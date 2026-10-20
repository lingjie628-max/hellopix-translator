/**
 * 操作菜单：右上角「应用操作 / 系统操作」两个下拉的状态绘制与执行反馈。
 *
 * ## 这两个下拉最容易出状态 bug
 *
 * 它们在"主页 ↔ 应用内"之间切换时会改变可见性。历史上有过这样的坑：
 * 主页打开系统操作 → 进应用 → 回主页，菜单自己还开着（`.open` 带了
 * opacity:1 和 wrapOpen），因为退出应用时只清了 appOpsWrap 的 open、
 * 从没管过 systemOpsWrap。所以这里统一走 closeOperationMenus()。
 *
 * ## runMenuAction 的三件事
 *
 * 1. 按钮加 `.busy` 防连点（重启 / 更新这类操作连点就是灾难）；
 * 2. 立刻把文案换成"正在…"，并且**给足 10s** —— 重启进程可能真要几秒，
 *    提前改回原文案会让用户以为没生效，然后去点第二下；
 * 3. 结果不管成功失败都要把文案改回来，并把按钮从 busy 里放出来。
 *
 * ★ 依赖 dom.js 与 ui-kit.js，需排在 app.js 之前 ★
 */

/** 当前选中的那个应用的 tab 状态；没有选中或还在主页时返回 null。 */
function activeTabState() {
  const state = window.__lastTabState || {}
  return ((state.rows || []).find(tab => tab.id === state.activeId)) || null
}

/**
 * 状态条。目前恒为空 —— 曾经在这里显示"3 个窗口运行中"之类的文案，
 * 后来被顶部标签栏取代，保留函数是为了不让调用点散落判断。
 */
function paintStatus(state, home, rows) {
  show(appStatus, false)
  appStatusText.textContent = ''
}

/**
 * 按"是否在应用内"刷新操作菜单的可见性。
 *
 * @param {boolean} home 是否在主页
 * @param {Array}   rows 当前标签行；空表示没有任何打开的窗口
 */
function paintOperationMenus(home, rows) {
  const hasActiveApp = !home && !!activeTabState()
  // 应用内：工具行清空，只在正中留翻译开关；主页按钮全部保留
  const utilityEl = document.querySelector('.utility')
  if (utilityEl) utilityEl.classList.toggle('in-app', hasActiveApp)
  if (appOpsWrap) appOpsWrap.classList.toggle('hidden', !hasActiveApp)
  // 进/出应用时把两个下拉都收掉：此前只清 appOpsWrap 的 open，systemOpsWrap
  // 从不清理，实测"主页打开系统操作 → 进应用 → 回主页"后菜单自己还开着
  // （wrapOpen=true、opacity=1）。closeOperationMenus() 不带参数即关全部。
  if (!hasActiveApp) closeOperationMenus()
  if (!rows || !rows.length) closeOperationMenus()
}

/**
 * 临时把按钮文案换成 text，到点再换回原文案。
 *
 * 原文案第一次调用时记在 dataset 上，之后就一直复用 —— 否则连续 flash
 * 会把"正在重启"记成原文案，最后停在一个中间态文案上。
 */
function flashMenuButton(button, text, delay) {
  if (!button) return
  const label = button.querySelector('b')
  if (!label) return
  const original = button.dataset.originalLabel || label.textContent
  button.dataset.originalLabel = original
  label.textContent = text
  clearTimeout(button._labelTimer)
  button._labelTimer = setTimeout(() => {
    label.textContent = original
    button.classList.remove('busy', 'danger-confirm')
  }, delay || 1800)
}

/**
 * 执行一个菜单动作并把结果反馈在按钮上。
 *
 * @param {HTMLElement} button   被点的按钮
 * @param {string}      busyText 执行中的文案
 * @param {Function}    action   返回 { msg } 或抛错的异步动作
 */
async function runMenuAction(button, busyText, action) {
  if (!button || button.classList.contains('busy')) return
  button.classList.add('busy')
  flashMenuButton(button, busyText, 10000)
  try {
    const result = await action()
    flashMenuButton(button, (result && result.msg) || '操作完成', 1800)
  } catch (e) {
    flashMenuButton(button, (e && e.message) || '操作失败', 2200)
  }
}
