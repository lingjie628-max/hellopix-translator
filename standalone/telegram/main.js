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

// 为翻译请求生成服务端幂等键。
//
// ★ 键必须**每次请求都不同** ★
//
// 幂等键的用途只有一个：让"同一个请求被重复发送"（双击、超时重试、
// Telegram 渲染两次气泡）在服务端合并成一笔，不重复扣费。
// 它描述的是**一次请求**，不是**一段文本**。
//
// 这里曾经用「设备 + 引擎 + 语种 + 文本」的哈希当键，看起来很严谨，
// 实际是拿内容指纹冒充请求指纹。后果是服务端的重放分支（reserveTranslate
// 里 `existing` 命中就原样回上次的响应）**永远会命中**：
//
//   · 同一个窗口里同一句话出现第二次 → 直接拿到上一次的译文，
//     上游换没换模型、用户换没换术语库，都不会重新翻译；
//   · 该键在 translation_reservations 里是终态 → 想重新翻只能换一个字。
//
// 正确做法：用随机 UUID（与 Windows 版一致）。真正的"同一次请求重发"
// 由调用方复用同一个 key 来表达（见调用处）；新的一次翻译就一定是新键。
function transRequestKey() {
  const deviceId = String((store && store.read().deviceId) || '')
  return `tg-app:${deviceId}:${crypto.randomUUID()}`
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
  pix = createPixApi({
    base: PIX_API,
    deviceId: data.deviceId,
    // 恢复上次的会话 cookie，并在每次变化时落盘。
    //
    // 少了这一步的话，重启 Telegram 客户端就等于掉登录态 —— 用户每次都要
    // 重新走一遍 Hello Pix 账号登录。Windows 版（telegram-win）一直是这么做的，
    // macOS 版漏了。
    cookies: data.pixCookies || {},
    onCookies(cookies) {
      const next = store.read()
      next.pixCookies = cookies
      store.write(next)
    }
  })
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
  // 服务端登出可能失败（断网/线路挂了），本地也必须断干净：
  // 清 cookie 内存 + 落盘，否则下一次登录会带着旧会话去请求。
  pix.clearSession()
  const data = store.read()
  data.pix = null
  // 首次启动时 store 里可能还没有 pixCookies 这个键 —— 显式写成 {}，
  // 让"没登录"和"有 cookie 但没 profile"不会被后续逻辑混淆。
  data.pixCookies = {}
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
    // 服务端明确说"没有会话"（401 / 被踢）时，本地那份 profile 已经
    // 作废了。只靠 catch 兜住会一直返回旧 profile，界面停在已登录状态，
    // 用户点什么都失败 —— 要把本地状态一起清掉。
    if (result && result.success === false) {
      pix.clearSession()
      const data = store.read()
      data.pix = null
      data.pixCookies = {}
      store.write(data)
      return null
    }
  } catch (_error) {
    // 网络异常：不能因为一次请求失败就把用户踹下线，
    // 留本地缓存的 profile 让他还能看到界面。
  }
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
      engine: settings.engine
    },
    // 每次翻译一个新键（见 transRequestKey 的注释）。
    // 走 options 而不是塞进 form：pix-api 会同时写 Idempotency-Key 头与 requestId。
    idempotencyKey: transRequestKey()
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
