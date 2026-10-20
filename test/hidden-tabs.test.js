const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const root = path.join(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
const hiddenSrc = fs.readFileSync(path.join(root, 'desktop', 'src/window/hidden-tabs.js'), 'utf8')
const rendererSrc = require('./helpers/renderer-src')
const appSrc = rendererSrc.all()

const hidden = require('../desktop/src/window/hidden-tabs')

function extract(src, name) {
  const at = src.indexOf('function ' + name + '(')
  assert.ok(at >= 0, '找不到 ' + name)
  // 按花括号配平截取整个函数体，而不是停在第一个 '}' ——
  // 函数里只要有 if/for/回调，第一个 '}' 就只是内层块的结尾。
  let depth = 0
  const start = src.indexOf('{', at)
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(at, i + 1)
    }
  }
  throw new Error('未闭合：' + name)
}

test('隐藏 = 不提醒：未读数不上报，角标不计入', () => {
  assert.equal(hidden.shouldNotifyWhenHidden(), false)
  // 关键契约：这个函数永远返回 false。返回 true 就是"隐藏了还在提醒"。
  assert.ok(/shouldNotifyWhenHidden\(\)/.test(mainSrc), 'main.js 必须真的用这个开关')
})

test('隐藏计划：摘视图 + 节流 + 静音 + 停未读；正在加载才停载', () => {
  assert.deepEqual(hidden.hidePlan({}), ['detach', 'throttle', 'mute', 'stopUnread'])
  assert.deepEqual(hidden.hidePlan({ loading: true }), ['detach', 'throttle', 'mute', 'stopUnread', 'stopLoading'])
  // 幂等：连点两次得到同一份计划，不会叠加出别的状态
  assert.deepEqual(hidden.hidePlan({ loading: true }), hidden.hidePlan({ loading: true }))
})

