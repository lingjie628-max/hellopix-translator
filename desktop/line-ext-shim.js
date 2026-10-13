/**
 * LINE 官方 Chrome 扩展在 Electron 里缺的 chrome.* 接口。
 *
 * Electron 只实现了 Chrome 扩展 API 的一个子集；LINE 扩展一启动就会访问
 * action / windows / system.display / notifications / cookies 等命名空间，
 * 拿到 undefined 直接抛错，后台脚本注册失败、页面空白。
 * 这里只**补缺**：已有的真实实现一律不覆盖。
 *
 * 同时作为普通 <script> 与 ES module 被加载（后台 service worker 是 module），
 * 所以不能有 import / export，也不能依赖 window。
 */
(function () {
  'use strict'
  const g = typeof globalThis !== 'undefined' ? globalThis : self
  const chrome = g.chrome = g.chrome || {}

  function event () {
    const fns = []
    return {
      addListener: (fn) => { if (typeof fn === 'function' && fns.indexOf(fn) < 0) fns.push(fn) },
      removeListener: (fn) => { const i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1) },
      hasListener: (fn) => fns.indexOf(fn) >= 0,
      hasListeners: () => fns.length > 0,
      _fire: (...a) => { for (const fn of fns.slice()) { try { fn(...a) } catch (e) {} } }
    }
  }

  /** 同时支持回调与 Promise 两种调用习惯。 */
  function api (value) {
    return function () {
      const cb = arguments.length && typeof arguments[arguments.length - 1] === 'function'
        ? arguments[arguments.length - 1] : null
      const v = typeof value === 'function' ? value.apply(null, arguments) : value
      if (cb) { setTimeout(() => cb(v), 0); return undefined }
      return Promise.resolve(v)
    }
  }

  function ensure (ns, defs) {
    const target = chrome[ns] = chrome[ns] || {}
    for (const k of Object.keys(defs)) if (target[k] === undefined) target[k] = defs[k]
    return target
  }

  const screenInfo = () => {
    const s = (g.screen) || { width: 1440, height: 900, availWidth: 1440, availHeight: 900 }
    return [{
      id: '0',
      isPrimary: true,
      bounds: { left: 0, top: 0, width: s.width || 1440, height: s.height || 900 },
      workArea: { left: 0, top: 0, width: s.availWidth || s.width || 1440, height: s.availHeight || s.height || 900 }
    }]
  }
  const WIN = { id: 1, focused: true, state: 'normal', type: 'normal', top: 0, left: 0, width: 1100, height: 760, alwaysOnTop: false, incognito: false }

  // 页面里 LINE 用 action.setBadgeText({ text }) 报总未读数（"3" / "99+" / ""）。
  // 内嵌时没有工具栏，把它写成标题前缀「(3) 」—— 宿主按标题读未读数（与 WhatsApp 同一口径）。
  let unreadText = ''
  const UNREAD_PREFIX = /^\(\d{1,5}\+?\)\s/
  function syncTitle () {
    if (typeof document === 'undefined') return
    const base = String(document.title || '').replace(UNREAD_PREFIX, '') || 'LINE'
    const want = unreadText ? '(' + unreadText + ') ' + base : base
    if (document.title !== want) document.title = want
  }
  function setBadgeText (details) {
    const raw = String((details && details.text) || '').trim()
    unreadText = /^\d{1,5}\+?$/.test(raw) && raw !== '0' ? raw : ''
    syncTitle()
  }
  if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
    const watch = () => {
      const head = document.head || document.documentElement
      if (head) new MutationObserver(() => { if (unreadText) syncTitle() }).observe(head, { subtree: true, childList: true, characterData: true })
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch, { once: true })
    else watch()
  }

  ensure('action', {
    setIcon: api(undefined),
    setBadgeText: api(undefined),
    setBadgeBackgroundColor: api(undefined),
    setTitle: api(undefined),
    getBadgeText: api(''),
    onClicked: event()
  })

  if (typeof document !== 'undefined') {
    const prevSetBadgeText = chrome.action.setBadgeText
    chrome.action.setBadgeText = function (details) {
      setBadgeText(details)
      try { return prevSetBadgeText.apply(this, arguments) } catch (e) { return Promise.resolve() }
    }
  }

  ensure('windows', {
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
    create: api(() => Object.assign({}, WIN)),
    update: api(() => Object.assign({}, WIN)),
    get: api(() => Object.assign({}, WIN)),
    getCurrent: api(() => Object.assign({}, WIN)),
    getLastFocused: api(() => Object.assign({}, WIN)),
    getAll: api(() => [Object.assign({}, WIN)]),
    remove: api(undefined),
    onRemoved: event(),
    onCreated: event(),
    onFocusChanged: event(),
    onBoundsChanged: event()
  })

  chrome.system = chrome.system || {}
  if (!chrome.system.display) chrome.system.display = { getInfo: api(screenInfo), onDisplayChanged: event() }

  ensure('notifications', {
    create: api((id) => (typeof id === 'string' ? id : 'pix-' + Date.now())),
    update: api(true),
    clear: api(true),
    getAll: api({}),
    onClicked: event(),
    onClosed: event(),
    onButtonClicked: event()
  })

  ensure('cookies', {
    get: api(null),
    getAll: api([]),
    set: api(null),
    remove: api(null),
    onChanged: event()
  })

  const tabs = ensure('tabs', {
    getCurrent: api(undefined),
    query: api([]),
    onRemoved: event(),
    onUpdated: event(),
    onActivated: event()
  })
  // Electron 的 tabs.getZoom 要求页面是「标签页」，独立窗口里会抛 "No such tab"。
  const realGetZoom = tabs.getZoom
  tabs.getZoom = function () {
    const cb = arguments.length && typeof arguments[arguments.length - 1] === 'function' ? arguments[arguments.length - 1] : null
    const done = (v) => { if (cb) cb(v); return v }
    if (typeof realGetZoom !== 'function') return Promise.resolve(done(1))
    try {
      const p = realGetZoom.apply(tabs, cb ? Array.prototype.slice.call(arguments, 0, -1) : arguments)
      if (p && typeof p.then === 'function') return p.then(done, () => done(1))
      return Promise.resolve(done(1))
    } catch (e) { return Promise.resolve(done(1)) }
  }

  ensure('downloads', { download: api(0), onChanged: event() })

  const ext = ensure('extension', {})
  if (typeof ext.getViews !== 'function') {
    ext.getViews = () => (typeof g.window !== 'undefined' ? [g.window] : [])
  }
})()
