'use strict'

/**
 * 发送翻译 **端到端分段耗时** 基准（真 Electron，跑生产 preload）。
 *
 * 跑法（在 desktop/ 目录下）：
 *   npm run bench:send
 *   # 或指定参数：
 *   env -u ELECTRON_RUN_AS_NODE electron scripts/bench-send-timing.js \
 *     --runs 20 --api-ms 900 --label gpt --settle 500
 *
 * ## 为什么必须真 Electron
 *
 * 被测的整条链只有真实 Chromium 才有意义：`webContents.insertText` 产生的是
 * **可信**输入事件，编辑器才会接受并更新内部 state（0.1.18 的 execCommand 就死在
 * 这一点上）。jsdom 里没有可信事件概念，测出来的"耗时"毫无参考价值。
 *
 * 本脚本装载的是**生产 preload**（`guest-inject.js`，一行不改）+ 生产
 * `native-composer.js`，页面是一个复刻 WhatsApp/Lexical 行为的 mock。
 *
 * ## 它测什么、不测什么
 *
 * 测：客户端这一侧的全部耗时 —— 拦截、原生输入（清空/插入）、编辑器沉降、
 *     正文校验、程序化发送、状态提示收口。
 * 不测：厂商模型本身的推理时间（那是外部依赖）。用 `--api-ms` 注入，
 *     并用**真机实测**的 P50/P95 填进来，就能得到接近真实的总耗时分解。
 *
 * 每个迭代都换一条不重复的文本，避免命中 guest 侧翻译缓存（否则 API 段恒为 0）。
 */

const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const nativeComposer = require('../native-composer')

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function arg (name, dflt) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  return v === undefined ? true : v
}
const RUNS = Math.max(1, Number(arg('runs', 25)))
const API_MS = Math.max(0, Number(arg('api-ms', 0)))
const LABEL = String(arg('label', 'default'))
const SETTLE = Number(arg('settle', NaN))          // 不传 → 用 prefs 默认（生产 500）
const OUT_JSON = String(arg('json', ''))           // 传了就写一份 JSON，便于前后对比

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// mock WhatsApp 页面（与 verify-native-input-electron.js 同源，保持行为一致）
// ---------------------------------------------------------------------------
function mockHtml () {
  return `<!doctype html><html><head><meta charset="utf-8"><title>bench</title></head><body>
<div id="main"><div id="msg-list"></div><footer>
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
  el.addEventListener('input', function (e) {
    if (trustedEditPending) { trustedEditPending = false; model = el.textContent; return }
    renderFromModel()
  })
  // 调和循环：真机就是它在下一次 render 时把外部改的 DOM 盖掉。
  setInterval(renderFromModel, 60)
  function nativeSend () {
    var t = el.textContent
    if (!String(t || '').trim()) return
    sent.push({ text: t, at: Date.now() })
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
    sent: sent
  }
})()
</script>
</body></html>`
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------
function percentile (sorted, p) {
  if (!sorted.length) return null
  if (sorted.length === 1) return sorted[0]
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo))
}
function stats (values) {
  const clean = values.filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b)
  if (!clean.length) return { n: 0 }
  return {
    n: clean.length,
    min: clean[0],
    p50: percentile(clean, 0.5),
    p95: percentile(clean, 0.95),
    max: clean[clean.length - 1],
    mean: Math.round(clean.reduce((a, b) => a + b, 0) / clean.length)
  }
}

