const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pix', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  // 界面主题：'dark' | 'light'，读写都走主进程（存 config.json）
  setTheme: (value) => ipcRenderer.invoke('config:setTheme', value),
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
  open: (payload) => ipcRenderer.invoke('app:open', payload),
  close: (id) => ipcRenderer.invoke('app:close', id),
  switchTab: (id) => ipcRenderer.invoke('app:switch', id),
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
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  translateEngines: () => ipcRenderer.invoke('translate:engines'),
  customerReminders: () => ipcRenderer.invoke('customer:reminders'),
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
  // 右键菜单点了「代理设置」：主进程只回传线路 id，渲染层据此打开弹窗
  onProxySettings: (cb) => {
    ipcRenderer.on('context:proxySettings', (_event, id) => cb(id))
  }
})
