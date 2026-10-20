/**
 * 新补的 6 个适配器：请求构造测试。
 *
 * 没有真实 key 就无法验证"能否调通"，但**请求长什么样是可以验证的** ——
 * 而多数接入失败恰恰是请求构造错了（语种码大小写、认证头名字、
 * 免费版打到了专业版域名），现象往往是 400/403，看不出原因。
 *
 * 这里用一个假的 fetch 把请求截下来逐项断言。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const provider = require('../server/services/translation-provider')

/** 把请求截下来，返回一个固定的成功响应 */
function capture(responseBody, status) {
  const calls = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      return {
        ok: (status || 200) < 400,
        status: status || 200,
        json: async () => responseBody
      }
    }
  }
}

const opts = (fetch, credentials) => ({
  fetch, timeoutMs: 3000, credentials: credentials || {}
})

const payload = { text: '你好', from: 'zh', to: 'en' }

// ---------------------------------------------------------------------------

test('DeepL：认证头是 DeepL-Auth-Key，语种码必须大写', async () => {
  const cap = capture({ translations: [{ text: 'Hello', detected_source_language: 'ZH' }] })
  const r = await provider.translate({ id: 'deepl', enabled: true }, payload,
    opts(cap.fetch, { apiKey: 'abc:fx' }))

  assert.equal(r.ok, true)
  const req = cap.calls[0]
  // 2025-03 起 DeepL 废弃了 auth_key 查询参数，必须是这个头
  assert.equal(req.init.headers.Authorization, 'DeepL-Auth-Key abc:fx')
  assert.equal(req.init.headers['Content-Type'], 'application/x-www-form-urlencoded')
  const body = new URLSearchParams(req.init.body)
  assert.equal(body.get('target_lang'), 'EN-US', 'DeepL 的语种码是大写，小写会被拒')
  assert.equal(body.get('text'), '你好')
})

test('DeepL：中文必须区分简繁（ZH-HANS / ZH-HANT），传 zh 会被拒', async () => {
  const cap = capture({ translations: [{ text: 'x' }] })
  await provider.translate({ id: 'deepl', enabled: true }, { text: 'hi', to: 'zh' },
    opts(cap.fetch, { apiKey: 'k' }))
  assert.equal(new URLSearchParams(cap.calls[0].init.body).get('target_lang'), 'ZH-HANS')

  const cap2 = capture({ translations: [{ text: 'x' }] })
  await provider.translate({ id: 'deepl', enabled: true }, { text: 'hi', to: 'zh-tw' },
    opts(cap2.fetch, { apiKey: 'k' }))
  assert.equal(new URLSearchParams(cap2.calls[0].init.body).get('target_lang'), 'ZH-HANT')
})

test('DeepL：免费版 key（:fx 结尾）必须打到 api-free 域名', async () => {
  const free = capture({ translations: [{ text: 'x' }] })
  await provider.translate({ id: 'deepl', enabled: true }, payload, opts(free.fetch, { apiKey: 'k:fx' }))
  assert.match(free.calls[0].url, /^https:\/\/api-free\.deepl\.com/, '免费版 key 打到专业版域名会 403')

  const pro = capture({ translations: [{ text: 'x' }] })
  await provider.translate({ id: 'deepl', enabled: true }, payload, opts(pro.fetch, { apiKey: 'k' }))
  assert.match(pro.calls[0].url, /^https:\/\/api\.deepl\.com/)
})

test('Papago：必须同时带 Client ID 与 Secret 两个头', async () => {
  const cap = capture({ message: { result: { translatedText: 'Hello' } } })
  const r = await provider.translate({ id: 'papago', enabled: true }, payload,
    opts(cap.fetch, { apiKey: 'id123', secret: 'sec456' }))

  assert.equal(r.ok, true)
  const h = cap.calls[0].init.headers
  assert.equal(h['X-NCP-APIGW-API-KEY-ID'], 'id123')
  assert.equal(h['X-NCP-APIGW-API-KEY'], 'sec456')
  assert.equal(JSON.parse(cap.calls[0].init.body).target, 'en')
})

test('Papago：只填一个凭据时给出可读提示，而不是发一个注定失败的请求', async () => {
  const cap = capture({})
  const r = await provider.translate({ id: 'papago', enabled: true }, payload,
    opts(cap.fetch, { apiKey: 'id123' }))
  assert.equal(r.ok, false)
  assert.match(r.msg, /两个值/)
  assert.equal(cap.calls.length, 0, '凭据不全时不该发出请求')
})

