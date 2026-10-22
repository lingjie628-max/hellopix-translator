'use strict'

/**
 * 确认框与原生视图的层叠契约。
 *
 * ## 这个文件为什么存在
 *
 * 用户的截图：WhatsApp 扫码页整个盖住了「关闭应用」的二次确认框，
 * 取消和确认按钮一个都点不到 —— **关闭功能彻底不可用**。
 *
 * 根因有两处，且必须同时修好才有效：
 *
 *   1. `overlayVisible()` 只检查七个面板的 hidden 类，**没有把确认框算进去**。
 *      确认框是 `<dialog>`，可见性由 `open` 属性决定，从来不加 hidden 类。
 *      于是弹框时它判定为"没有浮层"，反过来把原生视图**盖了回来**。
 *
 *   2. `confirmAction` 从头到尾没调 `syncOverlay()`：
 *      既不通知主进程让开，关掉之后也不通知放回来。
 *
 * ## 为什么不用源码正则断言
 *
 * 上一轮就是被正则害的：断言"INSERT 里写了 chars 列"能过，
 * 但那个列根本不存在，翻译一调用就 500。**"代码里有这行"不等于"行为对"。**
 *
 * 这里用 jsdom 真跑 `ui-kit.js`，所有 DOM 行为、dialog 的 open 语义、
 * setOverlay 的调用序列都是真实的。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')

const uiKitSource = fs.readFileSync(path.join(__dirname, '../desktop/renderer/ui-kit.js'), 'utf8')
const domSource = fs.readFileSync(path.join(__dirname, '../desktop/renderer/dom.js'), 'utf8')

/**
 * dom.js 里 `const xxx = document.getElementById(...)` 的元素 id。
 * 这些必须与真实 index.html 一致 —— 对不上的话 ui-kit 拿到 null，
 * 测试会以 TypeError 的形式炸，而不是给出清楚的断言失败。
 */
const ELEMENT_IDS = [
  'profile', 'profileBody', 'profileClose',
  'transPanel', 'lockScreen', 'addApp', 'addAppTitle', 'addAppX',
  'proxySettings', 'proxySettingsCard', 'proxySettingsFor', 'proxySettingsX',
  'updatePanel', 'standalonePanel', 'appOpsWrap', 'systemOpsWrap'
]

/**
 * 起一个最小化的渲染层：加载**真实的 dom.js**（不伪造元素句柄），
 * 再跑 ui-kit.js。这样测到的是线上同一份代码，不是我抄的副本。
 */
function bootRenderer() {
  // 元素必须带 `class="modal hidden"`，跟真实的 index.html 一致。
  //
  // 这里曾经只写 `class="hidden"`，于是 overlayVisible 的自动发现
  // （按 `.modal` 认面板）在测试里永远找不到面板 —— 测试绿了，线上是坏的。
  // fixture 的 class 是"线上契约"的一部分，不能自己编。
  const MODAL_IDS = new Set([
    'transPanel', 'addApp', 'proxySettings', 'updatePanel', 'standalonePanel', 'profile'
  ])
  const LOCKSCREEN_IDS = new Set(['lockScreen'])
  const elements = ELEMENT_IDS
    .map(id => {
      const cls = MODAL_IDS.has(id) ? 'modal '
        : LOCKSCREEN_IDS.has(id) ? 'lock-screen '
          : ''
      return `<div id="${id}" class="${cls}hidden"></div>`
    })
    .join('\n')
  const dom = new JSDOM(`<!doctype html><html><body>
    ${elements}
    <dialog id="closeConfirm" class="confirm-dialog">
      <h3 id="closeConfirmTitle"></h3>
      <p id="closeConfirmText"></p>
      <button id="closeConfirmCancel" type="button">取消</button>
      <button id="closeConfirmOk" type="button">确认</button>
    </dialog>
  </body></html>`, { runScripts: 'outside-only' })

  const { window } = dom

  // jsdom 没实现 showModal 的 top-layer，但 open 属性的语义是对的。
  // 显式补齐，确保测的是"open 变了"而不是"jsdom 凑巧行为一致"。
  const dialog = window.document.getElementById('closeConfirm')
  dialog.showModal = function showModal() { this.open = true }
  dialog.close = function close() { this.open = false }

  /** 记录主进程收到的每一次 setOverlay 调用，顺序也要能验 */
  const overlayCalls = []
  window.pix = {
    setOverlay: (on) => { overlayCalls.push(!!on) }
  }

  // dom.js 用的是顶层 const，不是 window 属性 —— 所以必须在同一个 eval
  // 作用域里连着跑两份源码，否则 ui-kit.js 看不到 dom.js 的绑定。
  // 末尾把要测的函数挂到 window 上，因为顶层 function 声明不会自动变成
  // window 属性（它们在 eval 的独立作用域里）。
  window.eval(`${domSource}\n${uiKitSource}
  window.__api = { confirmAction, overlayVisible, syncOverlay, showOverlay }
  `)

  return {
    window,
    document: window.document,
    dialog,
    overlayCalls,
    ...window.__api
  }
}

