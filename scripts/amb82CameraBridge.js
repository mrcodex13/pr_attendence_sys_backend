const path = require('node:path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })

const { createAmb82LocalBridge } = require('../src/services/amb82LocalBridge')
const { createRtspFrameSource } = require('../src/services/rtspCamera')

const DEFAULT_ORIGINS = [
  'https://prattendencesysfrontent.vercel.app',
  'http://localhost:5173',
]

function parseAllowedOrigins(value) {
  const origins = value.split(',').map((origin) => origin.trim()).filter(Boolean)
  if (origins.length === 0 || origins.some((origin) => {
    try {
      const parsed = new URL(origin)
      return !['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin
    } catch {
      return true
    }
  })) {
    throw new Error('CAMERA_BRIDGE_ALLOWED_ORIGINS must be comma-separated website origins without paths.')
  }
  return origins
}

function startBridge() {
  const port = 8765
  const configuredOrigins = process.env.CAMERA_BRIDGE_ALLOWED_ORIGINS ||
    process.env.ALLOWED_ORIGINS ||
    process.env.CORS_ORIGINS ||
    DEFAULT_ORIGINS.join(',')
  const allowedOrigins = parseAllowedOrigins(configuredOrigins)
  const frameSource = createRtspFrameSource({
    url: null,
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || 'ffmpeg',
  })
  const server = createAmb82LocalBridge({ frameSource, allowedOrigins, port })
    .listen(port, '127.0.0.1', () => {
      console.info(`AMB82 local connector listening on http://127.0.0.1:${port}`)
      console.info(`Allowed website origins: ${allowedOrigins.join(', ')}`)
    })

  function shutdown() {
    frameSource.close()
    server.close(() => process.exit(0))
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (require.main === module) {
  try {
    startBridge()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { parseAllowedOrigins, startBridge }
