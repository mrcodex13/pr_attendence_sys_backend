const express = require('express')
const mongoose = require('mongoose')
const { randomBytes, randomUUID } = require('node:crypto')
const Device = require('../models/Device')
const DeviceCommand = require('../models/DeviceCommand')
const Enrollment = require('../models/Enrollment')
const Group = require('../models/Group')
const Person = require('../models/Person')
const Site = require('../models/Site')
const AuditEvent = require('../models/AuditEvent')
const Organization = require('../models/Organization')
const { HttpError } = require('../lib/httpError')
const { createAuthenticate } = require('../middleware/authenticate')
const { createAuthenticateDevice } = require('../middleware/authenticateDevice')
const { requirePermission } = require('../middleware/authorize')
const { encryptDeviceSecret } = require('../services/deviceSecurity')
const { processDeviceScan } = require('../services/deviceAttendance')

const DEVICE_ROLES = ['SUPER_ADMIN', 'ADMIN']
const MAX_BATCH_SIZE = 25
const MAX_OFFLINE_AGE_MS = 24 * 60 * 60 * 1000
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
const COMMAND_TTL_MS = 24 * 60 * 60 * 1000

function serializeDevice(device) {
  return {
    id: device._id.toString(),
    deviceCode: device.deviceCode,
    name: device.name,
    ...(device.siteId ? { siteId: device.siteId.toString() } : {}),
    groupIds: device.groupIds,
    status: device.status,
    firmwareVersion: device.firmwareVersion,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    lastEventAt: device.lastEventAt?.toISOString() ?? null,
    createdAt: device.createdAt.toISOString(),
  }
}

function serializeCommand(command) {
  return {
    commandId: command.commandId,
    type: command.type,
    payload: command.payload,
    createdAt: command.createdAt.toISOString(),
    expiresAt: command.expiresAt.toISOString(),
  }
}

function serializeEnrollment(enrollment) {
  return {
    id: enrollment._id.toString(),
    deviceId: enrollment.deviceId.toString(),
    personId: enrollment.personId.toString(),
    commandId: enrollment.commandId,
    status: enrollment.status,
    resultMessage: enrollment.resultMessage,
    createdAt: enrollment.createdAt.toISOString(),
    ...(enrollment.completedAt ? { completedAt: enrollment.completedAt.toISOString() } : {}),
  }
}

async function queueCommand({ device, type, payload = {}, createdBy = null }) {
  return DeviceCommand.create({
    organizationId: device.organizationId,
    deviceId: device._id,
    commandId: randomUUID(),
    type,
    payload,
    createdBy,
    expiresAt: new Date(Date.now() + COMMAND_TTL_MS),
  })
}

async function expirePendingCommands(deviceId, now = new Date()) {
  const expired = await DeviceCommand.find({
    deviceId,
    status: 'PENDING',
    expiresAt: { $lte: now },
  })
  for (const command of expired) {
    const updated = await DeviceCommand.updateOne(
      { _id: command._id, status: 'PENDING' },
      { $set: { status: 'EXPIRED' } },
    )
    if (updated.modifiedCount !== 1 || !command.payload.enrollmentId) continue
    const enrollment = await Enrollment.findOne({
      _id: command.payload.enrollmentId,
      organizationId: command.organizationId,
      deviceId: command.deviceId,
    })
    if (!enrollment) continue
    enrollment.status = command.type === 'DELETE_PERSON' ? 'DELETE_FAILED' : 'FAILED'
    enrollment.resultMessage = 'The device command expired without an acknowledgement.'
    enrollment.completedAt = now
    await enrollment.save()
  }
}

