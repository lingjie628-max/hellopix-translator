'use strict'

/**
 * /team/device/reset 的会话撤销范围
 *
 * ## 现场
 *
 * 生产日志（2026-11-11 16:30）:
 *
 *   POST /apis/team/device/reset -> 200
 *   GET  /apis/team/subs         -> 401   ← 商户自己下一秒被踢了
 *   POST /apis/team/device/reset -> 200
 *   GET  /apis/team/subs         -> 401
 *
 * 商户主账号给子账号点「解绑电脑」，接口回 200，但**主账号自己的会话
 * 也被撤掉了**。原来的测试只做字符串匹配（`assert.match(block, /revokeUser/)`），
 * 完全没验证"撤的是谁"，所以这个 bug 一路绿灯进了生产。
 *
 * ## 这条测试的做法
 *
 * 起一个真实 express，塞一个假的 repository（记录每条 SQL 及其参数）和
 * 假的 auth（记录 revokeUser 的实参），然后真的发 HTTP 请求。断言的是
 * **副作用落在哪个账号上**，而不是源码里出现了什么字符。
 */

const assert = require('node:assert/strict')
const http = require('node:http')
const express = require('express')
const test = require('node:test')

const { productionRouter } = require('../server/routes/production')
const { mapRows } = require('../server/repositories/production-repository')

const MAIN_ID = 42
const SUB_ID = 77

/**
 * 搭一个只够跑 /team/device/reset 的最小环境。
 *
 * `ownerFound` 控制归属校验的返回：true = 子账号属于该商户。
 */
function harness ({ kind = 'main', accountId = MAIN_ID, ownerFound = true, ownedIds = [], body = {} } = {}) {
  const sql = []
  const revoked = []

  const repo = {
    async query (text, values) {
      const statement = String(text)
      sql.push({ text: statement, values: values || [] })
      if (/SELECT id FROM sub_accounts WHERE id=\$1 AND parent_id=\$2/.test(statement)) {
        // 归属校验：默认只认 SUB_ID；ownerFound=false 时一律不认。
        // `ownedIds` 允许测试指定"这个商户名下有哪几个子账号 id"。
        const wanted = Number(values[0])
        const allowed = ownerFound && (ownedIds.length ? ownedIds.includes(wanted) : wanted === SUB_ID)
        return { rows: allowed ? [{ id: wanted }] : [] }
      }
      return { rows: [], rowCount: 1 }
    },
    async list () { return { rows: [], total: 0 } }
  }

  const auth = {
    async revokeUser (who, id) { revoked.push({ kind: who, id: Number(id) }) },
    async verify () { return true },
    async hash () { return 'x' },
    async hashSecret () { return 'x' },
    middleware () {
      return (req, _res, next) => {
        req.pixUser = { kind, parent: { id: MAIN_ID }, account: { id: accountId } }
        next()
      }
    }
  }

  // buildContext 会用 core.redis 建限流器，只要够 evalScript/限流脚本跑起来即可。
  // 被测的是解绑分支，限流器一律放行。
  const redisStub = {
    eval: async () => [1, 1],
    evalsha: async () => [1, 1],
    defineCommand () {},
    get: async () => null,
    set: async () => 'OK',
    del: async () => 1,
    hgetall: async () => ({}),
    multi () { return this },
    exec: async () => [] }
  const core = { redis: redisStub, platforms: () => [] }
  const nested = { get: () => nested, post: () => nested, use: () => nested }
  const ctx = {
    repository: repo,
    auth,
    core,
    customers: nested,
    accounts: nested,
    security: { csrf: (_q, _s, n) => n() }
  }

  const app = express()
  app.use(express.urlencoded({ extended: true }))
  app.use(express.json())
  app.use(productionRouter(ctx))
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ success: false, msg: err.message, code: err.code })
  })

  const server = app.listen(0)
  const port = server.address().port

  const post = payload => new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {})
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/team/device/reset',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let out = ''
      res.on('data', c => { out += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(out) } catch (_e) { /* 原文 */ }
        resolve({ status: res.statusCode, json, raw: out })
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })

  return { post, sql, revoked, close: () => new Promise(r => server.close(r)) }
}

test('★ 撞号回归：子账号 id 与主账号 id 相同，也必须解绑子账号而不是自己', async () => {
  // 线上真实数据：users.id=37 是 jiufa，sub_accounts.id=37 是它的子账号 shijiu。
  // 两张表各有一套自增序列，撞号是常态。旧代码用
  //   data.id !== parent.id  → 判断是不是子账号
  // 于是 37 !== 37 为假，直接解绑了主账号自己，还把它踢下线。
  const h = harness({ kind: 'main', accountId: MAIN_ID, ownedIds: [MAIN_ID], body: { id: MAIN_ID } })
  try {
    const res = await h.post({ id: String(MAIN_ID), target: 'sub' })
    assert.equal(res.status, 200, res.raw)

    const update = h.sql.find(s => /UPDATE (sub_accounts|users) SET bound_device/.test(s.text))
    assert.ok(update, '必须执行一次清零')
    assert.match(update.text, /UPDATE sub_accounts/,
      'id 与主账号相同也必须更新 sub_accounts —— 更新 users 就是把商户自己解绑了')
    assert.deepEqual(h.revoked, [{ kind: 'sub', id: MAIN_ID }],
      '撤销的必须是 sub:' + MAIN_ID + '，绝不是 main:' + MAIN_ID)
  } finally { await h.close() }
})

