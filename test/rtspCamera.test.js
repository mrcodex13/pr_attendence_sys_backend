const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { test } = require('node:test')
const { createRtspFrameSource } = require('../src/services/rtspCamera')

function createFakeProcess() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.kill = () => {
    child.killed = true
  }
  return child
}

test('RTSP frame source reports missing configuration', () => {
  const source = createRtspFrameSource({ url: null })

  assert.throws(() => source.getLatestFrame(), {
    code: 'AMB82_STREAM_NOT_CONFIGURED',
    status: 503,
  })
})

test('RTSP frame source extracts JPEG frames from FFmpeg output', () => {
  const child = createFakeProcess()
  let spawnArguments
  const source = createRtspFrameSource({
    url: 'rtsp://camera.local/live',
    ffmpegPath: 'C:\\tools\\ffmpeg.exe',
    spawnProcess(...args) {
      spawnArguments = args
      return child
    },
  })

  assert.throws(() => source.getLatestFrame(), { code: 'AMB82_STREAM_CONNECTING' })
  assert.equal(spawnArguments[0], 'C:\\tools\\ffmpeg.exe')
  assert.ok(spawnArguments[1].includes('rtsp://camera.local/live'))
  assert.ok(spawnArguments[1].includes('nobuffer'))
  assert.ok(spawnArguments[1].includes('low_delay'))
  assert.ok(spawnArguments[1].includes('fps=5'))
  assert.equal(spawnArguments[1][spawnArguments[1].indexOf('-flush_packets') + 1], '1')

  const frame = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9])
  child.stdout.write(Buffer.concat([Buffer.from('ignored'), frame.subarray(0, 3)]))
  assert.throws(() => source.getLatestFrame(), { code: 'AMB82_STREAM_CONNECTING' })
  child.stdout.write(frame.subarray(3))

  assert.deepEqual(source.getLatestFrame(), frame)
  source.close()
  assert.equal(child.killed, true)
})
