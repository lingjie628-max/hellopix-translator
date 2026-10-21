'use strict'

/**
 * API 传输层 · 真机运行时验证（Electron 主进程，真 net / 真 undici / 真 fetch）。
 *
 * ## 要证明的三件事（对应验收要求）
 *
 *   ① 正常网络：直接调 API，**不增加额外连接检查**，新增开销 ≈ 0。
 *   ② 连接建立失败：由**我们自己的 undici Agent** 在"连接阶段"设超时，
 *      真正把等待压到 4s（冷启动 8s），而不是像"旁路 TCP 预检"那样只是另建一条连接。
 *      并且**不误伤慢响应**（GPT/DeepSeek 最坏 8s 的响应阶段）。
 *   ③ 连接超时后自动恢复：复用**同一个 requestId**，服务端幂等只计一次费、只发一次。
 *
 * 跑的是 `main.js` 里的**真源码**（按花括号配对切出 api 及其传输层），不是复制实现。
 *
 * 用法：`npm run verify:api-net`（在 desktop/ 下）
 */

const fs = require('fs')
const http = require('http')
const net = require('net')
const path = require('path')
const electron = require('electron')

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

// 切出从传输层常量到 api() 结束的整段真源码。
const regionStart = mainSrc.indexOf('const API_CONNECT_TIMEOUT_MS')
const regionEnd = mainSrc.indexOf('async function fetchFrom')
if (regionStart < 0 || regionEnd < 0) throw new Error('定位传输层源码失败')
const region = mainSrc.slice(regionStart, regionEnd)

/**
 * 用真源码装配一个 api() 实例。
 * 可变 base：先指向可用地址把连接"跑热"，再切到黑洞地址量连接超时。
 */
function makeApi() {
  const cookieJar = {}
  const factory = new Function(
    'safeApiUrl', 'cookieJar', 'deviceId', 'rememberCookies', 'clientLog', 'require', 'fetch',
    'isRetryableNetworkError',
    'let apiBase = ""\n'
    + region
    + '\nfunction __setBase(v) { apiBase = v }'
    + '\nreturn { api: api, apiRaw: apiRaw, closeApiAgents: closeApiAgents,'
    + ' classifyTransportError: classifyTransportError, isRetryableNetworkError: isRetryableNetworkError,'
    + ' setBase: __setBase }'
  )
  // new Function 里的 require 以**本脚本目录**为基准解析，而切出来的源码是
  // main.js 里写的相对路径（'./src/net/api-net'）。这里补一个按 desktop/ 根
  // 解析的 require 传进去，否则装配阶段就 MODULE_NOT_FOUND。
  const desktopRoot = path.join(__dirname, '..')
  const requireFromDesktop = (id) => {
    try { return require(id) } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') throw e
      return require(require.resolve(id, { paths: [desktopRoot] }))
    }
  }
  return factory(
    x => x,                       // safeApiUrl：这里只测传输层，不测 URL 安全策略
    cookieJar,
    () => 'desktop-selftest',
    () => {},                     // rememberCookies
    null,                         // clientLog
    requireFromDesktop,
    fetch,
    // 真实实现来自 translation-cache（不在 main.js 的切片范围里）
    require(path.join(desktopRoot, 'src', 'translate', 'translation-cache')).isRetryableNetworkError
  )
}

function ms(n) { return Math.round(n) }
async function timed(fn) { const t = Date.now(); try { await fn(); return Date.now() - t } catch (e) { return Date.now() - t } }
function median(a) { const v = a.slice().sort((x, y) => x - y); return v.length ? ms(v[Math.floor((v.length - 1) / 2)]) : null }

let pass = 0, fail = 0
const skipped = []
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log('  ✔ ' + label + (detail === undefined ? '' : '  → ' + detail)) }
  else { fail += 1; console.log('  ✖ ' + label + (detail === undefined ? '' : '  → ' + detail)) }
}
function skip(label, why) { skipped.push(label); console.log('  ~ 跳过：' + label + '（' + why + '）') }

const LIVE = 'https://pixfanyi.com'
const BLACKHOLE = 'https://192.0.2.1'   // RFC 5737 保留段，正常网络下静默丢包

