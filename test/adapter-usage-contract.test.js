'use strict'

/**
 * 适配器必须回传**记账字段**（model / retries / usage）。
 *
 * ## 生产事故（2026-10-11）
 *
 * `deepseek` 通道 48 次真实调用，在 `translation_usage` 里全是
 * `prompt_tokens=0 / completion_tokens=0 / upstream_cost=0`，且 `cost_verified=true`。
 *
 * 根因不在厂商，也不在 `recordUpstreamUsage`：**DeepSeek 适配器把用量丢了**。
 * `deepseekTranslate()` 的成功分支曾经返回 `{ ok: true, text }` ——
 * 而 DeepSeek 走的是 OpenAI 兼容的 `/chat/completions`，响应里**本来就有
 * `usage`**（`prompt_tokens` / `completion_tokens` / `total_tokens`）。
 *
 * 同一份文件里的通用实现 `openAiCompatible` 一直是带 `usage` 的，
 * 所以这不是"厂商不支持"，是**两条代码路径的记账契约不一致**。
 *
 * ## 这一组测试锁什么
 *
 * 对**每个在架通道**，喂一份带 usage 的上游响应，断言返回体里
 * `usage` 真的被透出来、`model` 是真的模型名。
 * 新增适配器时，只要忘了带这些字段，这里就会红。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const { providers } = require('../server/services/translation-provider')

/** 造一个假 fetch：固定返回给好的响应体，并记录请求。 */
function stubFetch(body, { status = 200 } = {}) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    }
  }
  return { fetch, calls }
}

/** OpenAI 兼容的聊天补全响应（DeepSeek / GPT 同构）。 */
function chatCompletion({ text = '你好', model = 'deepseek-flash' } = {}) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }
  }
}

// ---------------------------------------------------------------- DeepSeek（本次根因）
test('DeepSeek 适配器回传 usage —— 这是成本被记 0 的根因', async () => {
  const { fetch, calls } = stubFetch(chatCompletion({ text: 'Hello', model: 'deepseek-flash' }))

  const result = await providers.deepseek.translate(
    { id: 'deepseek', name: 'DeepSeek 翻译', model: 'deepseek-flash', enabled: true, wired: true },
    { text: '你好', from: 'zh', to: 'en' },
    { fetch, credentials: { apiKey: 'sk-test' }, timeoutMs: 8000 }
  )

  assert.equal(result.ok, true, '翻译本身要成功')
  assert.equal(result.text, 'Hello')

  assert.ok(result.usage, 'usage 必须存在。丢掉它 = 整条通道的成本在台账上记 0')
  assert.equal(result.usage.promptTokens, 120)
  assert.equal(result.usage.completionTokens, 30)
  assert.equal(result.usage.totalTokens, 150)

  assert.equal(result.model, 'deepseek-flash', '必须回传真实调用的模型（台账要按它查价）')
  assert.equal(typeof result.retries, 'number', '重试次数要回传，排障第一个要问的就是它')

  // 请求体仍要带 DeepSeek 专属的关思考参数（这次改动不能把它碰掉）
  assert.equal(calls[0].body.thinking && calls[0].body.thinking.type, 'disabled')
  assert.equal(calls[0].body.stream, false)
})

test('DeepSeek 上游没给 usage 时返回 null，由 core-service 走兜底估算', async () => {
  const body = chatCompletion()
  delete body.usage
  const { fetch } = stubFetch(body)

  const result = await providers.deepseek.translate(
    { id: 'deepseek', model: 'deepseek-flash', enabled: true, wired: true },
    { text: '你好', to: 'en' },
    { fetch, credentials: { apiKey: 'sk-test' }, timeoutMs: 8000 }
  )

  assert.equal(result.ok, true)
  assert.equal(result.usage, null, '拿不到就给 null（不要编造），由 core-service 按字符估并标未核实')
})

