'use strict'

/**
 * 从 WhatsApp 消息 ID 判断**发送设备**。
 *
 * ## 这个信息是真的，不是猜的
 *
 * WhatsApp 每条消息的 ID 是服务端生成的，**前缀编码了发送方设备类型**。
 * 这是协议层面的既有事实，不是我们推断出来的：
 *
 *   · 安卓   —— ID 长度 > 21 个字符（随机串更长）
 *   · iPhone —— 以 "3A" 开头
 *   · 网页版 —— 以 "3EB0" 开头
 *
 * 规则来源：Baileys（WhatsApp Web 协议实现）与 wppconnect 的
 * `getPlatformFromMessage`，两者一致。见
 * https://github.com/wppconnect-team/wa-js/blob/main/src/chat/functions/getPlatformFromMessage.ts
 *
 * ## 只能知道「发出这条消息时用的设备」
 *
 * presence（在线状态）里**没有**设备字段，WhatsApp 服务端不广播。
 * 所以任何声称"对方此刻用什么设备在线"的功能，只要它做的是 WhatsApp，
 * 就只能是编的。我们能给的是：「这个联系人最近用 iPhone 发消息」——
 * 这个经得起验证。
 *
 * ## 必须可降级
 *
 * 这些前缀是逆向出来的私有格式，不是公开 API。WhatsApp 哪天改了，
 * 这里就会开始返回 'unknown'。所以调用方必须能接受 'unknown' 并正常显示，
 * 绝不能因为识别不出来就报错或空白。
 */

/** 设备类型的稳定标识（会写进 UI 与埋点，改它等于改协议）。 */
const DEVICES = {
  ANDROID: 'android',
  IPHONE: 'iphone',
  DESKTOP: 'desktop',
  WEB: 'web',
  UNKNOWN: 'unknown'
}

/** 展示用文案。`unknown` 必须有兜底文案，不能显示成空白。 */
const DEVICE_LABELS = {
  android: '安卓',
  iphone: 'iPhone',
  desktop: '电脑版',
  web: '网页版',
  unknown: '未知设备'
}

/**
 * 从**裸消息 ID**（不含 jid、不含 fromMe 前缀）判断设备。
 *
 * ## 判据：前缀优先，长度兜底
 *
 * 前缀是强信号，长度是弱信号。2026-04-06 起 WhatsApp **改了 ID 长度**
 * 但**沿用了 iOS 的长度标准**（wwebjs 提交 a0ff21e：
 * "Whatsapp increased the number of characters in IDs, but followed
 * the IOS standard"）。真机抓到的实际样本：
 *
 *   3EB0B04053AA94DD0BA334   22 位  ← 老标准
 *   3EB0872294EF67F1C4EB     20 位  ← 新标准（同为网页版！）
 *
 * 如果把长度写死在正则里（Baileys 的 /^3E.{20}$/），新格式的 20 位
 * 网页版 ID 会全被判成 unknown —— 这是实测踩到的坑。
 *
 * ## 判定顺序
 *
 *   1. `3A` 开头            → iPhone    （前缀强信号）
 *   2. `3E` 开头            → 网页版     （前缀强信号，长度不管）
 *   3. `3F` 开头 / 18 位    → 电脑版
 *   4. 21 位 / 32 位        → 安卓      （唯一只能靠长度判的类型）
 *   5. 其它                  → unknown
 *
 * 为什么安卓放最后：安卓 ID 是纯随机串，没有可辨识前缀，只能靠长度。
 * 而 21/32 位这个长度不会和 3A/3E/3F 的前缀冲突（那三种长度是 20/22）。
 *
 * 为什么不严格按 Baileys 的正则：它假设长度不变，已经被 WhatsApp
 * 的改版打穿了。宁可放宽到"前缀对就算"，因为前缀才是协议层面的信号。
 *
 * @param {string} msgId 例如 "3EB0B04053AA94DD0BA334" 或 "3EB0872294EF67F1C4EB"
 * @returns {'android'|'iphone'|'desktop'|'web'|'unknown'}
 */