test('小牛：原文必须 URL 编码 —— 含 & 时不编码会截断参数', async () => {
  const cap = capture({ tgt_text: 'ok' })
  await provider.translate({ id: 'niutrans', enabled: true },
    { text: 'a&b=c?d', from: 'en', to: 'zh' }, opts(cap.fetch, { apiKey: 'K' }))

  const url = cap.calls[0].url
  assert.match(url, /src_text=a%26b%3Dc%3Fd/, '原文里的 & = ? 必须编码')
  assert.match(url, /apikey=K/)
  assert.match(url, /to=zh/)
})

test('小牛：错误藏在 200 响应体里，必须显式识别', async () => {
  const cap = capture({ errorCode: '40101', errorMessage: 'apikey 无效' })
  const r = await provider.translate({ id: 'niutrans', enabled: true }, payload,
    opts(cap.fetch, { apiKey: 'K' }))
  assert.equal(r.ok, false, '小牛把错误也放在 200 里，只看 HTTP 状态会误判成功')
  assert.match(r.msg, /40101/)
})

test('GPT / Grok：走 OpenAI 兼容协议，Bearer 认证', async () => {
  for (const [id, host] of [['gpt', 'api.openai.com'], ['grok', 'api.x.ai']]) {
    const cap = capture({ choices: [{ message: { content: 'Hello' } }] })
    const r = await provider.translate({ id, enabled: true }, payload, opts(cap.fetch, { apiKey: 'sk-x' }))
    assert.equal(r.ok, true, `${id} 应成功`)
    assert.match(cap.calls[0].url, new RegExp('^https://' + host.replace('.', '\\.')))
    assert.equal(cap.calls[0].init.headers.Authorization, 'Bearer sk-x')
    const body = JSON.parse(cap.calls[0].init.body)
    assert.equal(body.messages[0].role, 'system')
    assert.equal(body.temperature, 0, '翻译要稳定，温度必须为 0')
  }
})

test('GPT：模型可用后台配置覆盖', async () => {
  const cap = capture({ choices: [{ message: { content: 'x' } }] })
  await provider.translate({ id: 'gpt', enabled: true }, payload,
    opts(cap.fetch, { apiKey: 'k', model: 'gpt-4o' }))
  assert.equal(JSON.parse(cap.calls[0].init.body).model, 'gpt-4o')
})

test('GPT：接口地址只填域名时自动补 /chat/completions', async () => {
  const cap = capture({ choices: [{ message: { content: 'x' } }] })
  await provider.translate({ id: 'gpt', enabled: true, endpoint: 'https://my-gateway.example.com' },
    payload, opts(cap.fetch, { apiKey: 'k' }))
  assert.equal(cap.calls[0].url, 'https://my-gateway.example.com/chat/completions')
})

test('不支持的语种要明确拒绝，而不是发出去等厂商报错', async () => {
  const cap = capture({})
  const r = await provider.translate({ id: 'deepl', enabled: true },
    { text: 'x', to: 'klingon' }, opts(cap.fetch, { apiKey: 'k' }))
  assert.equal(r.ok, false)
  assert.match(r.msg, /不支持目标语种/)
  assert.equal(cap.calls.length, 0)
})

test('百度已下架 —— 注册表里不应再有它', () => {
  assert.equal(provider.providers.baidu, undefined, '百度应已从适配层移除')
  assert.ok(provider.providers.niutrans, '小牛应仍在')
  assert.ok(provider.providers.aws, 'AWS 应已实现')
})

// ---------------------------------------------------------------------------
// temperature 兼容：推理类模型只接受默认温度

/** 依次返回多个响应，用于验证"重试一次"这类行为 */
function sequence(responses) {
  const calls = []
  let index = 0
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      const spec = responses[Math.min(index, responses.length - 1)]
      index += 1
      return {
        ok: (spec.status || 200) < 400,
        status: spec.status || 200,
        json: async () => spec.body
      }
    }
  }
}

test('GPT：模型拒绝某个参数时去掉它重试一次（自愈降级仍然保留）', async () => {
  // 真实报文：400 "Unsupported value: 'temperature' does not support 0 with this model"
  //
  // 注：gpt-5.6-luna 现在**已经预判**不发 temperature（见下面的用例），
  // 所以这条改成验证"预判漏了的时候兜底还在"——用 gpt-4o-mini 这种本该
  // 接受 temperature 的模型去模拟厂商突然拒绝，确认降级链路没被改坏。
  const seq = sequence([
    {
      status: 400,
      body: {
        error: {
          message: "Unsupported value: 'temperature' does not support 0 with this model. " +
            'Only the default (1) value is supported.'
        }
      }
    },
    { status: 200, body: { choices: [{ message: { content: '你好' } }] } }
  ])
  const r = await provider.translate({ id: 'gpt', enabled: true, model: 'gpt-4o-mini' }, payload,
    opts(seq.fetch, { apiKey: 'k' }))

  assert.equal(r.ok, true, '去掉 temperature 后应当成功')
  assert.equal(r.text, '你好')
  assert.equal(seq.calls.length, 2, '应当正好重试一次')
  assert.equal(JSON.parse(seq.calls[0].init.body).temperature, 0, '预判之外的模型第一次仍按常规带上')
  assert.ok(!('temperature' in JSON.parse(seq.calls[1].init.body)), '重试必须去掉 temperature')
})

