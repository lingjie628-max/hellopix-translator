'use strict'

/**
 * 线路代理的**真机机制验收**（需要真 Electron，不能在纯 Node 下跑）。
 *
 * 跑法（在 desktop/ 目录下）：
 *   npm run verify:proxy
 *   （等价于 node_modules/.bin/electron scripts/proxy-mechanism-electron.js）
 *
 * 接真实公网代理做最后验收（⑦-⑧ 步，含认证）：
 *   PIX_PROXY_LINE='host:port:user:pass' PIX_PROXY_TYPE=socks5 npm run verify:proxy
 *   PIX_PROXY_LINE='host:port:user:pass' PIX_PROXY_TYPE=http   npm run verify:proxy
 *   （PIX_PROXY_LINE 也接受 'user:pass@host:port'，与产品里「整行粘贴」同源）
 *
 * ## 认证是怎么被验证的（P0 的核心）
 *
 * 凭据**绝不进 proxyRules**（Chromium 会报 ERR_NO_SUPPORTED_PROXIES）。本脚本按
 * 产品同款机制驱动真 Chromium：
 *   · HTTP/HTTPS：规则只写 host:port，凭据通过 `app.on('login')`（isProxy）回填；
 *   · SOCKS5：用产品自己的 `createSocksRelay()` 起本地中继，规则指向 127.0.0.1，
 *     认证发生在「中继 → 上游」那一段。
 * 因此 ⑧ 步能证明"带账号密码的代理真的能出网"，而不是"规则串看起来对"。
 *
 * ## ⚠️ 如果 macOS 弹出「"Electron" 意外退出」
 *
 * 那不是本脚本或产品出错。崩溃栈是：
 *     abort → HIServices _RegisterApplication → AppKit
 * 即 macOS LaunchServices 在**应用注册阶段**就 abort 了 —— 常见于
 * 「短时间反复启动同一个 app bundle」。它发生在脚本跑起来**之前**，
 * 与测试内容无关。
 *
 * 处理：弹窗点「好」（**不要点「重新打开」**，那会再崩一次）；
 * 等几秒，从一个正常的终端（GUI 会话）**只跑一次**。
 * 反复快速重试反而更容易触发。
 *
 * ## 为什么需要这个脚本，而不能只靠 test/proxy-mechanism.test.js
 *
 * 纯 Node 那套证明的是"我们生成的规则串正确且可达"（真实 HTTP/SOCKS5 代理、
 * 真实认证、真实 TCP）。但**"Chromium 是否真的按这条规则走"**只有 Chromium 自己
 * 能回答 —— 那就要 `session.setProxy()` + `session.fetch()`，即真 Electron。
 *
 * ## 一个必须知道的真实细节：<local> 绕过
 *
 * 产品给每条线路设置的是：
 *     setProxy({ proxyRules, proxyBypassRules: '<local>' })
 * `<local>` 会让**访问 localhost / 局域网目标时绕过代理**（这是对的：
 * 别把本机流量绕一圈代理）。副作用是：拿本地目标 + 本地代理做验收时，
 * 会看到"直连"——那不是代理坏了，是被 bypass 了。
 * 所以这里用 `--host-resolver-rules` 把 `pix-origin.test` 映射到 127.0.0.1，
 * 目标写成 `http://pix-origin.test:<port>/`，它不属于 local，代理才会真正生效。
 *
 * ## 覆盖的验收顺序（与需求里的 A→…→重启 一一对应）
 *
 *   ① A 直连
 *   ② A 加代理        → A 出口变化
 *   ③ B 不受影响
 *   ④ A 修改代理      → A 立即变化
 *   ⑤ A 删除代理      → A 恢复直连
 *   ⑥ 重启（按落盘逐条恢复）→ A/B 设置仍正确、不串线
 *   ⑦ safeStorage 真实加密：proxyPass 不明文落盘
 *   ⑧ 真实公网代理（设了 PIX_PROXY_LINE 才跑）：直连 IP → 代理 IP（A≠B）→
 *      双线路隔离 → 删除代理恢复直连；带认证时走 login / 本地中继
 *
 * 本脚本用**产品自己的函数**（desktop/proxy-settings.js 的 applyTabProxy /
 * proxyRulesOf / proxyFieldsChanged），不另写一套逻辑。
 */

