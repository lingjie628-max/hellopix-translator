const { coversFile, missingFromWhitelist } = require('./helpers/whitelist')
'use strict'

/**
 * 后台运行（关闭窗口不退出）守卫测试。
 *
 * ## 被测的风险
 *
 * 「关窗是隐藏还是退出」错一次的代价不对称：
 *
 *   - 该隐藏却退出了 → 用户以为只是收起来，翻译却停了（体验问题，能忍）
 *   - **该退出却隐藏了 → 窗口没了、没有任何入口能叫回来，进程变僵尸**
 *
 * 后者是真事故：用户只能在任务管理器里杀进程，而他多半根本不知道
 * 进程还在跑。所以判定必须偏向"宁可退出，也不要藏得找不回来"，
 * 且每一条放宽都要有明确理由。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  shouldHideOnClose,
  shouldQuitOnAllClosed,
  trayIconSize,
  trayTooltip
} = require('../desktop/src/window/background-mode')

const root = path.join(__dirname, '..')

/**
 * 装配真实的 config IPC handler（不启动 Electron）。
 * 用假的 registrar 收集 handler，state 用普通对象 —— 这里的断言只看业务语义。
 */
function configHarness () {
  const handlers = {}
  const state = {
    apiBase: 'https://a.example.com',
    theme: 'light',
    lineId: 'overseas',
    backgroundRunning: true,
    lines: [],
    proxyPresets: []
  }
  require('../desktop/src/ipc/config').registerConfigIpc({
    reg: { handle: (ch, fn) => { handlers[ch] = fn }, handleUnsafe: (ch, fn) => { handlers[ch] = fn } },
    state,
    env: {
      DEFAULT_API: 'https://a.example.com',
      EXTERNAL_HOSTS: [],
      safeApiUrl: v => v,
      fetchFrom: async () => ({}),
      isAllowedExternalUrl: () => false
    },
    actions: {
      saveConfig: () => {},
      setBackgroundRunning: v => { state.backgroundRunning = v },
      currentLine: () => ({ id: state.lineId }),
      refreshLines: async () => ({}),
      applyLine: id => ({ id, url: '' }),
      pingLine: async () => ({}),
      pingAllLines: async () => ({}),
      openExternal: async () => {},
      detectProxyNode: async () => ({})
    }
  })
  return { handlers, state }
}

// ------------------------------------------------------------ 关窗决策

test('后台运行开启且托盘就绪 → 关窗应当隐藏', () => {
  assert.equal(shouldHideOnClose({ isQuitting: false, backgroundEnabled: true, hasTray: true }), true)
})

test('★ 正在退出时必须放行，否则 app.quit() 会被自己拦下来', () => {
  // 这是最容易写错的一条：app.quit() 会先触发窗口 close，
  // 如果那时还按"关闭=隐藏"处理，退出流程就被吃掉了 ——
  // 现象是点了退出没反应，只能去任务管理器杀进程。
  assert.equal(shouldHideOnClose({ isQuitting: true, backgroundEnabled: true, hasTray: true }), false)
})

test('★ 托盘没建出来时绝不隐藏（否则进程变僵尸）', () => {
  // 没有托盘图标 = 用户没有任何入口能把窗口叫回来。
  // 这种情况下宁可老老实实退出，也不要藏起来。
  assert.equal(shouldHideOnClose({ isQuitting: false, backgroundEnabled: true, hasTray: false }), false)
})

test('用户关掉后台运行 → 关窗就是退出（保留旧行为）', () => {
  assert.equal(shouldHideOnClose({ isQuitting: false, backgroundEnabled: false, hasTray: true }), false)
})

test('决策对缺字段的参数保持安全（默认不隐藏）', () => {
  // 参数拼错/漏传时，默认走"退出"这条安全路径，而不是把窗口藏起来
  assert.equal(shouldHideOnClose({}), false)
  assert.equal(shouldHideOnClose(null), false)
  assert.equal(shouldHideOnClose(undefined), false)
})

// -------------------------------------------------- 窗口全关时的兜底

