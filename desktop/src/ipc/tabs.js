'use strict'

/**
 * 标签页操作 IPC：打开 / 关闭 / 切换 / 隐藏 / 重命名 / 排序 / 右键菜单。
 *
 * ## 这一组为什么最晚搬
 *
 * 它碰到的东西最多：tabs、activeId、showHome、webContents、原生 Menu、
 * 落盘（saveOpenApps / 预设文件）。每搬一个都要确认"状态改动之后有没有
 * 通知渲染层 + 落盘"，顺序错了就会让界面和磁盘对不上。
 *
 * ## 三条容易踩的线
 *
 * 1. **关闭必须二次确认**。主进程直接关会绕过渲染层弹框 ——
 *    而"误点一下就把号关了"正是要防的事。
 * 2. **隐藏不是关闭**。隐藏要保留进程与登录态；从 tabs 里删掉就是关闭，
 *    用户要重新扫码。
 * 3. **改名会写进预设模板**，模板里绝不能带代理 —— 否则下一个新建的
 *    实例会静默继承上一条线路的代理。
 */

/**
 * @param {object} deps
 * @param {object} deps.reg
 * @param {object} deps.state    { tabs, activeId, showHome }
 * @param {object} deps.actions  窗口 / 持久化 / 菜单
 * @param {object} deps.env      纯函数与常量
 */
