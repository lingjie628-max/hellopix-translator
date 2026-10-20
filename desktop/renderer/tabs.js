/**
 * 顶部标签栏：渲染、拖拽排序、重命名、横向滚轮、溢出提示。
 *
 * ## 这里踩过的坑（都写在对应函数上方）
 *
 *   · 滚轮横向滚动：浏览器只在纵向也溢出时才映射垂直滚轮，所以必须自己接；
 *   · 激活标签必须滚进可视区：否则用户"新建了却看不见"，观感是点了没反应；
 *   · 拖拽只做相邻插入，不做自由定位；
 *   · 「后台运行中」抽屉必须是常驻入口 —— 藏完找不回来的代价太大。
 *
 * ## 依赖
 *
 * 依赖 app.js 里的全局状态（lastTabs / selectedId / editingTabId / checkedIds），
 * 它们由 app.js 维护，这里只读或就地改。dragTabId 是本模块独占的。
 *
 * ★ 必须在 app.js 之前加载 ★
 */

function confirmCloseTab(tab) {
  const name = String((tab && (tab.name || tab.title)) || '这个窗口')
  return confirmAction(
    '关闭「' + name + '」？',
    '窗口将停止运行，需要重新登录才能再次打开。若只是想让它歇着，可以用右键菜单里的「隐藏该窗口」，登录状态会保留。',
    '关闭窗口'
  )
}

function makeTabEl(tab, active) {
  const el = document.createElement('div')
  el.className = 'tab' + (active ? ' active' : '')
  // 右键「重命名」由主进程菜单发起，回到渲染层要按 id 找回这个节点。
  el.dataset.tabId = tab.id
  // 翻译桥没起来 = 这个窗口的翻译整体失效。侧边栏必须一眼能看出来 ——
  // 让它长得和正常窗口一样，正是 0.1.12 能把用户坑到底的原因。
  if (tab.bridgeDown) {
    el.classList.add('bridge-down')
    el.title = '翻译组件未启动：此窗口的发送/接收翻译都不会生效，请重启 Hello Pix'
  }
  const name = tabLabel(tab)
  const unread = Number(tab.unread) || 0
  const badge = unread > 0
    ? '<span class="tab-unread" title="' + unread + ' 条未读消息">' + (unread > 99 ? '99+' : unread) + '</span>'
    : ''
  el.innerHTML = '<span class="tab-icon-wrap">' + iconTag(tab.platform, 'tab-icon', tab.icon) + badge + '</span>' +
    (name ? '<span class="tab-name" title="' + esc(name) + '">' + esc(name) + '</span>' : '') +
    (tab.bridgeDown ? '<span class="tab-warn" title="翻译组件未启动">⚠</span>' : '') +
    '<span class="x" title="关闭">×</span>'
  el.onclick = () => window.pix.switchTab(tab.id)
  el.oncontextmenu = event => showPixContextMenu(event, tab)
  const nameEl = el.querySelector('.tab-name')
  if (nameEl) {
    nameEl.ondblclick = event => {
      event.preventDefault()
      event.stopPropagation()
      startTabRename(tab, el)
    }
  }
  el.querySelector('.x').onclick = async (event) => {
    event.stopPropagation()
    // 二次确认：× 紧贴账号名，误点一次就要重新扫码，代价太大。
    if (!(await confirmCloseTab(tab))) return
    window.pix.close(tab.id)
  }
  attachTabDrag(el, tab)
  return el
}

/**
 * 「后台运行中」入口：标签栏最右边的抽屉按钮。
 *
 * ## 为什么必须有这个入口
 *
 * 隐藏窗口最大的风险是**藏完找不回来**（见 background-mode.js 里对
 * "僵尸进程"的论证）。所以隐藏功能配一个常驻、显眼的恢复入口是硬要求，
 * 不能指望用户记得"要在右键菜单里找"。
 *
 * 用原生 popover：点击外面任意处自动关闭，不用手写外部点击监听
 * （手写的那种很容易在切标签、窗口缩放时漏关，留下一个浮着的面板）。
 */
