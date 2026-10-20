'use strict'

/**
 * 健康守护（health-guard）—— 把「闪退 / 无响应 / 白屏」从「用户只能重开」
 * 变成「自动收口 + 留痕 + 循环启动时降级」。
 *
 * ## 它解决的四个真实现象（对应 0.1.43 的代码事实）
 *
 * 1. **闪退**：`log-file.attachProcessHandlers()` 对白名单外的 uncaughtException
 *    调用 `exit(1)`，而 main.js 传进去的是 `code => app.exit(code)` —— 整个进程
 *    当场消失，用户看不到任何提示，日志也可能没 flush。
 *    本模块提供 `isFatal()`（更准的分类）与 `hardExit()`（先 relaunch 再退）。
 *
 * 2. **实例渲染进程崩了没人救**：`createWebView()` 里 `render-process-gone`
 *    只写一行日志，视图就永远停在那张白/黑画面上。
 *    本模块按退避自动 reload，并有「10 分钟内最多 3 次」的熔断。
 *
 * 3. **无响应（页面卡死）没有任何监听**：Electron 的 `unresponsive` 事件
 *    全仓没人接，窗口白了也不会自愈。
 *    本模块在宽限期后 reload；仍不活就 `forcefullyCrashRenderer()`，
 *    交给上面的崩溃恢复链收口。
 *
 * 4. **崩溃循环**：连着重启三次还是崩，说明不是偶发。
 *    本模块记录启动历史，判定为崩溃循环后进入安全模式（关 GPU、限实例数）。
 *
 * ## 设计约束
 *
 * · **不 require electron**：electron 由调用方注入，因此本模块可以用纯 Node
 *   跑单测（见 test/health-guard.test.js），不需要起 Electron。
 * · **所有定时器 unref**：诊断/守护不能阻止进程退出。
 * · **不丢证据**：每次动作都通过 `log` 落一行，`report()` 可整体回传。
 */

const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  // 页面「无响应」后等多久再动手。太短会误杀正在跑大任务的页面（导入聊天记录、
  // 首次加载几百条消息），太长用户已经以为软件死了。12s 是折中值。
  unresponsiveGraceMs: 12000,
  // 同一个 webContents 连续 unresponsive 多少次后升级为「强制崩掉再重载」。
  unresponsiveBeforeForceKill: 2,
  // 崩溃后自动重载的退避序列（毫秒）。第 4 次起不再重载，改画错误页。
  reloadBackoffMs: [2000, 8000, 30000],
  // 熔断窗口：同一个视图在窗口内崩溃超过 N 次就停手（防止崩溃→重载→崩溃的死循环，
  // 那种循环比直接白屏更糟：CPU 被吃满，用户连关窗口都点不动）。
  goneWindowMs: 10 * 60 * 1000,
  goneMaxPerWindow: 3,
  // 崩溃循环判定：短窗口内启动这么多次 = 上次根本没跑起来。
  crashLoopWindowMs: 5 * 60 * 1000,
  crashLoopStarts: 3,
  // 跑满这么久才算「这次启动是好的」，清掉崩溃循环计数。
  stableRunMs: 10 * 60 * 1000
}

/** 只放行「明确可归因、且不影响主流程继续跑」的错误。 */
const RECOVERABLE_CODES = new Set([
  'ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'ERR_STREAM_WRITE_AFTER_END', 'ERR_STREAM_DESTROYED', 'ERR_ABORTED',
  'ERR_IPC_CHANNEL_CLOSED', 'ERR_INVALID_STATE'
])

/**
 * 按 message 特征放行。
 *
 * ## 为什么必须收这几条（真机来源）
 *
 * · `Object has been destroyed` —— Electron 里最常见的竞态：窗口/视图已经销毁，
 *   而一个排队的回调还在碰它（关标签、切代理、重启实例时必然出现）。
 *   它**不代表**进程状態坏了，只代表那一次动作晚了一拍。
 * · `Render frame was disposed` / `Render frame disappeared` —— 渲染进程被换掉
 *   时的正常噪音，Chromium 自己会重建。
 * · `net::ERR_*` —— 网络层错误，代理抖动时会成批出现。
 *
 * 这几条以前都落在「白名单外」→ 直接 exit(1)。用户体感就是「点了下关闭标签，
 * 整个软件没了」，而且日志里只有一行 uncaughtException，看起来毫无关联。
 */
