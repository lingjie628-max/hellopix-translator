const { coversFile, missingFromWhitelist } = require('./helpers/whitelist')
'use strict'

/**
 * 实例页面加载失败时的错误页（`desktop/load-error-page.js`）。
 *
 * ## 真机现场（2026-10-16 的 hello-pix 日志）
 *
 * 用户装 0.1.26、开着 54 个实例，日志里是**持续性**网络故障：
 *
 * ```
 *   19:27:48  /client/session  连不上服务器（UND_ERR_CONNECT_TIMEOUT）
 *             attempted addresses: 104.21.6.157:443, timeout: 4000ms
 *   20:26:13  同样超时（这次是 172.67.134.254:443）
 *   18:20 ~ 20:26 共 8 次 NETWORK_TIMEOUT / NETWORK_UNREACHABLE
 * ```
 *
 * 两个 IP 都属于 Cloudflare —— **这台机器连我们自己的后端都连不上**。
 * 用户的表现是「有的窗口直接就是黑的，有的可以打开扫码」：同一个软件、
 * 同一版本、同一时刻，差别只在"那一刻这个实例连没连上"。
 *
 * ## 缺陷
 *
 * `startTabLoad()` 里只有 `loadURL(tab.url)`，**没有 catch、没有 did-fail-load**。
 * 失败后 Chromium 什么都不画，用户看到的就是 `createWebView` 设的背景色
 * `#081628` —— 一块看起来像"软件坏了"的深色空白。于是网络问题被当成软件故障。
 *
 * 这些测试把错误页的两个关键性质钉死：
 *   ① **说清是什么问题、该做什么**（否则用户还是只能来问客服）
 *   ② **能自己重试**，且不依赖主进程（主进程卡住时按钮仍要能用）
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const {
  describeLoadError,
  buildLoadErrorPage,
  shouldShowErrorPage
} = require(path.join(__dirname, '..', 'desktop', 'src/stability/load-error-page.js'))

const root = path.join(__dirname, '..')
const MAIN = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')

// ---------------------------------------------------------------- 错误码翻译

test('★ 常见网络错误码要翻成人能看懂的话', () => {
  const cases = [
    [-106, /没联网|没有联网/],
    [-105, /解析|打不开/],
    [-102, /连不上|拒绝/],
    [-118, /超时/],
    [-109, /不可达/],
    [-130, /代理/],
    [-120, /代理|SOCKS/i]
  ]
  for (const [code, re] of cases) {
    const r = describeLoadError(code)
    assert.ok(r.title && r.title.length > 0, code + ' 必须有标题')
    assert.match(r.title, re, code + ' 的标题应说明问题类别')
  }
})

test('★ 每个说明都必须给出"该做什么"，不能只说问题', () => {
  // 用户拿到"连接超时"这四个字还是无从下手。必须给动作。
  const codes = [-106, -105, -102, -101, -118, -7, -109, -113, -138, -130, -120, -201, -20, -999]
  for (const code of codes) {
    const r = describeLoadError(code)
    assert.ok(r.hint && r.hint.length >= 8, code + ' 必须有可操作的建议')
    assert.match(r.hint, /请|检查|确认|重试|更换/, code + ' 的建议要给动作')
  }
})

test('SOCKS5 失败要指向"代理设置"（这是本产品的真实场景）', () => {
  const r = describeLoadError(-120)
  assert.match(r.title, /SOCKS5|代理/i)
  assert.match(r.hint, /代理/, '必须让用户知道去哪儿改')
})

test('未知错误码要附上原始码，便于真机排障', () => {
  const r = describeLoadError(-7777, 'SomeWeirdError')
  assert.match(r.hint, /-7777/, '带上原始码，用户截图发来就能定位')
  assert.match(r.hint, /SomeWeirdError/)
})

test('未知错误码也得给可操作建议（不是一句"未知错误"了事）', () => {
  const r = describeLoadError(-7777, 'X')
  assert.match(r.hint, /请|检查|重试/)
})

// ---------------------------------------------------------------- 错误页内容

test('★ 错误页要能自己重试（不依赖主进程 IPC）', () => {
  const page = decodeURIComponent(buildLoadErrorPage({ code: -118, url: 'https://web.whatsapp.com/' }))
  assert.match(page, /重新加载/, '必须有重试按钮')
  // 走 location.href 而不是任何 IPC —— 主进程卡住时按钮仍要能用
  assert.match(page, /location\.href/, '重试必须自己跳转，不能依赖主进程')
  assert.ok(!/window\.pix|ipcRenderer|postMessage/.test(page),
    '错误页不得依赖任何 IPC（主进程正忙时那条路是死的）')
})

test('错误页要显示目标地址，好让重试有去处', () => {
  const page = decodeURIComponent(buildLoadErrorPage({ code: -118, url: 'https://web.whatsapp.com/' }))
  assert.match(page, /data-url="https:\/\/web\.whatsapp\.com\/"/)
})

test('没有目标地址时按钮禁用，而不是给一个点了没反应的按钮', () => {
  const page = decodeURIComponent(buildLoadErrorPage({ code: -118, url: '' }))
  assert.match(page, /disabled/, '没有可重试地址时必须禁用，不能留一个死按钮')
})

test('要显示是哪个实例失败（多开时用户分不清是哪个）', () => {
  const page = decodeURIComponent(buildLoadErrorPage({ code: -118, url: 'https://x.com/', platformName: '接粉顾问5' }))
  assert.match(page, /接粉顾问5/)
})

test('错误码要出现在页面上（用户截图就能带给我们）', () => {
  const page = decodeURIComponent(buildLoadErrorPage({ code: -130, url: 'https://x.com/' }))
  assert.match(page, /-130/)
})

test('★ 目标 URL 必须转义（可能带查询串/引号，不能拼出注入）', () => {
  const nasty = 'https://x.com/?a="><script>alert(1)</script>'
  const page = decodeURIComponent(buildLoadErrorPage({ code: -118, url: nasty }))
  // 原始 <script> 不该作为标签出现（应已被转义成实体）
  assert.ok(!/<script>alert\(1\)<\/script>/.test(page),
    '用户可控的 URL 不能直接嵌入 HTML')
  assert.match(page, /&lt;script&gt;|&#39;|&quot;/, '应当被转义')
})

test('错误页背景色与 createWebView 一致（避免失败时闪白屏）', () => {
  const page = decodeURIComponent(buildLoadErrorPage({ code: -1, url: 'https://x.com/' }))
  assert.match(page, /#081628/, '要与 createWebView 的 setBackgroundColor 一致')
})

test('是 data: URL（网络坏了也能渲染出来）', () => {
  const page = buildLoadErrorPage({ code: -118, url: 'https://x.com/' })
  assert.match(page, /^data:text\/html;charset=utf-8,/, '必须离线可渲染')
})

// ---------------------------------------------------------------- 去重规则

test('★ ERR_ABORTED(-3) 不显示错误页（它是被新导航取代，不是失败）', () => {
  assert.equal(shouldShowErrorPage(-3), false,
    '不排除 -3 会在正常重定向时误报，用户会看到莫名其妙的错误页')
})

test('真实失败要显示错误页', () => {
  for (const code of [-106, -105, -102, -118, -130, -120]) {
    assert.equal(shouldShowErrorPage(code), true, code + ' 应当显示错误页')
  }
})

// ---------------------------------------------------------------- main.js 接线

test('★ startTabLoad 必须接住 loadURL 的失败', () => {
  const body = MAIN.slice(MAIN.indexOf('function startTabLoad('))
  const head = body.slice(0, body.indexOf('\n}'))
  assert.match(head, /loadURL\(tab\.url\)/, '仍要加载目标地址')
  assert.match(head, /\.catch\(/, '★ 没有 catch 就是这个缺陷本身 —— 失败后一片空白')
})

test('★ 必须挂 did-fail-load（promise 之外的到达通道）', () => {
  // 精确取 createWebView 里的那一个 —— 文件里还有探针窗口/disableAutoLoad 的
  // did-fail-load，用 indexOf 会抓错。
  const idx = MAIN.indexOf("view.webContents.on('did-fail-load'")
  assert.ok(idx > 0, 'createWebView 里必须挂 did-fail-load')
  assert.match(MAIN, /on\('did-fail-load'/, '有些失败只走事件不走 promise')
  const block = MAIN.slice(idx, idx + 600)
  assert.match(block, /isMainFrame|isMain/, 'iframe 失败不该顶掉整页（WhatsApp 里有第三方 iframe）')
  assert.match(block, /paintLoadError/, '必须接到错误页')
})

test('paintLoadError 必须防递归（错误页自己失败时不能再画错误页）', () => {
  const idx = MAIN.indexOf('function paintLoadError(')
  assert.ok(idx > 0)
  const block = MAIN.slice(idx, idx + 1600)
  assert.match(block, /data:text\/html/, '已在错误页上就直接返回，否则会无限重画')
})

test('paintLoadError 必须去重（promise 与事件会同时到达）', () => {
  const idx = MAIN.indexOf('function paintLoadError(')
  const block = MAIN.slice(idx, idx + 1600)
  assert.match(block, /tab\.loadErrorUrl|getURL\(\)/, '两条通道同时到达时只能画一次')
})

test('加载成功要清掉错误页标记，否则下次失败不再提示', () => {
  assert.match(MAIN, /tab\.loadErrorUrl = ''/, '不清理会形成一个"点了没反应"的死角')
})

test('加载失败要留日志（真机排障的唯一线索）', () => {
  const idx = MAIN.indexOf('function paintLoadError(')
  const block = MAIN.slice(idx, idx + 1600)
  assert.match(block, /clientLog\.warn\('load'/, '必须留痕，否则事后仍只能靠用户复述')
})

// ---------------------------------------------------------------- 打包白名单

test('★ load-error-page.js 必须在打包白名单里（漏了会启动即崩）', () => {
  // main.js 顶部 require('./src/stability/load-error-page')。打包后 app.asar 里若没这个文件，
  // require 会抛 MODULE_NOT_FOUND —— 窗口都建不出来。
  // tab-budget.js 当初就踩过这个坑，这里加护栏。
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'))
  const files = (pkg.build && pkg.build.files) || []
  assert.ok(coversFile(files, 'src/stability/load-error-page.js'), 'load-error-page.js 不在 build.files 覆盖范围内')
})

test('★ 白名单必须覆盖 main.js 直接 require 的本地模块', () => {
  // 通用的护栏：把 main.js 里所有本地 require 抓出来，逐个核对白名单。
  // 这样以后再新增模块、忘了加白名单，会在这里被拦下 —— 而不是等安装包发布后崩。
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'))
  const files = (pkg.build && pkg.build.files) || []
  const missing = missingFromWhitelist(MAIN, files, rel => fs.existsSync(path.join(root, 'desktop', rel)))
  assert.deepEqual(missing, [], '这些本地模块被 main.js require 但不在打包白名单覆盖范围内')
})
