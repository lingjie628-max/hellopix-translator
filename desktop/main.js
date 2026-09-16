const electron = require('electron')
if (!electron || !electron.app || !electron.ipcMain) {
  console.error('请在 desktop 目录执行 npx electron . ，不要用 node 直接跑 main.js')
  process.exit(1)
}
const { app, BrowserWindow, WebContentsView, session, ipcMain, shell, safeStorage, nativeImage, net, Menu } = electron
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { spawn } = require('child_process')
const fallbackPlatforms = require('./platforms')
const builtinLines = require('./lines')
const proxyPresets = require('./proxy-presets')
const {
  csvHosts,
  trustedApiHosts,
  validateApiUrl,
  isAllowedPlatformUrl,
  isAllowedExternalUrl
} = require('./security-policy')

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const TABS_HEIGHT = 72
const UTILITY_HEIGHT = 40
const TRANS_BAR_HEIGHT = 78
// 渲染层上报的工具条真实高度（CSS 实测约 88px，与上面的常量不一致时会用到）
let measuredTransBarHeight = 0
let hasMeasuredBarHeight = false
// 哨兵上报的 chrome 底边；有它就完全不需要再按常量估算
let measuredChromeHeight = 0
let hasMeasuredChrome = false
const STATUS_HEIGHT = 22
const FOOTER_HEIGHT = 30
const DEFAULT_API = require('./api-default').PUBLIC_URL
const DEVELOPMENT = !app.isPackaged && process.env.NODE_ENV !== 'production'
const API_HOSTS = trustedApiHosts(DEFAULT_API, process.env.PIX_ALLOWED_API_HOSTS)
const DOWNLOAD_HOSTS = Array.from(new Set(API_HOSTS.concat(csvHosts(process.env.PIX_ALLOWED_DOWNLOAD_HOSTS))))
const EXTERNAL_HOSTS = Array.from(new Set(DOWNLOAD_HOSTS.concat(['t.me', 'telegram.me', 'scamalytics.com'])))
// 应用图标走 renderer/ 下的那份：build/ 只是 electron-builder 的构建资源目录，
// 不会进 app.asar，打包后按原路径读会拿到空图（原生图标静默丢失）。
const APP_ICON = path.join(__dirname, 'renderer', 'icon.png')
const APP_VERSION = require('./package.json').version

function appIconImage() {
  try {
    const img = nativeImage.createFromPath(APP_ICON)
    return img && !img.isEmpty() ? img : null
  } catch (e) {
    return null
  }
}

function applyAppIdentity() {
  app.setName('Hello Pix')
  const icon = appIconImage()
  if (icon && process.platform === 'darwin' && app.dock) app.dock.setIcon(icon)
  if (icon) {
    app.setAboutPanelOptions({
      applicationName: 'Hello Pix',
      applicationVersion: '0.1.0',
      iconPath: APP_ICON
    })
  }
}

let win
let cookieJar = {}
let apiBase = DEFAULT_API
// 界面主题：'dark' | 'light'。存 config.json，随窗口一起持久化。
// 默认日间（新用户首屏就是日间）；用户手动切到夜间后才记住用夜间。
// 之所以不放 localStorage：渲染层每次都是新页面，靠 IPC 读主进程更可靠。
let theme = 'light'
let lineId = 'overseas'   // 内置首条线路的 id（见 desktop/lines.js）
let lines = builtinLines.slice()
let profile = null
let tabs = []
let activeId = ''
let showHome = true
let overlayOpen = false
let nextTab = 1
let usedCount = {}

function userFile(name) {
  return path.join(app.getPath('userData'), name)
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return fallback
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

function timingEqual(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const ENCRYPTED_VALUE_PREFIX = 'safe:v1:'

function sealSettings(settings) {
  const copy = Object.assign({}, settings || {})
  const password = String(copy.proxyPass || '')
  if (!password || password.startsWith(ENCRYPTED_VALUE_PREFIX)) return copy
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    copy.proxyPass = ENCRYPTED_VALUE_PREFIX + safeStorage.encryptString(password).toString('base64')
  } else {
    delete copy.proxyPass
  }
  return copy
}

function unsealSettings(settings) {
  const copy = Object.assign({}, settings || {})
  const value = String(copy.proxyPass || '')
  if (!value.startsWith(ENCRYPTED_VALUE_PREFIX)) return copy
  try {
    copy.proxyPass = safeStorage && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(value.slice(ENCRYPTED_VALUE_PREFIX.length), 'base64'))
      : ''
  } catch (e) {
    copy.proxyPass = ''
  }
  return copy
}

function openAppsFile() {
  return userFile('open-apps.json')
}

function currentPixUser() {
  return String((profile && profile.username) || loadStoredAuth().username || '').trim()
}

function accountSlug() {
  const safe = currentPixUser().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  return safe || 'anon'
}

function makePartition(platformId, index) {
  return 'persist:pix-' + accountSlug() + '-' + platformId + '-' + index
}

function saveOpenApps() {
  const user = currentPixUser()
  if (!user) return
  const all = readJson(openAppsFile(), {})
  if (!all.byUser || typeof all.byUser !== 'object') all.byUser = {}
  all.byUser[user] = {
    nextTab: nextTab,
    usedCount: usedCount,
    activeId: activeId,
    showHome: showHome,
    tabs: tabs.map(t => ({
      id: t.id,
      platform: t.platform,
      name: t.name,
      title: t.title,
      index: t.index,
      icon: t.icon,
      partition: t.partition,
      url: t.url || '',
      settings: sealSettings(t.settings)
    }))
  }
  writeJson(openAppsFile(), all)
}

function platformHomeUrl(item, settings) {
  if (!item) return ''
  if (item.id === 'tickets') return String(apiBase || DEFAULT_API).replace(/\/+$/, '') + '/'
  if (item.customUrl && settings && settings.customUrl) return String(settings.customUrl)
  return item.url
}

function safeApiUrl(value) {
  return validateApiUrl(value, {
    development: DEVELOPMENT,
    allowedHosts: API_HOSTS
  })
}

function safePlatformHomeUrl(item, settings) {
  const candidate = platformHomeUrl(item, settings)
  if (!candidate || !isAllowedPlatformUrl(item, candidate, candidate)) return ''
  return candidate
}

function bindTabLoading(tab) {
  tab.view.webContents.on('did-start-loading', () => {
    tab.loading = true
    sendTabs()
  })
  tab.view.webContents.on('did-stop-loading', () => {
    tab.loading = false
    try { tab.url = tab.view.webContents.getURL() } catch (e) {}
    sendTabs()
    saveOpenApps()
  })
}

function restoreOneApp(row) {
  const item = fallbackPlatforms.find(p => p.id === row.platform)
  if (!item) return
  const index = Math.max(1, Number(row.index) || 1)
  const partition = row.partition || makePartition(item.id, index)
  const settings = normalizeTabSettings(unsealSettings(row.settings || {}))
  if (item.id === 'whatsapp-pro' && settings.antiRevoke === undefined) settings.antiRevoke = true
  const homeUrl = safePlatformHomeUrl(item, settings)
  if (!homeUrl) return
  const view = createWebView(partition, settings, item, homeUrl)
  const tab = {
    id: row.id || (item.id + '-' + nextTab++),
    platform: item.id,
    name: String(row.name || item.name).trim() || item.name,
    title: String(row.title || row.name || item.name).trim() || item.name,
    index: index,
    icon: row.icon || item.icon || item.id,
    view: view,
    item: item,
    homeUrl: homeUrl,
    settings: settings,
    partition: partition,
    url: homeUrl,
    loading: true
  }
  if (settings.muteAll) view.webContents.setAudioMuted(true)
  bindTabLoading(tab)
  tabs.push(tab)
  usedCount[item.id] = Math.max(Number(usedCount[item.id] || 0), index)
  const n = Number(String(tab.id).split('-').pop())
  if (n) nextTab = Math.max(nextTab, n + 1)
  startTabLoad(tab)
}

function restoreOpenApps(username) {
  if (tabs.length) return
  const user = String(username || currentPixUser() || '').trim()
  if (!user) return
  const all = readJson(openAppsFile(), {})
  const data = (all.byUser && all.byUser[user]) || (all.username === user ? all : null)
  if (!data || !Array.isArray(data.tabs) || !data.tabs.length) return
  nextTab = Math.max(1, Number(data.nextTab) || 1)
  usedCount = Object.assign({}, data.usedCount || {})
  data.tabs.forEach(row => {
    try { restoreOneApp(row) } catch (e) {}
  })
  if (data.activeId && tabs.find(t => t.id === data.activeId)) activeId = data.activeId
  else if (tabs.length) activeId = tabs[0].id
  showHome = data.showHome !== false
  if (!tabs.length) showHome = true
  layoutViews()
  sendTabs()
}

