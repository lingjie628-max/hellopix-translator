'use strict'

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')
const { createStore } = require('./lib/store')
const enginesLib = require('./lib/engines')
const { createPixApi } = require('./lib/pix-api')
const { writeBridge, writeBridges } = require('./lib/bridge')

const RAIL = 76
const FLYOUT = 360

let win
let store
let pix
let telegramPid = 0
let dockTimer = null
let shiftedPid = 0
let railReady = false

function userFile(name) {
  return path.join(app.getPath('userData'), name)
}

function telegramExe() {
  const packed = path.join(process.resourcesPath, 'Telegram', 'Telegram.exe')
  const nextToApp = path.join(path.dirname(process.execPath), 'Telegram', 'Telegram.exe')
  const dev = path.join(__dirname, 'Telegram', 'Telegram.exe')
  return [packed, nextToApp, dev].find(item => fs.existsSync(item)) || nextToApp
}

function dockScript() {
  return path.join(__dirname, 'win-dock.ps1')
}

// 翻译通道不再写死 youdao/google/deepl。挑选规则在 lib/engines.js ——
// 单独成模块是为了让 scripts/verify-telegram-bridge-e2e.js 能 require 同一份实现，
// 而不是自己抄一份（抄的话脚本验的是它假想的启动器，这里改坏了也一样全绿）。
let engines = null

async function loadEngines() {
  try {
    const result = await pix.request('/translate/engines')
    if (result && result.success !== false && Array.isArray(result.rows)) {
      engines = result
      const data = store.read()
      data.engines = result
      store.write(data)
      return result
    }
  } catch (_error) {}
  engines = store.read().engines || null
  return engines
}

function prefs() {
  const data = store.read()
  const saved = Object.assign({
    transRecv: true,
    transSend: true,
    transGroup: true,
    engine: '',
    lang: 'zh'
  }, data.prefs || {})
  saved.engine = enginesLib.resolveEngine(engines, saved.engine)
  return saved
}

function instances() {
  const data = store.read()
  if (!data.instances || !data.instances.length) {
    data.instances = [{ id: 'main', name: '默认电报' }]
    store.write(data)
  }
  return data.instances
}

function workdir(id) {
  return path.join(app.getPath('userData'), 'tdata', String(id || 'main'))
}

function bridgePayload() {
  const data = store.read()
  return {
    apiBase: (pix && pix.state.base) || data.apiBase || process.env.PIX_API || 'http://127.0.0.1:8080',
    deviceId: (pix && pix.state.deviceId) || data.deviceId || '',
    cookies: (pix && pix.state.cookies) || data.pixCookies || {},
    prefs: prefs()
  }
}

function writeInstanceBridge(id) {
  return writeBridge(workdir(id), bridgePayload())
}

function writeAllBridges() {
  return writeBridges(instances().map(item => workdir(item.id)), bridgePayload())
}

function publicState() {
  const data = store.read()
  return {
    pix: data.pix || null,
    prefs: prefs(),
    engines: enginesLib.engineState(engines),
    instances: instances(),
    lastUsername: data.lastUsername || '',
    apiBase: data.apiBase || process.env.PIX_API || 'http://127.0.0.1:8080',
    telegramPath: telegramExe(),
    docked: process.platform === 'win32' && telegramPid > 0
  }
}

function fail(error) {
  throw new Error(error && error.message ? error.message : String(error || '操作失败'))
}

function runDock(args) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ ok: false })
    execFile('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', dockScript()
    ].concat(args), { windowsHide: true, timeout: 4000 }, (error, stdout) => {
      if (error) return resolve({ ok: false })
      try { resolve(JSON.parse(String(stdout || '{}'))) } catch (_err) { resolve({ ok: false }) }
    })
  })
}

