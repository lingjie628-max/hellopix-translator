'use strict'

/**
 * 译文/正文的**复制、粘贴、全选** —— 真 Electron 机制验收。
 *
 * 跑法（在 desktop/ 目录下）：
 *   npm run verify:copy
 *   （等价于 env -u ELECTRON_RUN_AS_NODE electron scripts/verify-copy-paste-electron.js）
 *
 * ## 为什么必须用真 Electron
 *
 * 真机现象：聊天窗口里的中文译文**看得见、选不中**，复制更是没反应。
 * 根因不在网页 CSS，而在 **Electron 的编辑快捷键转发**：
 *
 *   · 聊天应用跑在 `WebContentsView` 里，不是主窗口 DOM；
 *   · Electron **不会**把 `Cmd/Ctrl+C` / `V` / `A` 自动作用到嵌入的
 *     webContents —— 它们要靠应用程序菜单的编辑角色（role: 'copy' …）
 *     转发到当前聚焦的 webContents；
 *   · 本应用为隐藏菜单栏调了 `setMenuBarVisibility(false)`，且从未注册任何
 *     编辑角色 → 三样（复制/粘贴/全选）全缺；
 *   · `WebContentsView` 默认**不弹**系统右键菜单 → 连鼠标复制也没有。
 *
 * 这一点**只有真实 Chromium 能复现**：jsdom 里没有剪辑板、没有
 * `before-input-event`、也没有 WebContentsView。本脚本用真 Chromium +
 * **从 main.js 切出来的真源码**（不是复制一份实现）跑完整链路。
 *
 * ## 被测的东西（不是模拟品）
 *
 *   · `runEditCommand()` / `installEditSupport()`：**按花括号配对从
 *     desktop/main.js 切出真身**，原样作用到真的 WebContentsView；
 *   · 页面：一个**复刻 WhatsApp 禁选行为**的 mock —— 气泡上打
 *     `user-select: none`、并在 selectstart 上 preventDefault，
 *     用来证明"就算宿主禁选，我们的编辑命令仍能把译文复制出来"。
 *
 * 退出码：0 = 全部通过；1 = 有项不通过；2 = 脚本自身异常。
 */

