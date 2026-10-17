'use strict'

/**
 * 译文可选中、可复制（行为层）。
 *
 * ## 被修的真机现象
 *
 * 译文看得见，却**选不中 / 复制不出来**。
 *
 * ## 根因（两层）
 *
 * 1. CSS 层：译文框 `.pix-trans` 是宿主（WhatsApp / LINE / Telegram）气泡的
 *    后代，宿主会在气泡容器上打 `user-select: none`，很多构建用的是**带前缀**的
 *    `-webkit-user-select: none`。我们原来只写了不带前缀、也不带 `!important`
 *    的 `user-select: text`，层叠上压不过宿主 → 整个子树被禁选。
 * 2. 事件层：有一类宿主用事件禁选 —— 在气泡 / 消息列表上挂 `selectstart` /
 *    `mousedown` / `copy` 并 `preventDefault()`。CSS 再怎么放开，
 *    按下 / 复制那一刻也会被宿主取消。
 *
 * ## 怎么证
 *
 * 把**整份** guest-inject.js 跑进 jsdom（不是抽片段），插一个真的 `.pix-trans`
 * 到消息行里，再挂一个"恶意宿主"监听（复刻部分宿主的做法：在气泡 / #main 的
 * **捕获阶段**对消息区 selectstart 一律 preventDefault）。
 * 然后断言：落在译文框里的那一下被我们的守卫**在 document 捕获阶段**拦下并
 * stopPropagation —— 宿主的监听根本收不到，选择得以继续。
 *
 * 之所以是行为测试而不是只做源码断言：这两层失效都是**静默**的
 * （译文照样画出来，只是选不中），只有真的走一遍事件路径才锁得住。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { JSDOM } = require('jsdom')

const root = path.join(__dirname, '..')
const guestSrc = fs.readFileSync(path.join(root, 'desktop', 'guest-inject.js'), 'utf8')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 一条真实感的 WhatsApp 消息行：行([data-id]) > copyable-text > 正文 span。 */
function waRow (id, body) {
  return '<div data-id="' + id + '" class="message-in" role="row">' +
    '<div class="copyable-text">' +
      '<div class="_akbw"><span class="selectable-text copyable-text" dir="ltr">' + body + '</span></div>' +
    '</div>' +
    '</div>'
}

async function mount () {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="main"><div id="msg-list">' +
      waRow('row-1', 'Hello there') +
    '</div></div></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://web.whatsapp.com/' }
  )
  const win = dom.window
  const doc = win.document
  win.Element.prototype.getBoundingClientRect = () => ({
    width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0
  })
  win.require = () => ({
    ipcRenderer: {
      invoke: () => Promise.resolve({ success: true }),
      on: () => {},
      removeAllListeners: () => {}
    }
  })
  win.eval(guestSrc)
  await new Promise(resolve => {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', resolve, { once: true })
    else resolve()
  })
  await sleep(20)
  return { win, doc }
}

/** 手动插一个译文框到消息行里（绕开翻译网络链，只测"译文能不能被选"）。 */
function insertTransBox (doc, text) {
  const host = doc.querySelector('[data-id="row-1"] .copyable-text')
  const box = doc.createElement('div')
  box.className = 'pix-trans'
  box.textContent = text
  host.appendChild(box)
  return box
}

test('译文框:用户能选中（宿主挂在消息区的 selectstart 取消拦不住我们放行）', async () => {
  const { win, doc } = await mount()
  const box = insertTransBox(doc, '你好，世界')

  // 复刻"恶意宿主"：消息区（#main）与气泡（.copyable-text）都在捕获阶段
  // 对 selectstart 一律取消。真实宿主（WhatsApp 若干构建）就是这么干的 ——
  // 一旦我们的事件守卫没挂上，译文就会"看得见、选不中"。
  let hostSawSelectStart = 0
  const cancelOnSelectable = event => {
    if (event.target && event.target.closest && event.target.closest('.copyable-text')) {
      hostSawSelectStart++
      event.preventDefault()
    }
  }
  doc.getElementById('main').addEventListener('selectstart', cancelOnSelectable, true)
  const bubble = doc.querySelector('[data-id="row-1"] .copyable-text')
  bubble.addEventListener('selectstart', cancelOnSelectable, true)

  // 用户想在译文上按下开始选择。
  const evt = new win.Event('selectstart', { bubbles: true, cancelable: true })
  box.dispatchEvent(evt)

  // 我们的守卫在 **document 捕获阶段**（最外层）先收到并 stopPropagation，
  // 宿主的 #main / 气泡监听根本收不到这一下。
  assert.equal(hostSawSelectStart, 0,
    '译文的 selectstart 被传到了宿主 —— 宿主会 preventDefault，译文选不中')

  // 落在**非译文**区域的事件必须照旧传给宿主，绝不能影响宿主自己的禁选逻辑。
  const host = doc.querySelector('[data-id="row-1"] .copyable-text')
  const before = hostSawSelectStart
  const evt2 = new win.Event('selectstart', { bubbles: true, cancelable: true })
  host.dispatchEvent(evt2)
  assert.ok(hostSawSelectStart > before,
    '非译文区域的 selectstart 也被我们吞了 —— 不该干预宿主对普通消息的禁选')
})

test('译文框:宿主在更早阶段已取消时，守卫把译文整段选中兜底（至少能复制）', async () => {
  const { win, doc } = await mount()
  const box = insertTransBox(doc, '这段译文必须能被整段复制走')

  // 制造"事件到达我们之前就已经 defaultPrevented"：在 **window 捕获阶段**注册
  // 一个取消监听。window 捕获先于 document 捕获触发（捕获顺序：window →
  // document → … → target），所以 guest 的 document 捕获监听收到这一下时，
  // defaultPrevented 已经是 true。真机上对应"更早注入 / 更外层"的宿主脚本。
  win.addEventListener('selectstart', event => {
    if (event.target && event.target.closest && event.target.closest('.pix-trans')) {
      event.preventDefault()
    }
  }, true)

  const evt = new win.Event('selectstart', { bubbles: true, cancelable: true })
  box.dispatchEvent(evt)

  const sel = win.getSelection()
  assert.ok(sel && sel.rangeCount > 0, '兜底没有建立任何选区 —— 译文仍然复制不出来')
  const picked = sel.toString()
  assert.match(picked, /这段译文必须能被整段复制走/,
    '兜底选区没有覆盖译文内容，得到：' + JSON.stringify(picked))
})

test('译文框的 CSS 允许选中（两种前缀 + !important 都在）', () => {
  // 与行为测试互补：行为测试走 JS 事件路径，这条守住 CSS 的声明本身，
  // 因为宿主在**层叠**上禁选（纯 CSS）时只靠事件守卫拦不住。
  const rule = (guestSrc.match(/\.pix-trans\s*\{[\s\S]*?\n\s*\}/) || [''])[0]
  assert.ok(rule.length > 0, '找不到 .pix-trans 规则')
  assert.match(rule, /user-select:\s*text\s*!important/, '缺少不带前缀的 user-select: text !important')
  assert.match(rule, /-webkit-user-select:\s*text\s*!important/, '缺少带前缀的 -webkit-user-select: text !important')
})