test('★ 后台运行中窗口被异常带走 → 留在托盘（点一下能重建，不该静默中断翻译）', () => {
  assert.equal(
    shouldQuitOnAllClosed({ isQuitting: false, backgroundEnabled: true, hasTray: true }),
    false)
})

test('★ 用户关掉了后台运行 → 关窗必须退出，不能拿托盘当借口赖着不走', () => {
  // 这条是实测暴露出来的：托盘一直存在，如果只判 hasTray，
  // 用户明明关了后台运行、窗口也真的销毁了，进程却还挂着 ——
  // 直接违背用户的显式设置。
  assert.equal(
    shouldQuitOnAllClosed({ isQuitting: false, backgroundEnabled: false, hasTray: true }),
    true)
})

test('没有托盘时窗口全关必须退出（没有入口能叫回窗口）', () => {
  assert.equal(shouldQuitOnAllClosed({ isQuitting: false, backgroundEnabled: true, hasTray: false }), true)
})

test('退出流程中窗口全关 → 放行', () => {
  assert.equal(shouldQuitOnAllClosed({ isQuitting: true, backgroundEnabled: true, hasTray: true }), true)
})

test('window-all-closed 的判定对缺字段保持安全（默认退出）', () => {
  assert.equal(shouldQuitOnAllClosed({}), true)
  assert.equal(shouldQuitOnAllClosed(null), true)
})

// ---------------------------------------------------------------- 图标

test('托盘图标尺寸符合平台习惯', () => {
  assert.equal(trayIconSize('darwin'), 18)
  assert.equal(trayIconSize('win32'), 16)
  assert.equal(trayIconSize('linux'), 16)
})

test('托盘提示带版本号（用户截图反馈时能直接看出装的哪版）', () => {
  assert.equal(trayTooltip('0.1.5'), 'Hello Pix 0.1.5')
  assert.equal(trayTooltip(''), 'Hello Pix')
  assert.equal(trayTooltip(null), 'Hello Pix')
})

// ---------------------------------------------------------------- 接线

test('main.js 在创建窗口之前建好托盘（关窗判定依赖它）', () => {
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  const readyAt = main.indexOf('app.whenReady()')
  const trayAt = main.indexOf('createTray()', readyAt)
  const winAt = main.indexOf('createWindow()', readyAt)
  assert.ok(trayAt > 0, 'main.js 没有调用 createTray()')
  assert.ok(winAt > trayAt,
    '托盘必须先于窗口创建 —— 关窗拦截靠 tray 是否存在决定"隐藏还是退出"，晚建会误判')
})

test('main.js 用 background-mode 的判定，而不是自己写 if', () => {
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  assert.match(main, /backgroundMode\.shouldHideOnClose\(/, '关窗判定没有走统一逻辑')
  assert.match(main, /backgroundMode\.shouldQuitOnAllClosed\(/, 'window-all-closed 没有走统一逻辑')
})

test('★ before-quit 第一件事就是立 isQuitting', () => {
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  const at = main.indexOf("app.on('before-quit'")
  assert.ok(at > 0, '找不到 before-quit')
  const body = main.slice(at, main.indexOf('})', at))
  const quitFlagAt = body.indexOf('isQuitting = true')
  const saveAt = body.indexOf('saveOpenApps()')
  assert.ok(quitFlagAt > 0, 'before-quit 没有设置 isQuitting')
  // 必须排在其它操作之前：saveOpenApps 等都可能间接触发窗口事件
  assert.ok(quitFlagAt < saveAt, 'isQuitting 必须在 saveOpenApps 之前设置')
})

test('托盘创建失败会退化为"关闭即退出"，而不是静默留个空托盘', () => {
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  const at = main.indexOf('function createTray()')
  const body = main.slice(at, main.indexOf('function refreshTrayMenu', at))
  assert.match(body, /catch \(e\)/, 'createTray 没有兜住异常')
  assert.match(body, /tray = null/, '创建失败时必须把 tray 置空，判定才会放行退出')
})

test('background-mode.js 在打包白名单里（漏了会让安装包启动即崩）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'))
  assert.ok(coversFile(pkg.build.files, 'src/window/background-mode.js'), 'background-mode.js 不在 build.files 覆盖范围内')

  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  const missing = missingFromWhitelist(main, pkg.build.files, rel => fs.existsSync(path.join(root, 'desktop', rel)))
  assert.deepEqual(missing, [], '这些本地模块被 main.js require 但不在白名单覆盖范围内')
})