async function syncEnrollmentCommand(command) {
  if (!['ENROLL_PERSON', 'DELETE_PERSON'].includes(command.type)) return
  const enrollment = await Enrollment.findOne({
    _id: command.payload.enrollmentId,
    organizationId: command.organizationId,
    deviceId: command.deviceId,
    commandId: command.commandId,
  })
  if (!enrollment) return
  enrollment.status = command.type === 'ENROLL_PERSON'
    ? command.status === 'ACKNOWLEDGED' ? 'ENROLLED' : 'FAILED'
    : command.status === 'ACKNOWLEDGED' ? 'REMOVED' : 'DELETE_FAILED'
  enrollment.resultMessage = command.resultMessage
  enrollment.completedAt = command.acknowledgedAt
  await enrollment.save()
}

function requireDeviceAdmin(req) {
  if (!DEVICE_ROLES.includes(req.auth.membership.role)) {
    throw new HttpError(403, 'FORBIDDEN', 'Only organization admins can manage attendance devices.')
  }
}

async function writeDeviceAudit(req, action, device, detail = '') {
  await AuditEvent.create({
    organizationId: req.auth.organization._id,
    actorUserId: req.auth.user._id,
    action,
    entityType: 'Device',
    entityId: device._id.toString(),
    detail,
    requestId: req.requestId,
  })
}

function validateDeviceInput(input, { partial = false } = {}) {
  const allowed = new Set(['deviceCode', 'name', 'groupIds', 'siteId', 'status'])
  if (Object.keys(input).some((key) => !allowed.has(key)) ||
    (!partial && (!Object.hasOwn(input, 'deviceCode') || !Object.hasOwn(input, 'name') || !Object.hasOwn(input, 'groupIds'))) ||
    (partial && Object.keys(input).length === 0)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Provide supported device fields.')
  }
  if (input.deviceCode !== undefined &&
    (typeof input.deviceCode !== 'string' || input.deviceCode.trim().length < 2 || input.deviceCode.trim().length > 64 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.deviceCode.trim()))) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Device code must use 2–64 letters, numbers, dots, underscores, or hyphens.')
  }
  if (input.name !== undefined &&
    (typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.trim().length > 120)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Device name must be between 2 and 120 characters.')
  }
  if (input.groupIds !== undefined &&
    (!Array.isArray(input.groupIds) || input.groupIds.length < 1 || input.groupIds.length > 50 ||
      input.groupIds.some((id) => typeof id !== 'string' || !mongoose.isValidObjectId(id)) ||
      new Set(input.groupIds).size !== input.groupIds.length)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Assign the device to 1–50 unique active groups.')
  }
  if (input.siteId !== undefined && input.siteId !== null && !mongoose.isValidObjectId(input.siteId)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Device site ID is invalid.')
  }
  if (input.status !== undefined && !['ACTIVE', 'INACTIVE'].includes(input.status)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Device status must be ACTIVE or INACTIVE.')
  }
}

async function validateReferences(input, organizationId) {
  if (input.groupIds) {
    const activeCount = await Group.countDocuments({
      _id: { $in: input.groupIds },
      organizationId,
      status: 'ACTIVE',
    })
    if (activeCount !== input.groupIds.length) {
      throw new HttpError(400, 'INVALID_GROUP', 'All device groups must be active in this organization.')
    }
  }
  if (input.siteId) {
    const site = await Site.exists({ _id: input.siteId, organizationId, status: 'ACTIVE' })
    if (!site) throw new HttpError(400, 'INVALID_SITE', 'The device site must be active in this organization.')
  }
}

function validScans(scans) {
  if (!Array.isArray(scans) || scans.length < 1 || scans.length > MAX_BATCH_SIZE) return false
  const now = Date.now()
  return scans.every((scan) => {
    if (!scan || typeof scan !== 'object' || Array.isArray(scan)) return false
    const scannedAt = typeof scan.scannedAt === 'string' ? Date.parse(scan.scannedAt) : NaN
    return typeof scan.eventId === 'string' &&
      /^[A-Za-z0-9._:-]{1,96}$/.test(scan.eventId) &&
      typeof scan.personCode === 'string' &&
      scan.personCode.trim().length >= 2 &&
      scan.personCode.trim().length <= 40 &&
      typeof scan.confidence === 'number' &&
      Number.isFinite(scan.confidence) && scan.confidence >= 0 && scan.confidence <= 1 &&
      Number.isFinite(scannedAt) &&
      new Date(scannedAt).toISOString() === scan.scannedAt &&
      scannedAt >= now - MAX_OFFLINE_AGE_MS &&
      scannedAt <= now + MAX_FUTURE_SKEW_MS &&
      ['IN', 'OUT'].includes(scan.direction)
  })
}

