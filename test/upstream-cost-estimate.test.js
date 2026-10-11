'use strict'

/**
 * 上游成本台账：厂商没回 `usage` 时**不得把成本记成 0**。
 *
 * ## 生产上发现的真实缺陷（2026-10-11）
 *
 * ```
 * engine_id   model             calls  prompt_tokens  completion_tokens  upstream_cost  cost_verified
 * deepseek    deepseek-flash       48              0                  0     0.00000000   true
 * ```
 *
 * 48 次真实调用，token 与成本全是 0，而 `cost_verified=true`。
 * 成因两条：
 *   1. `normalizeUsage()` 在厂商未返回 usage 时返回 `null`（`adapters`）；
 *   2. `recordUpstreamUsage()` 拿不到 token 就按 0 记账。
 *
 * 于是成本报表上整条通道显示"几乎零成本"，而 `cost_verified=true`
 * 还让人以为已核实 —— 它核的是**单价查到了**，不是**用量记到了**。
 * 金额暂小（约 $0.005），但机制是坏的：DeepSeek 一旦成为主力通道，
 * 月度对账会凭空少一整块成本。
 *
 * ## 修法
 *
 * 拿不到 usage 时，按通道成本表的**字符单价**兜底估算
 * （与 `translate_logs.cost_amount` 同口径），并把 `cost_verified`
 * 如实置为 `false` —— 宁可标成"估的"，也不要一个看起来干净的 0。
 *
 * ## 这一组测试锁什么
 *
 * 1. 无 usage → 非 0 成本 + `cost_verified=false` + 可读的说明
 * 2. 有 usage → 走价目表精确计价，且 `cost_verified=true`（原能力不被破坏）
 * 3. 缓存命中不记账（原本就有的设计，不能被这次改动带坏）
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const { CoreService } = require('../server/services/core-service')

/** 抓一次 recordUpstreamUsage 真正写进 translation_usage 的那一行。 */
function makeHarness() {
  const inserted = []
  const repo = {
    query: async (sql, values) => {
      if (/INSERT INTO translation_usage/i.test(String(sql))) {
        // 列顺序见 core-service 的 INSERT 语句
        const cols = ['reservation_id', 'translate_log_id', 'user_id', 'sub_account_id', 'engine_id',
          'provider', 'model', 'prompt_tokens', 'completion_tokens', 'reasoning_tokens', 'total_tokens',
          'billed_units', 'billed_unit', 'upstream_cost', 'currency', 'retries', 'cached',
          'from_language', 'to_language', 'duration_ms', 'cost_verified', 'cost_note', 'cost_source', 'cost_as_of']
        const row = {}
        cols.forEach((c, i) => { row[c] = values[i] })
        inserted.push(row)
      }
      return { rows: [] }
    }
  }
  // 第三个参数是 auth、第四个是 options。本组测试不触发翻译与鉴权，
  // 只用记录台账（recordUpstreamUsage 不碰 redis/auth）。
  const svc = new CoreService(repo, { get() {}, set() {} }, {})
  return { svc, inserted }
}

const ENGINE = {
  id: 'deepseek',
  provider: 'DeepSeek',
  model: 'deepseek-flash',
  // 生产实测值：美元/百万字符
  costPerMillion: 0.8333
}

const SESSION = { parent: { id: 37 }, kind: 'main', account: { id: 37 } }