test('DeepSeek 失败分支不该被这次改动带坏（凭据缺失仍然 fail-closed）', async () => {
  const result = await providers.deepseek.translate(
    { id: 'deepseek', model: 'deepseek-flash', enabled: true, wired: true },
    { text: '你好', to: 'en' },
    { fetch: stubFetch(chatCompletion()).fetch, credentials: {}, timeoutMs: 8000 }
  )
  assert.equal(result.ok, false)
  assert.match(result.msg, /凭据未配置/)
})

// ------------------------------------------------ 语种回退不得无限递归（本次一并暴露）
test('「自动识别语种」+ 识别不出语种 → 曾是 500（无限递归），现在要正常翻译', async () => {
  // 触发条件：from='auto'（映射到空串）+ detectLang 没认出语种（detected=''）
  // 旧实现的 languageName 在两段都为空时会自递归到 RangeError，
  // 栈里只有语言函数，看不出真正原因。
  const { fetch } = stubFetch(chatCompletion({ text: 'Hello' }))

  const result = await providers.deepseek.translate(
    { id: 'deepseek', model: 'deepseek-flash', enabled: true, wired: true },
    { text: '...', from: 'auto', to: 'en', detected: '' },
    { fetch, credentials: { apiKey: 'sk-test' }, timeoutMs: 8000 }
  )

  assert.equal(result.ok, true, '不能再抛 RangeError')
  assert.equal(result.text, 'Hello')
  assert.ok(result.usage, '顺便：这条路径也要带上 usage')
})

test('from 为空且无 detected 同样不能崩', async () => {
  const { fetch } = stubFetch(chatCompletion({ text: 'Hi' }))
  const result = await providers.deepseek.translate(
    { id: 'deepseek', model: 'deepseek-flash', enabled: true, wired: true },
    { text: '你好', to: 'en' }, // from / detected 都没有
    { fetch, credentials: { apiKey: 'sk-test' }, timeoutMs: 8000 }
  )
  assert.equal(result.ok, true)
  assert.equal(result.text, 'Hi')
})

test('语种表仍是原来的语义：认得的转语言名，不认得的原样透传', async () => {
  const { fetch, calls } = stubFetch(chatCompletion({ text: 'x' }))
  await providers.deepseek.translate(
    { id: 'deepseek', model: 'deepseek-flash', enabled: true, wired: true },
    { text: '你好', from: 'zh', to: 'en' },
    { fetch, credentials: { apiKey: 'sk-test' }, timeoutMs: 8000 }
  )
  const prompt = calls[0].body.messages.map(m => m.content).join('\n')
  assert.match(prompt, /英语/, '目标语种要写成语言名，不能给 LLM 一个裸码')
  assert.match(prompt, /源语言是简体中文/, '源语种同理')

  // 表里没有的语种原样透传（LLM 认码），而不是丢掉或报错
  const { fetch: f2, calls: c2 } = stubFetch(chatCompletion({ text: 'x' }))
  await providers.deepseek.translate(
    { id: 'deepseek', model: 'deepseek-flash', enabled: true, wired: true },
    { text: '你好', from: 'zh', to: 'qqq' },
    { fetch: f2, credentials: { apiKey: 'sk-test' }, timeoutMs: 8000 }
  )
  assert.match(c2[0].body.messages.map(m => m.content).join('\n'), /qqq/)
})

// ---------------------------------------------------------------- Gemini（下架但保留实现）
test('Gemini 也回传 usage（usageMetadata 形状）—— 重新上架不会复发成本记 0', async () => {
  const geminiBody = {
    candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
    usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 20, totalTokenCount: 100 }
  }
  const { fetch } = stubFetch(geminiBody)

  const result = await providers.gemini.translate(
    { id: 'gemini', name: 'Gemini 翻译', model: 'gemini-2.5-flash', enabled: true, wired: true },
    { text: '你好', to: 'en' },
    { fetch, credentials: { apiKey: 'k' }, timeoutMs: 8000 }
  )

  assert.equal(result.ok, true)
  assert.ok(result.usage, 'Gemini 的 usageMetadata 必须被归一后回传')
  assert.equal(result.usage.promptTokens, 80)
  assert.equal(result.usage.completionTokens, 20)
  assert.equal(result.usage.totalTokens, 100)
  assert.equal(result.model, 'gemini-2.5-flash')
})

