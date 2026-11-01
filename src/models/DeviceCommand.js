const mongoose = require('mongoose')

const deviceCommandSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true, index: true },
  commandId: { type: String, required: true, unique: true, maxlength: 80 },
  type: { type: String, enum: ['REBOOT', 'SYNC_DIRECTORY', 'ENROLL_PERSON', 'DELETE_PERSON'], required: true },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['PENDING', 'ACKNOWLEDGED', 'FAILED', 'CANCELLED', 'EXPIRED'], default: 'PENDING', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resultMessage: { type: String, maxlength: 500, default: '' },
  expiresAt: { type: Date, required: true },
  acknowledgedAt: { type: Date, default: null },
}, { timestamps: true })

deviceCommandSchema.index({ deviceId: 1, status: 1, createdAt: 1 })

module.exports = mongoose.models.DeviceCommand || mongoose.model('DeviceCommand', deviceCommandSchema)
