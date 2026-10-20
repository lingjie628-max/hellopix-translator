'use strict'

/**
 * 多实例并发验收：**A 窗口在等 AI 返回时，不能拖住 B 窗口**。
 *
 * 跑法（desktop/ 目录下）：
 *   npm run verify:concurrency
 *   env -u ELECTRON_RUN_AS_NODE electron scripts/verify-concurrency.js --api-ms 800 --windows 3
 *
 * ## 为什么必须真 Electron
 *
 * 三个"实例"就是三个 `WebContentsView`，各装一份**生产 preload**（guest-inject.js）。
 * 这正是真机上"多开时每个窗口独立处理翻译"的真实结构。用 jsdom 测不出这件事。
 *
 * ## 判定什么
 *
 * ① **不串行**：三个窗口同时按回车，若主进程把翻译请求排成一条队，
 *    总时长会接近 3×apiMs；并发则接近 1×apiMs + 客户端开销。
 * ② **不串消息**：每个窗口只应该收到**自己那条**的译文，绝不能收到别的窗口的。
 * ③ **不重复**：每个窗口恰好发出 1 条。
 * ④ **同一窗口内连发**：按顺序各发 1 条，不允许错发/丢发。
 */

const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const nativeComposer = require('../src/translate/native-composer')

function arg (name, dflt) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  return (v === undefined || v.startsWith('--')) ? true : v
}
const API_MS = Math.max(0, Number(arg('api-ms', 800)))
const WINDOWS = Math.max(2, Number(arg('windows', 3)))

const sleep = ms => new Promise(r => setTimeout(r, ms))
const rows = []
function check (name, pass, detail) {
  rows.push({ name: name, pass: !!pass })
  console.log((pass ? '  ✔ ' : '  ✖ ') + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)))
}

/** 每个实例一套 mock 页面：各自的 composer / sent / 编辑器 state。 */
function mockHtml (id) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>bench ${id}</title></head><body>
<div id="main"><footer>
  <div id="editable-message-text" contenteditable="true" role="textbox" aria-label="Type a message"></div>
  <button id="send-btn" aria-label="Send" data-icon="wds-ic-send-filled"><span></span></button>
