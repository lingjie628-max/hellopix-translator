/**
 * 标签栏布局：顶部一行 / 左侧竖栏。
 *
 * ## 为什么要能切
 *
 * 顶部一行在账号少的时候最好用（横向扫一排，眼睛不用动）。但账号一多就崩：
 * 25 个标签实测宽 1912px，屏幕只放得下十几个，剩下全靠拖滚动条找。
 * 竖栏一屏能看十几个，且名字可以完整显示 —— 多开用户几乎必然需要它。
 * 所以做成可选，而不是二选一硬替换：老用户升级上来看到的还是原来那样。
 *
 * ## 为什么竖栏由 CSS 全权接管
 *
 * 标签 DOM 在两种模式下**完全一样**（都是 .tab 那一套），切换到竖栏只是给
 * .stage 加一个 `tabs-side` 类，尺寸/方向/溢出方向全交给 CSS。
 * 如果在 JS 里逐个改样式，重渲染（任何状态变化都会重建标签栏）时就会
 * 一半新一半旧 —— 这类 bug 只在"切了布局又切了标签"时出现，极难复现。
 *
 * ## 依赖
 *
 * - `tabs.js` 的 `attachTabsWheel` / `syncTabsOverflowHint` 会按当前模式
 *   决定滚哪个轴，本模块只负责切换和通知它们重算；
 * - main.js 的 `TABS_SIDE_WIDTH` 与 `--tabs-side-w` 必须一致（见 styles.css）。
 */

/** 当前布局：'top' | 'side'。tabs.js / app.js 直接读它。 */
let tabLayout = 'top'

function isSideLayout() {
  return tabLayout === 'side'
}

/**
 * 把布局写到 DOM 上。
 *
 * 只动 .stage 的一个类 + 一个 dataset：不重建标签、不碰实例视图。
 * 主进程那边的视图几何由 setTabLayout 的 IPC 触发重排。
 *
 * @param {string} layout  'top' | 'side'
 * @param {boolean} [syncScroll=true] 是否顺带刷新滚动/渐隐。
 *   首帧预热时 tabs.js 还没加载（syncTabsOverflowHint 不存在），必须传 false ——
 *   否则整个脚本在顶层就抛 ReferenceError，后面的 tags 栏逻辑也不会注册。
 */
function applyTabLayout(layout, syncScroll) {
  tabLayout = layout === 'side' ? 'side' : 'top'
  const stage = document.getElementById('stage')
  if (stage) stage.classList.toggle('tabs-side', tabLayout === 'side')
  document.documentElement.setAttribute('data-tabs-layout', tabLayout)
  const button = document.getElementById('tabLayoutBtn')
  if (button) {
    button.dataset.layout = tabLayout
    button.title = tabLayout === 'side' ? '标签栏：侧面（点击切换为顶部）' : '标签栏：顶部（点击切换为侧面）'
    const text = document.getElementById('tabLayoutText')
    if (text) text.textContent = tabLayout === 'side' ? '侧面' : '顶部'
    const ico = document.getElementById('tabLayoutIco')
    if (ico) ico.textContent = tabLayout === 'side' ? '▥' : '▤'
  }
  if (syncScroll === false) return
  // 滚轮/渐隐都按轴走，切完必须立刻按新模式重算一次，
  // 否则竖栏会带着"还能往右滚"的旧状态，渐隐条乱闪。
  if (typeof syncTabsOverflowHint === 'function') syncTabsOverflowHint()
  // 竖栏里标签变窄变多，当前激活项可能已经滚出可视区。
  const state = window.__lastTabState
  if (state && typeof keepActiveTabVisible === 'function') {
    keepActiveTabVisible(state, !!(state.home || !state.activeId))
  }
}

/** 顶部 ↔ 侧面 来回切。落盘由主进程负责（config.json）。 */
async function toggleTabLayout() {
  const next = tabLayout === 'side' ? 'top' : 'side'
  applyTabLayout(next)
  // 缓存要在这里同步写：等 IPC 回来再写，用户切完立刻关窗口就会丢。
  try { localStorage.setItem('pix-tab-layout', next) } catch (e) {}
  try {
    await window.pix.setTabLayout(next)
  } catch (e) {
    /* 落盘失败不回滚：本次会话里用户的选择仍然有效，
       下次启动退回默认顶部，比当场把界面弹回去要温和。 */
  }
}

// 首帧前同步打上布局类，避免顶栏先按顶部排一遍再跳成竖栏。
// 权威值仍是主进程的 config.json（见 app.js 启动流程），这里只读缓存加速。
//
// ★ 这里必须传 syncScroll:false ★
// tabs.js 还没加载，syncTabsOverflowHint / keepActiveTabVisible 都不存在。
// 在顶层直接调用它们会让整个脚本抛 ReferenceError —— 而这个文件排在
// tabs.js 之前，一挂就连锁把后面所有模块的顶层声明都断掉（实测表现为
// app.js 整份不执行、toast 等函数全是 undefined）。
;(function preloadTabLayout() {
  let cached = ''
  try { cached = localStorage.getItem('pix-tab-layout') || '' } catch (e) {}
  applyTabLayout(cached === 'side' ? 'side' : 'top', false)
})()

;(function bindTabLayoutButton() {
  const button = document.getElementById('tabLayoutBtn')
  if (!button) return
  button.onclick = event => {
    event.stopPropagation()
    toggleTabLayout()
  }
})()
