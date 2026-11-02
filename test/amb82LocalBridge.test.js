const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createAmb82LocalBridge, isValidRtspUrl } = require('../src/services/amb82LocalBridge')

async function withBridge(frameSource, run) {
  const server = createAmb82LocalBridge({
    frameSource,
    allowedOrigins: ['https://prattendencesysfrontent.vercel.app'],
  }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('local camera bridge validates RTSP URLs without exposing credentials', () => {
  assert.equal(isValidRtspUrl('rtsp://user:password@192.168.1.10:554/live'), true)
  assert.equal(isValidRtspUrl('https://camera.example/live'), false)
  assert.equal(isValidRtspUrl('not a url'), false)
})

test('local camera bridge only permits configured website origins', async () => {
  const frameSource = {
    getUrl: () => null,
    setUrl() {},
    getLatestFrame() {},
  }

  await withBridge(frameSource, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://untrusted.example' },
    })
    assert.equal(response.status, 403)
  })
})

test('local camera bridge configures the stream and serves JPEG frames', async () => {
  const frame = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9])
  let url = null
  const frameSource = {
    getUrl: () => url,
    setUrl(value) { url = value },
    getLatestFrame() { return frame },
  }
  const origin = 'https://prattendencesysfrontent.vercel.app'

  await withBridge(frameSource, async (baseUrl) => {
    const configured = await fetch(`${baseUrl}/configure`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'rtsp://camera.local:554/live' }),
    })
    assert.equal(configured.status, 200)
    assert.equal(url, 'rtsp://camera.local:554/live')

    const response = await fetch(`${baseUrl}/frame`, { headers: { Origin: origin } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/jpeg')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), frame)
  })
})

test('local camera bridge handles private-network preflight requests', async () => {
  const frameSource = {
    getUrl: () => null,
    setUrl() {},
    getLatestFrame() {},
  }

  await withBridge(frameSource, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/configure`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://prattendencesysfrontent.vercel.app',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
        'Access-Control-Request-Private-Network': 'true',
      },
    })
    assert.equal(response.status, 204)
    assert.equal(response.headers.get('access-control-allow-private-network'), 'true')
  })
})
