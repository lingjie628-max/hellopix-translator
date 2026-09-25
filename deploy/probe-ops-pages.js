'use strict'

/**
 * 运营两页（在线账号 / 进粉统计）的真实响应探针。
 *
 * 这两页曾经查旧工单模型的空表并返回 503「该兼容模块尚未迁移到 PostgreSQL」，
 * 现在改为读 conversations / customers。这个脚本用**线上那一份 routing 代码 +
 * 线上数据库**验证：接口真的通了、字段真的是前端要的那些、筛选真的生效。
 *
 * 鉴权层照例替换（这不是被测对象），其余全部原样。
 *
 * 用法：node deploy/probe-ops-pages.js
 */

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const APP = process.env.APP_DIR || '/opt/hello-pix'
const express = require(path.join(APP, 'node_modules/express'))
const { Pool } = require(path.join(APP, 'node_modules/pg'))
const Redis = require(path.join(APP, 'node_modules/ioredis'))

const env = {}
fs.readFileSync('/etc/hello-pix/hello-pix.env', 'utf8').split('\n').forEach(line => {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
})

const { productionRouter } = require(path.join(APP, 'server/routes/production'))
const { ProductionRepository } = require(path.join(APP, 'server/repositories/production-repository'))
const { AccountService } = require(path.join(APP, 'server/services/account-service'))

const pool = new Pool({ connectionString: env.DATABASE_URL })
const redis = new Redis(env.REDIS_URL, { lazyConnect: true })
const repo = new ProductionRepository(pool)
const accounts = new AccountService(repo, {}, redis, { redisPrefix: env.REDIS_KEY_PREFIX || 'pix' })

const fakeAuth = {
  middleware() {
    return (req, _res, next) => {
      req.pixAdmin = { id: 1, username: 'ops-probe', role: 'superadmin' }
      next()
    }
  }
}

let pass = 0, fail = 0
function check(label, ok, extra) {
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/apis' + urlPath }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(data) } catch (_e) { /* 原文 */ }
        resolve({ status: res.statusCode, json, raw: data })
      })
    }).on('error', reject)
  })
}

