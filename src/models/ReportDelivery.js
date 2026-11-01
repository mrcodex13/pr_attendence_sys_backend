const mongoose = require('mongoose')

const reportDeliverySchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  scheduleId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReportSchedule', required: true },
  status: { type: String, enum: ['SENDING', 'SENT', 'FAILED'], required: true },
  recipients: [{ type: String, required: true }],
  attemptedAt: { type: Date, required: true, default: Date.now },
  completedAt: { type: Date, default: null },
  error: { type: String, maxlength: 300, default: '' },
}, { timestamps: true })

reportDeliverySchema.index({ organizationId: 1, scheduleId: 1, attemptedAt: -1 })

module.exports = mongoose.models.ReportDelivery || mongoose.model('ReportDelivery', reportDeliverySchema)