test('关闭窗口时后台运行是默认开（老用户升级也直接获得新行为）', () => {
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  // `!== false` 而不是 `=== true`：老版本 config.json 里没有这个键，
  // 用 === true 会让升级上来的用户被动保持旧行为（关窗即退出）。
  assert.match(main, /backgroundRunning = cfg\.backgroundRunning !== false/,
    '默认值判断写反了：没存过这个键的用户应当直接获得后台运行')
  assert.match(main, /backgroundRunning: backgroundRunning,/, 'saveConfig 没有持久化该开关')
})

// ------------------------------------------------------------ 界面开关接线

test('★ 界面里也能开关后台运行，不用去翻托盘菜单', () => {
  const html = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'index.html'), 'utf8')
  assert.match(html, /id="systemBackgroundBtn"/, '系统操作菜单里没有后台运行开关')

  const app = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'app.js'), 'utf8')
  assert.match(app, /window\.pix\.setBackgroundRunning\(/, '界面开关没有接主进程')
  // 失败要回滚显示，否则界面写着"开"、实际是"关"，用户会以为设置生效了
  assert.match(app, /paintBackgroundButton\(res && res\.success/, '开关失败没有回滚界面状态')
})

test('config:get 会下发后台运行状态（界面初次渲染要知道当前值）', () => {
  // 不再搜源码：直接调真实 handler 看返回值
  const { handlers } = configHarness()
  const got = handlers['config:get']({})
  assert.equal(typeof got.backgroundRunning, 'boolean', 'config:get 必须返回 backgroundRunning')
  assert.equal(got.backgroundRunning, true)
})

test('★ config:setBackgroundRunning 必须校验来源，且非 false 一律按开启处理', () => {
  const { handlers, state } = configHarness()
  // 「校验来源」的约束现在由注册器统一提供（见 test/ipc-registrar.test.js，
  // 那里证明了受保护 handler 对不可信来源一次都不执行业务代码）。
  // 这里验的是业务语义：非 false 即开启。
  handlers['config:setBackgroundRunning']({}, false)
  assert.equal(state.backgroundRunning, false)
  for (const v of [undefined, null, 0, '', 'false']) {
    handlers['config:setBackgroundRunning']({}, v)
    assert.equal(state.backgroundRunning, true, '传 ' + String(v) + ' 必须按开启处理')
  }
  // 同时确认 main.js 里这个频道确实走了受保护的 ipcReg.handle
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  assert.ok(!/ipcMain\.handle\('config:setBackgroundRunning'/.test(main),
    '这个频道不能再用裸 ipcMain.handle —— 那样就没有来源校验了')
})

test('preload 暴露读写后台运行开关的接口', () => {
  const preload = fs.readFileSync(path.join(root, 'desktop', 'preload.js'), 'utf8')
  assert.match(preload, /setBackgroundRunning:/, 'preload 没有暴露 setBackgroundRunning')
  assert.match(preload, /onBackgroundRunning:/, 'preload 没有暴露状态变更回调')
})

test('托盘改了开关会推送给界面（两个入口不能各说各话）', () => {
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  const at = main.indexOf('function setBackgroundRunning(next)')
  assert.ok(at > 0, '找不到 setBackgroundRunning')
  const body = main.slice(at, main.indexOf('\n}', at))
  assert.match(body, /webContents\.send\('config:backgroundRunning'/, '改动开关后没有通知渲染层')

  const app = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'app.js'), 'utf8')
  assert.match(app, /onBackgroundRunning\(/, '渲染层没有监听状态变更')
})

test('★ macOS 点 Dock 图标要把隐藏的窗口唤回来', () => {
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  const at = main.indexOf("app.on('activate'")
  assert.ok(at > 0, '缺少 app.on(activate) —— macOS 上窗口藏了之后 Dock 点了没反应')
  const body = main.slice(at, main.indexOf('})', at))
  assert.match(body, /showMainWindow\(\)/, 'activate 没有调用 showMainWindow')
})