// 已下线的分区线路：服务器上这些节点并未部署，之前五条都指向同一地址，
// 切换无实际作用、延迟条还会误导用户。这里显式挡掉，避免老的本地配置
// （config.json 里存过 cn/hk/sg/jp/us）在改版后又被当成"额外线路"合并回来。
const RETIRED_LINE_IDS = new Set(['cn', 'hk', 'sg', 'jp', 'us'])

function isLegacyLine(item) {
  const id = String(item && item.id || '')
  if (RETIRED_LINE_IDS.has(id)) return true
  return /^线路\d+$/.test(String(item && item.name || '')) || /^line\d+$/.test(id)
}

function normalizeLine(item, index) {
  const safeUrl = safeApiUrl(item && item.url)
  return {
    id: String(item.id || 'line' + (index + 1)),
    name: item.name || ('线路' + (index + 1)),
    url: safeUrl || '',
    region: item.region || '',
    ms: item.ms
  }
}

function mergeLines(remote) {
  const byId = {}
  builtinLines.forEach(item => {
    byId[item.id] = normalizeLine(item, 0)
  })
  const extras = []
  builtinLines.concat(lines, remote || []).forEach((item, index) => {
    const row = normalizeLine(item, index)
    if (!row.url || isLegacyLine(row)) return
    if (byId[row.id]) {
      byId[row.id] = Object.assign({}, byId[row.id], row)
      return
    }
    if (!extras.find(x => x.id === row.id)) extras.push(row)
  })
  lines = builtinLines.map(item => byId[item.id]).concat(extras)
  return lines
}

function currentLine() {
  return lines.find(l => l.id === lineId) || lines.find(l => l.url === apiBase) || lines[0] ||
    normalizeLine({ id: 'overseas', name: '海外线路', url: apiBase, region: '海外' }, 0)
}

// --- 窗口尺寸记忆 -------------------------------------------------------------
// 竞品有 scheduleSaveWindowBounds；我们此前每次启动都用自适应尺寸覆盖，
// 用户调好的窗口大小无法保留。这里做同样的持久化，并在恢复时校验窗口仍在
// 可见显示器范围内（拔掉外接屏后不至于把窗口恢复到屏幕外）。
const WINDOW_BOUNDS_FILE = 'window-bounds.json'
let boundsSaveTimer = null

function scheduleSaveWindowBounds() {
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer)
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null
    if (!win || win.isDestroyed() || win.isFullScreen() || win.isMaximized()) return
    try { writeJson(userFile(WINDOW_BOUNDS_FILE), win.getBounds()) } catch (error) {}
  }, 500)
}

function restoreWindowBounds(fallback) {
  const saved = readJson(userFile(WINDOW_BOUNDS_FILE), null)
  if (!saved) return fallback
  const width = Math.round(Number(saved.width))
  const height = Math.round(Number(saved.height))
  const x = Math.round(Number(saved.x))
  const y = Math.round(Number(saved.y))
  if (![width, height, x, y].every(Number.isFinite)) return fallback
  try {
    const { screen: electronScreen } = require('electron')
    const visible = electronScreen.getAllDisplays().some(display => {
      const area = display.workArea
      return x + width > area.x + 120 && x < area.x + area.width - 40 &&
             y + height > area.y + 80 && y < area.y + area.height - 40
    })
    if (!visible) return fallback
  } catch (error) {
    return fallback
  }
  return {
    x, y,
    width: Math.min(Math.max(width, 1160), 3200),
    height: Math.min(Math.max(height, 680), 2000)
  }
}

function saveConfig() {
  writeJson(userFile('config.json'), {
    apiBase: apiBase,
    theme: theme,
    lineId: lineId,
    lines: lines.map(l => ({
      id: l.id,
      name: l.name,
      url: l.url,
      region: l.region || ''
    }))
  })
}

function applyLine(id) {
  if (id === 'auto') return currentLine()
  const line = lines.find(l => String(l.id) === String(id)) || currentLine()
  if (!line || !safeApiUrl(line.url)) return currentLine()
  lineId = line.id
  apiBase = line.url
  saveConfig()
  return line
}

function loadConfig() {
  const cfg = readJson(userFile('config.json'), {})
  theme = cfg.theme === 'dark' ? 'dark' : 'light'   // 默认日间
  const cached = Array.isArray(cfg.lines) ? cfg.lines.filter(l => !isLegacyLine(l)) : []
  lines = builtinLines.slice()
  if (cached.length) mergeLines(cached)
  apiBase = safeApiUrl(cfg.apiBase || DEFAULT_API) || safeApiUrl(DEFAULT_API) || ''
  // 默认落到内置首条（现在是"海外线路"）。不能再写死 'cn' —— 它已被列为
  // 下线的分区线路，写死会指向一个不存在的 id。
  const fallbackId = (builtinLines[0] && builtinLines[0].id) || 'overseas'
  lineId = isLegacyLine({ id: cfg.lineId }) ? fallbackId : String(cfg.lineId || fallbackId)
  const matched = lines.find(l => l.id === lineId) || lines.find(l => l.url === apiBase) || lines[0]
  if (matched) {
    lineId = matched.id
    apiBase = matched.url
  } else {
    lineId = fallbackId
  }
}

function loadStoredAuth() {
  const data = readJson(userFile('auth.json'), {})
  let password = ''
  if (data.passwordEnc && safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      password = safeStorage.decryptString(Buffer.from(data.passwordEnc, 'base64'))
    } catch (e) {}
  }
  return {
    remember: !!data.remember,
    autoLogin: !!data.autoLogin,
    username: data.username || '',
    password: password
  }
}

function publicAuth() {
  const auth = loadStoredAuth()
  return {
    remember: auth.remember,
    autoLogin: auth.autoLogin,
    username: auth.username,
    hasStoredPassword: !!auth.password
  }
}

function saveAuth(payload) {
  const remember = !!(payload && payload.remember)
  const autoLogin = remember && !!(payload && payload.autoLogin)
  if (!remember) {
    writeJson(userFile('auth.json'), { remember: false, autoLogin: false })
    return publicAuth()
  }
  const out = {
    remember: true,
    autoLogin: autoLogin,
    username: String((payload && payload.username) || '')
  }
  const password = String((payload && payload.password) || '')
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    out.passwordEnc = safeStorage.encryptString(password).toString('base64')
  } else {
    out.autoLogin = false
  }
  writeJson(userFile('auth.json'), out)
  return publicAuth()
}

function deviceId() {
  const file = userFile('device-id')
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
  const id = 'desktop-' + crypto.randomBytes(8).toString('hex')
  fs.writeFileSync(file, id)
  return id
}

function rememberCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : String(res.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/)
  list.forEach(item => {
    const part = String(item || '').split(';')[0]
    const eq = part.indexOf('=')
    if (eq < 0) return
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (!/^(__Host-)?pix_/.test(name)) return
    if (value) cookieJar[name] = value
    else delete cookieJar[name]
  })
}

async function api(pathname, opts) {
  const base = safeApiUrl(apiBase)
  if (!base) throw new Error('API 线路不符合安全策略')
  const options = opts || {}
  const headers = { Accept: 'application/json' }
  const cookieHeader = Object.keys(cookieJar).map(name => `${name}=${cookieJar[name]}`).join('; ')
  if (cookieHeader) headers.Cookie = cookieHeader
  headers['X-Pix-Device'] = deviceId()
  if (!['GET', 'HEAD', 'OPTIONS'].includes(String(options.method || 'GET').toUpperCase())) {
    const csrf = cookieJar['__Host-pix_csrf'] || cookieJar.pix_csrf
    if (csrf) headers['X-CSRF-Token'] = csrf
  }
  let body
  if (options.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(options.form).toString()
  }
  const res = await fetch(base + '/apis' + pathname, {
    method: options.method || 'GET',
    headers: headers,
    body: body
  })
  rememberCookies(res)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error('线路无法连接，请换一条再试：' + apiBase)
  }
}

