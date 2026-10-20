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
const fallbackPlatforms = require('./shared/platforms')
const builtinLines = require('./src/config/lines')
const proxyPresets = require('./src/proxy/proxy-presets')
const proxyIsolation = require('./src/proxy/proxy-isolation')
// 热路径上的状态文件改走异步 + 原子写（见下方 asyncJson 的说明）。
const { createStore } = require('./src/storage/async-store')
const { stripProxyFields } = proxyIsolation
// 代理的构建与应用抽到独立模块：产品、单元测试、机制测试共用**同一份实现**。
// 这几个函数原先内联在 main.js 里，而 main.js 一 require 就会加载 electron，
// 普通 Node 加载不了 —— 于是最需要回归保护的代理逻辑一个测试都没有。
const proxySettings = require('./src/proxy/proxy-settings')
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
const { createSocksRelay, precheckSocks5 } = require('./src/proxy/socks-relay')
// 读远程页面文本走隔离世界（不是 page world）—— 见 probe-page.js 顶部注释。
const { readPageText } = require('./src/translate/probe-page')
// 实例页面加载失败时的错误页（见该文件顶部：真机上"网络不通"表现为黑屏）。
const loadErrorPage = require('./src/stability/load-error-page')
const instanceSlot = require('./src/window/instance-slot')
const backgroundMode = require('./src/window/background-mode')
const hiddenTabs = require('./src/window/hidden-tabs')
const {
  csvHosts,
  trustedApiHosts,
  validateApiUrl,
  isAllowedPlatformUrl,
  isAllowedExternalUrl,
  PLATFORM_EXTENSION_IDS
} = require('./src/config/security-policy')
const logFile = require('./src/stability/log-file')
const crashReport = require('./src/stability/crash-report')
// 翻译桥警告条：preload 死了以后，唯一还能把警告画到用户眼前的手段
// （隔离世界注入，见该文件顶部注释）。
const bridgeWarning = require('./src/stability/bridge-warning')
// composer 的原生输入（Chromium 编辑命令）—— 见 desktop/native-composer.js 顶部
// 的根因说明：页面内直接改 DOM 的写入进不了 WhatsApp 编辑器的输入管线。
const nativeComposer = require('./src/translate/native-composer')
// 实例资源预算：防止"开太多窗口把应用撑崩"（句柄耗尽 → 闪退，见该文件顶部）。
const tabBudget = require('./src/window/tab-budget')

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * 一个窗口内最多同时开的实例数的**硬顶**。
 *
 * ## 为什么默认是 0（不设硬顶）
 *
 * 0.1.30 曾把它设成 20，理由是"每实例 24 个句柄、20 个就接近句柄上限"。
 * 0.1.31 实测发现**那个归因是错的**：
 *
 * ```
 *             句柄      主进程RSS    整机内存
 *   48 个  →  1178      122MB       6443MB
 *   80 个  →  1886      150MB       8163MB   ← 句柄才 1886，离上限极远
 * ```
 *
 * Electron 启动时会把软限制**抬到硬限制**（macOS 实测 `ulimit -n` = 1048575），
 * 所以 `launchd` 默认的 `maxfiles=256` 是个**假象** —— 句柄根本不是瓶颈。
 * 真正的瓶颈是**内存**，而且它与机器大小强相关：80 个实例约 8GB，
 * 在 8GB 机器上是灾难，在 32GB 机器上却毫无压力。
 *
 * 所以固定一个"最多 N 个"是错的：同一个数字在 8GB 机器上太冒险、
 * 在 32GB 机器上又太保守。改为**按系统内存水位动态判断**（见 tab-budget.js）。
 *
 * 这个常量留着是为了"想强行限死"的场景（设成 >0 即生效），默认 0 = 不限。
 */
const MAX_TABS_PER_WINDOW = 0

/**
 * 实际生效的实例上限。
 *
 * 常态是 `MAX_TABS_PER_WINDOW`（0 = 按内存水位动态判断）。
 * 但崩溃循环进入安全模式后，stability-boot 会把建议值放在
 * `global.__pixGuard.policy().maxTabs` 上 —— 以前这个值**只写进日志、
 * 从未被读取**，等于安全模式只关了 GPU，实例数照样不受限。
 *
 * 安全模式的判据来自「5 分钟内启动 3 次」：那种情况下最大的嫌疑就是
 * 实例太多，把它压到 2 个能让用户立刻验证这个假设，而不是继续崩。
 */
function effectiveMaxTabs() {
  try {
    const guard = global.__pixGuard
    if (guard && typeof guard.policy === 'function') {
      const max = Number(guard.policy().maxTabs) || 0
      if (max > 0) return max
    }
  } catch (e) {}
  return MAX_TABS_PER_WINDOW
}

/**
 * 安全模式下停掉翻译桥。
 *
 * `guest-inject.js` 有 4300 行，注入到每一个实例页面里，是崩溃嫌疑面里
 * 最难在真机二分的一块。安全模式的首要目标是"先让它能开起来"，所以
 * 这里把它摘掉：用户暂时没有翻译，但至少不会一开就崩。
 *
 * 只在崩溃循环（5 分钟内启动 3 次）时触发，正常使用完全不受影响。
 */
function safeModeDisablesBridge() {
  try {
    const guard = global.__pixGuard
    if (guard && typeof guard.policy === 'function') return !!guard.policy().disableBridge
  } catch (e) {}
  return false
}
// 顶部标签栏高度。含 6px 横向滚动条 —— 标签本身 62px + 上下 padding 10px = 72px，
// 多出的 6px 给滚动条，否则开多窗口滚动条会把标签压扁。与 styles.css 的 .tabs 同步。
const TABS_HEIGHT = 80
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
const DEFAULT_API = require('./src/config/api-default').PUBLIC_URL
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

/**
 * 隐藏窗口（后台保活）。
 *
 * 实现见 src/window/hidden-tab-ops.js —— 依赖全部参数化，
 * 测试可以直接喂一份 state 跑真身，不必再从源码里抠函数体。
 *
 * 这里的 state 是**实时代理**：读写的仍是 main.js 的模块级变量，
 * 所以 hideTab 里改 activeId 会真实生效，不是改了一份副本。
 */
const tabState = {
  get tabs () { return tabs },
  set tabs (v) { tabs = v },
  get activeId () { return activeId },
  set activeId (v) { activeId = v },
  get showHome () { return showHome },
  set showHome (v) { showHome = v }
}


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
  const store = syncStores.get(file)
  // 已交给异步存储的文件走异步通道，不能再同步写 —— 两条通道各写各的会互相覆盖。
  if (store) return store.set(data)
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

/**
 * 热路径上的 JSON 文件改用异步存储。
 *
 * ## 为什么只挑这两个文件
 *
 * `writeJson` 的调用点里，只有这两个在**主线程热路径**上：
 *
 *   · open-apps.json    ← saveOpenApps()，被 did-stop-loading / switchTab /
 *                           goHome / updateTabSettings 调用，开多窗口时每次
 *                           切标签都触发一轮「同步读 + 同步整份重写」；
 *   · window-bounds.json ← 拖动窗口（500ms 防抖），拖一下就是一次同步写。
 *
 * 其余（config / auth / web-apps / presets / proxy-history）都在用户主动
 * 操作时写一次，频率极低，保持同步反而更简单 —— 把启动期就需要读到的
 * 配置改成异步只会增加时序复杂度，收益为零。
 *
 * ## 用异步存储顺带修掉的数据风险
 *
 * `writeFileSync` 直接覆盖：写到一半断电或被杀进程，文件会变成半截 JSON，
 * 下次读取走 fallback，**用户的窗口列表静默丢失**。async-store 走
 * 「写临时文件 → rename」，同一分区上 rename 是原子的，结果只有
 * 「旧的完整文件」或「新的完整文件」。
 */
const syncStores = new Map()

function asyncJson(file) {
  const cached = syncStores.get(file)
  if (cached) return cached
  const store = createStore(file, {
    onError: error => {
      try { console.error('[store] 写入失败 ' + file + '：' + (error && error.message)) } catch (e) {}
    }
  })
  syncStores.set(file, store)
  return store
}

/** 退出前把异步队列里的数据同步落盘。 */
function flushSyncStores() {
  for (const store of syncStores.values()) {
    try { store.flushSync() } catch (e) {}
  }
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
  // 内存采样要在所有窗口创建之前就起来，才能覆盖"从启动到崩溃"的完整爬升过程。
  startMemorySampling(log)

  // ★ 子进程崩溃必须留痕（GPU / utility / 网络进程）★
  //
  // 用户反馈"开很多窗口时闪退"。以往只挂了主窗口的 render-process-gone，
  // **GPU 进程、utility 进程崩溃在日志里完全看不到**。而这类崩溃正是
  // "界面突然白屏/软件整个消失、连个错误提示都没有"的常见成因。
  //
  // 只记 error 级别、事件很短，不会把日志写大。type 要记清楚：
  // gpu 崩了 → 渲染/合成问题；utility 崩了 → 网络或杂活进程问题。
  app.on('child-process-gone', (_event, details) => {
    try {
      const reason = (details && details.reason) || '?'
      clientLog.error('crash', '子进程退出：type=' + ((details && details.type) || '?') +
        ' name=' + ((details && details.name) || '?') +
        ' reason=' + reason +
        ' exitCode=' + ((details && details.exitCode) == null ? '?' : details.exitCode) +
        (reason === 'oom' ? ' ★内存不足' : ''))
    } catch (ignore) {}
  })

  return log
}

