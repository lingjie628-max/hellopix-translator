'use strict'

/**
 * 主进程行为快照 —— 重构期的对照基准。
 *
 * ## 为什么需要它
 *
 * `main.js` 里的状态（win / tabs / profile / clientLog …）靠**闭包**共享。
 * 26 个测试文件用 `extract(mainSrc, '函数名')` 从源码里抠出函数体，再手工
 * 拼一份依赖塞进 VM —— 这套写法的前提是「函数必须留在 main.js 里，且源码
 * 形态不变」。一旦拆分，这些测试会成片误报，而误报会掩盖真正的回归。
 *
 * 这里换一种方式：把**整个 main.js 真跑起来**（用 mock electron），
 * 然后导出状态与函数。拆分前后各跑一次，比较导出的行为是否一致。
 * 它不关心代码放在哪个文件，只关心「外部能观察到的行为有没有变」。
 *
 * ## 用法
 *
 *   const { boot } = require('./helpers/boot-main')
 *   const app = boot({ tabs: [...], profile: {...} })
 *   app.expose('saveOpenApps')
 *   app.state.tabs
 *
 * ## 边界
 *
 * mock electron 覆盖真实 API 的**形状**，不模拟行为细节。它能证明
 * 「启动链路不崩、状态初始化正确、纯函数行为不变」，不能替代真机验收
 * （真机验收见 scripts/verify-preload-load.js 与 Electron 实跑）。
 */

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const Module = require('module')

const desktopDir = path.join(__dirname, '..', '..', 'desktop')
const mainPath = path.join(desktopDir, 'main.js')

/**
 * 窗口替身。
 *
 * main.js 的 createWindow 会调用**很多**窗口方法（setMenuBarVisibility /
 * setOverlayIcon / setProgressBar …）。这里全部显式列出并记录调用 —— 漏一个
 * 就会在启动期抛 TypeError，而那种错误在真机上表现为"窗口一闪就没了"。
 */
function makeWindow (calls, record) {
  const win = emitter({
    webContents: emitter({
      id: 1001,
      send: record('send'),
      getURL: () => 'file:///index.html',
      isDestroyed: () => false,
      executeJavaScript: () => Promise.resolve(),
      session: makeSession(),
      setWindowOpenHandler: record('setWindowOpenHandler'),
      sendInputEvent: record('sendInputEvent')
    }),
    __views: [],
    loadFile: () => Promise.resolve(),
    loadURL: () => Promise.resolve(),
    isDestroyed: () => false,
    isMinimized: () => false,
    isMaximized: () => false,
    isFullScreen: () => false,
    isVisible: () => true,
    isFocused: () => true,
    show: () => { calls.push(['show']) },
    hide: () => { calls.push(['hide']) },
    focus: () => { calls.push(['focus']) },
    blur: () => { calls.push(['blur']) },
    destroy: () => { calls.push(['destroy']) },
    close: () => { calls.push(['close']) },
    minimize: () => { calls.push(['minimize']) },
    restore: () => { calls.push(['restore']) },
    maximize: () => { calls.push(['maximize']) },
    unmaximize: () => { calls.push(['unmaximize']) },
    setBounds: (...a) => { calls.push(['setBounds', a]) },
    getBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    getContentBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    getNormalBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    setSize: () => {},
    setMinimumSize: () => {},
    setTitle: () => {},
    getTitle: () => '',
    setBackgroundColor: () => {},
    setMenuBarVisibility: () => {},
    setAutoHideMenuBar: () => {},
    setOverlayIcon: () => {},
    setProgressBar: () => {},
    setAlwaysOnTop: () => {},
    setSkipTaskbar: () => {},
    setRepresentedFilename: () => {},
    setDocumentEdited: () => {},
    setFullScreen: () => {},
    setOpacity: () => {},
    flashFrame: () => {},
    center: () => { calls.push(['center']) },
    setPosition: () => {},
    getPosition: () => [0, 0],
    reload: () => {},
    contentView: {
      addChildView: (v) => { win.__views.push(v) },
      removeChildView: () => {},
      children: []
    }
  })
  // 兜底：真机上 Electron 的窗口 API 很多，mock 不可能列全。未知方法一律
  // 当作 no-op 并记录调用 —— 宁可让测试少断言一个方法，也不要因为 mock 太薄
  // 把一个正常启动判成崩溃。
  return new Proxy(win, {
    get (target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'symbol') return undefined
      if (prop === 'then') return undefined            // 别让 await win 误判成 Promise
      return (...args) => { calls.push([String(prop), args]) }
    }
  })
}

/** 带事件接口的最小对象，够 main.js 在启动期挂监听。 */
function emitter (extra) {
  const listeners = new Map()
  return Object.assign({
    on (name, fn) { (listeners.get(name) || listeners.set(name, []).get(name)).push(fn); return this },
    once (name, fn) { return this.on(name, fn) },
    off (name, fn) {
      const list = listeners.get(name) || []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
      return this
    },
    removeListener (name, fn) { return this.off(name, fn) },
    removeAllListeners (name) { listeners.delete(name); return this },
    emit (name, ...args) { for (const fn of (listeners.get(name) || []).slice()) fn(...args); return true },
    listenerCount (name) { return (listeners.get(name) || []).length }
  }, extra || {})
}

