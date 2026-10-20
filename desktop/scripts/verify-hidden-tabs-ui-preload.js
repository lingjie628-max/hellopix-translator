'use strict'

/**
 * 隐藏窗口验收用的 preload：给真实 renderer 灌一个最小可用的 window.pix。
 *
 * 为什么需要：app.js 启动时就会调 getConfig / version / platforms 等一串
 * 主进程接口。真实主进程会去建 WebContentsView、读磁盘配置，跑验收时那是
 * 噪音 —— 这里只回桩数据，让界面能把标签栏渲染出来。
 *
 * 注意 contextIsolation 必须关（验收脚本里设的），否则这里挂不到页面全局。
 */

const noop = () => Promise.resolve({ success: true })

const stub = {
  getConfig: () => Promise.resolve({
    apiBase: 'https://example.invalid', theme: 'dark', backgroundRunning: false, lines: [], selectedLine: 'auto'
  }),
  version: () => Promise.resolve('0.0.0-verify'),
  platforms: () => Promise.resolve({ rows: [] }),
  proxyPresets: () => Promise.resolve({ rows: [] }),
  tabs: () => Promise.resolve({ rows: [] }),
  siteInfo: () => Promise.resolve({}),
  listLines: () => Promise.resolve({ rows: [] }),
  translateEngines: () => Promise.resolve({ rows: [] }),
  bridgeStatus: () => Promise.resolve({ ok: true }),
  customerReminders: () => Promise.resolve({ rows: [] }),
  onTabs: () => {},
  onPlatforms: () => {},
  onSession: () => {},
  onKicked: () => {},
  onBackgroundRunning: () => {},
  onContextCommand: () => {},
  onProxySettings: () => {},
  onBridgeDown: () => {},
  onTranslateOpen: () => {},
  home: noop,
  close: noop,
  switchTab: noop,
  hideTab: noop,
  showHiddenTab: noop,
  open: noop,
  contextAction: noop,
  showContextMenu: noop,
  setOverlay: noop,
  checkUpdate: noop,
  session: () => Promise.resolve({}),
  getAuth: () => Promise.resolve({}),
  saveTranslatePrefs: noop,
  updateTabSettings: noop,
  renameTab: noop,
  reorderTabs: noop,
  proxySettings: () => Promise.resolve({}),
  restartApp: noop,
  updatePlatform: noop,
  detectProxy: noop,
  pingAll: () => Promise.resolve({ rows: [] }),
  reportBarHeight: () => {},
  reportChromeHeight: () => {}
}

globalThis.window.pix = stub
