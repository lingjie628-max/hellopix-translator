'use strict'

const crypto = require('crypto')

function createPixApi(options) {
  const state = {
    base: String(options.base || 'http://127.0.0.1:8080').replace(/\/+$/, ''),
    cookies: Object.assign({}, options.cookies || {}),
    deviceId: options.deviceId || crypto.randomUUID()
  }

  function cookieHeader() {
    return Object.keys(state.cookies).map(name => `${name}=${state.cookies[name]}`).join('; ')
  }

  function rememberCookies(response) {
    const raw = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean)
    raw.forEach(value => {
      const match = String(value).match(/(?:^|,\s*)((?:__Host-)?pix_[^=]+)=([^;,]*)/)
      if (match) state.cookies[match[1]] = match[2]
    })
    if (typeof options.onCookies === 'function') options.onCookies(state.cookies)
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
    let body
    if (options.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(options.form).toString()
    }
    let response
    try {
      response = await fetch(state.base + '/apis' + pathname, {
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
    }
  }
}

module.exports = { createPixApi }
