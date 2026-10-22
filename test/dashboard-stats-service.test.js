'use strict'

/**
 * DashboardStatsService 的行为测试。
 *
 * ## 为什么光有 admin-dashboard-stats.test.js 不够
 *
 * 那个文件是**读源码做静态断言** —— 守的是"代码里有没有这件事"
 * （字段别名对不对、口径有没有改回 order_fans、有没有 ::int）。
 * 但它拦不住**算错**：`grossProfit` 写成 `received + cost`、
 * `activeEngine` 在没配默认通道时没退回已接通通道 —— 源码里该有的字都在。
 *
 * 所以这里跑真逻辑，用假 repo 喂确定的数据。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const { DashboardStatsService, CURRENCY_SYMBOLS } = require('../server/services/dashboard-stats-service')

/**
 * 造一个假 repo。
 *
 * 按 SQL 里的特征串分发，而不是按调用顺序 ——
 * 顺序在实现里是并发执行的，钉死顺序会让测试在无关改动下假红。
 */
function repoWith({ counts = {}, settings = {}, recentTranslates = [], recentAudits = [], engines = [], packages = [] } = {}) {
  const calls = []
  return {
    calls,
    settings: async () => settings,
    async query(sql, values) {
      calls.push({ sql: String(sql), values })
      const text = String(sql)
      if (text.includes('AS user_count')) return { rows: [counts] }
      if (text.includes('FROM translate_logs t JOIN users')) return { rows: recentTranslates }
      if (text.includes('FROM audit_logs')) return { rows: recentAudits }
      if (text.includes('cost_per_million')) return { rows: engines }
      if (text.includes('FROM packages')) return { rows: packages }
      throw new Error(`假 repo 不认识这条 SQL: ${text.slice(0, 80)}`)
    }
  }
}

const COUNTS = {
  userCount: 12,
  activeUsers: 9,
  enterpriseUsers: 2,
  subCount: 5,
  fanCount: 40,
  shortLinkHits: 130,
  charBalance: 900000,
  charUsed: 250000,
  rechargeSum: '1000.50',
  rechargeCount: 4,
  translateCost: '120.25',
  translateSell: '0',
  rechargePending: 3,
  rechargePendingStale: 1
}

test('毛利 = 实收 − 通道成本，收到 2 位小数', async () => {
  const svc = new DashboardStatsService(repoWith({ counts: COUNTS }))
  const stats = await svc.overview()
  // 1000.50 - 120.25 = 880.25
  assert.equal(stats.grossProfit, 880.25)
  assert.equal(typeof stats.grossProfit, 'number', '毛利必须是数字，不能是字符串')
})

test('毛利不产生浮点尾数', async () => {
  // 0.1 + 0.2 那类经典问题：不做收口会漏出 880.2500000000001
  const svc = new DashboardStatsService(repoWith({
    counts: { ...COUNTS, rechargeSum: '1000.1', translateCost: '119.85' }
  }))
  const stats = await svc.overview()
  assert.equal(stats.grossProfit, 880.25,
    `毛利出现了浮点尾数：${stats.grossProfit}`)
  assert.ok(String(stats.grossProfit).length <= 6, '毛利小数位失控')
})

test('实收或成本缺失时按 0 处理，不返回 NaN', async () => {
  // 三种缺失形态都要覆盖。只测 null 是不够的 ——
  // Number(null) === 0 会自动兜住，而 Number(undefined) === NaN 会一路传到前端，
  // 界面就显示 "NaN"。字段被 SQL 改名/漏查时，拿到的正是 undefined。
  for (const [label, counts] of [
    ['null', { ...COUNTS, rechargeSum: null, translateCost: null }],
    ['字段不存在', (({ rechargeSum, translateCost, ...rest }) => rest)(COUNTS)],
    ['空串', { ...COUNTS, rechargeSum: '', translateCost: '' }]
  ]) {
    const stats = await new DashboardStatsService(repoWith({ counts })).overview()
    assert.equal(stats.grossProfit, 0, `${label}：毛利应为 0`)
    assert.ok(!Number.isNaN(stats.grossProfit), `${label}：毛利变成了 NaN —— 前端会显示 NaN`)
  }
})

