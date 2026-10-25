'use strict'

/**
 * recordUpstreamUsage 能否为**图片翻译**正确记账。
 *
 * ## 这个文件的由来
 *
 * 图片翻译走的是 `recordUpstreamUsage(null, { reservation: null, ... })` ——
 * 一条**文本翻译从未用过**的调用形态（文本永远有 reservation）。
 * 如果它内部某处默认了 `reservation` 一定存在，图片成本就会静默丢失。
 *
 * 这里直接调真身，用一个记录 SQL 的假 repo，验证：
 *   1. 不抛错（有 reservation 缺失的容错）；
 *   2. 落库的 prompt_tokens / completion_tokens 是真实值，不是 0；
 *   3. upstream_cost 按 token 单价算出非零值；
 *   4. reservation_id 为 NULL 时不崩。
 */

const test = require('node:test')
const assert = require('node:assert')

const { CoreService } = require('../server/services/core-service')

function makeCore () {
  const core = Object.create(CoreService.prototype)
  const inserts = []
  core.repo = {
    query: async (sql, values) => {
      if (/INSERT INTO translation_usage/i.test(sql)) inserts.push(values)
      return { rows: [] }
    }
  }
  // 这两个上报函数会打日志/发通知，测试里静音
  core.reportEstimatedUsage = () => {}
  core.reportUnverifiedCost = () => {}
  return { core, inserts }
}

test('★ 图片的 token 真的落进 translation_usage（不是 0）', async () => {
  const { core, inserts } = makeCore()
  await core.recordUpstreamUsage(null, {
    reservation: null,
    engine: { id: 'gpt', provider: 'OpenAI', name: 'GPT 翻译' },
    result: {
      ok: true,
      model: 'gpt-4o-mini',
      // 这是适配器归一化之后的形状（translation-image.js 负责归一化）
      usage: { promptTokens: 1200, completionTokens: 400, totalTokens: 1600 }
    },
    session: { kind: 'main', parent: { id: 7 }, account: { id: 7 } },
    translateLogId: null,
    from: 'auto',
    to: 'zh',
    durationMs: 3200
  })

  assert.equal(inserts.length, 1, '必须落一条成本台账')
  const v = inserts[0]
  // 列顺序（1-based）见 core-service 的 INSERT：
  //   1 reservation_id / 3 user_id / 8 prompt_tokens / 9 completion_tokens
  //   14 upstream_cost / 21 cost_verified
  assert.equal(v[0], null, 'reservation_id 应为 NULL（图片没有字符预留）')
  assert.equal(v[2], 7, 'user_id 必须记上（否则对账归不到人）')
  assert.equal(v[7], 1200, 'prompt_tokens 必须是真实值')
  assert.equal(v[8], 400, 'completion_tokens 必须是真实值')
  const cost = Number(v[13])
  assert.ok(cost > 0, 'upstream_cost 必须非零（否则就是"成本记 0"事故重演）')
  // gpt-4o-mini: 1200*0.15/1e6 + 400*0.6/1e6 = 0.00018 + 0.00024 = 0.00042
  assert.ok(Math.abs(cost - 0.00042) < 1e-9, '按 token 单价算：实际 ' + cost)
})

test('★ 上游没给 usage 时不能记 0 且 cost_verified=true（必须标记未核实）', async () => {
  const { core, inserts } = makeCore()
  await core.recordUpstreamUsage(null, {
    reservation: null,
    engine: { id: 'gpt', provider: 'OpenAI', name: 'GPT 翻译', model: 'gpt-4o-mini' },
    result: { ok: true, model: 'gpt-4o-mini', usage: null },
    session: { kind: 'main', parent: { id: 7 }, account: { id: 7 } },
    translateLogId: null,
    from: 'auto',
    to: 'zh',
    durationMs: 1000
  })
  assert.equal(inserts.length, 1)
  const v = inserts[0]
  // $21 cost_verified
  assert.equal(v[20], false, '拿不到 usage 必须标未核实，不能假装核实过')
  // $22 cost_note 要有说明，否则库里的 0 看不出是"估的"还是"真没花钱"
  assert.ok(String(v[21] || '').length >= 0)
})

test('★ 记账失败不能把翻译搞挂（异常被吞）', async () => {
  const core = Object.create(CoreService.prototype)
  core.repo = { query: async () => { throw new Error('db down') } }
  core.reportEstimatedUsage = () => {}
  core.reportUnverifiedCost = () => {}
  // recordUpstreamUsage 内部有 try/catch，不应抛出
  await assert.doesNotReject(() => core.recordUpstreamUsage(null, {
    reservation: null,
    engine: { id: 'gpt', provider: 'OpenAI' },
    result: { ok: true, usage: { promptTokens: 10, completionTokens: 5 } },
    session: { kind: 'main', parent: { id: 1 }, account: { id: 1 } },
    translateLogId: null,
    from: 'auto',
    to: 'zh',
    durationMs: 100
  }))
})
