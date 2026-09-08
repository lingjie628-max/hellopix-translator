const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('app', {
  state: () => ipcRenderer.invoke('app:state'),
  pixLogin: payload => ipcRenderer.invoke('pix:login', payload),
  pixLogout: () => ipcRenderer.invoke('pix:logout'),
  pixSession: () => ipcRenderer.invoke('pix:session'),
  savePrefs: payload => ipcRenderer.invoke('pix:prefs', payload),
  translate: payload => ipcRenderer.invoke('pix:translate', payload),
  saveTelegramApi: payload => ipcRenderer.invoke('tg:saveApi', payload),
  connectTelegram: payload => ipcRenderer.invoke('tg:connect', payload),
  submitCode: code => ipcRenderer.invoke('tg:code', code),
  submitPassword: password => ipcRenderer.invoke('tg:password', password),
  dialogs: () => ipcRenderer.invoke('tg:dialogs'),
  messages: id => ipcRenderer.invoke('tg:messages', id),
  send: payload => ipcRenderer.invoke('tg:send', payload),
  addAccount: () => ipcRenderer.invoke('tg:addAccount'),
  switchAccount: id => ipcRenderer.invoke('tg:switchAccount', id),
  accounts: () => ipcRenderer.invoke('tg:accounts'),
  on: (channel, cb) => {
    const allowed = ['tg:needCode', 'tg:needPassword', 'tg:ready', 'tg:error', 'tg:update', 'pix:session']
    if (!allowed.includes(channel)) return
    ipcRenderer.on(channel, (_event, data) => cb(data))
  }
})
