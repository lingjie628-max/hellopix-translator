'use strict'

/**
 * 设备来源识别的单测。
 *
 * ## 判据：前缀优先，长度兜底
 *
 *   1. `3A` 开头         → iPhone
 *   2. `3E` 开头         → 网页版
 *   3. `3F` 开头         → 电脑版
 *   4. 21 位 / 32 位     → 安卓（唯一只能靠长度判的类型）
 *   5. 18 位             → 电脑版
 *   6. 其它              → unknown
 *
 * ## 为什么不用 Baileys 的严格正则
 *
 * Baileys 用 `/^3E.{20}$/`（要求 22 位）。2026-04-06 WhatsApp 改了 ID 长度
 * 但沿用了 iOS 标准（wwebjs 提交 a0ff21e），**真机实测**抓到 20 位的网页版 ID：
 *
 *   3EB0B04053AA94DD0BA334   22 位 → web ✔
 *   3EB0872294EF67F1C4EB     20 位 → 严格正则判 unknown ✘（实际是网页版）
 *
 * 长度是弱信号（WhatsApp 会改），前缀是协议层面的强信号。所以前缀优先。
 */

const test = require('node:test')
const assert = require('node:assert')

const {
  DEVICES,
  DEVICE_LABELS,
  deviceFromMessageId,
  parseDataId,
  summarizeDevices
} = require('../desktop/src/whatsapp/device-platform')

/* ---------------- 设备判据 ---------------- */

test('★ 真机抓到的两种长度都要判成网页版', () => {
  // 这是 2026-11-11 真机验证的实际样本，长度不同但都是 3E 开头
  const live22 = '3EB0B04053AA94DD0BA334'
  const live20 = '3EB0872294EF67F1C4EB'
  assert.equal(live22.length, 22)
  assert.equal(live20.length, 20)
  assert.equal(deviceFromMessageId(live22), DEVICES.WEB, '22 位网页版 ID')
  assert.equal(deviceFromMessageId(live20), DEVICES.WEB,
    '20 位网页版 ID 必须也能判出来 —— WhatsApp 2026-04 改了长度')
})

test('iPhone：3A 开头，不限长度', () => {
  assert.equal(deviceFromMessageId('3A' + 'A'.repeat(18)), DEVICES.IPHONE)
  assert.equal(deviceFromMessageId('3A' + 'A'.repeat(16)), DEVICES.IPHONE)
})

test('电脑版：3F 开头', () => {
  assert.equal(deviceFromMessageId('3F' + 'A'.repeat(18)), DEVICES.DESKTOP)
  assert.equal(deviceFromMessageId('3F' + 'A'.repeat(16)), DEVICES.DESKTOP)
})

test('安卓：21 位或 32 位（无前缀，只能靠长度）', () => {
  assert.equal(deviceFromMessageId('A'.repeat(21)), DEVICES.ANDROID)
  assert.equal(deviceFromMessageId('B'.repeat(32)), DEVICES.ANDROID)
})

test('电脑版：18 位（无 3F 前缀时的已知长度）', () => {
  assert.equal(deviceFromMessageId('2A' + 'C'.repeat(16)), DEVICES.DESKTOP)
})

test('★ 前缀优先于长度：3A 开头但 21 位仍判 iPhone', () => {
  // 旧规则会因「21 位 = 安卓」把它判成安卓。前缀是强信号，必须赢。
  const id = '3A' + 'A'.repeat(19)
  assert.equal(id.length, 21)
  assert.equal(deviceFromMessageId(id), DEVICES.IPHONE,
    '3A 前缀是协议强信号，不能被长度规则抢走')
})

test('★ 真机裸 ID 2A 开头 20 位：判不出来就是 unknown（能力边界）', () => {
  const live = '2A327AC82CD56D95E087'
  assert.equal(live.length, 20)
  assert.equal(deviceFromMessageId(live), DEVICES.UNKNOWN,
    '没有可辨识前缀、长度也不匹配 → 必须诚实返回 unknown')
})

test('认不出来一律返回 unknown，绝不抛错', () => {
  for (const bad of ['', null, undefined, '   ', 'XYZ123', '短ID', '!!!@@@']) {
    assert.equal(deviceFromMessageId(bad), DEVICES.UNKNOWN,
      '无法识别时必须返回 unknown：' + JSON.stringify(bad))
  }
})

test('每种设备都有展示文案（缺了 UI 会空白）', () => {
  for (const key of ['unknown', 'desktop', 'iphone', 'android', 'web']) {
    assert.ok(DEVICE_LABELS[key], key + ' 缺少展示文案')
    assert.notEqual(DEVICE_LABELS[key].trim(), '')
  }
})

