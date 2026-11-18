'use strict'

/**
 * 翻译被崩溃循环保护静默摘掉 —— 2026-11-02 线上事故的回归测试。
 *
 * ## 现场
 *
 * 用户报「1.3.5 不翻译了」。服务端、额度、通道全部正常：
 *   · translate_logs 最近一条成功翻译就在 55 分钟前
 *   · 该用户还剩 275 万字符，套餐 11-16 才到期
 *   · 进程 active，零错误
 *
 * 真正原因在客户端：5 分钟内崩了 5 次 → 触发 health-guard 的崩溃循环保护
 * → `policy().disableBridge = true` → 翻译桥（guest-inject.js）作为 preload
 * **根本没被注入**。
 *
 * ## 这个设计本身没错，错在静默
 *
 * "先保证能开起来"是对的。但摘掉翻译桥之后：
 *   · 界面没有任何变化
 *   · 点「译」没反应，不报错
 *   · 用户只能认为软件坏了
 * 而实际上只要等 5 分钟重启一次就好 —— 这句话从没被传达过。
 *
 * ## 本文件守什么
 *
 * 1. clearSafeMode 必须**落盘**，否则进程内看着好了，下次启动读回旧记录，
 *    用户以为"恢复了但没用"
 * 2. translateAvailability 必须能报出 limited 和启动次数（文案要具体）
 * 3. 渲染层横幅不能被 main.js 的其它分支误关，也不能自己出错就永久挂着
 * 4. 恢复必须重建视图 —— reload() 不会重跑 preload，刷新一百次也没用
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.join(__dirname, '..')
const DESKTOP = path.join(ROOT, 'desktop')
const read = f => fs.readFileSync(path.join(DESKTOP, f), 'utf8')

// ---------------------------------------------------------------------------
// 1) health-guard.clearSafeMode
// ---------------------------------------------------------------------------

test('★ clearSafeMode 必须落盘 —— 只改内存等于没修', () => {
  const src = read('src/stability/health-guard.js')
  const fn = src.slice(src.indexOf('function clearSafeMode'))
  const body = fn.slice(0, fn.indexOf('\n  }'))

  assert.match(body, /writeState\(/, 'clearSafeMode 没调用 writeState：重启后旧记录会被读回来')
  assert.match(body, /stats\.safeMode\s*=\s*false/, '没复位 stats.safeMode')
  assert.match(body, /starts:\s*\[\]/, '没清空 starts，下次 begin() 仍会判定为崩溃循环')
  assert.match(body, /crashed:\s*false/, '没清 crashed 标记：下次启动会被算作异常退出')
})

test('clearSafeMode 必须挂到返回对象上，否则 main.js 调不到', () => {
  const src = read('src/stability/health-guard.js')
  const ret = src.slice(src.lastIndexOf('return {'))
  assert.match(ret, /\bclearSafeMode\b/, '没导出 clearSafeMode')
})

// ---------------------------------------------------------------------------
// 2) main.js 的 translateAvailability
// ---------------------------------------------------------------------------

test('★ 翻译停掉时必须能报出 limited:true（否则横幅永远不出现）', () => {
  const src = read('main.js')
  const fn = src.slice(src.indexOf('function translateAvailability'))
  const body = fn.slice(0, fn.indexOf('\n}'))

  assert.match(body, /disableBridge/, '没检查 disableBridge —— 那正是翻译桥被摘掉的标志')
  assert.match(body, /limited:\s*true/, '受限时没返回 limited:true')
  assert.match(body, /startsInWindow/, '没带启动次数：文案说不出"启动太频繁"')
})

test('translateAvailability 自身出错时必须报"正常"，不能制造假警报', () => {
  const src = read('main.js')
  const fn = src.slice(src.indexOf('function translateAvailability'))
  const body = fn.slice(0, fn.indexOf('\n}'))
  const catchBlocks = body.match(/catch \(e\) \{[\s\S]*?\}/g) || []
  assert.ok(catchBlocks.length >= 1, '没有兜底 catch')
  assert.ok(
    catchBlocks.some(b => /limited:\s*false/.test(b)),
    'catch 里没返回 {limited:false} —— 守卫自己出错会把翻译误判成坏的'
  )
})

// ---------------------------------------------------------------------------
// 3) 恢复必须重建视图
// ---------------------------------------------------------------------------

test('★ 恢复翻译必须重建 WebContentsView —— reload() 不会重跑 preload', () => {
  const src = read('main.js')
  const fn = src.slice(src.indexOf('function translateRestore'))
  const body = fn.slice(0, fn.indexOf('\n * 翻译不可用时的'))

  assert.match(body, /createWebView\(/, '没重建视图：preload 不会再被注入')
  assert.match(body, /clearSafeMode\(/, '没先清安全模式：重建的视图仍会读到 disableBridge=true')
  // 顺序：必须先清安全模式，再建视图。反过来就白干。
  const clearAt = body.indexOf('clearSafeMode(')
  const createAt = body.indexOf('createWebView(')
  assert.ok(clearAt < createAt, '顺序反了：必须先清安全模式再重建视图')
})

test('恢复时必须摘掉旧视图，否则叠在下面继续吃内存', () => {
  const src = read('main.js')
  const fn = src.slice(src.indexOf('function translateRestore'))
  const body = fn.slice(0, fn.indexOf('\n * 翻译不可用时的'))
  assert.match(body, /removeChildView/, '旧视图没摘')
})

// ---------------------------------------------------------------------------
// 4) 渲染层横幅
// ---------------------------------------------------------------------------

test('★ 渲染层必须真的把横幅显示出来，且文案不提内部术语', () => {
  const src = read('renderer/trans-health.js')
  assert.match(src, /classList\.remove\('hidden'\)/, '没有移除 hidden，横幅不会显示')
  assert.match(src, /transBannerMessage/, '没有文案生成函数')

  // 用户看不懂"安全模式""崩溃循环"这些词。
  // 只扫**文案函数的返回值**，不扫注释 —— 注释里点名这些词恰恰是为了
  // 让后来的人知道背景，扫注释等于逼着大家把原因写丢。
  const msgFn = src.slice(src.indexOf('function transBannerMessage'))
  const msgBody = msgFn.slice(0, msgFn.indexOf('\n}'))
  const banned = ['崩溃循环', 'disableBridge', 'health-guard', 'safeMode', 'preload']
  for (const w of banned) {
    assert.ok(!msgBody.includes(w), '用户文案里混进了内部术语：' + w)
  }
  // 必须告诉用户"不影响聊天"，否则会以为软件整个坏了
  assert.match(msgBody, /不影响聊天/, '文案没安抚用户：应说明聊天功能不受影响')
})

test('横幅按钮失败时必须恢复可点 —— 否则用户被永久卡死', () => {
  const src = read('renderer/trans-health.js')
  const fn = src.slice(src.indexOf('async function onTransBannerRestore'))
  const body = fn.slice(0, fn.indexOf('\ndocument.addEventListener'))
  assert.match(body, /btn\.disabled = false/, '失败后没把按钮恢复可点')
  assert.match(body, /btn\.textContent = '重试'/, '失败后没给出重试提示')
})

test('横幅元素与脚本都要真的挂进页面', () => {
  const html = read('renderer/index.html')
  assert.match(html, /id="pixTransBanner"/, 'index.html 里没有横幅容器')
  assert.match(html, /id="pixTransBannerBtn"/, '没有恢复按钮')
  assert.match(html, /src="trans-health\.js"/, '脚本没引入')

  // 顺序：必须能拿到 dom，且不能被后面的脚本覆盖
  const css = read('renderer/styles.css')
  assert.match(css, /\.pix-trans-banner/, '没有横幅样式')
})

test('横幅容器默认必须是收起的，不能一启动就挂在屏幕上', () => {
  const html = read('renderer/index.html')
  const tag = html.slice(html.indexOf('id="pixTransBanner"') - 200, html.indexOf('id="pixTransBanner"') + 120)
  assert.match(tag, /hidden/, '默认没加 hidden：翻译正常的用户也会看到告警')
})

// ---------------------------------------------------------------------------
// 5) IPC 链路完整性
// ---------------------------------------------------------------------------

test('★ preload → IPC → actions 三段必须都接上，缺一段横幅永远不出现', () => {
  const preload = read('preload.js')
  assert.match(preload, /translateStatus:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('app:translateStatus'\)/)
  assert.match(preload, /translateRestore:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('app:translateRestore'\)/)

  const ipc = read('src/ipc/app.js')
  assert.match(ipc, /reg\.handle\('app:translateStatus'/)
  assert.match(ipc, /reg\.handle\('app:translateRestore'/)

  const main = read('main.js')
  assert.match(main, /translateAvailability,/, 'main.js 没把函数交给 IPC 层')
  assert.match(main, /translateRestore,/, 'main.js 没把恢复函数交给 IPC 层')
})

// ---------------------------------------------------------------------------
// 6) 轮询降频（同一次事故的另一个发现）
// ---------------------------------------------------------------------------

test('★ 会话轮询在页面不可见时必须停 —— 否则服务端日志被刷屏', () => {
  const src = read('renderer/app.js')
  const fn = src.slice(src.indexOf('async function pollSession'))
  const body = fn.slice(0, fn.indexOf('\n}'))

  assert.match(body, /document\.hidden/, '没判 document.hidden：后台仍在每 8 秒打接口')
  assert.match(body, /refreshInFlight/, '没有 inFlight 闸：网络慢时请求会堆积')
})

test('回到前台必须立刻补一次，不能干等 8 秒', () => {
  const src = read('renderer/app.js')
  assert.match(src, /visibilitychange/, '没有可见性监听')
  const at = src.lastIndexOf('visibilitychange')
  const after = src.slice(at, at + 260)
  assert.match(after, /pollSession\(\)/, '回到前台没触发续期')
})
