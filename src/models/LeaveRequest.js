const mongoose = require('mongoose')

const leaveRequestSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  personId: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', required: true },
  from: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  to: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  type: { type: String, enum: ['SICK', 'CASUAL', 'EXCUSE', 'OTHER'], required: true },
  reason: { type: String, required: true, maxlength: 1000 },
  status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING', required: true },
  requesterUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reviewerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
}, { timestamps: true })

leaveRequestSchema.index({ organizationId: 1, personId: 1, from: 1, to: 1 })

module.exports = mongoose.models.LeaveRequest || mongoose.model('LeaveRequest', leaveRequestSchema)