function makeHiddenTrayEl(hiddenRows) {
  const wrap = document.createElement('div')
  wrap.className = 'tab tab-hidden-tray'
  wrap.title = hiddenRows.length + ' 个窗口在后台运行（收消息但不会提醒）'
  wrap.innerHTML = '<span class="tab-tray-icon">▤</span><span class="tab-tray-count">' + hiddenRows.length + '</span>'
  wrap.oncontextmenu = event => event.preventDefault()
  wrap.id = 'hiddenTrayBtn'

  let panel = document.getElementById('hiddenTrayPanel')
  if (!panel) {
    panel = document.createElement('div')
    panel.id = 'hiddenTrayPanel'
    panel.className = 'hidden-tray-panel'
    panel.popover = 'manual'
    document.body.appendChild(panel)
  }
  panel.innerHTML = '<div class="hidden-tray-head">后台运行中</div>' +
    '<div class="hidden-tray-hint">这些窗口仍在后台挂着，不会提醒新消息，点一下即可恢复</div>' +
    hiddenRows.map(tab =>
      '<button type="button" class="hidden-tray-row" data-show-id="' + esc(tab.id) + '">' +
      iconTag(tab.platform, 'hidden-tray-icon', tab.icon) +
      '<span class="hidden-tray-name">' + esc(enabledName(tab)) + '</span>' +
      '<span class="hidden-tray-open">显示</span>' +
      '</button>').join('')

  wrap.onclick = event => {
    event.stopPropagation()
    if (!panel || typeof panel.showPopover !== 'function') return
    try {
      if (panel.matches(':popover-open')) panel.hidePopover()
      else panel.showPopover()
    } catch (e) {}
  }
  panel.querySelectorAll('[data-show-id]').forEach(button => {
    button.onclick = async event => {
      event.stopPropagation()
      const id = button.dataset.showId
      // 先收面板再恢复：恢复会重建标签栏，面板留着会挡在新窗口上。
      try { if (panel.matches(':popover-open')) panel.hidePopover() } catch (e) {}
      await window.pix.showHiddenTab(id)
    }
  })
  return wrap
}

/**
 * 标签拖拽排序。
 *
 * ## 为什么只做"相邻插入"而不是自由拖放到任意像素位置
 *
 * 标签是等宽固定宽度、没有层级关系的平铺列表，插入语义就够用了：
 * 拖到某个标签的左/右半边 → 插到它前面/后面。自由定位还要处理空隙动画、
 * 滚动跟随、跨行，成本高而收益为零。
 *
 * ## 三个必须处理的坑
 *
 * 1. **dragover 必须 preventDefault**，否则 drop 根本不会触发（HTML5 规定）。
 * 2. **不能把 home / 右侧分组当作普通目标**：左侧分组拖到右侧会打乱
 *    `alignRight` 的语义（右侧组本身是靠 settings 渲染出来的，不参与顺序）。
 *    所以只在同一个分组内允许互换。
 * 3. **拖动过程中重渲染会把 DOM 换掉**，drag 事件链就断了。所以拖动期间
 *    只改 class 做视觉提示，松手（drop/dragend）才真正提交并重渲染。
 */
let dragTabId = ''

function attachTabDrag(el, tab) {
  el.draggable = true
  el.addEventListener('dragstart', event => {
    if (editingTabId) { event.preventDefault(); return }
    dragTabId = tab.id
    el.classList.add('dragging')
    try {
      event.dataTransfer.effectAllowed = 'move'
      // Firefox/Safari 没有 setData 就不会真正开始拖动。
      event.dataTransfer.setData('text/plain', tab.id)
    } catch (e) {}
  })
  el.addEventListener('dragend', () => {
    dragTabId = ''
    clearTabDropHint()
    tabsEl.querySelectorAll('.tab.dragging').forEach(node => node.classList.remove('dragging'))
  })
  el.addEventListener('dragover', event => {
    if (!dragTabId || dragTabId === tab.id) return
    const source = findTabRow(dragTabId)
    if (!source || !!source.alignRight !== !!tab.alignRight) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = el.getBoundingClientRect()
    const before = event.clientX < rect.left + rect.width / 2
    clearTabDropHint()
    el.classList.add(before ? 'drop-before' : 'drop-after')
  })
  el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'))
  el.addEventListener('drop', async event => {
    if (!dragTabId || dragTabId === tab.id) return
    event.preventDefault()
    event.stopPropagation()
    // dragover 已经拒绝过跨分组（不发 preventDefault），但某些环境下
    // drop 仍会触发 —— 这里必须再校验一次，否则会提交一个本来被拒的排序。
    const source = findTabRow(dragTabId)
    if (!source || !!source.alignRight !== !!tab.alignRight) { dragTabId = ''; clearTabDropHint(); return }
    const rect = el.getBoundingClientRect()
    const before = event.clientX < rect.left + rect.width / 2
    const moved = dragTabId
    dragTabId = ''
    clearTabDropHint()
    try { await window.pix.reorderTabs(moved, tab.id, before) } catch (e) {}
  })
}

function findTabRow(id) {
  const state = window.__lastTabState
  const rows = (state && state.rows) || []
  return rows.find(row => row.id === id) || null
}

/** 当前激活窗口那一行；主页态返回 null（主页没有可改的名字）。 */
function activeTabRow() {
  const state = window.__lastTabState
  if (!state || state.home || !state.activeId) return null
  return findTabRow(state.activeId)
}