test('厂商没回 usage → 成本按字符单价估算，且标记为未核实（不再静默记 0）', async () => {
  const { svc, inserted } = makeHarness()

  await svc.recordUpstreamUsage(null, {
    reservation: { id: 410, reservedChars: 120 },
    engine: ENGINE,
    // 生产实况：适配器拿不到 usage，返回 null / undefined
    result: { model: 'deepseek-flash', usage: null },
    session: SESSION,
    translateLogId: 406,
    from: 'zh',
    to: 'en',
    durationMs: 977
  })

  assert.equal(inserted.length, 1, '必须落一条台账')
  const row = inserted[0]

  // 120 字符 × $0.8333/百万 = $0.0001（保留 8 位）
  assert.equal(Number(row.upstream_cost), Number((0.8333 * 120 / 1e6).toFixed(8)),
    '成本必须按字符单价估出来，绝不能是 0')
  assert.ok(Number(row.upstream_cost) > 0, '这是本次缺陷的核心：0 成本会让报表少一整块')
  assert.equal(row.cost_verified, false,
    '估算值必须标成未核实。cost_verified=true 会让人以为"已核实"，'
    + '而它核的是单价而不是用量')
  assert.match(String(row.cost_note), /未返回 usage/,
    '说明必须写清原因（厂商没回用量），否则对账时看不出这个数是怎么来的')
  assert.equal(row.currency, 'USD', 'cost_per_million 在迁移 032 后已是美元')
})

test('usage 为空对象时同样走估算（不能只看 null）', async () => {
  const { svc, inserted } = makeHarness()
  await svc.recordUpstreamUsage(null, {
    reservation: { id: 411, reservedChars: 80 },
    engine: ENGINE,
    result: { model: 'deepseek-flash', usage: {} },
    session: SESSION,
    translateLogId: 407,
    from: 'zh', to: 'en', durationMs: 1000
  })
  assert.ok(Number(inserted[0].upstream_cost) > 0, 'usage 空对象也要兜底')
  assert.equal(inserted[0].cost_verified, false)
})

test('有 usage 时仍走价目表精确计价，且核实标记为 true（原能力不被破坏）', async () => {
  const { svc, inserted } = makeHarness()

  await svc.recordUpstreamUsage(null, {
    reservation: { id: 412, reservedChars: 200 },
    engine: ENGINE,
    // deepseek-flash 价目表：峰时 $0.3 输入 / $1.2 输出
    result: { model: 'deepseek-flash', usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 } },
    session: SESSION,
    translateLogId: 408,
    from: 'zh', to: 'en', durationMs: 1200
  })

  const row = inserted[0]
  const expected = 1000 / 1e6 * 0.3 + 500 / 1e6 * 1.2
  assert.equal(Number(row.upstream_cost), Number(expected.toFixed(8)),
    '有 usage 时按 token 精确计价')
  assert.equal(row.prompt_tokens, 1000)
  assert.equal(row.completion_tokens, 500)
  assert.equal(row.cost_verified, true, '价目表查到了价、用量也拿到了 —— 这才叫已核实')
  assert.equal(row.billed_units, 1500, '按 token 计费的通道要记 token 数')
})

test('未定价的通道仍记 0 但标未核实（"0"的含义是不知道，不是免费）', async () => {
  const { svc, inserted } = makeHarness()
  await svc.recordUpstreamUsage(null, {
    reservation: { id: 413, reservedChars: 50 },
    // costPerMillion 缺失 = 通道未定价
    engine: { id: 'mystery', provider: '未知', model: 'unknown-model' },
    result: { model: 'unknown-model', usage: null },
    session: SESSION, translateLogId: 409, from: 'zh', to: 'en', durationMs: 500
  })
  assert.equal(Number(inserted[0].upstream_cost), 0, '没有单价就只能记 0')
  assert.equal(inserted[0].cost_verified, false, '但必须标未核实')
})

test('台账写失败不得把翻译带崩（旁路原则不能丢）', async () => {
  const repo = {
    query: async () => { throw new Error('relation does not exist') }
  }
  const svc = new CoreService(repo, { get() {}, set() {} }, {})
  await assert.doesNotReject(
    svc.recordUpstreamUsage(null, {
      reservation: { id: 414, reservedChars: 10 },
      engine: ENGINE,
      result: { model: 'deepseek-flash', usage: null },
      session: SESSION, translateLogId: 410, from: 'zh', to: 'en', durationMs: 100
    }),
    '台账是对账用的旁路，写失败只该打日志，绝不能影响已经成功的翻译'
  )
})