;(async () => {
  await redis.connect()
  const app = express()
  app.use(express.urlencoded({ extended: true }))
  app.use(express.json())
  app.use('/apis', productionRouter({
    repository: repo,
    auth: fakeAuth,
    core: { redis },
    customers: {},
    accounts,
    security: { csrf: (_req, _res, next) => next() }
  }))
  const server = app.listen(0)
  const port = server.address().port

  try {
    console.log('═══ 0. 数据源现状 ═══')
    const counts = (await pool.query(`
      SELECT (SELECT count(*) FROM conversations)::int AS conv,
             (SELECT count(*) FROM customers)::int     AS cust,
             (SELECT count(*) FROM orders)::int        AS legacy_orders,
             (SELECT count(*) FROM order_details)::int AS legacy_details,
             (SELECT count(*) FROM order_fans)::int    AS legacy_fans`)).rows[0]
    console.log('  ' + JSON.stringify(counts))
    check('新模型有数据（conversations > 0）', counts.conv > 0, counts.conv)

    console.log('\n═══ 1. GET /admin/accounts（在线账号）═══')
    const acc = await get(port, '/admin/accounts?page=1&rows=50')
    check('HTTP 200（不再是 503 NOT_MIGRATED）', acc.status === 200, { status: acc.status, body: acc.raw.slice(0, 160) })
    const accRows = (acc.json && acc.json.rows) || []
    console.log(`  返回 ${accRows.length} 行 / total=${acc.json && acc.json.total}`)
    if (accRows.length) {
      const r = accRows[0]
      console.log('  首行: ' + JSON.stringify({
        商户: r.username, 平台: r.platform, 接入账号: r.account,
        客户: r.peerKey, 昵称: r.nickName, 在线: r.onlineStatus,
        归属: r.ownerStatus, 客户编号: r.customerNo, 最后活动: r.lastMessageAt
      }))
      check('字段齐全（前端要的那些都在）',
        ['username', 'platform', 'account', 'peerKey', 'nickName', 'onlineStatus', 'lastMessageAt']
          .every(k => k in r), Object.keys(r))
      check('onlineStatus 是 0/1', [0, 1].includes(Number(r.onlineStatus)), r.onlineStatus)
      check('在线的那行 lastMessageAt 不为空',
        Number(r.onlineStatus) !== 1 || !!r.lastMessageAt, r.lastMessageAt)
    }

    console.log('\n═══ 2. GET /admin/fans（进粉统计）═══')
    const fans = await get(port, '/admin/fans?page=1&rows=50')
    check('HTTP 200', fans.status === 200, { status: fans.status, body: fans.raw.slice(0, 160) })
    const fanRows = (fans.json && fans.json.rows) || []
    console.log(`  返回 ${fanRows.length} 行 / total=${fans.json && fans.json.total}`)
    if (fanRows.length) {
      const r = fanRows[0]
      console.log('  首行: ' + JSON.stringify({
        商户: r.username, 平台: r.platform, 客户: r.account, 昵称: r.nickName,
        类型: r.fanType, 被见到次数: r.seenCount, 接入账号: r.loginAccount, 进粉时间: r.createTime
      }))
      check('字段齐全', ['username', 'platform', 'account', 'nickName', 'fanType', 'loginAccount', 'createTime']
        .every(k => k in r), Object.keys(r))
      check('fanType 只能是 新粉/重粉', ['新粉', '重粉'].includes(r.fanType), r.fanType)
      check('seenCount 是数字且 >= 1', Number(r.seenCount) >= 1, r.seenCount)
      check('新粉的重粉判定与 seenCount 自洽',
        (r.fanType === '重粉') === (Number(r.seenCount) > 1), { type: r.fanType, n: r.seenCount })
    }

    console.log('\n═══ 3. 筛选真的生效（不是摆设）═══')
    const online = await get(port, '/admin/accounts?page=1&rows=50&online=1')
    const offline = await get(port, '/admin/accounts?page=1&rows=50&online=0')
    const onN = Number((online.json || {}).total || 0)
    const offN = Number((offline.json || {}).total || 0)
    console.log(`  在线=${onN}  离线=${offN}  全部=${acc.json && acc.json.total}`)
    check('在线 + 离线 == 全部（互斥且不丢行）',
      onN + offN === Number((acc.json || {}).total || 0), { onN, offN, all: acc.json && acc.json.total })

    const nw = await get(port, '/admin/fans?page=1&rows=50&type=' + encodeURIComponent('新粉'))
    const rp = await get(port, '/admin/fans?page=1&rows=50&type=' + encodeURIComponent('重粉'))
    const nwN = Number((nw.json || {}).total || 0)
    const rpN = Number((rp.json || {}).total || 0)
    console.log(`  新粉=${nwN}  重粉=${rpN}  全部=${fans.json && fans.json.total}`)
    check('新粉 + 重粉 == 全部', nwN + rpN === Number((fans.json || {}).total || 0), { nwN, rpN })

    if (accRows.length) {
      const kw = await get(port, '/admin/accounts?page=1&rows=50&keyword=' + encodeURIComponent(accRows[0].username))
      console.log(`  按商户「${accRows[0].username}」搜索 → ${(kw.json || {}).total} 行`)
      check('关键词搜索有结果', Number((kw.json || {}).total) > 0, kw.json && kw.json.total)
    }

    console.log('\n═══ 4. 落库侧没有副作用 ═══')
    const after = (await pool.query(`
      SELECT (SELECT count(*) FROM conversations)::int AS conv,
             (SELECT count(*) FROM customers)::int     AS cust`)).rows[0]
    check('只读接口没有改动 conversations', after.conv === counts.conv, { before: counts.conv, after: after.conv })
    check('只读接口没有改动 customers', after.cust === counts.cust, { before: counts.cust, after: after.cust })
  } finally {
    server.close()
    await pool.end()
    await redis.quit().catch(() => {})
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail) process.exitCode = 1
})().catch(e => { console.error('异常:', (e && e.stack) || e); process.exitCode = 1 })
