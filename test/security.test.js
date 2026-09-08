const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const registerApi = require('../mock')
const { createSecurity } = require('../server/security')

async function startApi(options) {
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
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(resolve))
  }
}

function cookieJar(response) {
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

function cookieHeader(jar) {
  return Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; ')
}

async function request(base, path, options) {
  return fetch(base + path, options)
}

async function clientLogin(base, username, password, deviceId) {
  const response = await request(base, '/apis/client/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, deviceId })
  })
  return { response, jar: cookieJar(response), deviceId }
}

function authHeaders(login) {
  return {
    Cookie: cookieHeader(login.jar),
    'X-Pix-Device': login.deviceId,
    'X-CSRF-Token': decodeURIComponent(login.jar.pix_csrf),
    'Content-Type': 'application/x-www-form-urlencoded'
  }
}

test('rejects unauthenticated and forged legacy cookies', async t => {
  const api = await startApi()
  t.after(api.close)

  let response = await request(api.base, '/apis/user/dashboard')
  assert.equal(response.status, 401)

  response = await request(api.base, '/apis/user/dashboard', {
    headers: { Cookie: 'pix_uid=10001' }
  })
  assert.equal(response.status, 401)

  response = await request(api.base, '/apis/admin/stats', {
    headers: { Cookie: 'pix_admin=admin' }
  })
  assert.equal(response.status, 401)
})

test('desktop session requires bound device and CSRF for writes', async t => {
  const api = await startApi()
  t.after(api.close)

  const login = await request(api.base, '/apis/client/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'pix', password: '123456', deviceId: 'desktop-test' })
  })
  assert.equal(login.status, 200)
  const loginBody = await login.json()
  assert.equal(loginBody.success, true)
  const jar = cookieJar(login)
  assert.ok(jar.pix_user)
  assert.ok(jar.pix_csrf)

  let response = await request(api.base, '/apis/client/session', {
    headers: { Cookie: cookieHeader(jar), 'X-Pix-Device': 'wrong-device' }
  })
  assert.equal(response.status, 401)

  response = await request(api.base, '/apis/client/session', {
    headers: { Cookie: cookieHeader(jar), 'X-Pix-Device': 'desktop-test' }
  })
  assert.equal(response.status, 200)

  response = await request(api.base, '/apis/translate/run', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(jar),
      'X-Pix-Device': 'desktop-test',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ text: 'hello', from: 'auto', to: 'zh', engine: 'youdao' })
  })
  assert.equal(response.status, 403)

  response = await request(api.base, '/apis/translate/run', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(jar),
      'X-Pix-Device': 'desktop-test',
      'X-CSRF-Token': decodeURIComponent(jar.pix_csrf),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ text: 'hello', from: 'auto', to: 'zh', engine: 'youdao' })
  })
  assert.equal(response.status, 200)
})

test('login endpoint is rate limited', async t => {
  const api = await startApi()
  t.after(api.close)
  let status = 0
  for (let i = 0; i < 9; i += 1) {
    const response = await request(api.base, '/apis/client/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'rate-user', password: 'bad-password', deviceId: 'device' })
    })
    status = response.status
  }
  assert.equal(status, 429)
})

test('admin session cannot be forged and sensitive writes require CSRF', async t => {
  const api = await startApi()
  t.after(api.close)
  const login = await request(api.base, '/apis/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'admin123' })
  })
  const jar = cookieJar(login)
  assert.ok(jar.pix_admin_session)
  assert.ok(jar.pix_csrf)

  let response = await request(api.base, '/apis/admin/stats', {
    headers: { Cookie: cookieHeader(jar) }
  })
  assert.equal(response.status, 200)

  response = await request(api.base, '/apis/admin/staff/save', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(jar),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ id: '1', nickname: 'Blocked' })
  })
  assert.equal(response.status, 403)

  response = await request(api.base, '/apis/admin/staff/save', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(jar),
      'X-CSRF-Token': decodeURIComponent(jar.pix_csrf),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ id: '1', nickname: '超级管理员' })
  })
  assert.equal(response.status, 200)
})

