const AttendanceRecord = require('../models/AttendanceRecord')
const ScanEvent = require('../models/ScanEvent')
const Person = require('../models/Person')
const AuditEvent = require('../models/AuditEvent')
const { HttpError } = require('../lib/httpError')

function dateInTimezone(value, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function sameScan(existing, scan) {
  return existing.sourcePersonCode === scan.personCode &&
    existing.scannedAt.getTime() === new Date(scan.scannedAt).getTime() &&
    existing.confidence === scan.confidence &&
    existing.direction === scan.direction
}

function serializeEvent(event, duplicate = false) {
  return {
    eventId: event.eventId,
    result: event.result,
    ...(event.personId ? { personId: event.personId.toString() } : {}),
    scannedAt: event.scannedAt.toISOString(),
    duplicate,
  }
}

async function updateAttendanceRecord({ device, person, date, scan, scannedAt, eventId, existingRecord }) {
  let record = existingRecord || await AttendanceRecord.findOne({
    organizationId: device.organizationId,
    personId: person._id,
    date,
    scheduleId: null,
  })

  if (!record) {
    record = new AttendanceRecord({
      organizationId: device.organizationId,
      personId: person._id,
      date,
      scheduleId: null,
      status: 'PRESENT',
      source: 'DEVICE',
      firstIn: scan.direction === 'IN' ? scannedAt : null,
      lastOut: scan.direction === 'OUT' ? scannedAt : null,
      minutesWorked: 0,
      derivedFromEventIds: [eventId],
    })
    try {
      await record.save()
      return record
    } catch (error) {
      if (error?.code !== 11000) throw error
      record = await AttendanceRecord.findOne({
        organizationId: device.organizationId,
        personId: person._id,
        date,
        scheduleId: null,
      })
      if (!record) throw error
    }
  }

  if (record.derivedFromEventIds.includes(eventId)) return record
  if (scan.direction === 'IN' && (!record.firstIn || scannedAt < record.firstIn)) record.firstIn = scannedAt
  if (scan.direction === 'OUT' && (!record.lastOut || scannedAt > record.lastOut)) record.lastOut = scannedAt
  if (record.firstIn && record.lastOut) {
    record.minutesWorked = Math.max(0, Math.floor((record.lastOut - record.firstIn) / 60000))
  }
  record.derivedFromEventIds.addToSet(eventId)
  record.status = 'PRESENT'
  record.source = 'DEVICE'
  await record.save()
  return record
}

async function processDeviceScan({ device, organization, scan, receivedAt }) {
  const personCode = scan.personCode.trim().toUpperCase()
  const eventId = scan.eventId
  const normalizedScan = { ...scan, personCode }
  const storedEventId = `${device._id}:${eventId}`
  const existing = await ScanEvent.findOne({
    organizationId: device.organizationId,
    eventId: storedEventId,
  })
  if (existing) {
    if (!sameScan(existing, normalizedScan)) {
      throw new HttpError(409, 'DEVICE_EVENT_ID_REUSED', 'An event ID cannot be reused for different scan data.')
    }
    if (existing.result === 'ACCEPTED' && existing.personId) {
      const person = await Person.findOne({
        _id: existing.personId,
        organizationId: device.organizationId,
        status: 'ACTIVE',
      })
      if (person && device.groupIds.includes(person.groupId.toString())) {
        const scannedAt = new Date(scan.scannedAt)
        const date = dateInTimezone(scannedAt, organization.settings.timezone || 'UTC')
        await updateAttendanceRecord({
          device,
          person,
          date,
          scan: normalizedScan,
          scannedAt,
          eventId: storedEventId,
        })
      }
    }
    return serializeEvent(existing, true)
  }

  const person = await Person.findOne({
    organizationId: device.organizationId,
    personCode,
  })
  let result = 'ACCEPTED'
  const groupAllowed = person && device.groupIds.includes(person.groupId.toString())
  if (!person || !groupAllowed) result = 'UNKNOWN_PERSON'
  else if (person.status !== 'ACTIVE') result = 'INACTIVE_PERSON'
  else if (scan.confidence < organization.settings.minConfidence) result = 'LOW_CONFIDENCE'

  const scannedAt = new Date(scan.scannedAt)
  const date = dateInTimezone(scannedAt, organization.settings.timezone || 'UTC')
  let record = null
  if (result === 'ACCEPTED' && scan.direction === 'OUT') {
    record = await AttendanceRecord.findOne({
      organizationId: device.organizationId,
      personId: person._id,
      date,
      scheduleId: null,
      firstIn: { $ne: null },
    })
    if (!record) result = 'REJECTED'
  }

  if (result === 'ACCEPTED') {
    const debounceMs = organization.settings.debounceSeconds * 1000
    const recent = await ScanEvent.findOne({
      organizationId: device.organizationId,
      personId: person._id,
      direction: scan.direction,
      result: 'ACCEPTED',
      eventId: { $ne: storedEventId },
      scannedAt: {
        $gte: new Date(scannedAt.getTime() - debounceMs),
        $lte: new Date(scannedAt.getTime() + debounceMs),
      },
    }).select('_id')
    if (recent) result = 'DUPLICATE'
    else {
      record = await updateAttendanceRecord({
        device,
        person,
        date,
        scan: normalizedScan,
        scannedAt,
        eventId: storedEventId,
        existingRecord: record,
      })
    }
  }

  let event
  try {
    event = await ScanEvent.create({
      organizationId: device.organizationId,
      eventId: storedEventId,
      source: 'DEVICE',
      deviceId: device._id,
      personId: groupAllowed ? person._id : null,
      sourcePersonCode: personCode,
      rawLabel: groupAllowed ? person.name : personCode,
      confidence: scan.confidence,
      scannedAt,
      receivedAt,
      result,
      direction: scan.direction,
      resolution: { status: ['ACCEPTED', 'DUPLICATE'].includes(result) ? 'RESOLVED' : 'OPEN' },
    })
  } catch (error) {
    if (error?.code !== 11000) throw error
    const concurrent = await ScanEvent.findOne({
      organizationId: device.organizationId,
      eventId: storedEventId,
    })
    if (!concurrent) throw error
    if (!sameScan(concurrent, normalizedScan)) {
      throw new HttpError(409, 'DEVICE_EVENT_ID_REUSED', 'An event ID cannot be reused for different scan data.')
    }
    return serializeEvent(concurrent, true)
  }

  if (result === 'ACCEPTED') {
    await AuditEvent.create({
      organizationId: device.organizationId,
      action: 'device.attendance_recorded',
      entityType: 'AttendanceRecord',
      entityId: record._id.toString(),
      detail: `Attendance ${scan.direction.toLowerCase()} accepted from device ${device.deviceCode}.`,
    })
  }

  return serializeEvent(event)
}

module.exports = { dateInTimezone, processDeviceScan }
