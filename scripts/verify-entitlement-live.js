#!/usr/bin/env node
'use strict'

/**
 * 线上权益冒烟：对着**真库**跑**真路由**，但所有写入最后一律 ROLLBACK。
 *
 * ## 为什么需要它
 *
 * `test/recharge-package-entitlement.test.js` 已经覆盖了这三条契约，但它跑在
 * 测试库里。真上线之后，"测试库过了"不等于"生产是对的" —— 还差三件事：
 * 迁移到底跑没跑、部署上去的是不是那份被测的代码、这个商户的数据补对没有。
 * 这个脚本在生产库上把三件事一次性验掉。
 *
 * ## 怎么做到"验证了写入、却没改生产"
 *
 * 把 `repo.query` / `repo.transaction` 都改道到**同一个连接**，并在它上面
 * 开一个从不提交的事务。于是路由真的走完了 INSERT / UPDATE（真约束、真外键、
 * 真触发器、真审计），但拔掉插头的那一刻全部消失。
 *
 * 这是刻意的：超管改套餐、开子账号都是**写操作**，只读请求根本证明不了
 * "这条路现在能走通"。而直接在生产上真改一遍，万一中途失败，
 * 商户就被留在半改状态 —— 不能拿客户的权益去赌。
 *
 * 收尾会**另开一条连接**复核 user 37 与子账号数是否与开局完全一致，
 * 不一致就是事务泄漏，脚本会以非 0 退出码报出来。
 *
 * ## 用法
 *
 *   node scripts/verify-entitlement-live.js --user=37
 *
 * 退出码：0 全部通过；1 有断言失败或有事务泄漏。
 */

const config = require('../server/config')

