const electron = require('electron')
if (!electron || !electron.app || !electron.ipcMain) {
  console.error('请在 desktop 目录执行 npx electron . ，不要用 node 直接跑 main.js')
  process.exit(1)
}
const { app, BrowserWindow, WebContentsView, session, ipcMain, shell, safeStorage, nativeImage, net, Menu, Tray } = electron
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { spawn } = require('child_process')
const fallbackPlatforms = require('./platforms')
const builtinLines = require('./lines')
const proxyPresets = require('./proxy-presets')
const proxyIsolation = require('./proxy-isolation')
const { stripProxyFields } = proxyIsolation
// 代理的构建与应用抽到独立模块：产品、单元测试、机制测试共用**同一份实现**。
// 这几个函数原先内联在 main.js 里，而 main.js 一 require 就会加载 electron，
// 普通 Node 加载不了 —— 于是最需要回归保护的代理逻辑一个测试都没有。
const proxySettings = require('./proxy-settings')
const {
  sanitizeProxyPart,
  parseProxyHostLine,
  proxyRulesOf,
  proxyTargetOf,
  proxyAuthOf,
  proxySettingsOf,
  proxyFieldsChanged,
  applyTabProxy
} = proxySettings
// 带认证的 SOCKS5 只能走本地中继（Chromium 不会为 SOCKS5 触发 login 事件，
// 详见 socks-relay.js 顶部注释）。它是纯 Node 模块，产品与测试共用同一份。
const { createSocksRelay } = require('./socks-relay')
// 读远程页面文本走隔离世界（不是 page world）—— 见 probe-page.js 顶部注释。
const { readPageText } = require('./probe-page')
const instanceSlot = require('./instance-slot')
const backgroundMode = require('./background-mode')
const {
  csvHosts,
  trustedApiHosts,
  validateApiUrl,
  isAllowedPlatformUrl,
  isAllowedExternalUrl
} = require('./security-policy')
const logFile = require('./log-file')
// 翻译桥警告条：preload 死了以后，唯一还能把警告画到用户眼前的手段
// （隔离世界注入，见该文件顶部注释）。
const bridgeWarning = require('./bridge-warning')

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
      // 之前这里写死 '0.1.0'，从 0.1.1 起就再没对过 ——
      // 用户看"关于"报给我们的版本号是错的，排查时反而被误导。
      applicationVersion: app.getVersion(),
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

/* ---------------------------------------------------------------- 日志落盘 */

// 见 desktop/log-file.js 与 test/desktop-log-file.test.js。
// 这里只负责"何时建、装哪些钩子、放在哪个目录"。
let clientLog = null

/**
 * 启动客户端日志落盘。
 *
 * **必须放在 applyAppIdentity() 之后调用**：那一步会 app.setName('Hello Pix')，
 * 而 userData 目录是由 app name 推导出来的 —— 提前算会算到另一个目录去，
 * 日志就和分区数据、配置分家，用户卸载时残留、我们找日志时找错地方。
 *
 * 之前客户端一条日志都不写：主进程抛异常、渲染进程被杀、翻译静默失败
 * 全都没有痕迹，排查只能靠用户截图。这里做四件事：
 *   1. 把已有的 console.* 输出接进日志文件（不必逐条改写调用点）
 *   2. 挂上未捕获异常 / 未处理拒绝的钩子
 *   3. 记录渲染进程崩溃与报错
 *   4. 在「系统操作」菜单里给出「打开日志目录」，方便用户把日志发回来
 */
