'use strict'

const crypto = require('crypto')

/**
 * 客户端不该收的 cookie 名（生产带 `__Host-`，开发不带）。
 *
 * `(?:__Host-)?pix_` 是**前缀**匹配，`__Host-pix_admin` / `pix_admin_session`
 * 这类管理端会话也会被收进来。这个客户端永远不调管理员接口，那条 cookie
 * 唯一的去向就是被拼进每个 `/apis/client/*` 的 Cookie 头 ——
 * 而且这里的 cookies 还会被写进 bridge 文件交给 Telegram 进程。
 * 一个普通用户在他自己电脑上同时登着管理后台时，管理端会话就这样漏出去了。
 */
const CLIENT_COOKIE_DENY = /^(__Host-)?pix_(admin|admin_session)$/

function isClientCookie(name) {
  return /^(__Host-)?pix_/.test(name) && !CLIENT_COOKIE_DENY.test(name)
}

function createPixApi(options) {
  const state = {
    base: String(options.base || 'http://127.0.0.1:8080').replace(/\/+$/, ''),
    cookies: Object.assign({}, options.cookies || {}),
    deviceId: options.deviceId || crypto.randomUUID()
  }

  const onCookies = typeof options.onCookies === 'function' ? options.onCookies : null
  // fetch 可注入：生产走全局，测试可以塞一个假的。
  // 惰性解析，不在工厂调用时焊死 —— 否则之后任何替换（测试打桩、代理层）都会被忽略。
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
      // `pix_user=`，那跟"没有这条 cookie"是两回事。
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
    if (options.idempotencyKey) headers['Idempotency-Key'] = String(options.idempotencyKey)
    // 幂等键同时写进请求体。
    //
    // 服务端读的是 `Idempotency-Key` 头，但**旧版服务端可能只认 body 里的
    // `requestId`**（core-service 的 requireIdempotencyKey 两个都看）。两个
    // 客户端连的是同一套服务端，不能指望部署顺序永远一致 —— 头与体同时给，
    // 无论对面是哪个版本都拿得到键。
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
      throw new Error('连不上后台。Windows 上的 127.0.0.1 是这台电脑自己，请先在本机启动 Hello Pix 服务，或把服务器改成后台那台电脑的地址，例如 http://192.168.1.8:8080')
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
     * 退出登录时只清 `data.pix` 是不够的：`state.cookies` 里还留着上一个账号的
     * `pix_user`。下一次登录会带着这组旧 cookie 请求，服务端看到"已有有效会话"
     * 就直接复用 —— 用户以为登的是 B，实际进的是 A。
     *
     * main.js 的 pix:logout 里虽然直接写了 `pix.state.cookies = {}`，
     * 但那条路径绕过了 onCookies 回调（磁盘上的 pixCookies 靠 main.js 单独清）。
     * 任何**未来新增**的登出入口都容易漏掉其中一步。把这件事收敛到 api 自己身上，
     * 调用方只需要 `pix.clearSession()`。
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