function deviceFromMessageId (msgId) {
  const id = String(msgId == null ? '' : msgId).trim()
  if (!id) return DEVICES.UNKNOWN
  // 前缀优先：这是协议层面的强信号，不受 WhatsApp 改长度影响
  if (id.startsWith('3A')) return DEVICES.IPHONE
  if (id.startsWith('3E')) return DEVICES.WEB
  if (id.startsWith('3F')) return DEVICES.DESKTOP
  // 长度兜底：安卓是纯随机串没有前缀，只能按长度判
  if (/^(.{21}|.{32})$/.test(id)) return DEVICES.ANDROID
  // 18 位是桌面版的另一个已知长度
  if (id.length === 18) return DEVICES.DESKTOP
  return DEVICES.UNKNOWN
}

/**
 * 从消息节点的 `data-id` 属性判断设备。
 *
 * ## 必须同时支持两种格式（2026-11-11 实测确认）
 *
 * **旧格式**（WhatsApp Web 2026-04 之前）—— 复合串：
 *   `false_8613800138000@c.us_3EB0A1B2C3D4E5F6A7B8`
 *     ↑fromMe  ↑jid                  ↑真正的消息 ID
 *
 * **当前格式**（2026-04-30 起实测）—— **裸消息 ID**，没有下划线：
 *   `2A327AC82CD56D95E087`
 *
 * 证据：对 WhatsApp DOM 做 CDP 抓取的开源实现
 * （openhuman/app/src-tauri/src/whatsapp_scanner/dom_snapshot.rs）注释里
 * 明确记录了这个变化，并保留了两种格式的解析分支。
 *
 * ## fromMe 在新格式里拿不到
 *
 * 裸 ID 里没有 fromMe 信息。调用方（页面侧）改用消息气泡的
 * `message-in` / `message-out` class 判断，不能用这个字段。
 *
 * @param {string} dataId DOM 属性原值
 * @returns {{device: string, msgId: string, fromMe: boolean|null}}
 *          `fromMe` 为 null 表示该格式下无法判断
 */
function parseDataId (dataId) {
  const raw = String(dataId == null ? '' : dataId).trim()
  const empty = { device: DEVICES.UNKNOWN, msgId: '', fromMe: null }
  if (!raw) return empty

  const cut = raw.lastIndexOf('_')

  // ---- 旧格式：复合串，最后一段是消息 ID ----
  if (cut >= 0) {
    const msgId = raw.slice(cut + 1)
    if (!msgId) return empty
    return {
      device: deviceFromMessageId(msgId),
      msgId,
      // 前缀是 "true" / "false"；大小写可能有差异，统一小写比较。
      fromMe: raw.slice(0, cut).toLowerCase().indexOf('true') === 0
    }
  }

  // ---- 新格式：整个值就是裸消息 ID ----
  // 但要用字符集过滤：聊天列表行、懒加载哨兵等也带 data-id，
  // 它们的值不是消息 ID。只接受 ASCII 字母数字。
  if (!/^[0-9A-Za-z]+$/.test(raw)) return empty

  return {
    device: deviceFromMessageId(raw),
    msgId: raw,
    fromMe: null
  }
}

/**
 * 汇总一批消息，得出「这个联系人最近用什么设备」。
 *
 * 规则：按传入顺序**从新到旧**，取第一条能识别出设备的。
 * 传入顺序由调用方保证（DOM 里消息是渲染顺序，调用方负责反转）。
 *
 * 为什么要"最近一条能识别的"，而不是"统计出现最多的"：
 * 用户想知道的是"他现在用什么"，不是"他历史上用过什么"。
 * 一个人从 iPhone 换成安卓，少数服从多数会给出错误的当下结论。
 *
 * @param {Array<{device: string}>} messages 从新到旧
 * @returns {{device: string, label: string, seen: string[]}}
 */
function summarizeDevices (messages) {
  const list = Array.isArray(messages) ? messages : []
  const seenSet = new Set()
  let latest = DEVICES.UNKNOWN

  for (const item of list) {
    const device = item && item.device
    if (!device || device === DEVICES.UNKNOWN) continue
    seenSet.add(device)
    if (latest === DEVICES.UNKNOWN) latest = device
  }

  return {
    device: latest,
    label: DEVICE_LABELS[latest] || DEVICE_LABELS.unknown,
    // 历史用过哪些（用于悬停提示）。顺序 = 从新到旧首次出现。
    seen: Array.from(seenSet)
  }
}

module.exports = {
  DEVICES,
  DEVICE_LABELS,
  deviceFromMessageId,
  parseDataId,
  summarizeDevices
}
