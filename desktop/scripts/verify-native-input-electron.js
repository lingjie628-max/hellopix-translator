'use strict'

/**
 * composer 原生输入的**真机机制验收**（需要真 Electron，不能在纯 Node / jsdom 下跑）。
 *
 * 跑法（在 desktop/ 目录下）：
 *   npm run verify:native-input
 *   （等价于 env -u ELECTRON_RUN_AS_NODE electron scripts/verify-native-input-electron.js）
 *
 * ## 为什么必须用真 Electron
 *
 * 0.1.18 真机日志把根因钉死在**事件可信性**上：
 *
 *     expected : len=29 hash=33aaf90e  "Test translation information."
 *     actual   : len=6  hash=3a49c2d5  "测试翻译信息"
 *     writeMethod:"execCommand:insertText"   sawBeforeInput:false   sawInput:true
 *
 * 页面内 `execCommand` 产生的事件 `isTrusted === false`，WhatsApp 的编辑器在
 * **祖先捕获阶段**就把它们拦掉了 —— 所以写入从未进入编辑器的输入管线，正文原地不动。
 * 这一点**只有真实 Chromium 能复现**：jsdom 里没有可信事件的概念，
 * `isTrusted` 永远是 false，测不出区别。这个脚本用真 Chromium + 真 preload
 * （就是生产那个 `guest-inject.js`）+ 生产 `native-composer.js` 跑完整链路。
 *
 * ## 被测的东西（不是模拟品）
 *
 *   · `guest-inject.js`：**直接作为 WebContentsView 的 preload 装载**，一行不改；
 *   · `native-composer.js`：本脚本的 IPC handler 直接调用它的生产函数；
 *   · `canonicalizeSendBody()` / 沉降轮询 / fail-closed：都在 guest 里跑；
 *   · 页面：一个**复刻 WhatsApp 编辑器行为**的 mock（见 mockHtml 里的注释）：
 *       非可信 beforeinput 在祖先捕获阶段被吞掉并按内部 state 重画 DOM，
 *       可信输入则被编辑器接受。这正是真机的失败/成功分界。
 *
 * 退出码：0 = 全部验收通过；1 = 有项不通过；2 = 脚本自身异常。
 */

const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const nativeComposer = require('../native-composer')

const EN = 'Test translation information.'
const ZH = '测试翻译信息'