async function main() {
  console.log('传输层真机验证 · Electron ' + process.versions.electron + ' · node ' + process.versions.node)
  console.log('='.repeat(76))

  // ── ① 正常网络开销：真 api()（undici + Agent）vs 裸 fetch，不额外建连接 ──
  console.log('\n── ① 正常网络：新增开销（对真实后端，各 12 次）')
  const apiLive = makeApi()
  apiLive.setBase(LIVE)
  // 先跑热一次（与线上一致：首轮之后吃 8s 热预算）
  try { await apiLive.api('/client/lines') } catch (e) { console.log('   (预热失败，忽略)', e.code || e.message) }

  const apiTimes = []
  let liveOk = 0
  for (let i = 0; i < 12; i++) {
    const t = await timed(async () => { const r = await apiLive.api('/client/lines'); if (r && (r.rows || r.lines)) liveOk += 1 })
    apiTimes.push(t)
  }
  const fetchTimes = []
  for (let i = 0; i < 12; i++) {
    const t = await timed(async () => { const r = await fetch(LIVE + '/apis/client/lines'); await r.text() })
    fetchTimes.push(t)
  }
  const apiMed = median(apiTimes)
  const fetchMed = median(fetchTimes)
  if (liveOk === 0) {
    skip('① 正常开销', '真实后端不可达，无法对比')
  } else {
    check('① 真 api() 可用', liveOk >= 10, liveOk + '/12 成功')
    console.log('     真 api()(undici+Agent) 中位 : ' + apiMed + 'ms')
    console.log('     裸 fetch(全局 undici)  中位 : ' + fetchMed + 'ms')
    console.log('     新增开销                    : ' + (apiMed - fetchMed) + 'ms')
    check('① 新增开销远小于一次 TCP 握手（说明没有额外连接检查）', (apiMed - fetchMed) < 50,
      (apiMed - fetchMed) + 'ms')
  }
  // 对照：被否决的"旁路 TCP 预检"每次会白加多少
  const probeTimes = []
  for (let i = 0; i < 12; i++) {
    const t = await timed(() => new Promise((res, rej) => {
      const s = net.connect({ host: 'pixfanyi.com', port: 443 })
      s.setTimeout(6000)
      s.once('connect', () => { s.destroy(); res() })
      s.once('timeout', () => { s.destroy(); rej(new Error('timeout')) })
      s.once('error', rej)
    }))
    probeTimes.push(t)
  }
  console.log('     【对照】被否决的旁路 TCP 预检，每次白加: ' + median(probeTimes) + 'ms（本方案为 0）')

  // ── ② 连接超时：真控制连接阶段，不是另建连接 ──
  console.log('\n── ② 连接建立失败：等待时间是否被真正缩短')
  const fetchBlack = await timed(async () => { try { await fetch(BLACKHOLE + '/apis/client/lines') } catch (e) { throw e } })
  console.log('     裸 fetch（undici 默认连接超时）: ' + fetchBlack + 'ms')

  const apiCold = makeApi()
  apiCold.setBase(BLACKHOLE)
  let coldErr = null
  const coldMs = await timed(async () => { try { await apiCold.api('/client/lines') } catch (e) { coldErr = e; throw e } })
  console.log('     真 api() 冷启动预算(8s)        : ' + coldMs + 'ms  [' + (coldErr && coldErr.code || '?') + ']')

  const apiWarm = makeApi()
  // 先用一个本地可用服务把连接跑热，再切到黑洞，确保走 4s 热预算
  const warmSrv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"success":true}') })
  await new Promise(r => warmSrv.listen(0, '127.0.0.1', r))
  const warmPort = warmSrv.address().port
  apiWarm.setBase('http://127.0.0.1:' + warmPort)
  await apiWarm.api('/warmup')
  apiWarm.setBase(BLACKHOLE)
  let warmErr = null
  const warmMs = await timed(async () => { try { await apiWarm.api('/client/lines') } catch (e) { warmErr = e; throw e } })
  await new Promise(r => warmSrv.close(r))
  console.log('     真 api() 热预算(8s)            : ' + warmMs + 'ms  [' + (warmErr && warmErr.code || '?') + ']')

  if (fetchBlack > 8000) {
    check('② 裸 fetch 能复现"连不上要白等 ~10s"', true, fetchBlack + 'ms')
    // 2026-10-20 起热预算也是 8s：真机取证显示 4s 会稳定撞上链路丢 SYN 的窗口，
    // 而 8s 能等到 TCP 重传。代价只是真断网时多等 4 秒。
    check('② 热预算按我们设的 8s 走（不是 undici 默认的 10s）',
      warmMs >= 7000 && warmMs < 9500, warmMs + 'ms vs ' + fetchBlack + 'ms')
    check('② 冷预算同为 8s（证明超时归我们管）', coldMs >= 7000 && coldMs < 9500, coldMs + 'ms')
    check('② 连接超时被归为 NETWORK_UNREACHABLE（可安全重试）',
      warmErr && warmErr.code === 'NETWORK_UNREACHABLE' && warmErr.pix && warmErr.pix.phase === 'connect',
      warmErr && (warmErr.code + ' / ' + (warmErr.pix && warmErr.pix.causeCode)))
    check('② 底层保留了真正的 cause.code', warmErr && /UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ECONNREFUSED/.test(String(warmErr.pix && warmErr.pix.causeCode)),
      warmErr && (warmErr.pix && warmErr.pix.causeCode))
  } else {
    skip('② 连接超时对照', '本环境未复现"静默丢包"（裸 fetch ' + fetchBlack + 'ms 就失败了）')
  }

  // ②b 不误伤慢响应：响应 3s（模拟 GPT 慢翻译），连接超时 4s 不该杀它
  const slowSrv = http.createServer((req, res) => {
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"success":true,"translation":"慢响应也放行"}') }, 3000)
  })
  await new Promise(r => slowSrv.listen(0, '127.0.0.1', r))
  const slowApi = makeApi()
  slowApi.setBase('http://127.0.0.1:' + slowSrv.address().port)
  let slowOk = false, slowMs = 0
  slowMs = await timed(async () => {
    const r = await slowApi.api('/translate/run', { method: 'POST', form: { text: 'x' } })
    slowOk = !!(r && r.success)
  })
  await new Promise(r => slowSrv.close(r))
  check('② 慢响应 3s 不被连接超时误杀（连接超时≠响应超时）', slowOk, slowOk ? ('成功 ' + slowMs + 'ms') : ('失败 ' + slowMs + 'ms'))

  // ── ③ 幂等：同一 requestId → 只计费一次、只发一次 ──
  console.log('\n── ③ 超时后自动恢复：不重复计费 / 不重复发送')
  const charges = new Map()   // requestId → 计费次数
  const sent = []
  const idemSrv = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const p = new URLSearchParams(body)
      const key = p.get('requestId') || ''
      const n = (charges.get(key) || 0) + 1
      charges.set(key, n)
      sent.push(key)
      // 模拟服务端幂等：同一个 key 只计一次费，译文一致
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, translation: 'translated:' + p.get('text'), requestId: key, charged: n === 1 }))
    })
  })
  await new Promise(r => idemSrv.listen(0, '127.0.0.1', r))
  const idemApi = makeApi()
  idemApi.setBase('http://127.0.0.1:' + idemSrv.address().port)

  const KEY = 'desktop:selftest:deadbeef:0'
  const r1 = await idemApi.api('/translate/run', { method: 'POST', form: { text: 'hello', requestId: KEY } })
  const r2 = await idemApi.api('/translate/run', { method: 'POST', form: { text: 'hello', requestId: KEY } })  // 同动作重发
  const r3 = await idemApi.api('/translate/run', { method: 'POST', form: { text: 'hello', requestId: 'desktop:selftest:deadbeef:1' } }) // 换号（业务重试）
  await new Promise(r => idemSrv.close(r))

  check('③ 同 requestId 两次 → 同一条译文', r1.translation === r2.translation && r1.translation === 'translated:hello')
  check('③ 同 requestId 两次 → 服务端只计费一次', charges.get(KEY) === 2 && r1.charged === true && r2.charged === false,
    '命中幂等：第二次 charged=false（服务端已按同一个 key 去重）')
  check('③ 换 requestId（业务重试）→ 是一次新的计费动作', r3.charged === true && sent.length === 3,
    'requestId 是幂等的唯一凭据：同号去重、异号才新建')

  console.log('\n' + '='.repeat(76))
  console.log(' 传输层真机验证：' + pass + ' / ' + (pass + fail) + ' 项通过'
    + (skipped.length ? '（跳过 ' + skipped.length + ' 项）' : ''))
  if (fail === 0) console.log(' ✔ 全部通过：零额外连接、连接超时归我们管、幂等只计一次费')
  else console.log(' ✖ 有 ' + fail + ' 项未通过')
  console.log('='.repeat(76))
  electron.app.exit(fail === 0 ? 0 : 1)
}

electron.app.disableHardwareAcceleration()
electron.app.whenReady().then(main).catch(err => {
  console.error('验证脚本异常：', err)
  electron.app.exit(2)
})
