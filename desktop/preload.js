const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pix', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  // 渲染层把工具条真实高度上报给主进程，供原生视图定位使用
  reportBarHeight: (height) => ipcRenderer.send('chrome:barHeight', height),
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
  home: () => ipcRenderer.invoke('app:home'),
  version: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  translateEngines: () => ipcRenderer.invoke('translate:engines'),
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
  onContextCommand: (cb) => {
    ipcRenderer.on('context:command', (_event, command) => cb(command))
  }
})
