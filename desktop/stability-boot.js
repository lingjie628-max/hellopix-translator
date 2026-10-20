'use strict'

/**
 * stability-boot —— 应用真正的入口（替代 package.json 里的 "main": "main.js"）。
 *
 * ## 为什么要有这一层
 *
 * 本轮要修的三件事，全部落在 main.js 的**边界**上：
 *
 *   · 主进程未捕获异常 → exit(1) → app.exit()：在 log-file 的出口上；
 *   · 实例渲染进程崩溃不恢复：在 `WebContentsView` 的 webContents 上；
 *   · 无响应没人接：在同一个 webContents 的 `unresponsive` 事件上。
 *
 * 这三处**都不需要改 main.js 内部逻辑** —— 都能在「main.js 被 require 之前」
 * 或「webContents 刚被创建时」接住。所以这里做三件事：
 *
 *   1. 在 require('./main.js') **之前** 把 log-file 的出口换掉（见 stability-wiring）；
 *   2. 监听 `web-contents-created` / `browser-window-created`，给每个界面挂恢复链；
 *   3. 启动记账（崩溃循环 → 安全模式）。
 *
 * 结果：**177KB 的 main.js 一个字都不用改**。升级上游版本时不会因为 patch
 * 打不上而卡住，也不存在"改错一行把整个应用带崩"的风险。
 *
 * ## 开关（便于真机二分，不需要改代码）
 *
 *   PIX_GUARD_OFF=1          完全关闭本层（等价于回到原来直接跑 main.js）
 *   PIX_DISABLE_SAFE_MODE=1  只关闭「崩溃循环 → 安全模式」，其它照旧
 *   PIX_GUARD_DIR=<path>     状态文件目录（默认 <appData>/hello-pix）
 */

const path = require('path')

const electron = require('electron')
const app = electron && electron.app
if (!app) {
  console.error('[boot] 请在 desktop 目录执行 npx electron . ，不要用 node 直接跑')
  process.exit(1)
}

const { createHealthGuard } = require('./health-guard')
const wiring = require('./stability-wiring')

const GUARD_OFF = String(process.env.PIX_GUARD_OFF || '') === '1'
const SAFE_MODE_OFF = String(process.env.PIX_DISABLE_SAFE_MODE || '') === '1'

/**
 * 状态目录。
 *
 * ## 不能用 app.getPath('userData')
 *
 * main.js 里 `applyAppIdentity()` 会 `app.setName('Hello Pix')`，而 userData
 * 是由 app name 推导的 —— 在 setName **之前**取 userData 会算到另一个目录去
 * （`Electron` 而不是 `Hello Pix`）。本层必须在 ready 之前记启动次数，
 * 所以用 OS 级的 appData 拼一个自己的固定目录，与 setName 无关。
 */
function resolveStateDir() {
  const override = String(process.env.PIX_GUARD_DIR || '').trim()
  if (override) return override
  try {
    return path.join(app.getPath('appData'), 'hello-pix')
  } catch (e) {
    try { return path.join(app.getPath('temp'), 'hello-pix') } catch (e2) { return path.join(process.cwd(), '.hello-pix') }
  }
}

/**
 * 日志适配。
 *
 * 不自己建 logger：main.js 的 `installConsoleBridge` 会把**全局 console**
 * 接到它的日志文件上，所以这里走 console 就等于走同一份日志 ——
 * 不用第二个写入流，也不会和它的按天轮转打架。
 */
const consoleLog = {
  debug: (scope, msg) => { try { console.log('[guard][' + scope + '] ' + msg) } catch (e) {} },
  info: (scope, msg) => { try { console.log('[guard][' + scope + '] ' + msg) } catch (e) {} },
  warn: (scope, msg) => { try { console.warn('[guard][' + scope + '] ' + msg) } catch (e) {} },
  error: (scope, msg) => { try { console.error('[guard][' + scope + '] ' + msg) } catch (e) {} },
  fatal: (scope, msg) => { try { console.error('[guard][' + scope + '] ' + msg) } catch (e) {} }
}

let guard = null