const { app, BrowserWindow, WebContentsView, Menu, clipboard } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.join(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8')

const rows = []
function check (name, pass, detail) {
  rows.push({ name, pass: !!pass, detail: detail })
  console.log((pass ? '  ✔ ' : '  ✖ ') + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)))
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 按花括号配对，把 main.js 里某个函数的真身整段切出来（与单测同法）。 */
function sliceBlock (src, header) {
  const start = src.indexOf(header)
  if (start < 0) throw new Error('找不到源码片段：' + header)
  const lineEnd = src.indexOf('\n', start)
  const line = src.slice(start, lineEnd)
  const open = line.indexOf('{')
  if (open < 0) return line
  let depth = 0
  for (let i = start + open; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error('花括号不配对：' + header)
}

// ---------------------------------------------------------------------------
// mock WhatsApp 页面：宿主对正文与气泡**双重禁选**（复刻真机）
// ---------------------------------------------------------------------------
const ZH = '你好，这是一段需要复制的译文'
function mockHtml () {
  return `<!doctype html><html><head><meta charset="utf-8"><title>mock wa copy</title>
<style>
  /* 复刻宿主：气泡整体禁选，只对 .selectable-text 开选（Word 老构建的做法） */
  .copyable-text { user-select: none; -webkit-user-select: none; }
  .selectable-text { user-select: text; -webkit-user-select: text; }
  /* guest-inject.js 注入的修复：把译文框的选中权抢回来。
     没有这一条时，Chromium 在 user-select:none 的子树里**拒绝**建立选区
     （getSelection() 返回空串）—— 译文根本选不中。这一条是另一半。 */
  .pix-trans { user-select: text !important; -webkit-user-select: text !important; -webkit-user-drag: none; pointer-events: auto; }
</style></head><body>
<div id="main"><div id="msg-list">
  <div data-id="row-1" class="message-in">
    <div class="copyable-text">
      <span class="selectable-text">Hello there</span>
      <div class="pix-trans">${ZH}</div>
    </div>
  </div>
</div></div>
<script>
  // 复刻宿主：在气泡层捕获 selectstart 并 preventDefault（真机上确实有这种构建）。
  document.querySelector('.copyable-text').addEventListener('selectstart', function (e) {
    if (e.target.closest && e.target.closest('.copyable-text')) e.preventDefault()
  }, true)
  window.__mock = {
    // 供脚本回读：能不能用程序把译文设成"已选中"
    selectTrans () {
      var box = document.querySelector('.pix-trans')
      var sel = window.getSelection()
      var r = document.createRange()
      r.selectNodeContents(box)
      sel.removeAllRanges(); sel.addRange(r)
      return sel.toString()
    }
  }
</script>
</body></html>`
}

async function main () {
  const tmpHtml = path.join(os.tmpdir(), 'pix-copy-verify-' + process.pid + '.html')
  fs.writeFileSync(tmpHtml, mockHtml(), 'utf8')

  const win = new BrowserWindow({ show: false, width: 900, height: 600 })
  // 键盘路径（sendInputEvent → before-input-event）只在窗口**聚焦时**才有意义。
  // 隐藏窗口不会成为 key window，事件会被丢弃 —— 这是 Electron 测试的既有坑。
  // 真机上窗口当然是聚焦的，这里显式 show + focus 复刻真实状态。
  win.show()
  win.focus()
  win.webContents.focus()
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  win.contentView.addChildView(view)
  win.contentView.setBounds({ x: 0, y: 0, width: 900, height: 600 })
  view.setBounds({ x: 0, y: 0, width: 900, height: 600 })

  // ---- 用从 main.js 切出来的**真身**组装编辑支持 ----
  const runEditCommandSrc = sliceBlock(mainSrc, 'function runEditCommand(wc, action)')
  const installEditSupportSrc = sliceBlock(mainSrc, 'function installEditSupport(view)')
  const clientLog = null
  const runEditCommand = new Function('clientLog', 'return (' + runEditCommandSrc + ')')(clientLog)
  // installEditSupport 内部会调用 runEditCommand —— 必须把它一并放进闭包，
  // 否则切出来的函数体里 runEditCommand 未定义。
  const installEditSupport = new Function('clientLog', 'Menu', 'win', 'runEditCommand',
    'return (' + installEditSupportSrc + ')')(clientLog, Menu, win, runEditCommand)
  installEditSupport(view)

  await view.webContents.loadFile(tmpHtml)
  await sleep(200)

  // ---- ① 编辑支持是否被装上（快捷键处理器必须在）----
  console.log('\n── ① 编辑支持装载')
  const listenerCount = view.webContents.listenerCount('before-input-event')
  check('① installEditSupport 挂上了 before-input-event（编辑快捷键前置拦截）',
    listenerCount >= 1, listenerCount)
  check('① 挂上了 context-menu（右键复制/粘贴）',
    view.webContents.listenerCount('context-menu') >= 1, view.webContents.listenerCount('context-menu'))

  // ---- ② 程序选中译文 + Cmd/Ctrl+C → 剪辑板必须拿到译文 ----
  console.log('\n── ② 复制：选中译文后按复制')
  clipboard.writeText('__before__')
  const selected = await view.webContents.executeJavaScript('window.__mock.selectTrans()')
  check('② 译文被选中（选区内容 = 译文）', selected === ZH, selected)

  // 走真 before-input-event 路径：直接把一个 keyDown 事件交给 view 的
  // before-input-event 监听器（我们注册的那个）。真机上这一步由 OS 键盘产生 ——
  // 自动化里 sendInputEvent 在无真实键盘焦点的环境不可靠（隐藏/非 key 窗口会丢），
  // 所以这里直接投递到监听器，验证的是**我们的处理器行为**本身。
  const mod = process.platform === 'darwin' ? 'meta' : 'control'
  const emitKey = (key, modifiers) => {
    // EventEmitter 只暴露 on；用 emit 模拟 Electron 的投递。
    view.webContents.emit('before-input-event',
      { preventDefault () { this._pd = true }, _pd: false },
      { type: 'keyDown', key: key, [modifiers.indexOf('meta') >= 0 ? 'meta' : 'control']: true })
  }
  emitKey('c', [mod])
  await sleep(250)
  const copied = clipboard.readText()
  check('② Cmd/Ctrl+C 把译文复制进了剪辑板', copied === ZH, copied)

  // ---- ③ 直接走 wc.copy() 兜底通道（菜单角色最终也落到这里）----
  console.log('\n── ③ 复制：wc.copy() 编辑命令通道')
  clipboard.writeText('__before2__')
  await view.webContents.executeJavaScript('window.__mock.selectTrans()')
  runEditCommand(view.webContents, 'copy')
  await sleep(150)
  const copied2 = clipboard.readText()
  check('③ webContents.copy() 同样把译文复制进剪辑板', copied2 === ZH, copied2)

  // ---- ④ 全选：Cmd/Ctrl+A 必须真的全选（宿主没装编辑角色时这一步此前根本无效）----
  console.log('\n── ④ 全选：Cmd/Ctrl+A')
  await view.webContents.executeJavaScript('window.getSelection().removeAllRanges(); true')
  emitKey('a', [mod])
  await sleep(200)
  const selNow = await view.webContents.executeJavaScript('window.getSelection().toString()')
  check('④ Cmd/Ctrl+A 建立了非空选区（全选生效）', String(selNow).length > 0, selNow)

  // ---- ⑤ 粘贴：往可编辑框里 Cmd/Ctrl+V ----
  console.log('\n── ⑤ 粘贴：Cmd/Ctrl+V')
  await view.webContents.executeJavaScript(
    'var i=document.createElement("div");i.id="ed";i.contentEditable="true";' +
    'i.style.cssText="position:fixed;top:0;left:0;width:200px;height:40px";document.body.appendChild(i);' +
    'var r=document.createRange();r.selectNodeContents(i);var s=window.getSelection();s.removeAllRanges();s.addRange(r);' +
    'document.getElementById("ed").focus();true')
  clipboard.writeText('粘贴测试文本')
  emitKey('v', [mod])
  await sleep(250)
  const pasted = await view.webContents.executeJavaScript('document.getElementById("ed").textContent')
  check('⑤ Cmd/Ctrl+V 把剪辑板内容粘进了可编辑框', String(pasted).indexOf('粘贴测试文本') >= 0, pasted)

  // ---- ⑥ 非译文区域不受影响：普通文本的复制不被我们的处理器搞坏 ----
  console.log('\n── ⑥ 不越界：普通区域照旧')
  clipboard.writeText('__before3__')
  await view.webContents.executeJavaScript(
    'var s=window.getSelection();s.removeAllRanges();var r=document.createRange();' +
    'r.selectNodeContents(document.querySelector(".selectable-text"));s.addRange(r);true')
  emitKey('c', [mod])
  await sleep(200)
  const copied3 = clipboard.readText()
  check('⑥ 选中原始消息（非译文）也能正常复制', copied3 === 'Hello there', copied3)

  // ---- 汇总 ----
  const failed = rows.filter(r => !r.pass)
  console.log('\n' + '='.repeat(70))
  console.log(' 复制/粘贴/全选验收：' + (rows.length - failed.length) + ' / ' + rows.length + ' 项通过')
  if (failed.length) console.log(' ✖ FAIL：' + failed.map(r => r.name).join(' | '))
  else console.log(' ✔ 全部通过：编译进 WebContentsView 的编辑命令能把译文复制出来')
  console.log('='.repeat(70))

  try { fs.unlinkSync(tmpHtml) } catch (e) {}
  app.exit(failed.length ? 1 : 0)
}

app.whenReady().then(() => {
  main().catch(err => {
    console.error('脚本异常：', err)
    app.exit(2)
  })
})
