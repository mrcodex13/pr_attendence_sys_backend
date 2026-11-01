const express = require('express')
const mongoose = require('mongoose')
const AttendanceRecord = require('../models/AttendanceRecord')
const AuditEvent = require('../models/AuditEvent')
const Device = require('../models/Device')
const Group = require('../models/Group')
const LeaveRequest = require('../models/LeaveRequest')
const Notification = require('../models/Notification')
const Person = require('../models/Person')
const PrivacyDeletionRequest = require('../models/PrivacyDeletionRequest')
const ReportDelivery = require('../models/ReportDelivery')
const ReportSchedule = require('../models/ReportSchedule')
const ScanEvent = require('../models/ScanEvent')
const TimetableSlot = require('../models/TimetableSlot')
const { HttpError } = require('../lib/httpError')
const { createAuthenticate } = require('../middleware/authenticate')
const { requirePermission } = require('../middleware/authorize')
const { createAttendanceExport } = require('../services/reportExports')
const User = require('../models/User')

const STATUSES = ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED', 'HALF_DAY']
const DATE = /^\d{4}-\d{2}-\d{2}$/

function validDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function shiftDate(date, offset) {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + offset)
  return value.toISOString().slice(0, 10)
}

function nextReportRun(schedule, after = new Date()) {
  const [hour, minute] = schedule.localTime.split(':').map(Number)
  const start = Math.floor(after.getTime() / 60000) * 60000 + 60000
  for (let offset = 0; offset < 60 * 24 * 62; offset += 1) {
    const candidate = new Date(start + offset * 60000)
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: schedule.timezone,
      weekday: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(candidate)
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    if (Number(value.hour) !== hour || Number(value.minute) !== minute) continue
    if (schedule.frequency === 'WEEKLY' && ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value.weekday) !== schedule.weekday) continue
    if (schedule.frequency === 'MONTHLY' && Number(value.day) !== schedule.monthDay) continue
    return candidate
  }
  throw new HttpError(400, 'VALIDATION_ERROR', 'No next report execution time was found for this schedule.')
}

function requireReportAdmin(req) {
  if (!['SUPER_ADMIN', 'ADMIN'].includes(req.auth.membership.role)) {
    throw new HttpError(403, 'FORBIDDEN', 'Only organization administrators can schedule reports.')
  }
}

function pageOptions(query) {
  const page = Number(query.page || 1)
  const limit = Number(query.limit || 25)
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Page must be positive and limit must be between 1 and 100.')
  }
  return { page, limit, skip: (page - 1) * limit }
}

function scopedGroupIds(membership) {
  return ['TEACHER', 'MANAGER'].includes(membership.role)
    ? membership.groupIds.filter(mongoose.isValidObjectId)
    : null
}

async function personScope(personId, organizationId, membership) {
  const person = await Person.findOne({ _id: personId, organizationId })
  if (!person) return null
  const groups = scopedGroupIds(membership)
  if (groups && !groups.includes(person.groupId.toString())) {
    throw new HttpError(403, 'FORBIDDEN', 'You do not have access to this person.')
  }
  return person
}

function addScope(filter, membership) {
  const groups = scopedGroupIds(membership)
  if (groups) filter.$scopeGroupIds = groups
  return filter
}

async function rowsForScopedFilter(filter, membership) {
  if (!filter.$scopeGroupIds) return filter
  const allowedPeople = await Person.find({
    organizationId: filter.organizationId,
    groupId: { $in: filter.$scopeGroupIds },
  }).distinct('_id')
  delete filter.$scopeGroupIds
  const current = filter.personId
  const allowedIds = current
    ? allowedPeople.filter((id) => {
      if (current instanceof mongoose.Types.ObjectId) return id.toString() === current.toString()
      if (current.$in) return current.$in.some((candidate) => candidate.toString() === id.toString())
      return false
    })
    : allowedPeople
  filter.personId = { $in: allowedIds }
  return filter
}

async function writeAudit(req, action, entityType, entityId, detail) {
  await AuditEvent.create({
    organizationId: req.auth.organization._id,
    actorUserId: req.auth.user._id,
    action,
    entityType,
    entityId: entityId?.toString() || '',
    detail,
    requestId: req.requestId,
  })
}

function serializeRecord(record) {
  return {
    id: record._id.toString(),
    personId: record.personId.toString(),
    date: record.date,
    ...(record.scheduleId ? { scheduleId: record.scheduleId.toString() } : {}),
    status: record.status,
    ...(record.firstIn ? { firstIn: record.firstIn.toISOString() } : {}),
    ...(record.lastOut ? { lastOut: record.lastOut.toISOString() } : {}),
    minutesWorked: record.minutesWorked,
    source: record.source,
    derivedFromEventIds: record.derivedFromEventIds,
  }
}

