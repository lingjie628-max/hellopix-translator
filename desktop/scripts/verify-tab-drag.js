'use strict'

/**
 * 标签栏拖拽排序 + 右键重命名的 DOM 级验证。
 *
 * 为什么不用真机点：这两项都是**渲染层**行为（拖动语义、插入位置、
 * 输入框替换），主进程只负责接受"把 A 挪到 B 前/后"。把 app.js 在真实
 * DOM 语义里跑起来、喂给它一个假的 `window.pix`，就能覆盖全部判定逻辑，
 * 而且能断言到"拖到左半边 = 插到前面"这种细节 —— 真机手点反而不可复现。
 *
 * 用法：node desktop/scripts/verify-tab-drag.js
 */

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const appJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8')

// ── 极简 DOM ─────────────────────────────────────────────────────────
//
// jsdom 不在依赖里，而这里要验证的 API 很少：createElement / appendChild /
// querySelector(All) / classList / getBoundingClientRect / 事件监听。
// 自己实现一个够用的版本，比引入一个有自己 bug 的实现更可靠。
let idSeq = 0
class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = {}
    this.dataset = {}
    this.listeners = {}
    this.style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' }
    this.classList = makeClassList(this)
    this._text = ''
    this._uid = ++idSeq
  }
  get className() { return this.attributes.class || '' }
  set className(value) { this.attributes.class = String(value) }
  get innerHTML() { return this._html || '' }
  set innerHTML(value) {
    this._html = String(value)
    this.children.forEach(child => { child.parentNode = null })
    this.children = []
    // 真实 DOM 会把 HTML 解析成节点。这里只需要还原 renderTabs 依赖的
    // 那几个：带 class 的元素、data-* 不需要。用正则扫 class 属性足够，
    // 目的是让 el.querySelector('.x') / '.tab-name' 这类查询能命中。
    const pattern = /<(\w+)([^>]*)>/g
    let match
    while ((match = pattern.exec(String(value)))) {
      const attrs = match[2] || ''
      const classMatch = /class="([^"]*)"/.exec(attrs)
      const node = new Node(match[1])
      if (classMatch) node.className = classMatch[1]
      const idMatch = /id="([^"]*)"/.exec(attrs)
      if (idMatch) node.attributes.id = idMatch[1]
      node.parentNode = this
      this.children.push(node)
    }
  }
  get textContent() { return this._text }
  set textContent(value) { this._text = String(value) }
  get offsetWidth() { return this.tagName === 'INPUT' ? 60 : 68 }
  get offsetLeft() {
    const parent = this.parentNode
    if (!parent) return 0
    return parent.children.slice(0, parent.children.indexOf(this))
      .reduce((sum, node) => sum + node.offsetWidth, 0)
  }
  get scrollWidth() { return this.children.reduce((sum, node) => sum + node.offsetWidth, 0) }
  get clientWidth() { return 1400 }
  appendChild(node) {
    node.parentNode = this
    this.children.push(node)
    return node
  }
  replaceWith(node) {
    const parent = this.parentNode
    if (!parent) return
    const index = parent.children.indexOf(this)
    node.parentNode = parent
    parent.children[index] = node
    this.parentNode = null
  }
  remove() {
    const parent = this.parentNode
    if (!parent) return
    parent.children.splice(parent.children.indexOf(this), 1)
    this.parentNode = null
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
  dispatch(type, extra) {
    const event = Object.assign({
      type,
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() {},
      dataTransfer: { setData() {}, effectAllowed: '', dropEffect: '' },
      clientX: 0
    }, extra || {})
    event.defaultPrevented = false
    ;(this.listeners[type] || []).forEach(fn => fn(event))
    return event
  }
  matches(selector) { return matchesSelector(this, selector) }
  querySelector(selector) { return find(this, selector, true)[0] || null }
  querySelectorAll(selector) { return find(this, selector, false) }
  getBoundingClientRect() {
    const left = this.offsetLeft
    const width = this.offsetWidth
    return { left, width, right: left + width, top: 0, height: 62 }
  }
  scrollTo() {}
  focus() { this.focused = true }
  select() {}
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return this.attributes[name] }
  // 真实 input 的 value / maxLength 只是普通属性，事件处理走 on* 回调。
  dispatch(type, extra) {
    const event = Object.assign({
      type,
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() {},
      dataTransfer: { setData() {}, effectAllowed: '', dropEffect: '' },
      clientX: 0
    }, extra || {})
    event.defaultPrevented = false
    const own = this['on' + type]
    if (typeof own === 'function') own(event)
    ;(this.listeners[type] || []).forEach(fn => fn(event))
    return event
  }
  set scrollLeft(value) { this._scrollLeft = value }
  get scrollLeft() { return this._scrollLeft || 0 }
}