const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { app, session, safeStorage, BrowserWindow } = require('electron')
const {
  applyTabProxy,
  proxyRulesOf,
  proxyTargetOf,
  proxyAuthOf,
  proxyFieldsChanged,
  proxySettingsOf
} = require('../src/proxy/proxy-settings')
const { createSocksRelay } = require('../src/proxy/socks-relay')
// 与产品同一个读取实现：验收跑的就是 main.js 的路径
const { readPageText } = require('../src/translate/probe-page')

// 与 main.js 同款的代理认证投递：只认 isProxy，凭据按 webContents 精确匹配。
// （产品里由 main.js 负责；这里是验收脚本，需要自己装一份同样的处理器。）
const proxyAuthByWebContents = new Map()
let loginEvents = 0
app.on('login', (event, webContents, details, authInfo, callback) => {
  if (!authInfo || authInfo.isProxy !== true) return
  loginEvents++
  const creds = webContents ? proxyAuthByWebContents.get(webContents.id) : null
  if (!creds || !creds.user) return
  event.preventDefault()
  callback(creds.user, creds.pass)
})

// 验收会反复创建隐藏窗口探测出口 IP。Electron 默认在「所有窗口都关闭」时退出，
// 于是第一个探测窗口销毁就会把整个脚本带走（表现为只跑到一半、exit=0）。
app.on('window-all-closed', () => {})

// 必须在 app ready 之前挂上：把假域名指到本机，绕开 <local> 的 bypass
const FAKE_HOST = 'pix-origin.test'
app.commandLine.appendSwitch('host-resolver-rules', 'MAP ' + FAKE_HOST + ' 127.0.0.1')
app.disableHardwareAcceleration()

// 用临时 userData：验收过程会创建 persist:pix-mech-* 分区，
// 落到默认目录会污染用户真正的客户端数据（甚至和真实线路混在一起）。
const SANDBOX_DIR = path.join(os.tmpdir(), 'pix-mech-' + process.pid)
app.setPath('userData', SANDBOX_DIR)

const results = []
function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''))
}

// ─────────────────────────────────────────────── 真实目标站（带 Content-Length）