test('normalizeUsage 三种厂商形状都能归一（同一个口径）', () => {
  const { normalizeUsage } = require('../server/services/translation-adapters')

  // OpenAI 兼容（DeepSeek / GPT）
  assert.deepEqual(
    normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
    { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, totalTokens: 15 }
  )
  // Anthropic（Claude）
  assert.deepEqual(
    normalizeUsage({ input_tokens: 10, output_tokens: 5 }),
    { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, totalTokens: 15 }
  )
  // Gemini（包在 usageMetadata 里，字段名不同）
  assert.deepEqual(
    normalizeUsage({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } }),
    { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, totalTokens: 15 }
  )
  // 拿不到用量一律 null（不编造 0）
  assert.equal(normalizeUsage(null), null)
  assert.equal(normalizeUsage(undefined), null)
  assert.equal(normalizeUsage({}), null)
  assert.equal(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 }), null)
})

// ---------------------------------------------------------------- GPT（通用实现基线）
test('GPT 适配器同样回传 usage —— 两条路径的记账契约必须一致', async () => {
  const { fetch } = stubFetch(chatCompletion({ text: 'Hello', model: 'gpt-5' }))

  const result = await providers.gpt.translate(
    { id: 'gpt', name: 'GPT 翻译', model: 'gpt-5', enabled: true, wired: true },
    { text: '你好', to: 'en' },
    { fetch, credentials: { apiKey: 'sk-test' }, timeoutMs: 8000 }
  )

  assert.equal(result.ok, true)
  assert.ok(result.usage, 'GPT 走通用实现，usage 一直是有的 —— 这里是对照基线')
  assert.equal(result.usage.totalTokens, 150)
  assert.equal(result.model, 'gpt-5')
})

// ---------------------------------------------------------------- 契约守卫（面向未来）
test('在架通道的成功返回体都带 usage —— 新增适配器忘了带就会红', async () => {
  // `check:plan-copy` 认定的在架通道：只开放 DeepSeek 与 GPT。
  const ACTIVE = ['deepseek', 'gpt']

  for (const id of ACTIVE) {
    const adapter = providers[id]
    assert.ok(adapter, `在架通道 ${id} 必须在 providers 注册表里`)
    assert.equal(typeof adapter.translate, 'function')

    const { fetch } = stubFetch(chatCompletion({ text: 'ok', model: `${id}-model` }))
    const result = await adapter.translate(
      { id, name: id, model: `${id}-model`, enabled: true, wired: true },
      { text: '你好', to: 'en' },
      { fetch, credentials: { apiKey: 'sk-test' }, timeoutMs: 8000 }
    )

    assert.equal(result.ok, true, `${id} 应翻译成功`)
    assert.ok(
      result.usage,
      `${id} 的成功返回体没有 usage —— 厂商给了用量却在上游账本里记 0，`
      + '这正是 2026-10-11 DeepSeek 成本记 0 事故的形态'
    )
    assert.ok(
      result.usage.totalTokens > 0 || result.usage.promptTokens > 0 || result.usage.completionTokens > 0,
      `${id} 的 usage 全为 0，等于没记`
    )
    assert.ok(result.model, `${id} 没有回传 model —— 台账按 model 查价，缺了就只能标未核实`)
  }
})

test('providers 注册表里的每个通道都真的能调（没有占位通道）', () => {
  // "登记了但调不通"是百度那类通道的老问题，本项目明确不接受。
  for (const [id, adapter] of Object.entries(providers)) {
    assert.ok(adapter && typeof adapter.translate === 'function', `${id} 没有 translate 实现`)
    assert.equal(typeof adapter.name, 'string', `${id} 没有 name`)
  }
})
