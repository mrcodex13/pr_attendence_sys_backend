const mongoose = require('mongoose')

const organizationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  slug: { type: String, required: true, trim: true, lowercase: true, unique: true, maxlength: 80 },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', required: true },
  settings: {
    mode: { type: String, enum: ['SCHOOL', 'COMPANY', 'BOTH'], default: 'BOTH' },
    timezone: { type: String, default: 'Asia/Kolkata' },
    graceMinutes: { type: Number, default: 10 },
    debounceSeconds: { type: Number, default: 60 },
    minConfidence: { type: Number, default: 0.72 },
    retentionDays: { type: Number, default: 365 },
  },
}, { timestamps: true })

module.exports = mongoose.models.Organization || mongoose.model('Organization', organizationSchema)
