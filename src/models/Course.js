const mongoose = require('mongoose')

const courseSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  code: { type: String, required: true, trim: true, uppercase: true, minlength: 2, maxlength: 40 },
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
  teacherUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE', required: true },
}, { timestamps: true })

courseSchema.index({ organizationId: 1, code: 1 }, { unique: true })

module.exports = mongoose.models.Course || mongoose.model('Course', courseSchema)
