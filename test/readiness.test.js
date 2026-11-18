'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const zlib = require('node:zlib')
const { createRuntime } = require('../server/index')

test('mock runtime exposes readiness without claiming database dependencies', async () => {
  const runtime = await createRuntime({
    persistent: false,
    host: '127.0.0.1',
    port: 0
  })
  try {
    await runtime.start()
    const port = runtime.server.address().port
    const health = await fetch(`http://127.0.0.1:${port}/health`)
    const ready = await fetch(`http://127.0.0.1:${port}/ready`)
    assert.equal(health.status, 200)
    assert.equal(ready.status, 200)
    const body = await ready.json()
    assert.equal(body.ok, true)
    assert.equal(body.backend, 'mock')
  } finally {
    await runtime.stop()
  }
})

test('compressed request bodies are rejected cleanly before routing', async () => {
  const runtime = await createRuntime({
    persistent: false,
    host: '127.0.0.1',
    port: 0
  })
  try {
    await runtime.start()
    const port = runtime.server.address().port
    const body = zlib.gzipSync(Buffer.from(JSON.stringify({ probe: true })))
    const response = await fetch(`http://127.0.0.1:${port}/apis/site/info`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip'
      },
      body
    })
    assert.equal(response.status, 415)
    const payload = await response.json()
    assert.equal(payload.code, 'UNSUPPORTED_CONTENT_ENCODING')
    const health = await fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(health.status, 200, 'bad compressed input must not terminate the process')
  } finally {
    await runtime.stop()
  }
})