function parseUserId(argv) {
  const flag = argv.find(arg => arg.startsWith('--user='))
  if (!flag) throw new Error('必须指定 --user=<商户ID>，例如 --user=37')
  const value = Number(flag.slice('--user='.length))
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--user 必须是正整数商户 ID，收到: ${flag.slice('--user='.length)}`)
  }
  return value
}

async function main() {
  const userId = parseUserId(process.argv.slice(2))

  const express = require('express')
  const http = require('node:http')
  const { Pool } = require('pg')
  const { productionRouter } = require('../server/routes/production')
  const { ProductionRepository } = require('../server/repositories/production-repository')
  const { CoreService } = require('../server/services/core-service')
  const { AccountService } = require('../server/services/account-service')
  const { sendError } = require('../server/lib/http')

  const pool = new Pool({
    connectionString: config.database.connectionString,
    ssl: config.database.ssl,
    max: 4,
    applicationName: 'hello-pix-verify-entitlement'
  })
  const repo = new ProductionRepository(pool)

  const results = []
  const check = (name, condition, detail) => {
    results.push({ name, ok: Boolean(condition), detail })
    console.log(`  ${condition ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`)
    return Boolean(condition)
  }

  /** 开局快照：用**独立连接**读，作为最后"没泄漏"的比对基准 */
  const snapshot = async () => {
    const user = (await pool.query(
      `SELECT package_id, package_catalog_version, sub_quota, port_limit, expires_at,
              char_balance, enterprise, active_engine_id, updated_at
         FROM users WHERE id=$1`, [userId])).rows[0]
    const subs = (await pool.query(
      'SELECT count(*)::int AS n FROM sub_accounts WHERE parent_id=$1', [userId])).rows[0]
    const audits = (await pool.query(
      'SELECT count(*)::int AS n FROM audit_logs')).rows[0]
    return { user, subCount: subs.n, auditCount: audits.n }
  }

  const before = await snapshot()

  // 真管理员行：audit_logs.admin_id 有外键，随便造一个 id 会让审计写入失败
  const admin = (await pool.query(
    'SELECT id, username FROM admins WHERE status=1 ORDER BY id LIMIT 1')).rows[0]
  if (!admin) throw new Error('库里没有可用的管理员账号，无法产生审计留痕')

  // ---- 把一切写入改道到这条永不提交的连接上 ----
  const probe = await pool.connect()
  await probe.query('BEGIN')
  const rawQuery = repo.query.bind(repo)
  repo.query = (text, values, client) => rawQuery(text, values, client || probe)
  repo.transaction = async work => {
    await probe.query('SAVEPOINT probe')
    try {
      const out = await work(probe)
      await probe.query('RELEASE SAVEPOINT probe')
      return out
    } catch (error) {
      await probe.query('ROLLBACK TO SAVEPOINT probe')
      throw error
    }
  }

  const redisStub = { get: async () => null, set: async () => 'OK' }
  const fakeAuth = {
    hash: async value => `scrypt$probe$${value}`,
    revokeUser: async () => {},
    revokeSubject: async () => {},
    middleware() {
      return async (req, _res, next) => {
        try {
          const as = String(req.headers['x-probe-as'] || 'admin')
          if (as === 'admin') req.pixAdmin = { id: admin.id, username: admin.username, role: 'superadmin' }
          // 走真正的会话装载：和线上同一个 SQL，保证 profile 里的套餐名不是我们编的
          else req.pixUser = await repo.sessionAccount(`main:${as}`)
          next()
        } catch (error) { next(error) }
      }
    }
  }
  const accounts = new AccountService(repo, {}, redisStub, {})
  const core = new CoreService(repo, redisStub, fakeAuth, {})

  const app = express()
  app.use(express.urlencoded({ extended: true }))
  app.use(productionRouter({
    repository: repo, auth: fakeAuth, core, customers: {}, accounts,
    security: { csrf: (_req, _res, next) => next() }
  }))
  app.use((err, req, res, next) => sendError(err, req, res, next))

  const server = app.listen(0)
  const port = server.address().port
  const request = (method, urlPath, body, as) => new Promise((resolve, reject) => {
    const payload = new URLSearchParams(body || {}).toString()
    const headers = { 'Content-Length': Buffer.byteLength(payload), 'x-probe-as': as || 'admin' }
    if (payload) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(data) } catch (_e) { /* 保留原文 */ }
        resolve({ status: res.statusCode, json, text: data })
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
  const post = (p, body, as) => request('POST', p, body, as)
  const get = (p, as) => request('GET', p, null, as)

  try {
    console.log(`\n目标商户: ${userId}；用管理员 ${admin.username} 产生审计\n`)

    // =============================================== ② 商户端显示套餐
    console.log('② 商户端应显示套餐 / 到期时间 / 通道权益')
    // 这两个路由是 `res.json(await core.xxx(...))`，**直接**返回对象、没有包一层 obj
    const dash = await get('/user/dashboard', String(userId))
    const obj = (dash.json && (dash.json.obj || dash.json)) || {}
    check('GET /user/dashboard 返回 200', dash.status === 200, `HTTP ${dash.status}`)
    check('商户端拿到套餐名', Boolean(obj.packageTitle || obj.basename),
      `packageTitle=${JSON.stringify(obj.packageTitle)} basename=${JSON.stringify(obj.basename)}`)
    check('商户端拿到到期时间', Boolean(obj.expireTime), `expireTime=${obj.expireTime}`)
    check('商户端拿到翻译通道', Boolean(obj.activeEngine), `activeEngine=${obj.activeEngine}`)

    // =============================================== ③ 子账号额度
    console.log('\n③ 商户端应能开子账号')
    const team = await get('/team/info', String(userId))
    const teamObj = (team.json && (team.json.obj || team.json)) || {}
    check('GET /team/info 返回 200', team.status === 200, `HTTP ${team.status}`)
    const isEnterprise = Number(teamObj.enterprise) === 1
    const quota = Number(teamObj.subQuota || 0)
    check('子账号额度对得上（企业号不限量 / 否则须 > 0）',
      isEnterprise ? quota >= 0 : quota > 0,
      `enterprise=${teamObj.enterprise} subQuota=${quota} subCount=${teamObj.subCount}`)

    const subName = `probeteam${Date.now() % 1000000}`
    const created = await post('/team/subs/save',
      { username: subName, password: 'ProbePass123' }, String(userId))
    check('POST /team/subs/save 真的建出了子账号', created.status === 200,
      `HTTP ${created.status} ${String(created.text).slice(0, 160)}`)

    if (created.status === 200) {
      const listed = await get('/team/subs', String(userId))
      const rows = (listed.json && (listed.json.rows || (listed.json.obj && listed.json.obj.rows))) || []
      check('新子账号出现在列表里', rows.some(r => r.username === subName),
        `列表 ${rows.length} 条`)
    }

    // =============================================== ① 超管改套餐
    console.log('\n① 超管应能更改商户套餐')
    const packs = (await pool.query(
      'SELECT id, title FROM packages WHERE active=true ORDER BY sort_order, id')).rows
    const current = Number(before.user.package_id)
    const other = packs.find(p => Number(p.id) !== current)
    check('库里至少有两个在售套餐可供切换', Boolean(other),
      packages2Text(packs))

    if (other) {
      const changed = await post('/admin/users/save', { id: userId, versionId: other.id })
      check('改套餐返回 200', changed.status === 200,
        `HTTP ${changed.status} ${String(changed.text).slice(0, 200)}`)
      const after = (await probe.query(
        'SELECT package_id FROM users WHERE id=$1', [userId])).rows[0]
      check('套餐真的写进去了', String(after.package_id) === String(other.id),
        `现在 package_id=${after.package_id}，期望 ${other.id}（${other.title}）`)

      const restored = await post('/admin/users/save', { id: userId, versionId: current })
      check('改回原套餐也返回 200', restored.status === 200,
        `HTTP ${restored.status} ${String(restored.text).slice(0, 200)}`)
    }

    // 带 charBalance 的编辑必须仍被余额守卫拦下（安全边界不能因为修 bug 被放宽）
    const guarded = await post('/admin/users/save', { id: userId, charBalance: '999' })
    check('带 charBalance 的编辑仍被 USE_CHARACTER_GRANT 拦下',
      guarded.status === 400 && guarded.json && guarded.json.code === 'USE_CHARACTER_GRANT',
      `HTTP ${guarded.status} code=${guarded.json && guarded.json.code}`)
  } finally {
    server.close()
    // 拔插头：所有探针写入到此为止
    await probe.query('ROLLBACK').catch(() => {})
    probe.release()
  }

  // ---- 泄漏检查：另开连接复核，必须与开局一模一样 ----
  const after = await snapshot()
  console.log('\n④ 事务收尾：生产数据必须与开局完全一致')
  check(`user ${userId} 各字段未被改动`,
    JSON.stringify(after.user) === JSON.stringify(before.user),
    JSON.stringify(after.user) === JSON.stringify(before.user) ? '' : `\n      开: ${JSON.stringify(before.user)}\n      终: ${JSON.stringify(after.user)}`)
  check('子账号数量未变化', after.subCount === before.subCount,
    `${before.subCount} → ${after.subCount}`)
  check('审计表未新增记录（ROLLBACK 生效）', after.auditCount === before.auditCount,
    `${before.auditCount} → ${after.auditCount}`)

  await pool.end().catch(() => {})

  const failed = results.filter(r => !r.ok)
  console.log(`\n${failed.length ? '✗ 有失败项' : '✓ 全部通过'}：${results.length - failed.length}/${results.length}`)
  return failed.length ? 1 : 0
}

function packages2Text(packs) {
  return packs.map(p => `${p.id}:${p.title}`).join(', ')
}

if (require.main === module) {
  main()
    .then(code => { process.exitCode = code || 0 })
    .catch(error => {
      console.error('冒烟脚本异常:', (error && error.stack) || error)
      process.exitCode = 1
    })
}

module.exports = { main, parseUserId }
