'use strict'

const electron = require('electron')
if (!electron || !electron.app || !electron.ipcMain) {
  console.error('请在 standalone/telegram 目录执行 npx electron .')
  process.exit(1)
}

const { app, BrowserWindow, ipcMain } = electron
const path = require('path')
const crypto = require('crypto')
const { createStore } = require('./lib/store')
const { createPixApi } = require('./lib/pix-api')
const { TelegramService } = require('./lib/telegram-service')

const PIX_API = process.env.PIX_API || process.env.PIX_PUBLIC_URL || 'http://127.0.0.1:8080'

let win
let store
let pix
let telegram

function userFile(name) {
  return path.join(app.getPath('userData'), name)
}

function prefs() {
  const data = store.read()
  return Object.assign({
    transRecv: true,
    transSend: true,
    transGroup: true,
    engine: 'youdao',
    lang: 'zh',
    includeZh: false
  }, data.prefs || {})
}

function publicState() {
  const data = store.read()
  const tg = data.telegram || {}
  return {
    pix: data.pix || null,
    prefs: prefs(),
    telegramApiReady: !!(Number(process.env.PIX_TG_API_ID || tg.apiId) && String(process.env.PIX_TG_API_HASH || tg.apiHash || '')),
    accounts: tg.accounts || [],
    activeAccount: (tg.accounts || []).find(item => item.id === tg.activeId) || null
  }
}

function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// 为翻译请求生成服务端幂等键：同设备 + 同参数 + 同文本永远是同一个键，
// 服务端据此做幂等去重（重复渲染/重试不会二次扣费）；正式后端缺此键会直接 400。
function transRequestKey(text, from, to, engine) {
  const deviceId = String((store && store.read().deviceId) || '')
  const fingerprint = crypto.createHash('sha256')
    .update([String(engine || ''), String(from || ''), String(to || ''), String(text || '')].join('\u0001'))
    .digest('hex')
    .slice(0, 40)
  return `tg-app:${deviceId}:${fingerprint}`
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 880,
    minHeight: 560,
    title: 'Telegram',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.setMenuBarVisibility(false)
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

app.whenReady().then(async () => {
  app.setName('Hello Pix Telegram')
  store = createStore(userFile('standalone-telegram.json'))
  const data = store.read()
  if (!data.deviceId) {
    data.deviceId = crypto.randomUUID()
    store.write(data)
  }
  pix = createPixApi({ base: PIX_API, deviceId: data.deviceId })
  telegram = new TelegramService(store, emit)
  try {
    await telegram.restore()
  } catch (_error) {}
  await createWindow()
})

app.on('window-all-closed', () => app.quit())

ipcMain.handle('app:state', async () => {
  let authorized = false
  try {
    authorized = !!(telegram.client && await telegram.client.checkAuthorization())
  } catch (_error) {}
  return Object.assign(publicState(), { telegramAuthorized: authorized })
})

ipcMain.handle('pix:login', async (_event, payload) => {
  const body = payload || {}
  const result = await pix.request('/client/login', {
    method: 'POST',
    form: { username: body.username, password: body.password, deviceId: pix.state.deviceId }
  })
  if (!result || !result.success) throw new Error((result && result.msg) || '登录失败')
  const profile = result.obj || {}
  const data = store.read()
  data.pix = profile
  store.write(data)
  return profile
})

ipcMain.handle('pix:logout', async () => {
  try { await pix.request('/client/logout', { method: 'POST', form: {} }) } catch (_error) {}
  const data = store.read()
  data.pix = null
  store.write(data)
  return { ok: true }
})

ipcMain.handle('pix:session', async () => {
  try {
    const result = await pix.request('/client/session')
    if (result && result.obj) {
      const data = store.read()
      data.pix = result.obj
      store.write(data)
      return result.obj
    }
  } catch (_error) {}
  return store.read().pix || null
})

ipcMain.handle('pix:prefs', async (_event, payload) => {
  const next = Object.assign(prefs(), payload || {})
  const data = store.read()
  data.prefs = next
  store.write(data)
  if (data.pix) {
    try {
      await pix.request('/client/translate-prefs', {
        method: 'POST',
        form: {
          transRecv: next.transRecv ? 1 : 0,
          transSend: next.transSend ? 1 : 0,
          transGroup: next.transGroup ? 1 : 0,
          engine: next.engine,
          langOther: next.lang
        }
      })
    } catch (_error) {}
  }
  return next
})

ipcMain.handle('pix:translate', async (_event, payload) => {
  const text = String(payload && payload.text || '').trim()
  if (!text) return { text: '' }
  const settings = prefs()
  const incoming = !!(payload && payload.incoming)
  if (incoming && !settings.transRecv) return { text: '' }
  if (!incoming && !settings.transSend) return { text: '' }
  const result = await pix.request('/translate/run', {
    method: 'POST',
    form: {
      text,
      from: incoming ? 'auto' : settings.lang,
      to: incoming ? settings.lang : 'auto',
      engine: settings.engine,
      requestId: transRequestKey(text, incoming ? 'auto' : settings.lang, incoming ? settings.lang : 'auto', settings.engine)
    }
  })
  if (!result || result.success === false) throw new Error((result && result.msg) || '翻译失败')
  return { text: result.text || result.translated || result.obj || '' }
})

ipcMain.handle('tg:saveApi', async (_event, payload) => {
  const apiId = Number(payload && payload.apiId)
  const apiHash = String(payload && payload.apiHash || '').trim()
  if (!apiId || apiHash.length < 8) throw new Error('api_id / api_hash 无效')
  telegram.saveConfig({ apiId, apiHash })
  return { ok: true }
})

ipcMain.handle('tg:connect', (_event, payload) => telegram.connect(payload && payload.phone))
ipcMain.handle('tg:code', (_event, code) => telegram.submitCode(code))
ipcMain.handle('tg:password', (_event, password) => telegram.submitPassword(password))
ipcMain.handle('tg:dialogs', () => telegram.dialogs())
ipcMain.handle('tg:messages', (_event, id) => telegram.messages(id))
ipcMain.handle('tg:send', (_event, payload) => telegram.send(payload && payload.id, payload && payload.text))
ipcMain.handle('tg:addAccount', () => telegram.addAccount())
ipcMain.handle('tg:switchAccount', (_event, id) => telegram.switchAccount(id))
ipcMain.handle('tg:accounts', async () => publicState().accounts)
