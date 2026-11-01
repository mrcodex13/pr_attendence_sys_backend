const mongoose = require('mongoose')

const notificationSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, maxlength: 160 },
  description: { type: String, required: true, maxlength: 500 },
  tone: { type: String, enum: ['blue', 'green', 'red', 'amber'], default: 'blue' },
  icon: { type: String, maxlength: 40, default: 'info' },
  readAt: { type: Date, default: null },
}, { timestamps: true })

notificationSchema.index({ organizationId: 1, userId: 1, createdAt: -1 })

module.exports = mongoose.models.Notification || mongoose.model('Notification', notificationSchema)
