'use strict'

/**
 * 实例（tab）翻译偏好的解析。
 *
 * ## 为什么单独成模块
 *
 * 这里有两条**会被误判成 bug 的默认值**，值得单独用测试钉住：
 *
 * 1. 群组翻译三态。存量实例字段缺失必须当 `manual`，绝不能因为账号级
 *    `trans_group` 的库默认是 `true` 就自动打开 —— 那等于给所有老用户
 *    **打开自动扣费**。只有新建实例才拿 `inherit`。
 *
 * 2. 沉降确认窗。默认 60ms 是**最短**确认窗（正文稳定且等于译文就立刻发），
 *    不是"等满 60ms"。原先固定 500ms 占满整条发送链 100% 的客户端开销。
 *
 * 这些都是"算错了不会报错、只会静默扣钱或变慢"的地方，所以放在纯函数里，
 * 不依赖 electron，直接单测。
 */

/**
 * 群组翻译的**三态**。同一个概念有两个开关，必须说清谁说了算：
 *
 *   · 账号级「群聊自动翻译」—— 服务端 `users / sub_accounts.trans_group`，
 *     在「全局设置」里，登录后随 profile 下发；
 *   · 实例级「群组翻译」—— 顶部翻译栏那个下拉，存在 `tab.settings.groupMode`。
 *
 * 老实现只有两态（`auto` / `manual`），且让实例级**无条件覆盖**账号级
 * （`hasTab ? s.groupMode === 'auto' : g.transGroup`），而新建实例又被硬编码成
 * `manual` —— 于是"账号里/界面上开了自动、这个实例却永远不自动"，且毫无提示。
 * 真机上就表现为「群组翻译 = 自动，消息却一直不翻」，很容易被误判成
 * "自动翻译坏了"。
 *
 *   'inherit'  跟随账号级（**新建实例的默认**）
 *   'auto'     本实例强制自动
 *   'manual'   本实例强制手动
 *
 * ⚠️ **存量实例一律按 `manual` 处理（字段缺失也当 `manual`）**，绝不自动改成
 * `inherit`：账号级 `trans_group` 的库默认是 `true`（migration 003），
 * 把"没有显式选择"解释成"跟随账号"就等于给所有存量实例**打开自动扣费**。
 * 拿别人的钱做默认值是不可接受的 —— 所以只有**新建**实例才拿到 `inherit`。
 */
const GROUP_MODES = ['inherit', 'auto', 'manual']

/** 原生输入后的沉降确认窗默认下限（毫秒）。 */
const SEND_SETTLE_FLOOR_MS = 60
/** 等待上限：到点仍不稳定就换插入方式重试，再不行 fail-closed。 */
const SEND_SETTLE_CEILING_MS = 400

/**
 * 单个开关的取值。
 *
 * `enableTranslate` 是总开关：具体开关没设时跟随它（默认开）。
 */
function settingOn (settings, key) {
  const s = settings || {}
  if (s[key] !== undefined) return !!s[key]
  return s.enableTranslate !== false
}

/**
 * 群组翻译的三态。见文件头说明 —— 缺省必须是 `manual`。
 */
function groupModeOf (settings) {
  const mode = settings && settings.groupMode
  return GROUP_MODES.indexOf(mode) >= 0 ? mode : 'manual'
}

/** 实例级 + 账号级 → 这个实例最终要不要自动翻群聊。 */
function resolveGroupEnabled (settings, accountPrefs) {
  const mode = groupModeOf(settings)
  if (mode === 'auto') return true
  if (mode === 'manual') return false
  // 'inherit'：交给账号级。账号级也拿不到就按"不自动"，宁可不翻也不误扣。
  return !!(accountPrefs && accountPrefs.transGroup)
}

/** 语言值清洗：空 / auto 都回落到 fallback。 */
function pickLang (value, fallback) {
  const v = String(value || '').trim()
  if (!v || v === 'auto') return fallback
  return v
}

/** 账号级偏好（来自 profile）。 */
function accountPrefs (profile) {
  const p = profile || {}
  return {
    transRecv: p.transRecv !== 0,
    transSend: p.transSend !== 0,
    transGroup: !!Number(p.transGroup),
    langMine: p.langMine || 'zh',
    langOther: p.langOther || 'auto',
    includeZh: Number(p.includeZh) === 1,
    engine: p.activeEngine || ''
  }
}

/**
 * 某个实例最终生效的偏好。
 *
 * `hasTab` 的判据是"用户在这个实例上显式选过"（任一实例级字段存在）。
 * 没选过就整份跟随账号级 —— 否则会出现"账号开了接收翻译、新窗口却是关的"。
 */
function tabPrefs (tab, profile) {
  const g = accountPrefs(profile)
  const s = (tab && tab.settings) || {}
  const hasTab = !!(tab && tab.settings && (
    s.enableTranslate !== undefined ||
    s.enableSendTranslate !== undefined ||
    s.sendTo || s.recvTo
  ))
  return {
    transRecv: hasTab ? settingOn(s, 'enableRecvTranslate') : g.transRecv,
    transSend: hasTab ? settingOn(s, 'enableSendTranslate') : g.transSend,
    transGroup: hasTab ? resolveGroupEnabled(s, g) : g.transGroup,
    langMine: pickLang(s.recvTo, g.langMine || 'zh'),
    langOther: s.recvFrom || g.langOther || 'auto',
    sendFrom: s.sendFrom || 'auto',
    sendTo: pickLang(s.sendTo, 'en'),
    includeZh: s.includeZh !== undefined
      ? !!(s.includeZh && s.includeZh !== '0' && s.includeZh !== false)
      : g.includeZh,
    fontSize: Number(s.fontSize) || 15,
    fontColor: s.fontColor || '#22c55e',
    antiRevoke: !!s.antiRevoke,
    // 取证用：真机 trace 必须能回答"哪个窗口、哪个 partition、哪条通道"。
    // 少了这三项，一条 MANUAL_TRANSLATE_CLICK 没法定位到具体实例。
    tabId: (tab && tab.id) || '',
    partition: (tab && tab.partition) || '',
    engine: s.engine || g.engine || '',
    sendSettleMs: Number.isFinite(Number(s.sendSettleMs)) ? Number(s.sendSettleMs) : SEND_SETTLE_FLOOR_MS,
    sendSettleCeilingMs: Number.isFinite(Number(s.sendSettleCeilingMs))
      ? Number(s.sendSettleCeilingMs) : SEND_SETTLE_CEILING_MS
  }
}

module.exports = {
  GROUP_MODES,
  SEND_SETTLE_FLOOR_MS,
  SEND_SETTLE_CEILING_MS,
  settingOn,
  groupModeOf,
  resolveGroupEnabled,
  pickLang,
  accountPrefs,
  tabPrefs
}
