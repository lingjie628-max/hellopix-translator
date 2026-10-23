'use strict'

/**
 * 翻译相关 IPC。
 *
 * ## 这一组有两个不同的来源
 *
 * `translate:guestPrefs` / `composer*` / `translate:run` 的调用方是**多开窗里的
 * 客页**，不是主界面。所以它们不能走 isMainSender —— 但也不能裸奔：
 * 用 trustedTabSender 校验"这个 webContents 确实属于我们管理的某个 tab"。
 *
 * 这类 handler 在注册器里必须用 handleUnsafe 显式声明，好处是 code review
 * 时一眼能看出"这个频道允许客页调用"，而不是埋在 4000 行里靠人眼找。
 *
 * ## 翻译请求的三条铁律
 *
 * 1. 占位符（忙碌标记、emoji）绝不能进翻译接口 —— 翻出来只会污染译文
 * 2. 超长文本在本地就拒，不要送到上游去烧配额
 * 3. 网络错误不能冒充"翻译服务坏了" —— 用户会以为是我们这边的问题
 */

const MAX_TRANSLATE_CHARS = 5000

// 与服务端同一份实现（desktop/shared），避免两边规则分叉。
const { trimTrailingDot } = require('../../shared/trailing-dot')

/**
 * 把上游/网络异常归一成渲染层能识别的错误码。
 *
 * 只有"确实拿到服务端响应、但翻译失败"才算 TRANSLATE_FAILED。
 * 传输层已经分类过的（连不上 / 超时）按原码上报 —— 把网络问题说成
 * 服务故障，用户排查方向就错了。
 *
 * ## 曾经在这里错过
 *
 * 原实现读的是 `e.pix.code`，但 api-net.js 与 translation-cache.js 都是
 * 把错误码挂在 **`err.code`** 上，`err.pix` 只装取证信息（causeCode、
 * gotResponse 之类）。于是 `e.pix.code` 恒为 undefined，**所有**错误都被
 * 降级成 TRANSLATE_FAILED —— 注释承诺的"网络错误不冒充服务故障"从没生效过。
 *
 * 现在两个位置都认，以 `e.code` 优先（那才是真正的错误码）。
 */
function errorCodeOf (e) {
  if (!e) return 'TRANSLATE_FAILED'
  if (e.code) return e.code
  if (e.pix && e.pix.code) return e.pix.code
  return 'TRANSLATE_FAILED'
}

