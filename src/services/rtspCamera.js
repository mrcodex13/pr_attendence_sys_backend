const { spawn } = require('node:child_process')
const { HttpError } = require('../lib/httpError')

const FRAME_INTERVAL = 'fps=5'
const MAX_FRAME_BYTES = 5 * 1024 * 1024
const RESTART_DELAY_MS = 3000
const JPEG_START = Buffer.from([0xff, 0xd8])
const JPEG_END = Buffer.from([0xff, 0xd9])

function createRtspFrameSource({
  url: initialUrl,
  ffmpegPath = 'ffmpeg',
  spawnProcess = spawn,
  now = Date.now,
}) {
  let url = initialUrl
  let child = null
  let latestFrame = null
  let pendingBytes = Buffer.alloc(0)
  let retryAfter = 0
  let lastError = null
  let closed = false

  function resetProcess(errorMessage) {
    child = null
    latestFrame = null
    pendingBytes = Buffer.alloc(0)
    retryAfter = now() + RESTART_DELAY_MS
    lastError = errorMessage
  }

  function consumeFrames(chunk) {
    pendingBytes = Buffer.concat([pendingBytes, chunk])

    while (pendingBytes.length > 0) {
      const start = pendingBytes.indexOf(JPEG_START)
      if (start < 0) {
        pendingBytes = pendingBytes.at(-1) === 0xff
          ? pendingBytes.subarray(-1)
          : Buffer.alloc(0)
        return
      }

      if (start > 0) pendingBytes = pendingBytes.subarray(start)
      const end = pendingBytes.indexOf(JPEG_END, JPEG_START.length)
      if (end < 0) {
        if (pendingBytes.length > MAX_FRAME_BYTES) pendingBytes = Buffer.alloc(0)
        return
      }

      latestFrame = Buffer.from(pendingBytes.subarray(0, end + JPEG_END.length))
      pendingBytes = pendingBytes.subarray(end + JPEG_END.length)
      lastError = null
    }
  }

  function startProcess() {
    if (closed || child || !url || now() < retryAfter) return

    try {
      const process = spawnProcess(ffmpegPath, [
        '-hide_banner',
        '-loglevel', 'error',
        '-nostdin',
        '-rtsp_transport', 'tcp',
        '-fflags', 'nobuffer',
        '-flags', 'low_delay',
        '-i', url,
        '-vf', FRAME_INTERVAL,
        '-an',
        '-f', 'image2pipe',
        '-flush_packets', '1',
        '-vcodec', 'mjpeg',
        '-q:v', '5',
        'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      child = process
      process.stdout.on('data', consumeFrames)
      process.once('error', () => {
        if (child === process) resetProcess('The AMB82 stream process could not start. Check FFMPEG_PATH.')
      })
      process.once('close', () => {
        if (child === process) resetProcess('The AMB82 RTSP stream disconnected. Check its URL and network connection.')
      })
    } catch {
      resetProcess('The AMB82 stream process could not start. Check FFMPEG_PATH.')
    }
  }

  return {
    getUrl() {
      return url || null
    },
    setUrl(newUrl) {
      const sanitized = typeof newUrl === 'string' ? newUrl.trim() : null
      if (sanitized !== url) {
        url = sanitized
        if (child) {
          const oldProcess = child
          child = null
          oldProcess.kill()
        }
        resetProcess(null)
      }
    },
    getLatestFrame() {
      if (!url) {
        throw new HttpError(503, 'AMB82_STREAM_NOT_CONFIGURED', 'Configure AMB82_RTSP_URL in the backend environment.')
      }
      startProcess()
      if (latestFrame) return latestFrame
      if (lastError) throw new HttpError(503, 'AMB82_STREAM_FAILED', lastError)
      throw new HttpError(503, 'AMB82_STREAM_CONNECTING', 'Connecting to the AMB82 RTSP stream.')
    },
    close() {
      closed = true
      latestFrame = null
      pendingBytes = Buffer.alloc(0)
      const process = child
      child = null
      process?.kill()
    },
  }
}

module.exports = { createRtspFrameSource }