const RECOVERABLE_MESSAGE = [
  /Object has been destroyed/i,
  /Render frame was disposed/i,
  /Render frame disappeared/i,
  /WebContents (has been|was) destroyed/i,
  /webContents was destroyed/i,
  /frame was disposed/i,
  /^net::ERR_/,
  /ERR_ABORTED/,
  /ECONNRESET|EPIPE/,
  /socket has been ended by the other party/i,
  /This socket is closed/i
]

function isRecoverable(error) {
  if (!error) return false
  const code = String(error.code || '')
  if (RECOVERABLE_CODES.has(code)) return true
  const message = String(error.message || error)
  return RECOVERABLE_MESSAGE.some(re => re.test(message))
}

/**
 * 是否致命。
 *
 * 与 `log-file.isFatalError()` 的差别只有一处，但很关键：
 * 「已在运行的进程里的对象生命周期错误」不算致命。那类错误重试一次就好，
 * 让整个软件退出等于用最重的手段处理最轻的问题。
 *
 * 仍然保持「默认致命」：不认识的一律退出 + relaunch，避免造出
 * 界面还在、功能已坏的僵尸进程。
 */
function isFatal(error) {
  if (!error) return true
  return !isRecoverable(error)
}

function nowMs(clock) {
  return clock ? clock() : Date.now()
}

/**
 * @param {object} opts
 * @param {object} opts.app            Electron app（注入，便于测试）
 * @param {object} [opts.log]          带 info/warn/error/fatal(scope,msg) 的日志器
 * @param {string} [opts.dir]          状态目录（一般 app.getPath('userData')）
 * @param {object} [opts.options]      覆盖 DEFAULTS
 * @param {function} [opts.clock]      时间源（测试用）
 * @param {function} [opts.setTimeout] 定时器（测试用）
 * @param {function} [opts.clearTimeout]
 */
