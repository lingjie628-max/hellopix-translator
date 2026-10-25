'use strict'

/**
 * 图片翻译的**端到端**验证：真 Express + 真 body 解析器 + 真 HTTP 请求。
 *
 * ## 为什么不满足于单测
 *
 * 单测只能证明"函数逻辑对"。而这个功能最可能坏在**接线**上：
 *   · 全局 express.json 限 256kb，几 MB 的图会被 413 —— 单测看不见；
 *   · 客户端传 form 而不是 json，Content-Type 对不上 —— 单测看不见；
 *   · 路由前缀挂错（/translate/image vs /apis/translate/image）。
 *
 * 这三条任何一条错了，功能都是"看起来做完了、用户一点就失败"。
 * 所以起一个真的 HTTP 服务，用真的请求打一遍。
 */

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const express = require('express')

/** 起一个只装了"图片路由 + 全局 256kb"的最小服务（照抄 server/index.js 的装配顺序）。 */
function startServer (handlerResult) {
  return new Promise(resolve => {
    const app = express()
    // ★ 顺序必须与 server/index.js 一致 ★
    app.use('/apis/translate/image', express.json({ limit: '16mb', type: 'application/json' }))
    app.use(express.urlencoded({ extended: false, limit: '256kb' }))
    app.use(express.json({ limit: '256kb' }))
    app.post('/apis/translate/image', (req, res) => {
      // 模拟 core.translateImage 的返回/抛错
      Promise.resolve()
        .then(() => handlerResult(req.body))
        .then(out => res.json(out))
        .catch(err => res.status(err.status || 500).json({ error: err.code || 'ERR', message: err.message }))
    })
    const srv = app.listen(0, () => resolve({
      port: srv.address().port,
      close: () => new Promise(r => srv.close(r))
    }))
  })
}

function post (port, path, body, contentType) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body)
    const req = http.request({
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': contentType || 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let out = ''
      res.on('data', c => { out += c })
      res.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(out) } catch (e) { parsed = null }
        resolve({ status: res.statusCode, body: parsed, raw: out })
      })
    })
    req.on('error', reject)
    req.end(data)
  })
}

test('★ 大图能进得来：2MB 的 base64 不会被全局 256kb 挡住', async () => {
  let seen = 0
  const srv = await startServer(body => {
    seen = String(body.image || '').length
    return { ok: true, blocks: [{ source: 'a', target: '甲' }] }
  })
  try {
    const big = 'A'.repeat(2 * 1024 * 1024)
    const res = await post(srv.port, '/apis/translate/image', { image: big, mime: 'image/png' })
    assert.equal(res.status, 200, '大图必须能进（否则功能整体不可用）')
    assert.equal(seen, big.length, 'body 必须完整到达 handler')
  } finally {
    await srv.close()
  }
})

test('★ 别的路由仍受 256kb 保护（放宽只对图片路由生效）', async () => {
  const app = express()
  app.use('/apis/translate/image', express.json({ limit: '16mb', type: 'application/json' }))
  app.use(express.json({ limit: '256kb' }))
  app.post('/apis/other', (req, res) => res.json({ ok: true }))
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)) })
  try {
    // express 的 413 由默认错误处理器返回 HTML，所以看状态码就够
    const res = await post(srv.address().port, '/apis/other', { x: 'A'.repeat(2 * 1024 * 1024) })
      .catch(e => ({ status: 'ERR', raw: e.message }))
    assert.equal(res.status, 413, '普通路由不能被放宽')
  } finally {
    await new Promise(r => srv.close(r))
  }
})

test('传 form 而不是 json 时，图片字段拿不到 —— 这就是必须用 json 的原因', async () => {
  let got = null
  const srv = await startServer(body => {
    got = body
    return { ok: true }
  })
  try {
    // application/x-www-form-urlencoded：全局的 urlencoded 解析器接住了它，
    // 但字段是字符串，且 express.json 不会再来一遍 —— 行为与 json 不同。
    const res = await post(
      srv.port,
      '/apis/translate/image',
      'image=' + encodeURIComponent('AAAA') + '&mime=image%2Fpng',
      'application/x-www-form-urlencoded'
    )
    assert.equal(res.status, 200)
    // 这条断言是给后人的路标：如果哪天有人把客户端改成 form，
    // 上游会收到一个被 URL 编码过的巨型字符串（体积膨胀 ~3 倍）。
    assert.equal(got.image, 'AAAA')
  } finally {
    await srv.close()
  }
})

test('core 抛 400/NO_VISION 时，响应体里带得上 code（客户端据此引导换通道）', async () => {
  const srv = await startServer(() => {
    const err = new Error('当前通道不支持图片翻译')
    err.status = 400
    err.code = 'NO_VISION'
    throw err
  })
  try {
    const res = await post(srv.port, '/apis/translate/image', { image: 'AAAA', mime: 'image/png' })
    assert.equal(res.status, 400)
    assert.equal(res.body.error, 'NO_VISION')
  } finally {
    await srv.close()
  }
})
