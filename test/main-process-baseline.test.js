'use strict'

/**
 * 主进程重构的**行为基线**。
 *
 * 这不是普通的单元测试，而是重构期间的安全网：它不关心函数写在哪个文件，
 * 只锁定「整个 main.js 真跑一遍之后，外部能观察到的行为」。
 *
 * 拆分 main.js 时如果动了状态初始化顺序、漏搬了某个函数、或者某个 IPC
 * 悄悄消失，这里会直接红 —— 而不是等到安装包发出去才发现启动即崩。
 *
 * 基线值在**重构前**采集（见 commit 里 BASELINE 的来源），此后只在
 * 「有意改变行为」时才更新，并且必须在 commit message 里写清为什么。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { boot } = require('./helpers/boot-main')

test('主进程能完整启动（mock electron 下真实执行 main.js）', async () => {
  const app = boot()
  try {
    await app.ready()
    assert.ok(app.state, 'main.js 执行后必须导出状态')
    // 启动期必须注册 IPC，否则渲染层所有功能都调不通
    assert.ok(app.ipcHandlers.size > 30, `IPC handler 太少：${app.ipcHandlers.size}`)
    // 窗口必须真的建出来了（createWindow 走到了 WebContentsView）
    const madeWindow = app.calls.some(c => c[0] === 'new BrowserWindow')
    assert.ok(madeWindow, '启动后必须创建 BrowserWindow')
  } finally {
    app.dispose()
  }
})

test('启动后的初始状态与基线一致', async () => {
  const app = boot()
  try {
    await app.ready()
    const s = app.state
    assert.equal(s.theme, 'light')
    assert.equal(s.lineId, 'overseas')
    assert.equal(s.showHome, true)
    assert.equal(s.overlayOpen, false)
    assert.equal(s.nextTab, 1)
    assert.equal(s.profile, null)
    assert.deepEqual(s.tabs, [])
    assert.deepEqual(s.usedCount, {})
    assert.equal(s.isQuitting, false)
    assert.equal(s.backgroundRunning, true)
    // 默认不限实例数（0 = 按内存水位动态判断，见 tab-budget.js）
    assert.equal(s.effectiveMaxTabs, 0)
    assert.equal(s.hasClientLog, true, '日志必须在启动期就初始化')
  } finally {
    app.dispose()
  }
})

test('IPC 频道集合与基线一致（拆分时漏搬一个就会红）', async () => {
  const app = boot()
  try {
    await app.ready()
    const channels = [...app.ipcHandlers.keys()].sort()
    // 锁定频道名的**完整集合**，不锁顺序与实现。
    // 重构把 handler 搬进 src/ipc/ 时，只要漏搬一个这里立刻红。
    // 新增对外接口是有意行为，必须在同一 commit 里补进 BASELINE_CHANNELS。
    assert.deepEqual(channels, BASELINE_CHANNELS)
  } finally {
    app.dispose()
  }
})

/**
 * 关键频道清单 —— 每个域至少一个，漏掉就能立刻发现。
 * 完整清单有 53 个，只钉住"没有它整个域都不可用"的那些。
 */
/**
 * 全部 IPC 频道的**精确基线**（重构前实测采集，共 51 个）。
 *
 * 用精确集合而不是"至少 N 个"：拆分 handler 最大的风险就是漏搬某一个，
 * 而漏掉的那个往往正好是低频路径（比如 customer:reminders），
 * 数量阈值拦不住。宁可每次新增频道都来这里补一行。
 */
const BASELINE_CHANNELS = [
  'app:checkUpdate', 'app:clearActiveCache', 'app:close', 'app:contextAction',
  'app:hide', 'app:home', 'app:open', 'app:overlay', 'app:platforms', 'app:preset',
  'app:proxyPresets', 'app:proxySettings', 'app:reloadActive', 'app:rename',
  'app:reorder', 'app:restart', 'app:savePreset', 'app:showContextMenu',
  'app:showHidden', 'app:switch', 'app:tabs', 'app:updatePlatform',
  'app:updateSettings', 'app:version',
  'auth:autoLogin', 'auth:get', 'auth:login', 'auth:logout', 'auth:save',
  'auth:session', 'auth:verifyLock',
  'chrome:barHeight', 'chrome:height',
  'config:get', 'config:setApiBase', 'config:setBackgroundRunning', 'config:setTabLayout', 'config:setTheme',
  'customer:ingest', 'customer:reminders',
  'lines:list', 'lines:ping', 'lines:pingAll', 'lines:select',
  'proxy:detect', 'shell:open', 'site:info',
  'translate:bridgeStatus', 'translate:composerInsertText',
  'translate:composerSelectAllDelete', 'translate:engines', 'translate:guestPrefs',
  // 图片翻译：translate:image 走 ipcMain.handle（主界面发起），
  // translate:imageUiSource 是 sendSync（客页 preload 启动时取 UI 源码，
  // 因为 sandbox:true 读不到本地文件）。
  'translate:image', 'translate:imageUiSource',
  'translate:run', 'translate:savePrefs'
]

test('纯函数行为不变（真身直接调用，不复制源码）', async () => {
  const app = boot()
  try {
    await app.ready()
    const x = app.expose('groupModeOf')
    if (x) {
      // 基线：缺省是 manual（不是 inherit）—— 继承是**显式**选择
      assert.equal(x({}), 'manual')
      assert.equal(x({ groupMode: 'manual' }), 'manual')
      assert.equal(x({ groupMode: 'auto' }), 'auto')
      assert.equal(x(null), 'manual')
      // 未知值必须回落到 manual，不能把脏数据透传给下游
      assert.equal(x({ groupMode: 'weird' }), 'manual')
    }

    const n = app.expose('normalizeLine')
    if (n) {
      const line = n({ id: 'x', name: 'X', url: 'https://a.example.com' }, 0)
      assert.equal(line.id, 'x')
      assert.equal(typeof line.url, 'string')
    }

    const slug = app.expose('accountSlug')
    if (slug) {
      // 账号目录名必须稳定：变了等于用户数据全丢（open-apps/window-bounds 找不到）
      assert.equal(slug('Alice'), slug('Alice'))
      assert.equal(slug(''), slug(''))
    }

    const strip = app.expose('stripEmoji')
    if (strip) assert.equal(typeof strip('a😀b'), 'string')

    const te = app.expose('timingEqual')
    if (te) {
      assert.equal(te('ab', 'ab'), true)
      assert.equal(te('ab', 'ac'), false)
      assert.equal(te('ab', 'a'), false)
    }
  } finally {
    app.dispose()
  }
})

test('安全模式策略真的被读取（maxTabs / disableBridge）', async () => {
  const app = boot()
  try {
    await app.ready()
    const fn = app.expose('effectiveMaxTabs')
    if (fn) {
      global.__pixGuard = { policy: () => ({ safeMode: true, maxTabs: 2 }) }
      assert.equal(fn(), 2, '安全模式下必须压到 policy 给的上限')
      global.__pixGuard = { policy: () => ({ safeMode: false, maxTabs: 0 }) }
      assert.equal(fn(), 0)
      global.__pixGuard = undefined
    }
  } finally {
    global.__pixGuard = undefined
    app.dispose()
  }
})