function registerTranslateIpc (deps) {
  const { reg, state, actions, env } = deps

  // ---- 主界面调用 ----

  reg.handle('translate:bridgeStatus', () => {
    const rows = []
    const tabs = state.tabs || []
    tabs.forEach(tab => {
      const st = state.bridgeHealth.get(tab.id)
      if (st && st.ok === false) rows.push({ id: tab.id, name: tab.name, reason: st.reason })
    })
    return { success: true, rows: rows }
  })

  reg.handle('translate:engines', async () => {
    try {
      return await actions.api('/translate/engines')
    } catch (e) {
      return { success: false, rows: [] }
    }
  })

  reg.handle('translate:savePrefs', async (event, payload) => {
    try {
      const data = await actions.api('/client/translate-prefs', { method: 'POST', form: payload || {} })
      const profile = state.profile
      if (profile && payload) {
        // 服务端存成功后同步本地 profile，免得下次下发还是旧值。
        // 全部走 Number() ? 1 : 0：上游存的是 0/1，混进 true/false 会让
        // 后端的 `= 1` 判断失效。
        if (payload.transRecv !== undefined) profile.transRecv = Number(payload.transRecv) ? 1 : 0
        if (payload.transSend !== undefined) profile.transSend = Number(payload.transSend) ? 1 : 0
        if (payload.transGroup !== undefined) profile.transGroup = Number(payload.transGroup) ? 1 : 0
        if (payload.langMine) profile.langMine = payload.langMine
        if (payload.langOther) profile.langOther = payload.langOther
        if (payload.includeZh !== undefined) profile.includeZh = Number(payload.includeZh) ? 1 : 0
        if (payload.engine) profile.activeEngine = payload.engine
        actions.pushGuestPrefs()
      }
      return data
    } catch (e) {
      return { success: false, msg: e.message || '保存失败' }
    }
  })

  // ---- 客页调用（handleUnsafe + trustedTabSender 自校验）----

  reg.handleUnsafe('translate:guestPrefs', event => {
    const tab = actions.trustedTabSender(event.sender)
    if (!tab) return actions.rejectUntrustedSender()
    // guest 能问到 prefs，说明 preload 真的执行到了 —— 这是"桥活着"最可靠的证据。
    // 比心跳超时可靠：心跳可能是桥挂了但定时器还在跑。
    actions.bridgeReport(tab.id, true, '')
    return env.tabPrefs(tab)
  })

  const composerTargetOf = event => {
    const tab = actions.trustedTabSender(event.sender)
    if (!tab) return { tab: null, wc: null }
    const wc = tab.view && tab.view.webContents
    if (!wc || wc.isDestroyed()) return { tab: tab, wc: null }
    return { tab: tab, wc: wc }
  }

  /**
   * composer 的**原生输入**通道。
   *
   * 真机证据（0.1.18）：expected="Test translation information."(29) vs
   * actual="测试翻译信息"(6) —— 页面内 execCommand 的写入**从未进入**
   * WhatsApp 编辑器的输入管线（它拦掉 isTrusted:false 的 beforeinput）。
   * 所以改由浏览器进程发起真实输入：这里只做 Chromium 编辑命令，不碰 DOM。
   *
   * 拆成"清空 / 插入"两步，是为了让 guest 能在两步之间回读 DOM 留证
   * （COMPOSER_CLEARED / NATIVE_TEXT_INSERTED）。
   */
  reg.handleUnsafe('translate:composerSelectAllDelete', event => {
    const { tab, wc } = composerTargetOf(event)
    if (!tab) return actions.rejectUntrustedSender()
    if (!wc) return { ok: false, reason: 'NO_WEB_CONTENTS' }
    const res = actions.nativeComposer.selectAllAndClear(wc)
    actions.log('native-input', '实例 ' + tab.id + ' COMPOSER_CLEARED ok=' + res.ok +
      (res.ok ? '' : ' reason=' + res.reason) + ' focused=' + res.focused)
    return res
  })

  reg.handleUnsafe('translate:composerInsertText', (event, payload) => {
    const { tab, wc } = composerTargetOf(event)
    if (!tab) return actions.rejectUntrustedSender()
    if (!wc) return { ok: false, reason: 'NO_WEB_CONTENTS' }
    const text = String((payload && payload.text) || '')
    // 逐行模式：只在前一种写法的换行结构没对上时由 guest 显式要求
    const linewise = !!(payload && payload.linewise)
    const res = linewise
      ? actions.nativeComposer.insertTextLines(wc, text)
      : actions.nativeComposer.insertText(wc, text)
    actions.log('native-input', '实例 ' + tab.id + ' NATIVE_TEXT_INSERTED chars=' + text.length +
      ' ok=' + res.ok + (linewise ? ' linewise=1' : '') +
      (res.ok ? '' : ' reason=' + res.reason))
    return res
  })

  reg.handleUnsafe('translate:run', async (event, payload) => {
    const tab = actions.trustedTabSender(event.sender)
    if (!tab) return actions.rejectUntrustedSender()
    const p = payload || {}
    const raw = String(p.text || '').trim()
    if (raw.length > MAX_TRANSLATE_CHARS) {
      return { success: false, msg: '单次翻译最多 ' + MAX_TRANSLATE_CHARS + ' 个字符' }
    }
    // 占位符绝不能进翻译接口：它是我们自己的状态，翻出来只会污染译文。
    const text = env.stripEmoji(env.stripBusyMarks(raw))
    if (!text) return { success: true, translation: '', skipped: 'busy' }

    const s = (tab && tab.settings) || {}
    const profile = state.profile
    const incoming = !!p.incoming
    const to = incoming
      ? env.pickLang(s.recvTo, (profile && profile.langMine) || 'zh')
      : env.pickLang(s.sendTo, 'en')
    const from = incoming ? (s.recvFrom || 'auto') : (s.sendFrom || 'auto')
    const engine = s.engine || (profile && profile.activeEngine) || ''
    // 调用来源，一路带到服务端落进 translate_logs.trigger。
    // 出异常字符消耗时，靠它区分"用户点了译"和"扫描时自动翻"。
    const trigger = String(p.trigger || '').trim()

    // 真机取证用：把**实际送给上游**的 source_text 记进客户端日志。
    // 排查"译文里混进 UI 文案"这类问题时，没有这一行只能靠猜。
    actions.log('translate', 'source_text=' + JSON.stringify(text) +
      ' · from=' + from + ' to=' + to + ' engine=' + engine + ' dir=' + (incoming ? 'in' : 'out') +
      ' trigger=' + (trigger || '-'))

    const hit = actions.getTransCached(from, to, engine, text)
    if (hit) {
      // 本地缓存兜底：句点清理上线前存进去的旧译文还是带点的版本。
      // 不清一次的话，这些句子会**永远**命中旧缓存，用户以为没修好。
      // 清理后再写回缓存，下次命中就干净了。
      const cleaned = trimTrailingDot(text, hit)
      if (cleaned !== hit) actions.putTransCached(from, to, engine, text, cleaned)
      return { success: true, translation: cleaned, cached: true }
    }

    try {
      // requestTranslate 内部处理"上一轮请求号已终结"：换号重发一次再返回。
      // 这条路径不吞错 —— 服务端的 {success:false, code, msg} 原样上抛，
      // 由 guest-inject 的 notifyTranslateIssue() 显示成人话。
      const data = await actions.requestTranslate(text, from, to, engine, trigger)
      // 服务端已经清过句点，这里再兜一次是为了防御**旧服务端**：
      // 用户可能连着还没升级的后端，或者请求打到了缓存中间层。
      // 客户端多删一次的成本是零（幂等），代价远小于把带点的译文写进本地缓存。
      const out = trimTrailingDot(text, String((data && (data.translation || data.text)) || '').trim())
      if (data && data.success && out) {
        actions.putTransCached(from, to, engine, text, out)
        // 反向缓存：把译文按"反过来翻"的键存一份。回译时直接命中，
        // 省一次请求（这是缓存里唯一允许的方向性特例）。
        if (out !== text) actions.putTransCached('auto', from === 'auto' ? 'zh' : from, engine, out, text)
      }
      // 把这次实际使用的幂等号带回渲染层：真机取证要求 trace 里能看到
      // requestId，才能分清"同一次动作内的重发（复用幂等号）"和
      // "用户再次点击（新号）"。
      if (data && typeof data === 'object') {
        try { data.requestId = actions.transRequestId(text, from, to, engine) } catch (e) {}
      }
      // ★ 必须把清理后的 out 写回 data.translation ★
      //
      // 踩过的坑：上面算了 out、也写进了缓存，但这里直接 `return data`，
      // 渲染层拿到的还是服务端原始响应 —— 缓存干净、屏幕上有句点，
      // 两边不一致，而且看起来像"服务端修了客户端没修"。
      // 单测（translate-dot-cache.test.js）就是从这里抓到的。
      if (data && typeof data === 'object' && data.translation !== undefined && out) {
        data.translation = out
      }
      return data
    } catch (e) {
      return { success: false, code: errorCodeOf(e), msg: (e && e.message) || '翻译失败' }
    }
  })
}

module.exports = { registerTranslateIpc, errorCodeOf, MAX_TRANSLATE_CHARS }
