const mongoose = require('mongoose')

const privacyDeletionRequestSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  personId: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', required: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reason: { type: String, required: true, maxlength: 1000 },
  status: { type: String, enum: ['REQUESTED', 'APPROVED', 'REJECTED', 'DEVICE_PENDING', 'COMPLETED'], default: 'REQUESTED', required: true },
  reviewNote: { type: String, maxlength: 500, default: '' },
  reviewedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
}, { timestamps: true })

privacyDeletionRequestSchema.index({ organizationId: 1, personId: 1, status: 1 })

module.exports = mongoose.models.PrivacyDeletionRequest || mongoose.model('PrivacyDeletionRequest', privacyDeletionRequestSchema)
