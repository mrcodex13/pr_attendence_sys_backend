const mongoose = require('mongoose')

const importBatchSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  idempotencyKey: { type: String, required: true },
  contentHash: { type: String, required: true },
  result: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: true })

importBatchSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true })

module.exports = mongoose.models.ImportBatch || mongoose.model('ImportBatch', importBatchSchema)