async function fetchFrom(base, pathname, timeoutMs) {
  const safeBase = safeApiUrl(base)
  if (!safeBase) throw new Error('线路地址不符合安全策略')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 2500)
  try {
    const res = await fetch(safeBase + '/apis' + pathname, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' }
    })
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function refreshLines() {
  const bases = [apiBase].concat(lines.map(l => l.url)).filter((url, i, arr) => url && arr.indexOf(url) === i)
  for (let i = 0; i < bases.length; i++) {
    try {
      const data = await fetchFrom(bases[i], '/client/lines', 2000)
      const rows = (data && (data.rows || data.lines)) || []
      if (rows.length) {
        mergeLines(rows)
        saveConfig()
        break
      }
    } catch (e) {}
  }
  return { lineId: currentLine().id, rows: lines }
}

// 首次探测给更宽的预算：冷启动要现做 DNS 解析与 TLS 握手（还隔着 Cloudflare），
// 2.5 秒实测经常不够，会在登录页误报"超时"——新用户第一次打开就看见超时，
// 会以为软件坏了。首轮过后回到正常预算，真断线仍能快速显示超时。
const PING_TIMEOUT_FIRST = 8000
const PING_TIMEOUT_NORMAL = 2500
let hasPingedOnce = false

async function pingLine(id) {
  const line = lines.find(l => String(l.id) === String(id))
  if (!line) return { id: id, ok: false, ms: null }
  const start = Date.now()
  try {
    await fetchFrom(line.url, '/site/info', hasPingedOnce ? PING_TIMEOUT_NORMAL : PING_TIMEOUT_FIRST)
    line.ms = Date.now() - start
    line.ok = true
  } catch (e) {
    line.ms = null
    line.ok = false
  }
  return { id: line.id, ok: line.ok, ms: line.ms, name: line.name, region: line.region }
}

function fastestLine() {
  const ok = lines.filter(l => l.ok && l.ms != null).slice().sort((a, b) => a.ms - b.ms)
  return ok[0] || null
}

async function pingAllLines() {
  await Promise.all(lines.map(line => pingLine(line.id)))
  hasPingedOnce = true
  const best = fastestLine()
  if (best) applyLine(best.id)
  return {
    rows: lines.map(l => ({ id: l.id, name: l.name, region: l.region, url: l.url, ok: l.ok, ms: l.ms })),
    best: best ? { id: best.id, name: best.name, region: best.region, ms: best.ms } : null
  }
}

function settingOn(settings, key) {
  const s = settings || {}
  if (s[key] !== undefined) return !!s[key]
  return s.enableTranslate !== false
}

function normalizeTabSettings(settings) {
  const s = Object.assign({}, settings || {})
  if (s.showTransBar === undefined) s.showTransBar = true
  if (s.enableSendTranslate === undefined) s.enableSendTranslate = s.enableTranslate !== false
  if (s.enableRecvTranslate === undefined) s.enableRecvTranslate = s.enableTranslate !== false
  return s
}

function tabTransPayload(tab) {
  const s = (tab && tab.settings) || {}
  return {
    show: s.showTransBar !== false,
    enableSend: settingOn(s, 'enableSendTranslate'),
    enableRecv: settingOn(s, 'enableRecvTranslate'),
    sendFrom: s.sendFrom || 'auto',
    sendTo: s.sendTo || 'en',
    recvFrom: s.recvFrom || 'auto',
    recvTo: s.recvTo || 'zh',
    server: s.server || '',
    // 不再写死通道名：留空时由渲染进程从后台下发的通道列表里选
    engine: s.engine || (profile && profile.activeEngine) || '',
    groupMode: s.groupMode === 'auto' ? 'auto' : 'manual',
    includeZh: !!(s.includeZh && s.includeZh !== '0'),
    fontSize: Number(s.fontSize) || 15,
    fontColor: s.fontColor || '#22c55e',
    quickReply: !!s.enableQuickReply
  }
}

function tabPayload() {
  return {
    home: showHome || tabs.length === 0,
    activeId: activeId,
    rows: tabs.map(t => ({
      id: t.id,
      platform: t.platform,
      name: t.name,
      title: t.title,
      index: t.index,
      icon: t.icon,
      url: t.url || '',
      loading: !!t.loading,
      showTabName: !t.settings || t.settings.showTabName !== false,
      alignRight: !!(t.settings && t.settings.alignRight),
      alwaysStatusBar: !!(t.settings && t.settings.alwaysStatusBar),
      trans: tabTransPayload(t)
    }))
  }
}

function sendTabs() {
  if (!win || win.isDestroyed()) return
  win.webContents.send('app:tabs', tabPayload())
}

function sendKicked(msg) {
  cookieJar = {}
  profile = null
  clearTabs({ keepSaved: true })
  if (win && !win.isDestroyed()) win.webContents.send('auth:kicked', msg || '账号已在其他电脑登录')
}

function sendSession() {
  if (!win || win.isDestroyed() || !profile) return
  win.webContents.send('auth:session', profile)
}

function webAppsFile() {
  return userFile('web-apps.json')
}

function platformRows() {
  const store = readJson(webAppsFile(), {})
  return fallbackPlatforms.filter(item => item.listed !== false).map(item => {
    const row = store[item.id] || {}
    return Object.assign({}, item, {
      hasUpdate: item.badge !== false && !!row.hasUpdate,
      localVer: row.localVer || '',
      remoteVer: row.remoteVer || ''
    })
  })
}

function sendPlatforms() {
  if (!win || win.isDestroyed()) return
  win.webContents.send('app:platforms', { success: true, rows: platformRows() })
}

function platformHasCache(id) {
  const dir = path.join(app.getPath('userData'), 'Partitions')
  try {
    return fs.readdirSync(dir).some(name => name.indexOf('pix-' + id + '-') === 0)
  } catch (e) {
    return false
  }
}

function fingerprintFromHtml(html) {
  const assets = []
  const re = /(?:src|href)="([^"]+\.(?:js|css)[^"]*)"/gi
  let m
  while ((m = re.exec(html))) assets.push(m[1])
  const raw = assets.length
    ? assets.sort().join('|')
    : String(html || '').replace(/nonce="[^"]*"/g, '').slice(0, 8000)
  return crypto.createHash('sha1').update(raw).digest('hex')
}

async function fetchWebFingerprint(url) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 8000)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'User-Agent': CHROME_UA,
        Accept: 'text/html,application/xhtml+xml'
      }
    })
    if (!res.ok) return ''
    return fingerprintFromHtml(await res.text())
  } catch (e) {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

let checkingWebApps = false

async function refreshPlatformUpdates() {
  if (checkingWebApps) return
  checkingWebApps = true
  const store = readJson(webAppsFile(), {})
  const jobs = fallbackPlatforms.filter(item => item.badge !== false)
  let i = 0
  async function worker() {
    while (i < jobs.length) {
      const item = jobs[i++]
      const remote = await fetchWebFingerprint(item.url)
      if (!remote) continue
      const prev = store[item.id] || {}
      if (!prev.localHash) {
        if (platformHasCache(item.id)) {
          store[item.id] = {
            localHash: '',
            remoteHash: remote,
            hasUpdate: true,
            localVer: prev.localVer || '',
            remoteVer: Date.now(),
            checkedAt: Date.now()
          }
        } else {
          const v = Date.now()
          store[item.id] = {
            localHash: remote,
            remoteHash: remote,
            hasUpdate: false,
            localVer: v,
            remoteVer: v,
            checkedAt: v
          }
        }
      } else {
        const changed = prev.localHash !== remote
        store[item.id] = {
          localHash: prev.localHash,
          remoteHash: remote,
          hasUpdate: changed,
          localVer: prev.localVer || prev.checkedAt || '',
          remoteVer: changed ? Date.now() : (prev.remoteVer || prev.localVer || prev.checkedAt),
          checkedAt: Date.now()
        }
      }
    }
  }
  try {
    await Promise.all([worker(), worker(), worker(), worker()])
    writeJson(webAppsFile(), store)
    sendPlatforms()
  } finally {
    checkingWebApps = false
  }
}

async function clearPlatformWebCache(id) {
  const seen = new Set()
  tabs.forEach(tab => {
    if (tab.platform !== id || !tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return
    seen.add(tab.view.webContents.session)
  })
  const dir = path.join(app.getPath('userData'), 'Partitions')
  try {
    fs.readdirSync(dir).forEach(name => {
      if (name.indexOf('pix-' + id + '-') === 0) seen.add(session.fromPartition('persist:' + name))
    })
  } catch (e) {}
  for (const ses of seen) {
    try { await ses.clearCache() } catch (e) {}
    try { await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }) } catch (e) {}
  }
}