function sendUi(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function enterLoginMode() {
  if (!win || win.isDestroyed()) return
  railReady = false
  win.setAlwaysOnTop(false)
  win.setMinimumSize(440, 560)
  win.setSize(480, 680)
  win.center()
}

function enterRailMode(bounds) {
  if (!win || win.isDestroyed()) return
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setMinimumSize(RAIL, 360)
  if (bounds) win.setBounds(bounds)
  if (!railReady) {
    railReady = true
    sendUi('app:shell', publicState())
  }
}

async function placeRail() {
  const rect = await runDock(['-Mode', 'bounds', '-PidHint', String(telegramPid)])
  if (!rect.ok || rect.w < 200 || rect.h < 200) {
    if (telegramPid) sendUi('tg:gone')
    return
  }
  telegramPid = rect.pid
  const needShift = rect.x < RAIL - 8
  if (shiftedPid !== rect.pid && needShift) {
    await runDock([
      '-Mode', 'move', '-PidHint', String(rect.pid),
      '-X', String(rect.x + RAIL), '-Y', String(rect.y),
      '-W', String(Math.max(720, rect.w - RAIL)), '-H', String(rect.h)
    ])
    shiftedPid = rect.pid
    enterRailMode({ x: rect.x, y: rect.y, width: RAIL, height: rect.h })
    return
  }
  shiftedPid = rect.pid
  const railX = rect.x >= RAIL ? rect.x - RAIL : 0
  const wide = win && !win.isDestroyed() && win.getBounds().width > RAIL + 40
  enterRailMode({
    x: railX,
    y: rect.y,
    width: wide ? RAIL + FLYOUT : RAIL,
    height: rect.h
  })
}

function startDock() {
  stopDock()
  placeRail().catch(() => {})
  dockTimer = setInterval(() => { placeRail().catch(() => {}) }, 800)
}

function stopDock() {
  if (dockTimer) clearInterval(dockTimer)
  dockTimer = null
}

function createWindow() {
  win = new BrowserWindow({
    width: 480,
    height: 680,
    title: 'Hello Pix Telegram',
    backgroundColor: '#070b14',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.setMenuBarVisibility(false)
  return win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

app.whenReady().then(() => {
  app.setName('Hello Pix Telegram')
  store = createStore(userFile('hello-pix-telegram.json'))
  const data = store.read()
  if (!data.deviceId) {
    data.deviceId = crypto.randomUUID()
    store.write(data)
  }
  pix = createPixApi({
    base: process.env.PIX_API || data.apiBase || 'http://127.0.0.1:8080',
    deviceId: data.deviceId,
    cookies: data.pixCookies || {},
    onCookies(cookies) {
      const next = store.read()
      next.pixCookies = cookies
      store.write(next)
    }
  })
  // 先把上次问到的通道列表装载进来（离线也能挑对通道），再开窗口 ——
  // 顺序反了的话，渲染进程第一次 app:state 会拿到还没解析的 engine，
  // 首帧就会把死通道写进桥接文件。
  engines = data.engines || null
  createWindow()
  // 已登录过就顺手重新问一次后台并重写桥接文件。
  if (data.pix) {
    loadEngines().then(() => writeAllBridges()).catch(() => {})
  }
})

app.on('window-all-closed', () => {
  stopDock()
  app.quit()
})

ipcMain.handle('app:state', () => publicState())
ipcMain.handle('app:flyout', (_event, open) => {
  if (!win || win.isDestroyed()) return { ok: false }
  const bounds = win.getBounds()
  win.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: open ? RAIL + FLYOUT : RAIL,
    height: bounds.height
  })
  return { ok: true }
})

ipcMain.handle('pix:login', async (_event, payload) => {
  try {
    const body = payload || {}
    if (body.server) {
      pix.setBase(body.server)
      const data = store.read()
      data.apiBase = body.server
      store.write(data)
    }
    const result = await pix.request('/client/login', {
      method: 'POST',
      form: { username: body.username, password: body.password, deviceId: pix.state.deviceId }
    })
    if (!result || !result.success) throw new Error((result && result.msg) || '登录失败')
    const data = store.read()
    data.pix = result.obj || {}
    data.lastUsername = String(body.username || '')
    store.write(data)
    // 先问清这台账号能用哪个通道，再写桥接文件 —— 顺序反了就会先写进一个
    // 没接通的通道，魔改电报整个会话都不出译文。
    await loadEngines()
    writeAllBridges()
    return data.pix
  } catch (error) {
    fail(error)
  }
})

ipcMain.handle('pix:logout', async () => {
  try { await pix.request('/client/logout', { method: 'POST', form: {} }) } catch (_error) {}
  const data = store.read()
  data.pix = null
  data.pixCookies = {}
  store.write(data)
  pix.state.cookies = {}
  writeAllBridges()
  stopDock()
  telegramPid = 0
  shiftedPid = 0
  enterLoginMode()
  return { ok: true }
})

ipcMain.handle('pix:prefs', (_event, payload) => {
  const data = store.read()
  data.prefs = Object.assign(prefs(), payload || {})
  store.write(data)
  writeAllBridges()
  return data.prefs
})

// 打开「翻译设置」时重新问一次后台：商户刚在后台把通道接通，这里不用重启就能看到。
ipcMain.handle('pix:engines', async () => {
  await loadEngines()
  return enginesLib.engineState(engines)
})

ipcMain.handle('pix:translate', async (_event, payload) => {
  try {
    const text = String(payload && payload.text || '').trim()
    if (!text) return { text: '' }
    const settings = prefs()
    const incoming = payload && payload.incoming !== false
    const result = await pix.request('/translate/run', {
      method: 'POST',
      form: {
        text,
        from: incoming ? 'auto' : settings.lang,
        to: incoming ? settings.lang : 'auto',
        engine: settings.engine
      },
      idempotencyKey: 'ui-' + crypto.randomUUID()
    })
    if (!result || result.success === false) throw new Error((result && result.msg) || '翻译失败')
    return { text: result.translation || result.text || result.translated || '' }
  } catch (error) {
    fail(error)
  }
})

ipcMain.handle('tg:list', () => instances())

ipcMain.handle('tg:add', (_event, name) => {
  const data = store.read()
  const rows = instances()
  const id = 'acc-' + Date.now()
  rows.push({ id, name: String(name || '').trim() || ('电报 ' + rows.length) })
  data.instances = rows
  store.write(data)
  writeInstanceBridge(id)
  return rows
})

ipcMain.handle('tg:open', async (_event, id) => {
  const exe = telegramExe()
  if (!fs.existsSync(exe)) throw new Error('未找到官方 Telegram.exe，请检查安装包是否完整')
  fs.mkdirSync(workdir(id), { recursive: true })
  writeInstanceBridge(id)
  const child = spawn(exe, ['-workdir', workdir(id)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  child.unref()
  telegramPid = child.pid || 0
  shiftedPid = 0
  railReady = false
  setTimeout(() => startDock(), 900)
  return { ok: true, id: id || 'main', path: exe, pid: telegramPid }
})

ipcMain.handle('tg:focus', () => runDock(['-Mode', 'focus', '-PidHint', String(telegramPid)]))