function clearTabDropHint() {
  if (!tabsEl) return
  tabsEl.querySelectorAll('.tab.drop-before, .tab.drop-after')
    .forEach(node => node.classList.remove('drop-before', 'drop-after'))
}

/**
 * 拖到主页上 = 挪到最前面。
 *
 * 主页固定在首位、不参与排序，所以它天然是最稳的"拖到开头"落点：
 * 比拖到第一个标签的左半边更好命中（第一个标签太窄，手一抖就掉到右半边）。
 */
function attachHomeDropTarget(homeTab) {
  homeTab.addEventListener('dragover', event => {
    if (!dragTabId) return
    const source = findTabRow(dragTabId)
    if (!source || source.alignRight) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    clearTabDropHint()
    homeTab.classList.add('drop-after')
  })
  homeTab.addEventListener('dragleave', () => homeTab.classList.remove('drop-after'))
  homeTab.addEventListener('drop', async event => {
    if (!dragTabId) return
    event.preventDefault()
    event.stopPropagation()
    const moved = dragTabId
    dragTabId = ''
    homeTab.classList.remove('drop-after')
    try { await window.pix.reorderTabs(moved, 'home', false) } catch (e) {}
  })
}

function renderTabs(state) {
  window.__lastTabState = state
  const rows = (state && state.rows) || []
  // 全部窗口都被隐藏时也是"没有可见窗口"，应回主页 —— 否则界面停在一块空视图上。
  const anyVisible = rows.some(tab => !tab.hidden)
  const home = !anyVisible || !!(state && state.home)
  if (editingTabId && tabsEl.querySelector('.tab-name-input')) {
    show(emptyEl, home)
    paintStatus(state, home, rows)
    paintTransBar(state, home, rows)
    paintOperationMenus(home, rows)
    fillEnabled(rows)
    syncHomeVideo(home)
    return
  }
  tabsEl.innerHTML = ''
  const homeTab = document.createElement('div')
  homeTab.className = 'tab tab-home' + (home ? ' active' : '')
  homeTab.innerHTML = '<img class="tab-home-logo" src="icon.png" alt=""><span class="tab-name">主页</span>'
  homeTab.onclick = () => window.pix.home()
  homeTab.oncontextmenu = event => showPixContextMenu(event, null)
  attachHomeDropTarget(homeTab)
  tabsEl.appendChild(homeTab)
  // 隐藏的窗口不渲染成标签（它已经"不在标签栏上"了），单独挂一个入口。
  const visibleRows = rows.filter(tab => !tab.hidden)
  const hiddenRows = rows.filter(tab => tab.hidden)
  const left = visibleRows.filter(tab => !tab.alignRight)
  const right = visibleRows.filter(tab => tab.alignRight)
  left.forEach(tab => tabsEl.appendChild(makeTabEl(tab, !home && tab.id === state.activeId)))
  if (right.length) {
    const spacer = document.createElement('div')
    spacer.className = 'tab-spacer'
    tabsEl.appendChild(spacer)
    right.forEach(tab => tabsEl.appendChild(makeTabEl(tab, !home && tab.id === state.activeId)))
  }
  if (hiddenRows.length) tabsEl.appendChild(makeHiddenTrayEl(hiddenRows))
  show(emptyEl, home)
  paintStatus(state, home, rows)
  paintTransBar(state, home, rows)
  paintOperationMenus(home, rows)
  fillEnabled(rows)
  Object.keys(checkedIds).forEach(id => {
    if (!rows.find(tab => tab.id === id)) delete checkedIds[id]
  })
  syncHomeVideo(home)
  keepActiveTabVisible(state, home)
}

/**
 * 保证**当前激活的标签**始终在可视范围内。
 *
 * ## 为什么必须有
 *
 * 标签栏 overflow-x:auto，开十几个窗口后新标签排在右边、视口却停在最左。
 * 用户点了「新建」，新窗口其实已经开了，但顶栏里看不见 —— 观感就是
 * 「点了没反应 / 界面被无限拉长」。
 *
 * ## 为什么只滚"激活项"而不是每次都滚到最右
 *
 * 重建标签栏是高频操作（任何状态变化都会触发）。若无条件滚到末尾，
 * 用户手动往回翻看其它窗口时会被一次次拽回右边，非常烦人。
 * 只跟随激活项：切换/新建时自然跟过去，浏览时保持原地。
 */
