const mongoose = require('mongoose')

const groupSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  kind: { type: String, enum: ['CLASS', 'DEPARTMENT', 'TEAM'], required: true },
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null },
  supervisorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE', required: true },
}, { timestamps: true })

groupSchema.index({ organizationId: 1, name: 1 }, { unique: true })

module.exports = mongoose.models.Group || mongoose.model('Group', groupSchema)
