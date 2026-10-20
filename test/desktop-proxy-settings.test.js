'use strict'

/**
 * 「已存在线路的代理编辑 / 删除 / 即时生效」回归测试。
 *
 * ## 被测的两个真实缺陷
 *
 * 缺陷 1 —— **没有改已有线路代理的入口**
 *   `openAddApp()` 只会**新建**一条线路（usedCount++、新 partition、新 tab），
 *   右键菜单里也没有「代理设置」。于是用户一旦把某条线路的代理填错，
 *   除了关掉重建、丢掉登录态之外没有别的办法。
 *
 * 缺陷 2 —— **改了代理不会生效**
 *   `updateTabSettings()` 只写 `tab.settings` + 落盘，从不把代理写进 session。
 *   全项目里 `applySessionProxy()` 只有一个调用点：`startTabLoad()`。
 *   所以"编辑已有线路的代理"这条路永远不生效 —— 设置看着存了，
 *   实际走的还是旧代理，直到这条线路被关掉重建。这正是用户反馈的形态。
 *
 * ## 为什么这些断言能覆盖产品代码
 *
 * 代理的构建与应用现在只有**一份实现**：`desktop/proxy-settings.js`。
 * 产品（main.js）、本测试、真机机制测试用的都是它。
 * 不存在"测试里一套、产品里另一套"的漂移。
 *
 * 涉及 main.js / 渲染层这类**在 Node 里加载不了**（会 require electron）的部分，
 * 用源码级守卫锁住关键接线：沿用仓库既有做法（见 release-arch.test.js）。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  PROXY_FIELDS,
  proxyRulesOf,
  proxyTargetOf,
  proxyAuthOf,
  proxySettingsOf,
  proxyFieldsChanged,
  applySessionProxy,
  applyTabProxy
} = require('../desktop/src/proxy/proxy-settings')

const root = path.join(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
const preloadSrc = fs.readFileSync(path.join(root, 'desktop', 'preload.js'), 'utf8')
const appSrc = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'app.js'), 'utf8')
const htmlSrc = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'index.html'), 'utf8')

/** 记录 setProxy 调用的 session 替身。真实实现只要求 session 有 setProxy。 */
function fakeSession() {
  const calls = []
  return {
    calls,
    setProxy(arg) {
      calls.push(arg)
      return Promise.resolve()
    },
    last() {
      return calls[calls.length - 1] || null
    },
    rules() {
      const last = this.last()
      return last && last.proxyRules !== undefined ? last.proxyRules : null
    },
    isDirect() {
      const last = this.last()
      return !!(last && last.mode === 'direct')
    }
  }
}

function tabOf(session, settings) {
  return { id: 'tab-' + Math.random().toString(36).slice(2, 8), settings: settings, view: { webContents: { session: session } } }
}

/** 取 main.js 里某个函数的函数体，用于源码级守卫。 */
function fnBody(src, name) {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) return ''
  const open = src.indexOf('{', start)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return ''
}

// ───────────────────────────────────────── 代理规则本身

test('proxyRulesOf：socks5 / http 生成对应 scheme，直连返回空串', () => {
  assert.equal(proxyRulesOf({ proxyType: 'none' }), '')
  assert.equal(proxyRulesOf({ proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: '1080' }), 'socks5://127.0.0.1:1080')
  assert.equal(proxyRulesOf({ proxyType: 'http', proxyHost: '10.0.0.9', proxyPort: '3128' }), 'http://10.0.0.9:3128')
})