const STAGE_ORDER = ['intercept', 'translate', 'handoff', 'nativeInput', 'validate', 'send', 'uiClose']
const STAGE_LABEL = {
  intercept: '点击→拦截',
  translate: '翻译请求(=API)',
  handoff: 'API返回→原生输入',
  nativeInput: '原生输入→编辑器稳定',
  validate: '稳定→触发发送',
  send: '触发发送→发送确认',
  uiClose: '发送确认→提示关闭'
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main () {
  console.log('='.repeat(78))
  console.log(' 发送翻译 · 端到端分段耗时基准')
  console.log('   label=' + LABEL + ' · runs=' + RUNS + ' · 注入 API 延迟=' + API_MS + 'ms' +
    (Number.isFinite(SETTLE) ? ' · sendSettleMs=' + SETTLE : ' · sendSettleMs=prefs默认'))
  console.log('='.repeat(78))

  const tmpHtml = path.join(os.tmpdir(), 'pix-bench-mock.html')
  fs.writeFileSync(tmpHtml, mockHtml(), 'utf8')

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 640,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  })

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'guest-inject.js'),   // ★ 生产 preload，一行不改
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 900, height: 640 })
  const wc = view.webContents

  const traces = []
  wc.on('console-message', (...args) => {
    const message = (args.length === 1 && args[0] && typeof args[0] === 'object') ? args[0].message : args[2]
    const line = String(message == null ? '' : message)
    if (line.indexOf('[PIX_TRACE]') !== -1) traces.push(line)
  })
  wc.on('preload-error', (_e, p, error) => {
    console.error('    [preload-error] ' + path.basename(String(p)) + '：' + ((error && error.message) || error))
  })

  // ---- 生产同款 IPC 面 ----
  const prefsRow = {
    transRecv: true, transSend: true, transGroup: false,
    langMine: 'auto', langOther: 'auto', sendTo: 'en',
    includeZh: false, antiRevoke: false,
    tabId: 'bench', partition: 'bench', engine: LABEL
  }
  if (Number.isFinite(SETTLE)) prefsRow.sendSettleMs = SETTLE

  ipcMain.handle('translate:guestPrefs', () => Object.assign({}, prefsRow))
  ipcMain.handle('translate:run', async (_e, payload) => {
    // 注入"厂商 + 服务端"的往返时间。真实值来自真机实测（见 --api-ms）。
    if (API_MS) await sleep(API_MS)
    return { success: true, translation: 'Bench translation output #' + String(traces.length), requestId: 'bench' }
  })
  ipcMain.handle('customer:ingest', () => ({ ok: true }))
  ipcMain.handle('translate:savePrefs', () => ({ success: true }))
  ipcMain.handle('translate:engines', () => ({ success: true, rows: [] }))
  ipcMain.handle('translate:composerSelectAllDelete', () => nativeComposer.selectAllAndClear(wc))
  ipcMain.handle('translate:composerInsertText', (_e, payload) => {
    const text = String((payload && payload.text) || '')
    return (payload && payload.linewise) ? nativeComposer.insertTextLines(wc, text) : nativeComposer.insertText(wc, text)
  })

  async function focusComposer () {
    await wc.executeJavaScript(
      '(function(){var e=document.getElementById("editable-message-text");if(e)e.focus();return document.activeElement&&document.activeElement.id})()'
    )
    wc.focus()
    await sleep(60)
  }

  await wc.loadFile(tmpHtml)
  await sleep(400)
  win.show()
  win.focus()
  await focusComposer()

  // ---- 采样 ----
  const runs = []
  for (let i = 1; i <= RUNS; i++) {
    // 每次换一条不重复的文本 → 不命中 guest 翻译缓存 → translate 段真实经过 IPC。
    const zh = '基准文本' + i + '：今天下午三点开会，请准时参加'
    await wc.executeJavaScript('window.__mock.setUserText(' + JSON.stringify(zh) + ')')
    await wc.executeJavaScript('window.__mock.sent.length = 0')
    traces.length = 0
    await focusComposer()

    const t0 = Date.now()
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })

    let done = null
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      done = traces.find(t => t.indexOf('SEND_PERF') >= 0)
      if (done) break
      if (traces.some(t => t.indexOf('SEND_FAIL_CLOSED') >= 0)) break
      await sleep(10)
    }
    const sent = await wc.executeJavaScript('window.__mock.sent.slice()')

    if (!done) {
      console.log('  ✖ 第 ' + i + ' 次没有 SEND_PERF（链路没走完）')
      console.log('    ' + traces.slice(-6).join('\n    '))
      continue
    }
    const p = JSON.parse(done.slice(done.indexOf('{')))
    const row = { i: i, total: p.total, stages: p.stages, outcome: p.outcome, wall: Date.now() - t0, sent: sent.length }
    runs.push(row)

    if (!sent.length) {
      console.log('  ✖ 第 ' + i + ' 次：一个字节都没发出去（outcome=' + p.outcome + '）')
    } else if (sent.length !== 1) {
      console.log('  ✖ 第 ' + i + ' 次：发了 ' + sent.length + ' 条')
    }
    process.stdout.write('  · 第 ' + String(i).padStart(2) + ' 次  总 ' + String(p.total).padStart(5) +
      'ms  ' + STAGE_ORDER.filter(s => p.stages[s] != null).map(s => s + '=' + p.stages[s]).join(' ') + '\n')
  }

  // ---- 汇总 ----
  console.log('\n' + '='.repeat(78))
  console.log(' 分段耗时（ms）· label=' + LABEL + ' · n=' + runs.length)
  console.log('='.repeat(78))
  console.log(' ' + '阶段'.padEnd(24) + 'P50'.padStart(7) + 'P95'.padStart(7) + 'max'.padStart(7) + 'mean'.padStart(7))
  const summary = {}
  for (const st of STAGE_ORDER) {
    const s = stats(runs.map(r => r.stages[st]))
    summary[st] = s
    if (!s.n) continue
    console.log(' ' + (st + ' ' + STAGE_LABEL[st]).padEnd(24) +
      String(s.p50).padStart(7) + String(s.p95).padStart(7) + String(s.max).padStart(7) + String(s.mean).padStart(7))
  }
  const totalStats = stats(runs.map(r => r.total))
  console.log(' ' + '—'.repeat(24))
  console.log(' ' + '总耗时(点击→提示关闭)'.padEnd(22) +
    String(totalStats.p50).padStart(7) + String(totalStats.p95).padStart(7) +
    String(totalStats.max).padStart(7) + String(totalStats.mean).padStart(7))

  // 客户端净开销 = 总耗时 − 翻译段（就是我们能优化的部分）
  const overhead = stats(runs.map(r => (r.total != null && r.stages.translate != null) ? r.total - r.stages.translate : null))
  console.log(' ' + '客户端净开销(总−翻译)'.padEnd(22) +
    String(overhead.p50).padStart(7) + String(overhead.p95).padStart(7) +
    String(overhead.max).padStart(7) + String(overhead.mean).padStart(7))

  const bad = runs.filter(r => r.outcome !== 'ok' || r.sent !== 1)
  console.log('\n 发送正确性：' + (runs.length - bad.length) + ' / ' + runs.length + ' 次恰好发出 1 条且 outcome=ok')
  console.log(' 注入 API 延迟：' + API_MS + 'ms（真实值请用真机实测填 --api-ms）')

  if (OUT_JSON) {
    fs.writeFileSync(OUT_JSON, JSON.stringify({
      label: LABEL, runs: RUNS, apiMs: API_MS, settle: Number.isFinite(SETTLE) ? SETTLE : 'prefs',
      total: totalStats, overhead: overhead, stages: summary, samples: runs
    }, null, 2), 'utf8')
    console.log(' 已写出：' + OUT_JSON)
  }

  try { fs.unlinkSync(tmpHtml) } catch (e) {}
  app.exit(0)
}

app.whenReady().then(() => {
  main().catch(err => {
    console.error('脚本自身异常：', (err && err.stack) || err)
    app.exit(2)
  })
})
