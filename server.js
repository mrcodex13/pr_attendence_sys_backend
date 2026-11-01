const mongoose = require('mongoose')
const { config } = require('./src/config')
const { createApp } = require('./src/app')
const { createMailer } = require('./src/services/mailer')
const { startReportScheduler } = require('./src/services/reportScheduler')

const DATABASE_RETRY_DELAY_MS = 5000

async function start() {
  if (config.mongoUri && config.nodeEnv === 'production') {
    await mongoose.connect(config.mongoUri)
    console.info(JSON.stringify({ level: 'info', event: 'database_connected' }))
  } else if (!config.mongoUri) {
    console.warn(JSON.stringify({ level: 'warn', event: 'database_not_configured', message: 'Readiness will remain false.' }))
  }

  const app = createApp({ config })
  const stopReportScheduler = config.smtpHost
    ? startReportScheduler({ mailer: createMailer(config), logger: console })
    : () => {}
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.info(JSON.stringify({ level: 'info', event: 'server_started', port: config.port, host: '0.0.0.0', environment: config.nodeEnv }))
  })

  let shuttingDown = false
  let databaseRetryTimer
  let databaseConnecting = false

  async function connectDevelopmentDatabase() {
    if (shuttingDown || databaseConnecting || mongoose.connection.readyState === 1) return
    databaseConnecting = true
    try {
      await mongoose.connect(config.mongoUri)
      console.info(JSON.stringify({ level: 'info', event: 'database_connected' }))
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'database_connection_failed',
        error: error instanceof Error ? error.name : 'Unknown error',
        retryInMs: DATABASE_RETRY_DELAY_MS,
      }))
      if (!shuttingDown) {
        databaseRetryTimer = setTimeout(() => {
          databaseRetryTimer = undefined
          void connectDevelopmentDatabase()
        }, DATABASE_RETRY_DELAY_MS)
      }
    } finally {
      databaseConnecting = false
    }
  }

  if (config.mongoUri && config.nodeEnv !== 'production') {
    void connectDevelopmentDatabase()
  }

  async function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true
    if (databaseRetryTimer) clearTimeout(databaseRetryTimer)
    stopReportScheduler()
    app.locals.closeCameraFrameSource()
    console.info(JSON.stringify({ level: 'info', event: 'shutdown_started', signal }))
    server.close(async (error) => {
      if (error) {
        console.error(JSON.stringify({ level: 'error', event: 'server_close_failed', message: error.message }))
        process.exitCode = 1
      }
      try {
        await mongoose.disconnect()
      } catch (disconnectError) {
        console.error(JSON.stringify({
          level: 'error',
          event: 'database_disconnect_failed',
          message: disconnectError instanceof Error ? disconnectError.message : 'Unknown error',
        }))
        process.exitCode = 1
      }
    })
  }

  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

if (require.main === module) {
  start().catch((error) => {
    console.error(JSON.stringify({
      level: 'error',
      event: 'startup_failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    }))
    process.exitCode = 1
  })
}

module.exports = { start }