test('【P0】账密绝不进规则串：带认证的 socks5 规则里不能出现凭据', () => {
  // Chromium 的 proxyRules 字符串不接受内嵌凭据：`socks5://u:p@host:port`
  // 实测报 net::ERR_NO_SUPPORTED_PROXIES（这是 P0 的根因）。
  // 凭据必须走认证通道：HTTP 走 app.on('login')，SOCKS5 走本地中继。
  const target = proxyTargetOf({
    proxyType: 'socks5',
    proxyHost: '127.0.0.1',
    proxyPort: '1080',
    proxyUser: 'user@corp',
    proxyPass: 'p@ss:word'
  })
  assert.deepEqual(
    { scheme: target.scheme, host: target.host, port: target.port, user: target.user, pass: target.pass, hasAuth: target.hasAuth },
    { scheme: 'socks5', host: '127.0.0.1', port: '1080', user: 'user@corp', pass: 'p@ss:word', hasAuth: true }
  )
  // 没有中继地址时不产出规则串（applyTabProxy 会先起中继，绝不静默直连）
  assert.equal(proxyRulesOf({
    proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: '1080', proxyUser: 'u', proxyPass: 'p'
  }), '')
  // 有中继地址时，Chromium 连的是本地中继，规则串仍然不含凭据
  assert.equal(proxyRulesOf({
    proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: '1080', proxyUser: 'u', proxyPass: 'p'
  }, { relayEndpoint: '127.0.0.1:41234' }), 'socks5://127.0.0.1:41234')
})

test('【P0】http/https 的账密同样不进规则串，只通过 login 事件回填', () => {
  const settings = { proxyType: 'http', proxyHost: 'gate.example', proxyPort: '8080', proxyUser: 'u1', proxyPass: 'p@ss' }
  assert.equal(proxyRulesOf(settings), 'http://gate.example:8080')
  assert.ok(!proxyRulesOf(settings).includes('u1'), '规则串不得出现账号')
  assert.ok(!proxyRulesOf(settings).includes('p@ss'), '规则串不得出现密码')
  assert.deepEqual(proxyAuthOf(settings), { scheme: 'http', host: 'gate.example', port: '8080', user: 'u1', pass: 'p@ss' })
})

test('【P0】proxyAuthOf：无代理 / 无账密一律 null（绝不凭空造出凭据）', () => {
  assert.equal(proxyAuthOf({ proxyType: 'none' }), null)
  assert.equal(proxyAuthOf({ proxyType: 'http', proxyHost: 'h', proxyPort: '1' }), null)
  assert.equal(proxyAuthOf({ proxyType: 'socks5', proxyHost: 'h', proxyPort: '1', proxyUser: '', proxyPass: '' }), null)
})

test('proxyRulesOf：整行粘贴（主机:端口:账号:密码）也能解析', () => {
  // 整行粘贴时账密被解析出来，但同样只进认证通道，不进规则串。
  const settings = { proxyType: 'http', proxyHost: '1.2.3.4:8080:u1:p1' }
  assert.equal(proxyRulesOf(settings), 'http://1.2.3.4:8080')
  assert.deepEqual(proxyAuthOf(settings), { scheme: 'http', host: '1.2.3.4', port: '8080', user: 'u1', pass: 'p1' })
})

// ───────────────────────────────────────── 第 3 项：删除代理 = direct

test('【3】没有代理时 applySessionProxy 必须显式 mode=direct', async () => {
  const ses = fakeSession()
  await applySessionProxy(ses, { proxyType: 'none' })
  assert.deepEqual(ses.last(), { mode: 'direct' }, '删除代理必须复位成 direct，否则会继续走上一次的规则')
})

test('【3】从有代理切到 none：最后一次调用是 direct，不留旧规则', async () => {
  const ses = fakeSession()
  await applySessionProxy(ses, { proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: '1080' })
  assert.equal(ses.rules(), 'socks5://127.0.0.1:1080')
  await applySessionProxy(ses, { proxyType: 'none', proxyHost: '', proxyPort: '' })
  assert.equal(ses.isDirect(), true)
  assert.equal(ses.rules(), null)
})

test('applySessionProxy：有代理时带 proxyBypassRules=<local>，本机流量不被送去代理', async () => {
  const ses = fakeSession()
  await applySessionProxy(ses, { proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: '1080' })
  assert.deepEqual(ses.last(), {
    proxyRules: 'socks5://127.0.0.1:1080',
    proxyBypassRules: '<local>'
  })
})

