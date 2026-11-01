const path = require('node:path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })
require('dotenv').config()

function parseConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development'
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production.')
  }

  const rawPort = env.PORT || '8000'
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.')
  }

  const mongoUri = env.MONGODB_URI?.trim() || null
  if (nodeEnv === 'production' && !mongoUri) {
    throw new Error('MONGODB_URI is required in production.')
  }
  if (mongoUri && !/^mongodb(\+srv)?:\/\//.test(mongoUri)) {
    throw new Error('MONGODB_URI must use the mongodb:// or mongodb+srv:// scheme.')
  }

  const configuredOrigins = env.ALLOWED_ORIGINS || env.CORS_ORIGINS
  const rawOrigins = configuredOrigins || 'http://localhost:5173'
  if (nodeEnv === 'production' && !configuredOrigins) {
    throw new Error('ALLOWED_ORIGINS must be configured in production.')
  }
  const corsOrigins = rawOrigins.split(',').map((value) => value.trim()).filter(Boolean)
  if (corsOrigins.length === 0 || corsOrigins.some((origin) => {
    try {
      const parsed = new URL(origin)
      return !['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin
    } catch {
      return true
    }
  })) {
    throw new Error('ALLOWED_ORIGINS must be a comma-separated list of HTTP(S) origins without paths.')
  }

  const accessTokenSecret = env.ACCESS_TOKEN_SECRET?.trim() || null
  if (nodeEnv === 'production' && (!accessTokenSecret || accessTokenSecret.length < 32)) {
    throw new Error('ACCESS_TOKEN_SECRET of at least 32 characters is required in production.')
  }
  const deviceSecretEncryptionKey = env.DEVICE_SECRET_ENCRYPTION_KEY?.trim() || null
  if (deviceSecretEncryptionKey && deviceSecretEncryptionKey.length < 32) {
    throw new Error('DEVICE_SECRET_ENCRYPTION_KEY must be at least 32 characters when provided.')
  }
  const faceTemplateEncryptionKey = env.FACE_TEMPLATE_ENCRYPTION_KEY?.trim() || null
  if (faceTemplateEncryptionKey && faceTemplateEncryptionKey.length < 32) {
    throw new Error('FACE_TEMPLATE_ENCRYPTION_KEY must be at least 32 characters when provided.')
  }
  if (nodeEnv === 'production' && !faceTemplateEncryptionKey) {
    throw new Error('FACE_TEMPLATE_ENCRYPTION_KEY is required in production.')
  }

  const supabaseUrl = env.SUPABASE_URL?.trim() || null
  const supabaseSecretKey = env.SUPABASE_SECRET_KEY?.trim() || null
  if (Boolean(supabaseUrl) !== Boolean(supabaseSecretKey)) {
    throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be configured together.')
  }
  if (supabaseUrl) {
    try {
      const parsedSupabaseUrl = new URL(supabaseUrl)
      if (!['http:', 'https:'].includes(parsedSupabaseUrl.protocol) || parsedSupabaseUrl.origin !== supabaseUrl) {
        throw new Error()
      }
    } catch {
      throw new Error('SUPABASE_URL must be a valid HTTP(S) origin without a path.')
    }
  }
  if (nodeEnv === 'production' && !supabaseUrl) {
    throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required in production.')
  }

  const amb82RtspUrl = env.AMB82_RTSP_URL?.trim() || env.RTSP_URI?.trim() || null
  if (amb82RtspUrl) {
    try {
      const parsedRtspUrl = new URL(amb82RtspUrl)
      if (!['rtsp:', 'rtsps:'].includes(parsedRtspUrl.protocol) || !parsedRtspUrl.hostname) throw new Error()
    } catch {
      throw new Error('AMB82_RTSP_URL must be a valid rtsp:// or rtsps:// URL.')
    }
  }
  const ffmpegPath = env.FFMPEG_PATH?.trim() || 'ffmpeg'

  const refreshTokenDays = Number(env.REFRESH_TOKEN_DAYS || '30')
  if (!Number.isInteger(refreshTokenDays) || refreshTokenDays < 1 || refreshTokenDays > 90) {
    throw new Error('REFRESH_TOKEN_DAYS must be an integer between 1 and 90.')
  }
  const accessTokenTtl = env.ACCESS_TOKEN_TTL || '15m'
  if (!/^\d+(s|m|h|d)$/.test(accessTokenTtl)) {
    throw new Error('ACCESS_TOKEN_TTL must use seconds, minutes, hours, or days (for example 15m).')
  }

  const smtpHost = env.SMTP_HOST?.trim() || null
  const smtpPort = Number(env.SMTP_PORT || '587')
  const smtpUser = env.SMTP_USER?.trim() || null
  const smtpPassword = env.SMTP_PASSWORD || null
  const mailFrom = env.MAIL_FROM?.trim() || null
  const mailEnabled = Boolean(smtpHost && smtpUser && smtpPassword && mailFrom)
  if (mailEnabled && (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)) {
    throw new Error('SMTP_PORT must be an integer between 1 and 65535.')
  }

  const appUrl = env.APP_URL || 'http://localhost:5173'
  try {
    const parsedAppUrl = new URL(appUrl)
    if (!['http:', 'https:'].includes(parsedAppUrl.protocol)) throw new Error()
  } catch {
    throw new Error('APP_URL must be a valid HTTP(S) URL.')
  }
  const devPasswordResetEnabled = nodeEnv === 'development' &&
    env.DEV_PASSWORD_RESET_ENABLED === 'true'

  return {
    nodeEnv,
    devPasswordResetEnabled,
    port,
    mongoUri,
    corsOrigins,
    jsonBodyLimit: '1mb',
    accessTokenSecret: accessTokenSecret || require('node:crypto').randomBytes(32).toString('hex'),
    accessTokenTtl,
    deviceSecretEncryptionKey: deviceSecretEncryptionKey || accessTokenSecret || null,
    faceTemplateEncryptionKey,
    supabaseUrl,
    supabaseSecretKey,
    amb82RtspUrl,
    ffmpegPath,
    refreshTokenDays,
    mailEnabled,
    smtpHost,
    smtpPort,
    smtpSecure: env.SMTP_SECURE === 'true',
    smtpUser,
    smtpPassword,
    mailFrom,
    appUrl,
  }
}

const config = parseConfig()

module.exports = { config, parseConfig }
