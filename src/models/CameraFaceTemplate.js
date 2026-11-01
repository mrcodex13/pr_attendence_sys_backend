const mongoose = require('mongoose')

const cameraFaceTemplateSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  personId: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', required: true },
  ciphertext: { type: String, required: true, select: false },
  iv: { type: String, required: true, select: false },
  tag: { type: String, required: true, select: false },
  modelVersion: { type: String, required: true, maxlength: 80 },
  enrolledByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  enrolledAt: { type: Date, required: true, default: Date.now },
}, { timestamps: true })

cameraFaceTemplateSchema.index({ organizationId: 1, personId: 1 }, { unique: true })

module.exports = mongoose.models.CameraFaceTemplate ||
  mongoose.model('CameraFaceTemplate', cameraFaceTemplateSchema)