function makeClassList(node) {
  const api = {
    add: (...names) => {
      const set = new Set(node.className.split(/\s+/).filter(Boolean))
      names.forEach(name => set.add(name))
      node.className = Array.from(set).join(' ')
    },
    remove: (...names) => {
      const set = new Set(node.className.split(/\s+/).filter(Boolean))
      names.forEach(name => set.delete(name))
      node.className = Array.from(set).join(' ')
    },
    contains: name => node.className.split(/\s+/).includes(name),
    toggle: (name, force) => {
      const on = force === undefined ? !api.contains(name) : !!force
      if (on) api.add(name); else api.remove(name)
    }
  }
  return api
}

function matchesSelector(node, selector) {
  const parts = String(selector).trim()
  const attr = /^\[data-tab-id="(.*)"\]$/.exec(parts)
  if (attr) return node.dataset.tabId === attr[1]
  return parts.split('.').filter(Boolean).every(token =>
    node.tagName.toLowerCase() === token || node.classList.contains(token))
}

function find(root, selector, first) {
  const out = []
  const walk = node => {
    for (const child of node.children) {
      if (matchesSelector(child, selector)) {
        out.push(child)
        if (first) return true
      }
      if (walk(child) && first) return true
    }
    return false
  }
  walk(root)
  return out
}

// ── app.js 需要的全局对象 ────────────────────────────────────────────
const reorderCalls = []
const renameCalls = []
const tabState = {
  home: false,
  activeId: 'wa-1',
  rows: [
    { id: 'wa-1', platform: 'whatsapp', name: '凯瑟琳', title: '', alignRight: false, unread: 0 },
    { id: 'wa-2', platform: 'whatsapp', name: '卡罗琳', title: '', alignRight: false, unread: 0 },
    { id: 'wa-3', platform: 'whatsapp', name: '江顺明星', title: '', alignRight: false, unread: 0 },
    { id: 'wa-4', platform: 'whatsapp', name: '右侧分组', title: '', alignRight: true, unread: 0 }
  ]
}

const ids = ['tabs', 'tabsWrap', 'empty', 'status', 'transBar', 'operationMenus',
  'checkedList', 'homeBgVideo', 'pixContextMenu', 'userBox', 'systemUpdateBtn']
const elements = {}
ids.forEach(id => {
  const node = new Node('div')
  node.attributes.id = id
  elements[id] = node
})
// 主页背景视频节点会被 renderTabs 调用 play/pause。
elements.homeBgVideo.play = () => Promise.resolve()
elements.homeBgVideo.pause = () => {}

const document = {
  getElementById: id => {
    if (!elements[id]) {
      elements[id] = new Node('div')
      // 视频节点在任何地方都会调 play/pause，统一补上，避免按 id 逐个补。
      elements[id].play = () => Promise.resolve()
      elements[id].pause = () => {}
    }
    return elements[id]
  },
  createElement: tag => new Node(tag),
  addEventListener() {},
  body: new Node('body'),
  querySelector: () => null,
  querySelectorAll: () => []
}
document.documentElement = new Node('html')