function registerTabsIpc (deps) {
  const { reg, state, actions, env } = deps

  const findTab = id => (state.tabs || []).find(t => t.id === id)

  reg.handle('app:tabs', () => actions.tabPayload())

  reg.handle('app:open', (event, payload) => actions.openPlatform(payload || {}))
  reg.handle('app:close', (event, id) => actions.closeTab(id))
  reg.handle('app:switch', (event, id) => actions.switchTab(id))
  reg.handle('app:hide', (event, id) => actions.hideTab(String(id || state.activeId || '')))
  reg.handle('app:showHidden', (event, id) => actions.showHiddenTab(String(id || '')))
  reg.handle('app:showContextMenu', (event, payload) => actions.popupTabContextMenu(payload || {}))
  reg.handle('app:home', () => actions.goHome())

  reg.handle('app:rename', (event, payload) => {
    const id = String((payload && payload.id) || '')
    const next = String((payload && payload.name) || '').trim()
    const tab = findTab(id)
    if (!tab) return { success: false, msg: '应用不存在' }
    if (!next) return { success: false, msg: '名称不能为空' }
    tab.name = next
    tab.title = next
    const all = actions.readPresets()
    const prev = all[tab.platform] || {}
    // 兜底值以前是 `tab.settings`，那会把这条线路**正在用的代理**写进模板，
    // 于是"改个名字"就成了一次静默的代理泄漏：下一个新建实例会继承它。
    // 模板永远不含代理，所以两个来源都要先摘干净。
    all[tab.platform] = {
      name: next,
      settings: env.sealSettings(env.stripProxyFields(prev.settings || tab.settings || {}))
    }
    actions.writePresets(all)
    actions.sendTabs()
    actions.saveOpenApps()
    return { success: true, name: next }
  })

  reg.handle('app:reorder', (event, payload) => {
    // 拖拽排序：只接受"把 A 挪到 B 前面/后面"，不接受渲染层直接给整个数组 ——
    // 渲染层的列表是**过滤后**的（主页、右侧分组都不在里面），整表覆盖会把
    // 它看不见的窗口挤到未知位置。
    const tabs = state.tabs
    const draggedId = String((payload && payload.id) || '')
    const targetId = String((payload && payload.targetId) || '')
    const before = payload && payload.before !== false
    const from = tabs.findIndex(t => t.id === draggedId)
    if (from < 0) return { success: false, msg: '窗口不存在' }
    // 主页是固定的：把它当唯一基准时，就是"挪到最前/最后"。
    if (!targetId || targetId === 'home') {
      const [row] = tabs.splice(from, 1)
      if (before) tabs.unshift(row)
      else tabs.push(row)
      actions.sendTabs()
      actions.saveOpenApps()
      return { success: true }
    }
    const to = tabs.findIndex(t => t.id === targetId)
    if (to < 0) return { success: false, msg: '目标窗口不存在' }
    if (from === to) return { success: false, msg: '位置未变化' }
    const [row] = tabs.splice(from, 1)
    // 摘掉之后目标下标会左移一格，所以"插到目标前"直接用新下标即可。
    const insertAt = before
      ? tabs.findIndex(t => t.id === targetId)
      : tabs.findIndex(t => t.id === targetId) + 1
    tabs.splice(insertAt < 0 ? tabs.length : insertAt, 0, row)
    actions.sendTabs()
    actions.saveOpenApps()
    return { success: true }
  })

  reg.handle('app:reloadActive', () => {
    const tab = findTab(state.activeId)
    const wc = tab && tab.view && tab.view.webContents
    if (!wc || wc.isDestroyed()) return { success: false, msg: '当前没有打开的应用' }
    wc.reload()
    return { success: true, msg: '已刷新当前应用' }
  })

  reg.handle('app:clearActiveCache', async () => {
    const tab = findTab(state.activeId)
    const wc = tab && tab.view && tab.view.webContents
    if (!wc || wc.isDestroyed()) return { success: false, msg: '当前没有打开的应用' }
    try {
      await wc.session.clearCache()
      wc.reloadIgnoringCache()
      return { success: true, msg: '缓存已清理' }
    } catch (e) {
      return { success: false, msg: e.message || '缓存清理失败' }
    }
  })

  reg.handle('app:contextAction', async (event, payload) => {
    const id = String((payload && payload.id) || state.activeId || '')
    const action = String((payload && payload.action) || '')
    const tab = findTab(id)
    if (action === 'close') {
      // 关闭必须经过渲染层的二次确认。这里直接关会绕过确认 ——
      // 而「误点一下就把号关了」正是要防的事。
      return { success: false, msg: '关闭窗口需二次确认', needConfirm: true }
    }
    const wc = tab && tab.view && tab.view.webContents
    if (!wc || wc.isDestroyed()) return { success: false, msg: '应用不存在' }

    const history = wc.navigationHistory
    try {
      if (action === 'back' || action === 'forward') {
        const back = action === 'back'
        // Electron 新旧版本 API 不同：新的是 navigationHistory，
        // 老的是 webContents 自带方法。两个都要认，否则老版本上按钮失效。
        const allowed = history && typeof history['canGo' + (back ? 'Back' : 'Forward')] === 'function'
          ? history['canGo' + (back ? 'Back' : 'Forward')]()
          : typeof wc['canGo' + (back ? 'Back' : 'Forward')] === 'function' && wc['canGo' + (back ? 'Back' : 'Forward')]()
        if (!allowed) return { success: false, msg: back ? '没有上一页' : '没有下一页' }
        if (history && typeof history['go' + (back ? 'Back' : 'Forward')] === 'function') {
          history['go' + (back ? 'Back' : 'Forward')]()
        } else {
          wc['go' + (back ? 'Back' : 'Forward')]()
        }
        return { success: true }
      }
      if (action === 'reload') {
        wc.reload()
        return { success: true }
      }
      if (action === 'zoomIn' || action === 'zoomOut' || action === 'zoomReset') {
        const current = Number(wc.getZoomFactor()) || 1
        // 夹在 0.5 ~ 2 之间：再大版面会烂，再小读不了
        const next = action === 'zoomReset'
          ? 1
          : Math.min(2, Math.max(0.5, current + (action === 'zoomIn' ? 0.1 : -0.1)))
        wc.setZoomFactor(Number(next.toFixed(2)))
        return { success: true, msg: Math.round(next * 100) + '%' }
      }
      if (action === 'clearCache') {
        await wc.session.clearCache()
        wc.reloadIgnoringCache()
        return { success: true, msg: '缓存已清理' }
      }
    } catch (e) {
      return { success: false, msg: e.message || '操作失败' }
    }
    return { success: false, msg: '不支持该操作' }
  })

  reg.handle('app:restart', () => {
    // 延迟一下再重启：让这次 IPC 的返回值先回到渲染层，
    // 否则进程已经没了，渲染层等不到回执。
    setTimeout(() => actions.relaunchAndExit(), 120)
    return { success: true }
  })

  /**
   * 读取一条线路当前的代理配置，供「代理设置」弹窗回填。
   *
   * 只回传代理字段（proxySettingsOf），不把整份 settings 抖给渲染层。
   * proxyPass 在内存里本就是明文（与新建线路时一致），弹窗需要它回填；
   * 落盘时仍由 saveOpenApps 走 sealSettings 加密。
   */
  reg.handle('app:proxySettings', (event, payload) => {
    const id = String((payload && payload.id) || '')
    const tab = findTab(id)
    if (!tab) return { success: false, msg: '应用不存在' }
    return { success: true, data: env.proxySettingsOf(tab.settings) }
  })

  reg.handle('app:updateSettings', (event, payload) =>
    actions.updateTabSettings((payload && payload.id) || '', (payload && payload.settings) || {}))

  reg.handle('app:overlay', (event, on) => {
    state.overlayOpen = !!on
    actions.layoutViews()
    return { success: true }
  })
}

module.exports = { registerTabsIpc }
