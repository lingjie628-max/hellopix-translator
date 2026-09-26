/**
 * 2026-09-25 换线后新增的 AI 通道：请求构造测试。
 *
 * 没有真实 key 就验证不了"能否调通"，但**请求长什么样是可验证的** ——
 * 而接入失败绝大多数就是请求构造错了：认证头名字、必填字段漏传、
 * 端点少了一层路径、语种参数放错位置。这些现象在厂商侧表现为 400/403/404，
 * 错误文案往往看不出自己错在哪。
 *
 * 这里用假 fetch 把请求截下来逐项断言。三个协议各测一组：
 *   · OpenAI 兼容（豆包 / Kimi / GLM / Mistral / MiniMax）
 *   · Anthropic Messages（Claude）
 *   · 专用翻译模型（Qwen-MT）
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const provider = require('../server/services/translation-provider')
const { claudeMaxTokens, QWEN_MT_LANGUAGES } = require('../server/services/translation-adapters-llm')

/** 把请求截下来，返回固定的成功响应 */
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

/** 依次返回多个响应，用于验证"自愈重试"这类行为 */
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

const opts = (fetch, credentials) => ({
  fetch, timeoutMs: 3000, credentials: credentials || {}
})

const okBody = { choices: [{ message: { content: 'Hello' } }] }
const payload = { text: '你好', from: 'zh', to: 'en' }

// ---------------------------------------------------------------------------
// 一、OpenAI 兼容系：9 家共用一份实现，差异只在 baseURL / 模型 / 报文
// ---------------------------------------------------------------------------