function initClientLog() {
  let dir
  try {
    dir = path.join(app.getPath('userData'), 'logs')
  } catch (e) {
    try {
      dir = path.join(app.getPath('temp'), 'hello-pix-logs')
    } catch (e2) {
      return null
    }
  }
  const log = logFile.createLogger(dir, {
    // 刻意走 stderr 而不是 console.error：console 已被下面桥接到本 logger，
    // 用它上报"日志写入失败"会和自身形成回环。
    onError: error => {
      try {
        process.stderr.write('[hello-pix] 日志写入失败：' + (error && error.message) + '\n')
      } catch (e) {}
    }
  })
  logFile.installConsoleBridge(console, log)
  logFile.attachProcessHandlers(process, log, {
    flush: () => log.flush(),
    exit: code => app.exit(code)
  })
  clientLog = log
  return log
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

/**
 * 本进程独占的多开槽位。
 *
 * 启动时分配一次，之后所有分区命名都用它。**必须在创建任何 webview 之前拿到**，
 * 否则会退回"每个进程各自从 1 数"的老问题 —— 两个实例撞同一个分区。
 */
let instanceSlotHandle = null

function instanceSlotDir() {
  return path.join(app.getPath('userData'), 'instances')
}

function acquireInstanceSlot() {
  if (instanceSlotHandle) return instanceSlotHandle
  try {
    instanceSlotHandle = instanceSlot.acquireSlot(instanceSlotDir())
  } catch (e) {
    // 抢锁失败不能拦住客户端启动 —— 退化成一次性随机槽位，
    // 隔离性仍然成立（只是这次的分区是全新的）。
    instanceSlotHandle = { slot: 'x' + crypto.randomBytes(3).toString('hex'), file: null }
  }
  return instanceSlotHandle
}

function currentSlot() {
  return instanceSlotHandle ? instanceSlotHandle.slot : 1
}

/**
 * 分区名。
 *
 * 槽位 1 **不加任何中缀**，与历史命名完全一致 —— 单实例用户升级后
 * 不会丢 Telegram / WhatsApp 登录态。槽位 2+ 才带 `s<N>-`：
 *
 *   槽位 1 → persist:pix-alice-telegram-z-1
 *   槽位 2 → persist:pix-alice-s2-telegram-z-1
 */
function makePartition(platformId, index) {
  return 'persist:pix-' + accountSlug() + '-' + instanceSlot.slotInfix(currentSlot())
    + platformId + '-' + index
}

/**
 * 本实例从磁盘恢复出来、现由它管理的实例 id。
 *
 * ## 为什么需要它 —— 「我刚设的自动又变回手动了」
 *
 * `open-apps.json` 是按 **Pix 账号** 存的（`byUser[用户名]`），而 `auth.json`
 * 在 userData 顶层、**不按多开槽位隔离** —— 同一个账号开两个副本时，
 * 两边各有一份 `tabs` 内存态。老实现是整段覆盖：
 *
 *     all.byUser[user] = { ..., tabs: tabs.map(...) }   // 只用我的内存
 *
 * 于是副本 B 只要触发一次保存（切个 tab、改个别的设置），就会用它内存里的
 * **旧** `tabs` 把副本 A 刚改好的设置整段写回去。真机表现就是
 * "设置保存了却没生效"，而且**没有任何报错**。
 *
 * ## 合并口径
 *
 *   · 内存里的 tab                → 写入 / 更新
 *   · 恢复过、但现在不在内存里      → 删掉（这个副本确实关了它）
 *   · 磁盘上、本实例从没见过        → **原样保留**（属于另一个副本）
 *
 * 只在**确实创建出 tab** 之后才登记：`restoreOneApp()` 可能因为平台下线、
 * homeUrl 非法等原因提前 return，那种 id 不能算"本实例管理"，否则会在保存时
 * 把它从磁盘上删掉 —— 那是数据丢失，比覆盖更糟。
 */
const seededTabIds = new Set()

function saveOpenApps() {
  const user = currentPixUser()
  if (!user) return
  const all = readJson(openAppsFile(), {})
  if (!all.byUser || typeof all.byUser !== 'object') all.byUser = {}
  const previous = all.byUser[user] || {}
  const previousTabs = Array.isArray(previous.tabs) ? previous.tabs : []

  const live = new Map()
  tabs.forEach(t => {
    live.set(String(t.id), {
      id: t.id,
      platform: t.platform,
      name: t.name,
      title: t.title,
      index: t.index,
      icon: t.icon,
      partition: t.partition,
      url: t.url || '',
      settings: sealSettings(t.settings)
    })
  })

  const merged = previousTabs.filter(row => {
    const id = String((row && row.id) || '')
    // 本实例没见过的（属于别的副本）原样保留；本实例已知但已关闭的丢掉。
    return id && !seededTabIds.has(id) && !live.has(id)
  })
  for (const row of live.values()) merged.push(row)

  // nextTab / usedCount 取**单调**合并：两个副本各自自增，直接覆盖会让
  // 后写的那个把计数器倒退回去，进而生成重复的 tab id 与分区名。
  const mergedUsed = Object.assign({}, previous.usedCount || {})
  Object.keys(usedCount || {}).forEach(key => {
    mergedUsed[key] = Math.max(Number(mergedUsed[key]) || 0, Number(usedCount[key]) || 0)
  })

  all.byUser[user] = {
    nextTab: Math.max(nextTab, Number(previous.nextTab) || 0),
    usedCount: mergedUsed,
    activeId: activeId,
    showHome: showHome,
    tabs: merged
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
  const view = createWebView(partition, settings, item, homeUrl,
    { platform: item.id, account: accountSlug(), id: row.id || '' })
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
  // 只有**真的建出 tab** 的才算本实例管理（见 seededTabIds 的说明）。
  tabs.forEach(t => seededTabIds.add(String(t.id)))
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

/**
 * 窗口尺寸边界 —— **单一来源**。
 *
 * 这些值原先在两处各写了一遍（restoreWindowBounds 的夹取、createWindow 的构造），
 * 改一处漏一处就会出现"存档能到 900，但拖拽被卡在 1160"这种自相矛盾的行为。
 *
 * ## 最小值是怎么定出来的
 *
 * 不是拍脑袋，是用 CDP 在真实渲染层上逐档量出来的（见下方注释）。
 *
 * ### 宽度 900
 *
 * 页脚是 `grid-template-columns: minmax(max-content,1fr) auto minmax(max-content,1fr)`，
 * 两侧轨道的可用宽度取决于中间"版本块"的宽度，光读 CSS 算不准。
 * 实测（真机 DOM）：
 *
 *   900px  页脚 900 = 左组 261 + 版本块 103 + 右组 508   溢出 0   ✓
 *   890px  溢出 0   ✓
 *   885px  溢出 4px  ← 临界点在这
 *   860px  溢出 29px，右组越出视口
 *
 * 取 900 留出约 12px 余量。窄于此，页脚右组（下载入口）会被 `overflow:hidden` 裁掉。
 *
 * 原先的 1160 是根据"竞品最小宽 ≈1150（4 列 ×(70 标签 + 215 控件)）"推出来的，
 * 但渲染层其实**早就有响应式断点**（1100px 降 3 列、860px 降 2 列、1080px 压缩页脚），
 * 1160 把这些断点全挡在外面，一个都触发不到 ——
 * 用户在小屏上只能忍受一个占掉半屏还多的窗口。
 *
 * ### 高度 560
 *
 * 顶部 chrome 固定 112px（标签栏 + 翻译条）、页脚 30px，所以
 * 网页可视高度 = 窗口高 − 142：
 *
 *   680 → 538px    560 → 418px    500 → 358px
 *
 * 取 560（网页区 418px）—— 聊天窗口在这个高度仍然可读，
 * 再矮就会让 Telegram / WhatsApp 的消息区显得局促。
 */
const WINDOW_MIN_WIDTH = 900
const WINDOW_MIN_HEIGHT = 560
/** 上限。不是"屏幕没那么大"，而是防存档被写坏成一个荒唐的值。 */
const WINDOW_MAX_WIDTH = 3200
const WINDOW_MAX_HEIGHT = 2000

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
    width: Math.min(Math.max(width, WINDOW_MIN_WIDTH), WINDOW_MAX_WIDTH),
    height: Math.min(Math.max(height, WINDOW_MIN_HEIGHT), WINDOW_MAX_HEIGHT)
  }
}

function saveConfig() {
  writeJson(userFile('config.json'), {
    apiBase: apiBase,
    theme: theme,
    backgroundRunning: backgroundRunning,
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
  // 缺省为 true（后台运行）。只有显式存了 false 才关掉 ——
  // 用 `!== false` 而不是 `=== true`，是为了让老版本升级上来的用户
  // （config.json 里压根没这个键）直接获得新行为，而不是被动保持旧的。
  backgroundRunning = cfg.backgroundRunning !== false
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

/**
 * 群组翻译的**三态**。同一个概念有两个开关，必须说清谁说了算：
 *
 *   · 账号级「群聊自动翻译」—— 服务端 `users / sub_accounts.trans_group`，
 *     在「全局设置」里，登录后随 profile 下发；
 *   · 实例级「群组翻译」—— 顶部翻译栏那个下拉，存在 `tab.settings.groupMode`。
 *
 * 老实现只有两态（`auto` / `manual`），且让实例级**无条件覆盖**账号级
 * （`hasTab ? s.groupMode === 'auto' : g.transGroup`），而新建实例又被硬编码成
 * `manual` —— 于是"账号里/界面上开了自动、这个实例却永远不自动"，且毫无提示。
 * 真机上就表现为「群组翻译 = 自动，消息却一直不翻」，很容易被误判成
 * "自动翻译坏了"。
 *
 *   'inherit'  跟随账号级（**新建实例的默认**）
 *   'auto'     本实例强制自动
 *   'manual'   本实例强制手动
 *
 * ⚠️ **存量实例一律按 `manual` 处理（字段缺失也当 `manual`）**，绝不自动改成
 * `inherit`：账号级 `trans_group` 的库默认是 `true`（migration 003），
 * 把"没有显式选择"解释成"跟随账号"就等于给所有存量实例**打开自动扣费**。
 * 拿别人的钱做默认值是不可接受的 —— 所以只有**新建**实例才拿到 `inherit`。
 */
const GROUP_MODES = ['inherit', 'auto', 'manual']

function groupModeOf(settings) {
  const mode = settings && settings.groupMode
  return GROUP_MODES.indexOf(mode) >= 0 ? mode : 'manual'
}

/** 实例级 + 账号级 → 这个实例最终要不要自动翻群聊。 */
function resolveGroupEnabled(settings, accountPrefs) {
  const mode = groupModeOf(settings)
  if (mode === 'auto') return true
  if (mode === 'manual') return false
  // 'inherit'：交给账号级。账号级也拿不到就按"不自动"，宁可不翻也不误扣。
  return !!(accountPrefs && accountPrefs.transGroup)
}

function normalizeTabSettings(settings) {
  const s = Object.assign({}, settings || {})
  if (s.showTransBar === undefined) s.showTransBar = true
  if (s.enableSendTranslate === undefined) s.enableSendTranslate = s.enableTranslate !== false
  if (s.enableRecvTranslate === undefined) s.enableRecvTranslate = s.enableTranslate !== false
  s.groupMode = groupModeOf(s)
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
    groupMode: groupModeOf(s),
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
      // 翻译桥没起来 = 这个窗口的翻译整体失效。侧边栏必须打标记，
      // 不能让它看起来和正常窗口一样（0.1.12 就是这样静默坑人的）。
      bridgeDown: bridgeHealth.get(t.id) ? bridgeHealth.get(t.id).ok === false : false,
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
    // 原来的 `name.indexOf('pix-' + id + '-') === 0` 假设目录名以平台开头，
    // 而实际是 `pix-<用户名>-<平台>-<序号>` —— 前缀永远对不上，这个函数
    // 一直返回 false，"该平台有缓存"的判断从来没生效过。
    return fs.readdirSync(dir).some(name => instanceSlot.partitionBelongsTo(name, id))
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
      // 同样不能用前缀匹配：用户名在平台前面，且槽位 2+ 还会多一段 s2-。
      if (instanceSlot.partitionBelongsTo(name, id)) seen.add(session.fromPartition('persist:' + name))
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
  if (tab.bridgeTimer) {
    clearTimeout(tab.bridgeTimer)
    tab.bridgeTimer = null
  }
  bridgeHealth.delete(tab.id)
  stopSshTunnel(tab)
  releaseSocksRelay(tab)
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
    transGroup: hasTab ? resolveGroupEnabled(s, g) : g.transGroup,
    langMine: pickLang(s.recvTo, g.langMine || 'zh'),
    langOther: s.recvFrom || g.langOther || 'auto',
    sendFrom: s.sendFrom || 'auto',
    sendTo: pickLang(s.sendTo, 'en'),
    includeZh: s.includeZh !== undefined
      ? !!(s.includeZh && s.includeZh !== '0' && s.includeZh !== false)
      : g.includeZh,
    fontSize: Number(s.fontSize) || 15,
    fontColor: s.fontColor || '#22c55e',
    antiRevoke: !!s.antiRevoke,
    // 取证用：真机 trace 必须能回答"哪个窗口、哪个 partition、哪条通道"。
    // 少了这三项，一条 MANUAL_TRANSLATE_CLICK 没法定位到具体实例。
    tabId: (tab && tab.id) || '',
    partition: (tab && tab.partition) || '',
    engine: s.engine || g.engine || ''
  }
}

/**
 * 只 reload 目标线路自己的 webContents。
 *
 * 为什么必须 reload：`setProxy` 只影响**之后新建的连接**，已经建立的
 * socket 会继续走旧代理。不 reload 的话用户会看到"保存成功但出口没变"，
 * 正是本次要修的用户可感知症状。
 * 只碰这一条线路的 webContents，其他 partition 完全不受影响。
 */
function reloadTabContents(tab) {
  const wc = tab && tab.view && tab.view.webContents
  if (!wc || wc.isDestroyed()) return
  try { wc.reload() } catch (e) {}
}

async function updateTabSettings(id, patch) {
  const tab = tabs.find(t => t.id === String(id || ''))
  if (!tab) return { success: false, msg: '应用不存在' }
  // 先留一份改动前的快照：下面要拿它和改完的结果比，判断"这次有没有动代理"。
  const before = tab.settings || {}
  tab.settings = normalizeTabSettings(Object.assign({}, before, patch || {}))
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

  // ── 代理即时生效 ──────────────────────────────────────────────
  // 被修的缺陷：这个方法以前**只保存 settings**，从不把代理写进 session。
  // applySessionProxy 全项目只有 startTabLoad 一个调用点，于是"改一条已存在
  // 线路的代理"永远不生效，必须关掉线路重建才行。
  // 修法：复用同一个 applyTabProxy（不另写一套），并只 reload 这条线路。
  const proxyChanged = proxyFieldsChanged(before, tab.settings)
  if (proxyChanged) {
    await applyTabProxy(tab, tabProxyDeps())
    reloadTabContents(tab)
  }
  return { success: true, proxyChanged: proxyChanged }
}

/**
 * 发送中占位符。
 *
 * 这些字符串是客户端**自己的状态**，不是用户内容。它们必须留在输入框里、
 * 绝不能被送到翻译接口，更不能被当成用户消息发出去 —— 线上真的发出去过
 * 「哈喽你好[正在翻译中...]」。渲染进程已经有一道闸，这里是不信任渲染进程的
 * 第二道：主进程这一层再拦一次，留一个和渲染层无关的兜底。
 */
const CLIENT_BUSY_MARKS = ['[正在翻译中...]', '|翻译中...', '[翻译中...]', '翻译中...']

function stripBusyMarks(text) {
  let s = String(text == null ? '' : text)
  for (const mark of CLIENT_BUSY_MARKS) s = s.split(mark).join('')
  return s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
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
/**
 * 翻译请求的幂等键（Idempotency-Key）。
 *
 * ## 为什么要按**账号**入键
 *
 * 服务端把「账号 + 通道 + 语向 + 正文」一起算成 `requestHash` 来判定"这是不是同
 * 一次翻译"（`requestDigest`，含 `subAccountId`）。而客户端原来的指纹里**没有账号**
 * —— 同一台机器上先用主账号、再切子账号翻同一句话，会拿同一个 key 打过去，
 * 服务端看到 `requestHash` 变了，回 `409 IDEMPOTENCY_KEY_REUSED`。
 * 这条文本就**永久翻不出来**，且和用户操作毫无关系。
 *
 * ## 为什么需要"重试换代"
 *
 * 服务端一旦为某个 key 建过预留，这个 key 就**用死了**：预留被退款 / 超时 / 终结
 * 之后，同 key 再发一律 `409 REQUEST_FINALIZED`（"该请求已结束，不能重试"）。
 * 而旧实现的内容指纹是**纯函数**，同一个 key 会被无限复用 —— 只要失败过一次
 * （厂商 5xx、网络抖动），这条文本以后永远只能拿到 409。
 *
 * 但也不能简单地"每次尝试都换新号"：那样服务端就失去了按内容去重的能力，
 * 一次"服务端已成功、客户端读丢响应"的网络抖动会让用户**被扣两次费**。
 *
 * 所以最终口径是：
 *   · 键 = 账号 + 内容指纹 + **尝试代数**；
 *   · 代数**只在**服务端明确回"这个号已经用死了"时才 +1（见 DEAD_REQUEST_CODES），
 *     其余失败（余额不足 / 通道未接通 / 网络错误）保持原号；
 *   · 于是"服务端已成功但响应读丢"这种最危险的情况仍然命中同一个号，
 *     服务端直接返回已存的译文，**不会重复扣费**。
 */
const transAttempt = new Map()
// 指纹 → 代数的表无限增长会漏内存；翻译是热路径，元素很小，给个上限整体清空即可
// （清空只会让少数几条文本退回第 0 代，不会算错账）。
const TRANS_ATTEMPT_MAX = 4096

/**
 * 服务端明确表示"这个 Idempotency-Key 已经用死了，换一个再来"的错误码。
 *
 * 前三个是"预留已终结/已过期/被别的请求体占用"；最后一个
 * `ENGINE_SWITCH_REQUIRES_NEW_REQUEST` 是服务端**故意**要求客户端换号重发的
 * （换通道重译要重新计费），必须一起换，否则换通道后这条文本也翻不出来。
 */
const DEAD_REQUEST_CODES = [
  'REQUEST_FINALIZED',
  'RESERVATION_EXPIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'ENGINE_SWITCH_REQUIRES_NEW_REQUEST'
]

function transFingerprint(text, from, to, engine) {
  return crypto.createHash('sha256')
    .update([currentPixUser(), String(engine || ''), String(from || ''), String(to || ''), String(text || '')]
      .join('\u0001'))
    .digest('hex')
    .slice(0, 40)
}

function transRequestId(text, from, to, engine) {
  const fingerprint = transFingerprint(text, from, to, engine)
  const generation = transAttempt.get(fingerprint) || 0
  return `desktop:${deviceId()}:${fingerprint}:${generation}`
}

/** 换一代：让下一次重试拿到全新的 Idempotency-Key。 */
function bumpTransAttempt(text, from, to, engine) {
  const fingerprint = transFingerprint(text, from, to, engine)
  if (transAttempt.size > TRANS_ATTEMPT_MAX) transAttempt.clear()
  transAttempt.set(fingerprint, (transAttempt.get(fingerprint) || 0) + 1)
}

function isDeadRequest(data) {
  return !!(data && data.success === false && DEAD_REQUEST_CODES.indexOf(String(data.code || '')) >= 0)
}

/**
 * 发一次 /translate/run；命中"号用死了"就**原地换号重发一次**。
 *
 * 为什么要在原地重发、而不是把错误抛给用户让他手动再点一次：
 * 这类失败与"翻译服务坏了"完全无关（上一轮的预留被退款而已），
 * 把它显示成"翻译失败，请稍后重试"是在骗用户 —— 重试永远还是同一个号。
 * 只重发**一次**：连换两个号都不行，说明不是号的问题，那就如实上报。
 */
async function requestTranslate(text, from, to, engine, trigger) {
  const body = () => ({
    text: text, from: from, to: to, engine: engine, trigger: trigger,
    requestId: transRequestId(text, from, to, engine)
  })
  let data = await api('/translate/run', { method: 'POST', form: body() })
  if (!isDeadRequest(data)) return data
  // 换号重发一次。注意 `body()` 是在**换号之后**才求值的，
  // 否则 requestId 还是旧的，重发等于白发一次。
  bumpTransAttempt(text, from, to, engine)
  data = await api('/translate/run', { method: 'POST', form: body() })
  // 连换两个号都还是"号用死了"：说明不是号的问题，下一轮别再无谓地原地打转。
  if (isDeadRequest(data)) bumpTransAttempt(text, from, to, engine)
  return data
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

// ---------------------------------------------------------------------------
// 翻译桥健康看门狗 —— preload 装载失败必须"留痕 + 让用户看见"
// ---------------------------------------------------------------------------
// 0.1.12 那次 P0 能把客户坑到底，是因为 preload（guest-inject.js）在**装载阶段**
// 抛错之后一点痕迹都没有：keydown / click / 扫描监听器全都没挂上，但界面照常可用。
// 用户按回车，中文原文直通 WhatsApp；客户端日志里连一行都没有，事后只能靠复述。
//
// 这里补两张网：
//   ① 立即网：`preload-error` / guest 控制台报错 → 写进客户端日志
//   ② 兜底网：装载后 N 秒内没等到 guest 的第一次 prefs 询问 → 判定桥未启动，
//      写 error 并通知渲染层显示常驻警告条。
//
// 判"活"的依据是 guest 主动调用 `translate:guestPrefs` —— 那一步只有 preload
// 真的执行到了才会发生，比任何字符串特征都可靠。
const BRIDGE_PROBE_MS = 8000
const bridgeHealth = new Map() // tabId -> { ok: boolean, reason: string }

function bridgeReport(tabId, ok, reason) {
  if (!tabId) return
  const prev = bridgeHealth.get(tabId)
  if (prev && prev.ok === ok && prev.reason === (reason || '')) return
  bridgeHealth.set(tabId, { ok: !!ok, reason: reason || '' })
  const tab = tabs.find(t => t.id === tabId)
  const name = (tab && tab.name) || tabId
  if (clientLog) {
    if (ok) clientLog.info('preload', '实例 ' + tabId + ' 翻译桥已就绪')
    else {
      clientLog.error('preload', '实例 ' + tabId + '（' + name + '）的翻译桥**未启动**：' +
        (reason || '原因未知') + ' —— 发送翻译与接收翻译都不会生效，' +
        '用户输入不会被拦截，按回车就会把原文直接发出去')
    }
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('translate:bridgeDown', { id: tabId, name: name, ok: !!ok, reason: reason || '' })
    sendTabs()
  }
  if (!ok && tab) showGuestBridgeWarning(tab, reason)
}

/**
 * 在 guest 页面里画出警告条（走隔离世界，见 desktop/bridge-warning.js）。
 *
 * 为什么不能只靠渲染层弹提示：主界面是用 WebContentsView **盖**在窗口上的原生
 * 视图，渲染层 DOM 会被它挡住。而这次 preload 已经死了，也不能靠它注入。
 * 警告必须出现在**用户正在打字的那个位置**，否则等于没提示。
 */
function showGuestBridgeWarning(tab, reason) {
  const wc = tab && tab.view && tab.view.webContents
  if (!wc || wc.isDestroyed()) return
  const job = bridgeWarning.showBridgeWarning(wc, { name: tab.name, reason: reason })
  if (job && typeof job.catch === 'function') job.catch(() => {})
}

/**
 * 装载后守一段时间：guest 如果活着，`translate:guestPrefs` 会在这之前到达。
 * 到点还没到 → 桥没起来。定时器 unref，不阻止进程退出。
 */
function watchdogBridge(tab) {
  if (!tab || !tab.id) return
  // 装载期就已经报错了：立刻上报，不用等满 8 秒。
  const wc = tab.view && tab.view.webContents
  if (wc && wc.__pixPreloadError) {
    bridgeReport(tab.id, false, wc.__pixPreloadError)
    return
  }
  tab.bridgeTimer = setTimeout(() => {
    tab.bridgeTimer = null
    const st = bridgeHealth.get(tab.id)
    if (st && st.ok === true) return
    if (!tabs.includes(tab)) return
    bridgeReport(tab.id, false, '预加载脚本装载后 ' + Math.round(BRIDGE_PROBE_MS / 1000) + ' 秒内没有与主进程通信（很可能装载就报错了）')
  }, BRIDGE_PROBE_MS)
  if (tab.bridgeTimer.unref) tab.bridgeTimer.unref()
}

// 代理规则的构建（proxyPresetOf / sanitizeProxyPart / parseProxyHostLine /
// proxyRulesOf）已移到 ./proxy-settings.js，这里通过上方解构引用同一份实现。
// 不要在本文件里重新实现一套 —— 两份实现必然漂移，而这份逻辑是本次缺陷的中心。

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

// ── 带认证 SOCKS5 的本地中继生命周期 ──────────────────────────────────
// 一条线路一个中继实例、一个随机端口，绝不复用给第二条线路（复用即串凭据）。
// key 覆盖 host/port/账密：任何一项变了都重建，避免"改了密码还在用旧隧道"。
const socksRelays = new Map()   // tab.id -> { relay, key, endpoint }

function relayKeyOf(target) {
  return [target.host, target.port, target.user, target.pass].join('\u0001')
}

async function releaseSocksRelay(tab) {
  if (!tab) return
  const cur = socksRelays.get(tab.id)
  if (!cur) return
  socksRelays.delete(tab.id)
  try { await cur.relay.close() } catch (e) {}
}

async function ensureSocksRelay(tab, target) {
  const key = relayKeyOf(target)
  const cur = socksRelays.get(tab.id)
  if (cur && cur.key === key) return { endpoint: cur.endpoint }
  await releaseSocksRelay(tab)
  const relay = createSocksRelay({
    host: target.host,
    port: target.port,
    user: target.user,
    pass: target.pass,
    onError: () => {}
  })
  const info = await relay.start()
  const endpoint = '127.0.0.1:' + info.port
  socksRelays.set(tab.id, { relay: relay, key: key, endpoint: endpoint })
  return { endpoint: endpoint }
}

// applyTabProxy 的依赖集合。新建 / 重启恢复 / 改代理三条路径共用，避免只在一处接线。
function tabProxyDeps() {
  return {
    restartSshTunnel: startSshTunnel,
    ensureSocksRelay: ensureSocksRelay,
    releaseSocksRelay: releaseSocksRelay
  }
}

// ── 代理认证凭据的投递 ──────────────────────────────────────────────
// HTTP/HTTPS 代理的 Basic 认证由 Chromium 触发 app.on('login') 问我们要账密。
// 凭据**只按触发挑战的那个 webContents** 查（= 那条线路的 partition），
// 因此线路 A 的账密不可能被线路 B 用上。
// 探测节点（detectProxyNode）没有线路，走这张临时表。
const proxyAuthByWebContents = new Map()   // webContents.id -> { host, port, user, pass }

function tabOfWebContents(wc) {
  if (!wc) return null
  return tabs.find(t => t.view && t.view.webContents === wc) || null
}

app.on('login', (event, webContents, details, authInfo, callback) => {
  // 只接管**代理**认证。网站自己的 HTTP Basic Auth（isProxy !== true）一律放行，
  // 否则会拿代理账密去回答站点登录框 —— 那是凭据泄漏，比连不上严重得多。
  if (!authInfo || authInfo.isProxy !== true) return
  const pending = webContents ? proxyAuthByWebContents.get(webContents.id) : null
  const tab = tabOfWebContents(webContents)
  const creds = pending || (tab ? proxyAuthOf(tab.settings) : null)
  if (!creds || !creds.user) return
  event.preventDefault()
  callback(creds.user, creds.pass)
})

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

// 探测节点用的一次性隐藏窗口：需要真实的 webContents 才能拿到 login 事件
// 交回代理账密（`net.request` 发出的请求没有 webContents，代理认证拿不到凭据）。
const probeWindows = new Set()
const PROBE_TIMEOUT_MS = 15000

function probeTextWithProxy(ses, url, creds) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const win = new BrowserWindow({
      show: false,
      width: 380,
      height: 260,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    })
    probeWindows.add(win)
    const wc = win.webContents
    // 只登记到这一个 webContents 上，探测结束即删 —— 不会污染任何线路的凭据查找。
    if (creds && creds.user) proxyAuthByWebContents.set(wc.id, creds)

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      timer = null
      try { proxyAuthByWebContents.delete(wc.id) } catch (e) {}
      probeWindows.delete(win)
      try { if (!wc.isDestroyed()) wc.destroy() } catch (e) {}
      try { if (!win.isDestroyed()) win.destroy() } catch (e) {}
    }
    const done = (fn, arg) => {
      if (settled) return
      settled = true
      cleanup()
      fn(arg)
    }

    timer = setTimeout(() => done(reject, new Error('连接超时')), PROBE_TIMEOUT_MS)
    wc.on('did-finish-load', () => {
      // 隔离世界读取，绝不在远程页面的 page world 里执行脚本（安全测试的硬要求）
      readPageText(wc)
        .then(text => done(resolve, String(text || '')))
        .catch(err => done(reject, err))
    })
    wc.on('did-fail-load', (_e, code, desc) => {
      if (code === -3) return   // ERR_ABORTED：重定向/被新导航取代，不是失败
      done(reject, new Error(desc || ('load error ' + code)))
    })
    try { wc.loadURL(url) } catch (e) { done(reject, e) }
  })
}

async function detectProxyNode(payload) {
  const settings = payload || {}
  const target = proxyTargetOf(settings)
  if (target.direct || !target.host) return { success: false, msg: '请先填写代理主机和端口' }
  const creds = proxyAuthOf(settings)
  const ses = session.fromPartition('temp:pix-proxy-detect')
  let relay = null
  try {
    // 带认证的 SOCKS5：临时起一个只服务本次探测的中继，规则里填回环地址。
    let relayEndpoint = ''
    if (target.scheme === 'socks5' && target.hasAuth) {
      relay = createSocksRelay({ host: target.host, port: target.port, user: target.user, pass: target.pass, onError: () => {} })
      const info = await relay.start()
      relayEndpoint = '127.0.0.1:' + info.port
    }
    const rules = proxyRulesOf(settings, { relayEndpoint: relayEndpoint })
    if (!rules) return { success: false, msg: '请先填写代理主机和端口' }
    try {
      await ses.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' })
    } catch (e) {
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
        const text = (await probeTextWithProxy(ses, urls[i], creds)).trim()
        const json = parseJsonSafe(text)
        ip = String((json && json.ip) || text).replace(/[^\w.:]/g, '')
        if (ip) break
      } catch (e) {
        lastErr = e && e.message ? e.message : '连接失败'
      }
    }
    if (!ip) {
      return { success: false, msg: lastErr ? ('节点连不上：' + lastErr) : '节点连不上，请检查主机、端口和账密' }
    }
    const geo = await lookupIpGeo(ip, settings.proxyChannel || 'dbip')
    geo.ip = geo.ip || ip
    const usedAt = noteProxyIp(ip)
    return {
      success: true,
      ip: ip,
      geo: geo,
      history: usedAt ? { at: usedAt } : null
    }
  } finally {
    try { await ses.clearStorageData() } catch (ignore) {}
    try { await ses.setProxy({ mode: 'direct' }) } catch (ignore) {}
    if (relay) { try { await relay.close() } catch (ignore) {} }
  }
}