const rows = []
function check (name, pass, detail) {
  rows.push({ name, pass: !!pass, detail: detail })
  console.log((pass ? '  ✔ ' : '  ✖ ') + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)))
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// mock WhatsApp 页面
// ---------------------------------------------------------------------------
function mockHtml () {
  return `<!doctype html><html><head><meta charset="utf-8"><title>mock wa</title></head><body>
<div id="main"><div id="msg-list"></div><footer>
  <div id="editable-message-text" contenteditable="true" role="textbox" aria-label="Type a message"></div>
  <button id="send-btn" aria-label="Send" data-icon="wds-ic-send-filled"><span></span></button>
</footer></div>
<script>
(function () {
  var el = document.getElementById('editable-message-text')
  var sent = []
  // 编辑器内部状态 —— 真机上"会被发出去的那一份"就在这儿，DOM 只是它的投影。
  var model = ''
  // 编辑器"认可的一次原生输入"：只有**可信的 beforeinput** 才算。
  // 这是真机上两条路径的唯一分界 —— 见下面 listener 的注释。
  var trustedEditPending = false

  function renderFromModel () { if (el.textContent !== model) el.textContent = model }

  // ★ 复刻 WhatsApp / Lexical 的真实行为 ★
  //   ① 非可信（isTrusted=false）的 beforeinput 在**祖先捕获阶段**被吞掉：
  //      preventDefault + stopPropagation → composer 自己的监听收不到；
  //      这正是真机日志里的 sawBeforeInput:false。
  //   ② 只有"收到过可信 beforeinput"的那次改动才被编辑器接受并写进内部 state；
  //      其它任何来源的 DOM 变动都被视为异物，**立刻用内部 state 盖回去**。
  //      这就是真机 actual 永远等于原文的原因。
  var sawUntrustedInput = false
  document.addEventListener('beforeinput', function (e) {
    if (e.isTrusted) { trustedEditPending = true; return }
    e.preventDefault()
    e.stopPropagation()
    renderFromModel()
  }, true)

  el.addEventListener('input', function (e) {
    if (!e.isTrusted) sawUntrustedInput = true
    if (trustedEditPending) {
      trustedEditPending = false
      model = el.textContent          // 认可：编辑器 state 跟着走
      return
    }
    renderFromModel()                 // 不认可：用内部 state 盖回去
  })

  // 调和循环：真机就是它在下一次 render 时把外部改的 DOM 盖掉。
  setInterval(renderFromModel, 60)

  // 原生发送：挂在**冒泡阶段**（与真机一致）—— guest 必须在捕获阶段拦住它。
  function nativeSend () {
    var t = el.textContent
    if (!String(t || '').trim()) return
    sent.push(t)
    model = ''
    renderFromModel()
  }
  el.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) nativeSend()
  })
  document.getElementById('send-btn').addEventListener('click', nativeSend)

  window.__mock = {
    setUserText: function (t) { model = String(t == null ? '' : t); renderFromModel(); return model },
    getModel: function () { return model },
    domText: function () { return el.textContent },
    sent: sent,
    // 对照实验：0.1.18 的写入方式（页面内改 DOM）。用来看它到底生不生效。
    legacyDomWrite: function (t) {
      var sel = window.getSelection()
      var r = document.createRange()
      r.selectNodeContents(el)
      sel.removeAllRanges()
      sel.addRange(r)
      var sawBeforeInput = false
      var sawInput = false
      var onBI = function () { sawBeforeInput = true }
      var onI = function () { sawInput = true }
      el.addEventListener('beforeinput', onBI, true)
      el.addEventListener('input', onI, true)
      var ok = document.execCommand('insertText', false, String(t))
      el.removeEventListener('beforeinput', onBI, true)
      el.removeEventListener('input', onI, true)
      return {
        execCommandReturned: ok,
        sawBeforeInputOnComposer: sawBeforeInput,
        sawInputOnComposer: sawInput,
        domImmediatelyAfter: el.textContent,
        modelRightAfter: model
      }
    },
    // 调和循环跑过之后的最终结果（真机上"过一会儿再看就恢复成原文了"）。
    snapshotAfterSettle: function () {
      return { domAfterSettle: el.textContent, modelAfterSettle: model, sawUntrustedInput: sawUntrustedInput }
    }
  }
})()
</script>
</body></html>`
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main () {
  console.log('='.repeat(70))
  console.log(' composer 原生输入 · 真 Electron 机制验收')
  console.log('='.repeat(70))

  const tmpHtml = path.join(os.tmpdir(), 'pix-native-input-mock.html')
  fs.writeFileSync(tmpHtml, mockHtml(), 'utf8')

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 640,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  })

  const view = new WebContentsView({
    webPreferences: {
      // ★ 直接装生产 preload，一行不改 ★
      preload: path.join(__dirname, '..', 'guest-inject.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 900, height: 640 })
  const wc = view.webContents

  // trace 采集：与生产同源 —— guest 的 console.info 就是真机日志的输入。
  // Electron 33 的 console-message 是老签名 (event, level, message, line, sourceId)。
  const traces = []
  wc.on('console-message', (...args) => {
    let message
    if (args.length === 1 && args[0] && typeof args[0] === 'object') message = args[0].message
    else message = args[2]
    const line = String(message == null ? '' : message)
    if (line.indexOf('[PIX_TRACE]') !== -1) {
      traces.push(line)
      console.log('    ' + line)
    } else if (process.env.PIX_VERBOSE) {
      console.log('    [guest] ' + line)
    }
  })
  wc.on('preload-error', (_e, preloadPath, error) => {
    console.error('    [preload-error] ' + path.basename(String(preloadPath)) + '：' + ((error && error.message) || error))
  })

  // ---- 与生产 main.js 完全同款的 IPC 面 ----
  const bridge = { prefsAsked: 0, told: 0, traceSeen: false }
  ipcMain.handle('translate:guestPrefs', () => {
    bridge.prefsAsked++
    bridge.traceSeen = true
    return {
      transRecv: true, transSend: true, transGroup: false,
      langMine: 'auto', langOther: 'auto', sendTo: 'en',
      includeZh: false, antiRevoke: false,
      // 刻意开满 500ms 观察窗：本脚本要采到 0/100/300/500 的漂移证据。
      sendSettleMs: 500,
      tabId: 'verify-native-input', partition: 'verify', engine: 'gpt'
    }
  })
  ipcMain.handle('translate:run', (_e, payload) => {
    console.log('    [translate:run] trigger=' + (payload && payload.trigger) +
      ' chars=' + String((payload && payload.text) || '').length)
    return { success: true, translation: EN, requestId: 'verify' }
  })
  ipcMain.handle('customer:ingest', () => ({ ok: true }))
  ipcMain.handle('translate:savePrefs', () => ({ success: true }))
  ipcMain.handle('translate:engines', () => ({ success: true, rows: [] }))
  // ★ 生产原生输入通道：直接调用生产模块 ★
  ipcMain.handle('translate:composerSelectAllDelete', () => nativeComposer.selectAllAndClear(wc))
  ipcMain.handle('translate:composerInsertText', (_e, payload) => {
    const text = String((payload && payload.text) || '')
    return (payload && payload.linewise)
      ? nativeComposer.insertTextLines(wc, text)
      : nativeComposer.insertText(wc, text)
  })

  /** 等同于用户点了输入框：把焦点放进 composer，否则键盘事件到不了它。 */
  async function focusComposer () {
    await wc.executeJavaScript(
      '(function(){var e=document.getElementById("editable-message-text");if(e)e.focus();return document.activeElement&&document.activeElement.id})()'
    )
    wc.focus()
    await sleep(80)
  }

  await wc.loadFile(tmpHtml)
  await sleep(400)

  // ---- ① 对照实验：0.1.18 的写法（页面内 execCommand）到底生不生效 ----
  console.log('\n── ① 对照：页面内 execCommand 写入（0.1.18 的做法）')
  await wc.executeJavaScript('window.__mock.setUserText(' + JSON.stringify(ZH) + ')')
  const legacy = await wc.executeJavaScript(
    'window.__mock.legacyDomWrite(' + JSON.stringify(EN) + ')'
  )
  console.log('    execCommand 返回=' + legacy.execCommandReturned +
    ' · composer 收到 beforeinput=' + legacy.sawBeforeInputOnComposer +
    ' · 收到 input=' + legacy.sawInputOnComposer +
    ' · 写完后 DOM=' + JSON.stringify(legacy.domImmediatelyAfter) +
    ' · 编辑器 state=' + JSON.stringify(legacy.modelRightAfter))
  // 等调和循环跑过（真机上"过一会儿再看就变回原文了"
  await sleep(250)
  const legacyLate = await wc.executeJavaScript('window.__mock.snapshotAfterSettle()')
  console.log('    +250ms 之后 DOM=' + JSON.stringify(legacyLate.domAfterSettle) +
    ' · 编辑器 state=' + JSON.stringify(legacyLate.modelAfterSettle) +
    ' · 编辑器收到过不可信 input=' + legacyLate.sawUntrustedInput)
  check('① 页面内 execCommand 报成功，但 beforeinput 到不了 composer（sawBeforeInput=false）',
    legacy.execCommandReturned === true && legacy.sawBeforeInputOnComposer === false, legacy)
  check('① 真机同款：写完之后回读到的正文**就是原文**（actual=原文）',
    legacy.domImmediatelyAfter === ZH && legacyLate.domAfterSettle === ZH &&
    legacyLate.modelAfterSettle === ZH,
    {
      写完后立刻回读: legacy.domImmediatelyAfter,
      '250ms后回读': legacyLate.domAfterSettle,
      编辑器state: legacyLate.modelAfterSettle
    })
  check('① 真机日志同款症状齐了：execCommand=true / sawBeforeInput=false / sawInput=true',
    legacy.execCommandReturned === true && legacy.sawBeforeInputOnComposer === false &&
    legacy.sawInputOnComposer === true, legacy)
  check('① 差异确实不是"比较太严格"：DOM 里根本没有出现过译文',
    legacy.domImmediatelyAfter.indexOf(EN) < 0 && legacyLate.domAfterSettle.indexOf(EN) < 0,
    { immediately: legacy.domImmediatelyAfter, settled: legacyLate.domAfterSettle })

  // ---- ② 生产链路：原生输入（真 Enter → 真原生插入 → 校验 → 发送）----
  console.log('\n── ② 生产链路：真 Enter → 原生输入 → 校验 → 发送')
  console.log('    翻译桥（生产 preload）已就绪=' + (bridge.prefsAsked > 0) +
    '（guest 主动问 prefs 次数=' + bridge.prefsAsked + '）')
  await wc.executeJavaScript('window.__mock.setUserText(' + JSON.stringify(ZH) + ')')
  await wc.executeJavaScript('window.__mock.sent.length = 0')
  traces.length = 0

  // 真键盘事件需要一个真正获得焦点的窗口 —— 隐藏窗口收不到输入；
  // 而且事件要落在 composer 上（等同于用户点了输入框），否则 guest 的
  // eventInComposer() 判定不通过。
  win.show()
  win.focus()
  await focusComposer()
  console.log('    焦点状态：window focused=' + win.isFocused() + ' · view focused=' + wc.isFocused())
  const seenKeys = []
  wc.on('before-input-event', (_e, input) => { seenKeys.push(input.type + ':' + input.key) })
  // 真键盘事件（浏览器进程发起）—— composer 的冒泡监听会被 guest 在捕获阶段拦住。
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  await sleep(300)
  console.log('    键盘事件是否送达 view：' + JSON.stringify(seenKeys))

  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (traces.some(t => t.indexOf('PROGRAMMATIC_SEND_DONE') >= 0)) break
    if (traces.some(t => t.indexOf('SEND_FAIL_CLOSED') >= 0)) break
    await sleep(50)
  }

  const sent = await wc.executeJavaScript('window.__mock.sent.slice()')
  const names = traces.map(t => (t.match(/\[PIX_TRACE\]\s+(\w+)/) || [])[1]).filter(Boolean)

  // ---- ③ 关键 trace 顺序：本轮要求的那条链 ----
  const REQUIRED = ['NATIVE_INPUT_BEGIN', 'COMPOSER_CLEARED', 'NATIVE_TEXT_INSERTED',
    'LEXICAL_SETTLED', 'FINAL_TEXT_VALIDATED', 'PROGRAMMATIC_SEND_DONE']
  console.log('\n── ③ 关键 trace 顺序')
  console.log('    实际序列：' + names.join(' → '))
  let cursor = -1
  let orderOk = true
  for (const ev of REQUIRED) {
    const at = names.indexOf(ev, cursor + 1)
    if (at < 0) { orderOk = false; break }
    cursor = at
  }
  check('③ NATIVE_INPUT_BEGIN → COMPOSER_CLEARED → NATIVE_TEXT_INSERTED → LEXICAL_SETTLED → FINAL_TEXT_VALIDATED → PROGRAMMATIC_SEND_DONE',
    orderOk, names.join(' → '))

  // FINAL_TEXT_VALIDATED 必须是 ok=true
  const validated = traces.find(t => t.indexOf('FINAL_TEXT_VALIDATED') >= 0) || ''
  check('③ FINAL_TEXT_VALIDATED ok=true', /"ok":true/.test(validated), validated)

  // ---- ④ 漂移时间线：0 / 100 / 300 / 500ms ----
  const samples = traces
    .filter(t => t.indexOf('COMPOSER_DRIFT_SAMPLE') >= 0)
    .map(t => {
      const get = k => { const m = t.match(new RegExp('"' + k + '":([^,}]+)')); return m ? m[1].replace(/"/g, '') : '' }
      return {
        mark: Number(get('mark')),
        t: Number(get('t')),
        len: Number(get('len')),
        hash: get('hash'),
        equal: get('equal') === 'true'
      }
    })
  console.log('\n── ④ 漂移时间线（原生插入之后逐点回读）')
  console.log('    ' + '标记'.padEnd(8) + '实测(ms)'.padEnd(12) + '长度'.padEnd(8) + 'hash'.padEnd(12) + '与译文一致')
  for (const s of samples) {
    console.log('    ' + (s.mark + 'ms').padEnd(8) + String(s.t).padEnd(12) + String(s.len).padEnd(8) + s.hash.padEnd(12) + s.equal)
  }
  const marks = samples.map(s => s.mark)
  check('④ 采到 0 / 100 / 300 / 500ms 四个漂移采样点',
    [0, 100, 300, 500].every(m => marks.indexOf(m) >= 0), marks)
  check('④ 观察窗内正文始终等于译文（没有任何晚期漂移）',
    samples.length > 0 && samples.every(s => s.equal === true),
    samples.map(s => s.equal))

  // ---- ⑤ 对方真的收到译文，且只收一次 ----
  console.log('\n── ⑤ 发送结果')
  console.log('    sent=' + JSON.stringify(sent))
  check('⑤ 对方收到且只收到一条，内容 = 译文', sent.length === 1 && sent[0] === EN, sent)
  check('⑤ 没有把中文原文发出去', sent.every(s => s.indexOf(ZH) < 0), sent)
  check('⑤ 没有把占位符发出去', sent.every(s => s.indexOf('正在翻译') < 0 && s.indexOf('busy') < 0), sent)

  // ---- ⑥ fail-closed：原生插入被拒时必须一个字节都不发 ----
  console.log('\n── ⑥ fail-closed：原生插入被拒 → 必须拦住')
  ipcMain.removeHandler('translate:composerInsertText')
  ipcMain.handle('translate:composerInsertText', () => ({ ok: true, chars: 0, injected: 'reject' }))
  await wc.executeJavaScript('window.__mock.setUserText(' + JSON.stringify(ZH) + ')')
  await wc.executeJavaScript('window.__mock.sent.length = 0')
  traces.length = 0
  await focusComposer()
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  const d2 = Date.now() + 12000
  while (Date.now() < d2) {
    if (traces.some(t => t.indexOf('SEND_FAIL_CLOSED') >= 0)) break
    if (traces.some(t => t.indexOf('PROGRAMMATIC_SEND_DONE') >= 0)) break
    await sleep(50)
  }
  const sent2 = await wc.executeJavaScript('window.__mock.sent.slice()')
  const mismatch = traces.find(t => t.indexOf('SEND_BODY_MISMATCH_DETAIL') >= 0) || ''
  const failClosed = traces.find(t => t.indexOf('SEND_FAIL_CLOSED') >= 0) || ''
  check('⑥ 原生插入不生效 → 一个字节都不发', sent2.length === 0, sent2)
  check('⑥ 留下 BODY_MISMATCH 取证', mismatch !== '', mismatch)
  check('⑥ 失败原因写明 BODY_MISMATCH（不是笼统文案）', /BODY_MISMATCH/.test(failClosed), failClosed)
  check('⑥ 取证里不含消息原文（否则整行会被日志脱敏器打掉）',
    mismatch !== '' && mismatch.indexOf(EN) < 0 && mismatch.indexOf(ZH) < 0, mismatch)

  // ---- 汇总 ----
  const failed = rows.filter(r => !r.pass)
  console.log('\n' + '='.repeat(70))
  console.log(' 原生输入验收：' + (rows.length - failed.length) + ' / ' + rows.length + ' 项通过')
  if (failed.length) console.log(' ✖ FAIL：' + failed.map(r => r.name).join(' | '))
  else console.log(' ✔ 全部通过：写入走的是 Chromium 原生输入，编辑器认可，正文无漂移')
  console.log('='.repeat(70))

  try { fs.unlinkSync(tmpHtml) } catch (e) {}
  app.exit(failed.length ? 1 : 0)
}

app.whenReady().then(() => {
  main().catch(err => {
    console.error('脚本自身异常：', (err && err.stack) || err)
    app.exit(2)
  })
})
