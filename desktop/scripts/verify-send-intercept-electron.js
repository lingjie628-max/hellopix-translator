'use strict'

/**
 * 发送拦截 —— **真 Electron / 真 Chromium** 机制验收。
 *
 * 跑法（在 desktop/ 目录下）：
 *   npm run verify:send-intercept
 *
 * ## 为什么必须用真 Electron
 *
 * 这次要验的是「**图文一起发送的时候，不翻译**」——文字原样出网、消息还发成功了。
 * 这条链的每一环都是**浏览器实现细节**，jsdom 给不出可信结论：
 *
 *   · `isContentEditable` 在 jsdom 里是 `undefined`，在真 Chromium 里是 `true`。
 *     这正是"修了却没修好"的关键差别：**必须用真实现跑**，否则会得出相反结论。
 *   · 焦点（`document.activeElement`）、`contenteditable` 的真实布局、
 *     Enter 在 contenteditable 里产生的 `beforeinput`，都只有真浏览器才算数。
 *
 * ## 被测的东西（不是模拟品）
 *
 *   · `composerEl()` / `boxFromEvent()` / `sendTargetBox()` / `isEditableEl()` /
 *     `eventInComposer()` —— **按花括号配对从 desktop/guest-inject.js 切出真身**，
 *     原样注入真页面执行；
 *   · 页面：一个复刻 WhatsApp「附件预览面板」的 mock —— footer 里有**两个**
 *     contenteditable（媒体标题框在前、caption 框在后），发送按钮不带
 *     `aria-label="Send"`、只有 `data-testid`。
 *
 * ## 三个场景（对应真机三种现场）
 *
 *   1. 焦点在 caption 框（附加后焦点跟着走）→ 必须命中 caption；
 *   2. 焦点**不在** caption 框（用户先打字后附加图片）→ 仍必须命中 caption
 *      （这是老实现**静默放行**的现场）；
 *   3. 事件发生在媒体标题框里 → 不许被误当成正文（防反向回归）。
 *
 * 退出码：0 = 全部通过；1 = 有项不通过；2 = 脚本自身异常。
 */

const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const guestSrc = fs.readFileSync(path.join(root, 'guest-inject.js'), 'utf8')

const rows = []
function check (name, pass, detail) {
  rows.push({ name, pass: !!pass, detail })
  console.log((pass ? '  ✔ ' : '  ✖ ') + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)))
}

// 真身切片：全部来自 desktop/guest-inject.js，不是这里重写的实现。
const FN_NAMES = ['visible', 'isEditableEl', 'firstMatch', 'composerEl', 'eventInComposer', 'boxFromEvent', 'sendTargetBox']

/** 按花括号配对，把 guest-inject.js 里某个函数的真身整段切出来（与单测同法）。 */
function sliceFn (src, header) {
  const start = src.indexOf(header)
  if (start < 0) throw new Error('找不到源码片段：' + header)
  const lineEnd = src.indexOf('\n', start)
  const line = src.slice(start, lineEnd)
  const open = line.indexOf('{')
  if (open < 0) return line
  const braceLineStart = start + open
  let depth = 0
  let i = braceLineStart
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) { i++; break }
    }
  }
  return src.slice(start, i)
}

/** 函数声明可能写成 `function f (x)` 或 `function f(x)`，两种都认。 */
function sliceFnLoose (src, name) {
  const variants = ['function ' + name + ' (', 'function ' + name + '(']
  for (const v of variants) {
    if (src.indexOf(v) >= 0) return sliceFn(src, v)
  }
  throw new Error('找不到函数：' + name)
}

function collectFns () {
  return FN_NAMES.map(n => sliceFnLoose(guestSrc, n)).join('\n\n')
}

/** 附件预览面板 mock：两个 contenteditable，标题框在前、caption 框在后。 */
const PAGE_HTML = `<!doctype html><html><body>
<div id="main">
  <div id="msg-list"></div>
  <footer>
    <div id="media-editor">
      <div id="media-title" contenteditable="true" role="textbox" aria-label="Add a caption"></div>
      <div id="editable-message-text" contenteditable="true" role="textbox" aria-label="Type a message"></div>
    </div>
    <button id="attach-send" data-testid="media-editor-send"></button>
  </footer>
</div>
</body></html>`

/** 把真源码函数注入页面，并暴露一个探测入口。 */
const PROBE = `
window.__pixCanonicalize = function (name) {
  var found = window[name]
  return found
}
`

