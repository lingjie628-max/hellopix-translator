'use strict'

/**
 * 套餐权益发放 / 编辑商户 / 子账号额度（需要真实 PostgreSQL）。
 *
 * ## 为什么要有这个文件
 *
 * 生产上出现过一串**只在真库真路由下才暴露**的缺陷，它们合起来的表现是
 * 「商户充了 35 USDT，但什么都没生效」：
 *
 *   1. `POST /admin/users/save` 只要请求体带 `charBalance` 就 400
 *      （USE_CHARACTER_GRANT，这是刻意的资金安全守卫）。而 `AdminUsers.vue`
 *      的编辑弹窗**每次都回传**余额 —— 于是「编辑商户」整体不可用，
 *      表现就是"能建号、改不了套餐"，商户 `package_id` 永远是 NULL。
 *   2. 结算只加字符、从不发套餐：`creditOrder` 与 `/admin/recharges/status`
 *      都不碰 `users.package_id` / `expires_at` / `sub_quota`。
 *   3. 套餐没有子账号额度这个概念，`users.sub_quota` 恒为 0，
 *      而 `saveSub` 只按它判定 → 一个子账号都开不出来；
 *      企业账号也没有「无限」旁路，尽管界面上那么写着。
 *
 * 这三条都是**契约级**缺陷：单个函数看都对，串起来就错。所以这里用
 * **真库 + 线上那一份 productionRouter**（只替换鉴权层）跑完整请求，
 * 让它们在本地暴露，而不是等到生产冒烟。
 *
 * 运行：PIX_TEST_DATABASE_URL=... node --test test/recharge-package-entitlement.test.js
 */

const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const test = require('node:test')

const databaseUrl = process.env.PIX_TEST_DATABASE_URL
const rand = () => `${process.pid}${Date.now() % 1e6}${Math.floor(Math.random() * 1000)}`

