const assert = require('node:assert/strict')
const { after, before, test } = require('node:test')
const { createApp } = require('../src/app')
const { parseConfig } = require('../src/config')

const config = {
  nodeEnv: 'test',
  corsOrigins: ['http://localhost:5173'],
  jsonBodyLimit: '1mb',
}
const logger = { info() {}, error() {} }
let server
let baseUrl

before(async () => {
  const app = createApp({ config, getDatabaseReady: () => false, logger })
  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

test('liveness is independent of database readiness', async () => {
  const response = await fetch(`${baseUrl}/api/v1/health/live`)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.data.status, 'ok')
  assert.equal(body.meta.requestId, response.headers.get('x-request-id'))
})

test('readiness reports unavailable required services', async () => {
  const response = await fetch(`${baseUrl}/api/v1/health/ready`)
  const body = await response.json()

  assert.equal(response.status, 503)
  assert.equal(body.error.code, 'NOT_READY')
})

test('unknown routes use the standard error envelope', async () => {
  const response = await fetch(`${baseUrl}/api/v1/does-not-exist`)
  const body = await response.json()

  assert.equal(response.status, 404)
  assert.equal(body.error.code, 'NOT_FOUND')
  assert.ok(body.meta.requestId)
})

test('AMB82 camera frames require authentication', async () => {
  const response = await fetch(`${baseUrl}/api/v1/camera/amb82/frame`)
  const body = await response.json()

  assert.equal(response.status, 401)
  assert.equal(body.error.code, 'UNAUTHENTICATED')
})

test('invalid JSON uses the standard error envelope', async () => {
  const response = await fetch(`${baseUrl}/api/v1/anything`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  })
  const body = await response.json()

  assert.equal(response.status, 400)
  assert.equal(body.error.code, 'INVALID_JSON')
})

test('disallowed browser origins are rejected with a request ID', async () => {
  const response = await fetch(`${baseUrl}/api/v1/health/live`, {
    headers: { Origin: 'https://untrusted.example' },
  })
  const body = await response.json()

  assert.equal(response.status, 403)
  assert.equal(body.error.code, 'ORIGIN_NOT_ALLOWED')
  assert.ok(body.meta.requestId)
})

test('production configuration requires a database and explicit CORS origins', () => {
  assert.throws(() => parseConfig({ NODE_ENV: 'production' }), /MONGODB_URI is required/)
  assert.throws(() => parseConfig({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://localhost/test' }), /CORS_ORIGINS must be configured/)
})

test('configuration rejects invalid ports and non-origin CORS values', () => {
  assert.throws(() => parseConfig({ PORT: '70000' }), /PORT must be an integer/)
  assert.throws(() => parseConfig({ CORS_ORIGINS: 'http://localhost:5173/path' }), /CORS_ORIGINS must be/)
  assert.throws(() => parseConfig({ ACCESS_TOKEN_TTL: 'not-a-duration' }), /ACCESS_TOKEN_TTL must use/)
  assert.throws(() => parseConfig({ DEVICE_SECRET_ENCRYPTION_KEY: 'too-short' }), /DEVICE_SECRET_ENCRYPTION_KEY must be at least 32 characters/)
  assert.throws(() => parseConfig({ FACE_TEMPLATE_ENCRYPTION_KEY: 'too-short' }), /FACE_TEMPLATE_ENCRYPTION_KEY must be at least 32 characters/)
  assert.throws(() => parseConfig({ SUPABASE_URL: 'https://project.supabase.co' }), /must be configured together/)
  assert.throws(() => parseConfig({
    SUPABASE_URL: 'https://project.supabase.co/path',
    SUPABASE_SECRET_KEY: 'test-secret',
  }), /SUPABASE_URL must be a valid HTTP\(S\) origin/)
  assert.throws(() => parseConfig({ AMB82_RTSP_URL: 'https://camera.example/stream' }), /AMB82_RTSP_URL must be/)
})

test('configuration accepts a private RTSP URL and custom FFmpeg path', () => {
  const config = parseConfig({
    AMB82_RTSP_URL: 'rtsp://camera.local/live',
    FFMPEG_PATH: 'C:\\tools\\ffmpeg.exe',
  })

  assert.equal(config.amb82RtspUrl, 'rtsp://camera.local/live')
  assert.equal(config.ffmpegPath, 'C:\\tools\\ffmpeg.exe')
})

test('development password-reset links require an explicit development-only flag', () => {
  assert.equal(parseConfig({
    NODE_ENV: 'development',
    DEV_PASSWORD_RESET_ENABLED: 'true',
  }).devPasswordResetEnabled, true)
  assert.equal(parseConfig({
    NODE_ENV: 'test',
    DEV_PASSWORD_RESET_ENABLED: 'true',
  }).devPasswordResetEnabled, false)
  assert.equal(parseConfig({
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://localhost/test',
    CORS_ORIGINS: 'https://attendance.example.edu',
    ACCESS_TOKEN_SECRET: 'a'.repeat(32),
    FACE_TEMPLATE_ENCRYPTION_KEY: 'f'.repeat(32),
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SECRET_KEY: 'test-supabase-secret',
    SMTP_HOST: 'smtp.example.edu',
    SMTP_USER: 'demo-user',
    SMTP_PASSWORD: 'demo-password',
    MAIL_FROM: 'attendance@example.edu',
    DEV_PASSWORD_RESET_ENABLED: 'true',
  }).devPasswordResetEnabled, false)
})

test('production configuration requires strong token and mail delivery settings', () => {
  const required = {
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://localhost/test',
    CORS_ORIGINS: 'https://attendance.example.edu',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SECRET_KEY: 'test-supabase-secret',
  }
  assert.throws(() => parseConfig(required), /ACCESS_TOKEN_SECRET/)
  assert.throws(() => parseConfig({
    ...required,
    ACCESS_TOKEN_SECRET: 'a'.repeat(32),
  }), /FACE_TEMPLATE_ENCRYPTION_KEY is required/)
  assert.throws(() => parseConfig({
    ...required,
    ACCESS_TOKEN_SECRET: 'a'.repeat(32),
    FACE_TEMPLATE_ENCRYPTION_KEY: 'f'.repeat(32),
  }), /SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and MAIL_FROM/)
})
