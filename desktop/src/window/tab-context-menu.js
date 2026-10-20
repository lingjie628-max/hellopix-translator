'use strict'

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
      home, tab, wc, sendCommand, restart, libs
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
    // 钳在 0.5 ~ 2，并且保留两位 —— 否则反复点会出现 1.3000000000000003
    const current = Number(wc.getZoomFactor()) || 1
    wc.setZoomFactor(Number(Math.min(2, Math.max(0.5, current + delta)).toFixed(2)))
  }

  return [
    { label: '重命名窗口…', click: () => sendCommand({ action: 'rename', id: tab.id }) },
    {
      // 隐藏而不是关闭：网页版进程原地保留，登录态与设置一点不丢。
      label: '隐藏该窗口（后台运行）',
      click: () => libs.hideTab(tab.id)
    },
    { type: 'separator' },
    { label: '放大页面', accelerator: 'CmdOrCtrl+Plus', click: () => changeZoom(0.1) },
    { label: '缩小页面', accelerator: 'CmdOrCtrl+-', click: () => changeZoom(-0.1) },
    { label: '还原缩放', accelerator: 'CmdOrCtrl+0', click: () => wc.setZoomFactor(1) },
    { type: 'separator' },
    { label: '刷新当前应用', accelerator: 'CmdOrCtrl+R', click: () => wc.reload() },
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
    { label: '个人中心', click: () => sendCommand('account') },
    { label: '打开日志目录', click: () => libs.openLogDir() },
    // 关闭走二次确认：交给渲染层弹框，确认后才真正 closeTab。
    // 主进程直接关会绕过确认 —— 两条路径的语义必须一致。
    { label: '关闭应用', click: () => sendCommand({ action: 'closeAsk', id: tab.id }) }
  ]
}

module.exports = { createTabContextMenu, menuTemplate }
