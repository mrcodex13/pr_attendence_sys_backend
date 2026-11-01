const { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto')

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
const NONCE_TTL_MS = 10 * 60 * 1000

function encryptionKey(config) {
  return createHash('sha256')
    .update('pr-smart-attendance-device-secret-v1\0')
    .update(config.deviceSecretEncryptionKey || config.accessTokenSecret)
    .digest()
}

function encryptDeviceSecret(secret, config) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(config), iv)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return {
    secretCiphertext: ciphertext.toString('base64url'),
    secretIv: iv.toString('base64url'),
    secretTag: cipher.getAuthTag().toString('base64url'),
  }
}

function decryptDeviceSecret(device, config) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(config),
    Buffer.from(device.secretIv, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(device.secretTag, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(device.secretCiphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

function canonicalRequest({ timestamp, nonce, method, path, rawBody }) {
  return Buffer.concat([
    Buffer.from(`${timestamp}\n${nonce}\n${method.toUpperCase()}\n${path}\n`, 'utf8'),
    rawBody || Buffer.alloc(0),
  ])
}

function signDeviceRequest(secret, request) {
  return createHmac('sha256', secret).update(canonicalRequest(request)).digest('hex')
}

function signaturesMatch(expected, received) {
  if (typeof received !== 'string' || !/^[a-f0-9]{64}$/i.test(received)) return false
  const expectedBuffer = Buffer.from(expected, 'hex')
  const receivedBuffer = Buffer.from(received, 'hex')
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer)
}

module.exports = {
  MAX_CLOCK_SKEW_MS,
  NONCE_TTL_MS,
  decryptDeviceSecret,
  encryptDeviceSecret,
  signDeviceRequest,
  signaturesMatch,
}
