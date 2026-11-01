const express = require('express')
const mongoose = require('mongoose')
const rateLimit = require('express-rate-limit')
const AttendanceRecord = require('../models/AttendanceRecord')
const ScanEvent = require('../models/ScanEvent')
const Group = require('../models/Group')
const Person = require('../models/Person')
const AuditEvent = require('../models/AuditEvent')
const { HttpError } = require('../lib/httpError')
const { createAuthenticate } = require('../middleware/authenticate')
const { requirePermission, requireAnyPermission } = require('../middleware/authorize')
const { dateInTimezone } = require('../services/deviceAttendance')
const { createSupabaseFaceTemplateStore } = require('../services/supabaseFaceTemplates')
const {
  decryptDescriptors,
  encryptDescriptors,
  findBestMatch,
  validateDescriptor,
  validateDescriptors,
} = require('../services/cameraFaceTemplates')

function assertPersonGroupScope(person, membership) {
  if (membership.groupIds?.length &&
    !membership.groupIds.some((groupId) => groupId.toString() === person.groupId.toString())) {
    throw new HttpError(403, 'FORBIDDEN', 'You do not have access to this person.')
  }
}

async function writeCameraAudit(req, action, entityType, entityId, detail) {
  await AuditEvent.create({
    organizationId: req.auth.organization._id,
    actorUserId: req.auth.user._id,
    action,
    entityType,
    entityId: entityId.toString(),
    detail,
    requestId: req.requestId,
  })
}