test('★ 确认框打开时必须让开原生视图，否则 WhatsApp 页面会盖住按钮', async () => {
  const ui = bootRenderer()
  assert.equal(ui.overlayVisible(), false, '初始应该没有浮层')

  const answer = ui.confirmAction('关闭这个窗口？', '花花老顾问', '关闭窗口')

  // 弹框刚出现的这一刻，主进程必须已经收到"让开"
  assert.equal(ui.dialog.open, true, '确认框应该已经打开')
  assert.deepEqual(ui.overlayCalls, [true],
    'showModal 之后必须立刻 setOverlay(true)，否则原生视图会盖在确认框上')

  ui.document.getElementById('closeConfirmCancel').click()
  assert.equal(await answer, false)
})

test('overlayVisible 必须把 dialog.open 算进来', () => {
  const ui = bootRenderer()
  assert.equal(ui.overlayVisible(), false)

  ui.dialog.open = true
  assert.equal(ui.overlayVisible(), true,
    '确认框是 <dialog>，可见性是 open 属性，不能用 hidden 类判断')

  ui.dialog.open = false
  assert.equal(ui.overlayVisible(), false)
})

test('★ 取消之后必须把视图放回来，否则窗口里只剩空白', async () => {
  const ui = bootRenderer()
  const answer = ui.confirmAction('关闭这个窗口？', 'x', '关闭')
  assert.deepEqual(ui.overlayCalls, [true])

  ui.document.getElementById('closeConfirmCancel').click()
  await answer

  assert.deepEqual(ui.overlayCalls, [true, false],
    '取消后必须 setOverlay(false) 让实例视图重新挂回来')
  assert.equal(ui.dialog.open, false)
})

test('★ 确认关闭之后同样要放回视图（关的是标签不是整个窗口）', async () => {
  const ui = bootRenderer()
  const answer = ui.confirmAction('关闭这个窗口？', 'x', '关闭')
  ui.document.getElementById('closeConfirmOk').click()
  assert.equal(await answer, true)
  assert.deepEqual(ui.overlayCalls, [true, false])
})

test('ESC 取消也要恢复视图，不能让窗口留在"视图已摘"的状态', async () => {
  const ui = bootRenderer()
  const answer = ui.confirmAction('关闭这个窗口？', 'x', '关闭')

  const event = new ui.window.Event('cancel', { cancelable: true })
  ui.dialog.dispatchEvent(event)
  assert.equal(await answer, false)
  assert.deepEqual(ui.overlayCalls, [true, false])
})

test('确认框与面板叠加时，关掉确认框不能把还开着的面板一起摘掉', async () => {
  const ui = bootRenderer()
  // 假设「代理设置」面板正开着，用户又触发了关闭确认
  ui.document.getElementById('proxySettings').classList.remove('hidden')

  const answer = ui.confirmAction('关闭这个窗口？', 'x', '关闭')
  assert.deepEqual(ui.overlayCalls, [true])

  ui.document.getElementById('closeConfirmCancel').click()
  await answer

  // 面板还开着，所以这次 setOverlay 收到的应该是 true —— 视图继续保持摘除态
  assert.deepEqual(ui.overlayCalls, [true, true],
    '面板没关时不能把视图放回来，否则面板又会被盖住')
})

test('★ 锁屏也是整屏浮层，必须算进 overlayVisible（它用的不是 .modal 类）', () => {
  const ui = bootRenderer()
  ui.document.getElementById('lockScreen').classList.remove('hidden')
  assert.equal(ui.overlayVisible(), true,
    '锁屏时视图还在上面压着，用户连密码框都点不到')
})

test('★ 新加的 .modal 面板不需要改 overlayVisible 也能被认出来', () => {
  const ui = bootRenderer()
  // 模拟"以后有人加了个第八个面板"，只写了 class="modal hidden"
  const fresh = ui.document.createElement('div')
  fresh.className = 'modal hidden'
  ui.document.body.appendChild(fresh)
  assert.equal(ui.overlayVisible(), false, '还没打开时不该算浮层')

  fresh.classList.remove('hidden')
  assert.equal(ui.overlayVisible(), true,
    '白名单式实现会在这里返回 false —— 于是新面板一弹出来就被原生视图盖住')
})

test('连续弹两次确认框，overlay 调用必须成对，不能漏放回', async () => {
  const ui = bootRenderer()
  const first = ui.confirmAction('第一次', 'a', '确认')
  // 第二个进来会把第一个按"取消"结掉
  const second = ui.confirmAction('第二次', 'b', '确认')

  assert.equal(await first, false, '被顶掉的第一个应当按取消处理')
  assert.equal(ui.overlayCalls[0], true)

  ui.document.getElementById('closeConfirmCancel').click()
  assert.equal(await second, false)

  // 成对：[true, false]。中间那次 true 是第二次 showModal 补的。
  assert.equal(ui.overlayCalls[0], true, '第一次打开要让开')
  assert.equal(ui.overlayCalls[ui.overlayCalls.length - 1], false,
    '最后一次关闭必须把视图放回来')
})