test('applySessionProxy：session 缺失或没有 setProxy 时安静返回，不抛异常', async () => {
  await assert.doesNotReject(() => applySessionProxy(null, { proxyType: 'socks5', proxyHost: 'h', proxyPort: '1' }))
  await assert.doesNotReject(() => applySessionProxy({}, { proxyType: 'none' }))
})

// ───────────────────────────────────────── 第 1 项：新建线路带代理

test('【1】新建线路带代理时，代理被写进这条线路自己的 session', async () => {
  const ses = fakeSession()
  const tab = tabOf(ses, { proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: '1080' })
  await applyTabProxy(tab, {})
  assert.equal(ses.calls.length, 1, '新建线路必须应用一次代理')
  assert.equal(ses.rules(), 'socks5://127.0.0.1:1080')
})

test('【1】新建线路走直连时，session 被复位成 direct', async () => {
  const ses = fakeSession()
  await applyTabProxy(tabOf(ses, { proxyType: 'none' }), {})
  assert.equal(ses.isDirect(), true)
})

test('【1】ssh 类型：先起隧道再写 session（顺序不能反）', async () => {
  const order = []
  const ses = fakeSession()
  ses.setProxy = function (arg) {
    order.push('setProxy')
    this.calls.push(arg)
    return Promise.resolve()
  }
  const tab = tabOf(ses, { proxyType: 'ssh', proxyHost: 'ssh.example.com', proxyPort: '22' })
  await applyTabProxy(tab, {
    restartSshTunnel() {
      order.push('tunnel')
      tab.settings.proxyLocal = '127.0.0.1:1080'
    }
  })
  assert.deepEqual(order, ['tunnel', 'setProxy'], '隧道没起来就写 session 会连到一个不存在的本地端口')
  assert.equal(ses.rules(), 'socks5://127.0.0.1:1080')
})

// ───────────────────────────────────────── P0：带认证 SOCKS5 走本地中继

test('【P0】带认证的 SOCKS5：先起中继，规则串指向本地中继', async () => {
  const ses = fakeSession()
  const tab = tabOf(ses, {
    proxyType: 'socks5', proxyHost: '203.0.113.9', proxyPort: '1080', proxyUser: 'u1', proxyPass: 'p1'
  })
  const asked = []
  await applyTabProxy(tab, {
    ensureSocksRelay(t, target) {
      asked.push(target)
      return Promise.resolve({ endpoint: '127.0.0.1:41234' })
    }
  })
  assert.deepEqual(asked, [{ host: '203.0.113.9', port: '1080', user: 'u1', pass: 'p1' }], '中继必须拿到这条线路自己的账密')
  assert.equal(ses.rules(), 'socks5://127.0.0.1:41234')
  const rules = String(ses.rules())
  assert.ok(!rules.includes('u1') && !rules.includes('p1') && !rules.includes('@'), '规则串里绝不能出现凭据')
})

test('【P0】带认证的 SOCKS5 而没有中继依赖时：抛错，绝不静默退回直连', async () => {
  const ses = fakeSession()
  const tab = tabOf(ses, { proxyType: 'socks5', proxyHost: 'h', proxyPort: '1080', proxyUser: 'u', proxyPass: 'p' })
  await assert.rejects(() => applyTabProxy(tab, {}), /本地中继/)
  assert.equal(ses.calls.length, 0, '没有中继就不该往 session 写任何规则（写 direct 等于静默换出口）')
})

test('【P0】从带认证 SOCKS5 切走：先释放旧中继，再写新规则', async () => {
  const order = []
  const ses = fakeSession()
  ses.setProxy = function (arg) { order.push('setProxy'); this.calls.push(arg); return Promise.resolve() }
  const tab = tabOf(ses, { proxyType: 'socks5', proxyHost: 'h', proxyPort: '1080', proxyUser: 'u', proxyPass: 'p' })
  await applyTabProxy(tab, {
    ensureSocksRelay: () => { order.push('ensure'); return Promise.resolve({ endpoint: '127.0.0.1:1' }) },
    releaseSocksRelay: () => { order.push('release') }
  })
  tab.settings = { proxyType: 'none' }
  await applyTabProxy(tab, {
    ensureSocksRelay: () => { order.push('ensure') },
    releaseSocksRelay: () => { order.push('release') }
  })
  assert.deepEqual(order, ['ensure', 'setProxy', 'release', 'setProxy'], '切走必须先关掉旧中继，再写新规则')
  assert.equal(ses.isDirect(), true)
})