const pixStub = new Proxy({
  tabs: async () => tabState,
  reorderTabs: async (id, targetId, before) => {
    reorderCalls.push({ id, targetId, before })
    return { success: true }
  },
  renameTab: async (id, name) => { renameCalls.push({ id, name }); return { success: true } }
}, {
  get: (target, key) => {
    if (key in target) return target[key]
    // 其余任何 window.pix.xxx 都当作无操作，避免脚本在初始化阶段炸掉。
    return async () => ({ rows: [], tabs: tabState, lines: [] })
  }
})

const windowObject = {
  pix: pixStub,
  addEventListener() {},
  innerWidth: 1440,
  innerHeight: 900,
  document
}

const sandbox = {
  document,
  window: windowObject,
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval() {},
  requestAnimationFrame: fn => setTimeout(fn, 0),
  localStorage: { getItem: () => null, setItem() {} },
  navigator: { userAgent: 'verify' },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  location: { href: '' },
  // chrome 高度计算会读 CSS 变量；这里只关心标签栏行为，给个定值即可。
  getComputedStyle: () => ({ getPropertyValue: () => '64', height: '64px' }),
  // 主页背景视频：非空即会调用 play/pause，给两个空实现即可。
  HTMLMediaElement: class HTMLMediaElement {}
}
sandbox.HTMLMediaElement.prototype.play = function play() { return Promise.resolve() }
sandbox.HTMLMediaElement.prototype.pause = function pause() {}
sandbox.globalThis = sandbox

vm.createContext(sandbox)
vm.runInContext(appJs, sandbox, { filename: 'app.js' })

// renderTabs 是函数声明，在 vm 里属于全局，可以直接取。
const renderTabs = sandbox.renderTabs
const runPixContextAction = sandbox.runPixContextAction