test('GPT：与 temperature 无关的 400 不重试（别把真错误掩盖成重试）', async () => {
  const seq = sequence([
    { status: 400, body: { error: { message: 'The model `nope` does not exist' } } }
  ])
  const r = await provider.translate({ id: 'gpt', enabled: true }, payload, opts(seq.fetch, { apiKey: 'k' }))

  assert.equal(r.ok, false)
  assert.match(r.msg, /does not exist/)
  assert.equal(seq.calls.length, 1, '与该参数无关的错误不该多打一次请求')
})

test('GPT：去掉 temperature 后仍失败，透出第二次的错误', async () => {
  const seq = sequence([
    { status: 400, body: { error: { message: "temperature does not support 0" } } },
    { status: 429, body: { error: { message: 'quota exceeded' } } }
  ])
  const r = await provider.translate({ id: 'gpt', enabled: true }, payload, opts(seq.fetch, { apiKey: 'k' }))

  assert.equal(r.ok, false)
  assert.equal(seq.calls.length, 2)
  assert.match(r.msg, /429/)
  assert.match(r.msg, /quota exceeded/)
})

test('Grok：正常返回时不应产生多余的第二次请求', async () => {
  const cap = capture({ choices: [{ message: { content: 'Hello' } }] })
  const r = await provider.translate({ id: 'grok', enabled: true }, payload, opts(cap.fetch, { apiKey: 'k' }))
  assert.equal(r.ok, true)
  assert.equal(cap.calls.length, 1, '成功路径不该因为重试逻辑多一次调用')
})

// ===========================================================================
// 翻译延迟：不许"先被拒、再重试"地白跑一趟
// ===========================================================================
//
// 2026-10-19 生产数据：24 小时内 1311 次翻译，`translation_usage.retries`
// **全部为 1**，P50 耗时 2.85s。根因是 gpt-5.6-luna 不认 `max_tokens`，
// 每次请求都先被 400 拒掉、再降级重发 —— 用户白等一整趟往返。
//
// 那套"被拒再降级"的自愈逻辑本身是对的（不该维护会过期的模型清单），
// 但它**不该成为常态**。下面锁住：参数一开始就要传对。

test('GPT-5 系：输出上限用 max_completion_tokens，不许先发 max_tokens 被拒', async () => {
  const cap = capture({ choices: [{ message: { content: 'Hello' } }] })
  const r = await provider.translate(
    { id: 'gpt', enabled: true, model: 'gpt-5.6-luna', callParams: { maxOutputTokens: 512 } },
    payload, opts(cap.fetch, { apiKey: 'k' }))

  assert.equal(r.ok, true)
  const body = JSON.parse(cap.calls[0].init.body)
  assert.equal(body.max_completion_tokens, 512)
  assert.equal(body.max_tokens, undefined, '新模型收到 max_tokens 会 400，等于每次翻译白跑一趟')
  assert.equal(cap.calls.length, 1, '成功路径必须一次打中')
  assert.equal(r.retries, 0, 'retries 必须为 0 —— 线上全是 1 就是这条坏掉的信号')
})

test('o 系列同理（o1/o3）用 max_completion_tokens', async () => {
  const cap = capture({ choices: [{ message: { content: 'Hello' } }] })
  await provider.translate(
    { id: 'gpt', enabled: true, model: 'o3-mini', callParams: { maxOutputTokens: 256 } },
    payload, opts(cap.fetch, { apiKey: 'k' }))
  const body = JSON.parse(cap.calls[0].init.body)
  assert.equal(body.max_completion_tokens, 256)
  assert.equal(body.max_tokens, undefined)
})

test('老模型（gpt-4o-mini）仍然用 max_tokens，不能一刀切', async () => {
  const cap = capture({ choices: [{ message: { content: 'Hello' } }] })
  await provider.translate(
    { id: 'gpt', enabled: true, model: 'gpt-4o-mini', callParams: { maxOutputTokens: 256 } },
    payload, opts(cap.fetch, { apiKey: 'k' }))
  const body = JSON.parse(cap.calls[0].init.body)
  assert.equal(body.max_tokens, 256, 'gpt-4o 系不认识 max_completion_tokens')
  assert.equal(body.max_completion_tokens, undefined)
})