/**
 * 一个够用的 WebContentsView 替身。
 *
 * main.js 启动期会对 view 调一堆方法（setBounds / webContents.loadURL /
 * setBackgroundColor / …）。这里全部记下来，测试可以断言"调了什么"。
 */
function makeView (opts) {
  const calls = []
  const record = name => (...args) => { calls.push([name, args]); return undefined }
  const wc = emitter({
    id: (opts && opts.id) || Math.floor(Math.random() * 1e6),
    loadURL: (...a) => { calls.push(['loadURL', a]); return Promise.resolve() },
    getURL: () => (opts && opts.url) || 'about:blank',
    isDestroyed: () => false,
    isDestroyed_: false,
    setZoomFactor: record('setZoomFactor'),
    getZoomFactor: () => 1,
    setAudioMuted: record('setAudioMuted'),
    isAudioMuted: () => false,
    send: record('send'),
    executeJavaScript: (...a) => { calls.push(['executeJavaScript', a]); return Promise.resolve(undefined) },
    executeJavaScriptInIsolatedWorld: (...a) => { calls.push(['executeJavaScriptInIsolatedWorld', a]); return Promise.resolve(undefined) },
    openDevTools: record('openDevTools'),
    close: record('close'),
    reload: record('reload'),
    stop: record('stop'),
    focus: record('focus'),
    setWindowOpenHandler: record('setWindowOpenHandler'),
    session: makeSession(),
    id_: null
  })
  const view = emitter({
    webContents: wc,
    setBounds: record('setBounds'),
    getBounds: () => (opts && opts.bounds) || { x: 0, y: 0, width: 800, height: 600 },
    setBackgroundColor: record('setBackgroundColor'),
    setBorderRadius: record('setBorderRadius'),
    setVisible: record('setVisible'),
    setZIndex: record('setZIndex')
  })
  view.__calls = calls
  return view
}

function makeSession () {
  const ses = emitter({
    setProxy: (...a) => { ses.__proxy = a[0]; return Promise.resolve() },
    resolveProxy: () => Promise.resolve('DIRECT'),
    clearCache: () => Promise.resolve(),
    clearStorageData: () => Promise.resolve(),
    cookies: emitter({
      get: () => Promise.resolve([]),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      flushStore: () => Promise.resolve()
    }),
    setPermissionRequestHandler: (fn) => { ses.__permHandler = fn },
    setUserAgent: (ua) => { ses.__ua = ua },
    getUserAgent: () => ses.__ua || '',
    webRequest: emitter({
      onBeforeSendHeaders: emitter(),
      onHeadersReceived: emitter(),
      onBeforeRequest: emitter()
    }),
    protocol: emitter({ handle: () => {} })
  })
  return ses
}

/**
 * 启动主进程。
 *
 * @param {object} [opts]
 * @param {object} [opts.userData]  覆盖 app.getPath('userData') 指向的临时目录
 * @returns {{ state, expose, electron, calls, dispose }}
 */
