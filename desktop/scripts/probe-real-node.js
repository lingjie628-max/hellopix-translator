'use strict'

/**
 * 真机对照：同一个 SOCKS5 节点，分别用「新版预检」和「旧版路径（Chromium 直接经代理加载网页）」
 * 去检测，看结论是否不一致。
 *
 * 跑法（在 desktop/ 目录下，需要网络）：
 *   node_modules/.bin/electron scripts/probe-real-node.js [host] [port] [user] [pass]
 */

const { app, BrowserWindow, session } = require('electron')
const path = require('path')
const fs = require('fs')

const root = path.join(__dirname, '..')

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

const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const { createSocksRelay, precheckSocks5 } = require(path.join(root, 'socks-relay.js'))
const { proxyTargetOf, proxyAuthOf, proxyRulesOf } = require(path.join(root, 'proxy-settings.js'))
const { readPageText } = require(path.join(root, 'probe-page.js'))

const proxyAuthByWebContents = new Map()
const probeWindows = new Set()
function parseJsonSafe (text) { try { return JSON.parse(text) } catch (e) { return null } }

const PROBE_TIMEOUT_MS = Number((mainSrc.match(/const PROBE_TIMEOUT_MS\s*=\s*(\d+)/) || [])[1] || 15000)

// 关闭预检的版本：只看「Chromium 经代理能不能真的取到网页」（= 0.1.28 及之前的判定方式）
const noPrecheckSrc = (() => {
  const src = sliceBlock(mainSrc, 'async function detectProxyNode(payload)')
  return src.replace(/await precheckSocks5\([\s\S]*?\}\)/, '({ ok: true, code: "SKIPPED" })')
})()

const probeFnSrc = sliceBlock(mainSrc, 'function probeTextWithProxy(ses, url, creds)')

function build (detectSrc) {
  const factory = new Function(
    'BrowserWindow', 'session', 'createSocksRelay', 'precheckSocks5', 'proxyTargetOf', 'proxyAuthOf',
    'proxyRulesOf', 'readPageText', 'parseJsonSafe', 'PROBE_TIMEOUT_MS',
    'probeWindows', 'proxyAuthByWebContents', 'lookupIpGeo', 'noteProxyIp',
    `${probeFnSrc}\n${detectSrc}\nreturn { detectProxyNode }`
  )
  return factory(
    BrowserWindow, session, createSocksRelay, precheckSocks5, proxyTargetOf, proxyAuthOf,
    proxyRulesOf, readPageText, parseJsonSafe, PROBE_TIMEOUT_MS,
    probeWindows, proxyAuthByWebContents,
    async (ip) => ({ ip }), () => 0
  )
}

function settingsFor (node) {
  return {
    proxyType: 'socks5',
    proxyHost: node.host,
    proxyPort: String(node.port),
    proxyUser: node.user,
    proxyPass: node.pass,
    proxyIpVer: 'ipv4',
    proxyChannel: 'dbip'
  }
}

function fmt (r) {
  if (!r) return '（无结果）'
  return (r.success ? '✅ 可用' : '❌ ' + r.msg) + (r.ip ? '  ip=' + r.ip : '')
}

async function main () {
  const [host = '186.240.232.206', port = '54565', user = 'Jz245789', pass = 'Jf789123.'] = process.argv.slice(2)
  const node = { host, port: Number(port), user, pass }
  console.log('\n=== 同一个节点，两条判定路径对照 ===')
  console.log('   节点：' + host + ':' + port + '  账号：' + user + '\n')

  // ① 纯 Node 预检（0.1.29 起、0.1.33/0.1.34 真实拦人的那道）
  const t1 = Date.now()
  const pre = await precheckSocks5(node)
  console.log('① 纯 Node 预检          :', pre.ok ? '✅ 通过' : '❌ ' + pre.code, '(' + (Date.now() - t1) + 'ms)')
  for (const t of (pre.tried || [])) console.log('     ', t.host + ':' + t.port, '->', t.code, t.ms + 'ms')

  // ② 旧路径：Chromium 经代理真的加载网页（跳过预检）
  const old = build(noPrecheckSrc)
  const t2 = Date.now()
  let oldRes = null
  try {
    oldRes = await Promise.race([
      old.detectProxyNode(settingsFor(node)),
      new Promise(r => setTimeout(() => r({ success: false, msg: '（超过 30 秒未返回）' }), 30000))
    ])
  } catch (e) {
    oldRes = { success: false, msg: '抛错：' + (e && e.message) }
  }
  console.log('② Chromium 实载网页    :', fmt(oldRes), '(' + (Date.now() - t2) + 'ms)')

  // ③ 完整新版（预检 + 实载）
  const cur = build(sliceBlock(mainSrc, 'async function detectProxyNode(payload)'))
  const t3 = Date.now()
  let curRes = null
  try {
    curRes = await Promise.race([
      cur.detectProxyNode(settingsFor(node)),
      new Promise(r => setTimeout(() => r({ success: false, msg: '（超过 30 秒未返回）' }), 30000))
    ])
  } catch (e) {
    curRes = { success: false, msg: '抛错：' + (e && e.message) }
  }
  console.log('③ 当前版本(预检+实载)  :', fmt(curRes), '(' + (Date.now() - t3) + 'ms)')

  const same = (!!oldRes.success) === (pre.ok === true) && (!!oldRes.success) === (!!curRes.success)
  console.log('\n结论：' + (same ? '三条路径结论一致' : '★ 三条路径结论不一致 —— 就是「以前能过、现在不能」的来源'))
}

app.whenReady().then(() => main().then(
  () => app.exit(0),
  (e) => { console.error('脚本异常：', e); app.exit(2) }
))
