const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pix', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  // 界面主题：'dark' | 'light'，读写都走主进程（存 config.json）
  setTheme: (value) => ipcRenderer.invoke('config:setTheme', value),
  setTabLayout: (value) => ipcRenderer.invoke('config:setTabLayout', value),
  // 后台运行（关闭窗口时隐藏到托盘）。开关状态随 getConfig() 一起下发。
  setBackgroundRunning: (value) => ipcRenderer.invoke('config:setBackgroundRunning', value),
  // 渲染层把工具条真实高度上报给主进程，供原生视图定位使用
  reportBarHeight: (height) => ipcRenderer.send('chrome:barHeight', height),
  // 顶部 chrome 底边的实测位置（哨兵元素 bottom），原生视图直接用它作为起始 y
  reportChromeHeight: (height) => ipcRenderer.send('chrome:height', height),
  getAuth: () => ipcRenderer.invoke('auth:get'),
  saveAuth: (payload) => ipcRenderer.invoke('auth:save', payload),
  autoLogin: () => ipcRenderer.invoke('auth:autoLogin'),
  verifyLock: password => ipcRenderer.invoke('auth:verifyLock', password),
  setApiBase: (url) => ipcRenderer.invoke('config:setApiBase', url),
  listLines: () => ipcRenderer.invoke('lines:list'),
  selectLine: (id) => ipcRenderer.invoke('lines:select', id),
  pingLine: (id) => ipcRenderer.invoke('lines:ping', id),
  pingAll: () => ipcRenderer.invoke('lines:pingAll'),
  siteInfo: () => ipcRenderer.invoke('site:info'),
  openUrl: (url) => ipcRenderer.invoke('shell:open', url),
  login: (payload) => ipcRenderer.invoke('auth:login', payload),
  logout: () => ipcRenderer.invoke('auth:logout'),
  session: () => ipcRenderer.invoke('auth:session'),
  platforms: () => ipcRenderer.invoke('app:platforms'),
  updatePlatform: (id) => ipcRenderer.invoke('app:updatePlatform', id),
  proxyPresets: () => ipcRenderer.invoke('app:proxyPresets'),
  detectProxy: (payload) => ipcRenderer.invoke('proxy:detect', payload),
  preset: (id) => ipcRenderer.invoke('app:preset', id),
  savePreset: (payload) => ipcRenderer.invoke('app:savePreset', payload),
  tabs: () => ipcRenderer.invoke('app:tabs'),
  renameTab: (id, name) => ipcRenderer.invoke('app:rename', { id: id, name: name }),
  reorderTabs: (id, targetId, before) => ipcRenderer.invoke('app:reorder', { id: id, targetId: targetId, before: before !== false }),
  open: (payload) => ipcRenderer.invoke('app:open', payload),
  close: (id) => ipcRenderer.invoke('app:close', id),
  switchTab: (id) => ipcRenderer.invoke('app:switch', id),
  // 隐藏窗口 = 从标签栏移除但进程保留（不掉号、不丢设置），回到后台挂着
  hideTab: (id) => ipcRenderer.invoke('app:hide', id),
  // 把后台的窗口重新展示出来（不重新加载，直接回到原来的画面）
  showHiddenTab: (id) => ipcRenderer.invoke('app:showHidden', id),
  reloadActiveApp: () => ipcRenderer.invoke('app:reloadActive'),
  clearActiveAppCache: () => ipcRenderer.invoke('app:clearActiveCache'),
  contextAction: (id, action) => ipcRenderer.invoke('app:contextAction', { id: id, action: action }),
  showContextMenu: (payload) => ipcRenderer.invoke('app:showContextMenu', payload),
  restartApp: () => ipcRenderer.invoke('app:restart'),
  updateTabSettings: (id, settings) => ipcRenderer.invoke('app:updateSettings', { id: id, settings: settings }),
  // 读取某条线路当前的代理配置（供「代理设置」弹窗回填，只回代理字段）
  proxySettings: (id) => ipcRenderer.invoke('app:proxySettings', { id: id }),
  home: () => ipcRenderer.invoke('app:home'),
  version: () => ipcRenderer.invoke('app:version'),
  // 翻译是否被崩溃循环保护停掉了（2026-11-02：「不翻译了」的静默根因）
  translateStatus: () => ipcRenderer.invoke('app:translateStatus'),
  translateRestore: () => ipcRenderer.invoke('app:translateRestore'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  // ---- 应用内自动更新 ----
  // start 不接受任何参数：主进程会自己重新取清单并验签。
  // 传 URL 进来等于给网页开一条「让主进程下载并执行任意文件」的通路。
  updateStart: () => ipcRenderer.invoke('app:updateStart'),
  updateApply: () => ipcRenderer.invoke('app:updateApply'),
  updateCancel: () => ipcRenderer.invoke('app:updateCancel'),
  updateState: () => ipcRenderer.invoke('app:updateState'),
  onUpdateProgress: (cb) => {
    ipcRenderer.on('app:update-progress', (_event, data) => cb(data))
  },
  translateEngines: () => ipcRenderer.invoke('translate:engines'),
  // 翻译桥健康：preload 装载失败时，界面必须显示常驻警告，不能让用户以为翻译开着
  bridgeStatus: () => ipcRenderer.invoke('translate:bridgeStatus'),
  onBridgeDown: (cb) => {
    ipcRenderer.on('translate:bridgeDown', (_event, data) => cb(data))
  },
  customerReminders: () => ipcRenderer.invoke('customer:reminders'),
  counter: {
    summary: query => ipcRenderer.invoke('counter:summary', query),
    events: query => ipcRenderer.invoke('counter:events', query),
    repeats: query => ipcRenderer.invoke('counter:repeats', query),
    accounts: query => ipcRenderer.invoke('counter:accounts', query),
    archiveAccount: id => ipcRenderer.invoke('counter:archiveAccount', id),
    tickets: query => ipcRenderer.invoke('counter:tickets', query),
    ticket: id => ipcRenderer.invoke('counter:ticket', id),
    transitionTicket: data => ipcRenderer.invoke('counter:ticketTransition', data),
    replyTicket: data => ipcRenderer.invoke('counter:ticketReply', data),
    tabs: () => ipcRenderer.invoke('counter:tabs'),
    toggleTab: data => ipcRenderer.invoke('counter:toggleTab', data),
    queueStatus: () => ipcRenderer.invoke('counter:queueStatus'),
    retryFailed: () => ipcRenderer.invoke('counter:retryFailed'),
    flush: () => ipcRenderer.invoke('counter:flush'),
    onUpdated: cb => ipcRenderer.on('counter:updated', (_event, data) => cb(data))
  },
  saveTranslatePrefs: (payload) => ipcRenderer.invoke('translate:savePrefs', payload),
  setOverlay: (on) => ipcRenderer.invoke('app:overlay', on),
  onTranslateOpen: (cb) => {
    ipcRenderer.on('translate:open', () => cb())
  },
  onTabs: (cb) => {
    ipcRenderer.on('app:tabs', (_event, data) => cb(data))
  },
  onPlatforms: (cb) => {
    ipcRenderer.on('app:platforms', (_event, data) => cb(data))
  },
  onSession: (cb) => {
    ipcRenderer.on('auth:session', (_event, data) => cb(data))
  },
  onKicked: (cb) => {
    ipcRenderer.on('auth:kicked', (_event, msg) => cb(msg))
  },
  // 托盘菜单改了后台运行开关时，主进程会推给渲染层同步显示
  onBackgroundRunning: (cb) => {
    ipcRenderer.on('config:backgroundRunning', (_event, enabled) => cb(enabled))
  },
  onContextCommand: (cb) => {
    ipcRenderer.on('context:command', (_event, command) => cb(command))
  },
  // 主进程发起的一次性提示（如"复制图片失败：格式不支持"）。
  // 这些是主进程侧的动作结果，渲染层无从得知，必须由主进程推过来。
  onToast: (cb) => {
    ipcRenderer.on('app:toast', (_event, data) => cb(data))
  },
  // 右键菜单点了「代理设置」：主进程只回传线路 id，渲染层据此打开弹窗
  onProxySettings: (cb) => {
    ipcRenderer.on('context:proxySettings', (_event, id) => cb(id))
  }
})