async function main () {
  console.log('\n=== 发送拦截 · 真 Electron / 真 Chromium 验收 ===\n')

  let fns = ''
  try {
    fns = collectFns()
    for (const n of FN_NAMES) {
      check('切出真身源码：' + n + '()', /function\s+/.test(sliceFnLoose(guestSrc, n)))
    }
  } catch (e) {
    check('切出真身源码', false, String(e && e.message))
    console.log('\n=== 结果：0 / ' + rows.length + ' 通过 ===')
    return 2
  }

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false }
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE_HTML))

  // 注入真源码 + 一个可调用的探测函数。
  const probe = `
${fns}

// 真源码里 trace() 会往 console 打结构化日志，这里给个静默替身，
// 只记录最后一条，供断言用（不影响被测逻辑）。
var __traces = []
function trace (event, extra) { __traces.push({ event: event, extra: extra || {} }) }

window.__pix = {
  composerEl: composerEl,
  boxFromEvent: boxFromEvent,
  sendTargetBox: sendTargetBox,
  isEditableEl: isEditableEl,
  eventInComposer: eventInComposer,
  traces: function () { return __traces.slice() },
  reset: function () { __traces = [] }
};
undefined
`
  await win.webContents.executeJavaScript(probe)

  const pre = await win.webContents.executeJavaScript(`({
    hasComposerEl: typeof window.__pix.composerEl === 'function',
    hasSendTargetBox: typeof window.__pix.sendTargetBox === 'function',
    editableTitle: document.getElementById('media-title').isContentEditable,
    editableCaption: document.getElementById('editable-message-text').isContentEditable,
    editableCount: document.querySelectorAll('#media-editor [contenteditable="true"]').length
  })`)
  check('真 Chromium 里 isContentEditable 可用（jsdom 里是 undefined）',
    pre.editableTitle === true && pre.editableCaption === true, pre)
  check('页面里存在 2 个 contenteditable（附件预览面板形状）',
    pre.editableCount === 2, { count: pre.editableCount })

  // ---- 场景 1：焦点在 caption 框 ----
  const s1 = await win.webContents.executeJavaScript(`(() => {
    window.__pix.reset()
    const cap = document.getElementById('editable-message-text')
    cap.focus()
    cap.textContent = '这张图很好看'
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    cap.dispatchEvent(ev)
    const box = window.__pix.composerEl()
    const tgt = window.__pix.sendTargetBox(ev)
    return {
      focusedId: document.activeElement.id,
      composerId: box && box.id,
      targetId: tgt && tgt.id,
      inComposer: box ? window.__pix.eventInComposer(ev, box) : false,
      inTarget: tgt ? window.__pix.eventInComposer(ev, tgt) : false
    }
  })()`)
  check('场景1 焦点在 caption：composerEl 命中 caption',
    s1.composerId === 'editable-message-text', s1)
  check('场景1 sendTargetBox 命中 caption，且事件判定在框内',
    s1.targetId === 'editable-message-text' && s1.inTarget === true, s1)

  // ---- 场景 2：焦点**不在** caption 框（真机最可能的现场）----
  const s2 = await win.webContents.executeJavaScript(`(() => {
    window.__pix.reset()
    const title = document.getElementById('media-title')
    const cap = document.getElementById('editable-message-text')
    title.focus()                      // 焦点故意留在别的框上
    cap.textContent = '这张图很好看'
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    cap.dispatchEvent(ev)              // 但事件发生在 caption
    const box = window.__pix.composerEl()
    const tgt = window.__pix.sendTargetBox(ev)
    return {
      focusedId: document.activeElement.id,
      composerId: box && box.id,
      targetId: tgt && tgt.id,
      oldPathWouldIntercept: box ? window.__pix.eventInComposer(ev, box) : false,
      newPathIntercepts: tgt ? window.__pix.eventInComposer(ev, tgt) : false,
      traces: window.__pix.traces().map(t => t.event)
    }
  })()`)
  check('场景2 前置：焦点确实不在 caption（模拟"先打字后附加图片"）',
    s2.focusedId === 'media-title', s2)
  check('场景2 旧路径（只看焦点）会**漏判**——这正是静默放行的根因',
    s2.oldPathWouldIntercept === false, { oldPathWouldIntercept: s2.oldPathWouldIntercept })
  check('场景2 新路径 sendTargetBox 命中 caption，事件判定在框内',
    s2.targetId === 'editable-message-text' && s2.newPathIntercepts === true, s2)

  // ---- 场景 3：事件发生在媒体标题框 → 不许被误当成正文 ----
  const s3 = await win.webContents.executeJavaScript(`(() => {
    window.__pix.reset()
    const title = document.getElementById('media-title')
    title.focus()
    title.textContent = 'IMG_2043.HEIC'
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    title.dispatchEvent(ev)
    const tgt = window.__pix.sendTargetBox(ev)
    return { targetId: tgt && tgt.id }
  })()`)
  check('场景3 事件在标题框：解析出的就是标题框自己（调用方据此不会误翻 caption）',
    s3.targetId === 'media-title', s3)

  win.destroy()

  const failed = rows.filter(r => !r.pass)
  console.log('\n=== 结果：' + (rows.length - failed.length) + ' / ' + rows.length + ' 通过 ===')
  if (failed.length) {
    console.log('\n未通过：')
    for (const f of failed) console.log('  ✖ ' + f.name)
    return 1
  }
  console.log('\n真 Chromium 机制验收全部通过。\n')
  return 0
}

app.whenReady().then(async () => {
  let code = 2
  try {
    code = await main()
  } catch (e) {
    console.error('\n[verify-send-intercept] 脚本异常：', e && e.stack ? e.stack : e)
    code = 2
  }
  app.exit(code)
}).catch(e => {
  console.error('[verify-send-intercept] 启动失败：', e && e.stack ? e.stack : e)
  app.exit(2)
})