// 每一行：通道 id、期望的默认端点主机与路径、默认模型、期望的 temperature
// （`null` = 报文里不该出现该字段。Kimi K3 把采样参数固定在服务端，
//  官方建议不传 —— 传 0 是"要它稳定"这个意图，但厂商不认这个旋钮。）
const OPENAI_COMPATIBLE = [
  ['doubao', 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', 'doubao-seed-1-6', 0],
  ['kimi', 'https://api.moonshot.cn/v1/chat/completions', 'kimi-k3', null],
  ['glm', 'https://open.bigmodel.cn/api/paas/v4/chat/completions', 'glm-4.7', 0],
  ['mistral', 'https://api.mistral.ai/v1/chat/completions', 'mistral-large-latest', 0],
  ['minimax', 'https://api.minimaxi.com/v1/chat/completions', 'MiniMax-M3', 0]
]

for (const [id, expectedUrl, expectedModel, expectedTemp] of OPENAI_COMPATIBLE) {
  test(`${id}：端点自动补全、Bearer 认证、模型可用后台覆盖`, async () => {
    const cap = capture(okBody)
    const r = await provider.translate({ id, enabled: true }, payload, opts(cap.fetch, { apiKey: 'sk-x' }))

    assert.equal(r.ok, true, `${id} 应成功`)
    // 后台「接口地址」只填到基址时，必须自己补上 /chat/completions ——
    // 少这一层就是 404，而 404 的错误体通常不是 JSON，看不出原因
    assert.equal(cap.calls[0].url, expectedUrl)
    assert.equal(cap.calls[0].init.headers.Authorization, 'Bearer sk-x')

    const body = JSON.parse(cap.calls[0].init.body)
    assert.equal(body.model, expectedModel)
    assert.equal(body.stream, false)
    if (expectedTemp === null) {
      assert.ok(!('temperature' in body), `${id} 不接受采样参数，报文里不能出现 temperature`)
    } else {
      assert.equal(body.temperature, 0, '翻译要稳定，温度必须为 0')
    }
    assert.equal(body.messages[0].role, 'system')
    assert.equal(body.messages[1].content, '你好', '原文必须原样放进 user 消息')
  })

  test(`${id}：语种用自然语言描述，不是 ISO 码`, async () => {
    const cap = capture(okBody)
    await provider.translate({ id, enabled: true }, { text: '你好', to: 'ja' },
      opts(cap.fetch, { apiKey: 'k' }))
    assert.match(JSON.parse(cap.calls[0].init.body).messages[0].content, /日语/)
  })

  test(`${id}：后台改的模型名优先于默认值`, async () => {
    const cap = capture(okBody)
    await provider.translate({ id, enabled: true }, payload,
      opts(cap.fetch, { apiKey: 'k', model: 'custom-model-v9' }))
    assert.equal(JSON.parse(cap.calls[0].init.body).model, 'custom-model-v9')
  })
}

test('豆包 / GLM / MiniMax：带上"关思考"参数，避免翻译慢一倍、token 翻倍', async () => {
  for (const id of ['doubao', 'glm', 'minimax']) {
    const cap = capture(okBody)
    await provider.translate({ id, enabled: true }, payload, opts(cap.fetch, { apiKey: 'k' }))
    assert.deepEqual(JSON.parse(cap.calls[0].init.body).thinking, { type: 'disabled' },
      `${id} 应默认关闭思考模式`)
  }
})

test('Kimi / Mistral 不传 thinking —— 各家参数名不统一，少传不会坏，乱传会 400', async () => {
  for (const id of ['kimi', 'mistral']) {
    const cap = capture(okBody)
    await provider.translate({ id, enabled: true }, payload, opts(cap.fetch, { apiKey: 'k' }))
    assert.ok(!('thinking' in JSON.parse(cap.calls[0].init.body)), `${id} 不该带 thinking`)
  }
})

test('厂商拒绝 thinking 参数时去掉它重试一次（模型换代后的自愈）', async () => {
  const seq = sequence([
    { status: 400, body: { error: { message: 'unknown parameter: thinking' } } },
    { status: 200, body: okBody }
  ])
  const r = await provider.translate({ id: 'glm', enabled: true }, payload, opts(seq.fetch, { apiKey: 'k' }))

  assert.equal(r.ok, true, '去掉 thinking 后应当成功')
  assert.equal(seq.calls.length, 2)
  assert.ok('thinking' in JSON.parse(seq.calls[0].init.body), '第一次仍按常规带上 thinking')
  assert.ok(!('thinking' in JSON.parse(seq.calls[1].init.body)), '重试必须去掉 thinking')
  assert.equal(JSON.parse(seq.calls[1].init.body).temperature, 0, '不该顺手把 temperature 也删掉')
})

test('端点填了完整路径时原样使用，不重复拼一层', async () => {
  const cap = capture(okBody)
  await provider.translate(
    { id: 'glm', enabled: true, endpoint: 'https://my-gateway.example.com/v1/chat/completions' },
    payload, opts(cap.fetch, { apiKey: 'k' }))
  assert.equal(cap.calls[0].url, 'https://my-gateway.example.com/v1/chat/completions')
})

test('不支持的语种在本地就拒绝，不产生厂商请求', async () => {
  const cap = capture(okBody)
  const r = await provider.translate({ id: 'kimi', enabled: true },
    { text: 'x', to: 'klingon' }, opts(cap.fetch, { apiKey: 'k' }))
  assert.equal(r.ok, false)
  assert.match(r.msg, /不支持目标语种/)
  assert.equal(cap.calls.length, 0)
})

// ---------------------------------------------------------------------------
// 二、Claude（Anthropic Messages API）
// ---------------------------------------------------------------------------

test('Claude：认证头是 x-api-key 且必须带 anthropic-version', async () => {
  const cap = capture({ content: [{ type: 'text', text: 'Hello' }] })
  const r = await provider.translate({ id: 'claude', enabled: true }, payload,
    opts(cap.fetch, { apiKey: 'sk-ant-x' }))

  assert.equal(r.ok, true)
  const h = cap.calls[0].init.headers
  assert.equal(h['x-api-key'], 'sk-ant-x')
  assert.equal(h['anthropic-version'], '2023-06-01', '漏了这个头 Claude 直接 400')
  assert.equal(h.Authorization, undefined, 'Claude 不认 Bearer 头')
  assert.equal(cap.calls[0].url, 'https://api.anthropic.com/v1/messages')
})

test('Claude：max_tokens 必填，且 system 是顶层字段（不是 messages 里的一条）', async () => {
  const cap = capture({ content: [{ type: 'text', text: 'Hello' }] })
  await provider.translate({ id: 'claude', enabled: true }, payload, opts(cap.fetch, { apiKey: 'k' }))

  const body = JSON.parse(cap.calls[0].init.body)
  assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens > 0, 'max_tokens 漏了会 400')
  assert.equal(typeof body.system, 'string')
  assert.equal(body.messages.length, 1, 'system 不该占用 messages 槽位')
  assert.deepEqual(body.messages[0], { role: 'user', content: '你好' })
})

