const mongoose = require('mongoose')

const attendanceRecordSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  personId: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', required: true },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  scheduleId: { type: mongoose.Schema.Types.ObjectId, ref: 'TimetableSlot', default: null },
  status: { type: String, enum: ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED', 'HALF_DAY'], required: true },
  firstIn: { type: Date, default: null },
  lastOut: { type: Date, default: null },
  minutesWorked: { type: Number, min: 0, default: 0 },
  source: { type: String, enum: ['DEVICE', 'CAMERA', 'MANUAL', 'IMPORT'], required: true },
  derivedFromEventIds: [{ type: String, maxlength: 121 }],
  corrections: [{
    oldStatus: { type: String, enum: ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED', 'HALF_DAY'], required: true },
    newStatus: { type: String, enum: ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED', 'HALF_DAY'], required: true },
    reason: { type: String, required: true, maxlength: 500 },
    byUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, required: true, default: Date.now },
  }],
}, { timestamps: true })

attendanceRecordSchema.index({ organizationId: 1, personId: 1, date: 1, scheduleId: 1 }, { unique: true })
attendanceRecordSchema.index({ organizationId: 1, date: 1, status: 1 })

module.exports = mongoose.models.AttendanceRecord || mongoose.model('AttendanceRecord', attendanceRecordSchema)