test('【P0】无认证 SOCKS5 不需要中继：直接用上游地址（不白起一个本地端口）', async () => {
  const ses = fakeSession()
  let relayAsked = 0
  const tab = tabOf(ses, { proxyType: 'socks5', proxyHost: '198.51.100.7', proxyPort: '1080' })
  await applyTabProxy(tab, { ensureSocksRelay: () => { relayAsked++; return Promise.resolve({ endpoint: '127.0.0.1:1' }) } })
  assert.equal(relayAsked, 0)
  assert.equal(ses.rules(), 'socks5://198.51.100.7:1080')
})

// ───────────────────────────────────────── 第 2 项：已有线路改代理立刻生效

test('【2】已有线路改代理：同一个 session 上重新应用，最后一次是新规则', async () => {
  const ses = fakeSession()
  const tab = tabOf(ses, { proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: '1080' })

  await applyTabProxy(tab, {})                                  // 建线时
  tab.settings = Object.assign({}, tab.settings, { proxyPort: '1081' })
  await applyTabProxy(tab, {})                                  // 用户改端口后

  assert.equal(ses.calls.length, 2, '改代理必须在同一条线路的 session 上重新应用')
  assert.equal(ses.rules(), 'socks5://127.0.0.1:1081')
})

test('【2】改代理不会换 session 对象：改前改后是同一个 session', async () => {
  const ses = fakeSession()
  const tab = tabOf(ses, { proxyType: 'http', proxyHost: 'a.example', proxyPort: '8080' })
  await applyTabProxy(tab, {})
  tab.settings = Object.assign({}, tab.settings, { proxyHost: 'b.example' })
  await applyTabProxy(tab, {})
  assert.equal(tab.view.webContents.session, ses, '换 session 就等于换 partition，会丢登录态')
  assert.equal(ses.rules(), 'http://b.example:8080')
})

// ───────────────────────────────────────── 第 6 / 7 项：线路之间互不串

test('【6】改 A 的代理完全不碰 B 的 session', async () => {
  const sesA = fakeSession()
  const sesB = fakeSession()
  const tabA = tabOf(sesA, { proxyType: 'socks5', proxyHost: '111.111.111.111', proxyPort: '1080' })
  const tabB = tabOf(sesB, { proxyType: 'socks5', proxyHost: '222.222.222.222', proxyPort: '1080' })

  await applyTabProxy(tabA, {})
  await applyTabProxy(tabB, {})
  assert.equal(sesB.calls.length, 1, 'B 只应被自己那条线路应用一次')

  tabA.settings = Object.assign({}, tabA.settings, { proxyHost: '333.333.333.333' })
  await applyTabProxy(tabA, {})

  assert.equal(sesA.rules(), 'socks5://333.333.333.333:1080')
  assert.equal(sesB.calls.length, 1, '改 A 绝不能触发 B 的 setProxy')
  assert.equal(sesB.rules(), 'socks5://222.222.222.222:1080', 'B 的出口必须原封不动')
})

test('【7】重启恢复：每条线路各自恢复自己的代理，不串线', async () => {
  // 模拟 open-apps.json 落盘后重启：每行一条线路，恢复顺序与落盘顺序一致。
  const rows = [
    { id: 'A', settings: { proxyType: 'socks5', proxyHost: '10.0.0.1', proxyPort: '1080' } },
    { id: 'B', settings: { proxyType: 'http', proxyHost: '10.0.0.2', proxyPort: '3128' } },
    { id: 'C', settings: { proxyType: 'none' } }
  ]
  const sessions = {}
  const tabs = rows.map(row => {
    sessions[row.id] = fakeSession()
    return { id: row.id, settings: Object.assign({}, row.settings), view: { webContents: { session: sessions[row.id] } } }
  })

  for (const tab of tabs) await applyTabProxy(tab, {})

  assert.equal(sessions.A.rules(), 'socks5://10.0.0.1:1080')
  assert.equal(sessions.B.rules(), 'http://10.0.0.2:3128')
  assert.equal(sessions.C.isDirect(), true, '重启后直连线路必须仍是 direct')
  for (const id of ['A', 'B', 'C']) {
    assert.equal(sessions[id].calls.length, 1, `${id} 应恰好被应用一次`)
  }
})