test('GPT 默认压推理强度：翻译不需要思维链，思考那几秒是白等', async () => {
  const cap = capture({ choices: [{ message: { content: 'Hello' } }] })
  await provider.translate({ id: 'gpt', enabled: true, model: 'gpt-5.6-luna' },
    payload, opts(cap.fetch, { apiKey: 'k' }))
  assert.equal(JSON.parse(cap.calls[0].init.body).reasoning_effort, 'low')
})

test('通道表里的 extraBody 能覆盖推理强度（后台改完立刻生效，不用发版）', async () => {
  const cap = capture({ choices: [{ message: { content: 'Hello' } }] })
  await provider.translate(
    { id: 'gpt', enabled: true, model: 'gpt-5.6-luna', callParams: { extraBody: { reasoning_effort: 'medium' } } },
    payload, opts(cap.fetch, { apiKey: 'k' }))
  assert.equal(JSON.parse(cap.calls[0].init.body).reasoning_effort, 'medium')
})

test('模型不认 reasoning_effort 时自动去掉重试，而不是把通道打死', async () => {
  const seq = sequence([
    { status: 400, body: { error: { message: "Unsupported parameter: 'reasoning_effort'" } } },
    { status: 200, body: { choices: [{ message: { content: 'Hello' } }] } }
  ])
  const r = await provider.translate({ id: 'gpt', enabled: true, model: 'gpt-5.6-luna' },
    payload, opts(seq.fetch, { apiKey: 'k' }))
  assert.equal(r.ok, true)
  assert.equal(JSON.parse(seq.calls[0].init.body).reasoning_effort, 'low')
  assert.equal(JSON.parse(seq.calls[1].init.body).reasoning_effort, undefined,
    '第二次必须剥掉被点名的参数')
})

test('DeepSeek 默认关思考，且通道表 extraBody 可覆盖', async () => {
  const cap = capture({ choices: [{ message: { content: 'Hello' } }] })
  await provider.translate({ id: 'deepseek', enabled: true, model: 'deepseek-flash' },
    payload, opts(cap.fetch, { apiKey: 'k' }))
  assert.deepEqual(JSON.parse(cap.calls[0].init.body).thinking, { type: 'disabled' })

  const cap2 = capture({ choices: [{ message: { content: 'Hello' } }] })
  await provider.translate(
    { id: 'deepseek', enabled: true, model: 'deepseek-flash', callParams: { extraBody: { thinking: { type: 'auto' } } } },
    payload, opts(cap2.fetch, { apiKey: 'k' }))
  assert.deepEqual(JSON.parse(cap2.calls[0].init.body).thinking, { type: 'auto' })
})

test('GPT-5 系：不传 temperature，否则每次翻译先被 400 拒一次再重试', async () => {
  const cap = capture({ choices: [{ message: { content: 'Hello' } }] })
  const r = await provider.translate({ id: 'gpt', enabled: true, model: 'gpt-5.6-luna' },
    payload, opts(cap.fetch, { apiKey: 'k' }))
  const body = JSON.parse(cap.calls[0].init.body)
  assert.equal(body.temperature, undefined,
    'gpt-5.6-luna 只接受默认温度，传 0 会被 400 拒掉 —— 修了 max_tokens 也还是每次白跑一趟')
  assert.equal(cap.calls.length, 1)
  assert.equal(r.retries, 0)
})

test('老模型仍然带 temperature=0（翻译要稳定，不要发挥）', async () => {
  const cap = capture({ choices: [{ message: { content: 'Hello' } }] })
  await provider.translate({ id: 'gpt', enabled: true, model: 'gpt-4o-mini' },
    payload, opts(cap.fetch, { apiKey: 'k' }))
  assert.equal(JSON.parse(cap.calls[0].init.body).temperature, 0)
})

test('推理模型一次打中：max_tokens/temperature 都不发错，retries 必须是 0', async () => {
  // 这条是上面两条的合并断言 —— 线上 retries 全为 1 时，这一个数字就能看出来。
  const cap = capture({ choices: [{ message: { content: 'Hello' } }], usage: {} })
  const r = await provider.translate(
    { id: 'gpt', enabled: true, model: 'gpt-5.6-luna', callParams: { maxOutputTokens: 512 } },
    payload, opts(cap.fetch, { apiKey: 'k' }))
  const body = JSON.parse(cap.calls[0].init.body)
  assert.equal(body.temperature, undefined)
  assert.equal(body.max_tokens, undefined)
  assert.equal(body.max_completion_tokens, 512)
  assert.equal(body.reasoning_effort, 'low')
  assert.equal(cap.calls.length, 1)
  assert.equal(r.retries, 0)
})