/**
 * 崩溃日志上报 —— 把**上次异常退出**留下的证据自动送回来。
 *
 * ## 为什么要有这一步
 *
 * 0.1.36 起 `[crash]` / `[memory]` 已经能记录了，但日志只躺在用户本机。
 * 用户不主动发，我们永远看不到 —— 等于加了取证却没有收回证据的通道。
 * 这个函数在启动时把上次的痕迹送到服务器，用户无感。
 *
 * ## 设计约束（都很硬）
 *
 *   · **绝不阻塞启动**：先返回，网络请求在后台跑。启动速度是用户能直接感知的，
 *     不能因为一个诊断功能而变慢。
 *   · **失败完全静默**：不写日志、不弹窗。服务器连不上、线路不通都是常态，
 *     这不该变成用户看到的新问题。
 *   · **只传 crash / memory 行**：过滤在 crash-report.js 里，服务端还会再滤一次。
 *   · **传完就写标记**：防止同一次崩溃在下一次启动时重复上报。
 */
function reportCrashIfNeeded(log) {
  if (!log || !log.dir) return
  let found
  try {
    found = crashReport.detectAbnormalExit(log.dir)
  } catch (e) {
    return
  }
  // 正常退出、首次安装、没有任何日志 —— 都不上报。
  if (!found) return
  const picked = found.picked
  if (!picked || !picked.lines.length) return

  const payload = {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    lines: picked.lines
  }
  const summary = crashReport.summarize(picked.lines)

  // 不 await：调用方继续往下走，启动不受影响。
  setImmediate(() => {
    api('/client/crash-report', {
      method: 'POST',
      // 用 form 而不是 JSON：api() 只实现了 urlencoded 提交，
      // lines 作为 JSON 字符串放进单个字段，服务端再 parse。
      form: {
        version: payload.version,
        platform: payload.platform,
        arch: payload.arch,
        lines: JSON.stringify(payload.lines)
      },
      // 诊断流量不该和用户操作抢带宽，超时也给短一点。
      totalTimeoutMs: 20000
    }).then(() => {
      // 传成功 → 写标记，避免重复上报。
      crashReport.writeMarker(log.dir)
      try {
        log.info('crash', '崩溃日志已上报：' + summary.crashCount + ' 条崩溃' +
          (summary.memoryPeak == null ? '' : '，内存峰值 ' + summary.memoryPeak + '%'))
      } catch (e) {}
    }).catch(() => {
      // 失败就什么都不做：下次启动会再试。
      // 刻意不写 WARN —— 线路不通时每个用户都会看到这条，纯属噪音。
    })
  })
}

/**
 * 周期性记录内存水位 —— **崩溃之前那一刻的内存，是事后唯一能看到的证据**。
 *
 * ## 为什么必须有
 *
 * 用户反馈"开着很多窗口时闪退"。崩溃记录只能告诉我们"进程因为内存不足被杀了"
 * （reason=oom），但**回答不了最关键的问题：当时整机还有多少内存？窗口开了几个？**
 * 没有这两个数字，改阈值、改策略全是拍脑袋。
 *
 * ## 为什么不是每分钟一条
 *
 * 那样日志会被刷爆（一天 1440 行噪音），真出事时反而不好找。
 * 只在**水位发生变化**时写：跨过 70% / 80% / 90% 的档位才记一条。
 * 平时安静，一旦开始吃紧，日志里就有一串爬升曲线。
 */