test('套餐随结算发放 / 编辑商户 / 子账号额度', { skip: !databaseUrl }, async t => {
  process.env.DATABASE_URL = databaseUrl
  const express = require('express')
  const { Pool } = require('pg')

  const { productionRouter } = require('../server/routes/production')
  const { ProductionRepository } = require('../server/repositories/production-repository')
  const { CoreService } = require('../server/services/core-service')
  const { AccountService } = require('../server/services/account-service')
  const { sendError } = require('../server/lib/http')

  const pool = new Pool({ connectionString: databaseUrl })
  const repo = new ProductionRepository(pool)
  const redisStub = { get: async () => null, set: async () => 'OK' }
  const accounts = new AccountService(repo, {}, redisStub, {})

  /**
   * 超管身份必须是**真实存在的 admins 行**：
   * `audit_logs.admin_id` 有指向 admins 的外键，随便编一个 id 会让审计写入失败，
   * 于是每个管理端请求都 500 —— 那是夹具的问题，不是产品的问题。
   */
  const adminUsername = `entprobe_op_${rand()}`
  const insertedAdmin = await pool.query(
    `INSERT INTO admins(username,password_hash,nickname,role)
     VALUES($1,'scrypt$s$h','entprobe','superadmin') RETURNING id`, [adminUsername])
  const adminId = insertedAdmin.rows[0].id

  /**
   * 只替换鉴权层。
   *
   * 身份由请求头 `x-probe-as` 决定，避免"起两个 app"或改全局状态：
   *   `admin`           → 超管
   *   `<userId>`（数字） → 该商户的主账号
   * 被测的是路由与仓储，不是鉴权。
   */
  const fakeAuth = {
    hash: async value => `scrypt$s$${value}`,
    revokeUser: async () => {},
    revokeSubject: async () => {},
    middleware() {
      return (req, _res, next) => {
        const as = String(req.headers['x-probe-as'] || 'admin')
        if (as === 'admin') {
          req.pixAdmin = { id: adminId, username: adminUsername, role: 'superadmin' }
        } else {
          const id = Number(as)
          req.pixUser = { kind: 'main', parent: { id }, account: { id } }
        }
        next()
      }
    }
  }
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

  const createdUsers = []
  const createdOrders = []
  const createdSubs = []
  const createdPackages = []

  t.after(async () => {
    try {
      if (createdSubs.length) {
        await pool.query('DELETE FROM sub_accounts WHERE id = ANY($1::bigint[])', [createdSubs])
      }
      if (createdUsers.length) {
        await pool.query('DELETE FROM sub_accounts WHERE parent_id = ANY($1::bigint[])', [createdUsers])
        await pool.query('DELETE FROM char_ledger WHERE user_id = ANY($1::bigint[])', [createdUsers])
        await pool.query('DELETE FROM recharges WHERE user_id = ANY($1::bigint[])', [createdUsers])
        await pool.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [createdUsers])
      }
      if (createdOrders.length) {
        await pool.query('DELETE FROM recharges WHERE id = ANY($1::bigint[])', [createdOrders])
      }
      if (createdPackages.length) {
        await pool.query('DELETE FROM package_engines WHERE package_id = ANY($1::bigint[])', [createdPackages])
        await pool.query('DELETE FROM packages WHERE id = ANY($1::bigint[])', [createdPackages])
      }
      // 审计留痕：按操作者与套餐名清理，避免把探针数据留在共享测试库里。
      // audit_logs.admin_id 有外键，所以必须在删 admins 之前删掉。
      await pool.query('DELETE FROM audit_logs WHERE admin_id=$1', [adminId])
      await pool.query("DELETE FROM audit_logs WHERE action='发放套餐权益' AND detail->>'message' LIKE '%探针套餐%'")
      await pool.query('DELETE FROM admins WHERE id=$1', [adminId])
    } catch (e) {
      console.error('  测试清理出错:', e.message)
    }
    server.close()
    await pool.end()
  })

  // ---------------------------------------------------------------- 夹具

  async function makePackage(fields) {
    const code = `entprobe${rand()}_${fields.tag}`
    const { rows } = await pool.query(
      `INSERT INTO packages(code,title,subtitle,port_limit,port_unlimited,included_chars,price,
         clients,features,sort_order,sub_quota,catalog_version,active)
       VALUES($1,$2,'',$3,false,$4,$5,'{}'::jsonb,'{}'::jsonb,99,$6,$7,true) RETURNING id, code`,
      [code, `探针套餐${fields.tag}`, fields.portLimit, fields.chars,
        fields.price, fields.subQuota, fields.catalogVersion])
    createdPackages.push(rows[0].id)
    return rows[0]
  }

  async function makeUser(fields) {
    const f = fields || {}
    const name = `entprobe_${rand()}_${f.tag || 'u'}`
    const { rows } = await pool.query(
      `INSERT INTO users(username,password_hash,nickname,email,email_verified,status,
         char_balance,char_used,translate_count,sub_quota,auto_alloc_master,auto_reply,
         enterprise,port_limit,ports_in_use,remarks,expires_at)
       VALUES($1,'scrypt$s$h',$1,$2,false,1,0,0,0,$3,false,false,$4,$5,0,'',$6::timestamptz)
       RETURNING id, username`,
      [name, `${name}@example.test`, f.subQuota || 0, Boolean(f.enterprise),
        f.portLimit || 0, f.expiresAt || null])
    createdUsers.push(rows[0].id)
    return rows[0]
  }

  /**
   * 造一张「待支付」订单。
   *
   * 金额必须逐单唯一：表上有 `recharges_pending_amount_uq`
   * （`(payment_type, paid_amount) WHERE status = 0`）—— 这是"金额即订单标识"
   * 设计的第一道防线，同地址同金额不允许有两张未支付订单并存。
   *
   * 恒等式（020 的 CHECK）：`paid = original − discount + surcharge`；
   * 同时 001 要求 `paid <= original`，所以折扣必须吃掉尾数。
   */
  let orderSeq = 0
  async function makeOrder(fields) {
    const f = fields || {}
    const orderNumber = `ENT${rand()}`
    const base = Number(f.amount === undefined ? 35 : f.amount)
    const suffix = (((++orderSeq) % 899) + 1) / 1000
    const original = (base + 10).toFixed(3)
    const discount = (10).toFixed(3)
    const surcharge = suffix.toFixed(3)
    const paid = (base + suffix).toFixed(3)
    const { rows } = await pool.query(
      `INSERT INTO recharges(user_id,package_id,order_number,kind,payment_type,quantity,chars,
         original_amount,discount_amount,surcharge_amount,paid_amount,status,idempotency_key,
         package_catalog_version)
       VALUES($1,$2,$3,$4,'USDT-TRC20',$5,$6,$7,$8,$9,$10,0,$11,$12) RETURNING id, order_number`,
      [f.userId, f.packageId || null, orderNumber, f.kind || 'package', f.quantity || 1,
        f.chars || 1000, original, discount, surcharge, paid,
        `ent:${orderNumber}`, f.catalogVersion || null])
    createdOrders.push(rows[0].id)
    return rows[0]
  }

  const userRow = async id =>
    (await pool.query(
      `SELECT package_id, package_catalog_version, sub_quota, port_limit, char_balance,
              enterprise, expires_at, active_engine_id
         FROM users WHERE id=$1`, [id])).rows[0]

  const expiresAt = async id =>
    (await pool.query('SELECT expires_at FROM users WHERE id=$1', [id])).rows[0].expires_at

  const days = n => n * 24 * 60 * 60 * 1000

  await t.test('迁移 041：三档在售套餐都带上了非零子账号额度', async () => {
    const { rows } = await pool.query(
      'SELECT code, sub_quota FROM packages WHERE active = true ORDER BY sort_order, id')
    assert.ok(rows.length >= 3, '测试库缺少在售套餐')
    for (const row of rows) {
      assert.ok(Number(row.sub_quota) > 0,
        `套餐 ${row.code} 的 sub_quota 仍是 ${row.sub_quota} —— 041 迁移没生效，`
        + '或者新套餐没带额度，商户买它开不了子账号')
    }
  })

  // ================================================ ① 编辑商户必须能改套餐

  await t.test('编辑商户：带 charBalance 必须 400（余额守卫不可放宽）', async () => {
    const user = await makeUser()
    const packB = await makePackage({ tag: 'b0', subQuota: 5, chars: 2000, price: 65, portLimit: 0, catalogVersion: 9 })

    const res = await post('/admin/users/save', {
      id: user.id, versionId: packB.id, charBalance: '123'
    })
    assert.equal(res.status, 400, `期望守卫拦下，实际 HTTP ${res.status}`)
    assert.equal(res.json && res.json.code, 'USE_CHARACTER_GRANT',
      '带 charBalance 的编辑请求必须被 USE_CHARACTER_GRANT 拦下 —— '
      + '余额只能经 char_ledger 变更')

    const after = await userRow(user.id)
    assert.equal(after.package_id, null, '被拦下的请求不该改到任何东西')
  })

  await t.test('编辑商户：不带 charBalance 必须真的改成套餐', async () => {
    const user = await makeUser()
    const packA = await makePackage({ tag: 'a1', subQuota: 2, chars: 1000, price: 35, portLimit: 0, catalogVersion: 7 })
    const packB = await makePackage({ tag: 'b1', subQuota: 5, chars: 2000, price: 65, portLimit: 0, catalogVersion: 9 })

    const first = await post('/admin/users/save', { id: user.id, versionId: packA.id })
    assert.equal(first.status, 200, `改套餐失败：HTTP ${first.status} ${first.text.slice(0, 200)}`)
    let after = await userRow(user.id)
    assert.equal(String(after.package_id), String(packA.id))
    assert.equal(Number(after.package_catalog_version), 7, '换套餐要重新钉权益版本')
    assert.equal(Number(after.char_balance), 0, '编辑商户不该动余额')

    // 再换一次：这正是生产上"超管改不了套餐"的那一步
    const second = await post('/admin/users/save', { id: user.id, versionId: packB.id })
    assert.equal(second.status, 200, `二次改套餐失败：HTTP ${second.status} ${second.text.slice(0, 200)}`)
    after = await userRow(user.id)
    assert.equal(String(after.package_id), String(packB.id))
    assert.equal(Number(after.package_catalog_version), 9)
  })

  await t.test('编辑商户：显式传子账号额度要生效', async () => {
    const user = await makeUser()
    const pack = await makePackage({ tag: 'q1', subQuota: 2, chars: 1000, price: 35, portLimit: 0, catalogVersion: 7 })

    const res = await post('/admin/users/save', { id: user.id, versionId: pack.id, subQuota: '8' })
    assert.equal(res.status, 200, `HTTP ${res.status} ${res.text.slice(0, 200)}`)
    assert.equal(Number((await userRow(user.id)).sub_quota), 8,
      '超管显式填的子账号额度必须写进 users.sub_quota')
  })

  await t.test('新建商户：不填额度时按套餐默认发放', async () => {
    const pack = await makePackage({ tag: 'n1', subQuota: 4, chars: 1000, price: 35, portLimit: 0, catalogVersion: 7 })
    const username = `entprobeNew_${rand()}`

    const res = await post('/admin/users/save', {
      username, password: 'ProbePass123', versionId: pack.id
    })
    assert.equal(res.status, 200, `建号失败：HTTP ${res.status} ${res.text.slice(0, 200)}`)

    const row = (await pool.query(
      'SELECT id, sub_quota, package_id FROM users WHERE username=$1', [username])).rows[0]
    assert.ok(row, '新商户没建出来')
    createdUsers.push(row.id)
    assert.equal(Number(row.sub_quota), 4,
      '新商户的子账号额度必须取套餐默认值；写死 0 的话他一进来就开不了子账号')
    assert.equal(String(row.package_id), String(pack.id))
  })

  // ================================================ ② 套餐随结算发放

  await t.test('手工确认收款：套餐、到期时间、额度、权益版本一起落地', async () => {
    const pack = await makePackage({ tag: 'g1', subQuota: 5, chars: 2000, price: 65, portLimit: 0, catalogVersion: 9 })
    const user = await makeUser()
    const order = await makeOrder({
      userId: user.id, packageId: pack.id, kind: 'package',
      quantity: 1, chars: 2000, amount: 65, catalogVersion: 9
    })

    const res = await post('/admin/recharges/status', { id: order.id })
    assert.equal(res.status, 200, `确认收款失败：HTTP ${res.status} ${res.text.slice(0, 200)}`)
    assert.match(String(res.json && res.json.msg), /套餐已发放/,
      '响应要说明套餐已发放，否则超管无法从界面上判断这一单有没有真的生效')

    const after = await userRow(user.id)
    assert.equal(String(after.package_id), String(pack.id), 'package_id 必须落地')
    assert.equal(Number(after.package_catalog_version), 9, '权益版本取订单快照')
    assert.equal(Number(after.sub_quota), 5, '子账号额度必须随套餐发放')
    assert.equal(Number(after.char_balance), 2000, '字符也要到账')

    const left = new Date(after.expires_at).getTime() - Date.now()
    assert.ok(left > days(27) && left <= days(31) + 3600_000,
      `到期时间应约为 1 个月后，实际剩余 ${(left / days(1)).toFixed(2)} 天`)
  })

  await t.test('重复确认收款：不重复加字符，也不重复延长到期时间', async () => {
    const pack = await makePackage({ tag: 'g2', subQuota: 5, chars: 2000, price: 65, portLimit: 0, catalogVersion: 9 })
    const user = await makeUser()
    const order = await makeOrder({
      userId: user.id, packageId: pack.id, kind: 'package', quantity: 1, chars: 2000, amount: 65, catalogVersion: 9
    })

    await post('/admin/recharges/status', { id: order.id })
    const first = await expiresAt(user.id)
    const balance = Number((await userRow(user.id)).char_balance)

    const again = await post('/admin/recharges/status', { id: order.id })
    assert.equal(again.status, 200)
    assert.match(String(again.json && again.json.msg), /此前已确认/)

    assert.equal(new Date(await expiresAt(user.id)).getTime(), new Date(first).getTime(),
      '重复确认把到期时间又延了一个月 —— 幂等被破坏了')
    assert.equal(Number((await userRow(user.id)).char_balance), balance, '重复确认不能重复加字符')
  })

  await t.test('非套餐订单不得改商户套餐', async () => {
    const packA = await makePackage({ tag: 'n2a', subQuota: 2, chars: 1000, price: 35, portLimit: 0, catalogVersion: 7 })
    const packB = await makePackage({ tag: 'n2b', subQuota: 5, chars: 2000, price: 65, portLimit: 0, catalogVersion: 9 })

    // 备用：商户原本买的是 A 档
    const user = await makeUser()
    await post('/admin/users/save', { id: user.id, versionId: packA.id, subQuota: '2' })

    // 「后台赠送」订单即使带 package_id，也不能把商户套餐改成 B
    const manual = await makeOrder({
      userId: user.id, packageId: packB.id, kind: 'manual', quantity: 1, chars: 500, amount: 0
    })
    let res = await post('/admin/recharges/status', { id: manual.id })
    assert.equal(res.status, 200, `HTTP ${res.status} ${res.text.slice(0, 200)}`)
    let after = await userRow(user.id)
    assert.equal(String(after.package_id), String(packA.id), '赠送到账不该改套餐')
    assert.equal(Number(after.sub_quota), 2, '赠送到账不该改子账号额度')
    assert.equal(Number(after.char_balance), 500, '赠送到账要加字符')

    // 纯字符充值订单（无套餐）：同样不碰套餐
    const charsOnly = await makeOrder({
      userId: user.id, packageId: null, kind: 'characters', quantity: 1, chars: 300, amount: 10
    })
    res = await post('/admin/recharges/status', { id: charsOnly.id })
    assert.equal(res.status, 200, `HTTP ${res.status} ${res.text.slice(0, 200)}`)
    after = await userRow(user.id)
    assert.equal(String(after.package_id), String(packA.id), '字符充值不该改套餐')
    assert.equal(Number(after.char_balance), 800)
  })

  await t.test('续费：从"现在与原到期里的较晚者"起算，不吞掉剩余天数', async () => {
    const pack = await makePackage({ tag: 'r1', subQuota: 5, chars: 2000, price: 65, portLimit: 0, catalogVersion: 9 })
    // 原到期：还有 10 天
    const user = await makeUser({ expiresAt: new Date(Date.now() + days(10)).toISOString() })
    const order = await makeOrder({
      userId: user.id, packageId: pack.id, kind: 'package', quantity: 2, chars: 4000, amount: 130, catalogVersion: 9
    })

    const res = await post('/admin/recharges/status', { id: order.id })
    assert.equal(res.status, 200, `HTTP ${res.status} ${res.text.slice(0, 200)}`)

    const left = new Date(await expiresAt(user.id)).getTime() - Date.now()
    // 10 天 + 2 个月 ≈ 71 天。直接 now()+2月 会吞掉那 10 天（≈61 天），必须区分开。
    assert.ok(left > days(68) && left <= days(74),
      `续费应从较晚者起算（期望约 71 天），实际 ${(left / days(1)).toFixed(2)} 天 —— `
      + '直接按 now() 起算会吞掉商户已经买过的剩余天数')
  })

  await t.test('套餐 port_limit 为 0 时不得抹掉人工设定的端口数', async () => {
    const pack = await makePackage({ tag: 'p1', subQuota: 5, chars: 2000, price: 65, portLimit: 0, catalogVersion: 9 })
    const user = await makeUser({ portLimit: 25 })
    const order = await makeOrder({
      userId: user.id, packageId: pack.id, kind: 'package', quantity: 1, chars: 2000, amount: 65, catalogVersion: 9
    })

    const res = await post('/admin/recharges/status', { id: order.id })
    assert.equal(res.status, 200, `HTTP ${res.status} ${res.text.slice(0, 200)}`)
    assert.equal(Number((await userRow(user.id)).port_limit), 25,
      '套餐 port_limit=0 表示"套餐没规定"，不该把超管手调的端口数清零')
  })

  // ================================================ ③ 子账号额度

  await t.test('个人账号：按额度放行，超出即 409', async () => {
    const user = await makeUser({ subQuota: 2 })

    for (let i = 1; i <= 2; i++) {
      const res = await post('/team/subs/save', {
        username: `entprobeSub_${rand()}_${i}`, password: 'ProbePass123'
      }, user.id)
      assert.equal(res.status, 200, `第 ${i} 个子账号应能创建：HTTP ${res.status} ${res.text.slice(0, 200)}`)
      const row = (await pool.query(
        'SELECT id FROM sub_accounts WHERE parent_id=$1 ORDER BY id DESC LIMIT 1', [user.id])).rows[0]
      if (row) createdSubs.push(row.id)
    }

    const third = await post('/team/subs/save', {
      username: `entprobeSub_${rand()}_3`, password: 'ProbePass123'
    }, user.id)
    assert.equal(third.status, 409, `第 3 个应当被拦下：HTTP ${third.status} ${third.text.slice(0, 200)}`)
    assert.equal(third.json && third.json.code, 'SUB_QUOTA_FULL')
  })

  await t.test('额度为 0 的个人账号：文案要指向"买套餐"，而不是一句"名额已满"', async () => {
    const user = await makeUser({ subQuota: 0 })
    const res = await post('/team/subs/save', {
      username: `entprobeSub_${rand()}_z`, password: 'ProbePass123'
    }, user.id)
    assert.equal(res.status, 409)
    assert.match(String(res.json && res.json.msg), /购买套餐/,
      '额度为 0 时提示应说明"购买套餐后即可添加"；只说"名额已满"会让商户以为是自己用满了')
  })

  await t.test('企业账号：额度为 0 也必须能不限额开子账号', async () => {
    const user = await makeUser({ enterprise: true, subQuota: 0 })
    for (let i = 1; i <= 3; i++) {
      const res = await post('/team/subs/save', {
        username: `entprobeSubEnt_${rand()}_${i}`, password: 'ProbePass123'
      }, user.id)
      assert.equal(res.status, 200,
        `企业账号第 ${i} 个子账号应能创建（后台界面写着"企业开子账号不限数量"）：`
        + `HTTP ${res.status} ${res.text.slice(0, 200)}`)
      const row = (await pool.query(
        'SELECT id FROM sub_accounts WHERE parent_id=$1 ORDER BY id DESC LIMIT 1', [user.id])).rows[0]
      if (row) createdSubs.push(row.id)
    }
  })

  await t.test('企业账号：买套餐不得把它的 sub_quota 覆盖成套餐额度', async () => {
    const pack = await makePackage({ tag: 'e1', subQuota: 5, chars: 2000, price: 65, portLimit: 0, catalogVersion: 9 })
    const user = await makeUser({ enterprise: true, subQuota: 0 })
    const order = await makeOrder({
      userId: user.id, packageId: pack.id, kind: 'package', quantity: 1, chars: 2000, amount: 65, catalogVersion: 9
    })

    const res = await post('/admin/recharges/status', { id: order.id })
    assert.equal(res.status, 200, `HTTP ${res.status} ${res.text.slice(0, 200)}`)

    const after = await userRow(user.id)
    assert.equal(String(after.package_id), String(pack.id), '套餐本身仍要发放')
    assert.equal(Number(after.sub_quota), 0,
      '企业账号不受额度限制，结算不该把它的 sub_quota 改成套餐值 —— '
      + '否则日后降为个人账号会得到一个含义不明的额度')
  })
})