function createWorkflowsRouter({ config }) {
  const router = express.Router()
  const authenticate = createAuthenticate({ config })

  router.get('/dashboard', authenticate, requirePermission('dashboard.view'), async (req, res) => {
    if (req.query.date && !validDate(req.query.date)) throw new HttpError(400, 'VALIDATION_ERROR', 'Dashboard date must use YYYY-MM-DD.')
    const timezone = req.auth.organization.settings.timezone || 'UTC'
    const today = req.query.date || new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())
    const weekStart = shiftDate(today, -6)
    const monthStart = shiftDate(today, -29)
    const peopleFilter = { organizationId: req.auth.organization._id, status: 'ACTIVE' }
    const groups = scopedGroupIds(req.auth.membership)
    if (groups) peopleFilter.groupId = { $in: groups }
    const activePeopleIds = await Person.find(peopleFilter).distinct('_id')
    const people = activePeopleIds.length
    const scopedPeopleIds = groups ? activePeopleIds : null
    const personFilter = { personId: { $in: activePeopleIds } }
    const [records, exceptions, trendRows, absenteeRows, groupRows] = await Promise.all([
      AttendanceRecord.find({
        organizationId: req.auth.organization._id,
        date: today,
        ...personFilter,
      }).lean(),
      ScanEvent.countDocuments({
        organizationId: req.auth.organization._id,
        'resolution.status': 'OPEN',
        ...(groups ? { personId: { $in: scopedPeopleIds } } : {}),
      }),
      AttendanceRecord.aggregate([
        { $match: {
          organizationId: req.auth.organization._id,
          date: { $gte: weekStart, $lte: today },
          ...personFilter,
        } },
        { $group: {
          _id: { date: '$date', personId: '$personId' },
          present: { $max: { $cond: [{ $in: ['$status', ['PRESENT', 'LATE']] }, 1, 0] } },
          late: { $max: { $cond: [{ $eq: ['$status', 'LATE'] }, 1, 0] } },
        } },
        { $group: {
          _id: '$_id.date',
          present: { $sum: '$present' },
          late: { $sum: '$late' },
        } },
      ]),
      AttendanceRecord.aggregate([
        { $match: {
          organizationId: req.auth.organization._id,
          date: { $gte: monthStart, $lte: today },
          status: 'ABSENT',
          ...personFilter,
        } },
        { $group: { _id: '$personId', days: { $sum: 1 } } },
        { $sort: { days: -1 } },
        { $limit: 5 },
        { $lookup: { from: 'people', localField: '_id', foreignField: '_id', as: 'person' } },
        { $unwind: '$person' },
        { $project: { name: '$person.name', days: 1 } },
      ]),
      Person.aggregate([
        { $match: peopleFilter },
        { $group: { _id: '$groupId', total: { $sum: 1 } } },
      ]),
    ])
    const statusesByPerson = new Map()
    for (const record of records) {
      const personId = record.personId.toString()
      const statuses = statusesByPerson.get(personId) ?? new Set()
      statuses.add(record.status)
      statusesByPerson.set(personId, statuses)
    }
    const counts = Object.fromEntries(STATUSES.map((status) => [status.toLowerCase(), 0]))
    const statusPriority = ['LATE', 'PRESENT', 'ABSENT', 'EXCUSED', 'HALF_DAY']
    for (const statuses of statusesByPerson.values()) {
      const status = statusPriority.find((candidate) => statuses.has(candidate))
      if (status) counts[status.toLowerCase()] += 1
    }
    const present = counts.present
    const attended = counts.present + counts.late
    const notScanned = Math.max(0, people - statusesByPerson.size)
    const groupIds = groupRows.map((row) => row._id)
    const groupRecords = await AttendanceRecord.aggregate([
      { $match: {
        organizationId: req.auth.organization._id,
        date: today,
        status: { $in: ['PRESENT', 'LATE'] },
        ...personFilter,
      } },
      { $group: { _id: '$personId' } },
      { $lookup: { from: 'people', localField: '_id', foreignField: '_id', as: 'person' } },
      { $unwind: '$person' },
      { $match: { 'person.groupId': { $in: groupIds } } },
      { $group: { _id: '$person.groupId', present: { $sum: 1 } } },
    ])
    const presentByGroup = new Map(groupRecords.map((row) => [row._id.toString(), row.present]))
    const groupNames = await Group.find({ organizationId: req.auth.organization._id, _id: { $in: groupIds } }).select('_id name').lean()
    const nameByGroup = new Map(groupNames.map((group) => [group._id.toString(), group.name]))
    res.json({
      data: {
        ...counts,
        present,
        people,
        notScanned,
        exceptions,
        rate: people ? Math.round((attended / people) * 100) : 0,
        trend: Array.from({ length: 7 }, (_, index) => {
          const day = shiftDate(weekStart, index)
          const row = trendRows.find((item) => item._id === day)
          return { day, present: row?.present || 0, late: row?.late || 0 }
        }),
        groupRates: groupRows.map((row) => ({
          name: nameByGroup.get(row._id.toString()) || 'Group',
          rate: row.total ? Math.round(((presentByGroup.get(row._id.toString()) || 0) / row.total) * 100) : 0,
        })),
        topAbsentees: absenteeRows.map((row) => ({ name: row.name, days: row.days })),
        date: today,
      },
      meta: { requestId: req.requestId },
    })
  })

  router.get('/my-attendance', authenticate, requirePermission('my-attendance.view'), async (req, res) => {
    if (!['STUDENT', 'EMPLOYEE'].includes(req.auth.membership.role) || !req.auth.membership.personId) {
      throw new HttpError(403, 'FORBIDDEN', 'This account does not have a linked attendance record.')
    }
    const { page, limit, skip } = pageOptions(req.query)
    const filter = {
      organizationId: req.auth.organization._id,
      personId: req.auth.membership.personId,
    }
    const [records, total] = await Promise.all([
      AttendanceRecord.find(filter).sort({ date: -1, _id: -1 }).skip(skip).limit(limit),
      AttendanceRecord.countDocuments(filter),
    ])
    res.json({
      data: records.map(serializeRecord),
      meta: { page, limit, total, requestId: req.requestId },
    })
  })

  router.get('/attendance', authenticate, requirePermission('attendance.view'), async (req, res) => {
    const { page, limit, skip } = pageOptions(req.query)
    const filter = { organizationId: req.auth.organization._id }
    if (req.query.date) {
      if (!validDate(req.query.date)) throw new HttpError(400, 'VALIDATION_ERROR', 'Date must use YYYY-MM-DD.')
      filter.date = req.query.date
    }
    if (req.query.from || req.query.to) {
      if ((req.query.from && !validDate(req.query.from)) || (req.query.to && !validDate(req.query.to)) ||
          (req.query.from && req.query.to && req.query.to < req.query.from)) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'Attendance date range is invalid.')
      }
      filter.date = { ...(req.query.from ? { $gte: req.query.from } : {}), ...(req.query.to ? { $lte: req.query.to } : {}) }
    }
    if (req.query.status) {
      if (!STATUSES.includes(req.query.status)) throw new HttpError(400, 'VALIDATION_ERROR', 'Attendance status is invalid.')
      filter.status = req.query.status
    }
    if (req.query.personId) {
      if (!mongoose.isValidObjectId(req.query.personId)) throw new HttpError(400, 'VALIDATION_ERROR', 'Person ID is invalid.')
      filter.personId = new mongoose.Types.ObjectId(req.query.personId)
    }
    if (req.query.groupId) {
      if (!mongoose.isValidObjectId(req.query.groupId)) throw new HttpError(400, 'VALIDATION_ERROR', 'Group ID is invalid.')
      const group = scopedGroupIds(req.auth.membership)
      if (group && !group.includes(req.query.groupId)) return res.json({ data: [], meta: { page, limit, total: 0, requestId: req.requestId } })
      const peopleIds = await Person.find({ organizationId: req.auth.organization._id, groupId: req.query.groupId }).distinct('_id')
      filter.personId = { $in: peopleIds }
    }
    await rowsForScopedFilter(addScope(filter, req.auth.membership), req.auth.membership)
    const [records, total] = await Promise.all([
      AttendanceRecord.find(filter).sort({ date: -1, personId: 1 }).skip(skip).limit(limit),
      AttendanceRecord.countDocuments(filter),
    ])
    res.json({ data: records.map(serializeRecord), meta: { page, limit, total, requestId: req.requestId } })
  })

  router.get('/people/:id/attendance', authenticate, requirePermission('attendance.view'), async (req, res) => {
    const person = await personScope(req.params.id, req.auth.organization._id, req.auth.membership)
    if (!person) throw new HttpError(404, 'NOT_FOUND', 'The requested person was not found.')
    const { page, limit, skip } = pageOptions(req.query)
    const filter = { organizationId: req.auth.organization._id, personId: person._id }
    const [records, total] = await Promise.all([
      AttendanceRecord.find(filter).sort({ date: -1 }).skip(skip).limit(limit),
      AttendanceRecord.countDocuments(filter),
    ])
    res.json({ data: records.map(serializeRecord), meta: { page, limit, total, requestId: req.requestId } })
  })

  router.post('/attendance', authenticate, requirePermission('attendance.correct'), async (req, res) => {
    const { personId, date, status, reason, scheduleId = null } = req.body || {}
    if (typeof personId !== 'string' || !mongoose.isValidObjectId(personId) ||
      !validDate(date) || !STATUSES.includes(status) ||
      typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500 ||
      (scheduleId !== null && (typeof scheduleId !== 'string' || !mongoose.isValidObjectId(scheduleId)))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'A valid person, date, status, and reason are required.')
    }
    const person = await personScope(personId, req.auth.organization._id, req.auth.membership)
    if (!person) throw new HttpError(404, 'NOT_FOUND', 'The requested person was not found.')
    if (scheduleId && !await TimetableSlot.exists({
      _id: scheduleId,
      organizationId: req.auth.organization._id,
    })) {
      throw new HttpError(400, 'INVALID_SCHEDULE', 'The selected schedule does not belong to this organization.')
    }
    let record
    try {
      record = await AttendanceRecord.create({
        organizationId: req.auth.organization._id,
        personId: person._id,
        date,
        scheduleId,
        status,
        source: 'MANUAL',
      })
    } catch (error) {
      if (error?.code === 11000) {
        throw new HttpError(409, 'ATTENDANCE_ALREADY_EXISTS', 'An attendance record already exists for this person, date, and schedule.')
      }
      throw error
    }
    await writeAudit(req, 'attendance.created', 'AttendanceRecord', record._id, `Manually recorded ${status} for ${date}: ${reason.trim()}`)
    res.status(201).json({ data: serializeRecord(record), meta: { requestId: req.requestId } })
  })

  router.post('/attendance/:id/corrections', authenticate, requirePermission('attendance.correct'), async (req, res) => {
    const { status, reason } = req.body || {}
    if (!STATUSES.includes(status) || typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'A valid status and correction reason are required.')
    }
    const record = await AttendanceRecord.findOne({ _id: req.params.id, organizationId: req.auth.organization._id })
    if (!record) throw new HttpError(404, 'NOT_FOUND', 'The requested attendance record was not found.')
    await personScope(record.personId, req.auth.organization._id, req.auth.membership)
    if (record.status !== status) {
      record.corrections.push({ oldStatus: record.status, newStatus: status, reason: reason.trim(), byUserId: req.auth.user._id })
      record.status = status
      record.source = 'MANUAL'
      await record.save()
      await writeAudit(req, 'attendance.corrected', 'AttendanceRecord', record._id, `Status changed to ${status}: ${reason.trim()}`)
    }
    res.json({ data: serializeRecord(record), meta: { requestId: req.requestId } })
  })

  router.get('/exceptions', authenticate, requirePermission('exceptions.resolve'), async (req, res) => {
    const { page, limit, skip } = pageOptions(req.query)
    const filter = { organizationId: req.auth.organization._id, 'resolution.status': 'OPEN', result: { $ne: 'ACCEPTED' } }
    const groups = scopedGroupIds(req.auth.membership)
    if (groups) {
      const peopleIds = await Person.find({ organizationId: req.auth.organization._id, groupId: { $in: groups } }).distinct('_id')
      filter.personId = { $in: peopleIds }
    }
    const [events, total] = await Promise.all([
      ScanEvent.find(filter).sort({ receivedAt: -1 }).skip(skip).limit(limit),
      ScanEvent.countDocuments(filter),
    ])
    res.json({
      data: events.map((event) => ({
        id: event.eventId,
        eventId: event.eventId,
        deviceId: event.deviceId.toString(),
        personId: event.personId?.toString(),
        rawLabel: event.rawLabel,
        displayName: event.rawLabel,
        confidence: event.confidence,
        scannedAt: event.scannedAt.toISOString(),
        receivedAt: event.receivedAt.toISOString(),
        result: event.result,
        resolution: event.resolution.status,
      })),
      meta: { page, limit, total, requestId: req.requestId },
    })
  })

  router.post('/exceptions/:eventId/resolve', authenticate, requirePermission('exceptions.resolve'), async (req, res) => {
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : ''
    if (note.length < 3 || note.length > 500) throw new HttpError(400, 'VALIDATION_ERROR', 'A resolution note between 3 and 500 characters is required.')
    const event = await ScanEvent.findOne({ organizationId: req.auth.organization._id, eventId: req.params.eventId })
    if (!event) throw new HttpError(404, 'NOT_FOUND', 'The requested scan event was not found.')
    if (scopedGroupIds(req.auth.membership)) {
      if (!event.personId) throw new HttpError(403, 'FORBIDDEN', 'You do not have access to this scan event.')
      await personScope(event.personId, req.auth.organization._id, req.auth.membership)
    }
    if (event.resolution.status === 'OPEN') {
      event.resolution = { status: 'RESOLVED', note, actorUserId: req.auth.user._id, resolvedAt: new Date() }
      await event.save()
      await writeAudit(req, 'scan_exception.resolved', 'ScanEvent', event.eventId, note)
    }
    res.json({ data: { eventId: event.eventId, status: event.resolution.status, note: event.resolution.note }, meta: { requestId: req.requestId } })
  })

  router.get('/leave', authenticate, requirePermission('attendance.view'), async (req, res) => {
    const { page, limit, skip } = pageOptions(req.query)
    const filter = { organizationId: req.auth.organization._id }
    if (req.auth.membership.role === 'TEACHER' || req.auth.membership.role === 'MANAGER') {
      const peopleIds = await Person.find({ organizationId: req.auth.organization._id, groupId: { $in: scopedGroupIds(req.auth.membership) } }).distinct('_id')
      filter.personId = { $in: peopleIds }
    }
    const [items, total] = await Promise.all([
      LeaveRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      LeaveRequest.countDocuments(filter),
    ])
    res.json({ data: items.map((item) => ({
      id: item._id.toString(), personId: item.personId.toString(), from: item.from, to: item.to,
      type: item.type, status: item.status, reason: item.reason,
    })), meta: { page, limit, total, requestId: req.requestId } })
  })

  router.post('/leave', authenticate, requirePermission('people.manage'), async (req, res) => {
    const { personId, from, to, type, reason } = req.body || {}
    if (!mongoose.isValidObjectId(personId) || !validDate(from) || !validDate(to) || to < from ||
        !['SICK', 'CASUAL', 'EXCUSE', 'OTHER'].includes(type) ||
        typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 1000) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Leave person, date range, type, and reason are required.')
    }
    const person = await personScope(personId, req.auth.organization._id, req.auth.membership)
    if (!person || person.status !== 'ACTIVE') throw new HttpError(404, 'NOT_FOUND', 'The active person was not found.')
    const item = await LeaveRequest.create({
      organizationId: req.auth.organization._id, personId, from, to, type, reason: reason.trim(), requesterUserId: req.auth.user._id,
    })
    await writeAudit(req, 'leave.created', 'LeaveRequest', item._id, `Leave requested for ${from} through ${to}.`)
    res.status(201).json({ data: { id: item._id.toString(), personId: item.personId.toString(), from, to, type, status: item.status, reason: item.reason }, meta: { requestId: req.requestId } })
  })

  router.patch('/leave/:id', authenticate, requirePermission('leave.review'), async (req, res) => {
    const { status } = req.body || {}
    if (!['APPROVED', 'REJECTED'].includes(status)) throw new HttpError(400, 'VALIDATION_ERROR', 'Leave status must be APPROVED or REJECTED.')
    const item = await LeaveRequest.findOne({ _id: req.params.id, organizationId: req.auth.organization._id })
    if (!item) throw new HttpError(404, 'NOT_FOUND', 'The requested leave record was not found.')
    if (scopedGroupIds(req.auth.membership) &&
      !await personScope(item.personId, req.auth.organization._id, req.auth.membership)) {
      throw new HttpError(403, 'FORBIDDEN', 'You do not have access to this leave request.')
    }
    if (item.status === 'PENDING') {
      item.status = status
      item.reviewerUserId = req.auth.user._id
      item.reviewedAt = new Date()
      await item.save()
      await writeAudit(req, `leave.${status.toLowerCase()}`, 'LeaveRequest', item._id, `Leave request ${status.toLowerCase()}.`)
    }
    res.json({ data: { id: item._id.toString(), status: item.status }, meta: { requestId: req.requestId } })
  })

  router.get('/notifications', authenticate, requirePermission('dashboard.view'), async (req, res) => {
    const { page, limit, skip } = pageOptions(req.query)
    const filter = { organizationId: req.auth.organization._id, userId: req.auth.user._id }
    const [items, total] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Notification.countDocuments(filter),
    ])
    res.json({ data: items.map((item) => ({
      id: item._id.toString(), title: item.title, description: item.description,
      time: item.createdAt.toISOString(), tone: item.tone, icon: item.icon, read: Boolean(item.readAt),
    })), meta: { page, limit, total, requestId: req.requestId } })
  })

  router.get('/events/live', authenticate, requirePermission('live.view'), async (req, res) => {
    const groups = scopedGroupIds(req.auth.membership)
    const scope = groups
      ? {
          personId: {
            $in: await Person.find({
              organizationId: req.auth.organization._id,
              groupId: { $in: groups },
            }).distinct('_id'),
          },
        }
      : {}
    let cursor = null
    const lastEventId = req.get('Last-Event-ID')
    if (lastEventId) {
      const previous = await ScanEvent.findOne({
        organizationId: req.auth.organization._id,
        ...scope,
        eventId: lastEventId,
      }).select('_id')
      cursor = previous?._id ?? null
    }
    res.status(200)
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders()

    async function sendEvents(initial = false) {
      const query = { organizationId: req.auth.organization._id, ...scope }
      if (cursor) query._id = { $gt: cursor }
      const events = await ScanEvent.find(query)
        .sort({ _id: initial && !cursor ? -1 : 1 })
        .limit(25)
      if (initial && !cursor) events.reverse()
      for (const event of events) {
        res.write(`id: ${event.eventId}\n`)
        res.write(`data: ${JSON.stringify({
          eventId: event.eventId,
          ...(event.deviceId ? { deviceId: event.deviceId.toString() } : {}),
          source: event.source || 'DEVICE',
          ...(event.personId ? { personId: event.personId.toString() } : {}),
          rawLabel: event.rawLabel,
          displayName: event.rawLabel,
          confidence: event.confidence,
          scannedAt: event.scannedAt.toISOString(),
          receivedAt: event.receivedAt.toISOString(),
          result: event.result,
          direction: event.direction,
        })}\n\n`)
        cursor = event._id
      }
    }

    function endUnavailableStream() {
      if (res.destroyed || res.writableEnded) return
      res.write('event: error\ndata: {"code":"LIVE_FEED_UNAVAILABLE"}\n\n')
      res.end()
    }

    try {
      await sendEvents(true)
    } catch {
      endUnavailableStream()
      return
    }
    res.write(': connected\n\n')
    const timer = setInterval(() => {
      sendEvents().catch(() => {
        clearInterval(timer)
        endUnavailableStream()
      })
    }, 2000)
    req.on('close', () => clearInterval(timer))
  })

  router.patch('/notifications', authenticate, requirePermission('dashboard.view'), async (req, res) => {
    const { ids, read } = req.body || {}
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((id) => !mongoose.isValidObjectId(id)) ||
        typeof read !== 'boolean') {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Provide up to 100 notification IDs and a read boolean.')
    }
    const result = await Notification.updateMany(
      { _id: { $in: ids }, organizationId: req.auth.organization._id, userId: req.auth.user._id },
      { $set: { readAt: read ? new Date() : null } },
    )
    res.json({ data: { updated: result.modifiedCount }, meta: { requestId: req.requestId } })
  })

  router.get('/audit', authenticate, requirePermission('audit.view'), async (req, res) => {
    const { page, limit, skip } = pageOptions(req.query)
    const filter = { organizationId: req.auth.organization._id }
    if (req.query.action) filter.action = String(req.query.action).slice(0, 100)
    const [items, total] = await Promise.all([
      AuditEvent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      AuditEvent.countDocuments(filter),
    ])
    res.json({ data: items.map((item) => ({
      id: item._id.toString(), at: item.createdAt.toISOString(), actor: item.actorUserId?.toString() || 'system',
      action: item.action, entity: `${item.entityType}:${item.entityId}`, detail: item.detail,
    })), meta: { page, limit, total, requestId: req.requestId } })
  })

  router.get('/reports/attendance', authenticate, requirePermission('reports.export'), async (req, res) => {
    const { page, limit, skip } = pageOptions(req.query)
    const filter = { organizationId: req.auth.organization._id }
    if (req.query.from || req.query.to) {
      if ((req.query.from && !validDate(req.query.from)) || (req.query.to && !validDate(req.query.to)) ||
          (req.query.from && req.query.to && req.query.to < req.query.from)) throw new HttpError(400, 'VALIDATION_ERROR', 'Report date range is invalid.')
      filter.date = { ...(req.query.from ? { $gte: req.query.from } : {}), ...(req.query.to ? { $lte: req.query.to } : {}) }
    }
    if (req.query.groupId) {
      if (!mongoose.isValidObjectId(req.query.groupId)) throw new HttpError(400, 'VALIDATION_ERROR', 'Group ID is invalid.')
      const scope = scopedGroupIds(req.auth.membership)
      if (scope && !scope.includes(req.query.groupId)) return res.json({ data: [], meta: { page, limit, total: 0, requestId: req.requestId } })
      const ids = await Person.find({ organizationId: req.auth.organization._id, groupId: req.query.groupId }).distinct('_id')
      filter.personId = { $in: ids }
    }
    if (req.auth.membership.role === 'TEACHER' || req.auth.membership.role === 'MANAGER') {
      await rowsForScopedFilter(addScope(filter, req.auth.membership), req.auth.membership)
    }
    const [items, total] = await Promise.all([
      AttendanceRecord.find(filter).sort({ date: -1 }).skip(skip).limit(limit),
      AttendanceRecord.countDocuments(filter),
    ])
    res.json({ data: items.map(serializeRecord), meta: { page, limit, total, requestId: req.requestId } })
  })

  router.get('/reports/attendance/export', authenticate, requirePermission('reports.export'), async (req, res) => {
    const format = req.query.format || 'csv'
    if (!['csv', 'xlsx'].includes(format)) throw new HttpError(400, 'VALIDATION_ERROR', 'Export format must be csv or xlsx.')
    const filter = { organizationId: req.auth.organization._id }
    if (req.query.from || req.query.to) {
      if ((req.query.from && !validDate(req.query.from)) || (req.query.to && !validDate(req.query.to)) ||
          (req.query.from && req.query.to && req.query.to < req.query.from)) throw new HttpError(400, 'VALIDATION_ERROR', 'Report date range is invalid.')
      filter.date = { ...(req.query.from ? { $gte: req.query.from } : {}), ...(req.query.to ? { $lte: req.query.to } : {}) }
    }
    if (req.query.status) {
      if (!STATUSES.includes(req.query.status)) throw new HttpError(400, 'VALIDATION_ERROR', 'Attendance status is invalid.')
      filter.status = req.query.status
    }
    if (req.query.groupId) {
      if (!mongoose.isValidObjectId(req.query.groupId)) throw new HttpError(400, 'VALIDATION_ERROR', 'Group ID is invalid.')
      const scope = scopedGroupIds(req.auth.membership)
      if (scope && !scope.includes(req.query.groupId)) throw new HttpError(403, 'FORBIDDEN', 'You do not have access to this group.')
      const ids = await Person.find({ organizationId: req.auth.organization._id, groupId: req.query.groupId }).distinct('_id')
      filter.personId = { $in: ids }
    }
    if (req.auth.membership.role === 'TEACHER' || req.auth.membership.role === 'MANAGER') {
      await rowsForScopedFilter(addScope(filter, req.auth.membership), req.auth.membership)
    }
    const records = await AttendanceRecord.find(filter).sort({ date: -1 }).limit(50000).lean()
    await writeAudit(req, 'report.exported', 'AttendanceReport', '', `${format.toUpperCase()} rows=${records.length}`)
    const buffer = await createAttendanceExport(records, format.toUpperCase())
    if (format === 'csv') {
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="attendance-report.csv"',
      })
      return res.send(buffer)
    }
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="attendance-report.xlsx"',
    })
    res.send(buffer)
  })

  router.get('/reports/person-history', authenticate, requirePermission('reports.export'), async (req, res) => {
    if (!mongoose.isValidObjectId(req.query.personId)) throw new HttpError(400, 'VALIDATION_ERROR', 'A valid personId is required.')
    const person = await personScope(req.query.personId, req.auth.organization._id, req.auth.membership)
    if (!person) throw new HttpError(404, 'NOT_FOUND', 'The requested person was not found.')
    const { page, limit, skip } = pageOptions(req.query)
    const filter = { organizationId: req.auth.organization._id, personId: person._id }
    const [items, total] = await Promise.all([
      AttendanceRecord.find(filter).sort({ date: -1 }).skip(skip).limit(limit),
      AttendanceRecord.countDocuments(filter),
    ])
    res.json({ data: items.map(serializeRecord), meta: { page, limit, total, requestId: req.requestId } })
  })

  router.get('/reports/exceptions', authenticate, requirePermission('reports.export'), async (req, res) => {
    const { page, limit, skip } = pageOptions(req.query)
    const filter = { organizationId: req.auth.organization._id, result: { $ne: 'ACCEPTED' } }
    const groups = scopedGroupIds(req.auth.membership)
    if (groups) {
      const peopleIds = await Person.find({ organizationId: req.auth.organization._id, groupId: { $in: groups } }).distinct('_id')
      filter.personId = { $in: peopleIds }
    }
    const [items, total] = await Promise.all([
      ScanEvent.find(filter).sort({ receivedAt: -1 }).skip(skip).limit(limit),
      ScanEvent.countDocuments(filter),
    ])
    res.json({ data: items.map((item) => ({ eventId: item.eventId, result: item.result, rawLabel: item.rawLabel, receivedAt: item.receivedAt.toISOString() })), meta: { page, limit, total, requestId: req.requestId } })
  })

  router.get('/reports/device-health', authenticate, requirePermission('reports.export'), async (req, res) => {
    const now = new Date()
    const groups = scopedGroupIds(req.auth.membership)
    const devices = await Device.find({
      organizationId: req.auth.organization._id,
      ...(groups ? { groupIds: { $in: groups } } : {}),
    }).sort({ name: 1, _id: 1 })
    res.json({
      data: devices.map((device) => {
        const ageMs = device.lastSeenAt ? now.getTime() - device.lastSeenAt.getTime() : Number.POSITIVE_INFINITY
        const health = device.status !== 'ACTIVE' || ageMs > 30 * 60 * 1000
          ? 'OFFLINE'
          : ageMs >= 10 * 60 * 1000
            ? 'STALE'
            : 'ONLINE'
        return {
          id: device._id.toString(),
          deviceCode: device.deviceCode,
          name: device.name,
          status: device.status,
          health,
          firmwareVersion: device.firmwareVersion,
          lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
          lastEventAt: device.lastEventAt?.toISOString() ?? null,
        }
      }),
      meta: { requestId: req.requestId },
    })
  })

  router.get('/reports/schedules', authenticate, requirePermission('reports.schedule'), async (req, res) => {
    requireReportAdmin(req)
    const schedules = await ReportSchedule.find({ organizationId: req.auth.organization._id }).sort({ createdAt: -1 })
    res.json({ data: schedules.map((schedule) => ({
      id: schedule._id.toString(),
      name: schedule.name,
      reportType: schedule.reportType,
      format: schedule.format,
      frequency: schedule.frequency,
      weekday: schedule.weekday,
      monthDay: schedule.monthDay,
      localTime: schedule.localTime,
      timezone: schedule.timezone,
      recipients: schedule.recipients,
      groupId: schedule.groupId?.toString() ?? null,
      status: schedule.status,
      nextRunAt: schedule.nextRunAt.toISOString(),
      lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
    })), meta: { requestId: req.requestId } })
  })

  router.post('/reports/schedules', authenticate, requirePermission('reports.schedule'), async (req, res) => {
    requireReportAdmin(req)
    if (!config.smtpHost) {
      return res.status(503).json({
        error: { code: 'EMAIL_NOT_CONFIGURED', message: 'SMTP email delivery must be configured before creating scheduled reports.' },
        meta: { requestId: req.requestId },
      })
    }
    const { name, format, frequency, weekday, monthDay, localTime, timezone, recipients, groupId } = req.body || {}
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120 ||
        !['CSV', 'XLSX'].includes(format) || !['DAILY', 'WEEKLY', 'MONTHLY'].includes(frequency) ||
        typeof localTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime) ||
        typeof timezone !== 'string' || timezone.length > 80 || !Array.isArray(recipients) ||
        recipients.length < 1 || recipients.length > 20 ||
        (frequency === 'WEEKLY' && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)) ||
        (frequency === 'MONTHLY' && (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 28)) ||
        (groupId !== undefined && groupId !== null && !mongoose.isValidObjectId(groupId))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Scheduled report details are invalid.')
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    } catch {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Timezone must be a valid IANA timezone.')
    }
    const normalizedRecipients = [...new Set(recipients.map((email) => String(email).trim().toLowerCase()))]
    if (normalizedRecipients.length !== recipients.length || normalizedRecipients.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Recipient email addresses must be valid and unique.')
    }
    const users = await User.find({
      email: { $in: normalizedRecipients },
      status: 'ACTIVE',
      memberships: { $elemMatch: { organizationId: req.auth.organization._id, status: 'ACTIVE' } },
    }).select('email')
    const permittedEmails = new Set(users.map((user) => user.email))
    if (normalizedRecipients.some((email) => !permittedEmails.has(email))) {
      throw new HttpError(400, 'INVALID_RECIPIENT', 'Every report recipient must be an active member of this organization.')
    }
    if (groupId) {
      const group = await Group.findOne({ _id: groupId, organizationId: req.auth.organization._id, status: 'ACTIVE' })
      if (!group) throw new HttpError(400, 'INVALID_GROUP', 'The scheduled report group must be active in this organization.')
    }
    const scheduleInput = {
      organizationId: req.auth.organization._id,
      name: name.trim(),
      format,
      frequency,
      weekday: frequency === 'WEEKLY' ? weekday : null,
      monthDay: frequency === 'MONTHLY' ? monthDay : null,
      localTime,
      timezone,
      recipients: normalizedRecipients,
      groupId: groupId || null,
      createdBy: req.auth.user._id,
      nextRunAt: null,
    }
    scheduleInput.nextRunAt = nextReportRun(scheduleInput)
    const schedule = await ReportSchedule.create(scheduleInput)
    await writeAudit(req, 'report_schedule.created', 'ReportSchedule', schedule._id, `${format} ${frequency.toLowerCase()} schedule created.`)
    res.status(201).json({ data: { id: schedule._id.toString(), nextRunAt: schedule.nextRunAt.toISOString(), status: schedule.status }, meta: { requestId: req.requestId } })
  })

  router.get('/reports/schedules/:id', authenticate, requirePermission('reports.schedule'), async (req, res) => {
    requireReportAdmin(req)
    const schedule = await ReportSchedule.findOne({ _id: req.params.id, organizationId: req.auth.organization._id })
    if (!schedule) throw new HttpError(404, 'NOT_FOUND', 'The scheduled report was not found.')
    const { page, limit, skip } = pageOptions(req.query)
    const [deliveries, total] = await Promise.all([
      ReportDelivery.find({ organizationId: req.auth.organization._id, scheduleId: schedule._id }).sort({ attemptedAt: -1 }).skip(skip).limit(limit),
      ReportDelivery.countDocuments({ organizationId: req.auth.organization._id, scheduleId: schedule._id }),
    ])
    res.json({ data: deliveries.map((delivery) => ({
      id: delivery._id.toString(), status: delivery.status, attemptedAt: delivery.attemptedAt.toISOString(),
      completedAt: delivery.completedAt?.toISOString() ?? null, error: delivery.error,
    })), meta: { page, limit, total, requestId: req.requestId } })
  })

  router.patch('/reports/schedules/:id', authenticate, requirePermission('reports.schedule'), async (req, res) => {
    requireReportAdmin(req)
    const schedule = await ReportSchedule.findOne({ _id: req.params.id, organizationId: req.auth.organization._id })
    if (!schedule) throw new HttpError(404, 'NOT_FOUND', 'The scheduled report was not found.')
    const { status } = req.body || {}
    if (!['ACTIVE', 'PAUSED'].includes(status)) throw new HttpError(400, 'VALIDATION_ERROR', 'Schedule status must be ACTIVE or PAUSED.')
    schedule.status = status
    if (status === 'ACTIVE') schedule.nextRunAt = nextReportRun(schedule)
    await schedule.save()
    await writeAudit(req, `report_schedule.${status.toLowerCase()}`, 'ReportSchedule', schedule._id, `Schedule ${status.toLowerCase()}.`)
    res.json({ data: { id: schedule._id.toString(), status: schedule.status, nextRunAt: schedule.nextRunAt.toISOString() }, meta: { requestId: req.requestId } })
  })

  router.delete('/reports/schedules/:id', authenticate, requirePermission('reports.schedule'), async (req, res) => {
    requireReportAdmin(req)
    const schedule = await ReportSchedule.findOneAndUpdate(
      { _id: req.params.id, organizationId: req.auth.organization._id },
      { $set: { status: 'ARCHIVED' } },
      { returnDocument: 'after' },
    )
    if (!schedule) throw new HttpError(404, 'NOT_FOUND', 'The scheduled report was not found.')
    await writeAudit(req, 'report_schedule.archived', 'ReportSchedule', schedule._id, 'Schedule archived.')
    res.json({ data: { id: schedule._id.toString(), status: schedule.status }, meta: { requestId: req.requestId } })
  })

  router.get('/privacy/deletion-requests', authenticate, requirePermission('privacy.manage'), async (req, res) => {
    const { page, limit, skip } = pageOptions(req.query)
    const filter = { organizationId: req.auth.organization._id }
    const [items, total] = await Promise.all([
      PrivacyDeletionRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      PrivacyDeletionRequest.countDocuments(filter),
    ])
    res.json({ data: items.map((item) => ({
      id: item._id.toString(),
      personId: item.personId.toString(),
      reason: item.reason,
      status: item.status,
      reviewNote: item.reviewNote,
      createdAt: item.createdAt.toISOString(),
      reviewedAt: item.reviewedAt?.toISOString() ?? null,
    })), meta: { page, limit, total, requestId: req.requestId } })
  })

  router.post('/privacy/deletion-requests', authenticate, requirePermission('privacy.manage'), async (req, res) => {
    const { personId, reason } = req.body || {}
    if (!mongoose.isValidObjectId(personId) || typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 1000) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Person ID and a reason between 3 and 1000 characters are required.')
    }
    const person = await Person.findOne({ _id: personId, organizationId: req.auth.organization._id })
    if (!person) throw new HttpError(404, 'NOT_FOUND', 'The requested person was not found.')
    const existing = await PrivacyDeletionRequest.exists({
      organizationId: req.auth.organization._id,
      personId,
      status: { $in: ['REQUESTED', 'APPROVED', 'DEVICE_PENDING'] },
    })
    if (existing) throw new HttpError(409, 'DELETION_REQUEST_EXISTS', 'An open privacy deletion request already exists for this person.')
    const item = await PrivacyDeletionRequest.create({
      organizationId: req.auth.organization._id,
      personId,
      requestedBy: req.auth.user._id,
      reason: reason.trim(),
    })
    await writeAudit(req, 'privacy.deletion_requested', 'PrivacyDeletionRequest', item._id, 'Deletion request recorded; no data was purged.')
    res.status(201).json({ data: { id: item._id.toString(), status: item.status }, meta: { requestId: req.requestId } })
  })

  router.get('/privacy/deletion-requests/:id', authenticate, requirePermission('privacy.manage'), async (req, res) => {
    const item = await PrivacyDeletionRequest.findOne({ _id: req.params.id, organizationId: req.auth.organization._id })
    if (!item) throw new HttpError(404, 'NOT_FOUND', 'The deletion request was not found.')
    res.json({ data: {
      id: item._id.toString(),
      personId: item.personId.toString(),
      reason: item.reason,
      status: item.status,
      reviewNote: item.reviewNote,
      createdAt: item.createdAt.toISOString(),
      reviewedAt: item.reviewedAt?.toISOString() ?? null,
      completedAt: item.completedAt?.toISOString() ?? null,
    }, meta: { requestId: req.requestId } })
  })

  router.patch('/privacy/deletion-requests/:id', authenticate, requirePermission('privacy.manage'), async (req, res) => {
    const { status, reviewNote = '' } = req.body || {}
    if (!['APPROVED', 'REJECTED'].includes(status) || typeof reviewNote !== 'string' || reviewNote.length > 500) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Provide APPROVED or REJECTED and an optional review note.')
    }
    const item = await PrivacyDeletionRequest.findOne({ _id: req.params.id, organizationId: req.auth.organization._id })
    if (!item) throw new HttpError(404, 'NOT_FOUND', 'The deletion request was not found.')
    if (item.status !== 'REQUESTED') throw new HttpError(409, 'REQUEST_ALREADY_REVIEWED', 'Only pending deletion requests can be reviewed.')
    item.status = status
    item.reviewNote = reviewNote.trim()
    item.reviewedBy = req.auth.user._id
    item.reviewedAt = new Date()
    await item.save()
    await writeAudit(req, `privacy.deletion_${status.toLowerCase()}`, 'PrivacyDeletionRequest', item._id, item.reviewNote || 'No review note.')
    res.json({ data: { id: item._id.toString(), status: item.status, reviewNote: item.reviewNote }, meta: { requestId: req.requestId } })
  })

  return router
}

module.exports = { createWorkflowsRouter, validDate, writeAudit, nextReportRun }