function createDevicesRouter({ config }) {
  const router = express.Router()
  const authenticate = createAuthenticate({ config })
  const authenticateDevice = createAuthenticateDevice({ config })

  router.get('/devices', authenticate, requirePermission('devices.manage'), async (req, res) => {
    requireDeviceAdmin(req)
    const devices = await Device.find({ organizationId: req.auth.organization._id }).sort({ name: 1, _id: 1 })
    res.json({
      data: devices.map(serializeDevice),
      meta: { requestId: req.requestId },
    })
  })

  router.post('/devices', authenticate, requirePermission('devices.manage'), async (req, res) => {
    requireDeviceAdmin(req)
    const input = req.body || {}
    validateDeviceInput(input)
    const organizationId = req.auth.organization._id
    await validateReferences(input, organizationId)
    const secret = randomBytes(32).toString('base64url')
    const device = await Device.create({
      organizationId,
      deviceCode: input.deviceCode.trim().toUpperCase(),
      name: input.name.trim(),
      groupIds: input.groupIds,
      siteId: input.siteId || null,
      ...encryptDeviceSecret(secret, config),
    })
    await writeDeviceAudit(req, 'device.created', device, `Device ${device.deviceCode} registered.`)
    res.status(201).json({
      data: { device: serializeDevice(device), secret },
      meta: { requestId: req.requestId },
    })
  })

  router.get('/devices/:id', authenticate, requirePermission('devices.manage'), async (req, res) => {
    requireDeviceAdmin(req)
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'The device was not found.')
    const device = await Device.findOne({ _id: req.params.id, organizationId: req.auth.organization._id })
    if (!device) throw new HttpError(404, 'NOT_FOUND', 'The device was not found.')
    res.json({ data: serializeDevice(device), meta: { requestId: req.requestId } })
  })

  router.patch('/devices/:id', authenticate, requirePermission('devices.manage'), async (req, res) => {
    requireDeviceAdmin(req)
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'The device was not found.')
    const input = req.body || {}
    validateDeviceInput(input, { partial: true })
    await validateReferences(input, req.auth.organization._id)
    const device = await Device.findOne({ _id: req.params.id, organizationId: req.auth.organization._id })
    if (!device) throw new HttpError(404, 'NOT_FOUND', 'The device was not found.')
    if (input.deviceCode !== undefined) device.deviceCode = input.deviceCode.trim().toUpperCase()
    if (input.name !== undefined) device.name = input.name.trim()
    if (input.groupIds !== undefined) device.groupIds = input.groupIds
    if (input.siteId !== undefined) device.siteId = input.siteId || null
    if (input.status !== undefined) device.status = input.status
    await device.save()
    await writeDeviceAudit(req, 'device.updated', device, `Device ${device.deviceCode} settings updated.`)
    res.json({ data: serializeDevice(device), meta: { requestId: req.requestId } })
  })

  router.post('/devices/:id/rotate-secret', authenticate, requirePermission('devices.manage'), async (req, res) => {
    requireDeviceAdmin(req)
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'The device was not found.')
    const device = await Device.findOne({ _id: req.params.id, organizationId: req.auth.organization._id })
    if (!device) throw new HttpError(404, 'NOT_FOUND', 'The device was not found.')
    const secret = randomBytes(32).toString('base64url')
    Object.assign(device, encryptDeviceSecret(secret, config))
    await device.save()
    await writeDeviceAudit(req, 'device.secret_rotated', device, `Device ${device.deviceCode} secret rotated.`)
    res.json({
      data: { device: serializeDevice(device), secret },
      meta: { requestId: req.requestId },
    })
  })

  router.post('/devices/:id/commands', authenticate, requirePermission('devices.manage'), async (req, res) => {
    requireDeviceAdmin(req)
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'The device was not found.')
    const { type } = req.body || {}
    if (!['REBOOT', 'SYNC_DIRECTORY'].includes(type)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Supported device commands are REBOOT and SYNC_DIRECTORY.')
    }
    const device = await Device.findOne({
      _id: req.params.id,
      organizationId: req.auth.organization._id,
      status: 'ACTIVE',
    })
    if (!device) throw new HttpError(404, 'NOT_FOUND', 'The active device was not found.')
    const command = await queueCommand({ device, type, createdBy: req.auth.user._id })
    await writeDeviceAudit(req, 'device.command_queued', device, `${type} command queued.`)
    res.status(202).json({ data: serializeCommand(command), meta: { requestId: req.requestId } })
  })

  router.get('/devices/:id/commands', authenticateDevice, async (req, res) => {
    if (req.params.id !== req.device._id.toString()) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested device was not found.')
    }
    const now = new Date()
    await expirePendingCommands(req.device._id, now)
    const commands = await DeviceCommand.find({
      deviceId: req.device._id,
      status: 'PENDING',
      expiresAt: { $gt: now },
    }).sort({ createdAt: 1 }).limit(20)
    req.device.lastSeenAt = now
    await req.device.save()
    res.json({
      data: commands.map(serializeCommand),
      meta: { requestId: req.requestId },
    })
  })

  router.get('/device/config', authenticateDevice, async (req, res) => {
    const organization = await Organization.findOne({
      _id: req.device.organizationId,
      status: 'ACTIVE',
    }).select('settings')
    if (!organization) throw new HttpError(401, 'INVALID_DEVICE_AUTH', 'The device organization is inactive.')
    req.device.lastSeenAt = new Date()
    await req.device.save()
    res.json({
      data: {
        deviceId: req.device._id.toString(),
        deviceCode: req.device.deviceCode,
        siteId: req.device.siteId?.toString() ?? null,
        groupIds: req.device.groupIds,
        settings: {
          timezone: organization.settings.timezone,
          minConfidence: organization.settings.minConfidence,
          debounceSeconds: organization.settings.debounceSeconds,
        },
        serverTime: new Date().toISOString(),
      },
      meta: { requestId: req.requestId },
    })
  })

  router.post('/device/commands/:commandId/ack', authenticateDevice, async (req, res) => {
    const { status, message = '' } = req.body || {}
    if (!['ACKNOWLEDGED', 'FAILED'].includes(status) ||
      typeof message !== 'string' || message.length > 500) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Provide ACKNOWLEDGED or FAILED and an optional result message.')
    }
    const command = await DeviceCommand.findOne({
      commandId: req.params.commandId,
      deviceId: req.device._id,
      organizationId: req.device.organizationId,
    })
    if (!command) throw new HttpError(404, 'NOT_FOUND', 'The device command was not found.')
    if (command.expiresAt <= new Date() && command.status === 'PENDING') {
      await expirePendingCommands(req.device._id)
      throw new HttpError(409, 'COMMAND_EXPIRED', 'The device command has expired.')
    }
    if (command.status === status) {
      if (command.resultMessage !== message.trim()) {
        throw new HttpError(409, 'COMMAND_ACK_CONFLICT', 'A completed command cannot be acknowledged with different result data.')
      }
      await syncEnrollmentCommand(command)
      res.json({
        data: { commandId: command.commandId, status: command.status, message: command.resultMessage },
        meta: { requestId: req.requestId },
      })
      return
    }
    if (command.status !== 'PENDING') {
      throw new HttpError(409, 'COMMAND_ALREADY_FINAL', 'The device command is no longer pending.')
    }

    command.status = status
    command.resultMessage = message.trim()
    command.acknowledgedAt = new Date()
    await command.save()

    await syncEnrollmentCommand(command)
    req.device.lastSeenAt = new Date()
    await req.device.save()
    res.json({
      data: { commandId: command.commandId, status: command.status, message: command.resultMessage },
      meta: { requestId: req.requestId },
    })
  })

  router.get('/enrollments', authenticate, requirePermission('devices.manage'), async (req, res) => {
    requireDeviceAdmin(req)
    const page = Number(req.query.page || 1)
    const limit = Number(req.query.limit || 25)
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Page must be positive and limit must be between 1 and 100.')
    }
    const filter = { organizationId: req.auth.organization._id }
    const [enrollments, total] = await Promise.all([
      Enrollment.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Enrollment.countDocuments(filter),
    ])
    res.json({
      data: enrollments.map(serializeEnrollment),
      meta: { page, limit, total, requestId: req.requestId },
    })
  })

  router.post('/enrollments', authenticate, requirePermission('devices.manage'), async (req, res) => {
    requireDeviceAdmin(req)
    const { deviceId, personId } = req.body || {}
    if (!mongoose.isValidObjectId(deviceId) || !mongoose.isValidObjectId(personId)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'A valid device ID and person ID are required.')
    }
    const organizationId = req.auth.organization._id
    const [device, person] = await Promise.all([
      Device.findOne({ _id: deviceId, organizationId, status: 'ACTIVE' }),
      Person.findOne({ _id: personId, organizationId, status: 'ACTIVE' }),
    ])
    if (!device) throw new HttpError(404, 'NOT_FOUND', 'The active device was not found.')
    if (!person) throw new HttpError(404, 'NOT_FOUND', 'The active person was not found.')
    if (!device.groupIds.includes(person.groupId.toString())) {
      throw new HttpError(403, 'DEVICE_GROUP_DENIED', 'The device is not assigned to this person’s group.')
    }
    if (!person.consentGiven || !person.consentGivenAt) {
      throw new HttpError(409, 'BIOMETRIC_CONSENT_REQUIRED', 'Recorded consent is required before biometric enrollment.')
    }
    const activeEnrollment = await Enrollment.exists({
      organizationId,
      deviceId,
      personId,
      status: { $in: ['PENDING', 'ENROLLED', 'DELETE_PENDING', 'DELETE_FAILED'] },
    })
    if (activeEnrollment) {
      throw new HttpError(409, 'ENROLLMENT_ALREADY_EXISTS', 'This person already has an active or pending enrollment on this device.')
    }

    const commandId = randomUUID()
    const enrollment = await Enrollment.create({
      organizationId,
      deviceId,
      personId,
      commandId,
      status: 'PENDING',
      startedBy: req.auth.user._id,
    })
    try {
      await DeviceCommand.create({
        organizationId,
        deviceId,
        commandId,
        type: 'ENROLL_PERSON',
        payload: {
          enrollmentId: enrollment._id.toString(),
          personId: person._id.toString(),
          personCode: person.personCode,
          name: person.name,
        },
        createdBy: req.auth.user._id,
        expiresAt: new Date(Date.now() + COMMAND_TTL_MS),
      })
    } catch (error) {
      await Enrollment.deleteOne({ _id: enrollment._id })
      throw error
    }
    await writeDeviceAudit(req, 'device.enrollment_queued', device, `Enrollment queued for person ${person.personCode}.`)
    res.status(202).json({ data: serializeEnrollment(enrollment), meta: { requestId: req.requestId } })
  })

  router.get('/enrollments/:id', authenticate, requirePermission('devices.manage'), async (req, res) => {
    requireDeviceAdmin(req)
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'The enrollment was not found.')
    const enrollment = await Enrollment.findOne({ _id: req.params.id, organizationId: req.auth.organization._id })
    if (!enrollment) throw new HttpError(404, 'NOT_FOUND', 'The enrollment was not found.')
    res.json({ data: serializeEnrollment(enrollment), meta: { requestId: req.requestId } })
  })

  router.delete('/enrollments/:id', authenticate, requirePermission('devices.manage'), async (req, res) => {
    requireDeviceAdmin(req)
    if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'The enrollment was not found.')
    const enrollment = await Enrollment.findOne({ _id: req.params.id, organizationId: req.auth.organization._id })
    if (!enrollment) throw new HttpError(404, 'NOT_FOUND', 'The enrollment was not found.')
    if (['PENDING', 'ENROLLED', 'DELETE_FAILED'].includes(enrollment.status)) {
      const device = await Device.findOne({
        _id: enrollment.deviceId,
        organizationId: enrollment.organizationId,
        status: 'ACTIVE',
      })
      if (!device) throw new HttpError(409, 'DEVICE_UNAVAILABLE', 'Reactivate the enrollment device before removing its local biometric.')
      if (enrollment.status === 'PENDING') {
        await DeviceCommand.updateOne(
          { commandId: enrollment.commandId, status: 'PENDING' },
          { $set: { status: 'CANCELLED' } },
        )
      }
      const command = await queueCommand({
        device,
        type: 'DELETE_PERSON',
        payload: {
          enrollmentId: enrollment._id.toString(),
          personId: enrollment.personId.toString(),
        },
        createdBy: req.auth.user._id,
      })
      enrollment.commandId = command.commandId
      enrollment.status = 'DELETE_PENDING'
      enrollment.completedAt = null
    } else {
      throw new HttpError(409, 'ENROLLMENT_NOT_ACTIVE', 'Only pending or completed enrollments can be removed.')
    }
    await enrollment.save()
    await writeDeviceAudit(req, 'device.enrollment_removal_requested', { _id: enrollment.deviceId }, `Enrollment ${enrollment._id} removal requested.`)
    res.status(enrollment.status === 'DELETE_PENDING' ? 202 : 200).json({
      data: serializeEnrollment(enrollment),
      meta: { requestId: req.requestId },
    })
  })

  router.post('/device/heartbeat', authenticateDevice, async (req, res) => {
    const { firmwareVersion = '', uptimeSeconds, freeHeapBytes } = req.body || {}
    if (typeof firmwareVersion !== 'string' || firmwareVersion.length > 40 ||
      (uptimeSeconds !== undefined && (!Number.isSafeInteger(uptimeSeconds) || uptimeSeconds < 0)) ||
      (freeHeapBytes !== undefined && (!Number.isSafeInteger(freeHeapBytes) || freeHeapBytes < 0))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Heartbeat firmware or telemetry fields are invalid.')
    }
    const now = new Date()
    req.device.lastSeenAt = now
    if (firmwareVersion) req.device.firmwareVersion = firmwareVersion
    await req.device.save()
    res.json({
      data: {
        deviceId: req.device._id.toString(),
        serverTime: now.toISOString(),
        status: req.device.status,
      },
      meta: { requestId: req.requestId },
    })
  })

  router.post('/device/scans', authenticateDevice, async (req, res) => {
    const { scans } = req.body || {}
    if (!validScans(scans)) {
      throw new HttpError(400, 'VALIDATION_ERROR', `Submit 1–${MAX_BATCH_SIZE} valid scans; events may be at most 24 hours old.`)
    }
    const Organization = require('../models/Organization')
    const organization = await Organization.findOne({
      _id: req.device.organizationId,
      status: 'ACTIVE',
    })
    if (!organization) throw new HttpError(401, 'INVALID_DEVICE_AUTH', 'The device organization is inactive.')

    const receivedAt = new Date()
    const results = []
    for (const scan of scans) {
      results.push(await processDeviceScan({
        device: req.device,
        organization,
        scan,
        receivedAt,
      }))
    }
    req.device.lastSeenAt = receivedAt
    req.device.lastEventAt = receivedAt
    await req.device.save()
    res.status(202).json({
      data: {
        processed: results.length,
        accepted: results.filter((result) => result.result === 'ACCEPTED').length,
        results,
      },
      meta: { requestId: req.requestId },
    })
  })

  return router
}

module.exports = { createDevicesRouter }