async function updatePlatformWeb(id) {
  const item = fallbackPlatforms.find(p => p.id === String(id || ''))
  if (!item || item.badge === false) return { success: false, msg: '该应用无需更新' }
  await clearPlatformWebCache(item.id)
  const remote = await fetchWebFingerprint(item.url)
  const store = readJson(webAppsFile(), {})
  const now = Date.now()
  store[item.id] = {
    localHash: remote || (store[item.id] && store[item.id].remoteHash) || '',
    remoteHash: remote || (store[item.id] && store[item.id].remoteHash) || '',
    hasUpdate: false,
    localVer: now,
    remoteVer: now,
    checkedAt: now
  }
  writeJson(webAppsFile(), store)
  tabs.forEach(tab => {
    if (tab.platform !== item.id || !tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return
    tab.view.webContents.reloadIgnoringCache()
  })
  const rows = platformRows()
  sendPlatforms()
  return { success: true, rows: rows }
}

function activeWantsStatus() {
  return false
}

function activeWantsTransBar() {
  if (showHome || !tabs.length) return false
  const tab = tabs.find(t => t.id === activeId)
  if (!tab) return false
  return !tab.settings || tab.settings.showTransBar !== false
}

function chromeOffset() {
  // 首选哨兵实测值：标签栏/工具条/状态栏高度无论怎么变都自动生效
  if (hasMeasuredChrome) return measuredChromeHeight
  // 首帧（哨兵尚未上报）才按常量估算
  return TABS_HEIGHT + UTILITY_HEIGHT + (activeWantsTransBar() ? (hasMeasuredBarHeight ? measuredTransBarHeight : TRANS_BAR_HEIGHT) : 0) + (activeWantsStatus() ? STATUS_HEIGHT : 0)
}

let chromeAnim = null
const CHROME_ANIM_MS = 420

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3)
}

function stopChromeAnim() {
  if (!chromeAnim) return
  clearInterval(chromeAnim)
  chromeAnim = null
}

function applyViewBounds(y, attach) {
  if (!win || win.isDestroyed()) return
  if (overlayOpen || showHome || !tabs.length) {
    tabs.forEach(tab => detachView(tab.view))
    return
  }
  const size = win.getContentSize()
  const top = Math.max(0, Math.round(y))
  const bounds = {
    x: 0,
    y: top,
    width: Math.max(0, size[0]),
    height: Math.max(0, size[1] - top - FOOTER_HEIGHT)
  }
  tabs.forEach(tab => {
    if (tab.id === activeId) {
      tab.view.setBounds(bounds)
      if (attach) attachView(tab.view)
    } else {
      detachView(tab.view)
    }
  })
}

function currentViewY() {
  const tab = tabs.find(t => t.id === activeId)
  try {
    if (tab && tab.view) return tab.view.getBounds().y
  } catch (e) {}
  return chromeOffset()
}

function animateChromeTo(nextY) {
  if (!win || win.isDestroyed() || overlayOpen || showHome) {
    layoutViews()
    return
  }
  const fromY = currentViewY()
  if (Math.abs(fromY - nextY) < 2) {
    layoutViews()
    return
  }
  stopChromeAnim()
  applyViewBounds(fromY, true)
  const started = Date.now()
  chromeAnim = setInterval(() => {
    const t = Math.min(1, (Date.now() - started) / CHROME_ANIM_MS)
    applyViewBounds(fromY + (nextY - fromY) * easeOutCubic(t), false)
    if (t >= 1) stopChromeAnim()
  }, 16)
}

function layoutViews() {
  stopChromeAnim()
  applyViewBounds(chromeOffset(), true)
}

function attachView(view) {
  detachView(view)
  win.contentView.addChildView(view)
}

function detachView(view) {
  try {
    win.contentView.removeChildView(view)
  } catch (e) {}
}

function destroyTab(tab) {
  stopSshTunnel(tab)
  detachView(tab.view)
  try {
    tab.view.webContents.destroy()
  } catch (e) {}
}

function clearTabs(opts) {
  tabs.forEach(destroyTab)
  tabs = []
  activeId = ''
  usedCount = {}
  nextTab = 1
  showHome = true
  if (!opts || !opts.keepSaved) saveOpenApps()
  sendTabs()
}

function goHome() {
  showHome = true
  layoutViews()
  sendTabs()
  saveOpenApps()
  return { success: true }
}

function switchTab(id) {
  const tab = tabs.find(t => t.id === id)
  if (!tab) return { success: false, msg: '窗口不存在' }
  activeId = id
  showHome = false
  // 切换标签会改变顶部 chrome 高度（不同标签的工具条/状态栏偏好不同），
  // CSS 有 420ms 过渡动画，这里必须同样走动画，否则原生视图瞬间跳变造成错位。
  // animateChromeTo 在高度未变时会自行回退到 layoutViews。
  animateChromeTo(chromeOffset())
  sendTabs()
  saveOpenApps()
  return { success: true }
}

function closeTab(id) {
  const index = tabs.findIndex(t => t.id === id)
  if (index < 0) return { success: false, msg: '窗口不存在' }
  destroyTab(tabs[index])
  tabs.splice(index, 1)
  if (activeId === id) activeId = tabs.length ? tabs[Math.min(index, tabs.length - 1)].id : ''
  if (!tabs.length) showHome = true
  // 关闭标签可能改变 chrome 高度；与 switchTab 同样走动画，避免原生视图跳变
  animateChromeTo(chromeOffset())
  sendTabs()
  saveOpenApps()
  return { success: true }
}

function guestPrefs() {
  const p = profile || {}
  return {
    transRecv: p.transRecv !== 0,
    transSend: p.transSend !== 0,
    transGroup: !!Number(p.transGroup),
    langMine: p.langMine || 'zh',
    langOther: p.langOther || 'auto',
    includeZh: Number(p.includeZh) === 1
  }
}

function findTabByWc(wc) {
  return tabs.find(t => t.view && t.view.webContents === wc) || null
}

function trustedTabSender(wc) {
  const tab = findTabByWc(wc)
  if (!tab || !tab.item || tab.item.customUrl || tab.item.id === 'tickets') return null
  let current = ''
  try { current = wc.getURL() } catch (e) {}
  return isAllowedPlatformUrl(tab.item, current, tab.homeUrl) ? tab : null
}

function pickLang(value, fallback) {
  const v = String(value || '').trim()
  if (!v || v === 'auto') return fallback
  return v
}

function tabPrefs(tab) {
  const g = guestPrefs()
  const s = (tab && tab.settings) || {}
  const hasTab = !!(tab && tab.settings && (s.enableTranslate !== undefined || s.enableSendTranslate !== undefined || s.sendTo || s.recvTo))
  return {
    transRecv: hasTab ? settingOn(s, 'enableRecvTranslate') : g.transRecv,
    transSend: hasTab ? settingOn(s, 'enableSendTranslate') : g.transSend,
    transGroup: hasTab ? s.groupMode === 'auto' : g.transGroup,
    langMine: pickLang(s.recvTo, g.langMine || 'zh'),
    langOther: s.recvFrom || g.langOther || 'auto',
    sendFrom: s.sendFrom || 'auto',
    sendTo: pickLang(s.sendTo, 'en'),
    includeZh: s.includeZh !== undefined
      ? !!(s.includeZh && s.includeZh !== '0' && s.includeZh !== false)
      : g.includeZh,
    fontSize: Number(s.fontSize) || 15,
    fontColor: s.fontColor || '#22c55e',
    antiRevoke: !!s.antiRevoke
  }
}

function updateTabSettings(id, patch) {
  const tab = tabs.find(t => t.id === String(id || ''))
  if (!tab) return { success: false, msg: '应用不存在' }
  tab.settings = normalizeTabSettings(Object.assign({}, tab.settings || {}, patch || {}))
  if (tab.settings.muteAll !== undefined && tab.view && tab.view.webContents && !tab.view.webContents.isDestroyed()) {
    tab.view.webContents.setAudioMuted(!!tab.settings.muteAll)
  }
  const wc = tab.view && tab.view.webContents
  if (wc && !wc.isDestroyed()) {
    const prefs = tabPrefs(tab)
    wc.send('translate:prefs', prefs)
  }
  const barToggle = patch && Object.prototype.hasOwnProperty.call(patch, 'showTransBar')
  sendTabs()
  saveOpenApps()
  if (barToggle && !showHome) animateChromeTo(chromeOffset())
  else layoutViews()
  return { success: true }
}

