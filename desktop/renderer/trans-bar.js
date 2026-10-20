/**
 * 聊天翻译工具条：语种、通道、字号、每条窗口的翻译开关。
 *
 * ## 一个容易骗到用户的点
 *
 * 套餐不允许自选通道时，服务端会**忽略**账号里存的通道选择
 * （见 core-service.resolveEngineId 与契约用例「界面显示的当前通道必须
 * 与实际使用的一致」）。界面若还显示账号里的旧值就等于骗人：
 * 用户看到 GPT，实际扣费走的是 DeepSeek。
 *
 * 所以这里有 authoritativeEngine：以服务端解析结果为准，只在允许切换时
 * 才回落到用户的选择。
 *
 * ## 状态
 *
 * transBar* 是本模块独占。engineRows / canSwitchEngine / authoritativeEngine
 * 由 enterShell 写入、被「新增应用」弹窗读取，属于全局共享。
 *
 * ★ 必须在 app.js 之前加载 ★
 */

let transBarInited = false
let transBarSilent = false
let transBarTabId = ''
let engineRows = []
// 套餐是否允许商户自己换通道（基础版为 false）。服务端另有强制，这里只负责不误导用户
let canSwitchEngine = true
// 服务端解析出的「实际会用的通道」。套餐不允许切换时，账号里存的选择会被
// 服务端**忽略**（见 core-service.resolveEngineId / 契约用例
// 「界面显示的当前通道必须与实际使用的一致」），界面若还显示账号里的旧值
// 就等于在骗人：用户看到 GPT，实际扣费走的是 DeepSeek。
let authoritativeEngine = ''

function barLangOptions() {
  return langOptionHtml()
}

function ensureTransBarOptions() {
  if (!transBarInited) {
    barSendFrom.innerHTML = barLangOptions()
    barSendTo.innerHTML = barLangOptions()
    barRecvFrom.innerHTML = barLangOptions()
    barRecvTo.innerHTML = barLangOptions()
    barFontSize.innerHTML = [
      [11, '小号字体'],
      [12, '12号字体'],
      [14, '中号字体'],
      [15, '15号字体'],
      [16, '16号字体'],
      [18, '大号字体'],
      [20, '20号字体'],
      [22, '特大字体'],
      [30, '极大字体']
    ].map(item => '<option value="' + item[0] + '">' + item[1] + '</option>').join('')
    transBarInited = true
  }
  barServer.innerHTML = (lineRows.length ? lineRows : [{ id: 'cn', name: '默认线路' }]).map(l => {
    return '<option value="' + esc(l.id) + '">' + esc(l.name) + '</option>'
  }).join('')
  // 没有可用通道就给空选项，不假装有个默认通道
  const engines = engineRows.length ? engineRows : [{ id: '', name: '无可用通道' }]
  barEngine.innerHTML = engines.map(e => '<option value="' + esc(e.id) + '">' + esc(e.name) + '</option>').join('')
    // 套餐固定通道时禁用下拉：能点却点了没效果，比直接禁用更让人困惑
    barEngine.disabled = !canSwitchEngine
    barEngine.title = canSwitchEngine ? '' : '当前套餐的翻译通道由系统指定'
}

let transBarPainted = false

function transBarIsOpen() {
  return !!(transBar && !transBar.classList.contains('is-collapsed'))
}

function setTransBarOpen(open, instant) {
  if (!transBar) return
  transBar.classList.remove('hidden')
  const already = transBarIsOpen()
  if (already === !!open && transBarPainted) return
  if (instant || !transBarPainted) {
    transBar.classList.add('no-anim')
    transBar.classList.toggle('is-collapsed', !open)
    void transBar.offsetHeight
    transBar.classList.remove('no-anim')
    transBarPainted = true
    // 立即上报新的占位高度，嵌入式原生视图才能跟着一起让出/收回空间
    if (typeof window.__syncPixChrome === 'function') window.__syncPixChrome()
    return
  }
  if (open) {
    transBar.classList.add('is-collapsed')
    void transBar.offsetHeight
    transBar.classList.remove('is-collapsed')
  } else {
    transBar.classList.add('is-collapsed')
  }
  transBarPainted = true
  // 报的是目标态（收起=归零），主进程自己会做缓动动画
  if (typeof window.__syncPixChrome === 'function') window.__syncPixChrome()
}

function paintTransBar(state, home, rows) {
  const tab = (rows || []).find(item => item.id === state.activeId)
  const trans = (tab && tab.trans) || {}
  const open = !home && !!tab && trans.show !== false
  setTransBarOpen(open, !transBarPainted)
  if (transBarToggle) {
    transBarToggle.classList.toggle('hidden', home || !tab)
    transBarToggle.classList.toggle('on', open)
    transBarToggle.textContent = open ? '收起翻译设置' : '打开翻译设置'
  }
  if (!tab) {
    transBarTabId = ''
    return
  }
  ensureTransBarOptions()
  transBarSilent = true
  transBarTabId = tab.id
  // try/finally：`transBarSilent` 是"回填中，别把这次赋值当成用户改动"的闸门。
  // 老实现是裸的 `= true ... = false`，只要中间任何一行抛异常（缺 DOM、值非法），
  // 闸门就永远停在 true —— 之后用户在翻译条上改的任何设置都会被 saveTransBar
  // 静默丢弃，而且不报错。真机表现就是"改了没保存"。
  try {
    barSendOn.checked = trans.enableSend !== false
    barRecvOn.checked = trans.enableRecv !== false
    barSendFrom.value = trans.sendFrom || 'auto'
    barSendTo.value = trans.sendTo || 'en'
    barRecvFrom.value = trans.recvFrom || 'auto'
    barRecvTo.value = trans.recvTo || 'zh'
    barGroupMode.value = groupModeUiValue(trans.groupMode)
    barFontSize.value = String(trans.fontSize || 15)
    if (trans.server) barServer.value = trans.server
    barFontColor.value = trans.fontColor || '#22c55e'
    barIncludeZh.checked = !!trans.includeZh
    if (trans.engine) barEngine.value = engineToShow(trans.engine)
    barQuickReply.checked = !!trans.quickReply
  } finally {
    transBarSilent = false
  }
}

function readTransBarSettings() {
  return {
    enableSendTranslate: barSendOn.checked,
    enableRecvTranslate: barRecvOn.checked,
    enableTranslate: barSendOn.checked || barRecvOn.checked,
    sendFrom: barSendFrom.value,
    sendTo: barSendTo.value,
    recvFrom: barRecvFrom.value,
    recvTo: barRecvTo.value,
    groupMode: barGroupMode.value,
    fontSize: Number(barFontSize.value) || 15,
    server: barServer.value,
    fontColor: barFontColor.value,
    includeZh: barIncludeZh.checked,
    engine: barEngine.value,
    enableQuickReply: barQuickReply.checked
  }
}

async function saveTransBar(patch) {
  if (transBarSilent || !transBarTabId) return
  try {
    await window.pix.updateTabSettings(transBarTabId, patch || readTransBarSettings())
  } catch (e) {}
}
