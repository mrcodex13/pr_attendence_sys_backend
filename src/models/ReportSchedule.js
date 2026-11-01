const mongoose = require('mongoose')

const reportScheduleSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  reportType: { type: String, enum: ['ATTENDANCE'], default: 'ATTENDANCE', required: true },
  format: { type: String, enum: ['CSV', 'XLSX'], required: true },
  frequency: { type: String, enum: ['DAILY', 'WEEKLY', 'MONTHLY'], required: true },
  weekday: { type: Number, min: 0, max: 6, default: null },
  monthDay: { type: Number, min: 1, max: 28, default: null },
  localTime: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  timezone: { type: String, required: true, maxlength: 80 },
  recipients: [{ type: String, required: true, lowercase: true, trim: true, maxlength: 254 }],
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null },
  status: { type: String, enum: ['ACTIVE', 'PAUSED', 'ARCHIVED'], default: 'ACTIVE', required: true },
  nextRunAt: { type: Date, required: true, index: true },
  lastRunAt: { type: Date, default: null },
  lockedAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true })

reportScheduleSchema.index({ status: 1, nextRunAt: 1 })

module.exports = mongoose.models.ReportSchedule || mongoose.model('ReportSchedule', reportScheduleSchema)