if (!GUARD_OFF) {
  guard = createHealthGuard({
    app: app,
    dir: resolveStateDir(),
    log: consoleLog,
    options: SAFE_MODE_OFF ? { crashLoopStarts: Number.MAX_SAFE_INTEGER } : {}
  })

  // ---- 1) 启动记账（必须在 ready 之前：安全模式要在这里决定关不关 GPU）----
  const stats = guard.begin()
  global.__pixGuard = guard

  /**
   * ---- 2) 保守的 Chromium 缓存上限 ----
   *
   * 这两个开关只**减少**磁盘占用，不改渲染行为：
   * 多开几十个 WhatsApp Web 时，默认缓存会各自膨胀到几百 MB，
   * 那是"越用越卡"的一大部分（换页 + 索引膨胀）。
   * 20MB 媒体缓存对聊天场景足够 —— 图片过期会重下，但不会卡。
   */
  try {
    app.commandLine.appendSwitch('disk-cache-size', String(100 * 1024 * 1024))
    app.commandLine.appendSwitch('media-cache-size', String(20 * 1024 * 1024))
  } catch (e) {}

  // ---- 3) 换掉 log-file 的退出出口（必须在 require main.js 之前）----
  try {
    wiring.wrapAttachProcessHandlers(require('./log-file'), guard)
  } catch (e) {
    console.error('[boot] 包装 log-file 失败，退化为原生行为：' + (e && e.message))
  }

  // ---- 4) 给每个界面挂恢复链 ----
  const shellCrashCount = new Map()
  /** 外壳窗口的 webContents.id（在 browser-window-created 里登记） */
  const shellIds = new Set()
  /** webContents.id → 拆线器（探测窗口、已销毁的界面要撤掉） */
  const disposers = new Map()

  function reloadWebContents(wc) {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return
    let url = ''
    try { url = String(wc.getURL() || '') } catch (e) {}
    // 从没成功加载过（空白页 / 刚创建）：reload 没有意义，交给页面自己加载。
    if (!url || url === 'about:blank') return
    // 已经在错误页上：reload 会说"重新加载错误页"，必须换回原地址。
    if (url.indexOf('data:text/html') === 0) {
      try { wc.reload() } catch (e) {}
      return
    }
    const job = wc.loadURL(url)
    if (job && typeof job.catch === 'function') job.catch(() => {})
  }

  function giveUp(wc, reason) {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return
    try {
      wc.loadURL(wiring.buildGiveUpPage({
        code: reason,
        title: '这个窗口连续崩溃，已停止自动恢复',
        hint: '请关闭这个窗口后重新打开。如果同一账号反复出现，请在「设置 → 打开日志目录」把日志发给客服。'
      }))
    } catch (e) {}
  }

  app.on('web-contents-created', (_event, wc) => {
    if (!wiring.shouldWatch(wc)) return

    const dispose = guard.watchView(wc, {
      id: wiring.labelOf(wc),
      reload: () => reloadWebContents(wc),
      giveUp: reason => giveUp(wc, reason),
      onEvent: (event, payload) => {
        // 外壳界面（标签栏 / 设置 / 翻译条都在它里面）连崩两次，
        // 说明重载界面已经救不回来了 —— 直接整应用重启，比留个白窗口好。
        //
        // 用 `shellIds`（在 browser-window-created 里登记）而不是
        // `getType() === 'window'`：WebContentsView 的 webContents 在部分
        // Electron 版本里也报 'window'，那样会把「实例崩两次」误判成
        // 「外壳崩两次」→ 用户开两个账号崩一次就被重启，属于误伤。
        if (!shellIds.has(wc.id) || event !== 'gone') return
        const n = (shellCrashCount.get(wc.id) || 0) + 1
        shellCrashCount.set(wc.id, n)
        if (n >= 2) {
          console.error('[guard] 外壳界面连续崩溃 ' + n + ' 次，重启整个应用')
          guard.hardExit(1)
        }
        void payload
      }
    })

    // 记住每个 webContents 的「拆线器」：探测窗口等不该被管的界面，
    // 会在 browser-window-created 里被撤掉（见下）。
    disposers.set(wc.id, dispose)
    try { wc.once('destroyed', () => { disposers.delete(wc.id) }) } catch (e) {}
  })

  /**
   * 探测窗口要放过。
   *
   * main.js 的 `probeTextWithProxy()` 会为一个代理节点检测建一个 380x260 的
   * **隐藏** BrowserWindow，加载完就销毁。它的 webContents 同样会触发
   * `web-contents-created`（type=window）—— 如果给它装了恢复链，
   * 检测过程中的正常终止会被当成"崩溃"去重载，反而干扰节点检测。
   *
   * 判据用尺寸而不是 `show:false`：尺寸是从事件里能拿到的稳定特征，
   * 而 `show` 可能在创建后被改。用户界面最小宽度是 900（WINDOW_MIN_WIDTH），
   * 取 600 作为分界足够安全。
   */
  app.on('browser-window-created', (_event, win) => {
    try {
      if (!win || win.isDestroyed()) return
      const bounds = win.getBounds()
      if (bounds.width >= 600 && bounds.height >= 400) {
        // 用户界面（外壳）—— 登记它的 webContents，供崩溃升级判定使用。
        try { shellIds.add(win.webContents.id) } catch (e) {}
        return
      }
      const wc = win.webContents
      const dispose = wc && disposers.get(wc.id)
      if (typeof dispose === 'function') {
        dispose()
        disposers.delete(wc.id)
      }
    } catch (e) {}
  })

  // ---- 5) 正常退出时清掉「异常退出」标记 ----
  app.on('before-quit', () => {
    try { guard.markCleanExit() } catch (e) {}
  })

  // 启动日志：把这次的判定写清楚，真机排障时第一行就能看到。
  // 注意：安全模式在当前形态下**实际生效**的只有「关 GPU」与「缓存上限」
  // （见上面两处）。`policy().maxTabs` / `policy().disableBridge` 只是**建议值**，
  // 真正让它们生效需要 main.js 各一行（见 patches/main.js-integration.md 第 5 节），
  // 不在本包的零改动范围内 —— 写在这里是为了让日志能反映"本应限到几个"。
  console.log('[guard] 启动：' + JSON.stringify({
    startsInWindow: stats.starts,
    safeMode: stats.safeMode,
    policy: guard.policy()
  }))
}

// ---- 6) 交给原来的 main.js（顺序必须在上面全部完成之后）----
require('./main.js')