function stripEmoji(text) {
  return String(text || '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\uFE0F\u200D\u20E3]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const transCache = new Map()

function transCacheKey(from, to, engine, text) {
  return crypto.createHash('sha256')
    .update([engine || '', from || 'auto', to || '', text].join('\u0001'))
    .digest('hex')
}

function getTransCached(from, to, engine, text) {
  const key = transCacheKey(from, to, engine, text)
  const row = transCache.get(key)
  if (!row) return ''
  transCache.delete(key)
  transCache.set(key, row)
  return row
}

function putTransCached(from, to, engine, text, translation) {
  const out = String(translation || '').trim()
  if (!out) return
  const key = transCacheKey(from, to, engine, text)
  transCache.delete(key)
  transCache.set(key, out)
  while (transCache.size > 1000) transCache.delete(transCache.keys().next().value)
}

// 为翻译请求生成服务端幂等键：同设备 + 同参数 + 同文本永远是同一个键，
// 服务端据此做幂等去重（重复渲染/重试不会二次扣费）；正式后端缺此键会直接 400。
function transRequestId(text, from, to, engine) {
  const fingerprint = crypto.createHash('sha256')
    .update([String(engine || ''), String(from || ''), String(to || ''), String(text || '')].join('\u0001'))
    .digest('hex')
    .slice(0, 40)
  return `desktop:${deviceId()}:${fingerprint}`
}

function pushGuestPrefs() {
  tabs.forEach(tab => {
    const wc = tab.view && tab.view.webContents
    if (!wc || wc.isDestroyed() || !trustedTabSender(wc)) return
    const prefs = tabPrefs(tab)
    wc.send('translate:prefs', prefs)
  })
}

function pushPrefsToGuest(view) {
  if (!view || !view.webContents || view.webContents.isDestroyed()) return
  const tab = tabs.find(t => t.view === view)
  if (!tab || !trustedTabSender(view.webContents)) return
  const prefs = tabPrefs(tab)
  view.webContents.send('translate:prefs', prefs)
}

function proxyPresetOf(id) {
  return proxyPresets.find(item => item.id === id) || proxyPresets[0]
}

function sanitizeProxyPart(raw, max) {
  const text = String(raw || '').trim()
  if (!text || text.length > (max || 260) || /[\s<>'"\\]/.test(text)) return ''
  return text
}

function parseProxyHostLine(raw) {
  const text = String(raw || '').trim().replace(/^(socks5h?|https?):\/\//i, '')
  if (!text) return {}
  const authAt = text.lastIndexOf('@')
  if (authAt > 0) {
    const auth = text.slice(0, authAt)
    const hostPort = text.slice(authAt + 1)
    const colon = auth.indexOf(':')
    const hp = hostPort.split(':')
    return {
      user: colon >= 0 ? auth.slice(0, colon) : auth,
      pass: colon >= 0 ? auth.slice(colon + 1) : '',
      host: hp[0] || '',
      port: hp[1] || ''
    }
  }
  const parts = text.split(':')
  if (parts.length >= 4) {
    return { host: parts[0], port: parts[1], user: parts[2], pass: parts.slice(3).join(':') }
  }
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return { host: parts[0], port: parts[1] }
  }
  return { host: text }
}

function proxyRulesOf(settings) {
  const type = String((settings && settings.proxyType) || 'none')
  if (!type || type === 'none') return ''
  const preset = proxyPresetOf(type)
  if (preset.kind === 'direct') return ''
  if (type === 'ssh' && settings.proxyLocal) return 'socks5://' + settings.proxyLocal
  let host = sanitizeProxyPart(settings.proxyHost, 180)
  let port = sanitizeProxyPart(settings.proxyPort, 8)
  let user = String((settings && settings.proxyUser) || '').trim()
  let pass = String((settings && settings.proxyPass) || '').trim()
  const parsed = parseProxyHostLine(settings.proxyHost || settings.proxyNode || '')
  if (!host && parsed.host) host = sanitizeProxyPart(parsed.host, 180)
  if (!port && parsed.port) port = sanitizeProxyPart(parsed.port, 8)
  if (!user && parsed.user) user = String(parsed.user).trim()
  if (!pass && parsed.pass) pass = String(parsed.pass).trim()
  if (settings.proxyNode && !host) {
    const node = parseProxyHostLine(settings.proxyNode)
    host = sanitizeProxyPart(node.host, 180)
    port = port || sanitizeProxyPart(node.port, 8)
    user = user || String(node.user || '').trim()
    pass = pass || String(node.pass || '').trim()
  }
  if (!host) return ''
  const scheme = String((settings && settings.proxyScheme) || preset.scheme || 'socks5').toLowerCase()
  const proto = scheme === 'https' ? 'https' : scheme === 'http' ? 'http' : 'socks5'
  const auth = user || pass
    ? encodeURIComponent(user) + ':' + encodeURIComponent(pass) + '@'
    : ''
  return proto + '://' + auth + host + (port ? ':' + port : '')
}

function stopSshTunnel(tab) {
  if (!tab || !tab.sshProc) return
  try { tab.sshProc.kill() } catch (e) {}
  tab.sshProc = null
}

function startSshTunnel(tab) {
  stopSshTunnel(tab)
  const settings = tab.settings || {}
  const parsed = parseProxyHostLine(settings.proxyHost || '')
  const host = sanitizeProxyPart(settings.proxyHost && !String(settings.proxyHost).includes(':') ? settings.proxyHost : parsed.host, 180)
  const user = String(settings.proxyUser || parsed.user || '').trim()
  const port = Number(settings.proxyPort || parsed.port) || 22
  const validHost = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,178}[a-zA-Z0-9])?$/.test(host) || /^[0-9a-fA-F:]+$/.test(host)
  if (!validHost || !/^[a-zA-Z0-9._-]{1,64}$/.test(user) || port < 1 || port > 65535) return Promise.resolve()
  const local = 18100 + (Number(tab.index) || 1)
  settings.proxyLocal = '127.0.0.1:' + local
  const child = spawn('ssh', [
    '-N',
    '-D', String(local),
    '-p', String(port),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-l', user,
    '--', host
  ], { stdio: 'ignore' })
  tab.sshProc = child
  child.on('error', () => {
    if (tab.sshProc === child) tab.sshProc = null
  })
  child.on('exit', () => {
    if (tab.sshProc === child) tab.sshProc = null
  })
  return new Promise(resolve => setTimeout(resolve, 700))
}

function sessionGetText(ses, url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url: url, session: ses, redirect: 'follow' })
    let body = ''
    req.on('response', res => {
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve(body))
    })
    req.on('error', reject)
    req.end()
  })
}

function parseJsonSafe(text) {
  try { return JSON.parse(text) } catch (e) { return null }
}

async function lookupIpGeo(ip, channel) {
  const empty = { ip: ip, country: '', region: '', city: '', loc: '', timezone: '', zip: '' }
  if (!ip) return empty
  try {
    if (channel === 'ipapi') {
      const data = parseJsonSafe(await sessionGetText(session.defaultSession, 'http://ip-api.com/json/' + encodeURIComponent(ip) + '?lang=zh-CN&fields=status,country,countryCode,regionName,city,lat,lon,timezone,zip,query'))
      if (!data || data.status !== 'success') return empty
      return {
        ip: data.query || ip,
        country: (data.country || '') + (data.countryCode ? '(' + data.countryCode + ')' : ''),
        region: data.regionName || '',
        city: data.city || '',
        loc: (data.lon != null && data.lat != null) ? (data.lon + '/' + data.lat) : '',
        timezone: data.timezone || '',
        zip: data.zip || ''
      }
    }
    if (channel === 'ipinfo') {
      const data = parseJsonSafe(await sessionGetText(session.defaultSession, 'https://ipinfo.io/' + encodeURIComponent(ip) + '/json'))
      if (!data) return empty
      const loc = String(data.loc || '')
      const parts = loc.split(',')
      return {
        ip: data.ip || ip,
        country: data.country || '',
        region: data.region || '',
        city: data.city || '',
        loc: parts.length === 2 ? (parts[1] + '/' + parts[0]) : loc,
        timezone: data.timezone || '',
        zip: data.postal || ''
      }
    }
    if (channel === 'ipwhois') {
      const data = parseJsonSafe(await sessionGetText(session.defaultSession, 'https://ipwho.is/' + encodeURIComponent(ip)))
      if (!data || data.success === false) return empty
      return {
        ip: data.ip || ip,
        country: (data.country || '') + (data.country_code ? '(' + data.country_code + ')' : ''),
        region: data.region || '',
        city: data.city || '',
        loc: (data.longitude != null && data.latitude != null) ? (data.longitude + '/' + data.latitude) : '',
        timezone: (data.timezone && data.timezone.id) || '',
        zip: data.postal || ''
      }
    }
    const data = parseJsonSafe(await sessionGetText(session.defaultSession, 'https://api.db-ip.com/v2/free/' + encodeURIComponent(ip)))
    if (!data) return empty
    return {
      ip: data.ipAddress || ip,
      country: (data.countryName || '') + (data.countryCode ? '(' + data.countryCode + ')' : ''),
      region: data.stateProv || '',
      city: data.city || '',
      loc: '',
      timezone: '',
      zip: ''
    }
  } catch (e) {
    return empty
  }
}

