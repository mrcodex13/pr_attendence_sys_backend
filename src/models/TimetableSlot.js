const mongoose = require('mongoose')

const timetableSlotSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  weekday: { type: Number, required: true, min: 0, max: 6 },
  start: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  end: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  room: { type: String, trim: true, maxlength: 120, default: '' },
  effectiveFrom: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, default: null },
  effectiveTo: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, default: null },
  status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE', required: true },
}, { timestamps: true })

timetableSlotSchema.index({ organizationId: 1, courseId: 1, weekday: 1, status: 1 })

module.exports = mongoose.models.TimetableSlot || mongoose.model('TimetableSlot', timetableSlotSchema)
