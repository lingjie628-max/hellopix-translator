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
  proxySettingsOf,
  proxyFieldsChanged,
  applySessionProxy,
  applyTabProxy
} = require('../desktop/proxy-settings')

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

test('proxyRulesOf：账号密码做 URL 编码，不裸拼进规则串', () => {
  const rules = proxyRulesOf({
    proxyType: 'socks5',
    proxyHost: '127.0.0.1',
    proxyPort: '1080',
    proxyUser: 'user@corp',
    proxyPass: 'p@ss:word'
  })
  // 裸拼会得到 socks5://user@corp:p@ss:word@127.0.0.1:1080，被 Electron 解析错。
  assert.equal(rules, 'socks5://user%40corp:p%40ss%3Aword@127.0.0.1:1080')
})

test('proxyRulesOf：整行粘贴（主机:端口:账号:密码）也能解析', () => {
  const rules = proxyRulesOf({ proxyType: 'http', proxyHost: '1.2.3.4:8080:u1:p1' })
  assert.equal(rules, 'http://u1:p1@1.2.3.4:8080')
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
  assert.ok(mainSrc.includes("require('./proxy-settings')"), 'main.js 应引用共享模块')
})

test('proxy-settings.js 不 require electron（否则测试又加载不了）', () => {
  const src = fs.readFileSync(path.join(root, 'desktop', 'proxy-settings.js'), 'utf8')
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
  const idx = mainSrc.indexOf("ipcMain.handle('app:proxySettings'")
  assert.ok(idx > 0, '缺少 app:proxySettings IPC')
  const body = mainSrc.slice(idx, idx + 600)
  assert.ok(body.includes('isMainSender(event)'), '必须校验来源是主窗口')
  assert.ok(body.includes('proxySettingsOf'), '必须用 proxySettingsOf 只挑代理字段')
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