// ── 断言 ─────────────────────────────────────────────────────────────
const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? '  — ' + detail : ''}`)
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

;(async () => {
  const tabsEl = elements.tabs
  renderTabs(tabState)
  const tabEls = () => tabsEl.children
    .filter(node => node.classList.contains('tab') && !node.classList.contains('tab-home'))

  check('渲染出 3 个左侧标签 + 1 个右侧分组', tabEls().length === 4,
    tabEls().map(node => node.dataset.tabId).join(','))
  check('标签都带 data-tab-id（右键重命名要靠它找回节点）',
    tabEls().every(node => !!node.dataset.tabId))
  check('标签都是 draggable', tabEls().every(node => node.draggable === true))

  // 拖 wa-3（江顺明星）到 wa-1 的左半边 → 插到最前
  const target = tabsEl.querySelector('[data-tab-id="wa-1"]')
  tabsEl.querySelector('[data-tab-id="wa-3"]').dispatch('dragstart')
  const overEvent = target.dispatch('dragover', { clientX: target.getBoundingClientRect().left + 5 })
  check('dragover 在同一分组内会 preventDefault（否则 drop 不触发）', overEvent.defaultPrevented === true)
  check('左半边命中 → 显示 drop-before', target.classList.contains('drop-before'))
  target.dispatch('drop', { clientX: target.getBoundingClientRect().left + 5 })
  await tick()
  check('drop 提交 reorderTabs(wa-3, wa-1, before=true)',
    reorderCalls.length === 1 && reorderCalls[0].id === 'wa-3' &&
    reorderCalls[0].targetId === 'wa-1' && reorderCalls[0].before === true,
    JSON.stringify(reorderCalls[0]))

  // 拖 wa-1 到 wa-3 的右半边 → 插到后面
  reorderCalls.length = 0
  tabsEl.querySelector('[data-tab-id="wa-1"]').dispatch('dragstart')
  const t3 = tabsEl.querySelector('[data-tab-id="wa-3"]')
  t3.dispatch('dragover', { clientX: t3.getBoundingClientRect().right - 5 })
  check('右半边命中 → 显示 drop-after',
    t3.classList.contains('drop-after') && !t3.classList.contains('drop-before'))
  t3.dispatch('drop', { clientX: t3.getBoundingClientRect().right - 5 })
  await tick()
  check('右半边 drop → before=false',
    reorderCalls[0] && reorderCalls[0].before === false, JSON.stringify(reorderCalls[0]))

  // 跨分组拖拽必须被拒绝（右侧分组靠 alignRight 渲染，不参与顺序）
  reorderCalls.length = 0
  tabsEl.querySelector('[data-tab-id="wa-4"]').dispatch('dragstart')
  const t2 = tabsEl.querySelector('[data-tab-id="wa-2"]')
  const overCross = t2.dispatch('dragover', { clientX: 5 })
  t2.dispatch('drop', { clientX: 5 })
  await tick()
  check('跨分组（右侧→左侧）不提交排序', reorderCalls.length === 0 && overCross.defaultPrevented === false,
    `calls=${JSON.stringify(reorderCalls)} dp=${overCross.defaultPrevented}`)

  // 拖到主页 = 挪到最前
  reorderCalls.length = 0
  const homeTab = tabsEl.querySelector('.tab-home')
  tabsEl.querySelector('[data-tab-id="wa-2"]').dispatch('dragstart')
  homeTab.dispatch('dragover', { clientX: 10 })
  homeTab.dispatch('drop', { clientX: 10 })
  await tick()
  check('拖到主页 → reorderTabs(id, home, before=false)',
    reorderCalls[0] && reorderCalls[0].targetId === 'home' && reorderCalls[0].before === false,
    JSON.stringify(reorderCalls[0]))

  // ── 右键重命名 ─────────────────────────────────────────────────────
  renderTabs(tabState)
  runPixContextAction('rename', tabState.rows[0])
  const input = tabsEl.querySelector('.tab-name-input')
  check('右键「重命名窗口…」把名字换成输入框', !!input && input.value === '凯瑟琳',
    input ? input.value : 'no input')
  if (input) {
    input.value = '凯瑟琳-客服'
    input.dispatch('keydown', { key: 'Enter' })
    await tick()
  }
  check('回车提交 renameTab(id, 新名字)',
    renameCalls[0] && renameCalls[0].id === 'wa-1' && renameCalls[0].name === '凯瑟琳-客服',
    JSON.stringify(renameCalls[0]))

  renameCalls.length = 0
  renderTabs(tabState)
  runPixContextAction('rename', tabState.rows[1])
  const input2 = tabsEl.querySelector('.tab-name-input')
  if (input2) {
    input2.value = '不该保存'
    input2.dispatch('keydown', { key: 'Escape' })
    await tick()
  }
  check('Escape 取消，不提交改名', renameCalls.length === 0)

  // 「不显示标签名」时也必须能改名
  renameCalls.length = 0
  const hiddenState = Object.assign({}, tabState, {
    rows: tabState.rows.map((row, index) => Object.assign({}, row, { showTabName: index !== 2 }))
  })
  renderTabs(hiddenState)
  runPixContextAction('rename', hiddenState.rows[2])
  const input3 = tabsEl.querySelector('.tab-name-input')
  check('隐藏标签名的窗口仍能弹出重命名输入框', !!input3)
  if (input3) {
    input3.value = '江顺明星-2'
    input3.dispatch('keydown', { key: 'Enter' })
    await tick()
  }
  check('隐藏标签名时提交成功',
    renameCalls[0] && renameCalls[0].id === 'wa-3' && renameCalls[0].name === '江顺明星-2',
    JSON.stringify(renameCalls[0]))

  // ── 样式存在性 ─────────────────────────────────────────────────────
  check('styles.css 有插入位置指示线',
    /\.tab\.drop-before::before/.test(css) && /\.tab\.drop-after::before/.test(css))
  check('styles.css 有拖动中的半透明态', /\.tab\.dragging/.test(css))

  const failed = results.filter(item => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
})()
