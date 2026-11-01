const mongoose = require('mongoose')

const auditEventSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  action: { type: String, required: true, maxlength: 100 },
  entityType: { type: String, required: true, maxlength: 80 },
  entityId: { type: String, maxlength: 120, default: '' },
  detail: { type: String, maxlength: 500, default: '' },
  requestId: { type: String, maxlength: 80, default: '' },
}, { timestamps: { createdAt: true, updatedAt: false } })

auditEventSchema.index({ organizationId: 1, createdAt: -1 })

module.exports = mongoose.models.AuditEvent || mongoose.model('AuditEvent', auditEventSchema)
