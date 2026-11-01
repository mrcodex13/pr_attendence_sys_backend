const { randomUUID } = require('node:crypto')
const cors = require('cors')
const express = require('express')
const helmet = require('helmet')
const mongoose = require('mongoose')
const { createOrganizationRouter } = require('./routes/organization')
const { createAuthRouter } = require('./routes/auth')
const { createUsersRouter } = require('./routes/users')
const { createSchedulesRouter } = require('./routes/schedules')
const { createWorkflowsRouter } = require('./routes/workflows')
const { createDevicesRouter } = require('./routes/devices')
const { createCameraRouter } = require('./routes/camera')
const { createSupabaseFaceTemplateStore } = require('./services/supabaseFaceTemplates')
const { createRtspFrameSource } = require('./services/rtspCamera')

function createApp({
  config,
  getDatabaseReady = () => mongoose.connection.readyState === 1,
  logger = console,
  mailer,
  authRateLimits,
  faceTemplateStore,
  cameraFrameSource,
}) {
  const app = express()
  const resolvedFaceTemplateStore = faceTemplateStore || createSupabaseFaceTemplateStore({ config })
  const resolvedCameraFrameSource = cameraFrameSource || createRtspFrameSource({
    url: config.amb82RtspUrl,
    ffmpegPath: config.ffmpegPath,
  })

  app.disable('x-powered-by')
  app.use(helmet())
  app.use((req, res, next) => {
    req.requestId = randomUUID()
    res.setHeader('X-Request-Id', req.requestId)
    const startedAt = Date.now()
    res.on('finish', () => {
      logger.info(JSON.stringify({
        level: 'info',
        event: 'http_request',
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      }))
    })
    next()
  })
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true)
      const error = new Error('Origin is not allowed by CORS.')
      error.status = 403
      error.code = 'ORIGIN_NOT_ALLOWED'
      return callback(error)
    },
  }))
  app.use(express.json({
    limit: config.jsonBodyLimit,
    verify(req, _res, buffer) {
      req.rawBody = Buffer.from(buffer)
    },
  }))

  app.get('/', (_req, res) => {
    res.json({ status: 'ok' })
  })

  app.get('/api/v1/health/live', (req, res) => {
    res.json({ data: { status: 'ok' }, meta: { requestId: req.requestId } })
  })

  app.get('/api/v1/health/ready', (req, res) => {
    const ready = getDatabaseReady()
    res.status(ready ? 200 : 503).json(ready
      ? { data: { status: 'ready', database: 'connected' }, meta: { requestId: req.requestId } }
      : {
          error: { code: 'NOT_READY', message: 'Required services are not ready.' },
          meta: { requestId: req.requestId },
        })
  })

  app.use('/api/v1/auth', createAuthRouter({ config, logger, mailer, rateLimits: authRateLimits }))
  app.use('/api/v1', createOrganizationRouter({ config, faceTemplateStore: resolvedFaceTemplateStore }))
  app.use('/api/v1', createDevicesRouter({ config }))
  app.use('/api/v1', createCameraRouter({
    config,
    faceTemplateStore: resolvedFaceTemplateStore,
    cameraFrameSource: resolvedCameraFrameSource,
  }))
  app.locals.closeCameraFrameSource = () => resolvedCameraFrameSource.close?.()
  app.use('/api/v1/users', createUsersRouter({ config }))
  app.use('/api/v1', createSchedulesRouter({ config }))
  app.use('/api/v1', createWorkflowsRouter({ config }))

  app.use((req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
      meta: { requestId: req.requestId },
    })
  })

  app.use((error, req, res, _next) => {
    if (res.headersSent) return

    const status = error.code === 11000
      ? 409
      : ['ValidationError', 'CastError'].includes(error.name)
        ? 400
        : Number.isInteger(error.status) && error.status >= 400 && error.status < 500
      ? error.status
      : 500
    const code = error.code === 11000
      ? 'RESOURCE_ALREADY_EXISTS'
      : error.name === 'CastError'
        ? 'VALIDATION_ERROR'
      : error.name === 'ValidationError'
        ? 'VALIDATION_ERROR'
        : status === 400 && error.type === 'entity.parse.failed'
      ? 'INVALID_JSON'
      : status === 413
        ? 'PAYLOAD_TOO_LARGE'
        : error.code || (status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR')
    const message = status === 500
      ? 'An unexpected server error occurred.'
      : error.code === 11000
        ? 'A resource with the same unique value already exists.'
        : error.name === 'CastError'
          ? 'A supplied identifier is invalid.'
        : error.message || 'The request could not be processed.'

    if (status >= 500) {
      logger.error(JSON.stringify({
        level: 'error',
        event: 'request_failed',
        requestId: req.requestId,
        message: error instanceof Error ? error.message : 'Unknown error',
      }))
    }

    res.status(status).json({
      error: { code, message },
      meta: { requestId: req.requestId },
    })
  })

  return app
}

module.exports = { createApp }
