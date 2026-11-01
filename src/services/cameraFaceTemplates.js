const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('node:crypto')

const DESCRIPTOR_LENGTH = 128
const MAX_ENROLLMENT_SAMPLES = 5
const MAX_MATCH_DISTANCE = 0.5
const MIN_MATCH_MARGIN = 0.08
const MODEL_VERSION = 'face-api-128-v1'

function validateDescriptor(value) {
  if (!Array.isArray(value) || value.length !== DESCRIPTOR_LENGTH ||
    value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry) || entry < -2 || entry > 2)) {
    return false
  }
  return value.some((entry) => entry !== 0)
}

function validateDescriptors(value) {
  return Array.isArray(value) && value.length >= 1 && value.length <= MAX_ENROLLMENT_SAMPLES &&
    value.every(validateDescriptor)
}

function encryptionKey(config) {
  if (typeof config.faceTemplateEncryptionKey !== 'string' || config.faceTemplateEncryptionKey.length < 32) {
    const error = new Error('Face-template encryption is not configured.')
    error.status = 503
    error.code = 'FACE_TEMPLATE_STORAGE_DISABLED'
    throw error
  }
  return createHash('sha256')
    .update('pr-smart-attendance-camera-template-v1\0')
    .update(config.faceTemplateEncryptionKey)
    .digest()
}

function templateAad({ organizationId, personId, modelVersion }) {
  if (!organizationId || !personId || modelVersion !== MODEL_VERSION) {
    throw new Error('Face-template encryption context is invalid.')
  }
  return Buffer.from(
    `pr-smart-attendance-camera-template-v1\n${organizationId}\n${personId}\n${modelVersion}`,
    'utf8',
  )
}

function encryptDescriptors(descriptors, { organizationId, personId, config }) {
  if (!validateDescriptors(descriptors)) {
    throw new Error('Face descriptors are invalid.')
  }
  const modelVersion = MODEL_VERSION
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(config), iv)
  cipher.setAAD(templateAad({ organizationId, personId, modelVersion }))
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(descriptors), 'utf8'),
    cipher.final(),
  ])
  return {
    ciphertext: ciphertext.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    modelVersion,
  }
}

function decryptDescriptors(template, { organizationId, personId, config }) {
  const modelVersion = template.modelVersion
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(config),
    Buffer.from(template.iv, 'base64url'),
  )
  decipher.setAAD(templateAad({ organizationId, personId, modelVersion }))
  decipher.setAuthTag(Buffer.from(template.tag, 'base64url'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(template.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
  const descriptors = JSON.parse(plaintext)
  if (!validateDescriptors(descriptors)) {
    throw new Error('Stored face template is invalid.')
  }
  return descriptors
}

function descriptorDistance(left, right) {
  let squaredDistance = 0
  for (let index = 0; index < DESCRIPTOR_LENGTH; index += 1) {
    const difference = left[index] - right[index]
    squaredDistance += difference * difference
  }
  return Math.sqrt(squaredDistance)
}

function findBestMatch(descriptor, templates) {
  const ranked = templates.map((template) => ({
    personId: template.personId.toString(),
    distance: Math.min(...template.descriptors.map((sample) => descriptorDistance(descriptor, sample))),
  })).sort((left, right) => left.distance - right.distance)

  const best = ranked[0]
  if (!best || best.distance > MAX_MATCH_DISTANCE) return { matched: false, reason: 'NO_MATCH' }
  if (ranked[1] && ranked[1].distance - best.distance < MIN_MATCH_MARGIN) {
    return { matched: false, reason: 'AMBIGUOUS' }
  }
  return {
    matched: true,
    personId: best.personId,
    confidence: Math.max(0, Math.min(1, 1 - best.distance)),
  }
}

module.exports = {
  DESCRIPTOR_LENGTH,
  MAX_ENROLLMENT_SAMPLES,
  MODEL_VERSION,
  decryptDescriptors,
  encryptDescriptors,
  findBestMatch,
  validateDescriptor,
  validateDescriptors,
}