// ───────────────────────────────────────── 第 4 / 5 项：不建 partition / 不动 usedCount

test('【4】【5】updateTabSettings 不建 partition、不动 usedCount、不重建 webview', () => {
  const body = fnBody(mainSrc, 'updateTabSettings')
  assert.ok(body.length > 100, '没找到 updateTabSettings 函数体，源码级守卫失效了')
  for (const forbidden of ['fromPartition', 'makePartition', 'createWebView', 'usedCount', 'openPlatform']) {
    assert.ok(!body.includes(forbidden), `updateTabSettings 里出现 ${forbidden}：编辑代理不该新建线路/分区`)
  }
})

test('【4】【5】applyTabProxy 只碰已传入的 session，自身不产生任何新对象', async () => {
  const ses = fakeSession()
  const tab = tabOf(ses, { proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: '1080' })
  const beforeId = tab.id
  const beforeKeys = Object.keys(tab).sort()
  await applyTabProxy(tab, {})
  assert.equal(tab.id, beforeId, 'tab id 不变')
  assert.deepEqual(Object.keys(tab).sort(), beforeKeys, 'tab 上不新增字段（更不会新增 view/session）')
  assert.equal(tab.view.webContents.session, ses, '还是同一个 session')
  assert.equal(ses.calls.length, 1)
})

// ───────────────────────────────────────── 接线守卫：入口与即时生效

test('updateTabSettings 在代理变化时调用 applyTabProxy（缺陷 2 的修复点）', () => {
  const body = fnBody(mainSrc, 'updateTabSettings')
  assert.ok(body.includes('proxyFieldsChanged'), 'updateTabSettings 必须判断代理是否变化')
  assert.ok(body.includes('applyTabProxy'), 'updateTabSettings 必须在代理变化时重新应用')
  assert.ok(body.includes('reloadTabContents'), '改完代理要 reload 这条线路，否则旧 socket 还走老代理')
})

test('startTabLoad 与 updateTabSettings 用的是同一个 applyTabProxy（不搞第二套）', () => {
  assert.ok(fnBody(mainSrc, 'startTabLoad').includes('applyTabProxy'))
  assert.ok(fnBody(mainSrc, 'updateTabSettings').includes('applyTabProxy'))
})

