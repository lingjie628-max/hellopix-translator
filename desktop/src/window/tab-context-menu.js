'use strict'

// 缩放钳位/步长，与主进程「视图」菜单共用同一套（见 src/window/zoom.js）。
// 放模块顶层而不是 createTabContextMenu 里：menuTemplate 是独立导出的
// 纯函数，测试会直接调它，闭包里的变量在那里够不着。
const zoomLib = require('./zoom')

/**
 * 顶部标签栏的右键菜单。
 *
 * ## 两处刻意设计
 *
 * ### 隐藏 vs 关闭
 *
 * 隐藏走单独的菜单项，**不能**放进"关闭应用"那一组 —— 那里离手指太近，
 * 误点会把正在收消息的窗口藏掉，用户会以为被关了。
 * 而关闭本身要二次确认：交给渲染层弹框，确认后才真正 closeTab。
 * 主进程直接关会绕过确认 —— 两条路径的语义必须一致。
 *
 * ### 主页 vs 实例
 *
 * 主页（没选中任何实例）给的是全局操作：个人中心、检查更新、日志目录、重启。
 * 实例给的是该窗口的操作：重命名、隐藏、缩放、刷新、代理、缓存。
 */

/**
 * @param {object} deps
 * @param {object} deps.electron  { Menu, app }
 * @param {object} deps.state     { win, tabs }
 * @param {object} deps.libs      业务能力（都是惰性调用）
 */
function createTabContextMenu (deps) {
  const { electron, state, libs } = deps

  function popupTabContextMenu (payload) {
    const id = String((payload && payload.id) || '')
    const home = !!(payload && payload.home)
    const tabs = state.tabs || []
    const tab = tabs.find(t => t.id === id)
    const wc = tab && tab.view && tab.view.webContents
    const win = state.win
    const sendCommand = command => {
      if (win && !win.isDestroyed()) win.webContents.send('context:command', command)
    }
    const restart = () => {
      electron.app.relaunch()
      electron.app.exit(0)
    }

    const template = menuTemplate({
      home,
      tab,
      wc,
      // 右键的是不是当前正在显示的那个窗口 —— 决定菜单走"精细操作"还是
      // "批量收拾"。不能在主进程里猜：渲染层的 activeId 与这里的更权威的是
      // 同一份（都来自 state.activeId），所以以 state 为准。
      selected: !!(state.activeId && tab && tab.id === state.activeId),
      sendCommand,
      restart,
      libs
    })
    electron.Menu.buildFromTemplate(template).popup({ window: win })
    return { success: true }
  }

  return { popupTabContextMenu }
}