function startOrigin() {
  const server = http.createServer((req, res) => {
    const body = JSON.stringify({ ok: true, via: req.headers['x-pix-exit'] || 'direct', host: req.headers.host, path: req.url })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

// ─────────────────────────────────────────────── 真实 HTTP 代理（会标记出口；可选 Basic 认证）

function startHttpProxy(name, creds) {
  const state = { hits: 0, authed: 0, rejected: 0 }
  const server = http.createServer((req, res) => {
    if (creds) {
      const raw = String(req.headers['proxy-authorization'] || '')
      const expect = 'Basic ' + Buffer.from(creds.user + ':' + creds.pass).toString('base64')
      if (raw !== expect) {
        state.rejected++
        res.writeHead(407, { 'proxy-authenticate': 'Basic realm="pix"', 'content-length': 0 })
        res.end()
        return
      }
      state.authed++
    }
    if (!/^https?:\/\//i.test(req.url || '')) {
      res.writeHead(400)
      res.end('expect absolute-URI')
      return
    }
    state.hits++
    const target = new URL(req.url)
    const headers = Object.assign({}, req.headers)
    delete headers['proxy-authorization']
    delete headers['proxy-connection']
    headers.host = target.host
    headers['x-pix-exit'] = name
    const upstream = http.request({
      // 假域名在本脚本的代理里统一落到本机，避免依赖系统 DNS
      host: '127.0.0.1',
      port: Number(target.port || 80),
      path: target.pathname + target.search,
      method: req.method,
      headers
    }, upRes => {
      res.writeHead(upRes.statusCode, upRes.headers)
      upRes.pipe(res)
    })
    upstream.on('error', e => { res.writeHead(502); res.end('upstream: ' + e.message) })
    req.pipe(upstream)
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })))
}

// ─────────────────────────────────────────────── 线路模型 + 探测

function tabOf(id, ses, settings) {
  return { id: id, settings: settings, view: { webContents: { session: ses } } }
}

async function probe(ses, originPort) {
  const url = 'http://' + FAKE_HOST + ':' + originPort + '/probe'
  const res = await ses.fetch(url, { cache: 'no-store' })
  return JSON.parse(await res.text())
}

// ─────────────────────────────────────────────── 真实公网出口 IP

/**
 * 把环境变量解析成产品的代理 settings。
 * `PIX_PROXY_LINE` 接受 'host:port:user:pass' 或 'user:pass@host:port'，
 * 直接交给产品同款解析（整行粘贴在真实使用中很常见）。
 */
function settingsFromEnv(suffix) {
  const tail = suffix || ''
  const line = String(process.env['PIX_PROXY_LINE' + tail] || '').trim()
  if (!line) return null
  const type = String(process.env['PIX_PROXY_TYPE' + tail] || 'socks5').trim().toLowerCase()
  const normalized = type === 'http' ? 'http' : type === 'https' ? 'https' : 'socks5'
  return {
    proxyType: normalized,
    proxyScheme: normalized,
    // 整行塞进 proxyHost：parseProxyHostLine 会把 host/port/账密拆开
    proxyHost: line,
    proxyPort: '',
    proxyUser: '',
    proxyPass: ''
  }
}

/** 走当前 session 的代理设置取公网出口 IP。 */
async function fetchIpDirect(ses) {
  try {
    const res = await ses.fetch('https://api.ipify.org?format=json', { cache: 'no-store' })
    const data = JSON.parse(await res.text())
    return String((data && data.ip) || '').replace(/[^\w.:]/g, '')
  } catch (e) {
    return ''
  }
}

/**
 * 按一份代理 settings 取公网出口 IP。直连走 `mode:direct`；
 * 带认证的 SOCKS5 用产品自己的中继；HTTP 认证走 login（隐藏窗口）。
 *
 * 每次调用都用**独立分区名**，这样 A/B/C 三条线路互不污染 ——
 * 正是要验收的那条产品规则。
 */
async function ipForSettings(partitionName, settings) {
  const ses = session.fromPartition(partitionName)
  if (!settings || String(settings.proxyType || 'none') === 'none') {
    await ses.setProxy({ mode: 'direct' })
    return await fetchIpDirect(ses)
  }
  const target = proxyTargetOf(settings)
  const creds = proxyAuthOf(settings)
  let relay = null
  let relayEndpoint = ''
  if (target.scheme === 'socks5' && target.hasAuth) {
    relay = createSocksRelay({ host: target.host, port: target.port, user: target.user, pass: target.pass, onError: () => {} })
    const info = await relay.start()
    relayEndpoint = '127.0.0.1:' + info.port
  }
  const rules = proxyRulesOf(settings, { relayEndpoint: relayEndpoint })
  if (!rules) return ''
  try {
    await ses.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' })
    return creds ? await fetchIpViaWindow(ses, creds) : await fetchIpDirect(ses)
  } finally {
    if (relay) { try { await relay.close() } catch (e) {} }
  }
}

/**
 * 用一次性隐藏窗口请求 URL 并取回 JSON。
 *
 * 必须是真实 webContents：`login` 事件只有带 webContents 时我们才能精确投递凭据
 * （`ses.fetch` 发出的请求没有 webContents，HTTP 代理的账密就没法交回 Chromium）。
 */
function probeJsonViaWindow(ses, url, creds) {
  return new Promise(resolve => {
    const win = new BrowserWindow({
      show: false,
      width: 380,
      height: 260,
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    })
    const wc = win.webContents
    if (creds && creds.user) proxyAuthByWebContents.set(wc.id, creds)
    let done = false
    const finish = value => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { proxyAuthByWebContents.delete(wc.id) } catch (e) {}
      try { if (!wc.isDestroyed()) wc.destroy() } catch (e) {}
      try { if (!win.isDestroyed()) win.destroy() } catch (e) {}
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), 20000)
    wc.on('did-finish-load', () => {
      // 与产品同款：隔离世界读文本
      readPageText(wc)
        .then(text => { try { finish(JSON.parse(text)) } catch (e) { finish(null) } })
        .catch(() => finish(null))
    })
    wc.on('did-fail-load', (_e, code) => { if (code !== -3) finish(null) })
    try { wc.loadURL(url) } catch (e) { finish(null) }
  })
}

/** 走 HTTP 代理（带认证时经 login 回填）取公网出口 IP。 */
async function fetchIpViaWindow(ses, creds) {
  const data = await probeJsonViaWindow(ses, 'https://api.ipify.org?format=json', creds)
  return String((data && data.ip) || '').replace(/[^\w.:]/g, '')
}

// ─────────────────────────────────────────────── 主流程