function boot (opts) {
  const options = opts || {}
  const tmpRoot = options.userData ||
    fs.mkdtempSync(path.join(require('os').tmpdir(), 'pix-boot-'))

  const calls = []
  const record = name => (...args) => { calls.push([name, args]); return undefined }

  const appEvents = emitter()
  const ipcHandlers = new Map()

  const dialog = emitter({
    showMessageBox: () => Promise.resolve({ response: 0 }),
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    showSaveDialog: () => Promise.resolve({ canceled: true })
  })

  const mockElectron = {
    app: emitter({
      getPath: (name) => {
        const dir = path.join(tmpRoot, String(name || 'root'))
        fs.mkdirSync(dir, { recursive: true })
        return dir
      },
      getName: () => 'HelloPix',
      getVersion: () => '0.0.0-test',
      getAppPath: () => desktopDir,
      isPackaged: false,
      whenReady: () => Promise.resolve(),
      quit: record('quit'),
      exit: record('exit'),
      relaunch: record('relaunch'),
      setLoginItemSettings: record('setLoginItemSettings'),
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setAppUserModelId: record('setAppUserModelId'),
      setName: record('setName'),
      disableHardwareAcceleration: record('disableHardwareAcceleration'),
      commandLine: { appendSwitch: record('appendSwitch'), hasSwitch: () => false, appendArgument: record('appendArgument') },
      on: (...a) => appEvents.on(...a),
      once: (...a) => appEvents.once(...a),
      off: (...a) => appEvents.off(...a),
      removeAllListeners: (...a) => appEvents.removeAllListeners(...a),
      emit: (...a) => appEvents.emit(...a)
    }),
    ipcMain: emitter({
      handle: (channel, fn) => { ipcHandlers.set(channel, fn) },
      on: (channel, fn) => { ipcHandlers.set(channel, fn) },
      removeHandler: (channel) => { ipcHandlers.delete(channel) }
    }),
    // 测试里判断"窗口建出来了没有"靠这条调用记录
    BrowserWindow: class extends emitter {
      constructor (o) {
        super()
        calls.push(['new BrowserWindow', [o]])
        const w = makeWindow(calls, record)
        Object.assign(this, w)
      }
    },
    WebContentsView: class extends emitter {
      constructor (o) {
        super()
        const v = makeView(o)
        Object.assign(this, v)
        this.webContents = v.webContents
        this.__calls = v.__calls
        calls.push(['new WebContentsView', [o]])
      }
    },
    session: Object.assign(
      (name) => makeSession(),
      { fromPartition: (p) => makeSession(), defaultSession: makeSession() }
    ),
    shell: emitter({
      openExternal: () => Promise.resolve(),
      openPath: () => Promise.resolve(''),
      showItemInFolder: () => {}
    }),
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s) => Buffer.from(String(s)),
      decryptString: (b) => Buffer.from(b).toString()
    },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }),
      createEmpty: () => ({ isEmpty: () => true })
    },
    net: { request: () => emitter({ on: () => {}, end: () => {} }) },
    Menu: Object.assign(class extends emitter {}, {
      buildFromTemplate: (tpl) => emitter({ __template: tpl }),
      setApplicationMenu: record('setApplicationMenu'),
      getApplicationMenu: () => null
    }),
    Tray: class extends emitter {
      constructor (img) { super(); calls.push(['new Tray', [img]]) }
      setToolTip () {}
      setContextMenu () {}
      on (...a) { return super.on(...a) }
      destroy () {}
    },
    nativeTheme: emitter({ shouldUseDarkColors: false, on: () => {} }),
    screen: Object.assign(emitter({
      getPrimaryDisplay: () => ({
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
        workAreaSize: { width: 1440, height: 900 },
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        size: { width: 1440, height: 900 },
        scaleFactor: 2
      }),
      getAllDisplays: () => [{
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
        workAreaSize: { width: 1440, height: 900 },
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        size: { width: 1440, height: 900 },
        scaleFactor: 2
      }],
      getDisplayNearestPoint: () => ({
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
        workAreaSize: { width: 1440, height: 900 },
        scaleFactor: 2
      }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 })
    }), {}),
    Notification: class extends emitter {
      constructor (o) { super(); this.__opts = o }
      show () {}
      close () {}
    },
    dialog,
    crashReporter: emitter({ start: record('crashReporter.start') }),
    globalShortcut: emitter({ register: record('register'), unregisterAll: () => {} })
  }

  // main.js 第一行就检查 electron 的形状，形状不对会 process.exit(1)。
  // 这里临时替换 require 让它拿到 mock，执行完立刻还原。
  //
  // ★ 注意：main.js 在**函数内部**也有 require('electron')（createWindow、
  // restoreWindowBounds 里解构 screen）。如果把 _load 立刻还原，这些延迟调用
  // 会拿到真 electron（测试环境下为 undefined）→ 启动后异步报错。
  // 所以 mock 必须活到进程结束，由测试进程自然退出时释放。
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return mockElectron
    return originalLoad.apply(this, arguments)
  }
  // 只还原一次，避免多次 boot 时叠加包装层
  if (!Module._load.__pixBootPatched) {
    Module._load.__pixBootPatched = true
    process.once('exit', () => { Module._load = originalLoad })
  }

  let state = null
  try {
    delete require.cache[require.resolve(mainPath)]
    global.__pixGuard = undefined
    require(mainPath)
    state = exports.state = captureState()
  } finally {
    // 不还原 _load：见上面说明。函数内 require('electron') 仍需要 mock。
  }

  const api = {
    /** 实时状态（每次读都取最新值，不是启动那一刻的快照）。 */
    get state () { return captureState() },
    electron: mockElectron,
    ipcHandlers,
    calls,
    tmpRoot,
    /** 从 main.js 模块里取一个导出（测试钩子挂上去的）。 */
    expose (name) {
      const set = global.__pixMainTestExports
      return set ? set[name] : undefined
    },
    /** 等启动链跑完（app.whenReady().then 里的建窗口等动作）。 */
    async ready (ms) {
      const deadline = Date.now() + (ms || 2000)
      while (Date.now() < deadline) {
        if (calls.some(c => c[0] === 'new BrowserWindow')) break
        await new Promise(r => setTimeout(r, 10))
      }
      // 让 microtask / setTimeout(0) 里的收尾也跑完
      await new Promise(r => setTimeout(r, 20))
      return captureState()
    },
    dispose () {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) {}
    }
  }
  return api
}

/** 从模块导出里抓状态。main.js 末尾会用 exportForTest 挂一份。 */
function captureState () {
  const api = global.__pixMainTestExports
  if (!api || !api.__state) return {}
  const out = {}
  for (const [k, get] of Object.entries(api.__state)) {
    try { out[k] = get() } catch (e) { out[k] = '<error: ' + e.message + '>' }
  }
  return out
}

module.exports = { boot, makeView, makeSession, emitter }
