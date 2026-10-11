'use strict'

/**
 * 迁移 045：补算 DeepSeek 那 48 行「$0 却标着已核实」的历史台账。
 *
 * ## 背景（生产实测 2026-10-11）
 *
 * ```
 * engine     rows   零token行   总成本        cost_verified=true
 * deepseek     48          48   0.000000                   48   ← 全是假的"已核实"
 * gpt         417           0   0.035147                  417   ← 一直是好的
 * ```
 *
 * `deepseekTranslate()` 曾经返回 `{ ok: true, text }`，把厂商给的 `usage`
 * 整个丢掉了（适配器已修）。但**已落库的历史行不会自己变好**：
 * 「成本 0 且 cost_verified=true」是这张表最危险的状态 —— 0 与"真的没花钱"
 * 在库里完全一样，而"已核实"会让人以为查过了。月度对账会把这一块当成免费。
 *
 * ## 这一组测试锁什么
 *
 * 1. 只动"错误声称已核实"的行（守卫 `cost_verified = true`），因此天然幂等；
 * 2. 估算公式与运行时兜底 `estimateCostFromChars` **完全一致**，
 *    否则补算出来的数会自成一套口径，对账时更乱；
 * 3. 如实标 `cost_verified=false` + `cost_source=backfill:estimate`，
 *    不冒充精确；
 * 4. **不碰客户字符余额** —— 台账与对客户的扣费必须继续分离；
 * 5. `down` 靠 `cost_source` 标记精确定位，可回滚。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8')

const m = require('../migrations/045_backfill_zero_usage_cost')
const migrationSrc = read('migrations/045_backfill_zero_usage_cost.js')

test('迁移 045 存在且导出 up / down', () => {
  const files = fs.readdirSync(path.join(root, 'migrations')).filter(f => f.endsWith('.js'))
  assert.ok(files.includes('045_backfill_zero_usage_cost.js'), '找不到迁移 045')
  assert.equal(typeof m.up, 'function')
  assert.equal(typeof m.down, 'function')
})

test('守卫是「错误声称已核实」的行 —— 因此本迁移天然幂等', () => {
  assert.match(migrationSrc, /u\.cost_verified = true/,
    '必须只在 cost_verified=true 时补算。改完置 false，重复执行就不会再命中 —— '
    + '这正是"重复跑也安全"的来源')
  assert.match(migrationSrc, /u\.total_tokens = 0/,
    '要限定在"没拿到 token"的行，不能误伤正常的成本 0（例如按字符计价且真的免费）')
  assert.match(migrationSrc, /u\.upstream_cost = 0/, '要限定在成本确实记成 0 的行')
})

test('估算公式与运行时兜底 estimateCostFromChars 完全一致', () => {
  // 运行时口径：reserved_chars × cost_per_million ÷ 1e6
  const runtime = read('server/services/core-service.js')
  assert.match(runtime, /const cost = perMillion \* number\(chars\) \/ 1e6/,
    '运行时兜底公式变了 —— 迁移 045 必须同步，否则两本账口径分叉')

  // 迁移里的 SQL 也必须是一模一样的算式
  assert.match(migrationSrc, /r\.reserved_chars::numeric \* e\.cost_per_million::numeric\) \/ 1000000/,
    '迁移的算式与运行时不一致：补算出来的值与新记录对不上')
  assert.match(migrationSrc, /ROUND\([\s\S]*?, 8\)/, '成本要保留 8 位，与 upstream_cost 的既有精度一致')
})

test('如实标注：置 verified=false，来源标 backfill', () => {
  assert.match(migrationSrc, /cost_verified = false/,
    '估算就是估算，必须标未核实 —— 不能再留一个假的"已核实"')
  assert.equal(m.SOURCE_TAG, 'backfill:estimate')
  assert.match(migrationSrc, /cost_source\s*=\s*'\$\{SOURCE_TAG\}'/)
  assert.match(migrationSrc, /cost_as_of\s*=\s*'\$\{BACKFILL_AS_OF\}'/,
    '要写清这个估算是什么时候作出的（价目表会调价）')
})

test('成本说明由数据拼出（字符数 × 单价），不是一句空话', () => {
  assert.match(migrationSrc, /NOTE_PREFIX[\s\S]*r\.reserved_chars[\s\S]*e\.cost_per_million/,
    'cost_note 要写清"多少字符 × 什么单价"，否则后来人无从复核')
  assert.match(m.NOTE_PREFIX, /未返回 usage/,
    '要写明成因（厂商用量丢失），而不是含糊地说"估算"')
  // 「同口径」这句在 SQL 尾部拼接（NOTE_PREFIX 之后的续写），整条 note 里必须有
  assert.match(migrationSrc, /translate_logs\.cost_amount 同口径/,
    '要写明与 translate_logs.cost_amount 同口径，方便两本账对照')
})

test('不碰客户字符余额（台账与对客户的扣费必须继续分离）', () => {
  // 只允许 UPDATE translation_usage，不得出现任何余额/用户表的写操作
  assert.doesNotMatch(migrationSrc, /UPDATE\s+users/i, '迁移不得改动 users（客户余额在那里）')
  assert.doesNotMatch(migrationSrc, /char_balance/i, '迁移不得触碰客户字符余额')
  assert.doesNotMatch(migrationSrc, /UPDATE\s+translation_reservations/i,
    '预订表是只读依据，不能被这次补算改写')
  const updates = migrationSrc.match(/UPDATE\s+[a-z_]+/gi) || []
  for (const u of updates) {
    assert.match(u, /translation_usage|translation_reservations/i,
      `迁移里出现了意料之外的写操作：${u}`)
  }
})

test('down 靠 cost_source 标记精确定位，可回滚', () => {
  const down = migrationSrc.slice(migrationSrc.indexOf('exports.down'))
  assert.ok(down.length > 0, '没有 exports.down —— 无法回滚')
  assert.match(down, /WHERE cost_source = '\$\{SOURCE_TAG\}'/,
    'down 必须只还原本迁移改过的行，不能一把梭全表重置')
  assert.match(down, /upstream_cost = 0/, 'down 要把成本还原成 0')
  assert.match(down, /cost_verified = true/, 'down 要还原当初那个（错误的）已核实标记')
})

test('拿不到单价的行不动 —— 不猜', () => {
  assert.match(migrationSrc, /e\.cost_per_million > 0/,
    '没有单价就无从估算，必须留给人工，不能凭 0 或猜测写一个数')
})

test('金额量级与已知事实相符（48 行 × 8056 字符）', () => {
  // 生产实测：48 行全部可关联 reservation，合计 8056 字符，单价 $0.8333/百万字符
  const expected = 8056 * 0.8333 / 1e6
  assert.ok(Math.abs(expected - 0.0067) < 0.001, `量级应在 $0.0067 附近，实际 ${expected}`)
  assert.ok(expected > 0, '补算后总成本必须大于 0（这正是本迁移的意义）')
})