function keepActiveTabVisible(state, home) {
  if (!tabsEl) return
  const target = home
    ? tabsEl.querySelector('.tab-home')
    : (state && state.activeId ? tabsEl.querySelector('.tab.active') : null)
  if (target && typeof target.offsetLeft === 'number') {
    const left = target.offsetLeft
    const right = left + target.offsetWidth
    const viewLeft = tabsEl.scrollLeft
    const viewRight = viewLeft + tabsEl.clientWidth
    // 已经在可视区内就不动，避免每次渲染都产生抖动。
    if (left < viewLeft || right > viewRight) {
      const next = left < viewLeft ? left - 8 : right - tabsEl.clientWidth + 8
      try {
        tabsEl.scrollTo({ left: Math.max(0, next), behavior: 'smooth' })
      } catch (e) {
        tabsEl.scrollLeft = Math.max(0, next)
      }
    }
  }
  // 无论是否滚动，都要刷新两侧渐隐 —— 增删标签也会改变是否溢出。
  syncTabsOverflowHint()
}

/**
 * 根据当前滚动位置切换两侧渐隐提示。
 *
 * 滚动条只在溢出时出现，但用户未必第一眼注意到 —— 两侧渐隐是更直观的
 * "后面还有"信号。必须精确：滚到最左就没有左渐隐，滚到最右就没有右渐隐，
 * 否则用户会以为"还有"却滚不动，比没有提示更糟。
 */
function syncTabsOverflowHint() {
  if (!tabsEl || !tabsWrapEl) return
  const maxScroll = tabsEl.scrollWidth - tabsEl.clientWidth
  const x = tabsEl.scrollLeft
  // 1px 容差：缩放/小数像素下 scrollLeft 常是 1399 而非 1400。
  tabsWrapEl.classList.toggle('has-more-left', maxScroll > 1 && x > 1)
  tabsWrapEl.classList.toggle('has-more-right', maxScroll > 1 && x < maxScroll - 1)
}

/**
 * 让鼠标滚轮能横向滚动标签栏。
 *
 * ## 为什么要自己接
 *
 * `.tabs` 是 `overflow-x: auto` 的横向容器。浏览器**只有在容器纵向也溢出时**
 * 才会把垂直滚轮映射到横向；这里纵向根本不溢出，于是滚轮完全无效 ——
 * 用户只能去拖那条细滚动条。真实反馈就是"滚轮没用，必须手动拉"。
 *
 * ## 规则
 *
 * - 垂直滚轮（鼠标最常见）→ 转成横向滚动。
 * - 触控板横向滑动（deltaX 为主）→ 原样放行，别干预，否则手感会打架。
 * - 已经滚到两端 → **不拦**，把滚动让给外层（否则会出现"滚到底了
 *   整页也卡住"的死手感）。
 * - 按住 Shift 时浏览器本来就会横向滚，交给默认行为。
 *
 * 用非 passive 监听：必须 preventDefault 才能阻止页面跟着上下抖。
 */
function attachTabsWheel() {
  if (!tabsEl || tabsEl._wheelBound) return
  tabsEl._wheelBound = true

  // 触控板会连续发大量 wheel 事件，且带惯性。直接 1:1 映射会"嗖"地滚过去，
  // 找不到想点的标签。这里做两件事：
  //   1. 按 deltaMode 归一化成像素（Firefox 用行模式，一次 deltaY=3 行）；
  //   2. 保留原始增量但乘一个系数 —— 手感要接近"滚一下动一格标签"（约 76px）。
  const LINE_HEIGHT = 16
  const multiplier = event => {
    const mode = event.deltaMode
    // DOM_DELTA_LINE = 1（行），DOM_DELTA_PAGE = 2（页）
    if (mode === 1) return LINE_HEIGHT
    if (mode === 2) return tabsEl.clientWidth
    return 1
  }

  tabsEl.addEventListener('wheel', event => {
    // Shift + 滚轮 = 浏览器默认的横向滚动，别抢。
    if (event.shiftKey) return
    // 有横向增量说明是触控板横向手势，放行给默认行为。
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return

    const maxScroll = tabsEl.scrollWidth - tabsEl.clientWidth
    // 没有溢出：完全不拦，让外层去处理（比如主页的滚轮）。
    if (maxScroll <= 1) return

    const step = event.deltaY * multiplier(event)
    const next = Math.max(0, Math.min(maxScroll, tabsEl.scrollLeft + step))
    // 已经贴边且继续往同方向滚：放行，不做无意义的 preventDefault。
    if (next === tabsEl.scrollLeft) return

    event.preventDefault()
    tabsEl.scrollLeft = next
    // 滚动后立刻刷新两侧渐隐，否则提示图标要等到下一次渲染才更新。
    syncTabsOverflowHint()
  }, { passive: false })
}

if (tabsEl) {
  tabsEl.addEventListener('scroll', syncTabsOverflowHint, { passive: true })
  // 窗口缩放会改变可视宽度 → 是否溢出随之变化。
  window.addEventListener('resize', syncTabsOverflowHint)
}
