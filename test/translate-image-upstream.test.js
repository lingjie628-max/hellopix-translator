'use strict'

/**
 * 用**本地假上游**跑一次完整的图片翻译，验证线上真会发出去的那个请求体。
 *
 * ## 为什么不满足于断言 fetch 参数
 *
 * `translate-image-provider.test.js` 已经断言了"body 里有 image_url"。
 * 但那只能说"我以为的形状对"，真上游要求的是：
 *   · Content-Type: application/json
 *   · Authorization: Bearer <key>
 *   · messages[1].content 必须是**数组**，不是字符串（写成字符串是最常见的错）
 *   · image_url.url 必须是 data:<mime>;base64,<data>
 *   · model 必须与通道配置一致（配错模型名是最常见的 404 来源）
 *
 * 这里起一个真的 HTTP 服务器收请求，把上面五条逐条验证。
 */

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const { translateImage } = require('../server/services/translation-image')

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function startUpstream (reply) {
  return new Promise(resolve => {
    const seen = []
    const srv = http.createServer((req, res) => {
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: (() => { try { return JSON.parse(raw) } catch (e) { return null } })(),
          raw
        })
        res.writeHead(reply.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(reply.body))
      })
    })
    srv.listen(0, () => resolve({
      base: 'http://127.0.0.1:' + srv.address().port,
      seen,
      close: () => new Promise(r => srv.close(r))
    }))
  })
}

test('★ 发出的请求完全符合 OpenAI 多模态格式（用真 HTTP 验证）', async () => {
  const up = await startUpstream({
    status: 200,
    body: { choices: [{ message: { content: '{"blocks":[{"source":"Hello","target":"你好"}]}' } }] }
  })
  try {
    const res = await translateImage(
      { id: 'gpt', endpoint: up.base + '/v1', model: 'my-vision-model' },
      { image: TINY_PNG, mime: 'image/png', to: 'zh' },
      { credentials: { apiKey: 'sk-test-123' }, fetch: globalThis.fetch }
    )

    assert.equal(res.ok, true, '应成功：' + (res.msg || ''))
    assert.equal(up.seen.length, 1, '应该只打一次上游')

    const req = up.seen[0]
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/v1/chat/completions', '路径要拼成 /v1/chat/completions')
    assert.match(req.headers['content-type'] || '', /application\/json/)
    assert.equal(req.headers.authorization, 'Bearer sk-test-123', '鉴权头必须带 Key')

    const body = req.body
    assert.ok(body, '必须是合法 JSON')
    // ★ 模型名必须用通道里配的，不能被兜底值覆盖 ★
    assert.equal(body.model, 'my-vision-model')
    assert.ok(Array.isArray(body.messages), 'messages 必须是数组')

    const user = body.messages.find(m => m.role === 'user')
    // ★ 这是最容易写错的一条：多模态时 content 必须是数组 ★
    assert.ok(Array.isArray(user.content), 'content 必须是数组，不能是字符串')
    const img = user.content.find(p => p.type === 'image_url')
    assert.ok(img, '必须包含 image_url 分段')
    assert.equal(
      img.image_url.url,
      'data:image/png;base64,' + TINY_PNG,
      'data URL 必须是 data:<mime>;base64,<data>'
    )
  } finally {
    await up.close()
  }
})

test('上游返回 HTML 而不是 JSON 时，给"格式异常"而不是抛未捕获异常', async () => {
  const up = await startUpstream({ status: 200, body: {} })
  // 让上游返回非 JSON
  await up.close()
  const up2 = await new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html>gateway error</html>')
      })
    })
    srv.listen(0, () => resolve({
      base: 'http://127.0.0.1:' + srv.address().port,
      close: () => new Promise(r => srv.close(r))
    }))
  })
  try {
    const res = await translateImage(
      { id: 'gpt', endpoint: up2.base + '/v1', model: 'gpt-4o-mini' },
      { image: TINY_PNG, mime: 'image/png' },
      { credentials: { apiKey: 'k' }, fetch: globalThis.fetch }
    )
    // 不是 ok:true，但也不能抛出去 —— 网关返回 HTML 在真实世界里很常见
    assert.equal(res.ok, false)
    assert.ok(res.msg, '必须给出可读的失败原因')
  } finally {
    await up2.close()
  }
})

test('上游连不上时，返回"请求失败"而不是挂死', async () => {
  // 用一个已经关闭的端口
  const res = await translateImage(
    { id: 'gpt', endpoint: 'http://127.0.0.1:1/v1', model: 'gpt-4o-mini' },
    { image: TINY_PNG, mime: 'image/png' },
    { credentials: { apiKey: 'k' }, fetch: globalThis.fetch, timeoutMs: 3000 }
  )
  assert.equal(res.ok, false)
  assert.match(res.msg, /请求失败/)
})
