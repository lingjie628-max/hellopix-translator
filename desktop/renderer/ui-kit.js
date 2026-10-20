/**
 * 渲染层的界面基建：显隐、浮层、确认框、提示条、收起菜单。
 *
 * ## 为什么单独一个文件
 *
 * 这几样被几乎所有其它模块调用（标签栏关窗口要确认框、清空要 toast、
 * 弹面板要让开原生视图）。它们留在 app.js 里时，任何想复用它们的模块都
 * 只能"等 app.js 加载"—— 而 app.js 是最后一个，等于谁都用不了。
 *
 * 所以这个文件必须**排在所有业务模块之前**，且只依赖 dom.js 的元素句柄。
 *
 * ## 原生视图这一层是真会咬人的
 *
 * 实例页面是原生 WebContentsView，盖在渲染层之上。所以：
 *   · 弹面板必须调 setOverlay(true) 让主进程摘掉视图，否则面板被盖住；
 *   · 提示条必须用 popover 进 top-layer，普通绝对定位同样是盖不住。
 * 这两条下面各自写了原因，改的时候别绕开。
 *
 * ★ 必须在 tabs.js / add-app.js / trans-bar.js / app.js 之前加载 ★
 */

/** 显示 / 隐藏一个元素（统一用 hidden 类，不混用 style.display）。 */
function show(el, on) {
  el.classList.toggle('hidden', !on)
}

/**
 * 是否有任何面板正开着。
 *
 * 主进程据此决定是否把实例视图整块摘掉 —— 只要有一个面板没让开，
 * 用户看到的就是"面板被页面咬掉一半"。
 */
function overlayVisible() {
  return !profile.classList.contains('hidden') ||
    !transPanel.classList.contains('hidden') ||
    !lockScreen.classList.contains('hidden') ||
    !addApp.classList.contains('hidden') ||
    !proxySettings.classList.contains('hidden') ||
    !updatePanel.classList.contains('hidden') ||
    !standalonePanel.classList.contains('hidden')
}

function syncOverlay() {
  if (window.pix && window.pix.setOverlay) window.pix.setOverlay(overlayVisible())
}

/**
 * 打开某个面板，同时关掉其它面板。
 *
 * 面板是互斥的：同时开着两个，用户会点到底下那个，行为完全不可预期。
 * 所以 on=true 时不是"只显示 el"，而是"只显示 el、其余全关"。
 */
function showOverlay(el, on) {
  if (on) {
    show(profile, el === profile)
    show(transPanel, el === transPanel)
    show(lockScreen, el === lockScreen)
    show(addApp, el === addApp)
    show(proxySettings, el === proxySettings)
    show(updatePanel, el === updatePanel)
    show(standalonePanel, el === standalonePanel)
  } else {
    show(el, false)
  }
  syncOverlay()
}

/** 点击面板背景（不是内容）就关闭。 */
function bindModalDismiss(el) {
  el.addEventListener('click', (event) => {
    if (event.target === el) showOverlay(el, false)
  })
}

/** 收起「应用操作 / 系统操作」下拉。except 用于"点自己别收自己"。 */
function closeOperationMenus(except) {
  ;[appOpsWrap, systemOpsWrap].forEach(el => {
    if (el && el !== except) el.classList.remove('open')
  })
}

/** 生成用的确认框 resolve。同一时刻只允许一个确认框。 */
let closeConfirmResolve = null

/**
 * 二次确认。
 *
 * ## 只有明确点「确认」才返回 true
 *
 * ESC、点遮罩、程序化 close() —— 任何非确认路径都落到 false。
 * 反过来写（默认 true）就等于确认框形同虚设：用户按 ESC 反而执行了危险操作。
 *
 * @param {string} title   标题
 * @param {string} text    后果说明
 * @param {string} okText  确认按钮文案
 * @returns {Promise<boolean>} 只有明确点了确认按钮才为 true
 */
function confirmAction(title, text, okText) {
  const dialog = document.getElementById('closeConfirm')
  const titleEl = document.getElementById('closeConfirmTitle')
  const textEl = document.getElementById('closeConfirmText')
  const okBtn = document.getElementById('closeConfirmOk')
  const cancelBtn = document.getElementById('closeConfirmCancel')
  if (!dialog || typeof dialog.showModal !== 'function') {
    // 环境不支持 dialog（极老内核）：宁可放行也不能把关闭功能卡死。
    return Promise.resolve(true)
  }
  titleEl.textContent = title || '确认操作？'
  textEl.textContent = text || ''
  okBtn.textContent = okText || '确认'

  // 上一个还开着就先按"取消"结掉，避免两个 Promise 悬着。
  if (closeConfirmResolve) {
    const prev = closeConfirmResolve
    closeConfirmResolve = null
    prev(false)
  }

  return new Promise(resolve => {
    const finish = answer => {
      if (closeConfirmResolve !== finish) return
      closeConfirmResolve = null
      okBtn.onclick = null
      cancelBtn.onclick = null
      dialog.oncancel = null
      dialog.onclose = null
      try { if (dialog.open) dialog.close() } catch (e) {}
      resolve(answer)
    }
    closeConfirmResolve = finish
    okBtn.onclick = () => finish(true)
    cancelBtn.onclick = () => finish(false)
    // ESC / 点遮罩：一律当作取消。对话框关掉的任何非明确确认路径都必须
    // 落到"不关"，否则就等于绕过确认。
    dialog.oncancel = event => { event.preventDefault(); finish(false) }
    dialog.onclose = () => finish(false)
    try {
      if (dialog.open) dialog.close()
      dialog.showModal()
      // 焦点显式落到取消上（autofocus 在某些内核对 dialog 不生效）
      cancelBtn.focus()
    } catch (e) {
      finish(false)
    }
  })
}

/**
 * 底部提示条。
 *
 * ## 为什么必须是 popover 而不是普通 div
 *
 * 普通定位的提示会被原生视图彻底遮住 —— 用户点了垃圾桶却什么都没看见，
 * 只会以为"点了没反应"，然后反复点。popover 进 top-layer，天然盖在原生视图之上。
 */
function toast(text, tone) {
  let el = document.getElementById('pixToast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'pixToast'
    el.className = 'pix-toast'
    el.setAttribute('popover', 'manual')
    document.body.appendChild(el)
  }
  el.textContent = text
  el.classList.toggle('warn', tone === 'warn')
  try {
    if (!el.matches(':popover-open')) el.showPopover()
  } catch (e) {}
  clearTimeout(el._timer)
  el._timer = setTimeout(() => {
    try { if (el.matches(':popover-open')) el.hidePopover() } catch (e) {}
  }, 2200)
}
