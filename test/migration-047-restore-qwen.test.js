'use strict'

/**
 * 迁移 047：恢复 qwen 作为快速通道。
 *
 * 这条迁移动的是**已售权益**（package_engines / package_engine_versions），
 * 写错了影响的是真实计费与履约，不是显示。所以每条意图都钉一个用例。
 *
 * 没有真库时跑的是**静态契约**：直接读迁移导出的数据 + 扫 SQL 文本。
 * 真库行为由 test/ 下那一批需要 DATABASE_URL 的用例覆盖。
 */

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const m047 = require('../migrations/047_restore_qwen_fast_channel')
const m039 = require('../migrations/039_translation_lineup_v3_gpt_deepseek')
const m031 = require('../migrations/031_translation_channel_lineup')

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '047_restore_qwen_fast_channel.js'), 'utf8')

function packagesWith (engineId) {
  return m047.packageEnginesV4.filter(([, id]) => id === engineId).map(([code]) => code).sort()
}

// ---------------------------------------------------------------------------
// 1. 授权范围
// ---------------------------------------------------------------------------

test('★ qwen 只进 advanced / pro，不进 basic', () => {
  assert.deepEqual(packagesWith('qwen'), ['advanced', 'pro'],
    'basic 是三档里单位成本最高的一档，往里加通道等于直接吃毛利 —— 本次刻意不给')
})

test('★ gpt / deepseek 在三档都保留（不能因为加 qwen 把它们弄丢）', () => {
  for (const id of ['gpt', 'deepseek']) {
    assert.deepEqual(packagesWith(id), ['advanced', 'basic', 'pro'], id + ' 必须三档都在')
  }
})

test('v4 相对 v3 的**唯一**差别是 advanced/pro 各多一条 qwen', () => {
  const v3 = new Set(m039.packageEnginesV3.map(([c, i]) => c + ':' + i))
  const v4 = new Set(m047.packageEnginesV4.map(([c, i]) => c + ':' + i))
  const added = [...v4].filter(x => !v3.has(x)).sort()
  const removed = [...v3].filter(x => !v4.has(x)).sort()
  assert.deepEqual(added, ['advanced:qwen', 'pro:qwen'], '新增只能是这两条')
  assert.deepEqual(removed, [], '★ 不能顺手删掉任何已有权益')
})

test('每档通道数：basic=2，advanced=3，pro=3', () => {
  const count = code => m047.packageEnginesV4.filter(([c]) => c === code).length
  assert.equal(count('basic'), 2)
  assert.equal(count('advanced'), 3)
  assert.equal(count('pro'), 3)
})

test('无重复组合（重复会在 ON CONFLICT 里被吞掉，但说明清单写错了）', () => {
  const keys = m047.packageEnginesV4.map(([c, i]) => c + ':' + i)
  assert.equal(new Set(keys).size, keys.length)
})

// ---------------------------------------------------------------------------
// 2. wired 的处理 —— 这条最容易写错
// ---------------------------------------------------------------------------

test('★★ 恢复 qwen 时 enabled=true，但**绝不**把 wired 置 true', () => {
  // wired=true 的含义是「已接通、有可用凭据」。凭据在后台加密落库，
  // 迁移拿不到；硬写 true 就是谎报通道可用，用户一选就 502。
  const upBlock = SRC.slice(SRC.indexOf('exports.up'), SRC.indexOf('exports.down'))
  const restoreStmt = upBlock.slice(upBlock.indexOf('UPDATE engines'), upBlock.indexOf('2)'))

  assert.match(restoreStmt, /retired_at\s*=\s*NULL/, '必须清掉 retired_at')
  assert.match(restoreStmt, /enabled\s*=\s*true/, '必须置 enabled')
  assert.doesNotMatch(restoreStmt, /wired\s*=\s*true/,
    '★★ 恢复段里不能出现 wired = true —— 那是谎报凭据已配置')
})

test('恢复的是 031 里已有的 qwen 行，不是新建（否则会丢 031 的踩坑备注）', () => {
  assert.deepEqual(m047.restoredEngineIds, ['qwen'])
  const upBlock = SRC.slice(SRC.indexOf('exports.up'), SRC.indexOf('exports.down'))
  assert.doesNotMatch(upBlock, /INSERT\s+INTO\s+engines/i,
    '★ 不允许 INSERT engines —— qwen 行本来就在，新建会主键冲突并丢掉 note')
})

