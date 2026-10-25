'use strict'

/**
 * body 超限必须回 413，不能伪装成 500。
 *
 * ## 为什么值得单独测
 *
 * express.json 超限抛的是 PayloadTooLargeError，兜底中间件如果只认
 * "未知异常 → 500"，客户端就会拿到「服务器内部错误」。
 *
 * 这两种提示用户要做的事完全不同：
 *   · 413 → 换一张小图（用户自己能解决）
 *   · 500 → 稍后重试（用户只能等）
 *
 * 给了错的提示，用户会反复点同一张过大的图，既浪费带宽也解决不了问题。
 *
 * 2026-10-25 在生产上实测到的原状：20MB body 打 /apis/translate/image
 * 返回 500，日志里是 PayloadTooLargeError —— 就是这个缺陷。
 */

const test = require('node:test')
const assert = require('node:assert')
const express = require('express')

/** 复刻 server/index.js 里的兜底中间件（只测它，不起整个服务）。 */
function handler (err, _req, res, _next) {
  if (err && (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413)) {
    if (!res.headersSent) {
      res.status(413).json({ success: false, code: 'PAYLOAD_TOO_LARGE', msg: '内容太大，请换小一点的图片' })
    }
    return
  }
  if (!res.headersSent) res.status(500).json({ success: false, msg: '服务器内部错误' })
}

function buildApp (limit) {
  const app = express()
  app.use(express.json({ limit }))
  app.post('/echo', (req, res) => res.json({ ok: true, size: (req.body && req.body.x || '').length }))
  app.use(handler)
  return app
}

async function post (app, body) {
  const server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  const port = server.address().port
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, json }
  } finally {
    await new Promise(r => server.close(r))
  }
}

test('超过 limit 的 body 回 413，不是 500', async () => {
  const app = buildApp('1kb')
  const r = await post(app, { x: 'a'.repeat(5000) })
  assert.equal(r.status, 413, '超限必须是 413（用户据此换小图），不能是 500')
  assert.equal(r.json.code, 'PAYLOAD_TOO_LARGE')
})

test('未超限的 body 正常通过（别为修 413 把正常请求也挡了）', async () => {
  const app = buildApp('256kb')
  const r = await post(app, { x: 'a'.repeat(100) })
  assert.equal(r.status, 200)
  assert.equal(r.json.size, 100)
})

test('413 分支不打印 stack（客户端问题不该淹没真错误日志）', async () => {
  const app = express()
  const original = console.error
  const logged = []
  console.error = (...args) => logged.push(args)
  try {
    app.use(express.json({ limit: '1kb' }))
    app.post('/echo', (req, res) => res.json({ ok: true }))
    app.use(handler)
    await post(app, { x: 'a'.repeat(5000) })
  } finally {
    console.error = original
  }
  assert.equal(logged.length, 0, '413 是客户端问题，不该打 error 日志')
})

test('真正的未知异常仍然是 500（别把兜底吞了）', async () => {
  const app = express()
  app.get('/boom', () => { throw new Error('real bug') })
  app.use(handler)
  const server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  const original = console.error
  console.error = () => {}
  try {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/boom')
    assert.equal(res.status, 500)
  } finally {
    console.error = original
    await new Promise(r => server.close(r))
  }
})
