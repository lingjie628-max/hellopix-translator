'use strict'

/**
 * 代理相关的出口安全属性。
 *
 * 这几条不是"功能"，是**承诺**：用户设了代理，就不能有任何一条通道绕过它
 * 把真实 IP 送出去。每一条都要有测试钉住，否则下次重构顺手删掉一行，
 * 线上表现是"一切正常"，实际已经裸奔。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

/* ---------------------------------------------------------------------------
 * 1) WebRTC 不得泄漏真实 IP
 * ------------------------------------------------------------------------- */

const guardSrc = fs.readFileSync(
  path.join(__dirname, '..', 'desktop', 'src', 'proxy', 'webrtc-guard.js'), 'utf8')

test('★ WebRTC 策略必须是 disable_non_proxied_udp', () => {
  // 实测数据（Electron 33，一次 ICE 收集泄漏的 IP 条数）：
  //   default                              5 条（内网 + 真实公网）
  //   default_public_interface_only        1 条（公网照样漏）
  //   default_public_and_private_interfaces 2 条
  //   disable_non_proxied_udp              0 条  ← 只有这个真的挡住
  // 这是真机跑 verify-proxy-egress.js 得出的，不是查文档抄的。
  const m = guardSrc.match(/const POLICY = '([a-z_]+)'/)
  assert.ok(m, '找不到 POLICY 常量')
  assert.equal(m[1], 'disable_non_proxied_udp',
    '策略是 ' + m[1] + '，会泄漏真实 IP。只有 disable_non_proxied_udp 实测 0 泄漏')
})

test('★ WebRTC 策略必须设在 webContents 上（session 上没有这个方法）', () => {
  // Electron 33 实测：ses.setWebRTCIPHandlingPolicy → TypeError。
  // 它挂在 WebContents 上（electron.d.ts 里在 class WebContents 段内）。
  // 只看代码行，不看注释 —— 注释里提到这个错误用法是为了避免重犯。
  const code = guardSrc.split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert.match(guardSrc, /function applyWebRtcGuard \(wc\)/, '签名应接收 webContents')
  assert.match(code, /wc\.setWebRTCIPHandlingPolicy\(POLICY\)/, '必须调用 wc.setWebRTCIPHandlingPolicy')
  assert.doesNotMatch(code, /ses\.setWebRTCIPHandlingPolicy/,
    '这行在 Electron 33 会直接 TypeError —— 别改回 session')
})

test('★ createWebView 必须给每个 view 设防（挂不上要能发现）', () => {
  const viewSrc = fs.readFileSync(
    path.join(__dirname, '..', 'desktop', 'src', 'window', 'web-view.js'), 'utf8')
  // 允许中间夹一层兜底函数（webrtcGuardOf），只要真的对 view.webContents 设了
  assert.match(viewSrc, /webrtcGuardOf\(view\.webContents\)|applyWebRtcGuard\(view\.webContents\)/,
    'createWebView 里没有设 WebRTC 策略 —— 每个窗口都会漏真实 IP')
  // 没挂上时必须留日志，否则换 Electron 版本后静默失效。
  assert.match(viewSrc, /WebRTC 可能暴露真实 IP/, '失败分支没有告警')
  // 兜底函数自身必须存在，否则少注入一个 libs 函数就崩
  assert.match(viewSrc, /function webrtcGuardOf/, '缺少兜底，libs 少一个函数会让窗口建不出来')
})

test('★ 空桩回归：guard 面对没有该 API 的对象必须返回 false，而不是假装成功', () => {
  const { applyWebRtcGuard } = require('../desktop/src/proxy/webrtc-guard')
  assert.equal(applyWebRtcGuard(null), false)
  assert.equal(applyWebRtcGuard({}), false, '没有该方法却返回 true = 以为自己防住了')
  let got = ''
  const ok = applyWebRtcGuard({ setWebRTCIPHandlingPolicy: p => { got = p } })
  assert.equal(ok, true)
  assert.equal(got, 'disable_non_proxied_udp')
})