/** 纯函数：给一份就出菜单结构，方便测"该有的都有、不该有的都没有"。 */
function menuTemplate (ctx) {
  const { home, tab, wc, sendCommand, restart, libs } = ctx

  if (home || !tab || !wc || wc.isDestroyed()) {
    return [
      { label: '个人中心', click: () => sendCommand('account') },
      { label: '检查软件更新', click: () => sendCommand('softwareUpdate') },
      { type: 'separator' },
      { label: '打开日志目录', click: () => libs.openLogDir() },
      { label: '重启软件', click: restart }
    ]
  }

  const changeZoom = delta => {
    // 钳位与步长见 src/window/zoom.js —— 快捷键也走同一套，
    // 免得"右键放大"和"Cmd+= 放大"步长不一致
    zoomLib.changeZoom(wc, delta)
  }

  // ★ 当前是否就是正在显示的窗口 ★
  //
  // 同一个标签的菜单，在"正看着它"和"看着别的窗口"时给的东西不该一样：
  // 选中时要的是对**这个窗口**的精细操作（改名、缩小、代理、上一页）；
  // 未选中时用户的真实意图通常是"把这一堆一起收拾掉"（挂起、刷新全部、
  // 关掉全部同平台），逐个条目的操作反而是噪音。
  //
  // 但两套菜单不能是两份模板 —— 那样两边必然慢慢长歪，最后同一个功能
  // 在两处行为不同。所以做成**同一批操作 + 两种分组与危险级别**。
  const selected = ctx.selected !== false
  const platformName = (libs.platformLabel && libs.platformLabel(tab.platform)) || tab.platform || ''

  // 「关闭全部同平台」必须是 danger 加粗：它一次干掉 N 个窗口，且不可撤销。
  // 平台名为空时退回"该平台"，避免出现"关闭全部"这种看不出范围的标题。
  const closeAllLabel = '关闭全部' + (platformName || '该平台')
  const refreshAllLabel = '刷新全部' + (platformName || '该平台')

  if (!selected) {
    return [
      {
        // 挂起 = 隐藏到后台（进程保留、登录态不丢），不是关闭。
        label: '挂起',
        click: () => libs.hideTab(tab.id)
      },
      { type: 'separator' },
      { label: refreshAllLabel, click: () => libs.refreshTabsOfPlatform(tab.platform) },
      { type: 'separator' },
      // 关闭走二次确认：交给渲染层弹框，确认后才真正 closeTab。
      // 主进程直接关会绕过确认 —— 两条路径的语义必须一致。
      { label: '关闭应用', click: () => sendCommand({ action: 'closeAsk', id: tab.id }) },
      {
        label: closeAllLabel,
        // 菜单项本身不做二次确认（原生菜单弹不出我们的确认框），
        // 由渲染层负责：收到命令先弹框，确认后才逐个关。
        click: () => sendCommand({ action: 'closePlatformAsk', id: tab.id, platform: tab.platform })
      },
      { type: 'separator' },
      {
        label: '开发者工具',
        click: () => {
          try {
            if (wc.isDevToolsOpened()) wc.closeDevTools()
            else wc.openDevTools({ mode: 'detach' })
          } catch (e) {}
        }
      }
    ]
  }

  return [
    { label: '挂起', click: () => libs.hideTab(tab.id) },
    { label: '重命名窗口…', click: () => sendCommand({ action: 'rename', id: tab.id }) },
    { type: 'separator' },
    { label: '上一页', accelerator: 'Alt+Left', click: () => sendCommand({ action: 'back', id: tab.id }) },
    { label: '下一页', accelerator: 'Alt+Right', click: () => sendCommand({ action: 'forward', id: tab.id }) },
    { label: '刷新当前应用', accelerator: 'CmdOrCtrl+R', click: () => wc.reload() },
    { type: 'separator' },
    { label: '放大页面', accelerator: 'CmdOrCtrl+Plus', click: () => changeZoom(0.1) },
    { label: '缩小页面', accelerator: 'CmdOrCtrl+-', click: () => changeZoom(-0.1) },
    { label: '还原缩放', accelerator: 'CmdOrCtrl+0', click: () => wc.setZoomFactor(1) },
    { type: 'separator' },
    { label: '代理设置', click: () => libs.openProxySettingsFor(tab.id) },
    { label: '检查应用更新', click: () => libs.updatePlatformWeb(tab.platform) },
    {
      label: '清理当前应用缓存',
      click: async () => {
        try {
          await wc.session.clearCache()
          wc.reloadIgnoringCache()
        } catch (e) {}
      }
    },
    { type: 'separator' },
    { label: refreshAllLabel, click: () => libs.refreshTabsOfPlatform(tab.platform) },
    {
      label: closeAllLabel,
      click: () => sendCommand({ action: 'closePlatformAsk', id: tab.id, platform: tab.platform })
    },
    { type: 'separator' },
    // 关闭走二次确认：交给渲染层弹框，确认后才真正 closeTab。
    // 主进程直接关会绕过确认 —— 两条路径的语义必须一致。
    { label: '关闭应用', click: () => sendCommand({ action: 'closeAsk', id: tab.id }) },
    { type: 'separator' },
    { label: '个人中心', click: () => sendCommand('account') },
    { label: '打开日志目录', click: () => libs.openLogDir() },
    {
      label: '开发者工具',
      click: () => {
        try {
          if (wc.isDevToolsOpened()) wc.closeDevTools()
          else wc.openDevTools({ mode: 'detach' })
        } catch (e) {}
      }
    }
  ]
}

module.exports = { createTabContextMenu, menuTemplate }
