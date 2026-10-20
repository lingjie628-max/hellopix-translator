'use strict'

/**
 * 打开一个新实例。
 *
 * ## 顺序不能乱
 *
 * 1. **先问资源预算**，再创建任何 Chromium 对象。主判据是系统内存水位：
 *    实测 80 个重型实例约吃 8GB、句柄只用了 1886 个（离上限极远），
 *    所以"能不能再开"取决于内存，而不是窗口数或句柄。
 *    不判断的后果：内存吃满后系统开始换页，应用表现为卡死甚至闪退，
 *    而用户完全不知道是"开太多了"。
 *
 * 2. **地址先过安全策略**，再建视图。建了再发现地址不合法，等于白开一个进程。
 *
 * 3. 视图 → tab → 入列 → 看门狗 → 加载 → 切过去 → 落盘。
 *    sendTabs / saveOpenApps 必须在 push 之后，否则界面和磁盘都对不上。
 *
 * ## 为什么拒绝时用原生对话框
 *
 * 渲染层的弹窗会被 WebContentsView 盖住，而这里恰恰是"窗口已经很多"的场景
 * —— 原生对话框是唯一稳的通道。
 */

function createOpenPlatform (deps) {
  const { state, libs, env } = deps

  function openPlatform (payload) {
    const item = env.platforms.find(p => p.id === payload.platformId)
    if (!item) return { success: false, msg: '不支持该平台' }

    // ★ 资源预算：在创建任何 Chromium 对象之前先问"还能不能开" ★
    const budget = libs.tabBudget.canOpenAnotherTab({
      tabCount: state.tabs.length,
      maxTabs: libs.effectiveMaxTabs(),
      used: libs.tabBudget.openHandleCount(),
      limit: libs.tabBudget.handleLimit()
    })
    if (!budget.ok) {
      libs.logWarn('resource', '拒绝新增实例（' + budget.code + '）：' + budget.reason +
        ' · 当前窗口 ' + state.tabs.length + ' 个' +
        memorySuffix(budget.memory) +
        ' · 句柄 ' + budget.used + '/' + budget.limit)
      // 必须让用户**看见**：渲染层弹窗会被 WebContentsView 盖住
      libs.showResourceNotice(budget.reason, budget.code)
      return { success: false, code: budget.code, msg: budget.reason }
    }

    const counts = state.usedCount
    counts[item.id] = Number(counts[item.id] || 0) + 1
    const index = counts[item.id]
    const id = item.id + '-' + state.nextTab
    state.nextTab = state.nextTab + 1
    const partition = libs.makePartition(item.id, index)
    const settings = libs.normalizeTabSettings(payload.settings || {})
    // WhatsApp Pro 默认开启防撤回 —— 这是用户选这个版本的理由，
    // 但只在"没显式设置过"时才给默认值，别覆盖用户的选择。
    if (item.id === 'whatsapp-pro' && settings.antiRevoke === undefined) settings.antiRevoke = true
    const homeUrl = libs.safePlatformHomeUrl(item, settings)
    if (!homeUrl) return { success: false, msg: '应用地址不符合安全策略' }
    const displayName = String(payload.name || item.name).trim() || item.name
    const view = libs.createWebView(partition, settings, item, homeUrl,
      { platform: item.id, account: libs.accountSlug(), id: '' })
    const tab = {
      id: id,
      platform: item.id,
      name: displayName,
      title: displayName,
      index: index,
      icon: item.icon || item.id,
      view: view,
      item: item,
      homeUrl: homeUrl,
      settings: settings,
      partition: partition
    }
    if (settings.muteAll) view.webContents.setAudioMuted(true)
    if (settings.disableAutoLoad) {
      // 用户明确要求"别自动加载"：首次主框架失败就停在这里，
      // 不要让它一路重试把流量烧在打不开的网络上。
      view.webContents.on('did-fail-load', (_e, _code, _desc, _url, isMain) => {
        if (isMain) {
          try { view.webContents.stop() } catch (e) {}
        }
      })
    }
    tab.url = homeUrl
    tab.loading = true
    libs.bindTabLoading(tab)
    state.tabs.push(tab)
    // 只有在 preload 真的跑起来之后，guest 才会来问 prefs；到点没来就是桥没起来。
    libs.watchdogBridge(tab)
    libs.startTabLoad(tab)
    state.activeId = id
    state.showHome = false
    libs.layoutViews()
    libs.sendTabs()
    libs.saveOpenApps()
    return { success: true, id: id }
  }

  return { openPlatform }
}

/** 把内存水位拼成一段可读后缀；没有数据就返回空串。 */
function memorySuffix (m) {
  const mm = m || {}
  if (!mm.total) return ''
  return ' · 内存 ' + Math.round((mm.used || 0) / 1048576) + '/' + Math.round(mm.total / 1048576) + 'MB' +
    (mm.ratio === undefined ? '' : '（已用 ' + Math.round(mm.ratio * 100) + '%）')
}

module.exports = { createOpenPlatform, memorySuffix }
