'use strict'

/**
 * 为一个实例创建 WebContentsView。
 *
 * ## 这里的每一条设置都有真机证据
 *
 * 尤其是 `backgroundThrottling`，它只能**在创建时**一次写对：
 *
 *   写 false 的语义是"即使窗口在后台，也别节流定时器/渲染"。
 *   实测代价（probe-hidden-throttling.js）：
 *     隐藏窗口 2 秒内定时器触发 20 次（跑满），而 true 时只有 2-3 次。
 *   用户反馈的"开多了就卡、内存压力大"里，很大一块就是这里的后台空转。
 *
 *   那为什么可以放心用 true？实测（probe-throttle-strategy.js）：
 *     - 可见且聚焦：20/20 满速
 *     - 可见但 App 失焦：20/20 满速（收消息不受影响）
 *     - 隐藏（摘掉视图）：2/20，自动降到极低
 *     - 重新展示：立刻回到 20/20，不"粘住"
 *   也就是说 Chromium 是**按可见性**节流的，不是按 App 是否在前台。
 *
 *   注意：事后 setBackgroundThrottling(true) 无效（实测隐藏后仍跑满 20 次）。
 */

/**
 * @param {object} deps
 * @param {object} deps.electron   { WebContentsView, session }
 * @param {object} deps.state      { tabs }
 * @param {object} deps.libs       纯函数与业务能力
 * @param {object} deps.env        { __dirname, CHROME_UA }
 */