function createCameraRouter({
  config,
  faceTemplateStore = createSupabaseFaceTemplateStore({ config }),
  cameraFrameSource = {
    getLatestFrame() {
      throw new HttpError(503, 'AMB82_STREAM_NOT_CONFIGURED', 'Configure AMB82_RTSP_URL in the backend environment.')
    },
    getUrl() {
      return config.amb82RtspUrl || null
    },
    setUrl() {},
  },
}) {
  const router = express.Router()
  const authenticate = createAuthenticate({ config })
  const recognitionLimit = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'RATE_LIMITED', 'Too many camera scans. Try again shortly.')),
  })

  router.get('/camera/amb82/config', authenticate, requireAnyPermission('devices.manage', 'attendance.view', 'attendance.correct'), (_req, res) => {
    const currentUrl = cameraFrameSource.getUrl ? cameraFrameSource.getUrl() : (config.amb82RtspUrl || null)
    res.json({
      data: {
        url: currentUrl,
        configured: Boolean(currentUrl),
      },
    })
  })

  router.post('/camera/amb82/config', authenticate, requireAnyPermission('devices.manage', 'settings.manage'), (req, res) => {
    const { url } = req.body || {}
    if (typeof url !== 'string' || !url.trim()) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'A valid RTSP URL is required.')
    }
    const trimmed = url.trim()
    try {
      const parsed = new URL(trimmed)
      if (!['rtsp:', 'rtsps:'].includes(parsed.protocol) || !parsed.hostname) throw new Error()
    } catch {
      throw new HttpError(400, 'VALIDATION_ERROR', 'AMB82_RTSP_URL must be a valid rtsp:// or rtsps:// URL.')
    }
    if (typeof cameraFrameSource.setUrl === 'function') {
      cameraFrameSource.setUrl(trimmed)
    }
    res.json({
      data: {
        url: trimmed,
        configured: true,
      },
      meta: { requestId: req.requestId },
    })
  })

  router.get('/camera/amb82/frame', authenticate, requireAnyPermission('devices.manage', 'attendance.view', 'attendance.correct', 'live.view'), (_req, res) => {
    const frame = cameraFrameSource.getLatestFrame()
    res.set('Cache-Control', 'no-store')
    res.type('image/jpeg').send(frame)
  })

  router.get('/camera/templates', authenticate, requireAnyPermission('devices.manage', 'people.view', 'attendance.view', 'attendance.correct'), async (req, res) => {
    const { groupId } = req.query
    if (typeof groupId !== 'string' || !mongoose.isValidObjectId(groupId)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'A valid groupId is required.')
    }
    if (req.auth.membership.groupIds?.length &&
      !req.auth.membership.groupIds.some((id) => id.toString() === groupId)) {
      throw new HttpError(403, 'FORBIDDEN', 'You do not have access to this group.')
    }
    const group = await Group.findOne({
      _id: groupId,
      organizationId: req.auth.organization._id,
      status: 'ACTIVE',
    })
    if (!group) throw new HttpError(404, 'NOT_FOUND', 'The requested group was not found.')
    const people = await Person.find({
      organizationId: req.auth.organization._id,
      groupId,
      status: 'ACTIVE',
    }).select('_id name personCode consentGiven cameraConsentGiven')
    const enrolledIds = new Set(await faceTemplateStore.listPersonIds(
      req.auth.organization._id,
      people.map((person) => person._id),
    ))
    res.json({
      data: people.map((person) => ({
        personId: person._id.toString(),
        name: person.name,
        personCode: person.personCode,
        consentGiven: person.consentGiven,
        cameraConsentGiven: person.cameraConsentGiven,
        enrolled: enrolledIds.has(person._id.toString()),
      })),
      meta: { requestId: req.requestId },
    })
  })

  router.post('/camera/templates', authenticate, requireAnyPermission('devices.manage', 'people.manage'), async (req, res) => {
    const { personId, descriptors, cameraConsentConfirmed } = req.body || {}
    if (typeof personId !== 'string' || !mongoose.isValidObjectId(personId) ||
      !validateDescriptors(descriptors) ||
      (cameraConsentConfirmed !== undefined && typeof cameraConsentConfirmed !== 'boolean')) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'A valid personId, 1–5 face descriptors, and optional consent confirmation are required.')
    }
    const person = await Person.findOne({
      _id: personId,
      organizationId: req.auth.organization._id,
    })
    if (!person) throw new HttpError(404, 'NOT_FOUND', 'The requested person was not found.')
    assertPersonGroupScope(person, req.auth.membership)
    if (person.status !== 'ACTIVE') {
      throw new HttpError(409, 'PERSON_INACTIVE', 'Only active people can be enrolled.')
    }
    if (!person.cameraConsentGiven && cameraConsentConfirmed !== true) {
      throw new HttpError(403, 'CAMERA_CONSENT_REQUIRED', 'Explicit consent to encrypted server-side face-template storage is required.')
    }
    const encrypted = encryptDescriptors(descriptors, {
      organizationId: req.auth.organization._id,
      personId: person._id,
      config,
    })
    if (!person.cameraConsentGiven) {
      person.cameraConsentGiven = true
      person.cameraConsentGivenAt = new Date()
      person.cameraConsentSource = 'AMB82_RTSP_RECORDED'
      person.cameraConsentHistory.push({
        given: true,
        actorUserId: req.auth.user._id,
        source: 'AMB82_RTSP_RECORDED',
      })
      await person.save()
    }
    const template = await faceTemplateStore.upsert({
      organizationId: req.auth.organization._id,
      personId: person._id,
      ...encrypted,
      enrolledByUserId: req.auth.user._id,
      enrolledAt: new Date(),
    })
    await writeCameraAudit(req, 'camera.template.enrolled', 'Person', person._id, 'Encrypted face template enrolled or replaced.')
    res.status(201).json({
      data: { personId: template.personId, enrolledAt: new Date(template.enrolledAt).toISOString() },
      meta: { requestId: req.requestId },
    })
  })

  router.delete('/camera/templates/:personId', authenticate, requireAnyPermission('devices.manage', 'people.manage'), async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.personId)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'A valid personId is required.')
    }
    const person = await Person.findOne({
      _id: req.params.personId,
      organizationId: req.auth.organization._id,
    })
    if (!person) throw new HttpError(404, 'NOT_FOUND', 'The requested person was not found.')
    assertPersonGroupScope(person, req.auth.membership)
    await faceTemplateStore.deleteForPerson(req.auth.organization._id, person._id)
    await writeCameraAudit(req, 'camera.template.deleted', 'Person', person._id, 'Encrypted face template deleted by an authorized admin.')
    res.json({ data: { personId: person._id.toString(), deleted: true }, meta: { requestId: req.requestId } })
  })

  router.post('/camera/recognize', authenticate, requireAnyPermission('devices.manage', 'attendance.correct', 'attendance.view'), recognitionLimit, async (req, res) => {
    const { groupId, descriptor } = req.body || {}
    if (typeof groupId !== 'string' || !mongoose.isValidObjectId(groupId) || !validateDescriptor(descriptor)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'A valid groupId and face descriptor are required.')
    }
    if (req.auth.membership.groupIds?.length &&
      !req.auth.membership.groupIds.some((id) => id.toString() === groupId)) {
      throw new HttpError(403, 'FORBIDDEN', 'You do not have access to this group.')
    }
    const group = await Group.findOne({
      _id: groupId,
      organizationId: req.auth.organization._id,
      status: 'ACTIVE',
    })
    if (!group) throw new HttpError(404, 'NOT_FOUND', 'The requested group was not found.')

    const people = await Person.find({
      organizationId: req.auth.organization._id,
      groupId,
      status: 'ACTIVE',
      cameraConsentGiven: true,
    }).select('_id name personCode')
    const templates = await faceTemplateStore.listForPeople(
      req.auth.organization._id,
      people.map((person) => person._id),
    )
    const match = findBestMatch(descriptor, templates.map((template) => ({
      personId: template.personId,
      descriptors: decryptDescriptors(template, {
        organizationId: req.auth.organization._id,
        personId: template.personId,
        config,
      }),
    })))
    if (!match.matched) {
      return res.json({
        data: { matched: false, reason: match.reason },
        meta: { requestId: req.requestId },
      })
    }

    const person = people.find((item) => item._id.toString() === match.personId)
    if (!person) throw new HttpError(409, 'PERSON_UNAVAILABLE', 'The recognized person is no longer available for attendance.')
    const date = dateInTimezone(new Date(), req.auth.organization.settings.timezone || 'UTC')
    let record = await AttendanceRecord.findOne({
      organizationId: req.auth.organization._id,
      personId: person._id,
      date,
      scheduleId: null,
    })
    let alreadyRecorded = Boolean(record)
    if (!record) {
      try {
        record = await AttendanceRecord.create({
          organizationId: req.auth.organization._id,
          personId: person._id,
          date,
          status: 'PRESENT',
          firstIn: new Date(),
          source: 'CAMERA',
        })
      } catch (error) {
        if (error?.code !== 11000) throw error
        record = await AttendanceRecord.findOne({
          organizationId: req.auth.organization._id,
          personId: person._id,
          date,
          scheduleId: null,
        })
        if (!record) throw error
        alreadyRecorded = true
      }
    }

    if (record.source === 'CAMERA') {
      const eventId = `camera:${record._id.toString()}`
      await ScanEvent.updateOne(
        { organizationId: req.auth.organization._id, eventId },
        {
          $setOnInsert: {
            organizationId: req.auth.organization._id,
            eventId,
            source: 'CAMERA',
            deviceId: null,
            personId: person._id,
            sourcePersonCode: person.personCode,
            rawLabel: person.name,
            confidence: match.confidence,
            scannedAt: record.firstIn || new Date(),
            receivedAt: new Date(),
            result: 'ACCEPTED',
            direction: 'IN',
            resolution: { status: 'RESOLVED' },
          },
        },
        { upsert: true },
      )
    }

    await writeCameraAudit(
      req,
      alreadyRecorded ? 'camera.attendance.duplicate' : 'camera.attendance.recorded',
      'AttendanceRecord',
      record._id,
      `Camera recognition ${alreadyRecorded ? 'found existing attendance' : 'recorded attendance'}; confidence ${match.confidence.toFixed(3)}.`,
    )
    res.json({
      data: {
        matched: true,
        person: { id: person._id.toString(), name: person.name, personCode: person.personCode },
        confidence: match.confidence,
        attendance: {
          id: record._id.toString(),
          date: record.date,
          status: record.status,
          alreadyRecorded,
        },
      },
      meta: { requestId: req.requestId },
    })
  })

  return router
}

module.exports = { createCameraRouter }