test('配了默认通道时，优先返回配置的那个', async () => {
  const repo = repoWith({
    counts: COUNTS,
    settings: { 'translation.active_engine': 'gpt' },
    engines: [{ id: 'gpt', name: 'GPT', costPerMillion: 3 }]
  })
  const stats = await new DashboardStatsService(repo).overview()
  assert.equal(stats.activeEngine, 'GPT')
  assert.equal(stats.engineCostPerMillion, 3)
  // 参数必须真的传进去了，不能只是 SQL 里写着 $1
  const engineCall = repo.calls.find(c => c.sql.includes('cost_per_million'))
  assert.deepEqual(engineCall.values, ['gpt'], '配置的通道 id 没有传给 SQL')
})

test('没配默认通道时参数传空串，由 SQL 退回已接通通道', async () => {
  const repo = repoWith({ counts: COUNTS, engines: [{ id: 'baidu', name: '百度翻译', costPerMillion: 0.5 }] })
  const stats = await new DashboardStatsService(repo).overview()
  assert.equal(stats.activeEngine, '百度翻译')
  const engineCall = repo.calls.find(c => c.sql.includes('cost_per_million'))
  assert.deepEqual(engineCall.values, [''], '没配通道时参数应是空串，否则 SQL 两个分支都不成立')
})

test('一个可用通道都没有时不崩，activeEngine 回空串', async () => {
  const stats = await new DashboardStatsService(repoWith({ counts: COUNTS })).overview()
  assert.equal(stats.activeEngine, '')
  assert.equal(stats.engineCostPerMillion, null)
})

test('套餐文案用「系统设置」里的币种，缺省 USD', async () => {
  const packages = [{ title: '基础版', price: 200, includedChars: 500000 }]

  const usd = await new DashboardStatsService(repoWith({ counts: COUNTS, packages })).overview()
  assert.equal(usd.packageBill, '基础版 $200/50万')

  const cny = await new DashboardStatsService(repoWith({
    counts: COUNTS, packages, settings: { 'billing.currency': 'CNY' }
  })).overview()
  assert.equal(cny.packageBill, '基础版 ¥200/50万', '币种设置没被采纳')
})

test('未知币种回退 $，不会印出 undefined', async () => {
  const stats = await new DashboardStatsService(repoWith({
    counts: COUNTS,
    packages: [{ title: '基础版', price: 200, includedChars: 500000 }],
    settings: { 'billing.currency': 'XYZ' }
  })).overview()
  assert.equal(stats.packageBill, '基础版 $200/50万')
  assert.ok(!stats.packageBill.includes('undefined'))
})

test('没有套餐时不崩，文案为空串', async () => {
  const stats = await new DashboardStatsService(repoWith({ counts: COUNTS })).overview()
  assert.equal(stats.packageBill, '')
})

test('最近记录的条数通过参数传入，不写死在 SQL 里', async () => {
  const repo = repoWith({ counts: COUNTS })
  await new DashboardStatsService(repo).overview()
  for (const marker of ['FROM translate_logs t JOIN users', 'FROM audit_logs']) {
    const call = repo.calls.find(c => c.sql.includes(marker))
    assert.ok(Array.isArray(call.values) && call.values.length === 1,
      `${marker} 的 LIMIT 应该走参数`)
    assert.equal(typeof call.values[0], 'number')
  }
})

test('返回对象带上最近记录（即使是空数组也要有键）', async () => {
  const stats = await new DashboardStatsService(repoWith({ counts: COUNTS })).overview()
  assert.deepEqual(stats.recentTranslates, [])
  assert.deepEqual(stats.recentAudits, [])
})

test('返回对象保留 SQL 里的全部计数字段（mapRow 折叠成驼峰）', async () => {
  const stats = await new DashboardStatsService(repoWith({ counts: COUNTS })).overview()
  for (const key of Object.keys(COUNTS)) {
    assert.ok(key in stats, `总览缺少字段 ${key} —— 前端会显示 0`)
  }
})

test('构造时没有 repo.query 直接报错，而不是运行时才炸', () => {
  assert.throws(() => new DashboardStatsService({}), TypeError)
  assert.throws(() => new DashboardStatsService(null), TypeError)
})

test('币种表与前端约定保持一致', () => {
  assert.equal(CURRENCY_SYMBOLS.USD, '$')
  assert.equal(CURRENCY_SYMBOLS.CNY, '¥')
})