test('main.js 里不再保留第二份代理实现', () => {
  assert.ok(!/function applySessionProxy\s*\(/.test(mainSrc), 'applySessionProxy 只应存在于 proxy-settings.js')
  assert.ok(!/function proxyRulesOf\s*\(/.test(mainSrc), 'proxyRulesOf 只应存在于 proxy-settings.js')
  assert.ok(!/function proxyPresetOf\s*\(/.test(mainSrc), 'proxyPresetOf 只应存在于 proxy-settings.js')
  assert.ok(mainSrc.includes("require('./src/proxy/proxy-settings')"), 'main.js 应引用共享模块')
})

// ───────────────────────────────────────── P0：认证接线（只认代理、按线路匹配）

test('【P0】login 处理只认 isProxy，且按触发挑战的 webContents 精确取凭据', () => {
  const idx = mainSrc.indexOf("app.on('login'")
  assert.ok(idx > 0, 'main.js 必须监听 login 事件来处理 HTTP/HTTPS 代理认证')
  const body = mainSrc.slice(idx, idx + 1200)
  assert.ok(body.includes('authInfo.isProxy !== true'), '必须先判断 isProxy：网站自己的 Basic Auth 一律放行，绝不用代理账密去应答')
  assert.ok(body.includes('event.preventDefault()'), '确认是代理认证后才回填凭据')
  assert.ok(body.includes('proxyAuthOf'), '凭据必须来自当前线路的 settings')
  assert.ok(body.includes('tabOfWebContents') && body.includes('proxyAuthByWebContents'), '凭据必须按 webContents 精确匹配（= 按 partition 隔离，A 的账密不可能给 B 用）')
})

test('【P0】main.js 给两条应用路径都注入了中继依赖（不搞第二套接线）', () => {
  const deps = fnBody(mainSrc, 'tabProxyDeps')
  assert.ok(deps.includes('ensureSocksRelay') && deps.includes('releaseSocksRelay'), 'tabProxyDeps 必须提供中继的建/拆')
  assert.ok(fnBody(mainSrc, 'startTabLoad').includes('tabProxyDeps'), '新建 / 重启恢复路径要用同一套依赖')
  assert.ok(fnBody(mainSrc, 'updateTabSettings').includes('tabProxyDeps'), '改代理路径要用同一套依赖')
})

test('【P0】关闭线路 / 退出应用都要释放中继（不留无主监听端口）', () => {
  assert.ok(fnBody(mainSrc, 'destroyTab').includes('releaseSocksRelay'), '关闭线路必须释放它自己的中继')
  const quit = mainSrc.slice(mainSrc.indexOf("app.on('before-quit'"))
  assert.ok(quit.slice(0, 900).includes('socksRelays'), '退出时必须统一关闭所有中继')
})

test('【P0】中继是纯 Node 模块，产品与测试共用同一份实现', () => {
  const src = fs.readFileSync(path.join(root, 'desktop', 'src/proxy/socks-relay.js'), 'utf8')
  assert.ok(!/require\(['"]electron['"]\)/.test(src), 'socks-relay.js 一旦依赖 electron 就测不了')
  assert.ok(mainSrc.includes("require('./src/proxy/socks-relay')"), 'main.js 必须复用这份中继')
})

test('proxy-settings.js 不 require electron（否则测试又加载不了）', () => {
  const src = fs.readFileSync(path.join(root, 'desktop', 'src/proxy/proxy-settings.js'), 'utf8')
  assert.ok(!/require\(['"]electron['"]\)/.test(src), 'proxy-settings.js 一旦依赖 electron 就再也测不了')
})

// ───────────────────────────────────────── 第 1 项的入口：右键菜单

test('【1】右键菜单里有「代理设置」，且只把线路 id 发给渲染层', () => {
  const body = fnBody(mainSrc, 'popupTabContextMenu')
  assert.ok(body.includes('代理设置'), '右键菜单缺少「代理设置」入口')
  assert.ok(body.includes('openProxySettingsFor'), '菜单项应调用 openProxySettingsFor')
  const open = fnBody(mainSrc, 'openProxySettingsFor')
  assert.ok(open.includes("'context:proxySettings'"), '应通过专用通道把线路 id 发给渲染层')
  assert.ok(open.includes('String(id'), '只传 id，弹窗自己去读当前配置')
})

test('【1】preload 暴露了读取与订阅代理设置的通道', () => {
  assert.ok(/proxySettings:\s*\(id\)\s*=>\s*ipcRenderer\.invoke\('app:proxySettings'/.test(preloadSrc))
  assert.ok(/onProxySettings:/.test(preloadSrc) && preloadSrc.includes('context:proxySettings'))
})

test('app:proxySettings 只回传代理字段，且只认主窗口来源', () => {
  // handler 已迁到 src/ipc/tabs.js
  const impl = fs.readFileSync(path.join(root, 'desktop', 'src', 'ipc', 'tabs.js'), 'utf8')
  const idx = impl.indexOf("'app:proxySettings'")
  assert.ok(idx > 0, '缺少 app:proxySettings IPC')
  const body = impl.slice(idx, idx + 500)
  assert.ok(body.includes('proxySettingsOf'), '必须用 proxySettingsOf 只挑代理字段')
  // 来源校验已由注册器统一提供：它必须是受保护的 handle()，不能是 handleUnsafe
  assert.ok(!/handleUnsafe\('app:proxySettings'/.test(impl), '这个频道不能让客页调用')
  assert.match(impl.slice(Math.max(0, idx - 100), idx), /reg\.handle\(/,
    '必须走受保护的 reg.handle（注册器负责 isMainSender 校验）')
  // 且 main.js 里不该再有这个频道的注册
  assert.ok(!/ipcMain\.handle\('app:proxySettings'/.test(mainSrc),
    'main.js 里不该再有这个频道的注册')
})

// ───────────────────────────────────────── 第 9 项：弹窗能加载当前配置

test('【9】proxySettingsOf 原样回传全部代理字段（弹窗据此回填）', () => {
  const stored = {
    proxyType: 'ipfoxy',
    proxyScheme: 'http',
    proxyHost: 'gate-sg.ipfoxy.io',
    proxyPort: '58688',
    proxyUser: 'customer-u1-cc-US',
    proxyPass: 'secret-pass',
    // 这些不属于代理，不该回传
    sendFrom: 'auto',
    fontSize: 16
  }
  const out = proxySettingsOf(stored)
  for (const key of PROXY_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(out, key), `回填结果缺少 ${key}`)
  }
  assert.equal(out.proxyType, 'ipfoxy')
  assert.equal(out.proxyScheme, 'http')
  assert.equal(out.proxyHost, 'gate-sg.ipfoxy.io')
  assert.equal(out.proxyPort, '58688')
  assert.equal(out.proxyUser, 'customer-u1-cc-US')
  assert.equal(out.proxyPass, 'secret-pass')
  assert.ok(!('sendFrom' in out) && !('fontSize' in out), '不该把翻译设置一起回传')
})

test('【9】proxySettingsOf 对没有任何代理设置的线路给出 none，而不是 undefined', () => {
  const out = proxySettingsOf({})
  assert.equal(out.proxyType, 'none', '老线路没有 proxyType 时必须落到直连')
  assert.equal(out.proxyHost, '')
})

test('【9】弹窗 UI 存在，且用 window.pix.proxySettings 加载当前线路配置', () => {
  for (const id of ['proxySettings', 'psProxyType', 'psProxyHost', 'psProxyPort', 'psProxyUser', 'psProxyPass', 'psProxySave']) {
    assert.ok(htmlSrc.includes('id="' + id + '"'), `index.html 缺少 #${id}`)
  }
  const open = fnBody(appSrc, 'openProxySettings')
  assert.ok(open.includes('window.pix.proxySettings('), '弹窗必须读当前线路的已有配置')
  assert.ok(open.includes('psProxyHost.value'), '读取到的配置要回填到表单')
})

test('【3】弹窗提供「删除代理」，写 none 而不是清空字段了事', () => {
  assert.ok(htmlSrc.includes('id="psProxyDirect"'), '缺少删除代理按钮')
  const handler = appSrc.slice(appSrc.indexOf('psProxyDirect.onclick'))
  const body = handler.slice(0, 300)
  assert.ok(body.includes("proxyType: 'none'"), "删除代理必须显式写 proxyType: 'none'")
  for (const key of ['proxyHost', 'proxyPort', 'proxyUser', 'proxyPass']) {
    assert.ok(body.includes(key + ': '), `删除代理必须一并清掉 ${key}`)
  }
})

// ───────────────────────────────────────── 第 10 项：settings 与 session 状态一致

test('【10】应用后 session 上的规则与线路 settings 推导出的规则逐字一致', async () => {
  const cases = [
    { proxyType: 'none' },
    { proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: '1080' },
    { proxyType: 'http', proxyHost: 'proxy.local', proxyPort: '3128', proxyUser: 'u', proxyPass: 'p' },
    { proxyType: 'https', proxyScheme: 'https', proxyHost: 'secure.local', proxyPort: '8443' }
  ]
  for (const settings of cases) {
    const ses = fakeSession()
    await applyTabProxy(tabOf(ses, settings), {})
    const expected = proxyRulesOf(settings)
    if (expected) {
      assert.equal(ses.rules(), expected, 'session 上的规则与 settings 不一致：' + JSON.stringify(settings))
    } else {
      assert.equal(ses.isDirect(), true, '直连线路的 session 必须是 direct')
    }
  }
})

test('【10】proxyFieldsChanged 是"要不要重新应用"的唯一判据', () => {
  const base = { proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: '1080', proxyUser: 'u', proxyPass: 'p', proxyScheme: 'socks5' }

  // 动代理 → 必须重新应用
  assert.equal(proxyFieldsChanged(base, Object.assign({}, base, { proxyPort: '1081' })), true, '改端口')
  assert.equal(proxyFieldsChanged(base, Object.assign({}, base, { proxyHost: 'other' })), true, '改主机')
  assert.equal(proxyFieldsChanged(base, Object.assign({}, base, { proxyPass: 'new' })), true, '改密码')
  assert.equal(proxyFieldsChanged(base, Object.assign({}, base, { proxyType: 'none' })), true, '删代理')

  // 没动代理 → 不该重新应用、更不该 reload（否则每次保存翻译设置都刷新页面）
  assert.equal(proxyFieldsChanged(base, Object.assign({}, base, { fontSize: 18 })), false, '只改字号')
  assert.equal(proxyFieldsChanged(base, Object.assign({}, base, { sendFrom: 'zh' })), false, '只改翻译语言')
  assert.equal(proxyFieldsChanged(base, Object.assign({}, base)), false, '原样保存')

  // undefined 与 '' 视为相同：避免"表单空值"造成无意义 reload
  assert.equal(proxyFieldsChanged({ proxyType: 'none' }, { proxyType: 'none', proxyPass: '' }), false)
  assert.equal(proxyFieldsChanged({ proxyType: 'none', proxyHost: undefined }, { proxyType: 'none', proxyHost: '' }), false)
})

test('【10】normalizeTabSettings 不补代理字段（否则每次保存都会误判成改了代理）', () => {
  const body = fnBody(mainSrc, 'normalizeTabSettings')
  for (const key of PROXY_FIELDS) {
    assert.ok(!body.includes(key), `normalizeTabSettings 不该给 ${key} 填默认值，会导致误 reload`)
  }
})

// ───────────────────────────────────────── 第 8 项：密码不明文落盘

test('【8】落盘走 sealSettings，而 sealSettings 会加密 proxyPass', () => {
  assert.ok(mainSrc.includes('ENCRYPTED_VALUE_PREFIX = \'safe:v1:\''), '加密前缀被改动，请同步本测试')
  const seal = fnBody(mainSrc, 'sealSettings')
  assert.ok(seal.includes('proxyPass'), 'sealSettings 必须处理 proxyPass')
  assert.ok(seal.includes('ENCRYPTED_VALUE_PREFIX'), 'sealSettings 必须加上加密前缀')
  assert.ok(seal.includes('encryptString'), '必须真的调用 safeStorage.encryptString')
  assert.ok(seal.includes('delete copy.proxyPass'), 'safeStorage 不可用时应删掉密码而不是明文落盘')

  const save = fnBody(mainSrc, 'saveOpenApps')
  assert.ok(save.includes('sealSettings'), 'saveOpenApps 必须加密后再写文件')
})

test('【8】updateTabSettings 落盘路径经过 saveOpenApps（改代理后密码同样被加密）', () => {
  const body = fnBody(mainSrc, 'updateTabSettings')
  assert.ok(body.includes('saveOpenApps'), '改完设置必须落盘')
})

test('【8】渲染层只把密码交给主进程，不自己写盘', () => {
  assert.ok(!/localStorage\.setItem\([^)]*proxyPass/.test(appSrc), 'proxyPass 不该被渲染层写进 localStorage')
  assert.ok(!/document\.cookie\s*=/.test(appSrc), 'proxyPass 不该被写进 cookie')
})
