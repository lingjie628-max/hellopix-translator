'use strict'

/**
 * 「缩短沉降窗」的安全证明（真 Electron + 生产 preload）。
 *
 * 跑法（desktop/ 目录下）：
 *   npm run verify:settle-safety
 *
 * ## 为什么需要它
 *
 * 0.1.19 性能专项把沉降确认窗从"无条件等 500ms"改成"确认稳定即走"
 * （下限 60ms）。加速必须证明**不会**导致下面任何一种后果：
 *   · 原文泄露（把没翻译的中文发出去）
 *   · 占位符发送
 *   · 重复发送
 *   · 迟到漂移（编辑器在我们确认之后又把正文改回去）被当成合格内容发出去
 *
 * 本脚本用 mock 编辑器**故意**制造这些失败模式（包括"写入成功后再过一会儿
 * 才把正文改回原文"这种最阴险的迟到漂移），逐个验证脚本仍然是 fail-closed。
 *
 * 判据只有一条：**要么发出且内容严格正确，要么一个字节都不发**。
 * 「发出了不正确的内容」是本脚本唯一不可接受的结局。
 */

const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const nativeComposer = require('../native-composer')

const EN = 'Test translation information.'
const ZH = '测试翻译信息'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const rows = []
function check (name, pass, detail) {
  rows.push({ name: name, pass: !!pass })
  console.log((pass ? '  ✔ ' : '  ✖ ') + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)))
}

/**
 * mock 页面。`revertAtMs` > 0 时制造**迟到漂移**：插入成功之后过了这么久，
 * 编辑器按"自己的内部 state"把正文改回去（模拟 Lexical 的晚期调和）。
 * 这正是老实现必须等满 500ms 才敢发的那类风险。
 */
