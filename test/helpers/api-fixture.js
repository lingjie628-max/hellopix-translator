'use strict'

/**
 * API 测试夹具（从 test/security.test.js 抽出来，供多个测试文件共用）。
 *
 * 用的是 `mock/` 里那套内存实现 —— 它现在与生产**共用同一张能力表**
 * （server/lib/capabilities.js），所以在这里验证的授权行为和生产一致。
 */

const express = require('express')
const registerApi = require('../../mock')
const { createSecurity } = require('../../server/security')

async function startApi (options) {
  const opts = options || {}
  const app = express()
  app.set('trust proxy', 'loopback')
  app.use(express.urlencoded({ extended: false, limit: '256kb' }))
  app.use(express.json({ limit: '256kb' }))
  registerApi(app, {
    security: createSecurity({ production: false }),
    testMode: opts.testMode !== false,
    enableDemoPayment: opts.enableDemoPayment === true
  })
  const server = await new Promise(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value))
  })
  const address = server.address()
  return {
    app,
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(resolve))
  }
}

function cookieJar (response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || '']
  const out = {}
  values.forEach(value => {
    const match = String(value).match(/(?:^|,\s*)((?:__Host-)?pix_[^=]+)=([^;,]*)/)
    if (match) out[match[1]] = match[2]
    const csrf = String(value).match(/(?:^|,\s*)((?:__Host-)?pix_csrf)=([^;,]*)/)
    if (csrf) out[csrf[1]] = csrf[2]
  })
  return out
}

function cookieHeader (jar) {
  return Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; ')
}

async function request (base, path, options) {
  return fetch(base + path, options)
}

module.exports = { startApi, cookieJar, cookieHeader, request }