test('production cookies carry secure attributes', () => {
  const headers = new Map()
  const response = {
    getHeader: name => headers.get(name),
    setHeader: (name, value) => headers.set(name, value)
  }
  const security = createSecurity({ production: true })
  security.createSession(response, 'user', 10001, { remember: true })
  const values = headers.get('Set-Cookie')
  assert.ok(values.some(value => value.startsWith('__Host-pix_user=')))
  assert.ok(values.some(value => value.includes('HttpOnly')))
  assert.ok(values.every(value => value.includes('Secure')))
  assert.ok(values.every(value => value.includes('SameSite=')))
})

test('public order sharing requires a short-lived grant', async t => {
  const api = await startApi()
  t.after(api.close)
  const orderNum = 'HP20260902001'

  let response = await request(api.base, '/apis/order/selectOrderBySerialNumber', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ serialNumber: orderNum })
  })
  const summary = await response.json()
  assert.equal(response.status, 200)
  assert.equal(summary.data.sharePassword, undefined)

  response = await request(api.base, '/apis/orderDetails/shareOrder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ orderNum })
  })
  assert.equal(response.status, 403)

  response = await request(api.base, '/apis/order/checkSharePwd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ serialNumber: orderNum, sharePassword: 'abc123' })
  })
  const grant = await response.json()
  assert.equal(response.status, 200)
  assert.ok(grant.token)

  response = await request(api.base, '/apis/orderDetails/shareOrder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ orderNum, shareToken: grant.token })
  })
  assert.equal(response.status, 200)
})

test('demo identities and payment are disabled unless explicitly enabled', async t => {
  const locked = await startApi({ testMode: false })
  t.after(locked.close)
  let response = await request(locked.base, '/apis/client/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'pix', password: '123456', deviceId: 'locked' })
  })
  assert.equal((await response.json()).success, false)

  const api = await startApi()
  t.after(api.close)
  const login = await clientLogin(api.base, 'pix', '123456', 'payment-test')
  response = await request(api.base, '/apis/weixin/weixinPay?baseid=1&month=1&out_trade_no=x', {
    headers: { Cookie: cookieHeader(login.jar) }
  })
  assert.equal(response.status, 503)
})

test('order edits cannot overwrite ownership or immutable identifiers', async t => {
  const api = await startApi()
  t.after(api.close)
  const login = await clientLogin(api.base, 'pix', '123456', 'order-test')

  let response = await request(api.base, '/apis/order/editOrder', {
    method: 'POST',
    headers: authHeaders(login),
    body: new URLSearchParams({
      id: '1',
      userId: '10002',
      serialNumber: 'ATTACKER',
      title: '安全标题'
    })
  })
  assert.equal(response.status, 200)

  response = await request(api.base, '/apis/order/getOrder', {
    method: 'POST',
    headers: authHeaders(login),
    body: new URLSearchParams({ page: '1', rows: '500' })
  })
  const list = await response.json()
  const order = list.rows.find(item => String(item.id) === '1')
  assert.equal(order.userId, 10001)
  assert.equal(order.serialNumber, 'HP20260902001')
  assert.equal(order.title, '安全标题')
  assert.ok(list.rows.length <= 100)
})

test('translation cache is tenant scoped and cached work remains billable', async t => {
  const api = await startApi()
  t.after(api.close)
  const pix = await clientLogin(api.base, 'pix', '123456', 'tenant-pix')
  const demo = await clientLogin(api.base, 'demo', '123456', 'tenant-demo')

  const translate = login => request(api.base, '/apis/translate/run', {
    method: 'POST',
    headers: authHeaders(login),
    body: new URLSearchParams({ text: 'hello', from: 'en', to: 'zh', engine: 'youdao' })
  }).then(response => response.json())

  const first = await translate(pix)
  const second = await translate(pix)
  const otherTenant = await translate(demo)
  assert.equal(first.success, true)
  assert.equal(second.cached, true)
  assert.equal(second.chars, 5)
  assert.notEqual(otherTenant.cached, true)
  assert.equal(otherTenant.chars, 5)
})