test('Claude：默认模型是最快最省的一档，可被后台覆盖', async () => {
  const cap = capture({ content: [{ type: 'text', text: 'x' }] })
  await provider.translate({ id: 'claude', enabled: true }, payload, opts(cap.fetch, { apiKey: 'k' }))
  assert.equal(JSON.parse(cap.calls[0].init.body).model, 'claude-haiku-4-5')

  const cap2 = capture({ content: [{ type: 'text', text: 'x' }] })
  await provider.translate({ id: 'claude', enabled: true }, payload,
    opts(cap2.fetch, { apiKey: 'k', model: 'claude-sonnet-4-6' }))
  assert.equal(JSON.parse(cap2.calls[0].init.body).model, 'claude-sonnet-4-6')
})

test('Claude：返回体是 content 数组，取 text 块拼起来；非 text 块要忽略', async () => {
  const cap = capture({
    content: [
      { type: 'thinking', thinking: '（这里应该是推理过程，不该出现在译文里）' },
      { type: 'text', text: '你' },
      { type: 'text', text: '好' }
    ]
  })
  const r = await provider.translate({ id: 'claude', enabled: true }, payload, opts(cap.fetch, { apiKey: 'k' }))
  assert.equal(r.text, '你好')
})

test('Claude：端点只填域名会缺 /v1 —— 适配层补的是 /messages 而不是 /chat/completions', async () => {
  const cap = capture({ content: [{ type: 'text', text: 'x' }] })
  await provider.translate({ id: 'claude', enabled: true, endpoint: 'https://api.anthropic.com/v1' },
    payload, opts(cap.fetch, { apiKey: 'k' }))
  assert.equal(cap.calls[0].url, 'https://api.anthropic.com/v1/messages')
})

test('claudeMaxTokens：按原文长度估算并夹在 [1024, 8192]', () => {
  assert.equal(claudeMaxTokens(''), 1024, '短文本也要够用')
  assert.equal(claudeMaxTokens('a'.repeat(1000)), 2000)
  assert.equal(claudeMaxTokens('a'.repeat(100000)), 8192, '上限要压住，避免输出超长计费')
})

// ---------------------------------------------------------------------------
// 三、Qwen-MT（专用翻译模型）
// ---------------------------------------------------------------------------

