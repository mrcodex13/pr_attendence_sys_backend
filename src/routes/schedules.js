const express = require('express')
const mongoose = require('mongoose')
const Course = require('../models/Course')
const Group = require('../models/Group')
const Holiday = require('../models/Holiday')
const Shift = require('../models/Shift')
const Site = require('../models/Site')
const TimetableSlot = require('../models/TimetableSlot')
const User = require('../models/User')
const { HttpError } = require('../lib/httpError')
const { createAuthenticate } = require('../middleware/authenticate')
const { requirePermission } = require('../middleware/authorize')

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

function validDate(value) {
  if (value === null || value === undefined || value === '') return true
  if (typeof value !== 'string' || !DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function timeValue(value) {
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd
}

function activeRangeOverlaps(from, to, otherFrom, otherTo) {
  return (!to || !otherFrom || to >= otherFrom) && (!otherTo || !from || otherTo >= from)
}

function validateTimeRange(start, end) {
  if (typeof start !== 'string' || !TIME.test(start) || typeof end !== 'string' || !TIME.test(end) ||
      timeValue(start) >= timeValue(end)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Start and end must be valid times, with end after start on the same day.')
  }
}

function validateShiftRange(start, end) {
  if (typeof start !== 'string' || !TIME.test(start) || typeof end !== 'string' || !TIME.test(end) ||
      timeValue(start) >= timeValue(end)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Shift start and end must be valid times, with end after start on the same day.')
  }
}

function serialize(doc) {
  const output = { id: doc._id.toString() }
  for (const key of Object.keys(doc.toObject())) {
    if (key !== '_id' && key !== '__v' && key !== 'organizationId' && key !== 'createdAt' && key !== 'updatedAt') {
      output[key] = doc[key] instanceof mongoose.Types.ObjectId ? doc[key].toString() : doc[key]
    }
  }
  return output
}

function createSchedulesRouter({ config }) {
  const router = express.Router()
  const authenticate = createAuthenticate({ config })

  router.get('/courses', authenticate, requirePermission('courses.manage'), async (req, res) => {
    const courses = await Course.find({ organizationId: req.auth.organization._id, status: 'ACTIVE' }).sort({ name: 1 })
    res.json({ data: courses.map(serialize), meta: { requestId: req.requestId } })
  })

  router.post('/courses', authenticate, requirePermission('courses.manage'), async (req, res) => {
    const { name, code, groupId, teacherUserId } = req.body || {}
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120 ||
        typeof code !== 'string' || code.trim().length < 2 || code.trim().length > 40 ||
        !mongoose.isValidObjectId(groupId) || !mongoose.isValidObjectId(teacherUserId)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Course name, code, group, and teacher are required.')
    }
    const organizationId = req.auth.organization._id
    const [group, teacher] = await Promise.all([
      Group.findOne({ _id: groupId, organizationId, status: 'ACTIVE' }),
      User.findOne({
        _id: teacherUserId,
        status: 'ACTIVE',
        memberships: { $elemMatch: { organizationId, status: 'ACTIVE', role: { $in: ['TEACHER', 'ADMIN', 'SUPER_ADMIN'] } } },
      }),
    ])
    if (!group) throw new HttpError(400, 'INVALID_GROUP', 'The course group must be active in this organization.')
    if (!teacher) throw new HttpError(400, 'INVALID_TEACHER', 'The teacher must be an active organization member with a teaching-capable role.')
    const course = await Course.create({ organizationId, name: name.trim(), code: code.trim().toUpperCase(), groupId, teacherUserId })
    res.status(201).json({ data: serialize(course), meta: { requestId: req.requestId } })
  })

  router.patch('/courses/:id', authenticate, requirePermission('courses.manage'), async (req, res) => {
    const course = await Course.findOne({ _id: req.params.id, organizationId: req.auth.organization._id })
    if (!course) throw new HttpError(404, 'NOT_FOUND', 'The requested course was not found.')
    const input = req.body || {}
    const allowed = new Set(['name', 'code', 'groupId', 'teacherUserId', 'status'])
    if (!Object.keys(input).length || Object.keys(input).some((key) => !allowed.has(key))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Provide supported course fields to update.')
    }
    const nextGroupId = input.groupId ?? course.groupId
    const nextTeacherId = input.teacherUserId ?? course.teacherUserId
    const [group, teacher] = await Promise.all([
      Group.findOne({ _id: nextGroupId, organizationId: req.auth.organization._id, status: 'ACTIVE' }),
      User.findOne({
        _id: nextTeacherId,
        status: 'ACTIVE',
        memberships: { $elemMatch: { organizationId: req.auth.organization._id, status: 'ACTIVE', role: { $in: ['TEACHER', 'ADMIN', 'SUPER_ADMIN'] } } },
      }),
    ])
    if (!group) throw new HttpError(400, 'INVALID_GROUP', 'The course group must be active in this organization.')
    if (!teacher) throw new HttpError(400, 'INVALID_TEACHER', 'The teacher must be an active organization member with a teaching-capable role.')
    if (input.name !== undefined) course.name = input.name
    if (input.code !== undefined) course.code = input.code
    if (input.groupId !== undefined) course.groupId = input.groupId
    if (input.teacherUserId !== undefined) course.teacherUserId = input.teacherUserId
    if (input.status !== undefined) {
      if (!['ACTIVE', 'ARCHIVED'].includes(input.status)) throw new HttpError(400, 'VALIDATION_ERROR', 'Course status must be ACTIVE or ARCHIVED.')
      course.status = input.status
    }
    await course.save()
    res.json({ data: serialize(course), meta: { requestId: req.requestId } })
  })

  router.get('/timetable', authenticate, requirePermission('schedules.manage'), async (req, res) => {
    const slots = await TimetableSlot.find({ organizationId: req.auth.organization._id, status: 'ACTIVE' }).sort({ weekday: 1, start: 1 })
    res.json({ data: slots.map(serialize), meta: { requestId: req.requestId } })
  })

  router.post('/timetable', authenticate, requirePermission('schedules.manage'), async (req, res) => {
    const { courseId, weekday, start, end, room = '', effectiveFrom = null, effectiveTo = null } = req.body || {}
    validateTimeRange(start, end)
    if (!mongoose.isValidObjectId(courseId) || !Number.isInteger(weekday) || weekday < 0 || weekday > 6 ||
        typeof room !== 'string' || room.length > 120 || !validDate(effectiveFrom) || !validDate(effectiveTo) ||
        (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Course, weekday, room, and effective date values are invalid.')
    }
    const organizationId = req.auth.organization._id
    const course = await Course.findOne({ _id: courseId, organizationId, status: 'ACTIVE' })
    if (!course) throw new HttpError(400, 'INVALID_COURSE', 'The timetable course must be active in this organization.')
    const existing = await TimetableSlot.find({ organizationId, weekday, status: 'ACTIVE' })
      .populate({ path: 'courseId', match: { organizationId, status: 'ACTIVE' } })
    const conflict = existing.find((slot) => slot.courseId &&
      (slot.courseId.groupId.toString() === course.groupId.toString() || (room && slot.room.toLowerCase() === room.trim().toLowerCase())) &&
      overlap(timeValue(start), timeValue(end), timeValue(slot.start), timeValue(slot.end)) &&
      activeRangeOverlaps(effectiveFrom, effectiveTo, slot.effectiveFrom, slot.effectiveTo))
    if (conflict) throw new HttpError(409, 'SCHEDULE_CONFLICT', 'This time overlaps another active slot for the same group or room.')
    const slot = await TimetableSlot.create({ organizationId, courseId, weekday, start, end, room: room.trim(), effectiveFrom, effectiveTo })
    res.status(201).json({ data: serialize(slot), meta: { requestId: req.requestId } })
  })

  router.patch('/timetable/:id', authenticate, requirePermission('schedules.manage'), async (req, res) => {
    const slot = await TimetableSlot.findOne({ _id: req.params.id, organizationId: req.auth.organization._id })
    if (!slot) throw new HttpError(404, 'NOT_FOUND', 'The requested timetable slot was not found.')
    const input = req.body || {}
    const allowed = new Set(['courseId', 'weekday', 'start', 'end', 'room', 'effectiveFrom', 'effectiveTo', 'status'])
    if (!Object.keys(input).length || Object.keys(input).some((key) => !allowed.has(key))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Provide supported timetable slot fields to update.')
    }
    const next = {
      courseId: input.courseId ?? slot.courseId,
      weekday: input.weekday ?? slot.weekday,
      start: input.start ?? slot.start,
      end: input.end ?? slot.end,
      room: input.room ?? slot.room,
      effectiveFrom: input.effectiveFrom ?? slot.effectiveFrom,
      effectiveTo: input.effectiveTo ?? slot.effectiveTo,
      status: input.status ?? slot.status,
    }
    validateTimeRange(next.start, next.end)
    if (!mongoose.isValidObjectId(next.courseId) || !Number.isInteger(next.weekday) || next.weekday < 0 || next.weekday > 6 ||
        typeof next.room !== 'string' || next.room.length > 120 || !validDate(next.effectiveFrom) || !validDate(next.effectiveTo) ||
        (next.effectiveFrom && next.effectiveTo && next.effectiveTo < next.effectiveFrom) ||
        !['ACTIVE', 'ARCHIVED'].includes(next.status)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Timetable slot fields are invalid.')
    }
    const course = await Course.findOne({ _id: next.courseId, organizationId: req.auth.organization._id, status: 'ACTIVE' })
    if (!course) throw new HttpError(400, 'INVALID_COURSE', 'The timetable course must be active in this organization.')
    if (next.status === 'ACTIVE') {
      const existing = await TimetableSlot.find({
        organizationId: req.auth.organization._id,
        weekday: next.weekday,
        status: 'ACTIVE',
        _id: { $ne: slot._id },
      }).populate({ path: 'courseId', match: { organizationId: req.auth.organization._id, status: 'ACTIVE' } })
      const conflict = existing.find((other) => other.courseId &&
        (other.courseId.groupId.toString() === course.groupId.toString() ||
          (next.room && other.room.toLowerCase() === next.room.trim().toLowerCase())) &&
        overlap(timeValue(next.start), timeValue(next.end), timeValue(other.start), timeValue(other.end)) &&
        activeRangeOverlaps(next.effectiveFrom, next.effectiveTo, other.effectiveFrom, other.effectiveTo))
      if (conflict) throw new HttpError(409, 'SCHEDULE_CONFLICT', 'This time overlaps another active slot for the same group or room.')
    }
    Object.assign(slot, next)
    await slot.save()
    res.json({ data: serialize(slot), meta: { requestId: req.requestId } })
  })

  router.get('/shifts', authenticate, requirePermission('schedules.manage'), async (req, res) => {
    const shifts = await Shift.find({ organizationId: req.auth.organization._id, status: 'ACTIVE' }).sort({ name: 1 })
    res.json({ data: shifts.map(serialize), meta: { requestId: req.requestId } })
  })

  router.post('/shifts', authenticate, requirePermission('schedules.manage'), async (req, res) => {
    const { name, start, end, graceMinutes = 0, workingDays, effectiveFrom = null, effectiveTo = null } = req.body || {}
    validateShiftRange(start, end)
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120 ||
        !Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 720 ||
        !Array.isArray(workingDays) || !workingDays.length ||
        workingDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
        new Set(workingDays).size !== workingDays.length || !validDate(effectiveFrom) || !validDate(effectiveTo) ||
        (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Shift details, working days, grace period, or effective dates are invalid.')
    }
    const shift = await Shift.create({ organizationId: req.auth.organization._id, name: name.trim(), start, end, graceMinutes, workingDays, effectiveFrom, effectiveTo })
    res.status(201).json({ data: serialize(shift), meta: { requestId: req.requestId } })
  })

  router.patch('/shifts/:id', authenticate, requirePermission('schedules.manage'), async (req, res) => {
    const shift = await Shift.findOne({ _id: req.params.id, organizationId: req.auth.organization._id })
    if (!shift) throw new HttpError(404, 'NOT_FOUND', 'The requested shift was not found.')
    const input = req.body || {}
    const allowed = new Set(['name', 'start', 'end', 'graceMinutes', 'workingDays', 'effectiveFrom', 'effectiveTo', 'status'])
    if (!Object.keys(input).length || Object.keys(input).some((key) => !allowed.has(key))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Provide supported shift fields to update.')
    }
    const next = {
      name: input.name ?? shift.name,
      start: input.start ?? shift.start,
      end: input.end ?? shift.end,
      graceMinutes: input.graceMinutes ?? shift.graceMinutes,
      workingDays: input.workingDays ?? shift.workingDays,
      effectiveFrom: input.effectiveFrom !== undefined ? input.effectiveFrom : shift.effectiveFrom,
      effectiveTo: input.effectiveTo !== undefined ? input.effectiveTo : shift.effectiveTo,
      status: input.status ?? shift.status,
    }
    validateShiftRange(next.start, next.end)
    if (typeof next.name !== 'string' || next.name.trim().length < 2 || next.name.trim().length > 120 ||
        !Number.isInteger(next.graceMinutes) || next.graceMinutes < 0 || next.graceMinutes > 720 ||
        !Array.isArray(next.workingDays) || !next.workingDays.length ||
        next.workingDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
        new Set(next.workingDays).size !== next.workingDays.length || !validDate(next.effectiveFrom) || !validDate(next.effectiveTo) ||
        (next.effectiveFrom && next.effectiveTo && next.effectiveTo < next.effectiveFrom) ||
        !['ACTIVE', 'ARCHIVED'].includes(next.status)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Shift fields are invalid.')
    }
    next.name = next.name.trim()
    Object.assign(shift, next)
    await shift.save()
    res.json({ data: serialize(shift), meta: { requestId: req.requestId } })
  })

  router.get('/holidays', authenticate, requirePermission('holidays.manage'), async (req, res) => {
    const holidays = await Holiday.find({ organizationId: req.auth.organization._id, status: 'ACTIVE' }).sort({ date: 1 })
    res.json({ data: holidays.map(serialize), meta: { requestId: req.requestId } })
  })

  router.post('/holidays', authenticate, requirePermission('holidays.manage'), async (req, res) => {
    const { date, name, siteId } = req.body || {}
    if (!validDate(date) || !date || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120 ||
        !mongoose.isValidObjectId(siteId)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'A valid date, name, and site are required.')
    }
    const site = await Site.findOne({ _id: siteId, organizationId: req.auth.organization._id, status: 'ACTIVE' })
    if (!site) throw new HttpError(400, 'INVALID_SITE', 'The holiday site must be active in this organization.')
    const holiday = await Holiday.create({ organizationId: req.auth.organization._id, date, name: name.trim(), siteId })
    res.status(201).json({ data: serialize(holiday), meta: { requestId: req.requestId } })
  })

  router.patch('/holidays/:id', authenticate, requirePermission('holidays.manage'), async (req, res) => {
    const holiday = await Holiday.findOne({ _id: req.params.id, organizationId: req.auth.organization._id })
    if (!holiday) throw new HttpError(404, 'NOT_FOUND', 'The requested holiday was not found.')
    const input = req.body || {}
    const allowed = new Set(['date', 'name', 'siteId', 'status'])
    if (!Object.keys(input).length || Object.keys(input).some((key) => !allowed.has(key))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Provide supported holiday fields to update.')
    }
    const next = {
      date: input.date ?? holiday.date,
      name: input.name ?? holiday.name,
      siteId: input.siteId ?? holiday.siteId,
      status: input.status ?? holiday.status,
    }
    if (!validDate(next.date) || typeof next.name !== 'string' || next.name.trim().length < 2 || next.name.trim().length > 120 ||
        !mongoose.isValidObjectId(next.siteId) || !['ACTIVE', 'ARCHIVED'].includes(next.status)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Holiday fields are invalid.')
    }
    const site = await Site.findOne({ _id: next.siteId, organizationId: req.auth.organization._id, status: 'ACTIVE' })
    if (!site) throw new HttpError(400, 'INVALID_SITE', 'The holiday site must be active in this organization.')
    holiday.date = next.date
    holiday.name = next.name.trim()
    holiday.siteId = next.siteId
    holiday.status = next.status
    await holiday.save()
    res.json({ data: serialize(holiday), meta: { requestId: req.requestId } })
  })

  return router
}

module.exports = { createSchedulesRouter, validDate, timeValue }
