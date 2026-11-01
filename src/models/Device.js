const mongoose = require('mongoose')

const deviceSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  deviceCode: { type: String, required: true, trim: true, uppercase: true, minlength: 2, maxlength: 64 },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  siteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', default: null },
  groupIds: [{ type: String, required: true }],
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', required: true },
  secretCiphertext: { type: String, required: true, select: false },
  secretIv: { type: String, required: true, select: false },
  secretTag: { type: String, required: true, select: false },
  firmwareVersion: { type: String, maxlength: 40, default: '' },
  lastSeenAt: { type: Date, default: null },
  lastEventAt: { type: Date, default: null },
}, { timestamps: true })

deviceSchema.index({ organizationId: 1, deviceCode: 1 }, { unique: true })

module.exports = mongoose.models.Device || mongoose.model('Device', deviceSchema)