test('qwen 在 031 里已经定义过模型与端点（不是我们凭空编的通道）', () => {
  const lineup = m031.lineupEngineIds
  assert.ok(lineup.includes('qwen'), 'qwen 必须是 031 定义过的通道之一')
})

// ---------------------------------------------------------------------------
// 3. 版本推进
// ---------------------------------------------------------------------------

test('v4 快照与 packages.catalog_version 都推到 4', () => {
  const upBlock = SRC.slice(SRC.indexOf('exports.up'), SRC.indexOf('exports.down'))
  assert.match(upBlock, /package_engine_versions[\s\S]{0,200}?4,/, '快照版本号必须是 4')
  assert.match(upBlock, /catalog_version\s*=\s*4/, 'packages.catalog_version 必须是 4')
})

test('down 能把 v4 完整退回 v3（含把 qwen 重新下架）', () => {
  const downBlock = SRC.slice(SRC.indexOf('exports.down'))
  assert.match(downBlock, /catalog_version\s*=\s*3/)
  assert.match(downBlock, /DELETE FROM package_engine_versions WHERE version = 4/)
  assert.match(downBlock, /retired_at\s*=\s*NOW\(\)/, 'qwen 要重新下架')
  assert.match(downBlock, /FROM package_engine_versions v[\s\S]{0,200}?v\.version = 3/,
    '★ 回滚必须按 v3 快照整体恢复，不能只删不补')
})

// ---------------------------------------------------------------------------
// 4. 不能伤到存量商户
// ---------------------------------------------------------------------------

test('★ 不动 active_engine_id（本次是加通道，用户原选择仍合法）', () => {
  const upBlock = SRC.slice(SRC.indexOf('exports.up'), SRC.indexOf('exports.down'))
  assert.doesNotMatch(upBlock, /active_engine_id\s*=\s*NULL/,
    '039 清空它是因为有通道被下架；本次加通道不该打乱用户设置')
})

test('★ 释放存量商户的判据是"钉住版本里有通道已下架"，不是无条件清空', () => {
  const upBlock = SRC.slice(SRC.indexOf('exports.up'), SRC.indexOf('exports.down'))
  assert.match(upBlock, /package_catalog_version\s*=\s*NULL[\s\S]{0,400}?e\.retired_at IS NOT NULL/,
    '必须带 EXISTS 下架判定，否则会把所有商户无条件从钉版打回在售版')
})

test('★ 迁移不碰账务（char_balance / char_used / translate_logs）', () => {
  for (const col of ['char_balance', 'char_used', 'translate_logs']) {
    assert.ok(!SRC.includes(col), '加通道不该改已发生的账：' + col)
  }
})

// ---------------------------------------------------------------------------
// 5. 与混合路由的衔接
// ---------------------------------------------------------------------------

test('★ 恢复 qwen 之后，混合路由确实能拿到它当快速通道', () => {
  const { routeTranslate } = require('../server/services/translation-router')
  const rows = [
    { id: 'qwen', name: '通义千问翻译', enabled: true, wired: true, retired: false },
    { id: 'gpt', name: 'GPT 翻译', enabled: true, wired: true, retired: false },
    { id: 'deepseek', name: 'DeepSeek 翻译', enabled: true, wired: true, retired: false }
  ]
  const r = routeTranslate({
    selected: rows[1], text: '你好，在吗？',
    candidates: rows, fastEngineIds: ['qwen'], enabled: true
  })
  assert.equal(r.engine.id, 'qwen', '短句应被路由到 qwen')
  assert.equal(r.routed, true)
})

test('凭据还没填（wired=false）时，混合路由会自动退回原通道而不报错', () => {
  const { routeTranslate } = require('../server/services/translation-router')
  const rows = [
    { id: 'qwen', name: '通义千问翻译', enabled: true, wired: false, retired: false },
    { id: 'gpt', name: 'GPT 翻译', enabled: true, wired: true, retired: false }
  ]
  const r = routeTranslate({
    selected: rows[1], text: '你好',
    candidates: rows, fastEngineIds: ['qwen'], enabled: true
  })
  assert.equal(r.engine.id, 'gpt', '未接通的通道不能被选中')
  assert.equal(r.routed, false)
  assert.equal(r.reason, 'no-fast-engine')
})
