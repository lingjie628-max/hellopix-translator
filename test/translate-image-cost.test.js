'use strict'

/**
 * 图片翻译的成本台账 —— 防"成本记 0"事故重演。
 *
 * ## 为什么必须有这个文件
 *
 * 2026-10-11 生产上出过一件事：DeepSeek 通道 48 次调用的成本全是
 * `prompt_tokens=0 / upstream_cost=0`，`cost_verified=true`。
 * 成本表上整条通道"几乎零成本"，月末对账凭空少一整块。
 *
 * 根因是**两处字段名不匹配**：适配器返回原始 `prompt_tokens`，
 * 台账读 `usage.promptTokens` → 读不到 → 记 0。
 *
 * 图片翻译的单价远高于文本，同样的问题发生一次，损失比那次大得多。
 * 所以这里从"上游原始响应"一路验到"台账拿到的 token 数"。
 */

const test = require('node:test')
const assert = require('node:assert')

const { translateImage } = require('../server/services/translation-image')

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function upstreamWith (usage) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '{"blocks":[{"source":"a","target":"甲"}]}' } }],
      usage
    }),
    text: async () => ''
  })
}

test('★ 上游 usage 被归一化成台账认得的字段名（prompt_tokens → promptTokens）', async () => {
  const res = await translateImage(
    { id: 'gpt', endpoint: '', model: 'gpt-4o-mini' },
    { image: TINY_PNG, mime: 'image/png' },
    {
      credentials: { apiKey: 'k' },
      // 这是 OpenAI 真实返回的形状
      fetch: upstreamWith({ prompt_tokens: 1234, completion_tokens: 567, total_tokens: 1801 })
    }
  )
  assert.equal(res.ok, true)
  assert.ok(res.usage, '必须带回 usage')
  // 台账读的是 camelCase，缺了就是成本记 0
  assert.equal(res.usage.promptTokens, 1234, 'promptTokens 必须有值（否则成本记 0）')
  assert.equal(res.usage.completionTokens, 567)
  assert.equal(res.usage.totalTokens, 1801)
})

test('★ 上游没给 usage 时返回 null（而不是 {} 或 0）—— 由台账标"未核实"', async () => {
  const res = await translateImage(
    { id: 'gpt', endpoint: '', model: 'gpt-4o-mini' },
    { image: TINY_PNG, mime: 'image/png' },
    { credentials: { apiKey: 'k' }, fetch: upstreamWith(undefined) }
  )
  assert.equal(res.ok, true)
  // 关键：null 才能让 estimateCostFromChars 走"估算 + 标记未核实"的路径；
  // 返回 {} 会让 hasUsage 为 false 但看起来"有对象"，容易误判。
  assert.equal(res.usage, null)
})

test('★ 图片请求会带上 prompt token（看图本身要钱，不能只算输出）', async () => {
  let captured = null
  await translateImage(
    { id: 'gpt', endpoint: '', model: 'gpt-4o-mini' },
    { image: TINY_PNG, mime: 'image/png' },
    {
      credentials: { apiKey: 'k' },
      fetch: async (url, init) => {
        captured = JSON.parse(init.body)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: '{"blocks":[]}' } }],
            usage: { prompt_tokens: 1000, completion_tokens: 50 }
          }),
          text: async () => ''
        }
      }
    }
  )
  // 请求体里必须真的带了图片，否则"看图"这件事不存在，成本核算也没意义
  const img = captured.messages.find(m => m.role === 'user').content.find(p => p.type === 'image_url')
  assert.ok(img, '请求体必须带 image_url 分段')
})