function createHealthGuard(opts) {
  const o = opts || {}
  const app = o.app || null
  const log = o.log || null
  const dir = o.dir || ''
  const cfg = Object.assign({}, DEFAULTS, o.options || {})
  const clock = o.clock || (() => Date.now())
  const setT = o.setTimeout || setTimeout
  const clearT = o.clearTimeout || clearTimeout

  const stateFile = dir ? path.join(dir, 'health-state.json') : ''
  const timers = new Set()
  /** 每个视图的崩溃记录：{ times: number[], reloads: number } */
  const gone = new Map()
  /** 每个视图的无响应记录：{ timer, strikes } */
  const hang = new Map()
  const stats = {
    starts: 0,
    safeMode: false,
    fatalHandled: 0,
    recoverableSeen: 0,
    reloads: 0,
    forceKills: 0,
    unresponsive: 0
  }

  function track(fn, ms) {
    const t = setT(fn, ms)
    if (t && typeof t.unref === 'function') t.unref()
    timers.add(t)
    return t
  }

  function untrack(t) {
    if (!t) return
    timers.delete(t)
    clearT(t)
  }

  function say(level, msg) {
    if (!log || typeof log[level] !== 'function') return
    try { log[level]('guard', msg) } catch (e) {}
  }

  function readState() {
    if (!stateFile) return {}
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {} } catch (e) { return {} }
  }

  function writeState(next) {
    if (!stateFile) return
    try {
      fs.mkdirSync(dir, { recursive: true })
      // 同步写是对的：这份状态是「崩溃前最后想留下的一行」，异步可能写不到。
      // 它很小（几百字节）、且只在启动/退出/崩溃时写，不在热路径上。
      fs.writeFileSync(stateFile, JSON.stringify(next, null, 2))
    } catch (e) {}
  }

  /**
   * 启动记账 + 崩溃循环判定。
   *
   * 判据要看「连续」，不能只看「最近」：用户一天开十次是常态，
   * 只要每次间隔 > crashLoopWindowMs 就不该算循环。
   */
  function begin() {
    const t = nowMs(clock)
    const prev = readState()
    const recent = (Array.isArray(prev.starts) ? prev.starts : [])
      .filter(at => Number.isFinite(at) && t - at < cfg.crashLoopWindowMs)
    recent.push(t)
    stats.starts = recent.length

    // 上次没走 markCleanExit 也算一次异常退出 —— 与「启动次数」叠加判定。
    const crashedLast = !!prev.crashed
    const loop = recent.length >= cfg.crashLoopStarts || (crashedLast && recent.length >= 2)
    stats.safeMode = loop
    writeState({ starts: recent, crashed: false })

    if (loop) {
      say('warn', '检测到崩溃循环（' + cfg.crashLoopWindowMs / 1000 + 's 内启动 ' +
        recent.length + ' 次' + (crashedLast ? '，上次异常退出' : '') + '）→ 进入安全模式：' +
        '关闭 GPU / 限制实例数')
      // 安全模式必须在 ready 之前设置才有效。
      try {
        if (app && app.disableHardwareAcceleration) app.disableHardwareAcceleration()
        if (app && app.commandLine && app.commandLine.appendSwitch) {
          app.commandLine.appendSwitch('disable-gpu')
          app.commandLine.appendSwitch('disable-gpu-compositing')
        }
      } catch (e) {}
    } else {
      say('info', '启动 #' + recent.length + '（' + cfg.crashLoopWindowMs / 1000 + 's 窗口内）')
    }

    // 跑满 stableRunMs 就认为这次启动是健康的，清掉计数。
    const stable = track(() => {
      untrack(stable)
      writeState({ starts: [], crashed: false })
      say('info', '已稳定运行 ' + Math.round(cfg.stableRunMs / 60000) + ' 分钟，崩溃循环计数清零')
    }, cfg.stableRunMs)

    return stats
  }

  /** 正常退出时调用（app.on('before-quit') 之后、真正退出前）。 */
  function markCleanExit() {
    const prev = readState()
    writeState({ starts: prev.starts || [], crashed: false })
  }

  /**
   * 主进程致命错误：**先重启，再退出**。
   *
   * 直接 exit 的体感是「软件凭空消失」；relaunch + exit 的体感是「闪了一下又回来了」，
   * 而且安全模式会在下一次启动时生效（如果是崩溃循环）。
   */
  function hardExit(code) {
    stats.fatalHandled++
    say('fatal', '主进程致命错误，准备自动重启（exitCode=' + code + '）')
    const prev = readState()
    writeState({ starts: prev.starts || [], crashed: true })
    try {
      // 不传 args：Electron 会按当前进程的启动方式重启（打包版与开发版都正确）。
      // 显式传 process.argv.slice(1) 在打包版里会把资源路径当成参数再传一遍，
      // 表现是"重启后起不来"，比闪退更难查。
      if (app && typeof app.relaunch === 'function') app.relaunch()
    } catch (e) {}
    try {
      if (app && typeof app.exit === 'function') app.exit(0)
    } catch (e) {
      try { process.exit(code == null ? 1 : code) } catch (e2) {}
    }
    return true
  }

  function backoffFor(times) {
    const seq = cfg.reloadBackoffMs
    return seq[Math.min(times, seq.length - 1)]
  }

  /**
   * 给一个嵌入视图装恢复逻辑。
   *
   * @param {object} view webContents（WebContentsView.webContents）
   * @param {object} meta { id, name, reload: () => void, giveUp: (reason) => void }
   */
  function watchView(view, meta) {
    if (!view || typeof view.on !== 'function') return () => {}
    const id = String((meta && meta.id) || 'view')
    const reload = (meta && meta.reload) || (() => { try { view.reload() } catch (e) {} })
    const giveUp = (meta && meta.giveUp) || (() => {})
    const onEvent = (meta && meta.onEvent) || (() => {})
    const emit = (type, payload) => {
      try { onEvent(type, payload) } catch (e) {}
    }

    const onGone = (_event, details) => {
      const reason = String((details && details.reason) || 'unknown')
      // 'clean-exit' / 'killed'：我们自己关的，或被系统/用户结束 —— 不该自动复活。
      if (reason === 'clean-exit' || reason === 'killed') {
        say('info', '实例 ' + id + ' 渲染进程结束（' + reason + '），不自动重载')
        return
      }
      const t = nowMs(clock)
      const rec = gone.get(id) || { times: [], reloads: 0, gaveUp: false }
      rec.times = rec.times.filter(at => t - at < cfg.goneWindowMs)
      rec.times.push(t)
      gone.set(id, rec)

      // 已经熔断过的视图不再重复告警/重复回调，避免把日志刷满。
      if (rec.gaveUp) return

      say('error', '实例 ' + id + ' 渲染进程崩溃：reason=' + reason +
        ' exitCode=' + ((details && details.exitCode) == null ? '?' : details.exitCode) +
        (reason === 'oom' ? ' ★内存不足' : '') +
        '（' + cfg.goneWindowMs / 60000 + ' 分钟内第 ' + rec.times.length + ' 次）')
      emit('gone', { reason: reason, exitCode: details && details.exitCode, count: rec.times.length })

      if (rec.times.length > cfg.goneMaxPerWindow) {
        rec.gaveUp = true
        say('error', '实例 ' + id + ' 崩溃次数超过熔断阈值 ' + cfg.goneMaxPerWindow +
          '，停止自动重载（避免崩溃→重载→崩溃的死循环）')
        emit('gaveUp', { reason: 'crash-loop' })
        try { giveUp('crash-loop') } catch (e) {}
        return
      }

      const delay = backoffFor(rec.reloads)
      rec.reloads++
      emit('reload', { delay: delay, attempt: rec.reloads })
      say('warn', '实例 ' + id + ' 将在 ' + delay + 'ms 后自动重载（第 ' + rec.reloads + ' 次）')
      track(() => {
        stats.reloads++
        try { reload() } catch (e) { say('error', '实例 ' + id + ' 重载失败：' + (e && e.message)) }
      }, delay)
    }

    const onUnresponsive = () => {
      stats.unresponsive++
      const rec = hang.get(id) || { strikes: 0, timer: null }
      rec.strikes++
      emit('unresponsive', { strikes: rec.strikes })
      say('warn', '实例 ' + id + ' 无响应（第 ' + rec.strikes + ' 次），' +
        cfg.unresponsiveGraceMs + 'ms 后仍无响应将介入')
      if (!rec.timer) {
        rec.timer = track(() => {
          rec.timer = null
          if (rec.strikes >= cfg.unresponsiveBeforeForceKill) {
            stats.forceKills++
            say('error', '实例 ' + id + ' 多次无响应，强制结束渲染进程以触发恢复链')
            try {
              // 这条会触发 render-process-gone（reason=crashed），
              // 由上面的 onGone 统一按退避重载 —— 一处逻辑，两条入口。
              if (typeof view.forcefullyCrashRenderer === 'function') view.forcefullyCrashRenderer()
              else reload()
            } catch (e) { try { reload() } catch (e2) {} }
          } else {
            say('warn', '实例 ' + id + ' 无响应超过宽限期，主动重载')
            stats.reloads++
            try { reload() } catch (e) {}
          }
        }, cfg.unresponsiveGraceMs)
      }
      hang.set(id, rec)
    }

    const onResponsive = () => {
      const rec = hang.get(id)
      if (!rec) return
      if (rec.timer) untrack(rec.timer)
      rec.timer = null
      rec.strikes = 0
      hang.set(id, rec)
      emit('responsive', {})
      say('info', '实例 ' + id + ' 已恢复响应')
    }

    view.on('render-process-gone', onGone)
    view.on('unresponsive', onUnresponsive)
    view.on('responsive', onResponsive)

    return function dispose() {
      try {
        view.removeListener('render-process-gone', onGone)
        view.removeListener('unresponsive', onUnresponsive)
        view.removeListener('responsive', onResponsive)
      } catch (e) {}
      const rec = hang.get(id)
      if (rec && rec.timer) untrack(rec.timer)
      hang.delete(id)
      gone.delete(id)
    }
  }

  /**
   * 给主窗口（外壳渲染层）装恢复逻辑。
   *
   * 外壳渲染层挂掉 = 整个界面白掉（标签栏、设置、翻译条全在它里面）。
   * 以前这里同样是「只记日志」，用户只能强杀重开。
   *
   * @param {object} win BrowserWindow
   * @param {object} [meta] { reload }
   */
  function watchWindow(win, meta) {
    if (!win || typeof win.on !== 'function') return () => {}
    const reload = (meta && meta.reload) || (() => { try { win.reload() } catch (e) {} })
    let reloads = 0

    const onUnresponsive = () => {
      stats.unresponsive++
      say('warn', '主窗口无响应，' + cfg.unresponsiveGraceMs + 'ms 后主动重载界面')
      track(() => {
        if (win.isDestroyed && win.isDestroyed()) return
        stats.reloads++
        reloads++
        say('warn', '主窗口重载（第 ' + reloads + ' 次）')
        try { reload() } catch (e) {}
      }, cfg.unresponsiveGraceMs)
    }
    const onResponsive = () => say('info', '主窗口已恢复响应')

    const onGone = (_event, details) => {
      const reason = String((details && details.reason) || 'unknown')
      say('error', '主窗口渲染进程退出：reason=' + reason)
      if (reason === 'clean-exit' || reason === 'killed') return
      if (reloads >= 2) {
        say('fatal', '主窗口连续退出，改为重启整个应用')
        return hardExit(1)
      }
      reloads++
      stats.reloads++
      track(() => { try { reload() } catch (e) {} }, backoffFor(reloads))
    }

    win.on('unresponsive', onUnresponsive)
    win.on('responsive', onResponsive)
    try {
      win.webContents.on('unresponsive', onUnresponsive)
      win.webContents.on('responsive', onResponsive)
      win.webContents.on('render-process-gone', onGone)
    } catch (e) {}

    return function dispose() {
      try {
        win.removeListener('unresponsive', onUnresponsive)
        win.removeListener('responsive', onResponsive)
        win.webContents.removeListener('unresponsive', onUnresponsive)
        win.webContents.removeListener('responsive', onResponsive)
        win.webContents.removeListener('render-process-gone', onGone)
      } catch (e) {}
    }
  }

  /** 安全模式下的策略（main.js 在开新实例/isolation 之前读它）。 */
  function policy() {
    return {
      safeMode: stats.safeMode,
      // 安全模式下最多 2 个实例：崩溃若由「实例太多」触发，这条能立刻验证假设。
      maxTabs: stats.safeMode ? 2 : 0,
      disableGpu: stats.safeMode,
      // 安全模式下不注入翻译桥：preload 是崩溃的一大嫌疑面，先摘掉它做二分。
      disableBridge: stats.safeMode
    }
  }

  function report() {
    return {
      startsInWindow: stats.starts,
      safeMode: stats.safeMode,
      unresponsive: stats.unresponsive,
      reloads: stats.reloads,
      forceKills: stats.forceKills,
      fatalHandled: stats.fatalHandled,
      watchedViews: gone.size
    }
  }

  function dispose() {
    for (const t of timers) { try { clearT(t) } catch (e) {} }
    timers.clear()
    hang.clear()
    gone.clear()
  }

  return {
    begin,
    markCleanExit,
    hardExit,
    isFatal,
    isRecoverable,
    watchView,
    watchWindow,
    policy,
    report,
    dispose,
    // 便于测试
    _defaults: DEFAULTS
  }
}

module.exports = {
  createHealthGuard,
  isFatal,
  isRecoverable,
  DEFAULTS,
  RECOVERABLE_CODES,
  RECOVERABLE_MESSAGE
}
