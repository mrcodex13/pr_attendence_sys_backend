const express = require('express')
const { HttpError } = require('../lib/httpError')

function isValidRtspUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const parsed = new URL(value.trim())
    return ['rtsp:', 'rtsps:'].includes(parsed.protocol) && Boolean(parsed.hostname)
  } catch {
    return false
  }
}

function createAmb82LocalBridge({ frameSource, allowedOrigins, port = 8765 }) {
  const app = express()
  const origins = new Set(allowedOrigins)

  app.disable('x-powered-by')
  app.use((req, res, next) => {
    const host = req.headers.host
    const expectedPort = req.socket.localPort || port
    const allowedHosts = new Set([`127.0.0.1:${expectedPort}`, `localhost:${expectedPort}`])
    if (!allowedHosts.has(host)) {
      res.status(403).json({ error: { code: 'INVALID_HOST', message: 'Use the local camera connector address.' } })
      return
    }

    const origin = req.headers.origin
    if (!origin || !origins.has(origin)) {
      res.status(403).json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'This website is not allowed to use the local camera connector.' } })
      return
    }

    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Max-Age', '600')
    if (req.headers['access-control-request-private-network'] === 'true') {
      res.setHeader('Access-Control-Allow-Private-Network', 'true')
    }

    if (req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }
    next()
  })
  app.use(express.json({ limit: '2kb' }))

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', configured: Boolean(frameSource.getUrl()) })
  })

  app.post('/configure', (req, res) => {
    const { url } = req.body || {}
    if (!isValidRtspUrl(url)) {
      throw new HttpError(400, 'INVALID_RTSP_URL', 'Enter a valid rtsp:// or rtsps:// camera URL.')
    }
    frameSource.setUrl(url.trim())
    res.json({ configured: true })
  })

  app.get('/frame', (req, res) => {
    try {
      const frame = frameSource.getLatestFrame()
      res.set('Cache-Control', 'no-store')
      res.type('image/jpeg').send(frame)
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 503
      const message = error.code === 'AMB82_STREAM_NOT_CONFIGURED'
        ? 'Paste the AMB82 RTSP URL in the website and save it to this laptop connector.'
        : error.message || 'The local camera stream is unavailable.'
      res.status(status).json({
        error: {
          code: error.code || 'CAMERA_STREAM_ERROR',
          message,
        },
      })
    }
  })

  app.use((error, _req, res, _next) => {
    const status = Number.isInteger(error.status) ? error.status : 400
    const message = status >= 500
      ? 'The local camera connector could not complete the request.'
      : error.type === 'entity.parse.failed'
        ? 'The request body must be valid JSON.'
        : error.message
    res.status(status).json({
      error: {
        code: error.code || 'INVALID_REQUEST',
        message,
      },
    })
  })

  return app
}

module.exports = { createAmb82LocalBridge, isValidRtspUrl }