</footer></div>
<script>
(function () {
  var el = document.getElementById('editable-message-text')
  var sent = []
  var model = ''
  var trustedEditPending = false
  function renderFromModel () { if (el.textContent !== model) el.textContent = model }
  document.addEventListener('beforeinput', function (e) {
    if (e.isTrusted) { trustedEditPending = true; return }
    e.preventDefault(); e.stopPropagation(); renderFromModel()
  }, true)
  el.addEventListener('input', function () {
    if (trustedEditPending) { trustedEditPending = false; model = el.textContent; return }
    renderFromModel()
  })
  setInterval(renderFromModel, 60)
  function nativeSend () {
    var t = el.textContent
    if (!String(t || '').trim()) return
    sent.push(t); model = ''; renderFromModel()
  }
  el.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) nativeSend()
  })
  document.getElementById('send-btn').addEventListener('click', nativeSend)
  window.__mock = {
    setUserText: function (t) { model = String(t == null ? '' : t); renderFromModel(); return model },
    sent: sent
  }
})()
</script>
</body></html>`
}

async function main () {
  console.log('='.repeat(78))
  console.log(' 多实例并发验收 · windows=' + WINDOWS + ' · 注入 API 延迟=' + API_MS + 'ms')
  console.log('='.repeat(78))

  const win = new BrowserWindow({
    show: false, width: 900, height: 640,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  })

  // 每个实例一份 trace 桶 + 一份"该实例发出的请求"
  const buckets = []
  const wcs = []
  const views = []

  // ★ IPC 必须先注册再 load：preload 一装载就会问 prefs，
  //   晚注册会让它拿不到实例设置（并发验收就失去意义）。
  const wcOf = sender => {
    for (let i = 0; i < wcs.length; i++) if (wcs[i].id === sender.id) return wcs[i]
    return null
  }
  ipcMain.handle('translate:guestPrefs', event => ({
    transRecv: true, transSend: true, transGroup: false,
    langMine: 'auto', langOther: 'auto', sendTo: 'en',
    includeZh: false, antiRevoke: false,
    sendSettleMs: 60, sendSettleCeilingMs: 400,
    tabId: 'win-' + (wcOf(event.sender) ? wcs.indexOf(wcOf(event.sender)) : '?'),
    partition: 'conc', engine: 'gpt'
  }))
  // 注入延迟，并把「这一条翻译属于哪个实例」编进译文，用来抓"串消息"。
  ipcMain.handle('translate:run', async (event, payload) => {
    const wc = wcOf(event.sender)
    const idx = wc ? wcs.indexOf(wc) : -1
    if (idx >= 0) buckets[idx].lastRequest = String((payload && payload.text) || '')
    await sleep(API_MS)
    return { success: true, translation: 'EN<w' + idx + '>' + String((payload && payload.text) || ''), requestId: 'conc' }
  })
  ipcMain.handle('customer:ingest', () => ({ ok: true }))
  ipcMain.handle('translate:savePrefs', () => ({ success: true }))
  ipcMain.handle('translate:engines', () => ({ success: true, rows: [] }))
  ipcMain.handle('translate:composerSelectAllDelete', event => {
    const wc = wcOf(event.sender)
    return wc ? nativeComposer.selectAllAndClear(wc) : { ok: false, reason: 'NO_WC' }
  })
  ipcMain.handle('translate:composerInsertText', (event, payload) => {
    const wc = wcOf(event.sender)
    if (!wc) return { ok: false, reason: 'NO_WC' }
    const text = String((payload && payload.text) || '')
    return (payload && payload.linewise) ? nativeComposer.insertTextLines(wc, text) : nativeComposer.insertText(wc, text)
  })

  for (let i = 0; i < WINDOWS; i++) {
    const tmpHtml = path.join(os.tmpdir(), 'pix-conc-' + i + '.html')
    fs.writeFileSync(tmpHtml, mockHtml(i), 'utf8')
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'guest-inject.js'),   // ★ 生产 preload
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
      }
    })
    win.contentView.addChildView(view)
    view.setBounds({ x: i * 300, y: 0, width: 300, height: 640 })
    const wc = view.webContents
    wcs.push(wc)
    views.push(view)
    const bucket = { id: i, traces: [], html: tmpHtml, wc: wc }
    buckets.push(bucket)
    wc.on('console-message', (...args) => {
      const message = (args.length === 1 && args[0] && typeof args[0] === 'object') ? args[0].message : args[2]
      const line = String(message == null ? '' : message)
      if (line.indexOf('[PIX_TRACE]') !== -1) bucket.traces.push(line)
    })
    wc.on('preload-error', (_e, p, error) => {
      console.error('    [preload-error] 实例' + i + ' ' + path.basename(String(p)) + '：' + ((error && error.message) || error))
    })
    await wc.loadFile(tmpHtml)
  }

  // ---- 生产同款 IPC 面（已在上方注册：必须在 load 之前）----
  win.show()
  win.focus()
  await sleep(400)

  async function focusComposer (wc) {
    await wc.executeJavaScript(
      '(function(){var e=document.getElementById("editable-message-text");if(e)e.focus();return document.activeElement&&document.activeElement.id})()'
    )
    await sleep(40)
  }

  // ---- ① 并发：三个窗口同时按回车 ----
  console.log('\n── ① 三个窗口同时按回车（每个窗口一条中文）')
  for (let i = 0; i < WINDOWS; i++) {
    buckets[i].traces.length = 0
    await wcs[i].executeJavaScript('window.__mock.setUserText("并发测试第' + i + '条，请三点开会")')
    await wcs[i].executeJavaScript('window.__mock.sent.length = 0')
    await focusComposer(wcs[i])
  }
  const t0 = Date.now()
  for (let i = 0; i < WINDOWS; i++) {
    wcs[i].focus()
    wcs[i].sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    wcs[i].sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  }
  // 等全部收口
  const deadline = Date.now() + API_MS + 12000
  while (Date.now() < deadline) {
    const done = buckets.slice(0, WINDOWS).every(b => b.traces.some(t => t.indexOf('SEND_PERF') >= 0))
    if (done) break
    await sleep(20)
  }
  const wall = Date.now() - t0

  const totals = []
  for (let i = 0; i < WINDOWS; i++) {
    const line = buckets[i].traces.find(t => t.indexOf('SEND_PERF') >= 0)
    totals.push(line ? JSON.parse(line.slice(line.indexOf('{'))).total : null)
  }
  const sentAll = []
  for (let i = 0; i < WINDOWS; i++) {
    sentAll.push(await wcs[i].executeJavaScript('window.__mock.sent.slice()'))
  }

  console.log('    并发总墙钟=' + wall + 'ms · 各窗口总耗时=' + JSON.stringify(totals))
  console.log('    各窗口收到=' + JSON.stringify(sentAll))

  check('① 每个窗口都恰好发出 1 条', sentAll.every(s => s.length === 1), sentAll.map(s => s.length))
  check('① 每个窗口收到的都是**自己那条**的译文（没有串消息）',
    sentAll.every((s, i) => s.length === 1 && s[0].indexOf('EN<w' + i + '>') === 0),
    sentAll)
  // 串行的话总墙钟 ≥ WINDOWS × API_MS；并发应当接近 1×API_MS + 客户端开销。
  const serialFloor = WINDOWS * API_MS
  check('① 没有把翻译请求排成一条队（并发，而不是串行）',
    wall < serialFloor,
    { 并发墙钟: wall, 串行下限: serialFloor })

  // ---- ② 同一窗口内连发 3 条：顺序安全 ----
  console.log('\n── ② 同一窗口内连发 3 条（不允许错发 / 丢发 / 重复）')
  const wc0 = wcs[0]
  buckets[0].traces.length = 0
  await wc0.executeJavaScript('window.__mock.sent.length = 0')
  const expect = []
  for (let n = 1; n <= 3; n++) {
    const txt = '连发第' + n + '条：请确认'
    expect.push('EN<w0>' + txt)
    await wc0.executeJavaScript('window.__mock.setUserText(' + JSON.stringify(txt) + ')')
    await focusComposer(wc0)
    wc0.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    wc0.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    // 等这一条真的发出去再发下一条（真实用户节奏）
    const dl = Date.now() + API_MS + 6000
    while (Date.now() < dl) {
      const s = await wc0.executeJavaScript('window.__mock.sent.slice()')
      if (s.length >= n) break
      await sleep(20)
    }
  }
  const sent0 = await wc0.executeJavaScript('window.__mock.sent.slice()')
  console.log('    窗口0 收到=' + JSON.stringify(sent0))
  check('② 连发 3 条：条数正确、顺序正确、内容一一对应',
    sent0.length === 3 && JSON.stringify(sent0) === JSON.stringify(expect),
    { expect: expect, actual: sent0 })

  const failed = rows.filter(r => !r.pass)
  console.log('\n' + '='.repeat(78))
  console.log(' 并发验收：' + (rows.length - failed.length) + ' / ' + rows.length + ' 项通过')
  if (failed.length) console.log(' ✖ FAIL：' + failed.map(r => r.name).join(' | '))
  else console.log(' ✔ 全部通过：多窗口互相不阻塞、不串消息、不重复')
  console.log('='.repeat(78))

  for (const b of buckets) { try { fs.unlinkSync(b.html) } catch (e) {} }
  app.exit(failed.length ? 1 : 0)
}

app.whenReady().then(() => {
  main().catch(err => {
    console.error('脚本自身异常：', (err && err.stack) || err)
    app.exit(2)
  })
})