test('translation balance is reserved before concurrent provider work', async t => {
  const api = await startApi()
  t.after(api.close)
  const adminResponse = await request(api.base, '/apis/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'admin123' })
  })
  const adminJar = cookieJar(adminResponse)
  let response = await request(api.base, '/apis/admin/users/save', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(adminJar),
      'X-CSRF-Token': decodeURIComponent(adminJar.pix_csrf),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ id: '10002', versionId: '1', charBalance: '5' })
  })
  assert.equal(response.status, 200)

  const demo = await clientLogin(api.base, 'demo', '123456', 'concurrency-demo')
  const makeRequest = () => request(api.base, '/apis/translate/run', {
    method: 'POST',
    headers: authHeaders(demo),
    body: new URLSearchParams({ text: 'hello', from: 'en', to: 'zh', engine: 'youdao' })
  }).then(value => value.json())
  const results = await Promise.all([makeRequest(), makeRequest()])
  assert.equal(results.filter(result => result.success).length, 1)

  response = await request(api.base, '/apis/user/dashboard', {
    headers: { Cookie: cookieHeader(demo.jar) }
  })
  const dashboard = await response.json()
  assert.equal(dashboard.charBalance, 0)
})

test('share password attempts are rate limited', async t => {
  const api = await startApi()
  t.after(api.close)
  let status = 0
  for (let i = 0; i < 7; i += 1) {
    const response = await request(api.base, '/apis/order/checkSharePwd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        serialNumber: 'HP20260902001',
        sharePassword: 'wrong-password'
      })
    })
    status = response.status
  }
  assert.equal(status, 429)
})

test('operator accounts are read-only for admin mutations', async t => {
  const api = await startApi()
  t.after(api.close)
  const adminResponse = await request(api.base, '/apis/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'admin123' })
  })
  const adminJar = cookieJar(adminResponse)
  let response = await request(api.base, '/apis/admin/staff/save', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(adminJar),
      'X-CSRF-Token': decodeURIComponent(adminJar.pix_csrf),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      username: 'operator-test',
      password: 'operator-pass',
      nickname: '只读运营',
      role: 'operator'
    })
  })
  assert.equal(response.status, 200)

  const operatorResponse = await request(api.base, '/apis/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'operator-test', password: 'operator-pass' })
  })
  const operatorJar = cookieJar(operatorResponse)
  response = await request(api.base, '/apis/admin/orders/status', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(operatorJar),
      'X-CSRF-Token': decodeURIComponent(operatorJar.pix_csrf),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ id: '1', status: '0' })
  })
  assert.equal(response.status, 403)
})

test('CSRF token must belong to the session type authorizing the route', async t => {
  const api = await startApi()
  t.after(api.close)
  const user = await clientLogin(api.base, 'pix', '123456', 'csrf-user')
  const adminResponse = await request(api.base, '/apis/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'admin123' })
  })
  const admin = cookieJar(adminResponse)
  const mixedCookies = {
    pix_user: user.jar.pix_user,
    pix_admin_session: admin.pix_admin_session,
    pix_csrf: user.jar.pix_csrf
  }
  const response = await request(api.base, '/apis/admin/users/status', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(mixedCookies),
      'X-CSRF-Token': decodeURIComponent(user.jar.pix_csrf),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ id: '10001', status: '0' })
  })
  assert.equal(response.status, 403)
})

test('same-language or unchanged translations do not consume balance', async t => {
  const api = await startApi()
  t.after(api.close)
  const login = await clientLogin(api.base, 'pix', '123456', 'same-language')
  let response = await request(api.base, '/apis/user/dashboard', {
    headers: { Cookie: cookieHeader(login.jar) }
  })
  const before = (await response.json()).charBalance

  response = await request(api.base, '/apis/translate/run', {
    method: 'POST',
    headers: authHeaders(login),
    body: new URLSearchParams({ text: '你好', from: 'auto', to: 'zh', engine: 'youdao' })
  })
  const result = await response.json()
  assert.equal(result.success, true)
  assert.equal(result.chars, 0)
  assert.equal(result.remain, before)
})
