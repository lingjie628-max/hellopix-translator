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
    body: new URLSearchParams({ text: 'hello', from: 'auto', to: 'zh', engine: 'deepseek' })
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
    body: new URLSearchParams({ text: 'hello', from: 'auto', to: 'zh', engine: 'deepseek' })
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

test('translation cache is tenant scoped and cached work remains billable', async t => {
  const api = await startApi()
  t.after(api.close)
  const pix = await clientLogin(api.base, 'pix', '123456', 'tenant-pix')
  const demo = await clientLogin(api.base, 'demo', '123456', 'tenant-demo')

  const translate = login => request(api.base, '/apis/translate/run', {
    method: 'POST',
    headers: authHeaders(login),
    body: new URLSearchParams({ text: 'hello', from: 'en', to: 'zh', engine: 'deepseek' })
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
    body: new URLSearchParams({ text: 'hello', from: 'en', to: 'zh', engine: 'deepseek' })
  }).then(value => value.json())
  const results = await Promise.all([makeRequest(), makeRequest()])
  assert.equal(results.filter(result => result.success).length, 1)

  response = await request(api.base, '/apis/user/dashboard', {
    headers: { Cookie: cookieHeader(demo.jar) }
  })
  const dashboard = await response.json()
  assert.equal(dashboard.charBalance, 0)
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
    body: new URLSearchParams({ text: '你好', from: 'auto', to: 'zh', engine: 'deepseek' })
  })
  const result = await response.json()
  assert.equal(result.success, true)
  assert.equal(result.chars, 0)
  assert.equal(result.remain, before)
})

// ---------------------------------------------------------------------------
// 数据库传输安全守卫
//
// 数据库迁到独立主机却忘了开 TLS，是个**完全没有症状**的问题：
// 服务照常运行，口令哈希与通道密钥却在网络上明文传输。
// 所以做成启动守卫 —— 宁可拒绝启动，也不裸奔。
// ---------------------------------------------------------------------------

const { spawnSync } = require('node:child_process')
const path = require('node:path')

function tryBoot(env) {
  const r = spawnSync(process.execPath, ['-e', 'require("./server/config")'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, env),
    encoding: 'utf8'
  })
  return { ok: r.status === 0, err: (r.stderr || '') + (r.stdout || '') }
}

const BASE = {
  NODE_ENV: 'production',
  REDIS_URL: 'redis://:somepassword@127.0.0.1:6380',
  DATABASE_SSL_MODE: 'disable'
}

test('数据库在远程主机但 SSL 关闭 → 拒绝启动', () => {
  const r = tryBoot(Object.assign({}, BASE, {
    DATABASE_URL: 'postgres://u:p@db.example.com:5432/x'
  }))
  assert.equal(r.ok, false, '跨网络的明文数据库连接必须被拦下')
  assert.match(r.err, /DATABASE_SSL_MODE/)
})

test('远程数据库必须是 verify-full —— require 都不够', () => {
  // 不是"开了 TLS 就行"：require 只加密不验证证书，中间人可以用自签证书
  // 冒充数据库。verify-full 会校验主机名与证书链，才是真正的端到端。
  const weak = tryBoot(Object.assign({}, BASE, {
    DATABASE_URL: 'postgres://u:p@db.example.com:5432/x',
    DATABASE_SSL_MODE: 'require'
  }))
  assert.equal(weak.ok, false, 'require 不足以保护远程连接')
  assert.match(weak.err, /verify-full/)

  // verify-full 还要求提供 CA 证书（否则拿什么校验服务器身份）
  const missingCa = tryBoot(Object.assign({}, BASE, {
    DATABASE_URL: 'postgres://u:p@db.example.com:5432/x',
    DATABASE_SSL_MODE: 'verify-full'
  }))
  assert.equal(missingCa.ok, false, 'verify-full 缺 CA 必须拒绝启动')
  assert.match(missingCa.err, /DATABASE_SSL_CA_FILE/)

  // 给了 CA 才放行
  const caPath = path.join(require('node:os').tmpdir(), 'pix-test-ca.pem')
  require('node:fs').writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n')
  try {
    const ok = tryBoot(Object.assign({}, BASE, {
      DATABASE_URL: 'postgres://u:p@db.example.com:5432/x',
      DATABASE_SSL_MODE: 'verify-full',
      DATABASE_SSL_CA_FILE: caPath
    }))
    assert.equal(ok.ok, true, ok.err.slice(0, 200))
  } finally {
    require('node:fs').unlinkSync(caPath)
  }
})

test('数据库在本机 → 不因 SSL 关闭被拦（回环上 TLS 无实际收益）', () => {
  for (const host of ['127.0.0.1', 'localhost']) {
    const r = tryBoot(Object.assign({}, BASE, {
      DATABASE_URL: `postgres://u:p@${host}:5432/x`
    }))
    assert.equal(r.ok, true, `${host} 不该被拦: ${r.err.slice(0, 200)}`)
  }
})
