'use strict'

/**
 * 充值异常告警的测试。
 *
 * ## 背景：为什么这个功能必须被测
 *
 * 2026-10-21 审计发现 `recharge_exceptions` 有 11 条 open 记录，
 * 最早一条挂了 **28 天**。巡检每 10 分钟跑一次、次次"正常" ——
 * 因为它压根不看这张表。
 *
 * 所以这里测的不是"函数返回了什么"，而是**三种必须告警的情形是否真的告警**：
 *
 *   1. 条数多（扫描/匹配整体坏了）
 *   2. 悬置久（有人在等钱，没人管）← 28 天那次属于这类
 *   3. 有疑似归属（系统已经指出可能是谁的钱，等一个决定）
 *
 * 判据必须两两解耦：任何一条单独成立都要能触发。
 * 只按条数告警的话，1 条挂一个月永远不响 —— 那正是这次事故的形状。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  checkRechargeExceptions,
  RECHARGE_OPEN_MAX,
  RECHARGE_OPEN_MAX_HOURS,
  RECHARGE_ALERT_SAMPLE
} = require('../scripts/alert')

/**
 * 假 pool：按 SQL 内容分派到预设结果。
 * 只用最小匹配，不解析 SQL —— 测试关注的是判定逻辑，不是查询写法。
 */
function fakePool({ summary, rows }) {
  return {
    query: async (sql) => {
      if (/count\(\*\)::int AS n/.test(sql)) return { rows: [summary] }
      if (/ORDER BY amount_milli DESC/.test(sql)) return { rows: rows || [] }
      throw new Error('未预期的查询：' + sql.slice(0, 60))
    }
  }
}

const EMPTY = { n: 0, total_milli: '0', oldest_hours: 0, suspicious_n: 0 }

test('没有异常时不产生告警', async () => {
  const problems = await checkRechargeExceptions(fakePool({ summary: EMPTY }))
  assert.deepEqual(problems, [])
})

test('28 天那次事故的形状：单条、悬置很久 → 必须告警', async () => {
  // 关键：条数只有 1，远低于条数阈值 RECHARGE_OPEN_MAX(3)，
  // 只有时长判据能抓到它。这条测试就是在守这个解耦。
  const problems = await checkRechargeExceptions(fakePool({
    summary: { n: 1, total_milli: '349000', oldest_hours: 28 * 24, suspicious_n: 0 },
    rows: [{ id: 1, kind: 'NO_MATCH', amount_milli: '349000', created_at: new Date().toISOString(), summary: '' }]
  }))
  const keys = problems.map(p => p[0])
  assert.ok(keys.includes('充值异常长时间未处理'),
    `单条悬置 28 天必须告警，实际：${JSON.stringify(keys)}`)
  // 条数未超阈值，不该误报积压
  assert.ok(!keys.includes('充值异常积压'), '1 条不应报积压')
})

test('条数超过阈值 → 告警积压', async () => {
  const problems = await checkRechargeExceptions(fakePool({
    summary: { n: RECHARGE_OPEN_MAX + 1, total_milli: '5000000', oldest_hours: 1, suspicious_n: 0 },
    rows: []
  }))
  const keys = problems.map(p => p[0])
  assert.ok(keys.includes('充值异常积压'))
  // 悬置时间短，不该报长期未处理
  assert.ok(!keys.includes('充值异常长时间未处理'))
})

test('有疑似归属的到账 → 单独告警（不混在总数里）', async () => {
  const problems = await checkRechargeExceptions(fakePool({
    summary: { n: 1, total_milli: '65138', oldest_hours: 1, suspicious_n: 1 },
    rows: [{
      id: 9,
      kind: 'NO_MATCH',
      amount_milli: '65138',
      created_at: new Date().toISOString(),
      summary: '',
      suspicion: {
        kind: 'SUFFIX_TYPO',
        orderNumber: 'HP1792181934903294',
        reason: '尾数 318 疑似打成 138'
      }
    }]
  }))
  const keys = problems.map(p => p[0])
  assert.ok(keys.includes('有到账疑似某张订单但未确认'), '疑似归属必须单独成一条')

  const detail = problems.map(p => p[1]).join('\n')
  assert.match(detail, /HP1792181934903294/, '明细里要点出疑似订单号')
  assert.match(detail, /318/, '明细里要写明理由')
})

test('疑似字段可能是 JSON 字符串（pg 的 jsonb 经某些驱动返回字符串）', async () => {
  const problems = await checkRechargeExceptions(fakePool({
    summary: { n: 1, total_milli: '65138', oldest_hours: 1, suspicious_n: 1 },
    rows: [{
      id: 9,
      kind: 'NO_MATCH',
      amount_milli: '65138',
      created_at: new Date().toISOString(),
      summary: '',
      suspicion: JSON.stringify({ orderNumber: 'HP123', reason: '尾数笔误' })
    }]
  }))
  const detail = problems.map(p => p[1]).join('\n')
  assert.match(detail, /HP123/, '字符串形态的 suspicion 也要能解析出来')
})

test('无疑似时不误报疑似告警', async () => {
  const problems = await checkRechargeExceptions(fakePool({
    summary: { n: 2, total_milli: '3000000', oldest_hours: 2, suspicious_n: 0 },
    rows: []
  }))
  const keys = problems.map(p => p[0])
  assert.ok(!keys.includes('有到账疑似某张订单但未确认'))
})

test('明细按金额降序，并声明未列出的条数', async () => {
  const n = RECHARGE_ALERT_SAMPLE + 5
  const rows = Array.from({ length: RECHARGE_ALERT_SAMPLE }, (_, i) => ({
    id: i + 1,
    kind: 'NO_MATCH',
    amount_milli: String((RECHARGE_ALERT_SAMPLE - i) * 1000),
    created_at: new Date().toISOString(),
    summary: ''
  }))
  const problems = await checkRechargeExceptions(fakePool({
    summary: { n, total_milli: '100000', oldest_hours: 1, suspicious_n: 0 },
    rows
  }))
  const detail = problems.map(p => p[1]).join('\n')
  assert.match(detail, new RegExp(`另有 ${n - RECHARGE_ALERT_SAMPLE} 条`),
    '截断后必须说明还有多少条，否则运维以为就这么多')
})

test('三个判据互不依赖：任一条单独成立都能触发', async () => {
  const cases = [
    { summary: { n: 1, total_milli: '1', oldest_hours: 999, suspicious_n: 0 }, expect: '充值异常长时间未处理' },
    { summary: { n: 99, total_milli: '1', oldest_hours: 0, suspicious_n: 0 }, expect: '充值异常积压' },
    { summary: { n: 1, total_milli: '1', oldest_hours: 0, suspicious_n: 1 }, expect: '有到账疑似某张订单但未确认' }
  ]
  for (const c of cases) {
    const problems = await checkRechargeExceptions(fakePool({ summary: c.summary, rows: [] }))
    const keys = problems.map(p => p[0])
    assert.ok(keys.includes(c.expect),
      `情形 ${JSON.stringify(c.summary)} 应触发「${c.expect}」，实际：${JSON.stringify(keys)}`)
  }
})

test('阈值本身要合理：能抓 28 天的事故，又不至于每小时误报', () => {
  assert.ok(RECHARGE_OPEN_MAX >= 1)
  // 12 小时：订单有效期 30 分钟，正常的人工处理不该超过半天
  assert.ok(RECHARGE_OPEN_MAX_HOURS > 0 && RECHARGE_OPEN_MAX_HOURS <= 24,
    '时长阈值超过 24 小时就抓不到"当天该处理完"这类问题')
})