test('target=self 明确表示解绑自己，不受 id 影响', async () => {
  const h = harness({ kind: 'main', body: { target: 'self', id: 999 } })
  try {
    const res = await h.post({ target: 'self', id: 999 })
    assert.equal(res.status, 200, res.raw)
    assert.deepEqual(h.revoked, [{ kind: 'main', id: MAIN_ID }],
      'self 语义下忽略传入的 id')
  } finally { await h.close() }
})

test('target 取值非法必须 400', async () => {
  const h = harness({ kind: 'main' })
  try {
    const res = await h.post({ target: 'admin', id: 1 })
    assert.equal(res.status, 400, res.raw)
    assert.equal(res.json.code, 'BAD_TARGET')
    assert.deepEqual(h.revoked, [])
  } finally { await h.close() }
})

test('原有用例：主账号解绑子账号：只撤子账号会话，绝不能碰主账号', async () => {
  const h = harness({ kind: 'main', body: { id: SUB_ID } })
  try {
    const res = await h.post({ id: SUB_ID })

    assert.equal(res.status, 200, '解绑应成功：' + res.raw)

    // 1) 清掉的是 sub_accounts 里那条，不是 users
    const update = h.sql.find(s => /UPDATE (sub_accounts|users) SET bound_device/.test(s.text))
    assert.ok(update, '必须执行一次 bound_device 清零')
    assert.match(update.text, /UPDATE sub_accounts/,
      '主账号解绑子账号时必须更新 sub_accounts，更新 users 等于把商户自己解绑了')
    assert.deepEqual(update.values, [SUB_ID],
      '清零目标必须是子账号 id')

    // 2) 会话撤销只能是 sub:SUB_ID
    assert.deepEqual(h.revoked, [{ kind: 'sub', id: SUB_ID }],
      '必须且只能撤销子账号会话；出现 kind=main 就说明商户会被自己踢下线')
  } finally { await h.close() }
})

test('★ 解绑子账号后主账号会话仍然有效（回归 401 现场）', async () => {
  const h = harness({ kind: 'main', body: { id: SUB_ID } })
  try {
    await h.post({ id: SUB_ID })
    const hitMain = h.revoked.some(r => r.kind !== 'sub' || Number(r.id) === MAIN_ID)
    assert.equal(hitMain, false,
      '主账号(users#' + MAIN_ID + ')的会话被撤销了 —— 这正是线上点完解绑就退出的原因')
  } finally { await h.close() }
})

test('主账号不能解绑别人家的子账号（404，且不产生任何副作用）', async () => {
  const h = harness({ kind: 'main', ownerFound: false })
  try {
    const res = await h.post({ id: 999 })
    assert.equal(res.status, 404, '越权应回 404：' + res.raw)
    assert.deepEqual(h.revoked, [], '越权时不能撤销任何会话')
    assert.equal(
      h.sql.filter(s => /UPDATE/.test(s.text)).length, 0,
      '越权时不能更新任何行')
  } finally { await h.close() }
})

test('主账号不带 id 调用 = 必须报错，不能静默解绑自己（线上 401 的根因）', async () => {
  const h = harness({ kind: 'main' })
  try {
    const res = await h.post({})
    assert.equal(res.status, 400,
      '缺 id 时应回 400 SUB_ID_REQUIRED，而不是默默把商户自己解绑踢下线：' + res.raw)
    assert.equal(res.json && res.json.code, 'SUB_ID_REQUIRED')
    assert.deepEqual(h.revoked, [], '缺 id 时绝不能撤销任何会话')
    assert.equal(h.sql.filter(s => /UPDATE/.test(s.text)).length, 0,
      '缺 id 时绝不能更新 users 表')
  } finally { await h.close() }
})

test('主账号显式 self=1 才允许解绑自己', async () => {
  const h = harness({ kind: 'main' })
  try {
    const res = await h.post({ self: 1 })
    assert.equal(res.status, 200, res.raw)
    assert.deepEqual(h.revoked, [{ kind: 'main', id: MAIN_ID }],
      'self=1 是明确的自助解绑，只影响主账号自己')
    const update = h.sql.find(s => /UPDATE users SET bound_device/.test(s.text))
    assert.ok(update, '显式 self=1 时应更新 users 表')
  } finally { await h.close() }
})

test('子账号只能解绑自己，传别人的 id 没用', async () => {
  const h = harness({ kind: 'sub', accountId: SUB_ID })
  try {
    const res = await h.post({ id: 12345 })
    assert.equal(res.status, 200, res.raw)
    assert.deepEqual(h.revoked, [{ kind: 'sub', id: SUB_ID }],
      '子账号身份下无论传什么 id，都只能作用于自己')
  } finally { await h.close() }
})