test('★ WebRTC 防护不是命令行开关 —— 那个开关在 Electron 33 里不存在', () => {
  // 踩过的坑：strings 搜到 disable_non_proxied_udp 就以为
  // --force-webrtc-ip-handling-policy 能用。实测无效（照样漏 5 条）。
  // 锁死：不许在启动脚本里用这个开关冒充防护。
  const bootSrc = fs.readFileSync(
    path.join(__dirname, '..', 'desktop', 'stability-boot.js'), 'utf8')
  assert.doesNotMatch(bootSrc, /appendSwitch\('force-webrtc-ip-handling-policy'/,
    '实测无效的开关 —— 会让人以为已经防住了，实际全漏')
})

/* ---------------------------------------------------------------------------
 * 2) 代理应用失败不得退回直连
 * ------------------------------------------------------------------------- */

const mainSrc = fs.readFileSync(
  path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8')

test('★ 代理应用失败必须阻止页面加载（不能先 loadURL 再说）', () => {
  // startTabLoad 里的 applyTabProxy 必须接 catch，且 catch 里要有 paintLoadError。
  const idx = mainSrc.indexOf('applyTabProxy(tab, tabProxyDeps()).then(')
  assert.ok(idx >= 0, '找不到 startTabLoad 里的 applyTabProxy 调用')
  const tail = mainSrc.slice(idx, idx + 3000)
  assert.match(tail, /\.catch\(/, 'applyTabProxy 没有 catch —— 失败会变成 unhandledRejection，页面照常打开')
  assert.match(tail, /paintLoadError/, 'catch 里没有画错误页，用户会看到空白却不知道代理没生效')
  assert.match(tail, /以免用真实网络出口/, '提示文案里的关键承诺被删了，请确认逻辑仍然成立')
})

test('★ 带认证 SOCKS5 缺中继时必须抛错，不能返回空规则（空规则 = 直连）', () => {
  const settingsSrc = fs.readFileSync(
    path.join(__dirname, '..', 'desktop', 'src', 'proxy', 'proxy-settings.js'), 'utf8')
  const idx = settingsSrc.indexOf('function applyTabProxy')
  assert.ok(idx >= 0, '找不到 applyTabProxy')
  const body = settingsSrc.slice(idx, idx + 1800)
  assert.match(body, /绝不退回直连|静默换出口/, '设计意图的注释被删了')
  assert.match(body, /throw new Error\('带认证的 SOCKS5 需要本地中继/, '缺少中继时必须 throw，不能静默降级')
})

/* ---------------------------------------------------------------------------
 * 3) 代理凭据不得跨线路串用
 * ------------------------------------------------------------------------- */

test('★ 代理认证只按触发挑战的 webContents 查，且不放行网站自身的 Basic Auth', () => {
  const idx = mainSrc.indexOf("app.on('login'")
  assert.ok(idx >= 0, '找不到 login 处理')
  const body = mainSrc.slice(idx, idx + 900)
  assert.match(body, /isProxy\s*!==\s*true\)\s*return/,
    '必须挡掉非代理认证，否则会拿代理账密去回答站点登录框')
  assert.match(body, /proxyAuthByWebContents\.get\(webContents\.id\)|tabOfWebContents\(webContents\)/,
    '凭据必须按 webContents 查，否则 A 线路的账密会被 B 线路用上')
})

/* ---------------------------------------------------------------------------
 * 4) 探测必须看真实出口 IP，而不是"端口通就算过"
 * ------------------------------------------------------------------------- */

test('★ 节点检测的结论必须来自真实出口 IP', () => {
  const detectSrc = fs.readFileSync(
    path.join(__dirname, '..', 'desktop', 'src', 'proxy', 'detect.js'), 'utf8')
  assert.match(detectSrc, /api\.ipify\.org|icanhazip/,
    '必须通过真实 HTTP 请求拿出口 IP —— 只测 TCP 握手不足以证明代理生效')
  assert.match(detectSrc, /预检\*\*没有否决权|预检.*没有否决权|hardBlock/,
    '预检只能拦 TIMEOUT，不能把"连不上目标"说成"节点失效"')
})
