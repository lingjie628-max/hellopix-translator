'use strict'

/**
 * 端到端：真实 AuthService + 真实 memory security，验证解绑子账号后主账号会话仍有效
 *
 * 上一版测试用假 auth（`revokeUser` 只记录参数），所以只能验证"参数对不对"，
 * 验证不了"会话到底被谁删了"。线上 2026-11-11 的现象是：解绑成功（绿字），
 * 紧接着商户自己被踢去登录页（两条"请先登录"）。
 *
 * 这条测试把真实链路接起来：
 *   登录主账号 → 拿到 cookie → 解绑子账号 → 用同一个 cookie 再请求
 * 断言最后一步仍然是 200。
 */

const assert = require('node:assert/strict')
const http = require('node:http')
const express = require('express')
const test = require('node:test')

const { productionRouter } = require('../server/routes/production')
const { AuthService } = require('../server/services/auth-service')
const memorySecurity = require('../server/security')

const MAIN_ID = 501
const SUB_ID = 77

function buildHarness () {
  const subs = new Map()
  const revoked = []

  const accounts = {
    main: {
      id: MAIN_ID,
      username: 'jiufa',
      passwordHash: 'hash',
      status: 1,
      boundDevice: 'MAIN-DEVICE',
      packageId: 1,
      charBalance: 0
    },
    sub: {
      id: SUB_ID,
      parentId: MAIN_ID,
      username: 'emp1',
      passwordHash: 'hash',
      status: 1,
      boundDevice: 'SUB-DEVICE',
      charBalance: 0
    }
  }

  const repo = {
    async accountByUsername (username) {
      if (username === 'jiufa') return { ...accounts.main, kind: 'main' }
      if (username === 'emp1') return { ...accounts.sub, kind: 'sub' }
      return null
    },
    async sessionAccount (subjectId) {
      const [kind, raw] = String(subjectId).split(':')
      if (kind === 'main' && Number(raw) === MAIN_ID) {
        return { kind: 'main', account: accounts.main, parent: accounts.main }
      }
      if (kind === 'sub' && Number(raw) === SUB_ID) {
        return { kind: 'sub', account: accounts.sub, parent: accounts.main }
      }
      return null
    },
    async query (text, values) {
      const statement = String(text)
      if (/SELECT id FROM sub_accounts WHERE id=\$1 AND parent_id=\$2/.test(statement)) {
        const ok = Number(values[0]) === SUB_ID && Number(values[1]) === MAIN_ID
        return { rows: ok ? [{ id: SUB_ID }] : [] }
      }
      if (/UPDATE sub_accounts SET bound_device/.test(statement)) {
        accounts.sub.boundDevice = ''
        return { rows: [], rowCount: 1 }
      }
      if (/UPDATE users SET bound_device/.test(statement)) {
        accounts.main.boundDevice = ''
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
    async list () { return { rows: [], total: 0 } },
    async audit () {}
  }

  const security = memorySecurity.createSecurity()
  const auth = new AuthService(repo, security)

  // 包一层，记录"到底撤了谁的会话"，同时保留真实行为
  const realRevoke = auth.revokeUser.bind(auth)
  auth.revokeUser = (kind, id) => {
    revoked.push({ kind, id: Number(id) })
    return realRevoke(kind, id)
  }

  const redisStub = {
    eval: async () => [1, 1],
    evalsha: async () => [1, 1],
    defineCommand () {},
    get: async () => null,
    set: async () => 'OK',
    del: async () => 1
  }
  const core = { redis: redisStub, platforms: () => [] }
  const nested = { get: () => nested, post: () => nested, use: () => nested }

  const app = express()
  app.use(express.urlencoded({ extended: true }))
  // 真实中间件：登录后 req.pixUser 由 security 里的会话解析出来
  const ctx = {
    repository: repo,
    auth,
    core,
    customers: nested,
    accounts: nested,
    security: { csrf: (_q, _s, n) => n() }
  }
  app.use(productionRouter(ctx))

  // 手工挂一个最小登录入口 —— 生产里这段在 routes/auth.js，
  // 这里只需要"按 username 建会话"这一个行为。
  app.post('/test-login', async (req, res) => {
    const found = await repo.accountByUsername(String(req.body.username || ''))
    if (!found) return res.status(401).json({ success: false })
    await auth.createSessionForTest(req, res, found)
    res.json({ success: true })
  })
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ success: false, msg: err.message, code: err.code })
  })

  const server = app.listen(0)
  const port = server.address().port
  let cookie = ''

  const request = (method, path, body) => new Promise((resolve, reject) => {
    const payload = body ? new URLSearchParams(body).toString() : ''
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: Object.assign(
        { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) },
        cookie ? { Cookie: cookie } : {}
      )
    }, res => {
      const setCookie = res.headers['set-cookie']
      if (setCookie && setCookie.length && !cookie) cookie = setCookie.map(c => c.split(';')[0]).join('; ')
      let out = ''
      res.on('data', c => { out += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(out) } catch (_e) { /* 原文 */ }
        resolve({ status: res.statusCode, json, raw: out })
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })

  return {
    request,
    revoked,
    accounts,
    close: () => new Promise(r => server.close(r))
  }
}

// AuthService 没有"建会话"的公开方法，这里补一个仅测试用的钩子。
// 生产路径走 loginUser → security.createSession(...)，subject 由
// subject(kind, id) 生成 —— 这里复用同一个函数，保证被测的是同一条规则。
AuthService.prototype.createSessionForTest = function (req, res, account) {
  const kind = account.kind === 'sub' ? 'sub' : 'main'
  return this.security.createSession(req, res, 'user', this.subject(kind, account.id), {})
}

test('★ 主账号登录 → 解绑子账号 → 主账号仍然在线（线上 401 的真正回归）', async () => {
  const h = buildHarness()
  try {
    const login = await h.request('POST', '/test-login', { username: 'jiufa' })
    assert.equal(login.status, 200, '主账号应能建立会话：' + login.raw)

    const before = await h.request('GET', '/team/subs/list-probe')
    // 列表接口本身返回什么不重要，关键是「有没有被 middleware 挡成 401」
    assert.notEqual(before.status, 401,
      '刚登录就被判未授权，说明会话根本没建起来：' + before.raw)

    const reset = await h.request('POST', '/team/device/reset', { id: String(SUB_ID) })
    assert.equal(reset.status, 200, '解绑应成功：' + reset.raw)

    assert.deepEqual(h.revoked, [{ kind: 'sub', id: SUB_ID }],
      '只能撤销子账号会话；出现 kind=main 就是把商户自己踢了')

    const after = await h.request('GET', '/team/subs/list-probe')
    assert.notEqual(after.status, 401,
      '解绑子账号之后主账号会话必须仍有效 —— 线上就是这一步变成 401 把人踢去登录页')
  } finally { await h.close() }
})

test('主账号会话销毁不影响子账号会话（反向隔离）', async () => {
  const h = buildHarness()
  try {
    await h.request('POST', '/test-login', { username: 'jiufa' })
    const reset = await h.request('POST', '/team/device/reset', { self: '1' })
    assert.equal(reset.status, 200, reset.raw)
    assert.deepEqual(h.revoked, [{ kind: 'main', id: MAIN_ID }])
  } finally { await h.close() }
})
