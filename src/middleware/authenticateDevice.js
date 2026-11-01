const mongoose = require('mongoose')
const Device = require('../models/Device')
const DeviceNonce = require('../models/DeviceNonce')
const Organization = require('../models/Organization')
const { HttpError } = require('../lib/httpError')
const {
  MAX_CLOCK_SKEW_MS,
  NONCE_TTL_MS,
  decryptDeviceSecret,
  signDeviceRequest,
  signaturesMatch,
} = require('../services/deviceSecurity')

function createAuthenticateDevice({ config }) {
  return async function authenticateDevice(req, _res, next) {
    const deviceId = req.get('X-Device-Id')
    const timestamp = req.get('X-Device-Timestamp')
    const nonce = req.get('X-Device-Nonce')
    const signature = req.get('X-Device-Signature')
    const timestampMs = Number(timestamp)
    const now = Date.now()

    if (!mongoose.isValidObjectId(deviceId) ||
      typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp) ||
      !Number.isSafeInteger(timestampMs) || Math.abs(now - timestampMs) > MAX_CLOCK_SKEW_MS ||
      typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
      typeof signature !== 'string') {
      return next(new HttpError(401, 'INVALID_DEVICE_AUTH', 'Valid device authentication headers are required.'))
    }

    const device = await Device.findById(deviceId).select('+secretCiphertext +secretIv +secretTag')
    if (!device || device.status !== 'ACTIVE') {
      return next(new HttpError(401, 'INVALID_DEVICE_AUTH', 'The device credentials are invalid or inactive.'))
    }
    const organization = await Organization.findOne({ _id: device.organizationId, status: 'ACTIVE' }).select('_id')
    if (!organization) {
      return next(new HttpError(401, 'INVALID_DEVICE_AUTH', 'The device credentials are invalid or inactive.'))
    }

    const expected = signDeviceRequest(decryptDeviceSecret(device, config), {
      timestamp,
      nonce,
      method: req.method,
      path: `${req.baseUrl}${req.path}`,
      rawBody: req.rawBody,
    })
    if (!signaturesMatch(expected, signature)) {
      return next(new HttpError(401, 'INVALID_DEVICE_AUTH', 'The device credentials are invalid or inactive.'))
    }

    try {
      await DeviceNonce.create({
        deviceId: device._id,
        nonce,
        expiresAt: new Date(now + NONCE_TTL_MS),
      })
    } catch (error) {
      if (error?.code === 11000) {
        return next(new HttpError(409, 'DEVICE_REQUEST_REPLAYED', 'This signed request has already been used.'))
      }
      return next(error)
    }

    req.device = device
    next()
  }
}

module.exports = { createAuthenticateDevice }