function proxyHistoryFile() {
  return userFile('proxy-ip-history.json')
}

function noteProxyIp(ip) {
  if (!ip) return null
  const all = readJson(proxyHistoryFile(), { rows: [] })
  const rows = Array.isArray(all.rows) ? all.rows : []
  const prev = rows.find(item => item.ip === ip)
  const now = Date.now()
  rows.unshift({ ip: ip, at: now })
  const seen = {}
  const next = rows.filter(item => {
    if (!item || !item.ip || seen[item.ip]) return false
    seen[item.ip] = 1
    return now - Number(item.at || 0) < 30 * 86400000
  }).slice(0, 80)
  writeJson(proxyHistoryFile(), { rows: next })
  if (!prev) return null
  return prev.at
}

async function detectProxyNode(payload) {
  const settings = payload || {}
  const rules = proxyRulesOf(settings)
  if (!rules) return { success: false, msg: '请先填写代理主机和端口' }
  const ses = session.fromPartition('temp:pix-proxy-detect')
  try {
    await ses.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' })
  } catch (e) {
    try { await ses.setProxy({ mode: 'direct' }) } catch (ignore) {}
    return { success: false, msg: '代理规则无效' }
  }
  const v4 = settings.proxyIpVer !== 'ipv6'
  const urls = v4
    ? ['https://api.ipify.org?format=json', 'https://ipv4.icanhazip.com']
    : ['https://api64.ipify.org?format=json', 'https://api6.ipify.org?format=json']
  let ip = ''
  let lastErr = ''
  for (let i = 0; i < urls.length; i++) {
    try {
      const text = (await sessionGetText(ses, urls[i])).trim()
      const json = parseJsonSafe(text)
      ip = String((json && json.ip) || text).replace(/[^\w.:]/g, '')
      if (ip) break
    } catch (e) {
      lastErr = e && e.message ? e.message : '连接失败'
    }
  }
  if (!ip) {
    try { await ses.clearStorageData() } catch (ignore) {}
    try { await ses.setProxy({ mode: 'direct' }) } catch (ignore) {}
    return { success: false, msg: lastErr ? ('节点连不上：' + lastErr) : '节点连不上，请检查主机、端口和账密' }
  }
  const geo = await lookupIpGeo(ip, settings.proxyChannel || 'dbip')
  geo.ip = geo.ip || ip
  const usedAt = noteProxyIp(ip)
  try { await ses.clearStorageData() } catch (ignore) {}
  try { await ses.setProxy({ mode: 'direct' }) } catch (ignore) {}
  return {
    success: true,
    ip: ip,
    geo: geo,
    history: usedAt ? { at: usedAt } : null
  }
}

function applySessionProxy(ses, settings) {
  const rules = proxyRulesOf(settings)
  const next = rules
    ? ses.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' })
    : ses.setProxy({ mode: 'direct' })
  return Promise.resolve(next).catch(() => {})
}

