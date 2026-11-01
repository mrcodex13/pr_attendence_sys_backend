const mongoose = require('mongoose')

const membershipSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  role: { type: String, enum: ['SUPER_ADMIN', 'ADMIN', 'TEACHER', 'MANAGER', 'EMPLOYEE', 'STUDENT'], required: true },
  groupIds: { type: [String], default: [] },
  personId: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', default: null },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', required: true },
}, { _id: false })

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  email: { type: String, required: true, trim: true, lowercase: true, unique: true, maxlength: 254 },
  passwordHash: { type: String, required: true, select: false },
  status: { type: String, enum: ['ACTIVE', 'DISABLED'], default: 'ACTIVE', required: true },
  memberships: { type: [membershipSchema], default: [] },
  passwordResetHash: { type: String, select: false },
  passwordResetExpiresAt: { type: Date, select: false },
}, { timestamps: true })

module.exports = mongoose.models.User || mongoose.model('User', userSchema)
