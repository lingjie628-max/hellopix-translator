'use strict'

/**
 * 主窗口的单元测试。
 *
 * 最要紧的是两件事：
 *   1. 尺寸必须自适应可用区域，而且 macOS 恢复上次框架后要**再设一次**，
 *      否则自适应等于没做。
 *   2. 关窗 = 隐藏到托盘，但**托盘没建出来必须放行退出** ——
 *      否则窗口藏了、又没入口找回来，进程就成了用户关不掉的僵尸。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const { createWindowModule } = require('../desktop/src/window/main-window')

function harness (opts) {
  const o = opts || {}
  const calls = []
  const bounds = { x: 100, y: 100, width: 1000, height: 700 }
  const handlers = {}
  const wc = new EventEmitter()
  wc.setWindowOpenHandler = fn => { handlers.windowOpen = fn }

  const win = Object.assign(new EventEmitter(), {
    webContents: wc,
    setMenuBarVisibility: v => calls.push(['setMenuBarVisibility', v]),
    getBounds: () => Object.assign({}, bounds),
    setBounds: b => { calls.push(['setBounds', b]); Object.assign(bounds, b) },
    center: () => calls.push(['center']),
    hide: () => calls.push(['hide']),
    loadFile: f => calls.push(['loadFile', f])
  })
  let constructed = null

  const mod = createWindowModule({
    electron: {
      get BrowserWindow () {
        return function (cfg) { constructed = cfg; return win }
      },
      getScreen: () => ({
        getPrimaryDisplay: () => ({ workAreaSize: o.workArea || { width: 1440, height: 900 } })
      })    },
    state: {
      isQuitting: !!o.isQuitting,
      tray: o.tray === undefined ? { displayBalloon: () => calls.push(['balloon']) } : o.tray,
      backgroundTipShown: !!o.tipShown,
      set backgroundTipShown (v) { this._tip = v }
    },
    libs: {
      restoreWindowBounds: f => (o.saved ? Object.assign({}, f, o.saved) : Object.assign({}, f)),
      scheduleSaveWindowBounds: () => calls.push('saveBounds'),
      layoutViews: () => calls.push('layout'),
      backgroundMode: {
        shouldHideOnClose: args => {
          calls.push(['shouldHide', args])
          return !!(args.backgroundEnabled && args.hasTray && !args.isQuitting)
        }
      },
      backgroundEnabled: () => o.bgEnabled !== false,
      logWarn: (ch, msg) => calls.push(['warn', ch, msg]),
      logError: (ch, msg) => calls.push(['error', ch, msg])
    },
    env: {
      dirname: '/app/desktop',
      path,
      WINDOW_MIN_WIDTH: 960,
      WINDOW_MIN_HEIGHT: 640,
      APP_ICON: '/app/icon.png'
    }
  })
  return { mod, win, wc, calls, handlers, get constructed () { return constructed } }
}

test('窗口尺寸按可用区域自适应，并受上下限约束', () => {
  const h = harness({ workArea: { width: 1440, height: 900 } })
  h.mod.createWindow()
  assert.equal(h.constructed.width, 1424, '留 16px 余量')
  assert.equal(h.constructed.height, 884)
})

test('小屏不会小于最小尺寸', () => {
  const h = harness({ workArea: { width: 800, height: 500 } })
  h.mod.createWindow()
  assert.equal(h.constructed.width, 960, '不能小于 WINDOW_MIN_WIDTH')
  assert.equal(h.constructed.height, 640, '不能小于 WINDOW_MIN_HEIGHT')
})

test('超大屏封顶，不会撑出 1920/1600', () => {
  const h = harness({ workArea: { width: 3840, height: 2160 } })
  h.mod.createWindow()
  assert.equal(h.constructed.width, 1920)
  assert.equal(h.constructed.height, 1600)
})

test('★ macOS 恢复上次框架后必须再 setBounds 一次，否则自适应等于没做', () => {
  const h = harness({ saved: { x: 200, y: 150 } })
  h.mod.createWindow()
  const set = h.calls.find(c => Array.isArray(c) && c[0] === 'setBounds')
  assert.ok(set, '必须显式再设一次尺寸')
  assert.equal(set[1].x, 200, '有保存的位置就用保存的')
  assert.equal(set[1].y, 150)
  assert.ok(!h.calls.some(c => Array.isArray(c) && c[0] === 'center'), '有保存位置时不该强制居中')
})

test('没有保存位置时居中', () => {
  const h = harness()
  h.mod.createWindow()
  assert.ok(h.calls.some(c => Array.isArray(c) && c[0] === 'center'))
})

test('安全基线：contextIsolation / sandbox 开，nodeIntegration 关', () => {
  const h = harness()
  h.mod.createWindow()
  const p = h.constructed.webPreferences
  assert.equal(p.contextIsolation, true)
  assert.equal(p.nodeIntegration, false)
  assert.equal(p.sandbox, true)
  assert.match(p.preload, /preload\.js$/)
})

test('主窗口不能被导航走，也不能开新窗口', () => {
  const h = harness()
  h.mod.createWindow()
  assert.deepEqual(h.handlers.windowOpen({ url: 'https://evil.com' }), { action: 'deny' })
  const ev = { prevented: false, preventDefault: () => { ev.prevented = true } }
  h.wc.emit('will-navigate', ev)
  assert.equal(ev.prevented, true, '整个 UI 是本地文件，不该被导航走')
})

test('console-message 同时兼容新旧两种签名', () => {
  const h = harness()
  h.mod.createWindow()
  // 老签名 (event, level, message, line, sourceId)
  h.wc.emit('console-message', {}, 3, '老错误', 10, 'a.js')
  // 新签名（单个对象）
  h.wc.emit('console-message', { level: 'error', message: '新错误', lineNumber: 20, sourceId: 'b.js' })
  const warns = h.calls.filter(c => Array.isArray(c) && c[0] === 'warn')
  assert.ok(warns.some(w => /老错误.*a\.js:10/.test(w[2])))
  assert.ok(warns.some(w => /新错误.*b\.js:20/.test(w[2])), '升级后日志不能静默消失')
})

test('console 的 info 不刷日志', () => {
  const h = harness()
  h.mod.createWindow()
  h.wc.emit('console-message', {}, 0, '普通 info', 1, 'a.js')
  assert.equal(h.calls.filter(c => Array.isArray(c) && c[0] === 'warn').length, 0)
})

test('主窗口渲染进程崩溃与无响应都要留痕', () => {
  const h = harness()
  h.mod.createWindow()
  h.wc.emit('render-process-gone', {}, { reason: 'oom', exitCode: 9 })
  h.wc.emit('unresponsive')
  assert.ok(h.calls.some(c => Array.isArray(c) && c[0] === 'error' && /oom/.test(c[2])))
  assert.ok(h.calls.some(c => Array.isArray(c) && c[0] === 'warn' && /无响应/.test(c[2])))
})

test('★ 关窗 = 隐藏到托盘（后台继续翻译）', () => {
  const h = harness()
  h.mod.createWindow()
  const ev = { prevented: false, preventDefault: () => { ev.prevented = true } }
  h.win.emit('close', ev)
  assert.equal(ev.prevented, true)
  assert.ok(h.calls.some(c => Array.isArray(c) && c[0] === 'hide'))
})

test('★ 托盘没建出来时必须放行退出（否则进程成了关不掉的僵尸）', () => {
  const h = harness({ tray: null })
  h.mod.createWindow()
  const ev = { prevented: false, preventDefault: () => { ev.prevented = true } }
  h.win.emit('close', ev)
  assert.equal(ev.prevented, false, '没有托盘还拦截 = 用户再也找不到窗口')
})

test('正在退出时不拦截关窗', () => {
  const h = harness({ isQuitting: true })
  h.mod.createWindow()
  const ev = { prevented: false, preventDefault: () => { ev.prevented = true } }
  h.win.emit('close', ev)
  assert.equal(ev.prevented, false)
})

test('用户关掉后台运行时，关窗直接退出', () => {
  const h = harness({ bgEnabled: false })
  h.mod.createWindow()
  const ev = { prevented: false, preventDefault: () => { ev.prevented = true } }
  h.win.emit('close', ev)
  assert.equal(ev.prevented, false)
})

test('关窗判定必须拿到 hasTray / isQuitting / backgroundEnabled 三项', () => {
  const h = harness()
  h.mod.createWindow()
  h.win.emit('close', { preventDefault: () => {} })
  const call = h.calls.find(c => Array.isArray(c) && c[0] === 'shouldHide')
  assert.ok(call)
  assert.equal(call[1].hasTray, true)
  assert.equal(call[1].isQuitting, false)
  assert.equal(call[1].backgroundEnabled, true)
})

test('布局必须在 resize / 全屏切换 / 加载完成时都刷新', () => {
  const h = harness()
  h.mod.createWindow()
  const before = h.calls.filter(c => c === 'layout').length
  h.win.emit('resize')
  h.win.emit('enter-full-screen')
  h.win.emit('leave-full-screen')
  h.wc.emit('did-finish-load')
  assert.ok(h.calls.filter(c => c === 'layout').length - before >= 4,
    '少一个都会让视图位置错位')
})

test('加载的是本地 renderer/index.html', () => {
  const h = harness()
  h.mod.createWindow()
  const load = h.calls.find(c => Array.isArray(c) && c[0] === 'loadFile')
  assert.ok(load[1].endsWith(path.join('renderer', 'index.html')))
})

test('菜单栏隐藏（产品不用原生菜单）', () => {
  const h = harness()
  h.mod.createWindow()
  assert.ok(h.calls.some(c => Array.isArray(c) && c[0] === 'setMenuBarVisibility' && c[1] === false))
})