function createWebViewFactory (deps) {
  const { electron, state, libs, env } = deps

  /**
   * WebRTC 防泄漏。
   *
   * 优先用注入的 libs（这样测试、以及 main.js 的日志能接进去）；
   * 没注入就直接 require 本地实现 —— **安全增强不该有能力拖垮窗口创建**，
   * 更不能因为少注入一个函数就让整个实例窗口建不出来。
   */
  function webrtcGuardOf (wc) {
    let fn = libs && libs.applyWebRtcGuard
    if (typeof fn !== 'function') {
      try { fn = require('../proxy/webrtc-guard').applyWebRtcGuard } catch (e) { return false }
    }
    try { return !!fn(wc) } catch (e) { return false }
  }

  function createWebView (partition, settings, item, homeUrl, tabInfo) {
    const ses = electron.session.fromPartition(partition)
    ses.setUserAgent(env.CHROME_UA)
    ses.setPermissionRequestHandler((wc, permission, callback) => {
      // 只放行"可信实例 + 通知权限 + 用户没关通知"这一种组合。
      // 其余一律拒 —— 第三方页面不该能借我们的 window 弹任何权限框。
      const trusted = libs.trustedTabSender(wc)
      const allowNotification =
        trusted && permission === 'notifications' && (!settings || settings.showNotify !== false)
      callback(!!allowNotification)
    })

    const bridgeEnabled = libs.bridgeEnabledFor(item) && !libs.safeModeDisablesBridge()
    const view = new electron.WebContentsView({
      webPreferences: {
        preload: bridgeEnabled ? env.path.join(env.dirname, 'guest-inject.js') : undefined,
        partition: partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // ★ 必须 true，理由见文件头 ★
        backgroundThrottling: true
      }
    })
    if (typeof view.setBorderRadius === 'function') view.setBorderRadius(0)
    if (typeof view.setBackgroundColor === 'function') view.setBackgroundColor('#081628')
    view.webContents.setUserAgent(env.CHROME_UA)
    // ★ WebRTC 防泄漏 ★ 每个 view 单独设 —— 这个 API 挂在 webContents 上，
    // 不在 session 上。不设的话 ICE candidate 会把内网地址和真实公网 IP
    // 一起漏出去，代理等于没设。实测证据见 src/proxy/webrtc-guard.js 文件头。
    if (!webrtcGuardOf(view.webContents)) {
      try {
        if (typeof libs.logWarn === 'function') {
          libs.logWarn('proxy', '实例 ' + (tabInfo && tabInfo.id ? tabInfo.id : '?') +
            ' 未能设置 WebRTC 防泄漏策略，WebRTC 可能暴露真实 IP')
        }
      } catch (e) {}
    }
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    const guardNavigation = (event, targetUrl) => {
      if (!libs.isAllowedPlatformUrl(item, targetUrl, homeUrl)) event.preventDefault()
    }
    view.webContents.on('will-navigate', guardNavigation)
    view.webContents.on('will-redirect', guardNavigation)
    view.webContents.on('did-finish-load', () => libs.pushPrefsToGuest(view))

    // ★ 实例渲染进程崩溃必须留痕 ★
    //
    // 用户反馈"开着很多窗口时闪退"。以往只有主窗口记录了 render-process-gone，
    // **每个实例自己的渲染进程崩了日志里一个字都没有** —— 而开几十个窗口时，
    // 内存压力最先压垮的恰恰是这些实例进程。
    //
    // 记下实例标识（应用 + 序号）而不是内部 id：日志给用户看、也给我们看，
    // id 对不上任何东西。同时记 reason —— 'oom'（内存耗尽）与 'crashed'
    // 是两个完全不同的排查方向，不能混成一句"崩了"。
    view.webContents.on('render-process-gone', (_event, details) => {
      try {
        const reason = (details && details.reason) || '?'
        const exitCode = details && details.exitCode != null ? details.exitCode : '?'
        libs.logError('crash', '实例渲染进程退出：' + (item.app || '?') + '#' + (item.index || '?') +
          ' reason=' + reason + ' exitCode=' + exitCode +
          (reason === 'oom' ? ' ★内存不足' : ''))
      } catch (ignore) {}
    })

    // ★ 加载失败的兜底（真机取证：网络不通时表现为"黑屏"，用户以为是软件坏了）★
    //
    // 这是与 loadURL().catch 并行的第二条通道 —— 有些失败只走事件不走 promise
    // （例如页面已经在加载后中转失败）。两者都调 paintLoadError，
    // 由那里的 `tab.loadErrorUrl` / `getURL()` 去重，不会重复画。
    //
    // 注意 `isMainFrame`：子框架（iframe）失败不该顶掉整个页面 ——
    // WhatsApp Web 里就有若干第三方 iframe，它们失败是常态。
    view.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
      if (!isMainFrame) return
      const tab = (state.tabs || []).find(t => t.view === view)
      if (!tab) return
      libs.paintLoadError(tab, code, desc)
    })

    // 加载成功 → 清掉错误页痕迹，让下一次失败还能正常提示。
    // 不清理的话：用户点「重新加载」成功后，若日后再失败，去重逻辑会误以为
    // "还在错误页上"而什么都不做 —— 那就是一个"点了没反应"的死角。
    //
    // ★ 但必须排除"错误页自己加载完成"★ —— 错误页也是页面，也会触发
    //   did-finish-load。若不加判断，它会把自己的去重标记清掉，
    //   于是下一次失败又能画 → 而错误页若持续失败就是**无限重画**。
    view.webContents.on('did-finish-load', () => {
      const tab = (state.tabs || []).find(t => t.view === view)
      if (!tab) return
      let now = ''
      try { now = String(view.webContents.getURL() || '') } catch (e) {}
      if (now.indexOf('data:text/html') === 0) return
      tab.loadErrorUrl = ''
    })

    // 复制 / 粘贴 / 全选：Electron 不会把编辑快捷键自动作用到 WebContentsView，
    // 必须显式接住（否则译文选不中、复制不出来）。
    libs.installEditSupport(view)

    // preload 装载失败必须留痕：光靠控制台，线上看不到（0.1.12 就是这么漏出去的）。
    // 此刻 tab 可能还没进 tabs（按 id 找不到），所以先挂在 view 上，由
    // watchdogBridge() 按 tab 归属上报。
    view.webContents.on('preload-error', (_event, preloadPath, error) => {
      const file = env.path.basename(String(preloadPath || 'preload'))
      const reason = file + ' 装载失败：' + ((error && error.message) || String(error || '未知错误'))
      view.__pixPreloadError = reason
      libs.logError('preload', reason)
    })

    // guest 页面的报错也收进日志：拦截器内部的异常以前只进 webContents 控制台。
    view.webContents.on('console-message', (...args) => {
      let level, message, source, line
      if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        level = args[0].level
        message = args[0].message
        source = args[0].sourceId
        line = args[0].lineNumber
      } else {
        level = args[1]
        message = args[2]
        line = args[3]
        source = args[4]
      }
      const text = String(message == null ? '' : message)
      // ★ 发送状态机 trace 与发送结果日志**必须**无条件落盘。
      //   它们走的是 console.info（level 0/1），而下面那条过滤只放行 warning/error ——
      //   不特判的话，真机上一次 trace 都采不到，"抓真实事件顺序"就成了空话。
      //   （这正是 0.1.12 那类事故的成因之一：观测面缺失，事后只能靠用户复述。）
      if (text.indexOf('[PIX_TRACE]') !== -1 || text.indexOf('[Hello Pix]') !== -1) {
        libs.logGuestTrace(text + ' @' + (source || '') + ':' + line)
        return
      }
      if (level === 2 || level === 3 || level === 'warning' || level === 'error') {
        libs.logGuestWarn(text + ' @' + (source || '') + ':' + line)
      }
    })

    return view
  }

  return { createWebView }
}

module.exports = { createWebViewFactory }