/* ---------------- data-id 解析：两种格式 ---------------- */

test('★ 旧格式（复合串）：从右取消息 ID，jid 下划线不干扰', () => {
  const r = parseDataId('false_8613800138000@c.us_3EB0A1B2C3D4E5F6A7B8C9')
  assert.equal(r.device, DEVICES.WEB)
  assert.equal(r.msgId, '3EB0A1B2C3D4E5F6A7B8C9')
  assert.equal(r.fromMe, false)
})

test('★ 新格式（裸消息 ID）：整个值就是 ID', () => {
  const r = parseDataId('3EB0B04053AA94DD0BA334')
  assert.equal(r.device, DEVICES.WEB)
  assert.equal(r.msgId, '3EB0B04053AA94DD0BA334')
  assert.equal(r.fromMe, null, '裸 ID 里没有 fromMe，必须是 null 而不是 false')
})

test('★ 新格式：真机 20 位网页版裸 ID 要能识别出设备', () => {
  const r = parseDataId('3EB0872294EF67F1C4EB')
  assert.equal(r.msgId, '3EB0872294EF67F1C4EB')
  assert.equal(r.device, DEVICES.WEB, '这是真机样本，之前判 unknown 是 bug')
  assert.equal(r.fromMe, null)
})

test('新格式：真机 2A 开头 20 位 —— ID 有效但设备判不出', () => {
  const r = parseDataId('2A327AC82CD56D95E087')
  assert.equal(r.msgId, '2A327AC82CD56D95E087', '必须认出这是有效的消息 ID')
  assert.equal(r.device, DEVICES.UNKNOWN, '判不出设备是能力边界，不是 bug')
})

test('旧格式：自己发的消息 fromMe 为 true', () => {
  const r = parseDataId('true_8613800138000@c.us_3A7F2C1D4E5F6A7B8C9D')
  assert.equal(r.device, DEVICES.IPHONE)
  assert.equal(r.fromMe, true)
})

test('旧格式：群聊 jid 含下划线时仍取最后一段', () => {
  const r = parseDataId('false_120363012345678_abc@g.us_3EB0DEADBEEF12345678AB')
  assert.equal(r.device, DEVICES.WEB)
  assert.equal(r.msgId, '3EB0DEADBEEF12345678AB')
})

test('★ 非消息行的 data-id 必须被拒绝（聊天列表、懒加载哨兵）', () => {
  for (const junk of ['abc-def', 'has space', '中文值', 'a/b', 'x@y']) {
    const r = parseDataId(junk)
    assert.equal(r.msgId, '', '不该把非消息值当成消息 ID：' + JSON.stringify(junk))
  }
})

test('畸形输入返回 unknown 而不是崩溃', () => {
  for (const bad of ['', null, undefined, 'false_x_']) {
    const r = parseDataId(bad)
    assert.equal(r.device, DEVICES.UNKNOWN)
    assert.equal(r.msgId, '')
  }
})

/* ---------------- 汇总 ---------------- */

test('汇总：取最新一条能识别的设备，而不是出现最多的', () => {
  const messages = [
    { device: DEVICES.ANDROID },
    { device: DEVICES.ANDROID },
    { device: DEVICES.IPHONE },
    { device: DEVICES.IPHONE },
    { device: DEVICES.IPHONE }
  ]
  const r = summarizeDevices(messages)
  assert.equal(r.device, DEVICES.ANDROID, '必须取最新的安卓，不能被历史 iPhone 多数带偏')
  assert.equal(r.label, '安卓')
})

test('汇总：最新的认不出来时回退到上一条能识别的', () => {
  const r = summarizeDevices([{ device: DEVICES.UNKNOWN }, { device: DEVICES.IPHONE }])
  assert.equal(r.device, DEVICES.IPHONE)
})

test('汇总：全部认不出来时返回 unknown 且不抛错', () => {
  const r = summarizeDevices([{ device: DEVICES.UNKNOWN }, {}])
  assert.equal(r.device, DEVICES.UNKNOWN)
  assert.equal(r.label, DEVICE_LABELS.unknown)
  assert.deepEqual(r.seen, [])
})

test('汇总：seen 去重且保持从新到旧', () => {
  const r = summarizeDevices([
    { device: DEVICES.WEB },
    { device: DEVICES.IPHONE },
    { device: DEVICES.WEB }
  ])
  assert.deepEqual(r.seen, [DEVICES.WEB, DEVICES.IPHONE])
})

test('汇总：非数组输入不崩', () => {
  for (const bad of [null, undefined, {}, 'x', 0]) {
    assert.equal(summarizeDevices(bad).device, DEVICES.UNKNOWN)
  }
})
