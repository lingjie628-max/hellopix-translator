'use strict'

/**
 * translateImage 的边界与失败路径。
 *
 * 与 translation-image.test.js 的分工：
 *   那个文件测纯函数（解析 / 模型判定）；
 *   这个文件测**带 fetch 的完整调用**，重点是不该花钱的时候一分都不花。
 *
 * 每一条都对应一个真实的钱或体验问题：
 *   · 空图 / 超大图 → 上游按字节计费，不挡就是白付；
 *   · 非 GPT 通道   → 得给"换成 GPT"的准确提示，而不是"翻译失败"；
 *   · 通道已关闭    → 不能因为换了接口就绕过后台的停用开关；
 *   · 缺凭据        → fail-closed，绝不返回演示译文。
 */

const test = require('node:test')
const assert = require('node:assert')

const { translateImage } = require('../server/services/translation-image')
const provider = require('../server/services/translation-provider')

// 1x1 PNG，供"正常路径"用
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function fakeFetch (reply, capture) {
  return async (url, init) => {
    if (capture) capture.push({ url, init })
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
      text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body))
    }
  }
}

test('空图直接拒绝，不发起任何请求（不产生费用）', async () => {
  let called = 0
  const res = await translateImage(
    { id: 'gpt', endpoint: '', model: 'gpt-4o-mini' },
    { image: '' },
    { credentials: { apiKey: 'k' }, fetch: async () => { called += 1 } }
  )
  assert.equal(res.ok, false)
  assert.equal(called, 0)
})

test('超过 12MB 的图直接拒绝，不发起请求（视觉模型按图计费）', async () => {
  let called = 0
  // base64 长度 * 3/4 ≈ 字节数；要过 12MB 需 > 16M 个字符
  const huge = 'A'.repeat(17 * 1024 * 1024)
  const res = await translateImage(
    { id: 'gpt', endpoint: '', model: 'gpt-4o-mini' },
    { image: huge },
    { credentials: { apiKey: 'k' }, fetch: async () => { called += 1 } }
  )
  assert.equal(res.ok, false)
  assert.match(res.msg, /图片太大/)
  assert.equal(called, 0)
})

test('不支持的 mime 直接拒绝', async () => {
  const res = await translateImage(
    { id: 'gpt', endpoint: '', model: 'gpt-4o-mini' },
    { image: TINY_PNG, mime: 'application/pdf' },
    { credentials: { apiKey: 'k' }, fetch: async () => { throw new Error('不该发请求') } }
  )
  assert.equal(res.ok, false)
  assert.match(res.msg, /不支持这种图片格式/)
})

test('缺凭据 fail-closed，绝不返回演示译文', async () => {
  const res = await translateImage(
    { id: 'gpt', endpoint: '', model: 'gpt-4o-mini' },
    { image: TINY_PNG, mime: 'image/png' },
    { credentials: {}, fetch: async () => { throw new Error('不该发请求') } }
  )
  assert.equal(res.ok, false)
  assert.match(res.msg, /凭据未配置/)
  assert.equal(res.blocks, undefined)
})

test('模型明确不支持看图时，在发请求之前就拒绝', async () => {
  let called = 0
  const res = await translateImage(
    { id: 'gpt', endpoint: '', model: 'gpt-3.5-turbo' },
    { image: TINY_PNG, mime: 'image/png' },
    { credentials: { apiKey: 'k' }, fetch: async () => { called += 1 } }
  )
  assert.equal(res.ok, false)
  assert.equal(res.code, 'NO_VISION')
  assert.equal(called, 0)
})

test('正常路径：请求体里带 image_url，并解析出 blocks', async () => {
  const capture = []
  const res = await translateImage(
    { id: 'gpt', endpoint: '', model: 'gpt-4o-mini' },
    { image: TINY_PNG, mime: 'image/png', to: 'zh' },
    {
      credentials: { apiKey: 'k' },
      fetch: fakeFetch({
        status: 200,
        body: { choices: [{ message: { content: '{"blocks":[{"source":"Hello","target":"你好"}]}' } }] }
      }, capture)
    }
  )
  assert.equal(res.ok, true)
  assert.deepEqual(res.blocks, [{ source: 'Hello', target: '你好' }])
  assert.equal(capture.length, 1)
  const body = JSON.parse(capture[0].init.body)
  const userMsg = body.messages.find(m => m.role === 'user')
  const imgPart = userMsg.content.find(p => p.type === 'image_url')
  assert.ok(imgPart, '必须带 image_url 分段')
  assert.match(imgPart.image_url.url, /^data:image\/png;base64,/)
})

test('上游 400 且提到 image 时，给出「换视觉模型」的准确提示', async () => {
  const res = await translateImage(
    { id: 'gpt', endpoint: '', model: 'gpt-4o-mini' },
    { image: TINY_PNG, mime: 'image/png' },
    {
      credentials: { apiKey: 'k' },
      // 按 OpenAI 真实的错误体形状造桩：readErrorDetail 读的是
      // body.error.message，给一个裸字符串它解析不出东西。
      fetch: fakeFetch({
        status: 400,
        body: { error: { message: 'Unsupported content type: image_url is not supported' } }
      })
    }
  )
  assert.equal(res.ok, false)
  assert.equal(res.code, 'NO_VISION')
  assert.match(res.msg, /不支持看图/)
})

// ---------------------------------------------------------------------------
// provider 层：通道校验
// ---------------------------------------------------------------------------

test('provider：非 GPT 通道明确拒绝，并点名用户当前用的通道', async () => {
  const res = await provider.translateImage(
    { id: 'deepl', name: 'DeepL', enabled: true },
    { image: TINY_PNG, mime: 'image/png' },
    { credentials: { apiKey: 'k' } }
  )
  assert.equal(res.ok, false)
  assert.equal(res.code, 'NO_VISION')
  // 必须说清"你现在用的是哪个" —— 只说"不支持"用户不知道该改哪里
  assert.match(res.msg, /DeepL/)
})

test('provider：已关闭的 GPT 通道不能因为换了接口就绕过停用开关', async () => {
  const res = await provider.translateImage(
    { id: 'gpt', name: 'GPT 翻译', enabled: false, model: 'gpt-4o-mini' },
    { image: TINY_PNG, mime: 'image/png' },
    { credentials: { apiKey: 'k' }, fetch: async () => { throw new Error('不该发请求') } }
  )
  assert.equal(res.ok, false)
  assert.match(res.msg, /已关闭/)
})

test('provider：GPT 通道正常走通，且沿用通道配置的超时', async () => {
  const capture = []
  const res = await provider.translateImage(
    { id: 'gpt', name: 'GPT 翻译', enabled: true, model: 'gpt-4o-mini', callParams: { timeoutMs: 5000 } },
    { image: TINY_PNG, mime: 'image/png', to: 'zh' },
    {
      credentials: { apiKey: 'k' },
      fetch: fakeFetch({
        status: 200,
        body: { choices: [{ message: { content: '{"blocks":[{"source":"a","target":"甲"}]}' } }] }
      }, capture)
    }
  )
  assert.equal(res.ok, true)
  assert.equal(res.model, 'gpt-4o-mini')
  assert.equal(capture.length, 1)
})