// applySessionProxy 的实现已移到 ./proxy-settings.js。
// 这里不再保留第二份 —— 由 applyTabProxy 统一调度「ssh 隧道 → 写 session」。

function startTabLoad(tab) {
  if (!tab || !tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return
  // 新建线路 / 重启恢复走这里；修改已存在线路的代理走 updateTabSettings。
  // 两条路径都必须经过 applyTabProxy，否则又会退回"改了不生效"的老缺陷。
  applyTabProxy(tab, tabProxyDeps()).finally(() => {
    if (!tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return
    tab.view.webContents.loadURL(tab.url)
  })
}

function createWebView(partition, settings, item, homeUrl, tabInfo) {
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
  // preload 装载失败必须留痕：光靠控制台，线上看不到（0.1.12 就是这么漏出去的）。
  // 此刻 tab 可能还没进 tabs（按 id 找不到），所以先挂在 view 上，由
  // watchdogBridge() 按 tab 归属上报。
  view.webContents.on('preload-error', (_event, preloadPath, error) => {
    const file = path.basename(String(preloadPath || 'preload'))
    const reason = file + ' 装载失败：' + ((error && error.message) || String(error || '未知错误'))
    view.__pixPreloadError = reason
    if (clientLog) clientLog.error('preload', reason)
  })
  // guest 页面的报错也收进日志：拦截器内部的异常以前只进 webContents 控制台。
  if (clientLog) {
    view.webContents.on('console-message', (...args) => {
      let level, message, source, line
      if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        level = args[0].level; message = args[0].message; source = args[0].sourceId; line = args[0].lineNumber
      } else {
        level = args[1]; message = args[2]; line = args[3]; source = args[4]
      }
      const text = String(message == null ? '' : message)
      // ★ 发送状态机 trace 与发送结果日志**必须**无条件落盘。
      //   它们走的是 console.info（level 0/1），而下面那条过滤只放行 warning/error ——
      //   不特判的话，真机上一次 trace 都采不到，"抓真实事件顺序"就成了空话。
      //   （这正是 0.1.12 那类事故的成因之一：观测面缺失，事后只能靠用户复述。）
      if (text.indexOf('[PIX_TRACE]') !== -1 || text.indexOf('[Hello Pix]') !== -1) {
        clientLog.info('guest-trace', text + ' @' + (source || '') + ':' + line)
        return
      }
      if (level === 2 || level === 3 || level === 'warning' || level === 'error') {
        clientLog.warn('guest', text + ' @' + (source || '') + ':' + line)
      }
    })
  }
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
  const view = createWebView(partition, settings, item, homeUrl,
    { platform: item.id, account: accountSlug(), id: '' })
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
  // 只有在 preload 真的跑起来之后，guest 才会来问 prefs；到点没来就是桥没起来。
  watchdogBridge(tab)
  startTabLoad(tab)
  activeId = id
  showHome = false
  layoutViews()
  sendTabs()
  saveOpenApps()
  return { success: true, id: id }
}

/**
 * 后台运行状态。
 *
 * `isQuitting` 是关键：`app.quit()` 会先触发窗口的 `close` 事件，
 * 如果那时还按"关闭=隐藏"处理，退出流程会被自己拦下来 —— 表现是
 * 点了退出没反应，只能去任务管理器杀进程。
 */
let tray = null
let isQuitting = false
/** 默认开启：这是多开翻译工具，用户关掉界面往往只是"先收起来"，不是"别翻了"。 */
let backgroundRunning = true
let backgroundTipShown = false

function backgroundEnabled() {
  return backgroundRunning
}

/**
 * 建立系统托盘。
 *
 * 托盘不只是"后台运行的配套"，它是隐藏之后**唯一能把窗口叫回来的入口** ——
 * 所以创建失败必须被感知：`shouldHideOnClose` 会在 hasTray 为假时拒绝隐藏。
 */
function createTray() {
  if (tray) return tray
  try {
    const img = appIconImage()
    if (!img) throw new Error('图标读取失败')
    const size = backgroundMode.trayIconSize(process.platform)
    const small = img.resize({ width: size, height: size, quality: 'best' })
    tray = new Tray(small)
    tray.setToolTip(backgroundMode.trayTooltip(APP_VERSION))
    refreshTrayMenu()
    // 左键单击直接唤回窗口：这是用户最自然的动作，不该逼他右键找菜单
    tray.on('click', () => showMainWindow())
    tray.on('double-click', () => showMainWindow())
    return tray
  } catch (e) {
    // 建不出来就把 tray 留在 null —— 关窗逻辑会据此放行退出，
    // 绝不会出现"窗口藏了、没有任何入口能找回来"的僵尸进程
    console.error('[hello-pix] 托盘创建失败，将退化为关闭即退出：', e && e.message)
    tray = null
    return null
  }
}

function refreshTrayMenu() {
  if (!tray) return
  try {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主界面', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: '关闭窗口时后台运行',
        type: 'checkbox',
        checked: backgroundRunning,
        click: menuItem => setBackgroundRunning(!!menuItem.checked)
      },
      {
        label: '开机自动启动',
        type: 'checkbox',
        checked: loginItemEnabled(),
        click: menuItem => setLoginItem(!!menuItem.checked)
      },
      { type: 'separator' },
      { label: '打开日志目录', click: () => openLogDir() },
      { label: '退出 Hello Pix', click: () => quitApp() }
    ]))
  } catch (e) {
    console.error('[hello-pix] 托盘菜单构建失败：', e && e.message)
  }
}