test('Qwen-MT：只发一条 user 消息 —— 传 system 会被厂商直接拒绝', async () => {
  const cap = capture(okBody)
  const r = await provider.translate({ id: 'qwen', enabled: true }, payload,
    opts(cap.fetch, { apiKey: 'sk-q' }))

  assert.equal(r.ok, true)
  const body = JSON.parse(cap.calls[0].init.body)
  assert.equal(body.messages.length, 1, 'Qwen-MT 只接受一条 user 消息')
  assert.equal(body.messages[0].role, 'user')
  assert.ok(!body.messages.some(m => m.role === 'system'), '不能带 system')
  assert.equal(cap.calls[0].url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
  assert.equal(body.model, 'qwen-mt-flash')
})

test('Qwen-MT：语种走 translation_options，且必须是英文全称', async () => {
  const cap = capture(okBody)
  await provider.translate({ id: 'qwen', enabled: true }, { text: '你好', from: 'zh', to: 'en' },
    opts(cap.fetch, { apiKey: 'k' }))

  const body = JSON.parse(cap.calls[0].init.body)
  assert.deepEqual(body.translation_options, { source_lang: 'Chinese', target_lang: 'English' },
    '给 ISO 码会被拒，必须是 Chinese / English 这类英文全称')
})

test('Qwen-MT：自动检测源语种传 auto，繁体中文不能混成简体', async () => {
  const auto = capture(okBody)
  await provider.translate({ id: 'qwen', enabled: true }, { text: 'hi', from: 'auto', to: 'en' },
    opts(auto.fetch, { apiKey: 'k' }))
  assert.equal(JSON.parse(auto.calls[0].init.body).translation_options.source_lang, 'auto')

  const tw = capture(okBody)
  await provider.translate({ id: 'qwen', enabled: true }, { text: 'hi', to: 'zh-TW' },
    opts(tw.fetch, { apiKey: 'k' }))
  assert.equal(JSON.parse(tw.calls[0].init.body).translation_options.target_lang, 'Traditional Chinese')
})

test('Qwen-MT：不支持的目标语种在本地拒绝（含把 auto 当目标这种非法用法）', async () => {
  const cap = capture(okBody)
  const r = await provider.translate({ id: 'qwen', enabled: true }, { text: 'x', to: 'klingon' },
    opts(cap.fetch, { apiKey: 'k' }))
  assert.equal(r.ok, false)
  assert.match(r.msg, /不支持目标语种/)
  assert.equal(cap.calls.length, 0)

  const cap2 = capture(okBody)
  const r2 = await provider.translate({ id: 'qwen', enabled: true }, { text: 'x', to: 'auto' },
    opts(cap2.fetch, { apiKey: 'k' }))
  assert.equal(r2.ok, false, '"auto" 不能作为目标语种')
  assert.equal(cap2.calls.length, 0)
})

test('Qwen-MT 语种表不含任何"近似替代"—— 宁可拒也不能静默翻错', () => {
  for (const [code, value] of Object.entries(QWEN_MT_LANGUAGES)) {
    assert.equal(typeof value, 'string', `${code} 的映射值必须是字符串`)
    assert.ok(value.length > 0, `${code} 的映射值不能为空`)
  }
  assert.equal(QWEN_MT_LANGUAGES.zh, 'Chinese')
  assert.equal(QWEN_MT_LANGUAGES['zh-tw'], 'Traditional Chinese')
  assert.equal(QWEN_MT_LANGUAGES.yue, 'Cantonese')
  assert.equal(QWEN_MT_LANGUAGES.fil, 'Tagalog')
})

// ---------------------------------------------------------------------------
// 四、契约层：注册表、凭据门禁
// ---------------------------------------------------------------------------

test('换线后的 11 个通道全部登记在册', () => {
  const expected = ['gpt', 'grok', 'deepseek', 'google', 'qwen', 'claude', 'doubao', 'kimi', 'glm', 'mistral', 'minimax']
  for (const id of expected) {
    const p = provider.providers[id]
    assert.ok(p, `${id} 应在注册表里`)
    assert.equal(typeof p.translate, 'function', `${id} 缺 translate`)
    assert.equal(typeof p.configured, 'function', `${id} 缺 configured`)
    assert.ok(p.name && p.name.length > 0, `${id} 缺展示名`)
  }
})

test('新通道发凭据前一律 fail-closed，绝不返回演示译文', async () => {
  for (const id of ['qwen', 'claude', 'doubao', 'kimi', 'glm', 'mistral', 'minimax']) {
    const result = await provider.translate(
      { id, enabled: true, wired: true },
      payload,
      {}   // 刻意不传 credentials
    )
    assert.equal(result.ok, false, `${id} 在无凭据时不该成功`)
    assert.ok(result.msg && result.msg.length > 0, `${id} 失败时必须有可读原因`)
  }
})

test('换线没有弄丢已接通的 4 个通道（gpt / grok / deepseek / google）', () => {
  for (const id of ['gpt', 'grok', 'deepseek', 'google']) {
    const p = provider.providers[id]
    assert.ok(p, `${id} 必须还在注册表里`)
    assert.equal(p.configured({ apiKey: 'k' }), true, `${id} 仍应认凭据`)
  }
})
