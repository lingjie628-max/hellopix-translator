'use strict'

/**
 * 实例 WebContentsView 工厂的单元测试。
 *
 * 这里的每一条都对应一次真机事故：
 *   - backgroundThrottling 写错 → 隐藏窗口继续跑满定时器（用户喊卡）
 *   - 错误页自己触发 did-finish-load → 无限重画
 *   - preload 装载失败没人记 → 线上"翻译没反应"查无实据
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const { createWebViewFactory } = require('../desktop/src/window/web-view')

function makeHarness (opts) {
  const o = opts || {}
  const harnessRef = {}
  const logged = { error: [], info: [], warn: [] }
  const webPrefs = []
  const wc = new EventEmitter()
  wc.setUserAgent = () => {}
  wc.setWindowOpenHandler = () => {}
  wc.getURL = () => (o.urlRef ? o.urlRef.value : (o.currentUrl || 'https://web.whatsapp.com/'))
  const view = Object.assign(new EventEmitter(), {
    webContents: wc,
    setBorderRadius: () => {},
    setBackgroundColor: () => {}
  })
  const ses = {
    setUserAgent: () => {},
    setPermissionRequestHandler: fn => { harnessRef.permissionHandler = fn }
  }
  const factory = createWebViewFactory({
    electron: {
      WebContentsView: function (cfg) {
        webPrefs.push(cfg.webPreferences)
        return view
      },
      session: { fromPartition: () => ses }
    },
    state: { tabs: o.tabs || [] },
    libs: {
      trustedTabSender: wc2 => (wc2 && wc2.trusted ? { id: 't1' } : null),
      bridgeEnabledFor: () => o.bridge !== false,
      safeModeDisablesBridge: () => !!o.safeMode,
      isAllowedPlatformUrl: () => o.allowNav !== false,
      pushPrefsToGuest: () => { logged.info.push('pushPrefs') },
      paintLoadError: (tab, code) => { logged.error.push(['paint', tab && tab.id, code]) },
      installEditSupport: () => { logged.info.push('editSupport') },
      logError: (ch, msg) => { logged.error.push([ch, msg]) },
      logGuestTrace: msg => { logged.info.push(msg) },
      logGuestWarn: msg => { logged.warn.push(msg) }
    },
    env: { dirname: '/app/desktop', path, CHROME_UA: 'UA/1.0' }
  })
  return { factory, view, wc, webPrefs, logged, harnessRef }
}

test('★ backgroundThrottling 必须是 true（写 false 隐藏窗口会跑满定时器）', () => {
  const { factory, webPrefs } = makeHarness()
  factory.createWebView('persist:wa', {}, { app: 'wa' }, 'https://web.whatsapp.com/', {})
  assert.equal(webPrefs[0].backgroundThrottling, true,
    '这个开关只在创建时生效，事后 setBackgroundThrottling 无效')
})

test('安全基线：contextIsolation / sandbox 开，nodeIntegration 关', () => {
  const { factory, webPrefs } = makeHarness()
  factory.createWebView('persist:wa', {}, {}, '', {})
  const p = webPrefs[0]
  assert.equal(p.contextIsolation, true)
  assert.equal(p.nodeIntegration, false)
  assert.equal(p.sandbox, true)
})

test('桥开启时挂 guest-inject.js；安全模式或平台不支持时不挂', () => {
  let h = makeHarness({ bridge: true })
  h.factory.createWebView('p', {}, {}, '', {})
  assert.match(h.webPrefs[0].preload, /guest-inject\.js$/)

  h = makeHarness({ bridge: true, safeMode: true })
  h.factory.createWebView('p', {}, {}, '', {})
  assert.equal(h.webPrefs[0].preload, undefined, '安全模式下不能挂桥')

  h = makeHarness({ bridge: false })
  h.factory.createWebView('p', {}, {}, '', {})
  assert.equal(h.webPrefs[0].preload, undefined)
})

test('权限回调：不可信来源 / 非通知 / 用户关了通知 → 一律拒', () => {
  const h = makeHarness()
  h.factory.createWebView('p', {}, { showNotify: true }, '', {})
  const handler = h.harnessRef.permissionHandler
  assert.ok(handler, '必须挂 setPermissionRequestHandler（否则任意页面都能弹权限框）')

  const ask = (wc, permission) => {
    let got = null
    handler(wc, permission, v => { got = v })
    return got
  }
  assert.equal(ask({ trusted: true }, 'notifications'), true, '可信实例 + 通知 + 开关开着才放行')
  assert.equal(ask({ trusted: false }, 'notifications'), false, '不可信来源不能弹通知')
  assert.equal(ask({ trusted: true }, 'camera'), false, '除通知外一律不给')
  assert.equal(ask({ trusted: true }, 'geolocation'), false)
})

test('★ 错误页自己加载完成时不能清 loadErrorUrl（否则无限重画）', () => {
  const tab = { id: 't1', loadErrorUrl: 'data:text/html,error' }
  const h = makeHarness({ tabs: [tab], currentUrl: 'data:text/html,error' })
  const view = h.factory.createWebView('p', {}, {}, '', {})
  tab.view = view // 真实流程里 createWebView 之后由 openPlatform 挂上
  view.webContents.emit('did-finish-load')
  assert.equal(tab.loadErrorUrl, 'data:text/html,error', '错误页不能清掉自己的标记')
})

test('正常页面加载完成时清掉 loadErrorUrl', () => {
  const tab = { id: 't1', loadErrorUrl: 'data:text/html,error' }
  const h = makeHarness({ tabs: [tab], currentUrl: 'https://web.whatsapp.com/' })
  const view = h.factory.createWebView('p', {}, {}, '', {})
  tab.view = view
  view.webContents.emit('did-finish-load')
  assert.equal(tab.loadErrorUrl, '', '成功后必须清，否则下次失败不再提示')
})

test('did-fail-load 只为 mainFrame 画错误页（iframe 失败是常态）', () => {
  const tab = { id: 't1' }
  const h = makeHarness({ tabs: [tab] })
  const view = h.factory.createWebView('p', {}, {}, '', {})
  tab.view = view
  view.webContents.emit('did-fail-load', {}, -105, 'ERR', 'https://x', false)
  assert.equal(h.logged.error.filter(e => Array.isArray(e) && e[0] === 'paint').length, 0,
    '子框架失败不该顶掉整页')
  view.webContents.emit('did-fail-load', {}, -105, 'ERR', 'https://x', true)
  assert.equal(h.logged.error.filter(e => Array.isArray(e) && e[0] === 'paint').length, 1)
})

test('★ preload-error 必须以 error 级别留痕，并挂到 view 上等归属上报', () => {
  const h = makeHarness()
  const view = h.factory.createWebView('p', {}, {}, '', {})
  const err = Object.assign(new Error('boom'), {})
  view.webContents.emit('preload-error', {}, '/x/preload.js', err)
  const entry = h.logged.error.find(e => e[0] === 'preload')
  assert.ok(entry, 'preload 装载失败必须进客户端日志')
  assert.match(entry[1], /preload\.js 装载失败/)
  assert.match(view.__pixPreloadError, /装载失败/, '必须挂在 view 上，此时 tab 可能还查不到')
})

test('★ [PIX_TRACE] / [Hello Pix] 必须无条件落盘，不受 level 过滤', () => {
  const h = makeHarness()
  const view = h.factory.createWebView('p', {}, {}, '', {})
  // console.info 的 level 是 0，正常情况下会被过滤掉
  view.webContents.emit('console-message', {}, 0, '[PIX_TRACE] send started', 'guest.js', 42)
  assert.ok(h.logged.info.some(m => /PIX_TRACE/.test(m)), 'trace 采不到，"抓真实事件顺序"就是空话')

  view.webContents.emit('console-message', {}, 0, '[Hello Pix] 发送完成', 'guest.js', 43)
  assert.ok(h.logged.info.some(m => /Hello Pix/.test(m)))
})

test('普通 info 日志不落盘；warning / error 要落盘', () => {
  const h = makeHarness()
  const view = h.factory.createWebView('p', {}, {}, '', {})
  view.webContents.emit('console-message', {}, 0, '普通 info', 'guest.js', 1)
  assert.equal(h.logged.warn.length, 0, '普通 info 不该刷日志')
  view.webContents.emit('console-message', {}, 2, 'warn text', 'guest.js', 2)
  assert.ok(h.logged.warn.some(m => /warn text/.test(m)))
  view.webContents.emit('console-message', {}, 'error', 'err text', 'guest.js', 3)
  assert.ok(h.logged.warn.some(m => /err text/.test(m)))
})

test('实例渲染进程崩溃要记 reason，oom 要显式标记', () => {
  const h = makeHarness()
  const view = h.factory.createWebView('p', {}, { app: 'wa', index: 3 }, '', {})
  view.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 5 })
  const entry = h.logged.error.find(e => e[0] === 'crash')
  assert.ok(entry)
  assert.match(entry[1], /wa#3/)
  assert.match(entry[1], /reason=oom/)
  assert.match(entry[1], /内存不足/, 'oom 和 crashed 是两个排查方向，不能混')
})

test('每个 WebContentsView 都装上编辑支持', () => {
  const h = makeHarness()
  h.factory.createWebView('p', {}, {}, '', {})
  assert.ok(h.logged.info.includes('editSupport'), '不装就复制不出译文')
})

test('窗口不能被页面自行打开（setWindowOpenHandler 一律 deny）', () => {
  const h = makeHarness()
  let handler = null
  h.wc.setWindowOpenHandler = fn => { handler = fn }
  h.factory.createWebView('p', {}, {}, '', {})
  assert.ok(handler, '必须挂 setWindowOpenHandler')
  assert.deepEqual(handler({ url: 'https://evil.com' }), { action: 'deny' })
})