function startTabLoad(tab) {
  if (!tab || !tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return
  const ready = String((tab.settings && tab.settings.proxyType) || '') === 'ssh'
    ? startSshTunnel(tab)
    : Promise.resolve()
  ready.then(() => applySessionProxy(tab.view.webContents.session, tab.settings)).finally(() => {
    if (!tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return
    tab.view.webContents.loadURL(tab.url)
  })
}

function createWebView(partition, settings, item, homeUrl) {
  const ses = session.fromPartition(partition)
  ses.setUserAgent(CHROME_UA)
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const trusted = trustedTabSender(wc)
    const allowNotification = trusted && permission === 'notifications' && (!settings || settings.showNotify !== false)
    callback(!!allowNotification)
  })
  const bridgeEnabled = !item.customUrl && item.id !== 'tickets'
  const view = new WebContentsView({
    webPreferences: {
      preload: bridgeEnabled ? path.join(__dirname, 'guest-inject.js') : undefined,
      partition: partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  if (typeof view.setBorderRadius === 'function') view.setBorderRadius(0)
  if (typeof view.setBackgroundColor === 'function') view.setBackgroundColor('#081628')
  view.webContents.setUserAgent(CHROME_UA)
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const guardNavigation = (event, targetUrl) => {
    if (!isAllowedPlatformUrl(item, targetUrl, homeUrl)) event.preventDefault()
  }
  view.webContents.on('will-navigate', guardNavigation)
  view.webContents.on('will-redirect', guardNavigation)
  view.webContents.on('did-finish-load', () => pushPrefsToGuest(view))
  return view
}

function openPlatform(payload) {
  const platforms = fallbackPlatforms
  const item = platforms.find(p => p.id === payload.platformId)
  if (!item) return { success: false, msg: '不支持该平台' }
  usedCount[item.id] = Number(usedCount[item.id] || 0) + 1
  const index = usedCount[item.id]
  const id = item.id + '-' + nextTab++
  const partition = makePartition(item.id, index)
  const settings = normalizeTabSettings(payload.settings || {})
  if (item.id === 'whatsapp-pro' && settings.antiRevoke === undefined) settings.antiRevoke = true
  const homeUrl = safePlatformHomeUrl(item, settings)
  if (!homeUrl) return { success: false, msg: '应用地址不符合安全策略' }
  const displayName = String(payload.name || item.name).trim() || item.name
  const view = createWebView(partition, settings, item, homeUrl)
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
    view.webContents.on('did-fail-load', (_e, _code, _desc, _url, isMain) => {
      if (isMain) {
        try { view.webContents.stop() } catch (e) {}
      }
    })
  }
  tab.url = homeUrl
  tab.loading = true
  bindTabLoading(tab)
  tabs.push(tab)
  startTabLoad(tab)
  activeId = id
  showHome = false
  layoutViews()
  sendTabs()
  saveOpenApps()
  return { success: true, id: id }
}

function createWindow() {
  // 按屏幕可用区域自适应开窗：此前固定 1280x820，小屏尚可、大屏浪费，
  // 而窄屏下顶部翻译设置区会被挤压换行。取下 92% 并设上下限，保证完整显示。
  const { screen: electronScreen } = require('electron')
  const { workAreaSize } = electronScreen.getPrimaryDisplay()
  // 高度优先：顶部设置区两行需要空间，因此尽量吃满可用高度（只留 16px 余量），
  // 而不是按比例缩。1280x800 这类逻辑分辨率下可用高度约 775px，这就是物理上限。
  // 竞品的设计最小宽 ≈1150（4 列 ×(70 标签 + 215 控件) + 内边距），我们取 1160
  const MIN_WIDTH = 1160
  const fallback = {
    width: Math.max(MIN_WIDTH, Math.min(1920, workAreaSize.width - 16)),
    height: Math.max(680, Math.min(1600, workAreaSize.height - 16))
  }
  const saved = restoreWindowBounds(fallback)
  const width = saved.width
  const height = saved.height
  win = new BrowserWindow({
    width,
    height,
    center: true,
    minWidth: 1160,
    minHeight: 680,
    title: 'Hello Pix',
    icon: APP_ICON,
    backgroundColor: '#070b14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.setMenuBarVisibility(false)
  // macOS 会恢复上次的窗口框架，覆盖构造时的 width/height。
  // 这里显式再设一次并居中，确保"吃满可用区域"的尺寸真正生效。
  const hasSavedPosition = Number.isFinite(saved.x) && Number.isFinite(saved.y)
  win.setBounds({
    x: hasSavedPosition ? saved.x : win.getBounds().x,
    y: hasSavedPosition ? saved.y : win.getBounds().y,
    width,
    height
  })
  if (!hasSavedPosition) win.center()
  win.on('resize', layoutViews)
  win.on('resized', layoutViews)
  win.on('resize', scheduleSaveWindowBounds)
  win.on('move', scheduleSaveWindowBounds)
  win.on('enter-full-screen', layoutViews)
  win.on('leave-full-screen', layoutViews)
  win.webContents.on('did-finish-load', layoutViews)
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

function isMainSender(event) {
  return !!(event && win && !win.isDestroyed() && event.sender === win.webContents)
}

function rejectUntrustedSender() {
  return { success: false, msg: '不允许的 IPC 来源' }
}

// 工具条高度由渲染层实测上报：改样式后无需再同步硬编码常量。
// 只在数值真正变化时重排，避免频繁触发原生视图跳动。
ipcMain.on('chrome:height', (event, height) => {
  if (!isMainSender(event)) return
  const value = Math.round(Number(height))
  if (!Number.isFinite(value) || value < 0 || value > 1000) return
  if (value === measuredChromeHeight && hasMeasuredChrome) return
  const firstMeasure = !hasMeasuredChrome
  measuredChromeHeight = value
  hasMeasuredChrome = true
  // 首帧没有"上一个位置"可缓动，直接落位，免得开窗时看到一次滑动。
  // 其余情况一律走缓动：收起时 showTransBar 已置 false，若按 activeWantsTransBar()
  // 判断就会走瞬跳分支，原生视图一帧内跳到新位置、盖掉渲染层 340ms 的收起动画，
  // 而展开方向却是缓动的 —— 同一个开关两个方向表现不一致。
  if (firstMeasure || overlayOpen || showHome) layoutViews()
  else animateChromeTo(chromeOffset())
})

ipcMain.on('chrome:barHeight', (event, height) => {
  if (!isMainSender(event)) return
  const value = Math.round(Number(height))
  if (!Number.isFinite(value) || value < 0 || value > 400) return
  if (value === measuredTransBarHeight) return
  measuredTransBarHeight = value
  hasMeasuredBarHeight = true
  // animateChromeTo 内部会 stopChromeAnim()，这里不要手动置空动画句柄
  if (activeWantsTransBar()) {
    animateChromeTo(chromeOffset())
  } else {
    layoutViews()
  }
})

ipcMain.handle('config:get', () => ({
  apiBase: apiBase,
  theme: theme,
  lineId: currentLine().id,
  lines: lines
}))

// 主题切换：只接受两个合法值，落盘后回执，渲染层据此更新 data-theme
ipcMain.handle('config:setTheme', (event, value) => {
  if (!isMainSender(event)) return rejectUntrustedSender()
  const next = value === 'dark' ? 'dark' : 'light'
  theme = next
  saveConfig()
  return { success: true, theme: theme }
})

ipcMain.handle('auth:get', event => isMainSender(event) ? publicAuth() : rejectUntrustedSender())
ipcMain.handle('auth:save', (event, payload) => isMainSender(event) ? saveAuth(payload || {}) : rejectUntrustedSender())

ipcMain.handle('config:setApiBase', (event, url) => {
  if (!isMainSender(event)) return rejectUntrustedSender()
  const nextBase = safeApiUrl(url || DEFAULT_API)
  if (!nextBase) return { success: false, msg: '线路地址不符合安全策略' }
  apiBase = nextBase
  const matched = lines.find(l => l.url === apiBase)
  if (matched) lineId = matched.id
  saveConfig()
  return { apiBase: apiBase, lineId: lineId }
})

ipcMain.handle('lines:list', async () => refreshLines())

ipcMain.handle('lines:select', (_event, id) => {
  const line = applyLine(id)
  return { success: true, lineId: line.id, apiBase: line.url, line: line }
})

ipcMain.handle('lines:ping', async (_event, id) => pingLine(id))
ipcMain.handle('lines:pingAll', async () => pingAllLines())
ipcMain.handle('site:info', async () => {
  try {
    return await fetchFrom(apiBase, '/site/info', 2500)
  } catch (e) {
    return {}
  }
})
ipcMain.handle('shell:open', async (event, url) => {
  if (!isMainSender(event)) return rejectUntrustedSender()
  const href = String(url || '')
  if (isAllowedExternalUrl(href, EXTERNAL_HOSTS)) {
    await shell.openExternal(href)
    return { success: true }
  }
  return { success: false, msg: '外部链接不在信任列表' }
})

async function loginWithCredentials(username, password) {
  const previousCookies = cookieJar
  cookieJar = {}
  const data = await api('/client/login', {
    method: 'POST',
    form: {
      username: username,
      password: password,
      deviceId: deviceId()
    }
  })
  if (!data || !data.success) {
    cookieJar = previousCookies
    return data
  }
  profile = data.obj
  restoreOpenApps(profile && profile.username)
  return data
}

ipcMain.handle('auth:login', async (event, payload) => {
  if (!isMainSender(event)) return rejectUntrustedSender()
  const value = payload || {}
  return loginWithCredentials(String(value.username || ''), String(value.password || ''))
})

ipcMain.handle('auth:autoLogin', async event => {
  if (!isMainSender(event)) return rejectUntrustedSender()
  const auth = loadStoredAuth()
  if (!auth.remember || !auth.autoLogin || !auth.username || !auth.password) {
    return { success: false, msg: '未启用自动登录' }
  }
  return loginWithCredentials(auth.username, auth.password)
})

ipcMain.handle('auth:verifyLock', async (event, password) => {
  if (!isMainSender(event)) return rejectUntrustedSender()
  const entered = String(password || '')
  if (!entered) return { success: false, msg: '请输入密码' }
  const auth = loadStoredAuth()
  if (auth.password && (!profile || !auth.username || auth.username === profile.username)) {
    return { success: timingEqual(auth.password, entered), msg: '密码不正确' }
  }
  if (!profile || !profile.username) return { success: false, msg: '登录状态已失效' }
  const result = await loginWithCredentials(profile.username, entered)
  return result && result.success ? { success: true } : { success: false, msg: '密码不正确' }
})

ipcMain.handle('auth:logout', async event => {
  if (!isMainSender(event)) return rejectUntrustedSender()
  try {
    await api('/client/logout', { method: 'POST' })
  } catch (e) {}
  cookieJar = {}
  profile = null
  clearTabs({ keepSaved: true })
  return { success: true }
})

ipcMain.handle('auth:session', async () => {
  const data = await api('/client/session')
  if (!data || !data.obj) {
    sendKicked((data && data.msg) || '登录状态已失效，请重新登录')
    return data
  }
  profile = data.obj
  sendSession()
  return data
})

ipcMain.handle('app:platforms', async () => {
  try {
    const data = await api('/client/platforms')
    if (data && data.kicked) sendKicked(data.msg)
  } catch (e) {}
  const rows = platformRows()
  setTimeout(() => refreshPlatformUpdates(), 0)
  return { success: true, rows: rows }
})
ipcMain.handle('app:updatePlatform', async (_event, id) => updatePlatformWeb(id))
ipcMain.handle('app:proxyPresets', () => ({ success: true, rows: proxyPresets }))
ipcMain.handle('proxy:detect', (event, payload) => isMainSender(event) ? detectProxyNode(payload || {}) : rejectUntrustedSender())
ipcMain.handle('app:preset', (_event, id) => {
  const all = readJson(userFile('app-presets.json'), {})
  const key = String(id || '')
  const row = all[key]
  if (!row) return { success: true, data: null }
  return { success: true, data: Object.assign({}, row, { settings: unsealSettings(row.settings) }) }
})
ipcMain.handle('app:savePreset', (event, payload) => {
  if (!isMainSender(event)) return rejectUntrustedSender()
  const id = String((payload && payload.platformId) || '')
  if (!id) return { success: false }
  const all = readJson(userFile('app-presets.json'), {})
  all[id] = { name: (payload && payload.name) || '', settings: sealSettings((payload && payload.settings) || {}) }
  writeJson(userFile('app-presets.json'), all)
  return { success: true }
})

ipcMain.handle('app:tabs', () => tabPayload())

function popupTabContextMenu(payload) {
  const id = String((payload && payload.id) || '')
  const home = !!(payload && payload.home)
  const tab = tabs.find(t => t.id === id)
  const wc = tab && tab.view && tab.view.webContents
  const sendCommand = command => {
    if (win && !win.isDestroyed()) win.webContents.send('context:command', command)
  }
  const restart = () => {
    app.relaunch()
    app.exit(0)
  }
  let template
  if (home || !tab || !wc || wc.isDestroyed()) {
    template = [
      { label: '个人中心', click: () => sendCommand('account') },
      { label: '检查软件更新', click: () => sendCommand('softwareUpdate') },
      { type: 'separator' },
      { label: '重启软件', click: restart }
    ]
  } else {
    const changeZoom = delta => {
      const current = Number(wc.getZoomFactor()) || 1
      wc.setZoomFactor(Number(Math.min(2, Math.max(0.5, current + delta)).toFixed(2)))
    }
    template = [
      { label: '放大页面', accelerator: 'CmdOrCtrl+Plus', click: () => changeZoom(0.1) },
      { label: '缩小页面', accelerator: 'CmdOrCtrl+-', click: () => changeZoom(-0.1) },
      { label: '还原缩放', accelerator: 'CmdOrCtrl+0', click: () => wc.setZoomFactor(1) },
      { type: 'separator' },
      { label: '刷新当前应用', accelerator: 'CmdOrCtrl+R', click: () => wc.reload() },
      { label: '检查应用更新', click: () => updatePlatformWeb(tab.platform) },
      {
        label: '清理当前应用缓存',
        click: async () => {
          try {
            await wc.session.clearCache()
            wc.reloadIgnoringCache()
          } catch (e) {}
        }
      },
      { type: 'separator' },
      { label: '个人中心', click: () => sendCommand('account') },
      { label: '关闭应用', click: () => closeTab(tab.id) }
    ]
  }
  Menu.buildFromTemplate(template).popup({ window: win })
  return { success: true }
}

ipcMain.handle('app:rename', (_event, payload) => {
  const id = String((payload && payload.id) || '')
  const next = String((payload && payload.name) || '').trim()
  const tab = tabs.find(t => t.id === id)
  if (!tab) return { success: false, msg: '应用不存在' }
  if (!next) return { success: false, msg: '名称不能为空' }
  tab.name = next
  tab.title = next
  const all = readJson(userFile('app-presets.json'), {})
  const prev = all[tab.platform] || {}
  all[tab.platform] = { name: next, settings: sealSettings(prev.settings || tab.settings || {}) }
  writeJson(userFile('app-presets.json'), all)
  sendTabs()
  saveOpenApps()
  return { success: true }
})
ipcMain.handle('app:open', (event, payload) => isMainSender(event) ? openPlatform(payload || {}) : rejectUntrustedSender())
ipcMain.handle('app:close', (_event, id) => closeTab(id))
ipcMain.handle('app:switch', (_event, id) => switchTab(id))
ipcMain.handle('app:showContextMenu', (_event, payload) => popupTabContextMenu(payload || {}))
ipcMain.handle('app:reloadActive', () => {
  const tab = tabs.find(t => t.id === activeId)
  const wc = tab && tab.view && tab.view.webContents
  if (!wc || wc.isDestroyed()) return { success: false, msg: '当前没有打开的应用' }
  wc.reload()
  return { success: true, msg: '已刷新当前应用' }
})
ipcMain.handle('app:clearActiveCache', async () => {
  const tab = tabs.find(t => t.id === activeId)
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
ipcMain.handle('app:contextAction', async (_event, payload) => {
  const id = String((payload && payload.id) || activeId || '')
  const action = String((payload && payload.action) || '')
  const tab = tabs.find(t => t.id === id)
  if (action === 'close') return closeTab(id)
  if (!tab || !tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) {
    return { success: false, msg: '应用不存在' }
  }
  const wc = tab.view.webContents
  const history = wc.navigationHistory
  try {
    if (action === 'back') {
      const allowed = history && typeof history.canGoBack === 'function'
        ? history.canGoBack()
        : typeof wc.canGoBack === 'function' && wc.canGoBack()
      if (!allowed) return { success: false, msg: '没有上一页' }
      if (history && typeof history.goBack === 'function') history.goBack()
      else wc.goBack()
      return { success: true }
    }
    if (action === 'forward') {
      const allowed = history && typeof history.canGoForward === 'function'
        ? history.canGoForward()
        : typeof wc.canGoForward === 'function' && wc.canGoForward()
      if (!allowed) return { success: false, msg: '没有下一页' }
      if (history && typeof history.goForward === 'function') history.goForward()
      else wc.goForward()
      return { success: true }
    }
    if (action === 'reload') {
      wc.reload()
      return { success: true }
    }
    if (action === 'zoomIn' || action === 'zoomOut' || action === 'zoomReset') {
      const current = Number(wc.getZoomFactor()) || 1
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
ipcMain.handle('app:restart', () => {
  setTimeout(() => {
    app.relaunch()
    app.exit(0)
  }, 120)
  return { success: true }
})
ipcMain.handle('app:updateSettings', (_event, payload) => updateTabSettings((payload && payload.id) || '', (payload && payload.settings) || {}))
ipcMain.handle('app:home', () => goHome())
ipcMain.handle('app:version', () => APP_VERSION)
ipcMain.handle('app:checkUpdate', async () => {
  const local = APP_VERSION
  try {
    const data = await api('/client/update?os=' + process.platform + '&arch=' + process.arch)
    const remote = String((data && (data.version || (data.obj && data.obj.version))) || '')
    const candidate = String((data && (data.url || (data.obj && data.obj.url))) || '')
    const url = isAllowedExternalUrl(candidate, DOWNLOAD_HOSTS) ? candidate : ''
    return { success: true, local: local, remote: remote, url: url }
  } catch (e) {
    return { success: false, local: local, msg: e.message || '无法检查更新' }
  }
})
ipcMain.handle('translate:engines', async () => {
  try {
    return await api('/translate/engines')
  } catch (e) {
    return { success: false, rows: [] }
  }
})
ipcMain.handle('translate:savePrefs', async (_event, payload) => {
  try {
    const data = await api('/client/translate-prefs', { method: 'POST', form: payload || {} })
    if (profile && payload) {
      if (payload.transRecv !== undefined) profile.transRecv = Number(payload.transRecv) ? 1 : 0
      if (payload.transSend !== undefined) profile.transSend = Number(payload.transSend) ? 1 : 0
      if (payload.transGroup !== undefined) profile.transGroup = Number(payload.transGroup) ? 1 : 0
      if (payload.langMine) profile.langMine = payload.langMine
      if (payload.langOther) profile.langOther = payload.langOther
      if (payload.includeZh !== undefined) profile.includeZh = Number(payload.includeZh) ? 1 : 0
      if (payload.engine) profile.activeEngine = payload.engine
      pushGuestPrefs()
    }
    return data
  } catch (e) {
    return { success: false, msg: e.message || '保存失败' }
  }
})
ipcMain.handle('translate:guestPrefs', event => {
  const tab = trustedTabSender(event.sender)
  return tab ? tabPrefs(tab) : rejectUntrustedSender()
})
ipcMain.handle('translate:run', async (event, payload) => {
  const tab = trustedTabSender(event.sender)
  if (!tab) return rejectUntrustedSender()
  const p = payload || {}
  const raw = String(p.text || '').trim()
  if (raw.length > 5000) return { success: false, msg: '单次翻译最多 5000 个字符' }
  const text = stripEmoji(raw)
  if (!text) return { success: true, translation: '', skipped: 'emoji' }
  const s = (tab && tab.settings) || {}
  const incoming = !!p.incoming
  const to = incoming
    ? pickLang(s.recvTo, (profile && profile.langMine) || 'zh')
    : pickLang(s.sendTo, 'en')
  const from = incoming ? (s.recvFrom || 'auto') : (s.sendFrom || 'auto')
  const engine = s.engine || (profile && profile.activeEngine) || ''
  const hit = getTransCached(from, to, engine, text)
  if (hit) return { success: true, translation: hit, cached: true }
  try {
    const data = await api('/translate/run', { method: 'POST', form: { text: text, from: from, to: to, engine: engine, requestId: transRequestId(text, from, to, engine) } })
    const out = String((data && (data.translation || data.text)) || '').trim()
    if (data && data.success && out) {
      putTransCached(from, to, engine, text, out)
      if (out !== text) putTransCached('auto', from === 'auto' ? 'zh' : from, engine, out, text)
    }
    return data
  } catch (e) {
    return { success: false, msg: e.message || '翻译失败' }
  }
})
ipcMain.handle('app:overlay', (event, on) => {
  if (!isMainSender(event)) return rejectUntrustedSender()
  overlayOpen = !!on
  layoutViews()
  return { success: true }
})

app.whenReady().then(() => {
  applyAppIdentity()
  try { fs.rmSync(userFile('translate-cache.json'), { force: true }) } catch (e) {}
  loadConfig()
  createWindow()
})

app.on('before-quit', () => {
  saveOpenApps()
})

app.on('window-all-closed', () => {
  app.quit()
})
