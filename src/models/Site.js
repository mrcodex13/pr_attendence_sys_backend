const mongoose = require('mongoose')

const siteSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  siteCode: { type: String, required: true, trim: true, uppercase: true, minlength: 2, maxlength: 40 },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  address: { type: String, trim: true, maxlength: 300, default: '' },
  timezone: { type: String, maxlength: 80, default: '' },
  status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE', required: true },
}, { timestamps: true })

siteSchema.index({ organizationId: 1, siteCode: 1 }, { unique: true })

module.exports = mongoose.models.Site || mongoose.model('Site', siteSchema)
