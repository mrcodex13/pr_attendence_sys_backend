const mongoose = require('mongoose')

const holidaySchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  siteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Site', required: true },
  status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE', required: true },
}, { timestamps: true })

holidaySchema.index({ organizationId: 1, siteId: 1, date: 1 }, { unique: true })

module.exports = mongoose.models.Holiday || mongoose.model('Holiday', holidaySchema)