app.whenReady().then(async () => {
  const origin = await startOrigin()
  const proxyA = await startHttpProxy('A')
  const proxyB = await startHttpProxy('B')

  const sesA = session.fromPartition('persist:pix-mech-A')
  const sesB = session.fromPartition('persist:pix-mech-B')
  // 注意：Electron 的 Session 没有 `id` 属性（不是分区名），只能比对象身份。
  // 分区是否真的互相隔离，由 ③/⑥ 用真实流量证明。
  record('A/B 拿到不同的 session 对象（不共享代理与存储）',
    sesA !== sesB && typeof sesA.setProxy === 'function' && typeof sesB.setProxy === 'function',
    { sameObject: sesA === sesB, hasSetProxy: typeof sesA.setProxy })

  const direct = { proxyType: 'none' }
  const viaA = { proxyType: 'http', proxyHost: '127.0.0.1', proxyPort: String(proxyA.port) }
  const viaB = { proxyType: 'http', proxyHost: '127.0.0.1', proxyPort: String(proxyB.port) }

  const tabA = tabOf('A', sesA, Object.assign({}, direct))
  const tabB = tabOf('B', sesB, Object.assign({}, direct))

  // ① A 直连
  await applyTabProxy(tabA, {})
  let a = await probe(sesA, origin.port)
  record('① A 直连：出口 = 直连', a.via === 'direct', { via: a.via })
  const hitsA0 = proxyA.state.hits

  // ② A 加代理 → 出口变化（走 updateTabSettings 的真实判据 + 真实应用）
  const before = tabA.settings
  tabA.settings = Object.assign({}, before, viaA)
  const changed = proxyFieldsChanged(before, tabA.settings)
  if (changed) await applyTabProxy(tabA, {})
  a = await probe(sesA, origin.port)
  record('② A 加代理：出口变成 A', changed && a.via === 'A', { via: a.via, changed })
  record('② 代理 A 确实承载了流量', proxyA.state.hits > hitsA0, { hits: proxyA.state.hits })

  // ③ B 不受影响
  await applyTabProxy(tabB, {})
  const b1 = await probe(sesB, origin.port)
  record('③ B 不受影响：仍是直连', b1.via === 'direct', { via: b1.via })

  // ④ A 修改代理 → 立即变化（不重启、不新建线路）
  const before2 = tabA.settings
  tabA.settings = Object.assign({}, before2, viaB)
  const changed2 = proxyFieldsChanged(before2, tabA.settings)
  if (changed2) await applyTabProxy(tabA, {})
  const hitsB0 = proxyB.state.hits
  a = await probe(sesA, origin.port)
  record('④ A 改代理后立即变化：出口变成 B', changed2 && a.via === 'B', { via: a.via, changed: changed2 })
  record('④ 代理 B 承载了流量', proxyB.state.hits > hitsB0, { hits: proxyB.state.hits })
  record('④ 同一条线路：tab id / session 都没换',
    tabA.id === 'A' && tabA.view.webContents.session === sesA, { id: tabA.id })

  // ⑤ A 删除代理 → 恢复直连
  const before3 = tabA.settings
  tabA.settings = Object.assign({}, before3, { proxyType: 'none', proxyHost: '', proxyPort: '', proxyUser: '', proxyPass: '', proxyScheme: '' })
  const changed3 = proxyFieldsChanged(before3, tabA.settings)
  if (changed3) await applyTabProxy(tabA, {})
  a = await probe(sesA, origin.port)
  record('⑤ A 删除代理后恢复直连', changed3 && a.via === 'direct', { via: a.via })
  record('⑤ 规则确实为空（会走 setProxy mode=direct）', proxyRulesOf(tabA.settings) === '', { rules: proxyRulesOf(tabA.settings) })

  // ⑥ 重启：按落盘逐条恢复，A/B 各归各
  const persisted = [
    { id: 'A', settings: proxySettingsOf(viaA) },
    { id: 'B', settings: proxySettingsOf(viaB) }
  ]
  const sesA2 = session.fromPartition('persist:pix-mech-A2')
  const sesB2 = session.fromPartition('persist:pix-mech-B2')
  const restoredA = tabOf('A', sesA2, Object.assign({}, persisted[0].settings))
  const restoredB = tabOf('B', sesB2, Object.assign({}, persisted[1].settings))
  await applyTabProxy(restoredA, {})
  await applyTabProxy(restoredB, {})
  const ra = await probe(sesA2, origin.port)
  const rb = await probe(sesB2, origin.port)
  record('⑥ 重启后 A 仍走自己的代理', ra.via === 'A', { via: ra.via })
  record('⑥ 重启后 B 仍走自己的代理（不串线）', rb.via === 'B', { via: rb.via })

  // ⑩ 新建实例默认直连：模板不得携带代理
  //    这一条对应本次修的缺陷 —— 新建 B 之所以继承了 A 的代理，
  //    根因是**代理被当成模板内容**存进了 app-presets.json，
  //    而不是哪里复制了一个变量。所以这里走的必须是真实的模板链路。
  {
    const { PROXY_FIELDS, DIRECT_PROXY, stripProxyFields, isDirectProxy } = require('../src/proxy/proxy-isolation')

    // A 配了代理，然后系统把这条线路的设置存成模板。
    // main.js 的 app:savePreset 语义 = sealSettings(stripProxyFields(settings))
    const aLive = Object.assign({ fontSize: 16, sendTo: 'en' }, viaA)
    const presetOnDisk = stripProxyFields(aLive)

    // 用户点「新增应用」：app:preset 语义 = unsealSettings(stripProxyFields(row.settings))
    // 渲染层 fillAddForm 语义 = 继承普通偏好，代理只认直连初值
    const inherited = Object.assign({}, stripProxyFields(presetOnDisk))
    const form = Object.assign({}, inherited)
    for (const name of PROXY_FIELDS) form[name] = DIRECT_PROXY[name]

    const leaked = PROXY_FIELDS.filter(name => presetOnDisk[name] !== undefined)
    record('⑩ 模板里不含任何代理字段', leaked.length === 0, { leaked: leaked })
    record('⑩ 普通偏好照常继承（字体/语言）', presetOnDisk.fontSize === 16 && form.fontSize === 16 && form.sendTo === 'en',
      { fontSize: form.fontSize, sendTo: form.sendTo })
    record('⑩ 新建实例的表单判定为直连', isDirectProxy(form), { proxyType: form.proxyType, proxyHost: form.proxyHost })

    // 真 Chromium：按这份表单开一条**新线路**（新分区、新 session），出口必须直连
    const sesD = session.fromPartition('persist:pix-mech-D')
    const tabD = tabOf('D', sesD, form)
    await applyTabProxy(tabD, {})
    const d = await probe(sesD, origin.port)
    record('⑩ 新建实例真实出口 = 直连（没有继承 A 的代理）', d.via === 'direct', { via: d.via })

    // 同时：A 仍走自己的代理 —— 证明"新实例直连"不是把 A 也重置了
    tabA.settings = Object.assign({}, tabA.settings, viaA)
    await applyTabProxy(tabA, {})
    const aNow = await probe(sesA, origin.port)
    record('⑩ 同一条 A 仍走代理 A（新实例直连不是把 A 也重置了）', aNow.via === 'A', { via: aNow.via })
    record('⑩ D 与 A 的 session 不是同一个对象', sesD !== sesA, { same: sesD === sesA })
  }

  // ⑦ safeStorage 真实加密：proxyPass 不明文落盘
  const available = safeStorage.isEncryptionAvailable()
  record('⑦ safeStorage 可用（密码能加密落盘）', available, { available })
  if (available) {
    const plain = 'pix-plaintext-pass-9d3f'
    const sealed = 'safe:v1:' + safeStorage.encryptString(plain).toString('base64')
    const tmp = path.join(os.tmpdir(), 'pix-open-apps-' + Date.now() + '.json')
    fs.writeFileSync(tmp, JSON.stringify({ A: { settings: Object.assign({}, viaA, { proxyPass: sealed }) } }))
    const onDisk = fs.readFileSync(tmp, 'utf8')
    const decrypted = safeStorage.decryptString(Buffer.from(sealed.slice(8), 'base64'))
    record('⑦ 落盘文件不含明文密码', !onDisk.includes(plain), { bytes: onDisk.length })
    record('⑦ 密文可解回原密码', decrypted === plain, { decryptedMatches: decrypted === plain })
    fs.unlinkSync(tmp)
  }

  // ⑨ 真 Chromium + 真实 HTTP Basic 认证代理：凭据只能由 login 事件回填
  // （用户给的公网端点是 SOCKS5-only，验证不了 HTTP 认证通道；这里补上真实验证）
  const authProxy = await startHttpProxy('AUTH', { user: 'pix-user', pass: 'p@ss:word' })
  {
    const authSettings = {
      proxyType: 'http', proxyScheme: 'http', proxyHost: '127.0.0.1', proxyPort: String(authProxy.port),
      proxyUser: 'pix-user', proxyPass: 'p@ss:word'
    }
    const authRules = proxyRulesOf(authSettings)
    record('⑨ HTTP 规则串只有地址、不含凭据',
      authRules === 'http://127.0.0.1:' + authProxy.port && !authRules.includes('pix-user') && !authRules.includes('p@ss'),
      { rules: authRules })

    const sesAuth = session.fromPartition('persist:pix-mech-auth')
    await sesAuth.setProxy({ proxyRules: authRules, proxyBypassRules: '<local>' })
    const via = await probeJsonViaWindow(sesAuth, 'http://' + FAKE_HOST + ':' + origin.port + '/auth', proxyAuthOf(authSettings))
    record('⑨ 真 Chromium 经 login 回填凭据后真的从代理出网', !!via && via.via === 'AUTH', { via: via && via.via })
    record('⑨ login 事件被真实触发（isProxy）', loginEvents >= 1, { loginEvents: loginEvents })
    record('⑨ 代理收到且仅接受 1 次带凭据请求', authProxy.state.authed === 1 && authProxy.state.rejected >= 1,
      { authed: authProxy.state.authed, rejected: authProxy.state.rejected })

    const sesAuthBad = session.fromPartition('persist:pix-mech-authbad')
    await sesAuthBad.setProxy({ proxyRules: authRules, proxyBypassRules: '<local>' })
    const badVia = await probeJsonViaWindow(sesAuthBad, 'http://' + FAKE_HOST + ':' + origin.port + '/auth', { user: 'pix-user', pass: 'wrong' })
    record('⑨ 错密码绝不放行（不静默直连、不蒙混）', !badVia || badVia.via !== 'AUTH', { via: badVia && badVia.via })
  }

  // ⑧ 真实公网代理验收（含账号密码；用户提供代理后再跑）
  const envSettings = settingsFromEnv()
  if (envSettings) {
    const sesPub = session.fromPartition('persist:pix-mech-pub')
    await sesPub.setProxy({ mode: 'direct' })
    const directIp = await fetchIpDirect(sesPub)
    record('⑧ 直连出口 IP 可用', !!directIp, { direct: directIp })

    const target = proxyTargetOf(envSettings)
    const creds = proxyAuthOf(envSettings)
    // 凭据绝不能出现在 Chromium 看到的规则串里
    const leaked = [target.user, target.pass].filter(Boolean).some(v => v.length > 2)

    let relay = null
    let relayEndpoint = ''
    if (target.scheme === 'socks5' && target.hasAuth) {
      relay = createSocksRelay({ host: target.host, port: target.port, user: target.user, pass: target.pass, onError: () => {} })
      const info = await relay.start()
      relayEndpoint = '127.0.0.1:' + info.port
    }
    const rules = proxyRulesOf(envSettings, { relayEndpoint: relayEndpoint })
    record('⑧ 规则串只含地址、不含凭据', !!rules && !(leaked && (rules.includes(target.user) || rules.includes(target.pass))),
      { scheme: target.scheme, auth: target.hasAuth, relay: !!relay, ruleHasCreds: !!(rules.includes(target.user) || rules.includes(target.pass)) })

    await sesPub.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' })
    // HTTP 带认证 → 走 login（隐藏窗口）；SOCKS5 带认证 → 走中继，Chromium 侧无认证
    const proxiedIp = creds ? await fetchIpViaWindow(sesPub, creds) : await fetchIpDirect(sesPub)
    record('⑧ 代理出口 IP 与直连不同', !!proxiedIp && proxiedIp !== directIp, { direct: directIp, proxied: proxiedIp })
    record('⑧ 代理出口 IP 可用', !!proxiedIp, { proxied: proxiedIp })

    // 双线路隔离：A（代理）与 B（直连）同时在线，互不污染
    const sesIso = session.fromPartition('persist:pix-mech-iso')
    await sesIso.setProxy({ mode: 'direct' })
    const isoIp = await fetchIpDirect(sesIso)
    record('⑧ 双线路隔离：B 仍是直连出口、与 A 不同', isoIp === directIp && isoIp !== proxiedIp, { a: proxiedIp, b: isoIp })

    // 删除代理 → 恢复直连
    await sesPub.setProxy({ mode: 'direct' })
    const backIp = await fetchIpDirect(sesPub)
    record('⑧ 删除代理后出口 IP 回到直连', backIp === directIp, { back: backIp })

    if (relay) await relay.close()
  } else {
    console.log('  SKIP  ⑧ 真实公网代理验收（未设 PIX_PROXY_LINE）')
  }

  // ⑪ 三线路真实出口验收：A=代理 X / B=代理 Y / C=直连
  //     需要两条**不同的**公网代理才能证明 IP_A != IP_B：
  //       PIX_PROXY_LINE='host:port:user:pass'   PIX_PROXY_TYPE=socks5
  //       PIX_PROXY_LINE_B='host:port:user:pass' PIX_PROXY_TYPE_B=socks5
  const lineA = settingsFromEnv('')
  const lineB = settingsFromEnv('_B')
  if (lineA && lineB) {
    const ipC = await ipForSettings('persist:pix-3line-C', null)
    const ipA = await ipForSettings('persist:pix-3line-A', lineA)
    const ipB = await ipForSettings('persist:pix-3line-B', lineB)
    record('⑪ C 直连出口 IP 可用', !!ipC, { c: ipC })
    record('⑪ A 代理出口 IP 可用', !!ipA, { a: ipA })
    record('⑪ B 代理出口 IP 可用', !!ipB, { b: ipB })
    record('⑪ IP_A != IP_B（两个代理确实是两个出口）', !!ipA && !!ipB && ipA !== ipB, { a: ipA, b: ipB })
    record('⑪ IP_A != IP_C', !!ipA && !!ipC && ipA !== ipC, { a: ipA, c: ipC })
    record('⑪ IP_B != IP_C', !!ipB && !!ipC && ipB !== ipC, { b: ipB, c: ipC })

    // 修改 A 的代理 → 只有 A 变
    const ipA2 = await ipForSettings('persist:pix-3line-A2', lineB)
    const ipBAfter = await ipForSettings('persist:pix-3line-B2', lineB)
    const ipCAfter = await ipForSettings('persist:pix-3line-C2', null)
    record('⑪ 改 A 之后 A 走 B 的代理（出口变成 B 的）', !!ipA2 && ipA2 === ipB, { a2: ipA2, b: ipB })
    record('⑪ 改 A 不影响 B/C', ipBAfter === ipB && ipCAfter === ipC, { b: ipBAfter, c: ipCAfter })

    // 删除 A 的代理 → A 回直连，B/C 不动
    const ipABack = await ipForSettings('persist:pix-3line-A3', null)
    const ipBBack = await ipForSettings('persist:pix-3line-B3', lineB)
    record('⑪ 删除 A 的代理 → A 回直连', !!ipABack && ipABack === ipC, { a: ipABack, c: ipC })
    record('⑪ 删除 A 不影响 B（B 仍走自己的代理）', ipBBack === ipB, { b: ipBBack })

    // 重启：逐条从自己的配置恢复，C 仍直连
    const ipARestart = await ipForSettings('persist:pix-3line-A4', lineA)
    const ipBRestart = await ipForSettings('persist:pix-3line-B4', lineB)
    const ipCRestart = await ipForSettings('persist:pix-3line-C4', null)
    record('⑪ 重启后 A 恢复自己的代理', ipARestart === ipA, { a: ipARestart })
    record('⑪ 重启后 B 恢复自己的代理', ipBRestart === ipB, { b: ipBRestart })
    record('⑪ 重启后 C 仍是直连', ipCRestart === ipC, { c: ipCRestart })
  } else {
    console.log('  SKIP  ⑪ 三线路真实出口验收（需要同时设 PIX_PROXY_LINE 与 PIX_PROXY_LINE_B 两条不同代理）')
  }

  const failed = results.filter(r => !r.ok)
  console.log('\n===SUMMARY===' + JSON.stringify({ total: results.length, failed: failed.length, failedNames: failed.map(f => f.name) }))

  origin.server.close()
  proxyA.server.close()
  proxyB.server.close()
  authProxy.server.close()
  try { require('node:fs').rmSync(SANDBOX_DIR, { recursive: true, force: true }) } catch (e) {}
  app.exit(failed.length ? 1 : 0)
}).catch(error => {
  console.error('MECHANISM ERROR:', (error && error.stack) || error)
  app.exit(2)
})
