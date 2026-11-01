const mongoose = require('mongoose')

const deviceNonceSchema = new mongoose.Schema({
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
  nonce: { type: String, required: true, maxlength: 128 },
  expiresAt: { type: Date, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } })

deviceNonceSchema.index({ deviceId: 1, nonce: 1 }, { unique: true })
deviceNonceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

module.exports = mongoose.models.DeviceNonce || mongoose.model('DeviceNonce', deviceNonceSchema)
