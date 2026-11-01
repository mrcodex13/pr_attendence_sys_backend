const mongoose = require('mongoose')

const scanEventSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  eventId: { type: String, required: true, maxlength: 121 },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', default: null },
  source: { type: String, enum: ['DEVICE', 'CAMERA'], default: 'DEVICE', required: true },
  personId: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', default: null },
  sourcePersonCode: { type: String, maxlength: 40, default: '' },
  rawLabel: { type: String, required: true, maxlength: 120 },
  confidence: { type: Number, min: 0, max: 1, required: true },
  scannedAt: { type: Date, required: true },
  receivedAt: { type: Date, required: true, default: Date.now },
  result: { type: String, enum: ['ACCEPTED', 'DUPLICATE', 'UNKNOWN_PERSON', 'INACTIVE_PERSON', 'LOW_CONFIDENCE', 'REJECTED'], required: true },
  direction: { type: String, enum: ['IN', 'OUT', 'EITHER'], required: true },
  resolution: {
    status: { type: String, enum: ['OPEN', 'RESOLVED'], default: 'OPEN' },
    note: { type: String, maxlength: 500, default: '' },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
  },
}, { timestamps: true })

scanEventSchema.index({ organizationId: 1, eventId: 1 }, { unique: true })
scanEventSchema.index({ organizationId: 1, result: 1, 'resolution.status': 1, receivedAt: -1 })

module.exports = mongoose.models.ScanEvent || mongoose.model('ScanEvent', scanEventSchema)
