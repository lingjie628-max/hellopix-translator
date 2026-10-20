'use strict'

/**
 * 主窗口。
 *
 * ## 尺寸
 *
 * 按屏幕可用区域自适应：此前固定 1280x820，小屏尚可、大屏浪费，
 * 而窄屏下顶部翻译设置区会被挤压换行。取下 92% 并设上下限。
 *
 * 高度优先吃满可用高度（只留 16px 余量），而不是按比例缩 ——
 * 顶部设置区两行需要空间，1280x800 这类逻辑分辨率下可用高度约 775px，
 * 这就是物理上限。
 *
 * macOS 会恢复上次的窗口框架，覆盖构造时的 width/height，所以构造后
 * 必须再 setBounds 一次，确保尺寸真正生效。
 *
 * ## 关闭 = 隐藏到托盘
 *
 * 翻译靠的是各个 webview 里注入的脚本，窗口一旦真关掉、webContents 被销毁，
 * 翻译就停了。用户点右上角的 ×，多数时候意思是"先收起来"，不是"别翻了"
 * —— 尤其是这个产品的多开窗口本来就要一直挂着。
 *
 * 但**不是无条件拦截**：托盘没建出来时必须放行退出，否则窗口藏了、
 * 又没有任何入口能找回来，进程就成了用户看不见也关不掉的僵尸。
 * 判定集中放在 background-mode.js，那里有单测。
 */

function createWindowModule (deps) {
  const { electron, state, libs, env } = deps
  const path = env.path
  const dirname = env.dirname

  function createWindow () {
    // ★ 必须延迟取 screen ★
    // Electron 的 screen 模块在 app ready 之前不可用，模块顶层解构会拿到 undefined
    // （mock electron 下更是直接 ReferenceError）。原实现就是在函数内部 require 的。
    const { workAreaSize } = electron.getScreen().getPrimaryDisplay()
    const fallback = {
      width: Math.max(env.WINDOW_MIN_WIDTH, Math.min(1920, workAreaSize.width - 16)),
      height: Math.max(env.WINDOW_MIN_HEIGHT, Math.min(1600, workAreaSize.height - 16))
    }
    const saved = libs.restoreWindowBounds(fallback)
    const width = saved.width
    const height = saved.height

    const win = new electron.BrowserWindow({
      width,
      height,
      center: true,
      minWidth: env.WINDOW_MIN_WIDTH,
      minHeight: env.WINDOW_MIN_HEIGHT,
      title: 'Hello Pix',
      icon: env.APP_ICON,
      backgroundColor: '#070b14',
      webPreferences: {
        preload: path.join(dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    win.setMenuBarVisibility(false)

    // 渲染进程的报错与崩溃要留痕：此前"界面白屏""翻译没反应"这类问题在客户端
    // 没有任何记录，只能靠用户复述当时点了什么。
    const wcLog = win.webContents
    wcLog.on('console-message', (...args) => {
      // Electron 33 是老签名 (event, level, message, line, sourceId)，
      // 新版本改成单个对象。两种都兼容 —— 否则升级后日志会静默消失。
      let level, message, line, source
      if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        level = args[0].level
        message = args[0].message
        line = args[0].lineNumber
        source = args[0].sourceId
      } else {
        level = args[1]
        message = args[2]
        line = args[3]
        source = args[4]
      }
      // 只收警告与错误：渲染层的 info 量大且几乎没有诊断价值
      if (level === 2 || level === 3 || level === 'warning' || level === 'error') {
        libs.logWarn('renderer', String(message) + ' @' + (source || '') + ':' + line)
      }
    })
    wcLog.on('render-process-gone', (_event, details) => {
      libs.logError('crash', '主窗口渲染进程退出：reason=' +
        ((details && details.reason) || '?') + ' exitCode=' +
        ((details && details.exitCode) == null ? '?' : details.exitCode))
    })
    wcLog.on('unresponsive', () => libs.logWarn('renderer', '主窗口无响应'))

    // macOS 会恢复上次的窗口框架，覆盖构造时的 width/height。
    // 这里显式再设一次并居中，确保"吃满可用区域"的尺寸真正生效。
    const hasSavedPosition = Number.isFinite(saved.x) && Number.isFinite(saved.y)
    const bounds = win.getBounds()
    win.setBounds({
      x: hasSavedPosition ? saved.x : bounds.x,
      y: hasSavedPosition ? saved.y : bounds.y,
      width,
      height
    })
    if (!hasSavedPosition) win.center()

    // 关闭窗口 → 隐藏到托盘（后台继续跑），而不是退出。判定见文件头。
    win.on('close', event => {
      if (!libs.backgroundMode.shouldHideOnClose({
        isQuitting: state.isQuitting,
        backgroundEnabled: libs.backgroundEnabled(),
        hasTray: !!state.tray
      })) return
      event.preventDefault()
      win.hide()
      // 只提示一次，避免每次关窗都弹一下惹人烦
      if (!state.backgroundTipShown && state.tray && process.platform === 'win32') {
        state.backgroundTipShown = true
        try {
          state.tray.displayBalloon({
            title: 'Hello Pix 仍在后台运行',
            content: '翻译会继续工作。要完全退出，请右键托盘图标选择「退出」。'
          })
        } catch (e) { /* 某些系统不支持气泡，忽略即可 */ }
      }
    })

    win.on('resize', libs.layoutViews)
    win.on('resized', libs.layoutViews)
    win.on('resize', libs.scheduleSaveWindowBounds)
    win.on('move', libs.scheduleSaveWindowBounds)
    win.on('enter-full-screen', libs.layoutViews)
    win.on('leave-full-screen', libs.layoutViews)
    win.webContents.on('did-finish-load', libs.layoutViews)
    // 主窗口本身不该被导航走（整个 UI 是本地文件）
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.loadFile(path.join(dirname, 'renderer', 'index.html'))
    return win
  }

  return { createWindow }
}

module.exports = { createWindowModule }
