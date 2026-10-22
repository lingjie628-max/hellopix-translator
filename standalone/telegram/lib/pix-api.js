'use strict'

const crypto = require('crypto')

function createPixApi(options) {
  const state = {
    base: String(options.base || 'http://127.0.0.1:8080').replace(/\/+$/, ''),
    cookies: Object.assign({}, options.cookies || {}),
    deviceId: options.deviceId || crypto.randomUUID()
  }
  // cookie 一变就落盘。
  //
  // 原来 macOS 版只把 deviceId 和 profile 存进 store，`state.cookies`
  // 只活在内存里 —— 进程一退，服务端会话就没了。Windows 版早就做了这件事
  // （见 telegram-win/lib/pix-api.js），两个平台的行为不该不一致。
  const onCookies = typeof options.onCookies === 'function' ? options.onCookies : null
  // fetch 可注入：生产走全局，测试可以塞一个假的。
  //
  // 没有这个注入点的话，"退出登录真的把 cookie 清干净了吗"只能靠读代码确认 ——
  // 而这恰恰是一个真机故障过的地方（跨账号串号），必须能被测试直接钉住。
  //
  // ★ 不能在工厂调用时就把 globalThis.fetch 存下来 ★
  //   那样等于把当时的实现焊死：之后任何替换（测试打桩、代理层、
  //   undici 初始化）都会被忽略。用一个惰性解析器，每次请求现取。
  const injectedFetch = typeof options.fetch === 'function' ? options.fetch : null
  function doFetch(url, init) {
    const fn = injectedFetch || globalThis.fetch
    if (typeof fn !== 'function') throw new Error('运行环境没有 fetch')
    return fn(url, init)
  }

  function cookieHeader() {
    // 空值不能发出去。
    //
    // `pix_user=` 这样的空 cookie 打到服务端时，`parseCookies` 会解析出
    // 一个空字符串 token。那本身不会被当成有效会话，但它会让"当前是否
    // 已登录"的判断变成"有个 cookie 但这 cookie 是空的"，而不同实现对
    // 空串的处理并不一致 —— 不如根本不发。
    return Object.keys(state.cookies)
      .filter(name => state.cookies[name])
      .map(name => `${name}=${state.cookies[name]}`)
      .join('; ')
  }

  /**
   * 客户端不该收的 cookie 名（生产带 `__Host-`，开发不带）。
   *
   * 用**排除法**而不是白名单：白名单坏起来是"服务端将来新增的客户端
   * cookie 被静默丢掉"，那类 bug 表现是"后端说发了、抓包也有、就是不生效"。
   * 排除法坏起来只是多带一个，而服务端签名还拦得住。两种失效代价不对称。
   *
   * 这里和 `desktop/main.js` 的 `isClientCookie` 是同一个口径 —— 两个客户端
   * 连的是同一套服务端，cookie 边界必须一致。
   */
  const CLIENT_COOKIE_DENY = new Set([
    '__Host-pix_admin', 'pix_admin_session', 'pix_admin'
  ])

  function isClientCookie(name) {
    if (CLIENT_COOKIE_DENY.has(name)) return false
    return /^(__Host-)?pix_/.test(name)
  }

  function rememberCookies(response) {
    const raw = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean)
    let changed = false
    raw.forEach(value => {
      const match = String(value).match(/(?:^|,\s*)((?:__Host-)?pix_[^=]+)=([^;,]*)/)
      if (!match) return
      const name = match[1]
      if (!isClientCookie(name)) return
      // 空值 = 服务端要求清掉这条。写成空字符串的话 cookieHeader 里会出现
      // `pix_user=`，那跟"没有这条 cookie"是两回事 —— 有些服务端会把
      // 空 token 当成一次真实的（无效）会话，而不是"未登录"。
      if (match[2]) {
        if (state.cookies[name] !== match[2]) {
          state.cookies[name] = match[2]
          changed = true
        }
      } else if (name in state.cookies) {
        delete state.cookies[name]
        changed = true
      }
    })
    if (changed && onCookies) {
      try { onCookies(Object.assign({}, state.cookies)) } catch (_error) {}
    }
  }

  async function request(pathname, opts) {
    const options = opts || {}
    const headers = { Accept: 'application/json', 'X-Pix-Device': state.deviceId }
    const cookie = cookieHeader()
    if (cookie) headers.Cookie = cookie
    if (!['GET', 'HEAD', 'OPTIONS'].includes(String(options.method || 'GET').toUpperCase())) {
      const csrf = state.cookies['__Host-pix_csrf'] || state.cookies.pix_csrf
      if (csrf) headers['X-CSRF-Token'] = decodeURIComponent(csrf)
    }
    // 幂等键：头 + 请求体双写。
    //
    // 服务端 `requireIdempotencyKey` 读 `Idempotency-Key` 头，**也**认 body 里的
    // `requestId`。两个客户端连的是同一套服务端，但不能指望部署顺序永远一致 ——
    // 头与体同时给，对面是哪个版本都拿得到键。
    if (options.idempotencyKey) headers['Idempotency-Key'] = String(options.idempotencyKey)
    const form = options.form ? Object.assign({}, options.form) : null
    if (form && options.idempotencyKey && form.requestId === undefined) {
      form.requestId = String(options.idempotencyKey)
    }
    let body
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(form).toString()
    }
    let response
    try {
      response = await doFetch(state.base + '/apis' + pathname, {
        method: options.method || 'GET',
        headers,
        body
      })
    } catch (_error) {
      // 连接层失败必须给出**人能看懂**的话。
      // 原来这里直接把 undici 的 `TypeError: fetch failed` 抛给渲染进程，
      // 用户看到的就是一行英文堆栈，完全不知道要检查服务地址还是网络。
      // 与 Windows 版保持一致的口径：告诉他在哪改、改什么。
      throw new Error(`连不上后台（${state.base}）。请确认 Hello Pix 服务已启动，或在设置里把服务器地址改成正确的后台地址`)
    }
    rememberCookies(response)
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch (_error) {
      throw new Error('Hello Pix 线路无法连接')
    }
  }

  return {
    state,
    request,
    setBase(url) {
      state.base = String(url || state.base).replace(/\/+$/, '')
    },
    /**
     * 丢掉整个服务端会话。
     *
     * 退出登录时只把 `data.pix` 清掉是不够的：`state.cookies` 里还留着
     * 上一个账号的 `pix_user` / `pix_csrf`。下一次 `pix:login` 会带着这组
     * 旧 cookie 去发登录请求，服务端看到"已有一个有效会话"就直接复用 ——
     * 用户以为登的是 B 账号，实际进的是 A 账号。多开/共享设备上这是
     * 实打实的串号。
     */
    clearSession() {
      state.cookies = {}
      if (onCookies) {
        try { onCookies({}) } catch (_error) {}
      }
    }
  }
}

module.exports = { createPixApi }
