const mongoose = require('mongoose')

const invitationSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  role: { type: String, enum: ['ADMIN', 'TEACHER', 'MANAGER', 'EMPLOYEE', 'STUDENT'], required: true },
  groupIds: { type: [String], default: [] },
  personGroupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null },
  codeHash: { type: String, required: true, unique: true, select: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt: { type: Date, required: true, index: true },
  claimedAt: { type: Date, default: null },
  claimId: { type: String, default: null },
  usedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
}, { timestamps: true })

invitationSchema.index({ organizationId: 1, email: 1, usedAt: 1 })

module.exports = mongoose.models.Invitation || mongoose.model('Invitation', invitationSchema)