function setBackgroundRunning(next) {
  backgroundRunning = !!next
  saveConfig()
  refreshTrayMenu()
  // 同步渲染层的开关状态：托盘菜单和界面里那一项是同一个设置，
  // 从托盘改完之后界面上的显示不能还是旧的。
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.send('config:backgroundRunning', backgroundRunning)
    }
  } catch (e) {}
}

/** 把窗口唤回来并聚焦。窗口可能被隐藏或最小化，两种情况都要处理。 */
function showMainWindow() {
  if (!win || win.isDestroyed()) {
    // 窗口被销毁了（异常路径）—— 重建一个，总比让用户对着托盘图标干瞪眼好
    createWindow()
    return
  }
  if (!win.isVisible()) win.show()
  if (win.isMinimized()) win.restore()
  win.focus()
}

/** 真正退出。必须先立 isQuitting，否则 close 拦截会把这次退出吃掉。 */
function quitApp() {
  isQuitting = true
  app.quit()
}

function loginItemEnabled() {
  try {
    return !!app.getLoginItemSettings().openAtLogin
  } catch (e) {
    return false
  }
}

function setLoginItem(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: false })
  } catch (e) {
    console.error('[hello-pix] 设置开机启动失败：', e && e.message)
  }
  refreshTrayMenu()
}

