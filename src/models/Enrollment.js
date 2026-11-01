const mongoose = require('mongoose')

const enrollmentSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true, index: true },
  personId: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', required: true, index: true },
  commandId: { type: String, required: true, maxlength: 80 },
  status: { type: String, enum: ['PENDING', 'ENROLLED', 'FAILED', 'DELETE_PENDING', 'DELETE_FAILED', 'REMOVED', 'CANCELLED'], default: 'PENDING', required: true },
  resultMessage: { type: String, maxlength: 500, default: '' },
  startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  completedAt: { type: Date, default: null },
}, { timestamps: true })

enrollmentSchema.index({ organizationId: 1, personId: 1, deviceId: 1, status: 1 })

module.exports = mongoose.models.Enrollment || mongoose.model('Enrollment', enrollmentSchema)
