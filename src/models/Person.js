const mongoose = require('mongoose')

const personSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  personCode: { type: String, required: true, trim: true, uppercase: true, minlength: 2, maxlength: 40 },
  type: { type: String, enum: ['STUDENT', 'EMPLOYEE'], required: true },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  email: { type: String, trim: true, lowercase: true, maxlength: 254, default: '' },
  phone: { type: String, trim: true, maxlength: 32, default: '' },
  photoUrl: { type: String, default: undefined },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', required: true },
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
  rollNumber: { type: String, trim: true, maxlength: 80, default: '' },
  semester: { type: String, trim: true, maxlength: 40, default: '' },
  employeeId: { type: String, trim: true, maxlength: 80, default: '' },
  designation: { type: String, trim: true, maxlength: 120, default: '' },
  consentGiven: { type: Boolean, default: false, required: true },
  consentGivenAt: { type: Date, default: null },
  consentSource: { type: String, maxlength: 80, default: null },
  cameraConsentGiven: { type: Boolean, default: false, required: true },
  cameraConsentGivenAt: { type: Date, default: null },
  cameraConsentSource: { type: String, maxlength: 80, default: null },
  consentHistory: [{
    given: { type: Boolean, required: true },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    source: { type: String, required: true, maxlength: 80 },
    recordedAt: { type: Date, required: true, default: Date.now },
  }],
  cameraConsentHistory: [{
    given: { type: Boolean, required: true },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    source: { type: String, required: true, maxlength: 80 },
    recordedAt: { type: Date, required: true, default: Date.now },
  }],
}, { timestamps: true })

personSchema.index({ organizationId: 1, personCode: 1 }, { unique: true })
personSchema.index({ organizationId: 1, groupId: 1, status: 1 })
personSchema.index(
  { organizationId: 1, email: 1 },
  { unique: true, partialFilterExpression: { email: { $gt: '' } } },
)

module.exports = mongoose.models.Person || mongoose.model('Person', personSchema)
