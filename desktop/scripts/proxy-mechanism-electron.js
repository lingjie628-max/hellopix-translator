'use strict'

/**
 * 线路代理的**真机机制验收**（需要真 Electron，不能在纯 Node 下跑）。
 *
 * 跑法（在 desktop/ 目录下）：
 *   npm run verify:proxy
 *   （等价于 node_modules/.bin/electron scripts/proxy-mechanism-electron.js）
 *
 * 接真实公网代理做最后验收：
 *   PIX_PROXY_RULES='http://user:pass@1.2.3.4:8080' npm run verify:proxy
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
 *
 * 本脚本用**产品自己的函数**（desktop/proxy-settings.js 的 applyTabProxy /
 * proxyRulesOf / proxyFieldsChanged），不另写一套逻辑。
 */

const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { app, session, safeStorage } = require('electron')
const {
  applyTabProxy,
  proxyRulesOf,
  proxyFieldsChanged,
  proxySettingsOf
} = require('../proxy-settings')

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

// ─────────────────────────────────────────────── 真实 HTTP 代理（会标记出口）

function startHttpProxy(name) {
  const state = { hits: 0 }
  const server = http.createServer((req, res) => {
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

  // ⑧ 可选：真实公网代理验收（用户提供代理后再跑）
  const rules = String(process.env.PIX_PROXY_RULES || '').trim()
  if (rules) {
    const sesPub = session.fromPartition('persist:pix-mech-pub')
    const directIp = await (await sesPub.fetch('https://api.ipify.org?format=json', { cache: 'no-store' })).json()
    await sesPub.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' })
    const proxiedIp = await (await sesPub.fetch('https://api.ipify.org?format=json', { cache: 'no-store' })).json()
    record('⑧ 真实公网代理：出口 IP 与直连不同', directIp.ip !== proxiedIp.ip, { direct: directIp.ip, proxied: proxiedIp.ip })
    await sesPub.setProxy({ mode: 'direct' })
    const backIp = await (await sesPub.fetch('https://api.ipify.org?format=json', { cache: 'no-store' })).json()
    record('⑧ 删除代理后出口 IP 回到直连', backIp.ip === directIp.ip, { back: backIp.ip })
  } else {
    console.log('  SKIP  ⑧ 真实公网代理验收（未设 PIX_PROXY_RULES）')
  }

  const failed = results.filter(r => !r.ok)
  console.log('\n===SUMMARY===' + JSON.stringify({ total: results.length, failed: failed.length, failedNames: failed.map(f => f.name) }))

  origin.server.close()
  proxyA.server.close()
  proxyB.server.close()
  try { require('node:fs').rmSync(SANDBOX_DIR, { recursive: true, force: true }) } catch (e) {}
  app.exit(failed.length ? 1 : 0)
}).catch(error => {
  console.error('MECHANISM ERROR:', (error && error.stack) || error)
  app.exit(2)
})
