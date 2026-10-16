'use strict'

/**
 * 节点检测（detectProxyNode）—— **真 Electron 机制验收 + 卡死复现**。
 *
 * 跑法（在 desktop/ 目录下）：
 *   node_modules/.bin/electron scripts/verify-detect-proxy-electron.js
 *
 * ## 为什么必须有这个脚本
 *
 * 用户报：Windows 上「节点检测一直处于正在检测阶段，没办法检测出来」，
 * **连错误提示都没有**。而这条链完全没有单测覆盖（`detectProxyNode` 零测试）。
 *
 * "永远不出结果"只有两种可能：① 超时机制没生效；② 某一步 await 永不 resolve。
 * 这两种**都只能靠真 Electron 验证** —— jsdom 里没有 session.setProxy、
 * 没有 BrowserWindow、没有真实的 did-fail-load。
 *
 * ## 本脚本用一个"假的 SOCKS5 上游"精确制造各种现场
 *
 * 真起一个 TCP server 冒充 SOCKS5 节点，按场景控制它的行为：
 *   · 连得上但**不回问候**（静默丢弃）→ 复现"永远正在检测"的经典现场
 *   · 连得上、回问候、但**不回 CONNECT reply** → 同上
 *   · 回「认证失败」→ 应当快速失败
 *   · 端口没人监听 → 应当快速失败
 *
 * 每个场景都断言：**必须在超时上限内返回**（不许永远挂起），
 * 且失败时**必须带错误信息**（不许静默）。
 *
 * 退出码：0 = 全部通过；1 = 有项不通过；2 = 脚本自身异常。
 */

const { app, BrowserWindow, session } = require('electron')
const net = require('net')
const path = require('path')

const rows = []
function check (name, pass, detail) {
  rows.push({ name, pass: !!pass, detail })
  console.log((pass ? '  ✔ ' : '  ✖ ') + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)))
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- 从真源码切出被测函数（与单测同法，不复制实现） ----
const fs = require('fs')
const root = path.join(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const relaySrc = fs.readFileSync(path.join(root, 'socks-relay.js'), 'utf8')

/** 按花括号配对切出函数/对象字面量的真身。 */
function sliceBlock (src, header) {
  const start = src.indexOf(header)
  if (start < 0) throw new Error('找不到源码片段：' + header)
  const open = src.indexOf('{', start + header.length - 1)
  if (open < 0) return src.slice(start, src.indexOf('\n', start))
  let depth = 0
  let i = open
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { i++; break } }
  }
  return src.slice(start, i)
}

/** 在**真 Electron 主进程**里装配一份可调用的 detectProxyNode。 */
function buildDetect () {
  // 真依赖
  const { createSocksRelay } = require(path.join(root, 'socks-relay.js'))
  const { proxyTargetOf, proxyAuthOf } = require(path.join(root, 'proxy-settings.js'))
  const { proxyRulesOf } = require(path.join(root, 'proxy-settings.js'))
  const { readPageText } = require(path.join(root, 'probe-page.js'))

  const PROBE_TIMEOUT_MS = Number(
    (mainSrc.match(/const PROBE_TIMEOUT_MS\s*=\s*(\d+)/) || [])[1] || 15000
  )
  const probeWindows = new Set()
  const proxyAuthByWebContents = new Map()

  function parseJsonSafe (text) {
    try { return JSON.parse(text) } catch (e) { return null }
  }

  // ---- 真身：probeTextWithProxy（整段切出）----
  const probeFnSrc = sliceBlock(mainSrc, 'function probeTextWithProxy(ses, url, creds)')

  // ---- 真身：detectProxyNode（整段切出）----
  const detectFnSrc = sliceBlock(mainSrc, 'async function detectProxyNode(payload)')

  const factory = new Function(
    'BrowserWindow', 'session', 'createSocksRelay', 'precheckSocks5', 'proxyTargetOf', 'proxyAuthOf',
    'proxyRulesOf', 'readPageText', 'parseJsonSafe', 'PROBE_TIMEOUT_MS',
    'probeWindows', 'proxyAuthByWebContents', 'lookupIpGeo', 'noteProxyIp',
    `${probeFnSrc}\n${detectFnSrc}\nreturn { detectProxyNode, probeTextWithProxy, PROBE_TIMEOUT_MS }`
  )

  const { precheckSocks5 } = require(path.join(root, 'socks-relay.js'))

  return factory(
    BrowserWindow, session, createSocksRelay, precheckSocks5, proxyTargetOf, proxyAuthOf,
    proxyRulesOf, readPageText, parseJsonSafe, PROBE_TIMEOUT_MS,
    probeWindows, proxyAuthByWebContents,
    // geo 查询与历史记录与本验收无关，打桩（它们会发真网络请求）
    async (ip) => ({ ip, country: 'Testland', region: '', city: '', loc: '', timezone: '', zip: '' }),
    () => 0
  )
}

