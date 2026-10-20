'use strict'

/**
 * 实例偏好解析。
 *
 * 这里锁的两类问题都属于**不会报错、只会静默出事**：
 *   · 群组默认值算错 → 给老用户打开自动扣费；
 *   · 沉降窗算错 → 发送链路凭空多等几百毫秒。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  groupModeOf,
  resolveGroupEnabled,
  settingOn,
  pickLang,
  accountPrefs,
  tabPrefs,
  SEND_SETTLE_FLOOR_MS,
  SEND_SETTLE_CEILING_MS
} = require('../desktop/src/window/instance-prefs')

// ---------------------------------------------------------------------------
// 群组三态：默认值关系到钱
// ---------------------------------------------------------------------------

test('群组模式缺省必须是 manual，绝不能默认 inherit', () => {
  // 账号级 trans_group 的库默认是 true。把"没选过"解释成"跟随账号"
  // = 给所有存量实例打开自动扣费。
  assert.equal(groupModeOf({}), 'manual')
  assert.equal(groupModeOf(null), 'manual')
  assert.equal(groupModeOf(undefined), 'manual')
  assert.equal(groupModeOf({ groupMode: 'garbage' }), 'manual')
})

test('群组模式认三个合法值', () => {
  assert.equal(groupModeOf({ groupMode: 'inherit' }), 'inherit')
  assert.equal(groupModeOf({ groupMode: 'auto' }), 'auto')
  assert.equal(groupModeOf({ groupMode: 'manual' }), 'manual')
})

test('resolveGroupEnabled：auto/manual 强制，inherit 跟随账号且拿不到就关', () => {
  assert.equal(resolveGroupEnabled({ groupMode: 'auto' }, { transGroup: false }), true)
  assert.equal(resolveGroupEnabled({ groupMode: 'manual' }, { transGroup: true }), false)
  assert.equal(resolveGroupEnabled({ groupMode: 'inherit' }, { transGroup: true }), true)
  assert.equal(resolveGroupEnabled({ groupMode: 'inherit' }, { transGroup: false }), false)
  // 账号级缺失 → 宁可不翻，也不误扣
  assert.equal(resolveGroupEnabled({ groupMode: 'inherit' }, null), false)
  assert.equal(resolveGroupEnabled({ groupMode: 'inherit' }, {}), false)
  // 字段缺失（存量为 manual）→ 即使账号开了也必须是关
  assert.equal(resolveGroupEnabled({}, { transGroup: true }), false,
    '存量实例字段缺失时绝不能跟随账号级自动翻译')
})

// ---------------------------------------------------------------------------
// 开关取值
// ---------------------------------------------------------------------------

test('settingOn：具体开关优先，缺省跟随总开关 enableTranslate', () => {
  assert.equal(settingOn({ enableRecvTranslate: true }, 'enableRecvTranslate'), true)
  assert.equal(settingOn({ enableRecvTranslate: false }, 'enableRecvTranslate'), false)
  // 具体开关没设 → 看总开关，默认开
  assert.equal(settingOn({}, 'enableRecvTranslate'), true)
  assert.equal(settingOn({ enableTranslate: true }, 'enableRecvTranslate'), true)
  assert.equal(settingOn({ enableTranslate: false }, 'enableRecvTranslate'), false)
  assert.equal(settingOn(null, 'x'), true)
})

test('pickLang：空值与 auto 都回落', () => {
  assert.equal(pickLang('', 'zh'), 'zh')
  assert.equal(pickLang('auto', 'zh'), 'zh')
  assert.equal(pickLang('   ', 'zh'), 'zh')
  assert.equal(pickLang('en', 'zh'), 'en')
  assert.equal(pickLang(null, 'en'), 'en')
})

// ---------------------------------------------------------------------------
// 账号级 / 实例级合成
// ---------------------------------------------------------------------------

test('accountPrefs：数值字段按 0/1 约定解析', () => {
  const p = accountPrefs({ transRecv: 0, transSend: 1, transGroup: 1, includeZh: 1, activeEngine: 'deepl' })
  assert.equal(p.transRecv, false, 'transRecv:0 表示关')
  assert.equal(p.transSend, true)
  assert.equal(p.transGroup, true)
  assert.equal(p.includeZh, true)
  assert.equal(p.engine, 'deepl')
  // 空 profile 给安全默认：接收/发送开，群组关
  const d = accountPrefs(null)
  assert.equal(d.transRecv, true)
  assert.equal(d.transSend, true)
  assert.equal(d.transGroup, false)
  assert.equal(d.langMine, 'zh')
  assert.equal(d.langOther, 'auto')
})

test('tabPrefs：实例没设过任何字段 → 整份跟随账号', () => {
  const profile = { transRecv: 0, transSend: 1, transGroup: 1, langMine: 'ja' }
  const p = tabPrefs({ id: 't1', settings: {} }, profile)
  assert.equal(p.transRecv, false, '账号关了接收，新窗口也必须是关的')
  assert.equal(p.transSend, true)
  assert.equal(p.transGroup, true, '没设过 → 跟随账号')
  assert.equal(p.langMine, 'ja')
})

test('tabPrefs：实例设过 → 以实例为准', () => {
  const profile = { transGroup: true }
  const p = tabPrefs({
    id: 't2',
    partition: 'persist:x',
    settings: { enableRecvTranslate: false, recvTo: 'en', groupMode: 'manual' }
  }, profile)
  assert.equal(p.transRecv, false)
  assert.equal(p.langMine, 'en')
  assert.equal(p.transGroup, false, '实例显式关了群组，不能因为账号开着就翻')
})

test('tabPrefs：取证字段必须带上 tabId / partition / engine', () => {
  const p = tabPrefs({ id: 'tab-9', partition: 'persist:telegram', settings: {} }, { activeEngine: 'gpt' })
  assert.equal(p.tabId, 'tab-9')
  assert.equal(p.partition, 'persist:telegram')
  assert.equal(p.engine, 'gpt')
})

test('tabPrefs：includeZh 兼容 0/1 与布尔', () => {
  assert.equal(tabPrefs({ settings: { enableTranslate: true, includeZh: 1 } }, {}).includeZh, true)
  assert.equal(tabPrefs({ settings: { enableTranslate: true, includeZh: 0 } }, {}).includeZh, false)
  assert.equal(tabPrefs({ settings: { enableTranslate: true, includeZh: '0' } }, {}).includeZh, false)
  assert.equal(tabPrefs({ settings: { enableTranslate: true, includeZh: false } }, {}).includeZh, false)
})

test('tabPrefs：沉降窗默认是最短确认窗，不是 500ms', () => {
  const p = tabPrefs({ settings: {} }, {})
  assert.equal(p.sendSettleMs, SEND_SETTLE_FLOOR_MS)
  assert.equal(p.sendSettleMs, 60, '默认 60ms：正文稳定就立刻发，不能无条件等 500ms')
  assert.equal(p.sendSettleCeilingMs, SEND_SETTLE_CEILING_MS)
  // 取证模式可以显式调到 500
  assert.equal(tabPrefs({ settings: { sendSettleMs: 500 } }, {}).sendSettleMs, 500)
  // 非法值回落到默认
  assert.equal(tabPrefs({ settings: { sendSettleMs: 'abc' } }, {}).sendSettleMs, 60)
})

test('tabPrefs：字号/字体色有默认值', () => {
  const p = tabPrefs({ settings: {} }, {})
  assert.equal(p.fontSize, 15)
  assert.equal(p.fontColor, '#22c55e')
  assert.equal(p.antiRevoke, false)
})
