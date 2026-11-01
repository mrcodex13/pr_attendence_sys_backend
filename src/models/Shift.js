const mongoose = require('mongoose')

const shiftSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  start: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  end: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  graceMinutes: { type: Number, min: 0, max: 720, default: 0 },
  workingDays: { type: [Number], required: true, validate: (days) => days.length > 0 && days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) },
  effectiveFrom: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, default: null },
  effectiveTo: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, default: null },
  status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE', required: true },
}, { timestamps: true })

module.exports = mongoose.models.Shift || mongoose.model('Shift', shiftSchema)