/** 起一个「假 SOCKS5 上游」，按 mode 控制行为。返回 { port, close, stats }。 */
function startFakeUpstream (mode) {
  const stats = { connections: 0, bytesIn: 0, destroyed: 0 }
  const sockets = new Set()
  const server = net.createServer(socket => {
    stats.connections++
    sockets.add(socket)
    socket.on('close', () => { stats.destroyed++; sockets.delete(socket) })
    socket.on('error', () => {})
    socket.on('data', chunk => {
      stats.bytesIn += chunk.length
      if (mode === 'silent') return                    // 收到什么都不回（经典卡死现场）
      if (mode === 'greet-then-silent') {
        // 回问候（选「无认证」），但 CONNECT 之后不回 reply
        if (chunk[0] === 0x05 && chunk[1] >= 1 && stats.bytesIn <= chunk.length) {
          socket.write(Buffer.from([0x05, 0x00]))
        }
        return
      }
      if (mode === 'auth-reject') {
        socket.write(Buffer.from([0x05, 0xFF]))        // 无可接受认证方式
      }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        stats,
        close () {
          for (const s of sockets) { try { s.destroy() } catch (e) {} }
          return new Promise(r => server.close(() => r()))
        }
      })
    })
  })
}

async function withTimeout (promise, ms, label) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('HUNG_OVER_' + ms + 'ms:' + label)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function main () {
  console.log('\n=== 节点检测 · 真 Electron 卡死复现与验收 ===\n')

  const built = buildDetect()
  const LIMIT = built.PROBE_TIMEOUT_MS
  console.log('  (探测超时上限 PROBE_TIMEOUT_MS = ' + LIMIT + 'ms，断言一律在 3 倍以内返回)\n')

  const settingsFor = (port) => ({
    proxyType: 'socks5',
    proxyHost: '127.0.0.1',
    proxyPort: String(port),
    proxyUser: 'u',
    proxyPass: 'p',
    proxyIpVer: 'ipv4',
    proxyChannel: 'dbip'
  })

  // ---- 场景 1：上游连得上但**静默不回**（用户报的"永远正在检测"现场）----
  {
    const up = await startFakeUpstream('silent')
    const t0 = Date.now()
    let outcome = null
    try {
      const r = await withTimeout(
        built.detectProxyNode(settingsFor(up.port)).catch(e => ({ threw: String(e && e.message) })),
        LIMIT * 3,
        'silent-upstream'
      )
      outcome = { ms: Date.now() - t0, result: r }
    } catch (e) {
      outcome = { ms: Date.now() - t0, hung: true, error: String(e && e.message) }
    }
    await up.close()
    check('场景1 静默上游：**必须返回**（不许永远"正在检测"）',
      !outcome.hung, outcome)
    check('场景1 静默上游：失败时必须带错误信息（不许静默）',
      !outcome.hung && outcome.result && (outcome.result.success === false || outcome.result.threw), outcome)
  }

  // ---- 场景 2：回了问候但 CONNECT 后不回 reply ----
  {
    const up = await startFakeUpstream('greet-then-silent')
    const t0 = Date.now()
    let outcome = null
    try {
      const r = await withTimeout(
        built.detectProxyNode(settingsFor(up.port)).catch(e => ({ threw: String(e && e.message) })),
        LIMIT * 3,
        'greet-then-silent'
      )
      outcome = { ms: Date.now() - t0, result: r }
    } catch (e) {
      outcome = { ms: Date.now() - t0, hung: true, error: String(e && e.message) }
    }
    await up.close()
    check('场景2 CONNECT 无 reply：**必须返回**', !outcome.hung, outcome)
    check('场景2 CONNECT 无 reply：失败时必须带错误信息',
      !outcome.hung && outcome.result && (outcome.result.success === false || outcome.result.threw), outcome)
  }

  // ---- 场景 3：端口没人监听（应当快速失败，不该等满超时）----
  {
    const probe = await startFakeUpstream('silent')
    const deadPort = probe.port
    await probe.close()   // 关掉 → 端口空出来，连接会被拒
    const t0 = Date.now()
    let outcome = null
    try {
      const r = await withTimeout(
        built.detectProxyNode(settingsFor(deadPort)).catch(e => ({ threw: String(e && e.message) })),
        LIMIT * 3,
        'dead-port'
      )
      outcome = { ms: Date.now() - t0, result: r }
    } catch (e) {
      outcome = { ms: Date.now() - t0, hung: true, error: String(e && e.message) }
    }
    check('场景3 端口不可达：必须返回失败', !outcome.hung && outcome.result && outcome.result.success === false, outcome)
  }

  // ---- 场景 4：上游拒绝认证方式（应当快速、明确地失败）----
  {
    const up = await startFakeUpstream('auth-reject')
    const t0 = Date.now()
    let outcome = null
    try {
      const r = await withTimeout(
        built.detectProxyNode(settingsFor(up.port)).catch(e => ({ threw: String(e && e.message) })),
        LIMIT * 3,
        'auth-reject'
      )
      outcome = { ms: Date.now() - t0, result: r }
    } catch (e) {
      outcome = { ms: Date.now() - t0, hung: true, error: String(e && e.message) }
    }
    await up.close()
    check('场景4 认证被拒：必须返回失败', !outcome.hung && outcome.result && outcome.result.success === false, outcome)
  }

  // ---- 场景 5：中继自己不能无限挂着（直接压 socks-relay）----
  {
    const { createSocksRelay } = require(path.join(root, 'socks-relay.js'))
    const up = await startFakeUpstream('silent')
    const relay = createSocksRelay({
      host: '127.0.0.1', port: up.port, user: 'u', pass: 'p', onError: () => {}
    })
    let startMs = 0
    let startOk = false
    try {
      const t0 = Date.now()
      const info = await withTimeout(relay.start(), 5000, 'relay.start')
      startMs = Date.now() - t0
      startOk = !!(info && info.port)
    } catch (e) {
      startOk = false
    }
    check('场景5 relay.start() 本身能在 5s 内返回（它只监听回环，不该挂）', startOk, { startMs })
    await relay.close().catch(() => {})
    await up.close()
  }

  // ---- 场景 6：★最关键★ 一轮坏节点检测之后，新开实例的翻译桥必须仍能起来 ----
  //
  // 这条锁的是用户实际报的两个症状的**因果**：
  //   「节点检测一直正在检测」→（老实现会把渲染进程基础设施弄坏）→
  //   「新开的 WhatsApp 实例显示 *翻译组件未启动*」。
  // 真机复现过：老实现下，一次坏节点检测之后，新建带 preload 的 WebContentsView
  // **不触发任何事件**（loadURL 都不返回）。这里断言修复后它必须正常 did-finish-load。
  {
    const { WebContentsView } = require('electron')
    const up = await startFakeUpstream('silent')   // 典型坏节点：连得上但不回话

    // 先跑一次"检测" —— 走真 detectProxyNode（它会先预检、不会创建探测窗口）
    let detectResult = null
    try {
      detectResult = await withTimeout(
        built.detectProxyNode(settingsFor(up.port)).catch(e => ({ threw: String(e && e.message) })),
        LIMIT * 3,
        'bridge-regression-detect'
      )
    } catch (e) {
      detectResult = { hung: true, error: String(e && e.message) }
    }
    check('场景6 前置：坏节点检测必须按时返回失败（不弄坏应用）',
      detectResult && detectResult.success === false, detectResult)

    // 再新建一个带真 preload 的 view —— 模拟用户新开一个 WhatsApp 实例
    const holder = new BrowserWindow({ show: false, width: 600, height: 400 })
    let view = null
    try { view = new WebContentsView({
      webPreferences: {
        preload: path.join(root, 'guest-inject.js'),
        partition: 'persist:pix-verify-bridge',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    }) } catch (e) { view = null }
    if (!view) {
      check('场景6 能新建 WebContentsView', false, 'WebContentsView 创建失败')
    } else {
      holder.contentView.addChildView(view)
      const events = []
      view.webContents.on('preload-error', () => events.push('preload-error'))
      view.webContents.on('did-finish-load', () => events.push('did-finish-load'))
      view.webContents.on('did-fail-load', () => events.push('did-fail-load'))
      view.webContents.on('render-process-gone', () => events.push('render-process-gone'))
      let loaded = false
      try {
        await withTimeout(view.webContents.loadURL('data:text/html,<p>hi</p>'), 6000, 'bridge-load')
        loaded = true
      } catch (e) { loaded = false }
      // 给 preload 一点执行时间
      await sleep(600)
      check('场景6 坏节点检测之后，新实例仍能加载页面（不卡死）',
        loaded === true && events.includes('did-finish-load'), { loaded, events })
      check('场景6 新实例的 preload 没有装载失败（翻译桥能起来）',
        !events.includes('preload-error'), { events })
    }
    await up.close()
  }

  const failed = rows.filter(r => !r.pass)
  console.log('\n=== 结果：' + (rows.length - failed.length) + ' / ' + rows.length + ' 通过 ===')
  if (failed.length) {
    console.log('\n未通过：')
    for (const f of failed) console.log('  ✖ ' + f.name + '  → ' + JSON.stringify(f.detail))
    return 1
  }
  console.log('\n全部通过：节点检测在各类失败现场都能**按时返回并给出明确错误**。\n')
  return 0
}

app.whenReady().then(async () => {
  let code = 2
  try {
    code = await main()
  } catch (e) {
    console.error('\n[verify-detect-proxy] 脚本异常：', e && e.stack ? e.stack : e)
    code = 2
  }
  app.exit(code)
}).catch(e => {
  console.error('[verify-detect-proxy] 启动失败：', e && e.stack ? e.stack : e)
  app.exit(2)
})
