const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('app', {
  state: () => ipcRenderer.invoke('app:state'),
  flyout: open => ipcRenderer.invoke('app:flyout', open),
  login: payload => ipcRenderer.invoke('pix:login', payload),
  logout: () => ipcRenderer.invoke('pix:logout'),
  savePrefs: payload => ipcRenderer.invoke('pix:prefs', payload),
  engines: () => ipcRenderer.invoke('pix:engines'),
  translate: payload => ipcRenderer.invoke('pix:translate', payload),
  openTelegram: id => ipcRenderer.invoke('tg:open', id),
  addInstance: name => ipcRenderer.invoke('tg:add', name),
  instances: () => ipcRenderer.invoke('tg:list'),
  focusTelegram: () => ipcRenderer.invoke('tg:focus'),
  on: (channel, cb) => {
    const allowed = ['app:shell', 'tg:gone']
    if (!allowed.includes(channel)) return
    ipcRenderer.on(channel, (_event, data) => cb(data))
  }
})