function createWindow() {
  // 按屏幕可用区域自适应开窗：此前固定 1280x820，小屏尚可、大屏浪费，
  // 而窄屏下顶部翻译设置区会被挤压换行。取下 92% 并设上下限，保证完整显示。
  const { screen: electronScreen } = require('electron')
  const { workAreaSize } = electronScreen.getPrimaryDisplay()
  // 高度优先：顶部设置区两行需要空间，因此尽量吃满可用高度（只留 16px 余量），
  // 而不是按比例缩。1280x800 这类逻辑分辨率下可用高度约 775px，这就是物理上限。
  // 最小尺寸见 WINDOW_MIN_WIDTH / WINDOW_MIN_HEIGHT 的注释（含实测依据）。
  const fallback = {
    width: Math.max(WINDOW_MIN_WIDTH, Math.min(1920, workAreaSize.width - 16)),
    height: Math.max(WINDOW_MIN_HEIGHT, Math.min(1600, workAreaSize.height - 16))
  }
  const saved = restoreWindowBounds(fallback)
  const width = saved.width
  const height = saved.height
  win = new BrowserWindow({
    width,
    height,
    center: true,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
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
  // 渲染进程的报错与崩溃要留痕：此前"界面白屏""翻译没反应"这类问题在客户端
  // 没有任何记录，只能靠用户复述当时点了什么。
  if (clientLog) {
    const wcLog = win.webContents
    wcLog.on('console-message', (...args) => {
      // Electron 33 是老签名 (event, level, message, line, sourceId)，
      // 新版本改成单个对象。两种都兼容 —— 否则升级后日志会静默消失。
      let level, message, line, source
      if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        level = args[0].level
        message = args[0].message
        line = args[0].lineNumber
        source = args[0].sourceId
      } else {
        level = args[1]
        message = args[2]
        line = args[3]
        source = args[4]
      }
      // 只收警告与错误：渲染层的 info 量大且几乎没有诊断价值
      if (level === 2 || level === 3 || level === 'warning' || level === 'error') {
        clientLog.warn('renderer', String(message) + ' @' + (source || '') + ':' + line)
      }
    })
    wcLog.on('render-process-gone', (_event, details) => {
      clientLog.error('crash', '主窗口渲染进程退出：reason=' +
        ((details && details.reason) || '?') + ' exitCode=' +
        ((details && details.exitCode) == null ? '?' : details.exitCode))
    })
    wcLog.on('unresponsive', () => clientLog.warn('renderer', '主窗口无响应'))
  }
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
  /**
   * 关闭窗口 → 隐藏到托盘（后台继续跑），而不是退出。
   *
   * 翻译靠的是各个 webview 里注入的脚本，窗口一旦真关掉、webContents 被销毁，
   * 翻译就停了。用户点右上角的 ×，多数时候意思是"先收起来"，
   * 不是"别翻了" —— 尤其是这个产品的多开窗口本来就要一直挂着。
   *
   * 但**不是无条件拦截**：托盘没建出来时必须放行退出，
   * 否则窗口藏了、又没有任何入口能找回来，进程就成了用户看不见也关不掉的僵尸。
   * 判定集中放在 background-mode.js，那里有单测。
   */
  win.on('close', event => {
    if (!backgroundMode.shouldHideOnClose({
      isQuitting,
      backgroundEnabled: backgroundEnabled(),
      hasTray: !!tray
    })) return
    event.preventDefault()
    win.hide()
    // 只提示一次，避免每次关窗都弹一下惹人烦
    if (!backgroundTipShown && tray && process.platform === 'win32') {
      backgroundTipShown = true
      try {
        tray.displayBalloon({
          title: 'Hello Pix 仍在后台运行',
          content: '翻译会继续工作。要完全退出，请右键托盘图标选择「退出」。'
        })
      } catch (e) { /* 某些系统不支持气泡，忽略即可 */ }
    }
  })
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
  // 后台运行开关：渲染层的「系统操作」菜单要显示当前状态，托盘菜单之外的
  // 第二个入口 —— 不能指望用户去右键托盘图标找设置。
  backgroundRunning: backgroundRunning,
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

// 后台运行开关（关闭窗口时隐藏到托盘，而不是退出）。
// 只接受布尔值语义：任何非 false 的输入都按开启处理，与 loadConfig 的
// `!== false` 默认值保持一致 —— 免得 renderer 传个 undefined 把开关关掉。
ipcMain.handle('config:setBackgroundRunning', (event, value) => {
  if (!isMainSender(event)) return rejectUntrustedSender()
  setBackgroundRunning(value !== false)
  return { success: true, backgroundRunning: backgroundRunning }
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
      // 带上 process.arch，服务端才能给对应架构的安装包。
      // 不带的话 macOS 会固定下发 x64 —— Apple 芯片用户点「苹果电脑版」
      // 拿到的是 Intel 包。
      return await fetchFrom(apiBase, '/site/info?arch=' + encodeURIComponent(process.arch), 2500)
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
  // 先摘代理字段再解密：模板里本来就不该有代理，摘在前面连 proxyPass 都不会被解密。
  // 这一步同时**自愈**旧版本已经写进磁盘的带代理模板 —— 用户不用清配置。
  const settings = unsealSettings(stripProxyFields(row.settings))
  return { success: true, data: Object.assign({}, row, { settings: settings }) }
})
ipcMain.handle('app:savePreset', (event, payload) => {
  if (!isMainSender(event)) return rejectUntrustedSender()
  const id = String((payload && payload.platformId) || '')
  if (!id) return { success: false }
  const all = readJson(userFile('app-presets.json'), {})
  // 模板只存"可以跨实例继承的普通偏好"（字体、语言、通道…）。
  // 代理是实例级敏感配置，**不进模板** —— 否则新建实例会继承上一个实例的代理。
  all[id] = {
    name: (payload && payload.name) || '',
    settings: sealSettings(stripProxyFields((payload && payload.settings) || {}))
  }
  writeJson(userFile('app-presets.json'), all)
  return { success: true }
})

ipcMain.handle('app:tabs', () => tabPayload())

/**
 * 打开日志目录。
 *
 * 这是日志功能真正能用起来的关键一步 —— 日志写在本地，
 * 如果用户找不到它，"请把日志发给我们"就只是一句空话。
 * 放在「系统操作」菜单里：用户报障时最自然的入口。
 */
function openLogDir() {
  if (!clientLog) {
    console.error('[hello-pix] 日志未启用，无法打开日志目录')
    return
  }
  Promise.resolve(shell.openPath(clientLog.dir)).then(error => {
    if (error) console.error('[hello-pix] 打开日志目录失败：', error)
  }).catch(error => console.error('[hello-pix] 打开日志目录失败：', error))
}

/**
 * 在**已存在的线路**上打开「代理设置」。
 *
 * 只把线路 id 发给渲染层，由弹窗去编辑这条线路自己的 proxy settings：
 * 不新建线路、不新建 partition、不动 usedCount、不改 tab id ——
 * 这恰是旧版缺的入口（旧版只能新建线路，改不了已有线路的代理）。
 */
function openProxySettingsFor(id) {
  if (win && !win.isDestroyed()) win.webContents.send('context:proxySettings', String(id || ''))
}

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
      { label: '打开日志目录', click: () => openLogDir() },
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
      { label: '代理设置', click: () => openProxySettingsFor(tab.id) },
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
      { label: '打开日志目录', click: () => openLogDir() },
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
  // 兜底值以前是 `tab.settings`，那会把这条线路**正在用的代理**写进模板，
  // 于是"改个名字"就成了一次静默的代理泄漏：下一个新建实例会继承它。
  // 模板永远不含代理，所以两个来源都要先摘干净。
  all[tab.platform] = { name: next, settings: sealSettings(stripProxyFields(prev.settings || tab.settings || {})) }
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
/**
 * 读取一条线路当前的代理配置，供「代理设置」弹窗回填。
 *
 * 只回传代理字段（proxySettingsOf），不把整份 settings 抖给渲染层。
 * proxyPass 在内存里本就是明文（与新建线路时一致），弹窗需要它回填 ——
 * 这与「新增应用」弹窗从预设回填密码的行为保持一致；
 * 落盘时仍由 saveOpenApps 走 sealSettings 加密。
 */
ipcMain.handle('app:proxySettings', (event, payload) => {
  if (!isMainSender(event)) return rejectUntrustedSender()
  const id = String((payload && payload.id) || '')
  const tab = tabs.find(t => t.id === id)
  if (!tab) return { success: false, msg: '应用不存在' }
  return { success: true, data: proxySettingsOf(tab.settings) }
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
// 客户身份线索上报。
//
// platform 与 accountKey **由主进程填入，不接受渲染进程传值** ——
// 渲染进程在网页上下文里，理论上可被页面脚本影响；由主进程按
// webContents 反查到可信的 tab 再补上，才能保证"这条线索确实来自那个账号"。
ipcMain.handle('customer:ingest', async (event, payload) => {
  const tab = trustedTabSender(event.sender)
  if (!tab) return { success: false, msg: '标签页未授权' }
  const data = Object.assign({}, payload || {}, {
    platform: tab.platform,
    accountKey: accountSlug()
  })
  // 出向消息的发送方是**本账号**，不是对方。
  // 服务端在缺失时拿 peerKey 兜底 —— 那是"接收"的语义，用在出向上会把
  // 发送方记成客户，于是"我方发了什么"在归档里看起来像"客户发了什么"。
  // 和 platform/accountKey 一样放在主进程补：渲染进程在网页上下文里，
  // 让它自报"我是谁"等于把归属判断交给不可信的一侧。
  if (data.direction === 'out' && !data.senderKey) data.senderKey = data.accountKey
  try {
    return await api('/customer/ingest', { method: 'POST', form: data })
  } catch (e) {
    // 采集失败不影响聊天，静默即可 —— 但不能吞掉到连排查线索都没有
    return { success: false, msg: String((e && e.message) || '上报失败') }
  }
})

// 撞单提醒查询。客户端每 8 秒的 session 轮询顺带拉一次，
// 不另开定时器、也不上 WebSocket —— 撞单不是高频交易，
// "8 秒内知道"和"立刻知道"对结果没有区别。
ipcMain.handle('customer:reminders', async () => {
  try {
    const data = await api('/customer/reminders')
    return data && data.items ? data.items : []
  } catch (e) {
    return []
  }
})

// 渲染层加载时主动查一次：警告条不能只在"刚变成坏"的那一刻出现 ——
// 渲染层重载、切标签、重启后都要能恢复显示。
ipcMain.handle('translate:bridgeStatus', event => {
  if (!isMainSender(event)) return rejectUntrustedSender()
  const rows = []
  tabs.forEach(tab => {
    const st = bridgeHealth.get(tab.id)
    if (st && st.ok === false) rows.push({ id: tab.id, name: tab.name, reason: st.reason })
  })
  return { success: true, rows: rows }
})

ipcMain.handle('translate:engines', async () => {  try {
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
  if (!tab) return rejectUntrustedSender()
  // guest 能问到 prefs，说明 preload 真的执行到了 —— 这是"桥活着"最可靠的证据。
  bridgeReport(tab.id, true, '')
  return tabPrefs(tab)
})
ipcMain.handle('translate:run', async (event, payload) => {
  const tab = trustedTabSender(event.sender)
  if (!tab) return rejectUntrustedSender()
  const p = payload || {}
  const raw = String(p.text || '').trim()
  if (raw.length > 5000) return { success: false, msg: '单次翻译最多 5000 个字符' }
  // 占位符绝不能进翻译接口：它是我们自己的状态，翻出来只会污染译文。
  const text = stripEmoji(stripBusyMarks(raw))
  if (!text) return { success: true, translation: '', skipped: 'busy' }
  const s = (tab && tab.settings) || {}
  const incoming = !!p.incoming
  const to = incoming
    ? pickLang(s.recvTo, (profile && profile.langMine) || 'zh')
    : pickLang(s.sendTo, 'en')
  const from = incoming ? (s.recvFrom || 'auto') : (s.sendFrom || 'auto')
  const engine = s.engine || (profile && profile.activeEngine) || ''
  // 调用来源，一路带到服务端落进 translate_logs.trigger。
  // 出异常字符消耗时，靠它区分"用户点了译"和"扫描时自动翻"。
  const trigger = String(p.trigger || '').trim()
  // 真机取证用：把**实际送给上游**的 source_text 记进客户端日志。
  // 排查"译文里混进 UI 文案"这类问题时，没有这一行只能靠猜。
  if (clientLog) {
    clientLog.info('translate', 'source_text=' + JSON.stringify(text) +
      ' · from=' + from + ' to=' + to + ' engine=' + engine + ' dir=' + (incoming ? 'in' : 'out') +
      ' trigger=' + (trigger || '-'))
  }
  const hit = getTransCached(from, to, engine, text)
  if (hit) return { success: true, translation: hit, cached: true }
  try {
    // requestTranslate 内部处理"上一轮的请求号已终结"：换号重发一次再返回。
    // 这条路径不吞错 —— 服务端的 {success:false, code, msg} 原样上抛给渲染层，
    // 由 guest-inject 的 notifyTranslateIssue() 显示成人话（余额不足 / 通道未包含）。
    const data = await requestTranslate(text, from, to, engine, trigger)
    const out = String((data && (data.translation || data.text)) || '').trim()
    if (data && data.success && out) {
      putTransCached(from, to, engine, text, out)
      if (out !== text) putTransCached('auto', from === 'auto' ? 'zh' : from, engine, out, text)
    }
    return data
  } catch (e) {
    return { success: false, code: 'TRANSLATE_FAILED', msg: e.message || '翻译失败' }
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
  // 必须在 applyAppIdentity() 之后：日志目录由 app name 推导（见 initClientLog）。
  const log = initClientLog()
  if (log) {
    log.info('app', '启动 Hello Pix v' + app.getVersion() +
      ' · ' + process.platform + ' ' + process.arch +
      ' · electron ' + process.versions.electron)
    log.info('app', '日志目录：' + log.dir)
  }
  // 槽位必须在任何 webview 之前拿到 —— 分区名依赖它。
  const handle = acquireInstanceSlot()
  console.log('[hello-pix] 多开槽位 =', handle.slot,
    handle.file ? '' : '（槽位已满，本次使用一次性分区）')
  try { fs.rmSync(userFile('translate-cache.json'), { force: true }) } catch (e) {}
  loadConfig()
  // 托盘要先于窗口建好：关闭拦截依赖 `tray` 是否为真来决定"隐藏还是退出"。
  createTray()
  createWindow()
})

app.on('before-quit', () => {
  // 必须在最前面：后面 saveOpenApps / releaseSlot 都可能触发窗口操作，
  // 而那些操作若被 close 拦截当成"隐藏"，退出流程就会被自己吃掉。
  isQuitting = true
  saveOpenApps()
  // 关掉所有本地中继：它们是本进程内的监听端口，进程结束前清干净。
  try {
    socksRelays.forEach(item => { try { item.relay.close() } catch (e) {} })
    socksRelays.clear()
  } catch (e) {}
  // 归还槽位，让下一个窗口能拿回同一个分区（登录态得以保留）。
  // 崩溃时不会执行到这里，由 acquireSlot 的陈旧锁接管逻辑兜底。
  try { instanceSlot.releaseSlot(instanceSlotHandle) } catch (e) {}
  try { if (tray) { tray.destroy(); tray = null } } catch (e) {}
  // 把缓冲区里的日志刷到磁盘 —— 正常退出时不能把最后几条丢掉，
  // 而"最后几条"往往正是退出前出的问题。
  try { if (clientLog) clientLog.flush() } catch (e) {}
})

app.on('window-all-closed', () => {
  // 后台运行时窗口只是 hide、并没有 close，所以这里正常情况下不会触发。
  // 真触发只有两种情形，答案不一样（判定集中在 background-mode.js，带单测）：
  //   1. 用户关掉了后台运行 → 此时必须退出，不能拿"托盘还在"当借口赖着不走
  //   2. 后台运行中窗口被异常带走（渲染进程崩溃）→ 留在托盘，点一下能重建窗口，
  //      退出反而会让翻译静默中断。只有托盘也没建出来时才退出，
  //      否则会剩一个没有窗口、也没有任何入口的程序。
  if (backgroundMode.shouldQuitOnAllClosed({
    isQuitting,
    backgroundEnabled: backgroundEnabled(),
    hasTray: !!tray
  })) app.quit()
})

// macOS：点 Dock 图标要把（可能已隐藏到托盘的）窗口唤回来。
// 与托盘左键单击走同一条路径；窗口被异常销毁时 showMainWindow 会重建，
// 避免"图标点了没反应"。
app.on('activate', () => showMainWindow())