function mockHtml (revertAtMs, revertTo) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>settle safety</title></head><body>
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
  var revertAt = ${Number(revertAtMs) || 0}
  var revertTo = ${JSON.stringify(String(revertTo || ''))}
  var lastTrustedAt = 0
  function renderFromModel () { if (el.textContent !== model) el.textContent = model }
  document.addEventListener('beforeinput', function (e) {
    if (e.isTrusted) { trustedEditPending = true; return }
    e.preventDefault(); e.stopPropagation(); renderFromModel()
  }, true)
  el.addEventListener('input', function () {
    if (trustedEditPending) {
      trustedEditPending = false
      model = el.textContent
      lastTrustedAt = Date.now()
      return
    }
    renderFromModel()
  })
  // 调和循环：真机就是它在下一次 render 时把外部改的 DOM 盖掉。
  setInterval(function () {
    // ★ 迟到漂移：写入成功 revertAt 毫秒之后，编辑器按自己的 state 改回去。
    if (revertAt && lastTrustedAt && Date.now() - lastTrustedAt >= revertAt) {
      lastTrustedAt = 0
      model = revertTo
    }
    renderFromModel()
  }, 20)
  function nativeSend () {
    // 真机发送读的是**编辑器的内部 state**，不是 DOM。这里如实复刻。
    var t = model
    if (!String(t || '').trim()) return
    sent.push(t); model = ''; renderFromModel()
  }
  el.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) nativeSend()
  })
  document.getElementById('send-btn').addEventListener('click', nativeSend)
  window.__mock = {
    setUserText: function (t) { model = String(t == null ? '' : t); renderFromModel(); return model },
    getModel: function () { return model },
    sent: sent
  }
})()
</script>
</body></html>`
}

/** 跑一次"按回车 → 完了"的完整发送，返回 {sent, traces, settleMs}。 */
async function runOnce (wc, traces, zh) {
  await wc.executeJavaScript('window.__mock.setUserText(' + JSON.stringify(zh) + ')')
  await wc.executeJavaScript('window.__mock.sent.length = 0')
  traces.length = 0
  await wc.executeJavaScript(
    '(function(){var e=document.getElementById("editable-message-text");if(e)e.focus();return 1})()'
  )
  wc.focus()
  await sleep(50)
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  // 冷启动容差：刚跑完 electron-builder 时，第一台 Electron/Chromium 进程要
  // 预热（加载 preload + 建渲染进程 + 首次原生输入），整条链可能比热态慢一个
  // 数量级。原先固定 8s 会在这种冷态下把"场景 1 正常发送"误判成失败（发送还没
  // 走完就到底了）——这是**harness 的冷启动竞态，不是产品行为**。放宽到 30s。
  const RUN_ONCE_DEADLINE_MS = 30000
  const deadline = Date.now() + RUN_ONCE_DEADLINE_MS
  while (Date.now() < deadline) {
    if (traces.some(t => t.indexOf('SEND_PERF') >= 0)) break
    await sleep(15)
  }
  await sleep(120)
  const sent = await wc.executeJavaScript('window.__mock.sent.slice()')
  const settledLine = traces.find(t => t.indexOf('LEXICAL_SETTLED') >= 0) || ''
  let settleMs = null
  try { settleMs = JSON.parse(settledLine.slice(settledLine.indexOf('{'))).ms } catch (e) {}
  return { sent: sent, traces: traces.slice(), settleMs: settleMs }
}

async function main () {
  console.log('='.repeat(78))
  console.log(' 「缩短沉降窗」安全证明 · 生产 preload + 真 Chromium 原生输入')
  console.log('='.repeat(78))

  const win = new BrowserWindow({
    show: false, width: 900, height: 640,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  })

  const traces = []
  let scenario = null
  let view = null
  let wc = null
  let inserted = 0

  const prefs = {
    transRecv: true, transSend: true, transGroup: false,
    langMine: 'auto', langOther: 'auto', sendTo: 'en',
    includeZh: false, antiRevoke: false,
    // ★ 生产的下限/上限（就是本轮改成的值）★
    sendSettleMs: 60, sendSettleCeilingMs: 400,
    tabId: 'settle-safety', partition: 'safety', engine: 'gpt'
  }

  ipcMain.handle('translate:guestPrefs', () => Object.assign({}, prefs, (scenario && scenario.prefs) || {}))
  ipcMain.handle('translate:run', async () => {
    await sleep(30)
    // 场景可注入"翻译结果"（例如故意返回带占位符的脏结果）。
    return { success: true, translation: (scenario && scenario.translation) || EN, requestId: 'safety' }
  })
  ipcMain.handle('customer:ingest', () => ({ ok: true }))
  ipcMain.handle('translate:savePrefs', () => ({ success: true }))
  ipcMain.handle('translate:engines', () => ({ success: true, rows: [] }))
  ipcMain.handle('translate:composerSelectAllDelete', () => nativeComposer.selectAllAndClear(wc))
  ipcMain.handle('translate:composerInsertText', (_e, payload) => {
    inserted++
    if (scenario && scenario.rejectInsert) return { ok: true, chars: 0 }
    const text = String((payload && payload.text) || '')
    return (payload && payload.linewise) ? nativeComposer.insertTextLines(wc, text) : nativeComposer.insertText(wc, text)
  })

  async function mount (html, sc) {
    scenario = sc || null
    inserted = 0
    const tmp = path.join(os.tmpdir(), 'pix-safety-' + Date.now() + '.html')
    fs.writeFileSync(tmp, html, 'utf8')
    if (view) { try { win.contentView.removeChildView(view) } catch (e) {} }
    view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'guest-inject.js'),   // ★ 生产 preload
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
      }
    })
    win.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 900, height: 640 })
    wc = view.webContents
    wc.on('console-message', (...args) => {
      const message = (args.length === 1 && args[0] && typeof args[0] === 'object') ? args[0].message : args[2]
      const line = String(message == null ? '' : message)
      if (line.indexOf('[PIX_TRACE]') !== -1) traces.push(line)
    })
    wc.on('preload-error', (_e, p, error) => {
      console.error('    [preload-error] ' + path.basename(String(p)) + '：' + ((error && error.message) || error))
    })
    await wc.loadFile(tmp)
    await sleep(300)
    win.show(); win.focus()
    try { fs.unlinkSync(tmp) } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // 场景 1：正常路径 —— 必须发出**且内容严格正确**，不重复
  // -------------------------------------------------------------------------
  console.log('\n── 场景 1：正常路径（基线：证明加速后仍然发得对）')
  await mount(mockHtml(0, ''), {})
  {
    const seen = []
    for (let i = 0; i < 5; i++) seen.push(await runOnce(wc, traces, ZH))
    const allOne = seen.every(r => r.sent.length === 1)
    const allEn = seen.every(r => r.sent.length === 1 && r.sent[0] === EN)
    const settles = seen.map(r => r.settleMs)
    console.log('    每次发送结果=' + JSON.stringify(seen.map(r => r.sent)))
    console.log('    沉降耗时=' + JSON.stringify(settles) + 'ms')
    check('1 每次都恰好发出 1 条（不重复）', allOne, seen.map(r => r.sent.length))
    check('1 发出去的就是译文，原文/占位符都没出网', allEn, seen.map(r => r.sent))
    check('1 沉降确实走的是"确认即走"（远小于老的 500ms 固定窗）',
      settles.every(v => typeof v === 'number' && v < 200), settles)
  }

  // -------------------------------------------------------------------------
  // 场景 2：★ 迟到漂移 ★ —— 插入正确，但 150ms 后编辑器把正文改回原文
  //
  //   我们的下限是 60ms → 会在 ~60-80ms 就"确认稳定"。
  //   150ms 的回退**发生在我们确认之后**。这时唯一能拦住它的是发送前那道
  //   sendableBody() 闸 —— 本场景就是要证明它确实拦住了。
  // -------------------------------------------------------------------------
  console.log('\n── 场景 2：迟到漂移（插入正确，150ms 后编辑器改回原文）')
  await mount(mockHtml(150, ZH), {})
  {
    const seen = []
    for (let i = 0; i < 5; i++) seen.push(await runOnce(wc, traces, ZH))
    const leakedZh = seen.filter(r => r.sent.some(s => s.indexOf('测试翻译') >= 0))
    const wrong = seen.filter(r => r.sent.length && r.sent[0] !== EN)
    console.log('    每次发送结果=' + JSON.stringify(seen.map(r => r.sent)))
    check('2 绝不把改回后的原文发出去', leakedZh.length === 0, leakedZh.map(r => r.sent))
    check('2 要么发出正确译文、要么一个字节都不发（没有第三种结局）',
      wrong.length === 0 && seen.every(r => r.sent.length <= 1), seen.map(r => r.sent))
  }

  // -------------------------------------------------------------------------
  // 场景 2b：★ 提前漂移 ★ —— 插入后 40ms（**早于我们的 60ms 下限**）就改回原文
  //
  //   这时我们在下限处读到的就已经是错的 → LEXICAL_SETTLED ok=false →
  //   换插入方式重试一次 → 仍不对 → fail-closed。必须一个字节都不发。
  // -------------------------------------------------------------------------
  console.log('\n── 场景 2b：提前漂移（插入后 40ms 就改回原文，早于下限）')
  await mount(mockHtml(40, ZH), {})
  {
    const seen = []
    for (let i = 0; i < 3; i++) seen.push(await runOnce(wc, traces, ZH))
    const leaked = seen.filter(r => r.sent.some(s => s.indexOf('测试翻译') >= 0))
    console.log('    每次发送结果=' + JSON.stringify(seen.map(r => r.sent)))
    check('2b 绝不把改回后的原文发出去', leaked.length === 0, leaked.map(r => r.sent))
    check('2b 一个字节都不发（fail-closed）', seen.every(r => r.sent.length === 0), seen.map(r => r.sent))
  }

  // -------------------------------------------------------------------------
  // 场景 3：写入被拒（编辑器不接受）—— 必须 fail-closed
  // -------------------------------------------------------------------------
  console.log('\n── 场景 3：原生插入被编辑器拒绝 → 必须一个字节都不发')
  await mount(mockHtml(0, ''), { rejectInsert: true })
  {
    const r = await runOnce(wc, traces, ZH)
    const mismatch = r.traces.find(t => t.indexOf('SEND_BODY_MISMATCH_DETAIL') >= 0) || ''
    console.log('    收到=' + JSON.stringify(r.sent))
    check('3 一个字节都没发', r.sent.length === 0, r.sent)
    check('3 留下 BODY_MISMATCH 取证', mismatch !== '', mismatch.slice(0, 160))
    check('3 没有把占位符/原文当成"合格正文"放行',
      r.sent.every(s => s.indexOf('正在翻译') < 0 && s.indexOf('测试翻译') < 0), r.sent)
  }

  // -------------------------------------------------------------------------
  // 场景 4：翻译结果本身带占位符 —— 不允许出网
  // -------------------------------------------------------------------------
  console.log('\n── 场景 4：译文里混进占位符 → 不允许出网')
  await mount(mockHtml(0, ''), { translation: EN + '[正在翻译中...]' })
  {
    const r = await runOnce(wc, traces, ZH)
    console.log('    收到=' + JSON.stringify(r.sent))
    check('4 带占位符的正文一个字节都没出网', r.sent.every(s => s.indexOf('正在翻译') < 0), r.sent)
  }

  // -------------------------------------------------------------------------
  // 场景 5：用户草稿保护 —— 等翻译期间用户打了新内容
  // -------------------------------------------------------------------------
  console.log('\n── 场景 5：翻译期间用户打了新草稿 → 立即中止，绝不覆盖')
  await mount(mockHtml(0, ''), { translation: EN, slowMs: 400 })
  ipcMain.removeHandler('translate:run')
  ipcMain.handle('translate:run', async () => { await sleep(400); return { success: true, translation: EN, requestId: 'safety' } })
  {
    const DRAFT = '用户正在打的下一条，绝不能被覆盖'
    await wc.executeJavaScript('window.__mock.setUserText(' + JSON.stringify(ZH) + ')')
    await wc.executeJavaScript('window.__mock.sent.length = 0')
    traces.length = 0
    await wc.executeJavaScript('(function(){var e=document.getElementById("editable-message-text");if(e)e.focus();return 1})()')
    wc.focus(); await sleep(50)
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await sleep(120)                            // 翻译还在路上
    await wc.executeJavaScript('window.__mock.setUserText(' + JSON.stringify(DRAFT) + ')')
    await sleep(1500)
    const sent = await wc.executeJavaScript('window.__mock.sent.slice()')
    const model = await wc.executeJavaScript('window.__mock.getModel()')
    console.log('    收到=' + JSON.stringify(sent) + ' · 输入框=' + JSON.stringify(model))
    check('5 这一条不发送（用户已改草稿）', sent.length === 0, sent)
    check('5 用户的新草稿原样保留（一个字节都没被覆盖）', model === DRAFT, model)
  }

  const failed = rows.filter(r => !r.pass)
  console.log('\n' + '='.repeat(78))
  console.log(' 安全证明：' + (rows.length - failed.length) + ' / ' + rows.length + ' 项通过')
  if (failed.length) console.log(' ✖ FAIL：' + failed.map(r => r.name).join(' | '))
  else console.log(' ✔ 全部通过：加速没有放宽任何一道闸，失败一律 fail-closed')
  console.log('='.repeat(78))
  app.exit(failed.length ? 1 : 0)
}

app.whenReady().then(() => {
  main().catch(err => {
    console.error('脚本自身异常：', (err && err.stack) || err)
    app.exit(2)
  })
})