function startMemorySampling(log) {
  if (!log) return null
  const MB = 1024 * 1024
  let lastBucket = -1
  let lastAt = 0

  const tick = () => {
    try {
      // 节流：距上次记录不足 30 秒就跳过，避免窗口抖动导致重复写。
      if (Date.now() - lastAt < 30000) return
      const mem = tabBudget.memoryPressure()
      if (!mem || !Number.isFinite(mem.ratio) || mem.total <= 0) return
      const pct = Math.round(mem.ratio * 100)
      // 70% 以下每 10 个百分点一档；70% 以上每 5 个一档（越接近上限越要密）。
      const bucket = pct >= 90 ? 90 + Math.floor((pct - 90) / 2) * 2
        : pct >= 70 ? 70 + Math.floor((pct - 70) / 5) * 5
          : Math.floor(pct / 10) * 10
      if (bucket === lastBucket) return
      lastBucket = bucket
      lastAt = Date.now()
      // 同时记实例数与本进程 RSS：后者能看出"是不是我们自己在涨"。
      const rss = Math.round(process.memoryUsage().rss / MB)
      log.info('memory', '整机已用 ' + pct + '%（' +
        Math.round(mem.used / MB) + '/' + Math.round(mem.total / MB) + 'MB，口径 ' + mem.source +
        '）  实例 ' + tabs.length + ' 个  主进程 RSS ' + rss + 'MB')
    } catch (ignore) {}
  }

  // ★ 首次采样必须异步，不能在这里同步跑 ★
  //
  // tick() 在 macOS 上会走 tab-budget 的 vm_stat 分支，那是 execSync ——
  // 平时 5ms，但系统繁忙时最长卡 3 秒（timeout: 3000）。而本函数在
  // app.whenReady 的启动路径上被同步调用，卡住的就是用户眼里的
  // "双击了没反应"。采样是诊断，绝不能拖慢启动。
  const primed = setTimeout(tick, 1000)
  if (primed && typeof primed.unref === 'function') primed.unref()
  const timer = setInterval(tick, 15000)
  if (timer && typeof timer.unref === 'function') timer.unref()
  return timer
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

/**
 * 打开的应用列表 → 异步存储。
 *
 * 这是全仓最热的一份状态：did-stop-loading / switchTab / goHome /
 * updateTabSettings 都会调 saveOpenApps()，而它每次都是
 * 「同步读盘 → 合并所有标签 → 整份同步重写」。开十几个窗口时，
 * 每切一次标签就在主线程上做一轮全量磁盘 IO。
 *
 * 注册走 asyncJson() 之后，saveOpenApps() 里的 readJson(openAppsFile())
 * 变成读内存缓存，writeJson 变成 250ms 合并后的异步原子写。
 *
 * 幂等：asyncJson 自带缓存，重复调用返回同一个 store。
 */
function openAppsStore() {
  return asyncJson(openAppsFile())
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
  const all = openAppsStore().get({})
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
      // 隐藏状态必须落盘：否则重启软件后隐藏窗口全部回到标签栏，
      // 用户会以为"隐藏"没记住。
      hidden: !!t.hidden,
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

/**
 * 从网页标题里读未读数。
 *
 * 各家网页版有未读时都会改标题：WhatsApp / Messenger / Facebook / Zalo / Instagram
 * 是 `(3) WhatsApp`，部分是 `WhatsApp (3)` 或 `3 • Telegram`。标题是这些页面
 * **对外公开的未读信号**，不依赖任何会随改版失效的 DOM 结构。
 * 读不到数字一律视为 0（宁可不显示，也不显示错的数）。
 */
function unreadFromTitle(title) {
  return hiddenTabs.unreadFromTitle(title)
}

/** 未读数清零要延迟确认的时长：Messenger 等会在 `(1) Messenger` 与「某某发来消息」之间来回闪标题。 */
const UNREAD_CLEAR_DELAY_MS = 2500

function bindTabUnread(tab) {
  let clearTimer = null
  const wc = tab.view.webContents
  const apply = n => {
    // 隐藏的窗口不计未读：它的定义就是"静默地挂着"。
    // 不看这个标记，隐藏窗口收到消息照样推角标 —— 用户会以为隐藏没生效。
    if (tab.hidden && !hiddenTabs.shouldNotifyWhenHidden()) return
    if ((tab.unread || 0) === n) return
    tab.unread = n
    sendTabs()
  }
  wc.on('page-title-updated', (_event, title) => {
    const n = unreadFromTitle(title)
    if (n > 0) {
      if (clearTimer) { clearTimeout(clearTimer); clearTimer = null }
      apply(n)
      return
    }
    if (!tab.unread || clearTimer) return
    clearTimer = setTimeout(() => {
      clearTimer = null
      if (wc.isDestroyed()) return
      apply(unreadFromTitle(wc.getTitle()))
    }, UNREAD_CLEAR_DELAY_MS)
  })
  wc.once('destroyed', () => { if (clearTimer) clearTimeout(clearTimer) })
}

let lastGlobalUnread = -1

/** Dock / 任务栏角标：只统计开了「包含在全局未读消息提示中」的标签。 */
function syncGlobalUnread() {
  const total = tabs.reduce((sum, t) => {
    // 隐藏的窗口一律不计入角标 —— 同理，隐藏 = 不提醒。
    if (t.hidden) return sum
    return sum + ((t.settings && t.settings.globalUnread === false) ? 0 : (t.unread || 0))
  }, 0)
  if (total === lastGlobalUnread) return
  lastGlobalUnread = total
  try { app.setBadgeCount(total) } catch (e) {}
}

function bindTabLoading(tab) {
  bindTabUnread(tab)
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
    loading: true,
    // 上次退出时处于隐藏状态的窗口，重启后继续保持隐藏（后台跑着）。
    hidden: !!row.hidden
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
  const all = openAppsStore().get({})
  const data = (all.byUser && all.byUser[user]) || (all.username === user ? all : null)
  if (!data || !Array.isArray(data.tabs) || !data.tabs.length) return
  nextTab = Math.max(1, Number(data.nextTab) || 1)
  usedCount = Object.assign({}, data.usedCount || {})
  data.tabs.forEach(row => {
    try { restoreOneApp(row) } catch (e) {}
  })
  // 只有**真的建出 tab** 的才算本实例管理（见 seededTabIds 的说明）。
  tabs.forEach(t => seededTabIds.add(String(t.id)))
  // 上次退出时激活的窗口现在可能是隐藏状态 —— 不能把隐藏窗口设为激活，
  // 否则界面会停在空视图上（标签栏里没有任何高亮项）。
  if (data.activeId && tabs.find(t => t.id === data.activeId && !t.hidden)) activeId = data.activeId
  else {
    const firstVisible = tabs.find(t => !t.hidden)
    activeId = firstVisible ? firstVisible.id : ''
  }
  showHome = data.showHome !== false
  // 全都被隐藏（或没有窗口）时回主页，不能留空视图。
  if (!activeId) showHome = true
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
    try { asyncJson(userFile(WINDOW_BOUNDS_FILE)).set(win.getBounds()) } catch (error) {}
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

// ── API 传输层：连接超时 / 整体兜底 / 错误分类 ────────────────────────
//
// 真机（0.1.20，macOS）复现过：发一条要翻译的消息，客户端白等约 10.4s 后报
// `TRANSLATE_FAILED`。取证结论是请求**根本没到服务端**（nginx 无记录、
// translation_reservations 无预留），底层是 undici 的 `UND_ERR_CONNECT_TIMEOUT`
// —— TCP 连接 10s 内没建起来，而 10s 正是 undici 的**默认连接超时**。
//
// 两个**不能**用的做法（都论证过）：
//   · 给整个翻译请求设 4 秒超时 —— 正常翻译本身要 2.4~3.4s、上游最坏 8s，
//     砍到 4s 会把好请求一起砍掉；
//   · "先建一条 TCP 探一下连通性" —— 那是**另一条连接**：既控制不了 undici 的
//     连接超时（探通了 undici 仍可能卡满 10s），又在每次请求上白加一次握手。
//
// 真正可行的做法：**用我们自己的 undici 发请求，并显式给它的"连接阶段"设超时**。
// `Agent({ connect: { timeout } })` 只管连接建立这一段；响应阶段由
// headersTimeout / bodyTimeout 单独兜底 —— 两段天然分开，互不误伤（GPT 慢响应不会被误杀）。
// 自带 undici 与 Node 内置 fetch 是同一个库，行为一致，差别只在"连接超时归我们管"。
const API_CONNECT_TIMEOUT_MS = 4000
const API_CONNECT_TIMEOUT_FIRST = 8000
const API_TOTAL_TIMEOUT_MS = 30000

// 冷启动首次要现做 DNS 解析 + TLS 握手（还隔着 Cloudflare），4s 预算会误伤；
// 首轮过后回到 4s。与 pingLine 的 PING_TIMEOUT_FIRST 是同一个道理。
// 冷启动首次要现做 DNS 解析 + TLS 握手（还隔着 Cloudflare），4s 预算会误伤；
// 首轮过后回到 4s。与 pingLine 的 PING_TIMEOUT_FIRST 是同一个道理。

/**
 * 出站 HTTP 传输层（连接池 / 超时 / 错误分类）—— 实现见 src/net/api-net.js。
 *
 * 它是纯 Node 模块，不依赖 electron，因此"连接超时到底算哪类错误"这种判断
 * 可以直接单测，不必切片 main.js 源码。
 */
const apiNet = require('./src/net/api-net').createApiNet({
  timeouts: {
    connectFirstMs: API_CONNECT_TIMEOUT_FIRST,
    connectMs: API_CONNECT_TIMEOUT_MS,
    totalMs: API_TOTAL_TIMEOUT_MS
  },
  getLog: () => clientLog
})

/** 惰性取到自带的 undici；取不到则退回全局 fetch（连接超时退化为不可控，但绝不崩）。 */
function apiTransport() {
  return apiNet.transport()
}

/**
 * 取本进程共用的 dispatcher。
 *
 * 冷 / 热两个 Agent 的取舍见 src/net/api-net.js 顶部。
 */
function apiDispatcher() {
  return apiNet.dispatcher()
}

/** 退出时收掉连接池，别把 keep-alive 的 socket 留在进程里。 */
function closeApiAgents() {
  apiNet.close()
}

/** 真正发一次请求：优先自带 undici（连接超时可控），否则退回全局 fetch。 */
function apiRaw(url, init) {
  return apiNet.raw(url, init)
}

/**
 * 连接建立阶段**可以安全自动重试**的错误码。
 *
 * 只收"请求还没发出去"的那几种：DNS 解析失败、TCP 连接被拒 / 不可达 / 连接建立超时。
 * 故意**不收** ECONNRESET / EPIPE / UND_ERR_SOCKET —— 它们发生在连接建立之后，
 * 请求可能已经到服务端了，属于"是否送达不确定"，不允许盲目重发。
 *
 * 实现见 src/translate/translation-cache.js 的 isRetryableNetworkError（同一份实现，
 * 纯 Node 可单测）。
 */

/** 造一个带错误码 + 取证信息的异常，并落一条日志（只含非敏感字段）。 */
/** 造一个带错误码 + 取证信息的异常，并落一条日志（只含非敏感字段）。 */
function apiFailure(code, message, info) {
  return apiNet.failure(code, message, info)
}

/** 分类一次**没拿到 HTTP 响应**的传输失败：整体超时 vs 连接不可达。 */
function classifyTransportError(err, baseInfo) {
  return apiNet.classify(err, baseInfo)
}

async function api(pathname, opts) {
  const base = safeApiUrl(apiBase)
  if (!base) throw new Error('API 线路不符合安全策略')
  const options = opts || {}
  const method = String(options.method || 'GET')
  const headers = { Accept: 'application/json' }
  const cookieHeader = Object.keys(cookieJar).map(name => `${name}=${cookieJar[name]}`).join('; ')
  if (cookieHeader) headers.Cookie = cookieHeader
  headers['X-Pix-Device'] = deviceId()
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
    const csrf = cookieJar['__Host-pix_csrf'] || cookieJar.pix_csrf
    if (csrf) headers['X-CSRF-Token'] = csrf
  }
  let body
  if (options.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(options.form).toString()
  }
  const started = Date.now()
  // 取证字段：只放"哪个请求、走到哪一步、底层报了什么"，不含任何凭据。
  const trace = { path: pathname, method: method, requestId: options.requestId || '' }

  // 直接发请求，**不做任何额外的连通性预检**（那是另一条连接，既控不住超时又白增开销）。
  // 连接超时由 apiRaw() 里的 undici Agent 在"连接阶段"独立控制；
  // 这里的总超时只是最后的兜底，绝不用来卡正常的慢翻译。
  let res
  try {
    const init = { method: method, headers: headers, body: body }
    const rawTotal = options.totalTimeoutMs
    const totalMs = rawTotal === 0 ? 0 : (Number(rawTotal) || API_TOTAL_TIMEOUT_MS)
    if (totalMs > 0) init.signal = AbortSignal.timeout(totalMs)
    res = await apiRaw(base + '/apis' + pathname, init)
  } catch (err) {
    throw classifyTransportError(err, Object.assign({}, trace, {
      elapsedMs: Date.now() - started
    }))
  }
  // 拿到了响应头 = 连接确实建立过，之后的请求可以吃"热"预算（4s）。
  apiNet.markWarm()
  rememberCookies(res)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch (e) {
    // 拿到 HTTP 响应了，只是 body 不是 JSON —— 这是"服务端返回异常"，不是网络不可达。
    throw apiFailure('SERVER_BAD_RESPONSE', '服务器返回异常，请稍后重试', Object.assign({}, trace, {
      phase: 'parse', gotResponse: true, httpStatus: res.status,
      elapsedMs: Date.now() - started, errName: e.name || '',
      causeCode: '', causeMessage: String(e.message || '')
    }))
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

function normalizeTabSettings(settings) {
  const s = Object.assign({}, settings || {})
  if (s.showTransBar === undefined) s.showTransBar = true
  if (s.enableSendTranslate === undefined) s.enableSendTranslate = s.enableTranslate !== false
  if (s.enableRecvTranslate === undefined) s.enableRecvTranslate = s.enableTranslate !== false
  s.groupMode = groupModeOf(s)
  return s
}

/**
 * 渲染层的实例列表载荷（实现见 src/window/tab-payload.js）。
 *
 * 每个字段都对应渲染层的一处展示，算错不会抛错、只会让界面静默失准：
 * hidden 漏了 → 隐藏窗口重新出现在标签栏；bridgeDown 漏了 → 翻译桥断了
 * 但看起来一切正常（0.1.12 就这样坑过）。
 */
const tabPayloadApi = require('./src/window/tab-payload').createTabPayload({
  state: tabState,
  profileOf: () => profile,
  // 惰性取：bridgeHealth 在文件更靠后的位置才初始化（且是 Map），
  // 这里直接传值会踩 TDZ。用 getter 把"什么时候取"推迟到真正调用时。
  bridgeHealth: { get: id => bridgeHealth.get(id) }
})

function tabTransPayload(tab) {
  return tabPayloadApi.tabTransPayload(tab)
}

function tabPayload() {
  return tabPayloadApi.payload()
}

function sendTabs() {
  syncGlobalUnread()
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

/**
 * 视图几何与布局计划（实现见 src/window/view-layout.js）。
 *
 * 真正会算错的只有纯数据部分：y 从哪来、高度为什么扣 FOOTER、
 * 什么时候全摘。它们算错了不抛错，只表现为"底部被截一条""切换后空白"，
 * 真机上极难定位 —— 所以提成纯函数单独钉住。
 * Electron 那一层（attach / detach / setBounds）仍留在这里。
 */
const viewLayout = require('./src/window/view-layout')

function chromeOffset() {
  return viewLayout.chromeOffset({
    hasMeasuredChrome: hasMeasuredChrome,
    measuredChromeHeight: measuredChromeHeight,
    wantsTransBar: activeWantsTransBar(),
    hasMeasuredBarHeight: hasMeasuredBarHeight,
    measuredTransBarHeight: measuredTransBarHeight,
    wantsStatus: activeWantsStatus(),
    sizes: {
      tabs: TABS_HEIGHT,
      utility: UTILITY_HEIGHT,
      transBar: TRANS_BAR_HEIGHT,
      status: STATUS_HEIGHT
    }
  })
}

let chromeAnim = null
const CHROME_ANIM_MS = 420

function easeOutCubic(t) {
  return viewLayout.easeOutCubic(t)
}

function stopChromeAnim() {
  if (!chromeAnim) return
  clearInterval(chromeAnim)
  chromeAnim = null
}

function applyViewBounds(y, attach) {
  if (!win || win.isDestroyed()) return
  const plan = viewLayout.planLayout({
    tabs: tabs,
    activeId: activeId,
    overlayOpen: overlayOpen,
    showHome: showHome
  })
  if (plan.detachAll) {
    plan.detach.forEach(tab => detachView(tab.view))
    return
  }
  const size = win.getContentSize()
  const bounds = viewLayout.viewBounds({
    y: y,
    width: size[0],
    height: size[1],
    footerHeight: FOOTER_HEIGHT
  })
  plan.detach.forEach(tab => detachView(tab.view))
  if (plan.active) {
    plan.active.view.setBounds(bounds)
    if (attach) attachView(plan.active.view)
  }
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
  // 复核定时器也要清 —— 否则它会在 tab 销毁后才触发。
  // 虽然回调里有 `tabs.includes(tab)` 兜底，但让一个已销毁 tab 的定时器
  // 白白挂着 82 秒，等于平白多占一份资源，正是 0.1.30 清理句柄泄漏的思路。
  if (tab.bridgeDeadTimer) {
    clearTimeout(tab.bridgeDeadTimer)
    tab.bridgeDeadTimer = null
  }
  bridgeHealth.delete(tab.id)
  stopSshTunnel(tab)
  // releaseSocksRelay 是 async（relay.close() 要等监听端口真正释放）。
  // 不接住这个 promise 的话，它里面的异步收尾会漂浮在事件循环上 ——
  // 端口与句柄晚一步才还，而用户可能马上就开下一个实例。
  const released = releaseSocksRelay(tab)
  if (released && typeof released.catch === 'function') released.catch(() => {})
  detachView(tab.view)
  try {
    // 先摘监听器再销毁：销毁后仍挂着的监听器会一直持有该 webContents 的引用，
    // 让本该回收的原生对象多活很久（句柄也就跟着多占一份）。
    const wc = tab.view && tab.view.webContents
    if (wc && typeof wc.removeAllListeners === 'function') wc.removeAllListeners()
  } catch (e) {}
  try {
    tab.view.webContents.destroy()
  } catch (e) {}
  // 断开对 view 的引用，让 JS 侧对象图尽早可回收。
  try { tab.view = null } catch (e) {}
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
  // 隐藏的窗口不在标签栏上，点它等于"把它叫回来"，必须先恢复再激活。
  // 不这样处理的话会切到一个没挂在视图树上的窗口 —— 界面一片空白。
  if (tab.hidden) return showHiddenTab(id)
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

const { hideTab, showHiddenTab } = require('./src/window/hidden-tab-ops').createHiddenTabOps({
  state: tabState,
  detachView: view => detachView(view),
  layoutViews: () => layoutViews(),
  sendTabs: () => sendTabs(),
  saveOpenApps: () => saveOpenApps(),
  animateChromeTo: y => animateChromeTo(y),
  chromeOffset: () => chromeOffset(),
  switchTab: id => switchTab(id),
  unreadFromTitle: title => unreadFromTitle(title)
})

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

/**
 * 实例翻译偏好（解析实现在 src/window/instance-prefs.js）。
 *
 * 这些默认值关系到两件事，都不容出错，所以搬成纯函数单测：
 *   · 群组三态缺省是 manual —— 算错等于给老用户打开自动扣费；
 *   · 沉降窗默认 60ms 是**最短**确认窗 —— 算错等于每次发送凭空多等几百毫秒。
 */
const instancePrefs = require('./src/window/instance-prefs')

function settingOn(settings, key) {
  return instancePrefs.settingOn(settings, key)
}

const GROUP_MODES = instancePrefs.GROUP_MODES

function groupModeOf(settings) {
  return instancePrefs.groupModeOf(settings)
}

function resolveGroupEnabled(settings, accountPrefs) {
  return instancePrefs.resolveGroupEnabled(settings, accountPrefs)
}

function pickLang(value, fallback) {
  return instancePrefs.pickLang(value, fallback)
}

function guestPrefs() {
  return instancePrefs.accountPrefs(profile)
}

const SEND_SETTLE_FLOOR_MS = instancePrefs.SEND_SETTLE_FLOOR_MS
const SEND_SETTLE_CEILING_MS = instancePrefs.SEND_SETTLE_CEILING_MS

function tabPrefs(tab) {
  return instancePrefs.tabPrefs(tab, profile)
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

/**
 * 翻译缓存与幂等键（实现见 src/translate/translation-cache.js）。
 *
 * 依赖用注入而不是闭包：这样它不必加载 electron，普通 Node 即可单测 ——
 * 幂等键算错就是用户被重复扣费，这个逻辑最需要测试。
 */
const transCacheModule = require('./src/translate/translation-cache')
const transCacheApi = transCacheModule.createTranslationCache({
  currentUser: () => currentPixUser(),
  deviceId: () => deviceId()
})
const { isDeadRequest, isRetryableNetworkError } = transCacheModule

function transCacheKey(from, to, engine, text) {
  return transCacheApi.cacheKey(from, to, engine, text)
}

function getTransCached(from, to, engine, text) {
  return transCacheApi.get(from, to, engine, text)
}

function putTransCached(from, to, engine, text, translation) {
  transCacheApi.put(from, to, engine, text, translation)
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
 *
 * 实现见 src/translate/translation-cache.js（纯 Node，不依赖 electron，可单测）。
 */
function transFingerprint(text, from, to, engine) {
  return transCacheApi.fingerprint(text, from, to, engine)
}

function transRequestId(text, from, to, engine) {
  return transCacheApi.requestId(text, from, to, engine)
}

/** 换一代：让下一次重试拿到全新的 Idempotency-Key。 */
function bumpTransAttempt(text, from, to, engine) {
  transCacheApi.bumpAttempt(text, from, to, engine)
}

/**
 * 发一次 /translate/run，失败按类型决定是否重发 —— 实现在
 * src/translate/translation-cache.js 的 createRequestTranslate。
 *
 * 抽出去的理由和前一段一样：这段逻辑涉及资金（重复扣费 / 永久 409），
 * 必须能被单测直接覆盖，而不是靠"切片源码 + 手拼依赖"。
 */
const requestTranslateImpl = transCacheModule.createRequestTranslate({
  api: (pathname, opts) => api(pathname, opts),
  cache: transCacheApi,
  getLog: () => clientLog
})

async function requestTranslate(text, from, to, engine, trigger) {
  return requestTranslateImpl(text, from, to, engine, trigger)
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
//
// ## ★ 为什么是「先复核、再判死」（0.1.31 真机日志的教训）★
//
// 原实现只有一个 8000ms 的死线：到点没收到 guest 的 prefs 询问就**立刻**判死，
// 写一条 ERROR 并在页面上画常驻警告条。
//
// 真机日志（用户开了 54 个实例，见 2026-10-16 的 hello-pix 日志）证明这是**误报**：
//
//     实例            报「未启动」      实际就绪        延迟
//     green-39        20:02:54        20:26:47       1433s
//     green-48        20:22:28        20:25:26        178s
//     green-25        19:30:00        19:32:01        120s
//     ...
//     43 个实例报过「未启动」，其中 42 个后来**都就绪了**；中位延迟 28 秒
//
// 也就是说：**桥没坏，只是慢。** 54 个渲染进程同时装载时，CPU/磁盘被瓜分，
// preload 跑完 exec + 首次 IPC 远远不止 8 秒。
//
// 而这个误报的代价很大 —— 看 bridgeReport 里的文案，它会让用户以为
// 「按回车就会把原文直接发出去」，于是**不敢用**；侧边栏还会挂一个 ⚠。
// 42 个实例白挂警告，用户对整个软件的信任就没了。
//
// 所以改成两段：
//   ① **软线**（BRIDGE_PROBE_MS）：到点还没消息 → 只记 debug，**不判死、不告警**。
//   ② **硬线**（BRIDGE_DEAD_MS）：再等一段仍无消息 → 才判"真未启动"并告警。
//
// 为什么硬线不是简单地把 8 秒改成很大：真坏（preload 装载即抛错）时，
// 用户越早知道越好 —— 8 秒那次仍有价值，只是**结论要等复核**。
// 而且装载期就报错的路径（`__pixPreloadError`）**依然是立即判死**，不受影响：
// 那是确凿证据，不需要等。
const BRIDGE_PROBE_MS = 8000

/**
 * 判"真未启动"的硬线。到这条线仍无消息才写 ERROR、画警告条。
 *
 * 取值依据：真机日志里 42/43 个实例最终都就绪，其中位延迟 28 秒、
 * 第 90 百分位约 2 分钟。取 90 秒是**折中**：
 *   · 够覆盖绝大多数"只是慢"（中位 28s 的 3 倍）；
 *   · 又不至于让真正坏掉的实例拖几十分钟才告诉用户。
 * 超过 90 秒仍未通的（日志里 green-39 用了 1433s），属于极端拥塞，
 * 那种情况下面向用户的告警本来也该出现 —— 只是文案要说清"还在加载"。
 */
const BRIDGE_DEAD_MS = 90000

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
 * 定时器 unref，不阻止进程退出。
 *
 * 两段判定（见 BRIDGE_PROBE_MS / BRIDGE_DEAD_MS 顶部说明）：
 *   · 8 秒没消息 → **只记 debug，不判死**（并发装载时这是常态，不是故障）
 *   · 90 秒仍没消息 → 才判"真未启动"，写 ERROR 并画警告条
 *   任何时刻收到 guest 的消息，两个定时器都会作废（bridgeReport(ok=true)）。
 */
function watchdogBridge(tab) {
  if (!tab || !tab.id) return
  // 幂等：重复调用（重载 / 重建 tab）时先作废上一轮的两个定时器。
  // 不清的话，旧定时器仍会按"上一轮"的 deadline 触发，可能给一个刚
  // 重新装载、正在正常握手的 tab 扣上"未启动"。
  if (tab.bridgeTimer) { clearTimeout(tab.bridgeTimer); tab.bridgeTimer = null }
  if (tab.bridgeDeadTimer) { clearTimeout(tab.bridgeDeadTimer); tab.bridgeDeadTimer = null }
  // 没挂翻译桥的页面（自定义网页 / 工单 / LINE 扩展）本来就不会来握手，不能报"桥没起来"。
  if (!bridgeEnabledFor(tab.item)) return
  // 装载期就已经报错了：立刻上报，不用等满 8 秒。
  // 这是**确凿证据**（preload 自己抛错），不需要走"先复核"那套。
  const wc = tab.view && tab.view.webContents
  if (wc && wc.__pixPreloadError) {
    bridgeReport(tab.id, false, wc.__pixPreloadError)
    return
  }
  // ① 软线：到点还没消息，先不当回事 —— 只在日志留一行 debug。
  //
  //    为什么不在这里写 WARN 或 ERROR：并发装载时"慢"是常态（真机中位 28 秒），
  //    写成错误会让日志被 43 条假故障淹没，真正的问题反而看不见。
  tab.bridgeTimer = setTimeout(() => {
    tab.bridgeTimer = null
    const st = bridgeHealth.get(tab.id)
    if (st && st.ok === true) return
    if (!tabs.includes(tab)) return
    if (clientLog) {
      clientLog.debug('preload', '实例 ' + tab.id + ' 的翻译桥 ' +
        Math.round(BRIDGE_PROBE_MS / 1000) + ' 秒内还没消息，继续观察（并发装载时常见）')
    }
    // ② 硬线：再守一段，仍无消息才判"真未启动"。
    tab.bridgeDeadTimer = setTimeout(() => {
      tab.bridgeDeadTimer = null
      const now = bridgeHealth.get(tab.id)
      if (now && now.ok === true) return
      if (!tabs.includes(tab)) return
      const wcNow = tab.view && tab.view.webContents
      const secs = Math.round(BRIDGE_DEAD_MS / 1000)
      // 复核时再查一次 preload 错误 —— 若这时拿到了确凿原因，就报真正的原因，
      // 而不是笼统的"没通信"（对用户排障更有用）。
      const detail = (wcNow && wcNow.__pixPreloadError)
        ? wcNow.__pixPreloadError
        : ('预加载脚本装载后 ' + secs + ' 秒内没有与主进程通信（很可能装载就报错了）')
      bridgeReport(tab.id, false, detail)
    }, Math.max(0, BRIDGE_DEAD_MS - BRIDGE_PROBE_MS))
    if (tab.bridgeDeadTimer.unref) tab.bridgeDeadTimer.unref()
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
//
// ★ 同一节点（host/port/账密全同）的所有窗口**共用一个中继实例** ★
//
// 原先是「一窗口一中继」，每个窗口都向节点开一条独立的 SOCKS5 控制连接。
// 真机反馈过一个症状：账号开到一定数量后新窗口连不上。除了系统资源，
// 还有一个容易被忽略的原因 —— **商业代理常常限制单账号的并发连接数**，
// 60 个窗口就是 60 条到节点上游的连接，节点侧可能直接开始拒绝。
//
// 同类产品（比特浏览器）就是共享的：同一节点复用同一个本地端口
// （`md5(host+port+user+pass)` 做 key，端口从 5550 起递增）。
//
// ## 为什么不直接共享
//
// `createSocksRelay().close()` 会**销毁该中继上的所有 socket**（见其实现）。
// 如果两个窗口共用一个实例，窗口 A 关闭时一次 `close()` 会把窗口 B 的连接一起掐掉。
// 所以这里必须做**引用计数**：每个 tab 持有一份租约，最后一个租约归还时才真正 close。
//
// ## 隔离性没有被削弱
//
// 共享的前提是 key 完全一致 —— host、port、账号、密码四项一字不差。
// 不同线路/不同账号永远落在不同的 key 上，不可能串凭据。
const socksRelays = new Map()   // tab.id -> { key, endpoint, lease }
const relayPool = new Map()     // key -> { relay, endpoint, starting, refs }

function relayKeyOf(target) {
  return [target.host, target.port, target.user, target.pass].join('\u0001')
}

async function releaseSocksRelay(tab) {
  if (!tab) return
  const cur = socksRelays.get(tab.id)
  if (!cur) return
  socksRelays.delete(tab.id)
  const entry = relayPool.get(cur.key)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs > 0) return          // 还有别的窗口在用，不能关
  relayPool.delete(cur.key)
  try { await entry.relay.close() } catch (e) {}
}

async function ensureSocksRelay(tab, target) {
  const key = relayKeyOf(target)
  const cur = socksRelays.get(tab.id)
  if (cur && cur.key === key) return { endpoint: cur.endpoint }
  // 这个 tab 换了节点：先归还旧租约（可能连带关闭旧中继）
  await releaseSocksRelay(tab)

  let entry = relayPool.get(key)
  if (!entry) {
    const relay = createSocksRelay({
      host: target.host,
      port: target.port,
      user: target.user,
      pass: target.pass,
      onError: () => {}
    })
    entry = { relay: relay, endpoint: '', starting: null, refs: 0 }
    relayPool.set(key, entry)
    entry.starting = relay.start().then(info => {
      entry.endpoint = '127.0.0.1:' + info.port
      return entry.endpoint
    }).catch(err => {
      // 起不来就把池里的空壳清掉，否则后续窗口会拿到一个永远 pending 的实例。
      if (relayPool.get(key) === entry) relayPool.delete(key)
      throw err
    })
  }
  const endpoint = await entry.starting
  entry.refs += 1
  socksRelays.set(tab.id, { key: key, endpoint: endpoint, lease: true })
  return { endpoint: endpoint }
}

/** 仅供测试/诊断：当前池状态。 */
function relayPoolStats() {
  return {
    keys: relayPool.size,
    tabs: socksRelays.size,
    entries: Array.from(relayPool.entries()).map(([k, v]) => ({ key: k.split('\u0001').slice(0, 2).join(':'), refs: v.refs }))
  }
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

/**
 * IP 归属地查询（实现见 src/proxy/ip-geo.js）。
 *
 * 四个通道字段名各不相同，以前只能靠真机点一次"节点检测"验证。
 * 拆出来之后每个通道的解析都能单独测。
 */
const ipGeo = require('./src/proxy/ip-geo').createIpGeo({
  sessionGetText,
  getDefaultSession: () => session.defaultSession,
  parseJsonSafe,
  onError: (channel, e) => {
    if (clientLog) clientLog.warn('proxy', '归属地查询失败（' + channel + '）：' + ((e && e.message) || String(e)))
  }
})

const lookupIpGeo = ipGeo.lookupIpGeo

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

/**
 * 在一个隐藏窗口里加载 `url`（走指定 session 的代理），把页面正文读回来。
 *
 * ## ★ 清理必须"温柔"（0.1.29 修的真机缺陷）★
 *
 * 真机复现：当代理上游**连得上但不回话**时，Chromium 会一直卡在 SOCKS5 握手，
 * `did-finish-load` / `did-fail-load` / `render-process-gone` **一个事件都不触发**。
 * 此时若直接 `wc.destroy()` + `win.destroy()`，会把 Electron 的渲染进程基础设施弄坏
 * （实测：`MachPortRendezvousServer ... No rendezvous client, terminating process`），
 * **之后整个应用再也创建不出可用窗口** —— 用户看到的就是"节点检测永远在转圈"。
 *
 * 所以清理分两步：
 *   1. 先 `stop()` 让加载**优雅中止**（给 Chromium 一个收口的机会），
 *      并解除所有监听 —— 我们不再关心它的任何后续事件；
 *   2. **延迟**再销毁窗口，且销毁包在 try 里。
 *
 * 这只是第二道保险：正常情况下真正的防线是 detectProxyNode 里的
 * `precheckSocks5()`（不可用的节点根本不会走到这里、不会创建窗口）。
 */
/**
 * 代理节点检测（实现见 src/proxy/detect.js）。
 *
 * 全仓踩坑最多的一段：0.1.29 的"卡在握手把渲染基础设施弄坏"、
 * 0.1.33 的"预检越权否决导致以前能用的节点全被判死"都在这里。
 * 搬出去之后它终于能单独测了。
 */
const proxyDetect = require('./src/proxy/detect').createProxyDetect({
  electron: { BrowserWindow, session },
  maps: { probeWindows, proxyAuthByWebContents },
  libs: {
    readPageText,
    precheckSocks5,
    createSocksRelay,
    proxyTargetOf,
    proxyAuthOf,
    proxyRulesOf,
    lookupIpGeo,
    parseJsonSafe
  },
  io: {
    // 惰性取：clientLog 在启动时才赋值，直接传值会永远是 null
    log: () => clientLog,
    noteProxyIp
  },
  env: { PROBE_TIMEOUT_MS }
})

const probeTextWithProxy = proxyDetect.probeTextWithProxy
const detectProxyNode = proxyDetect.detectProxyNode

// applySessionProxy 的实现已移到 ./proxy-settings.js。
// 这里不再保留第二份 —— 由 applyTabProxy 统一调度「ssh 隧道 → 写 session」。

/**
 * 内置扩展目录（如 LINE 官方扩展）。打包后在 resources/<name>-ext（extraResources，
 * 不进 asar —— Chromium 直接读扩展文件，asar 里的读不到）；开发时在 desktop/vendor/。
 */
function platformExtensionDir(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, name + '-ext')
    : path.join(__dirname, 'vendor', name + '-ext')
}

/** 每个分区只装一次；装载失败不缓存，下次打开会重试。 */
const extensionLoads = new Map()

function ensurePlatformExtension(tab) {
  const name = tab && tab.item && tab.item.extension
  if (!name) return Promise.resolve()
  const extId = PLATFORM_EXTENSION_IDS[name]
  const key = tab.partition + '|' + name
  if (!extensionLoads.has(key)) {
    const job = (async () => {
      const ses = session.fromPartition(tab.partition)
      const host = ses.extensions || ses
      if (typeof host.getExtension === 'function' && host.getExtension(extId)) return
      const ext = await host.loadExtension(platformExtensionDir(name))
      if (!ext || ext.id !== extId) throw new Error('扩展 ID 不符：' + (ext && ext.id))
    })()
    job.catch(e => {
      extensionLoads.delete(key)
      if (clientLog) clientLog.error('extension', name + ' 扩展装载失败：' + ((e && e.message) || e))
    })
    extensionLoads.set(key, job)
  }
  return extensionLoads.get(key)
}

function startTabLoad(tab) {
  if (!tab || !tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return
  // 新建线路 / 重启恢复走这里；修改已存在线路的代理走 updateTabSettings。
  // 两条路径都必须经过 applyTabProxy，否则又会退回"改了不生效"的老缺陷。
  applyTabProxy(tab, tabProxyDeps()).finally(() => {
    // 扩展承载的平台（LINE）：扩展必须先装进该分区，否则 chrome-extension:// 页面打不开。
    ensurePlatformExtension(tab).catch(() => {}).then(() => {
      if (!tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return
      // ★ 加载失败必须有兜底 ★
      //
      // 真机取证（2026-10-16）：用户那台机器连我们后端都连不上
      // （/client/session 多次 UND_ERR_CONNECT_TIMEOUT，目标 IP 是 Cloudflare），
      // 表现是"有的窗口黑屏、有的能扫码"。原先这里只有一句 loadURL，
      // **没有 catch、也没有 did-fail-load** —— 失败后 Chromium 什么都不画，
      // 用户只看到 createWebView 设的深色背景，于是把网络问题当成软件故障。
      //
      // 这里接住它：显示一个能自己重试的错误页，把"是什么问题 + 该做什么"说清。
      const job = tab.view.webContents.loadURL(tab.url)
      if (job && typeof job.catch === 'function') {
        job.catch(err => {
          // loadURL 的 reject 与 did-fail-load 会同时到达；由 paintLoadError 内部的
          // 去重保证只画一次（否则会重复导航）。
          const code = (err && (err.code || err.errno)) || -2
          paintLoadError(tab, code, (err && err.message) || '')
        })
      }
    })
  })
}

/**
 * 画"加载失败"错误页。
 *
 * ## 必须去重
 *
 * 一次失败会**同时**从两个地方到达：`loadURL()` 的 promise reject，
 * 以及 `did-fail-load` 事件。两边都画就会连续导航两次 —— 表现为
 * 错误页一闪、甚至又触发一次失败，形成抖动。
 * 所以用 `tab.loadErrorUrl` 记住"当前已经画的是哪个错误页"，重复的直接跳过。
 *
 * ## 必须防止"错误页自己也失败 → 无限递归"
 *
 * 错误页是 `data:` URL，正常不会再失败。但如果它真的失败了，
 * 我们不能再去画错误页（那会无限循环）。判据是 `webContents.getURL()`
 * 已经是个 data: URL 时就直接放弃，只留日志。
 */
function paintLoadError(tab, code, desc) {
  if (!tab || !tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return
  // ERR_ABORTED 不是失败（被新导航取代 / 用户主动停止）——与既有实现同一口径。
  if (!loadErrorPage.shouldShowErrorPage(code)) return
  const wc = tab.view.webContents
  // 已经在错误页上就不要再画（防递归）。
  let current = ''
  try { current = String(wc.getURL() || '') } catch (e) {}
  if (current.indexOf('data:text/html') === 0) return

  const page = loadErrorPage.buildLoadErrorPage({
    code: code,
    desc: desc,
    url: tab.url,
    platformName: tab.name
  })
  if (clientLog) {
    // 记 warn 而不是 error：这是**网络侧**的问题，不是软件缺陷。
    // 但要留下足够的现场（哪个实例、什么码、什么地址），否则事后仍只能靠复述。
    clientLog.warn('load', '实例 ' + tab.id + ' 页面加载失败（错误码 ' + code + '）' +
      (desc ? '：' + desc : '') + ' → 已显示可重试的错误页')
  }
  tab.loadErrorUrl = page
  const job = wc.loadURL(page)
  if (job && typeof job.catch === 'function') job.catch(() => {})
}

/** 翻译桥（guest-inject.js）只挂在已适配的网页平台上。 */
function bridgeEnabledFor(item) {
  return !!item && !item.customUrl && item.id !== 'tickets' && !item.extension
}

/* ---------------------------------------------------------------------------
   译文/正文的复制、粘贴、全选（P0：多开窗口里选不中、复制不出来）

   ## 真机现象
   在聊天窗口（WhatsApp / Telegram / Line 等）里，中文译文**看得见、选不中**，
   复制更是没反应。

   ## 根因（与 CSS 无关的另一半）
   聊天应用跑在 **WebContentsView** 里，而不是主窗口的 DOM。Electron 里
   `Cmd/Ctrl+C` / `V` / `A` 这些**编辑快捷键不会自动**作用到嵌入的
   webContents —— 它们要靠**应用程序菜单里的编辑角色**（role: 'copy' /
   'paste' / 'selectAll' …）来转发到当前聚焦的 webContents。
   本应用为隐藏菜单栏调了 `setMenuBarVisibility(false)`，且**从未注册任何
   编辑角色**（也没有 setApplicationMenu）。于是：
     · 选中靠 `Cmd+A` / 菜单全选 —— 没有 → 连"全选"都做不到；
     · 复制靠 `Cmd+C` / 菜单复制 —— 没有 → 复制无声失败；
     · 右键菜单 —— WebContentsView 默认**不弹**系统上下文菜单。
   三样全缺，"译文复制不出来"是必然结果。（注入网页里的 CSS/事件修复是**另一半**，
   两者都到位才能真正复制。）

   ## 修法（两条独立通道，互为兜底）
   1. **应用菜单**：给 macOS 装一份含编辑角色的标准菜单（Linux/Windows 用
      `setMenu(null)` + 快捷键事件，见下）。
   2. **WebContentsView 级 before-input-event + 右键菜单**：在每个 view 上直接
      接住 Cmd/Ctrl+C/V/X/A，调用 webContents 的编辑命令。这条路**不依赖菜单**，
      是最稳的兜底 —— 菜单在某些平台/打包方式下可能被系统吞掉，这条不会。
   --------------------------------------------------------------------------- */

/** 对某个 webContents 执行一次编辑动作，带可用性保护。 */
function runEditCommand(wc, action) {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false
  try {
    if (action === 'copy' && typeof wc.copy === 'function') return wc.copy(), true
    if (action === 'paste' && typeof wc.paste === 'function') return wc.paste(), true
    if (action === 'cut' && typeof wc.cut === 'function') return wc.cut(), true
    if (action === 'selectAll' && typeof wc.selectAll === 'function') return wc.selectAll(), true
  } catch (e) {
    if (clientLog) clientLog.warn('edit', action + ' 失败：' + ((e && e.message) || e))
  }
  return false
}

/**
 * 给一个 WebContentsView 的 webContents 装"编辑快捷键 + 右键菜单"。
 *
 * 为什么在 **view 层** 而不是主窗口：快捷键必须作用在**聚焦的那个
 * webContents** 上。多开时可能有多个 view，只有当前聚焦的一个该响应。
 */
function installEditSupport(view) {
  const wc = view && view.webContents
  if (!wc) return
  // 1) 键盘：Cmd/Ctrl+C/V/X/A。用 before-input-event 在**输入进入页面前**接住，
  //    避免被宿主网页自己的 keydown 处理器吞掉（WhatsApp 等会拦一部分快捷键）。
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const mod = process.platform === 'darwin' ? input.meta : input.control
    if (!mod || input.alt) return
    const key = String(input.key || '').toLowerCase()
    if (key === 'c') { if (runEditCommand(wc, 'copy')) event.preventDefault() }
    else if (key === 'v') { if (runEditCommand(wc, 'paste')) event.preventDefault() }
    else if (key === 'x') { if (runEditCommand(wc, 'cut')) event.preventDefault() }
    else if (key === 'a') { if (runEditCommand(wc, 'selectAll')) event.preventDefault() }
  })
  // 2) 右键菜单：WebContentsView 默认不弹系统菜单。用户习惯右键复制/粘贴，
  //    缺了它会以为"复制功能坏了"。
  wc.on('context-menu', (_event, params) => {
    const template = []
    const hasSelection = !!(params && params.selectionText)
    const isEditable = !!(params && params.isEditable)
    if (hasSelection) {
      template.push({ label: '复制', accelerator: 'CmdOrCtrl+C', click: () => runEditCommand(wc, 'copy') })
    }
    if (isEditable) {
      template.push({ label: '剪切', accelerator: 'CmdOrCtrl+X', click: () => runEditCommand(wc, 'cut') })
      template.push({ label: '粘贴', accelerator: 'CmdOrCtrl+V', click: () => runEditCommand(wc, 'paste') })
    }
    if (hasSelection || isEditable) {
      template.push({ type: 'separator' })
      template.push({ label: '全选', accelerator: 'CmdOrCtrl+A', click: () => runEditCommand(wc, 'selectAll') })
    }
    if (!template.length) return
    Menu.buildFromTemplate(template).popup({ window: win })
  })
}

/**
 * 装应用菜单。
 *
 * macOS：必须有一份含编辑角色的菜单 —— 否则 Cmd+C/V/A 不会转发到聚焦的
 * webContents（这是 Electron 在 macOS 上的既有行为，不是 bug）。
 * 保留应用菜单（含退出、隐藏、窗口切换）+ 编辑菜单（撤销/剪切/复制/粘贴/全选）。
 *
 * Windows/Linux：菜单栏用 `setMenu(null)` 隐藏（与既有观感一致），编辑快捷键
 * 完全由 installEditSupport 的 before-input-event 负责。
 */
function installApplicationMenu() {
  if (process.platform !== 'darwin') {
    try { Menu.setApplicationMenu(null) } catch (e) {}
    return
  }
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 Hello Pix' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 Hello Pix' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 Hello Pix' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' }
      ]
    }
  ]
  try { Menu.setApplicationMenu(Menu.buildFromTemplate(template)) } catch (e) {
    if (clientLog) clientLog.warn('menu', '装应用菜单失败：' + ((e && e.message) || e))
  }
}

/**
 * 实例 WebContentsView 工厂（实现见 src/window/web-view.js）。
 *
 * 最关键的是 backgroundThrottling: true —— 它只能在创建时一次写对，
 * 事后 setBackgroundThrottling() 无效。写错的代价是隐藏窗口继续跑满定时器。
 */
const webViewFactory = require('./src/window/web-view').createWebViewFactory({
  electron: { WebContentsView, session },
  state: { get tabs () { return tabs } },
  libs: {
    trustedTabSender,
    bridgeEnabledFor,
    safeModeDisablesBridge,
    isAllowedPlatformUrl,
    pushPrefsToGuest,
    paintLoadError,
    installEditSupport,
    logError: (channel, msg) => { if (clientLog) clientLog.error(channel, msg) },
    logGuestTrace: msg => { if (clientLog) clientLog.info('guest-trace', msg) },
    logGuestWarn: msg => { if (clientLog) clientLog.warn('guest', msg) }
  },
  env: { dirname: __dirname, path, CHROME_UA }
})

const createWebView = webViewFactory.createWebView

/**
 * 资源不足时的提示。
 *
 * ## 为什么用原生对话框而不是渲染层
 *
 * 主界面是 `WebContentsView` **盖**在渲染层之上的原生视图，渲染层弹的东西
 * 会被完全挡住。而这个提示出现的场景恰恰是"窗口已经很多"—— 那时用户
 * 眼前全是实例页面，任何渲染层提示都等于没提示。
 *
 * 只在主窗口存在时弹，并且**不阻塞**（不用 modal 的同步返回）：
 * 用户可能有多个实例在同时收发消息，不能因为一个提示把界面卡住。
 */
function showResourceNotice(message, code) {
  try {
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return
    const { dialog } = electron
    if (!dialog || typeof dialog.showMessageBox !== 'function') return
    // 标题按原因走：用户一眼看到的是"内存"还是"窗口数"，
    // 决定他下一步去关窗口还是去关别的程序。
    const title = code === 'MEMORY_PRESSURE' ? '运行内存不足' : '无法再开新窗口'
    const job = dialog.showMessageBox(win, {
      type: 'warning',
      title: title,
      message: title,
      detail: message,
      buttons: ['知道了'],
      defaultId: 0,
      noLink: true
    })
    if (job && typeof job.catch === 'function') job.catch(() => {})
  } catch (e) {
    if (clientLog) clientLog.warn('resource', '弹资源提示失败：' + ((e && e.message) || e))
  }
}

/**
 * 打开实例（实现见 src/window/open-platform.js）。
 *
 * 顺序：资源预算 → 地址安全策略 → 建视图 → 入列 → 看门狗 → 加载 → 落盘。
 * 预算判断必须在创建任何 Chromium 对象之前，理由见该文件头。
 */
const openPlatformApi = require('./src/window/open-platform').createOpenPlatform({
  state: {
    get tabs () { return tabs },
    get usedCount () { return usedCount },
    get nextTab () { return nextTab },
    set nextTab (v) { nextTab = v },
    get activeId () { return activeId },
    set activeId (v) { activeId = v },
    get showHome () { return showHome },
    set showHome (v) { showHome = v }
  },
  libs: {
    tabBudget,
    effectiveMaxTabs,
    makePartition,
    normalizeTabSettings,
    safePlatformHomeUrl,
    createWebView,
    accountSlug,
    bindTabLoading,
    watchdogBridge,
    startTabLoad,
    layoutViews,
    sendTabs,
    saveOpenApps,
    showResourceNotice,
    logWarn: (channel, msg) => { if (clientLog) clientLog.warn(channel, msg) }
  },
  env: { platforms: fallbackPlatforms }
})

const openPlatform = openPlatformApi.openPlatform

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

/**
 * 主窗口（实现见 src/window/main-window.js）。
 *
 * 关闭 = 隐藏到托盘，但托盘没建出来时必须放行退出 ——
 * 否则窗口藏了又没有任何入口找回来，进程就成了关不掉的僵尸。
 */
const mainWindowApi = require('./src/window/main-window').createWindowModule({
  electron: {
    get BrowserWindow () { return electron.BrowserWindow },
    // 延迟到调用时才取 —— app ready 之前 screen 是 undefined
    getScreen: () => electron.screen
  },
  state: {
    get isQuitting () { return isQuitting },
    get tray () { return tray },
    get backgroundTipShown () { return backgroundTipShown },
    set backgroundTipShown (v) { backgroundTipShown = v }
  },
  libs: {
    restoreWindowBounds,
    scheduleSaveWindowBounds,
    layoutViews,
    backgroundMode,
    backgroundEnabled,
    logWarn: (channel, msg) => { if (clientLog) clientLog.warn(channel, msg) },
    logError: (channel, msg) => { if (clientLog) clientLog.error(channel, msg) }
  },
  env: { dirname: __dirname, path, WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT, APP_ICON }
})

function createWindow () {
  win = mainWindowApi.createWindow()
  return win
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
/**
 * IPC 注册器（实现见 src/ipc/registrar.js）。
 *
 * 所有 handler 都过这一层：来源校验收进注册器，就再也写不出
 * "忘了 isMainSender" 的越权入口。
 */
const ipcReg = require('./src/ipc/registrar').createIpcRegistrar({
  ipcMain, isMainSender, rejectUntrustedSender
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

/**
 * 翻译相关 IPC（实现见 src/ipc/translate.js）。
 *
 * 注意 composer* / guestPrefs / run 是**客页**调用的，走 handleUnsafe +
 * trustedTabSender 自校验 —— 那是另一个来源，不能拿 isMainSender 卡。
 */
require('./src/ipc/translate').registerTranslateIpc({
  reg: ipcReg,
  state: {
    get tabs () { return tabs },
    get profile () { return profile },
    bridgeHealth: { get: id => bridgeHealth.get(id) }
  },
  actions: {
    api,
    pushGuestPrefs,
    trustedTabSender,
    rejectUntrustedSender,
    bridgeReport,
    nativeComposer,
    log: (channel, msg) => { if (clientLog) clientLog.info(channel, msg) },
    getTransCached,
    putTransCached,
    transRequestId,
    requestTranslate
  },
  env: { tabPrefs, stripEmoji, stripBusyMarks, pickLang }
})

/**
 * 标签页操作 IPC（实现见 src/ipc/tabs.js）。
 *
 * 这组碰的最多：tabs / activeId / webContents / 原生菜单 / 落盘。
 * 隐藏不是关闭 —— 隐藏要保留进程和登录态，从 tabs 里删掉才是关闭。
 */
require('./src/ipc/tabs').registerTabsIpc({
  reg: ipcReg,
  state: {
    get tabs () { return tabs },
    get activeId () { return activeId },
    set overlayOpen (v) { overlayOpen = v }
  },
  actions: {
    tabPayload,
    openPlatform,
    closeTab,
    switchTab,
    hideTab,
    showHiddenTab,
    // 惰性取：这个工厂的 const 声明在下面，直接引用会撞 TDZ
    popupTabContextMenu: payload => popupTabContextMenu(payload),
    goHome,
    readPresets: () => readJson(userFile('app-presets.json'), {}),
    writePresets: all => writeJson(userFile('app-presets.json'), all),
    sendTabs,
    saveOpenApps,
    updateTabSettings,
    layoutViews,
    relaunchAndExit: () => { app.relaunch(); app.exit(0) }
  },
  env: { sealSettings, stripProxyFields, proxySettingsOf }
})

/**
 * 应用级 IPC（实现见 src/ipc/app.js）：平台、预设模板、版本更新、客户线索。
 *
 * 预设模板绝不能带代理 —— 那是实例级敏感配置，带进去就是下个实例
 * 在别人的出口上聊。customer:* 归客页调用，走 handleUnsafe 自校验。
 */
require('./src/ipc/app').registerAppIpc({
  reg: ipcReg,
  actions: {
    api,
    sendKicked,
    platformRows,
    refreshPlatformUpdates,
    updatePlatformWeb,
    readPresets: () => readJson(userFile('app-presets.json'), {}),
    writePresets: all => writeJson(userFile('app-presets.json'), all),
    trustedTabSender,
    accountSlug
  },
  env: {
    APP_VERSION,
    DOWNLOAD_HOSTS,
    isAllowedExternalUrl,
    unsealSettings,
    sealSettings,
    stripProxyFields
  }
})

/**
 * 账号相关 IPC（实现见 src/ipc/auth.js）。
 *
 * profile / cookieJar 必须 setter 直连：写错就是掉号或串号。
 */
require('./src/ipc/auth').registerAuthIpc({
  reg: ipcReg,
  state: {
    get profile () { return profile },
    set profile (v) { profile = v },
    set cookieJar (v) { cookieJar = v }
  },
  actions: {
    publicAuth,
    saveAuth,
    loadStoredAuth,
    loginWithCredentials,
    clearTabs,
    sendKicked,
    sendSession,
    api
  },
  env: { timingEqual }
})

/**
 * 配置 / 线路 / 站点相关 IPC（实现见 src/ipc/config.js）。
 *
 * state 是实时代理：getter/setter 直连下面的模块级变量。
 * 传快照会出事 —— 切完主题 main.js 里那份没变，下次 config:get 又读回旧值。
 */
require('./src/ipc/config').registerConfigIpc({
  reg: ipcReg,
  state: {
    get apiBase () { return apiBase },
    set apiBase (v) { apiBase = v },
    get theme () { return theme },
    set theme (v) { theme = v },
    get lineId () { return lineId },
    set lineId (v) { lineId = v },
    get backgroundRunning () { return backgroundRunning },
    get lines () { return lines },
    get proxyPresets () { return proxyPresets }
  },
  env: { safeApiUrl, DEFAULT_API, fetchFrom, isAllowedExternalUrl, EXTERNAL_HOSTS },
  actions: {
    saveConfig,
    setBackgroundRunning,
    currentLine,
    refreshLines,
    applyLine,
    pingLine,
    pingAllLines,
    openExternal: url => shell.openExternal(url),
    detectProxyNode
  }
})

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

/**
 * 标签栏右键菜单（实现见 src/window/tab-context-menu.js）。
 *
 * 隐藏和关闭必须分开 —— "关闭"那一组离手指太近，
 * 把"隐藏"放进去，误点会把正在收消息的窗口藏掉。
 */
const tabContextMenu = require('./src/window/tab-context-menu').createTabContextMenu({
  electron: { Menu, app },
  state: {
    get win () { return win },
    get tabs () { return tabs }
  },
  libs: { openLogDir, hideTab, openProxySettingsFor, updatePlatformWeb }
})

const popupTabContextMenu = tabContextMenu.popupTabContextMenu

/**
 * 读取一条线路当前的代理配置，供「代理设置」弹窗回填。
 *
 * 只回传代理字段（proxySettingsOf），不把整份 settings 抖给渲染层。
 * proxyPass 在内存里本就是明文（与新建线路时一致），弹窗需要它回填 ——
 * 这与「新增应用」弹窗从预设回填密码的行为保持一致；
 * 落盘时仍由 saveOpenApps 走 sealSettings 加密。
 */
app.whenReady().then(() => {
  applyAppIdentity()
  // 必须在 applyAppIdentity() 之后：日志目录由 app name 推导（见 initClientLog）。
  const log = initClientLog()
  if (log) {
    log.info('app', '启动 Hello Pix v' + app.getVersion() + ' · ' + process.platform + ' ' + process.arch +
      ' · electron ' + process.versions.electron)
    log.info('app', '日志目录：' + log.dir)
  }
  // 上次若是异常退出（闪退），把崩溃痕迹送到服务器 —— 用户无感。
  // 放在拿到槽位之前：它不依赖任何窗口状态，且越早发出越不容易被后续
  // 的初始化失败连累（启动即崩的场景，这段代码本身也可能跑不完）。
  reportCrashIfNeeded(log)
  // 槽位必须在任何 webview 之前拿到 —— 分区名依赖它。
  const handle = acquireInstanceSlot()
  console.log('[hello-pix] 多开槽位 =', handle.slot,
    handle.file ? '' : '（槽位已满，本次使用一次性分区）')
  try { fs.rmSync(userFile('translate-cache.json'), { force: true }) } catch (e) {}
  loadConfig()
  // 应用菜单：macOS 上 Cmd+C/V/A 依赖菜单的编辑角色才能转发到 webContents。
  // 必须在建窗口之前装好，窗口一出现快捷键就可用。
  installApplicationMenu()
  // 托盘要先于窗口建好：关闭拦截依赖 `tray` 是否为真来决定"隐藏还是退出"。
  createTray()
  createWindow()
})

app.on('before-quit', () => {
  // 必须在最前面：后面 saveOpenApps / releaseSlot 都可能触发窗口操作，
  // 而那些操作若被 close 拦截当成"隐藏"，退出流程就会被自己吃掉。
  isQuitting = true
  // 写"正常退出"标记：下次启动时靠它判断上次是不是闪退。
  // 放最前面 —— 后面任何一步若抛异常，标记都已经写下了，
  // 宁可少上报一次，也不要把"正常退出"误报成崩溃。
  try { if (clientLog && clientLog.dir) crashReport.writeMarker(clientLog.dir) } catch (e) {}
  saveOpenApps()
  // 异步存储的队列必须在这里同步落盘：process 退出后定时器不会再有下一次机会，
  // 而 open-apps.json 决定用户下次打开看到哪些窗口。
  flushSyncStores()
  // 关掉所有本地中继：它们是本进程内的监听端口，进程结束前清干净。
  try {
    relayPool.forEach(entry => { try { entry.relay.close() } catch (e) {} })
    relayPool.clear()
    socksRelays.clear()
  } catch (e) {}
  // 收掉 API 传输层的连接池（自带 undici 的 keep-alive socket），别留在进程里。
  try { closeApiAgents() } catch (e) {}
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

// ---------------------------------------------------------------------------
// 测试钩子（仅非打包环境生效）
//
// 26 个测试文件靠 `extract(mainSrc, '函数名')` 从源码里抠函数体、手拼依赖塞进
// VM —— 一旦把函数拆进独立模块，这套写法会成片误报，而误报会掩盖真回归。
//
// 这里挂一个只读导出：测试可以直接拿到「真身」，不必再复制一份源码。
// 判据用 `!app.isPackaged`，打包产物里这段等于不存在。
// ---------------------------------------------------------------------------
if (!app.isPackaged) {
  global.__pixMainTestExports = {
    // 函数真身
    effectiveMaxTabs, safeModeDisablesBridge, timingEqual, sealSettings, unsealSettings,
    readJson, writeJson, asyncJson, flushSyncStores,
    accountSlug, makePartition, platformHomeUrl, safeApiUrl, safePlatformHomeUrl,
    unreadFromTitle, isLegacyLine, normalizeLine, mergeLines,
    publicAuth, deviceId, isRetryableNetworkError, classifyTransportError,
    settingOn, groupModeOf, resolveGroupEnabled, normalizeTabSettings,
    tabTransPayload, platformRows, platformHasCache, fingerprintFromHtml,
    activeWantsStatus, activeWantsTransBar, easeOutCubic,
    guestPrefs, trustedTabSender, pickLang, tabPrefs,
    stripBusyMarks, stripEmoji, transCacheKey, transFingerprint, transRequestId,
    isDeadRequest, relayKeyOf, parseJsonSafe, proxyHistoryFile,
    bridgeEnabledFor, rejectUntrustedSender,
    unreadFromTitle, bindTabUnread, syncGlobalUnread, bindTabLoading,
    tabPayload, sendTabs, layoutViews, applyViewBounds,
    hideTab, showHiddenTab, createWebView, popupTabContextMenu,
    // 状态读取器：拿的是**实时值**，不是快照
    __state: {
      theme: () => theme,
      lineId: () => lineId,
      lines: () => lines,
      activeId: () => activeId,
      showHome: () => showHome,
      overlayOpen: () => overlayOpen,
      nextTab: () => nextTab,
      usedCount: () => usedCount,
      profile: () => profile,
      apiBase: () => apiBase,
      tabs: () => tabs.map(t => ({ id: t.id, platformId: t.platformId, hidden: !!t.hidden, name: t.name })),
      isQuitting: () => isQuitting,
      backgroundRunning: () => backgroundRunning,
      effectiveMaxTabs: () => effectiveMaxTabs(),
      guestPrefs: () => guestPrefs(),
      hasClientLog: () => !!clientLog
    }
  }
}