test('backgroundThrottling 必须是 true —— 写 false 会让隐藏窗口后台空转', () => {
  // 实测：false 时隐藏窗口 2 秒触发定时器 20 次（跑满）；true 时只有 2 次。
  // 而可见时两者都是 20 次，所以 true 不牺牲任何可见窗口的响应。
  // createWebView 已迁到 src/window/web-view.js —— 守卫必须跟着走。
  const impl = fs.readFileSync(
    path.join(root, 'desktop', 'src', 'window', 'web-view.js'), 'utf8')
  assert.ok(/backgroundThrottling:\s*true/.test(impl),
    'createWebView 必须用 true；这个开关只在创建时生效，事后改无效')
  assert.ok(!/backgroundThrottling:\s*false/.test(impl),
    '不能有任何一个实例创建时写死 false')
  // 全仓库不能再有第二处创建 WebContentsView 的代码绕过这条
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  assert.ok(!/new WebContentsView\(/.test(main), '实例视图只能由 web-view.js 工厂创建')
})

test('恢复计划：用户自己静音过就别替他开声音', () => {
  const normal = hidden.showPlan({ settings: {} })
  assert.ok(normal.includes('unmute'))
  const muted = hidden.showPlan({ settings: { muteAll: true } })
  assert.ok(!muted.includes('unmute'), 'muteAll 是用户设置，隐藏功能不能改回来')
})

test('至少保留一个可见窗口', () => {
  assert.equal(hidden.canHide({ id: 'a' }, 1).ok, false)
  assert.equal(hidden.canHide({ id: 'a' }, 2).ok, true)
  assert.equal(hidden.canHide({ id: 'a', hidden: true }, 2).ok, false, '重复隐藏要拒绝')
  assert.equal(hidden.canHide(null, 5).ok, false)
})

test('藏掉当前窗口：优先切右边，没有就切左边，且不选隐藏的', () => {
  const tabs = [
    { id: 'a' }, { id: 'b', hidden: true }, { id: 'c' }, { id: 'd' }
  ]
  assert.equal(hidden.nextActiveAfterHide(tabs, 'c'), 'd')
  // b 是隐藏的，从 a 往右找必须跳过它
  assert.equal(hidden.nextActiveAfterHide([{ id: 'a' }, { id: 'b', hidden: true }, { id: 'c' }], 'a'), 'c')
  // 最右边藏掉 → 往左找
  assert.equal(hidden.nextActiveAfterHide(tabs, 'd'), 'c')
  assert.equal(hidden.nextActiveAfterHide([{ id: 'a' }, { id: 'b', hidden: true }], 'a'), '')
})

/**
 * 装配**真实**的 hideTab / showHiddenTab，只把原生 Electron 调用换成可观测的桩。
 *
 * 这两个函数已经搬进 desktop/src/window/hidden-tab-ops.js，依赖全部参数化。
 * 所以这里直接调工厂，不再从 main.js 抠函数体拼进 new Function ——
 * 测的是产品实际调用的那份实现，改内部写法不会误报。
 */
function makeRuntime () {
  const tabs = []
  const calls = []
  const state = { tabs: tabs, activeId: '', showHome: false }
  const ops = require('../desktop/src/window/hidden-tab-ops').createHiddenTabOps({
    state: state,
    detachView: () => calls.push('detach'),
    layoutViews: () => calls.push('layout'),
    sendTabs: () => calls.push('send'),
    saveOpenApps: () => {},
    animateChromeTo: () => calls.push('chrome'),
    chromeOffset: () => 0,
    switchTab: id => { calls.push('switch:' + id); return { success: true } },
    unreadFromTitle: title => hidden.unreadFromTitle(title)
  })
  return { api: ops, tabs, state, calls }
}

function addTab(tabs, id, extra) {
  const wc = new EventEmitter()
  let muted = false
  let title = ''
  wc.setAudioMuted = v => { muted = v }
  wc.stop = () => {}
  wc.getTitle = () => title
  tabs.push(Object.assign({
    id: id,
    settings: {},
    view: { webContents: wc },
    isMuted: () => muted,
    setTitle: t => { title = t }
  }, extra || {}))
  return tabs[tabs.length - 1]
}

test('隐藏后：进程仍在 tabs 里（绝不销毁 = 不掉号）', () => {
  const { api, tabs, state } = makeRuntime()
  addTab(tabs, 'a')
  addTab(tabs, 'b')
  state.activeId = 'b'
  const r = api.hideTab('b')
  assert.equal(r.success, true)
  assert.equal(tabs.length, 2, '不能把 tab 从数组里删掉 —— 删了就是关闭')
  assert.equal(tabs[1].hidden, true)
  assert.ok(tabs[1].view && tabs[1].view.webContents, 'webContents 必须还在，否则要重新扫码')
})

test('隐藏当前窗口后自动切到相邻可见窗口', () => {
  const { api, tabs, state } = makeRuntime()
  // tabs 数组本身就是标签栏的显示顺序（main.js 的 tabs 也按这个顺序维护）
  addTab(tabs, 'a')
  addTab(tabs, 'b')
  addTab(tabs, 'c')
  state.activeId = 'b'
  api.hideTab('b')
  assert.equal(tabs.find(t => t.id === 'b').hidden, true)
  assert.equal(state.activeId, 'c')
  assert.equal(state.showHome, false)
})

test('隐藏时静音；恢复时按用户原设置决定是否开声音', () => {
  const { api, tabs, state } = makeRuntime()
  addTab(tabs, 'a')
  const b = addTab(tabs, 'b')
  state.activeId = 'a'
  api.hideTab('b')
  assert.equal(b.isMuted(), true)
  api.showHiddenTab('b')
  assert.equal(b.hidden, false)
  assert.equal(b.isMuted(), false)

  const { api: api2, tabs: tabs2, state: state2 } = makeRuntime()
  addTab(tabs2, 'a')
  const muted = addTab(tabs2, 'c', { settings: { muteAll: true } })
  state2.activeId = 'a'
  api2.hideTab('c')
  api2.showHiddenTab('c')
  assert.equal(muted.isMuted(), true, 'muteAll 是用户自己开的，恢复时不能被强行取消')
})

test('隐藏时清掉未读，恢复后重新读真实标题数', () => {
  const { api, tabs, state } = makeRuntime()
  addTab(tabs, 'a')
  const b = addTab(tabs, 'b')
  b.unread = 7
  state.activeId = 'a'
  api.hideTab('b')
  assert.equal(b.unread, 0, '隐藏前必须清角标，否则数字会僵在那里')
  b.setTitle('(3) Messenger')
  api.showHiddenTab('b')
  assert.equal(b.unread, 3, '恢复后要重新取标题里的真实未读数')
})

test('重复隐藏被拒绝，不会把状态搞乱', () => {
  const { api, tabs, state } = makeRuntime()
  addTab(tabs, 'a')
  addTab(tabs, 'b')
  state.activeId = 'a'
  assert.equal(api.hideTab('b').success, true)
  const again = api.hideTab('b')
  assert.equal(again.success, false)
  assert.equal(tabs[1].hidden, true)
})

test('只剩一个可见窗口时不许隐藏', () => {
  const { api, tabs, state } = makeRuntime()
  addTab(tabs, 'a')
  state.activeId = 'a'
  const r = api.hideTab('a')
  assert.equal(r.success, false)
  assert.equal(tabs[0].hidden, undefined)
})

test('恢复一个本来就没隐藏的窗口 = 切换，不能重复 attach', () => {
  const { api, tabs, state } = makeRuntime()
  addTab(tabs, 'a')
  addTab(tabs, 'b')
  state.activeId = 'a'
  const r = api.showHiddenTab('b')
  assert.equal(r.success, true)
  assert.equal(tabs[1].hidden, undefined)
})

test('布局绝不能把隐藏窗口重新挂回视图树', () => {
  const apply = extract(mainSrc, 'applyViewBounds')
  // applyViewBounds 现在只负责把 planLayout 的结论落到 Electron 上；
  // 「跳过隐藏窗口」的判断搬进了 src/window/view-layout.js 的 planLayout。
  // 这里同时验证接线和实现 —— 少任何一处，隐藏窗口都会盖住激活窗口。
  assert.ok(/viewLayout\.planLayout\(/.test(apply),
    'applyViewBounds 必须走 planLayout，否则隐藏窗口会盖住激活窗口')
  const layoutSrc = fs.readFileSync(
    path.join(root, 'desktop', 'src', 'window', 'view-layout.js'), 'utf8')
  assert.ok(/tab\.hidden/.test(layoutSrc), 'planLayout 必须跳过隐藏窗口')
})

test('未读上报与全局角标都要跳过隐藏窗口', () => {
  const bind = extract(mainSrc, 'bindTabUnread')
  assert.ok(/tab\.hidden/.test(bind), '隐藏窗口收到消息不能推角标')
  const badge = extract(mainSrc, 'syncGlobalUnread')
  assert.ok(/t\.hidden/.test(badge), 'Dock 角标必须排除隐藏窗口')
})

test('隐藏状态要落盘并可恢复，否则重启后全部复活', () => {
  // tabPayload 已经参数化（src/window/tab-payload.js），直接跑真身看输出。
  const { createTabPayload } = require('../desktop/src/window/tab-payload')
  const api = createTabPayload({
    state: { tabs: [{ id: 'a', hidden: true }, { id: 'b' }], activeId: 'b', showHome: false },
    profileOf: () => null,
    bridgeHealth: { get: () => null }
  })
  const rows = api.payload().rows
  assert.equal(rows[0].hidden, true, '隐藏标记必须进载荷，否则渲染层会让它重新出现在标签栏')
  assert.equal(rows[1].hidden, false)

  // 落盘与恢复仍走 saveOpenApps / restoreOneApp，用源码守卫即可
  assert.ok(/hidden: !!t\.hidden/.test(mainSrc), 'saveOpenApps 必须带上 hidden')
  assert.ok(/hidden: !!row\.hidden/.test(mainSrc), 'restoreOneApp 必须读回 hidden')
})

test('右键菜单有「隐藏该窗口」且接的是 hideTab', () => {
  // 菜单模板已迁到 src/window/tab-context-menu.js
  const menu = fs.readFileSync(
    path.join(root, 'desktop', 'src', 'window', 'tab-context-menu.js'), 'utf8')
  assert.ok(/隐藏该窗口/.test(menu))
  assert.ok(/hideTab\(tab\.id\)/.test(menu))
})

test('渲染层：隐藏窗口不进标签栏，也不算"已启用"', () => {
  const fill = extract(appSrc, 'fillEnabled')
  assert.ok(/filter\(tab => !tab\.hidden\)/.test(fill), '已启用的应用不能包含后台窗口')
  const clear = extract(appSrc, 'renderTabs')
  assert.ok(/hiddenRows = rows\.filter\(tab => tab\.hidden\)/.test(clear),
    '隐藏窗口必须从标签栏里剔除，单独渲染')
  assert.ok(/makeHiddenTrayEl/.test(clear), '必须有恢复入口，否则藏完找不回来')
})

test('批量关闭不会连后台窗口一起关掉', () => {
  const at = appSrc.indexOf('clearEnabled.onclick')
  const block = appSrc.slice(at, appSrc.indexOf('\n}', at))
  assert.ok(/filter\(tab => !tab\.hidden\)/.test(block),
    '垃圾桶必须只关可见窗口 —— 否则用户毫不知情地丢一个号')
})

test('垃圾桶没勾选就只提示，绝不批量关闭', () => {
  const at = appSrc.indexOf('clearEnabled.onclick')
  const block = appSrc.slice(at, appSrc.indexOf('\n}', at))
  // 关键：以前是 `selected.length ? selected : 全部`，没勾选等于全关。
  // 现在必须先拦一道，把提示摆在前面。
  assert.ok(/if \(!ids\.length\)/.test(block), '必须先判断没勾选')
  assert.ok(/请选择需要关闭的窗口应用/.test(block), '提示文案要一致')
  assert.ok(!/ids\s*=\s*[^;\n]*:\s*visible\.map/.test(block), '不能再有"没选就全关"的兜底')
  const guard = block.indexOf('if (!ids.length)')
  const close = block.indexOf('window.pix.close')
  assert.ok(guard >= 0 && guard < close, '拦截必须发生在任何关闭动作之前')
})

test('垃圾桶只关勾选的账号', () => {
  const at = appSrc.indexOf('clearEnabled.onclick')
  const block = appSrc.slice(at, appSrc.indexOf('\n}', at))
  assert.ok(/checkedIds\[tab\.id\]/.test(block), '必须按勾选过滤，而不是按全部窗口')
})

test('提示必须走 top-layer，否则会被原生视图盖住看不见', () => {
  const fn = extract(appSrc, 'toast')
  assert.ok(/popover/.test(fn), '普通定位的提示会被 WebContentsView 遮住')
})

// ── 关闭二次确认 ──────────────────────────────────────────────────────

test('标签上的 × 必须先确认才关', () => {
  const fn = extract(appSrc, 'makeTabEl')
  const at = fn.indexOf("el.querySelector('.x').onclick")
  assert.ok(at >= 0, '找不到 × 的点击处理')
  const block = fn.slice(at, at + 320)
  assert.ok(/confirmCloseTab\(tab\)/.test(block), '× 必须走二次确认')
  assert.ok(/await[\s\S]*confirmCloseTab/.test(block), '必须 await 确认结果')
  const confirmAt = block.indexOf('confirmCloseTab')
  const closeAt = block.indexOf('window.pix.close')
  assert.ok(closeAt > confirmAt, 'close 必须在确认之后，不能先关再问')
})

test('右键「关闭应用」也要确认，不能由主进程直接关', () => {
  // 菜单模板已迁到 src/window/tab-context-menu.js
  const menu = fs.readFileSync(
    path.join(root, 'desktop', 'src', 'window', 'tab-context-menu.js'), 'utf8')
  assert.ok(/closeAsk/.test(menu), '右键关闭应回传给渲染层弹确认')
  assert.ok(!/label: '关闭应用', click: \(\) => closeTab/.test(menu),
    '主进程直接 closeTab 会绕过确认')
  const cmd = appSrc.slice(appSrc.indexOf("command.action === 'closeAsk'"))
  assert.ok(/confirmCloseTab/.test(cmd.slice(0, 400)))
})

test('确认框默认落在「取消」上，手快回车也不会误关', () => {
  const fn = extract(appSrc, 'confirmAction')
  assert.ok(/cancelBtn\.focus\(\)/.test(fn), '默认焦点必须是取消')
  // 任何非"明确点确认"的关闭路径都必须解析成 false
  assert.ok(/dialog\.oncancel = event => \{ event\.preventDefault\(\); finish\(false\) \}/.test(fn),
    'ESC 必须是取消')
  assert.ok(/dialog\.onclose = \(\) => finish\(false\)/.test(fn), '关闭即取消')
})

test('垃圾桶批量关闭要确认一次，且文案给出数量', () => {
  const at = appSrc.indexOf('clearEnabled.onclick')
  const block = appSrc.slice(at, appSrc.indexOf('\n}', at))
  assert.ok(/confirmAction\(/.test(block), '批量关闭必须确认')
  assert.ok(/await/.test(block), '必须等确认结果')
  assert.ok(/ids\.length > 1/.test(block), '多个窗口时文案要给数量')
})

test('底层 close 通道不能无确认放行', () => {
  // contextAction 已迁到 src/ipc/tabs.js
  const impl = fs.readFileSync(path.join(root, 'desktop', 'src', 'ipc', 'tabs.js'), 'utf8')
  const at = impl.indexOf("if (action === 'close')")
  assert.ok(at >= 0, '找不到 contextAction 的 close 分支')
  const block = impl.slice(at, at + 300)
  assert.ok(/needConfirm/.test(block), 'contextAction 的 close 必须被拦下')
  assert.ok(!/if \(action === 'close'\) return closeTab/.test(impl))
  assert.ok(!/if \(action === 'close'\) return closeTab/.test(mainSrc))
})

// ── 标签栏滚轮 ────────────────────────────────────────────────────────

/**
 * 装配真实的 attachTabsWheel，用假容器驱动 wheel 事件。
 * wheel 的处理逻辑全在事件回调里，抽不出来，所以直接跑真函数。
 */
function wheelHarness (opts) {
  const o = opts || {}
  const listeners = {}
  const hints = { calls: 0 }
  const tabsEl = {
    clientWidth: o.clientWidth || 600,
    scrollWidth: o.scrollWidth || 1800,
    scrollLeft: o.scrollLeft || 0,
    addEventListener (type, fn, options) {
      listeners[type] = { fn, options }
    }
  }
  const tabsWrapEl = { classList: { toggle () {} } }
  const body = [
    extract(appSrc, 'syncTabsOverflowHint'),
    extract(appSrc, 'attachTabsWheel'),
    'return { attachTabsWheel }'
  ].join('\n')
  const api = new Function('tabsEl', 'tabsWrapEl', body)(tabsEl, tabsWrapEl)

  let prevented = false
  const fire = extra => {
    prevented = false
    const event = Object.assign({
      deltaX: 0,
      deltaY: 0,
      deltaMode: 0,
      shiftKey: false,
      preventDefault () { prevented = true }
    }, extra || {})
    listeners.wheel.fn(event)
    hints.calls++
    return prevented
  }
  return { api, tabsEl, fire, listeners, scrollLeft: () => tabsEl.scrollLeft }
}

test('垂直滚轮能横向滚动标签栏', () => {
  const h = wheelHarness({ scrollLeft: 200 })
  h.api.attachTabsWheel()
  const prevented = h.fire({ deltaY: 120 })
  assert.equal(prevented, true, '必须拦下来，否则页面会跟着上下抖')
  assert.equal(h.scrollLeft(), 320, '滚轮应把容器往右推')
})

test('滚轮事件必须是非 passive 的，否则 preventDefault 无效', () => {
  const h = wheelHarness()
  h.api.attachTabsWheel()
  assert.equal(h.listeners.wheel.options && h.listeners.wheel.options.passive, false,
    'passive:true 会让 preventDefault 被忽略，滚动时会带动整页')
})

test('滚到两端就放行，不制造"滚不动也不让页面滚"的死手感', () => {
  const atEnd = wheelHarness({ scrollLeft: 1200, clientWidth: 600, scrollWidth: 1800 })
  atEnd.api.attachTabsWheel()
  assert.equal(atEnd.fire({ deltaY: 200 }), false, '到底了还继续往下滚必须放行')

  const atStart = wheelHarness({ scrollLeft: 0 })
  atStart.api.attachTabsWheel()
  assert.equal(atStart.fire({ deltaY: -200 }), false, '到顶了还继续往上滚必须放行')
})

test('没有溢出时不拦截滚轮', () => {
  const h = wheelHarness({ clientWidth: 600, scrollWidth: 600 })
  h.api.attachTabsWheel()
  assert.equal(h.fire({ deltaY: 120 }), false, '不需要滚动时不能抢滚轮')
})

test('触控板横向滑动 / Shift+滚轮 交给浏览器默认行为', () => {
  const h = wheelHarness({ scrollLeft: 200 })
  h.api.attachTabsWheel()
  assert.equal(h.fire({ deltaX: 120, deltaY: 8 }), false, '横向手势要放行')
  assert.equal(h.fire({ deltaY: 120, shiftKey: true }), false, 'Shift 本身就是横向滚')
})

test('行模式的滚轮要按行换算成像素', () => {
  const h = wheelHarness({ scrollLeft: 100 })
  h.api.attachTabsWheel()
  h.fire({ deltaY: 3, deltaMode: 1 })
  // 3 行 × 16px = 48px，而不是 3px（那几乎动不了）
  assert.equal(h.scrollLeft(), 148, 'deltaMode=1 时必须乘行高，否则滚一格只动 3 像素')
})

test('滚轮监听只能绑一次（重渲染不能叠监听器）', () => {
  const h = wheelHarness()
  h.api.attachTabsWheel()
  const first = h.listeners.wheel
  h.api.attachTabsWheel()
  assert.equal(h.listeners.wheel, first, '重复调用不能覆盖或叠加监听')
})
