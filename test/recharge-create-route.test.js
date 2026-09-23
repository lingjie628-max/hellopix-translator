'use strict'

/**
 * `/userRecharge/create` 路由级测试（需要真实 PostgreSQL）。
 *
 * ## 为什么要单独测这一条路由
 *
 * RC-02 期间这个接口在生产上**连挂三次**，每次都是不同的低级错误，
 * 而且每一次都要走完整套「改代码 → 构建 → 部署 → 冒烟」才发现：
 *
 *   1. `client.query(sql, values, client)` —— 多传了第三个参数，
 *      而 `client.query` 的第三参是回调不是连接（`repo.query` 才是那个签名），
 *      报 `callback is not a function`
 *   2. `formatMilli(order.paidAmount)` —— mapRow 把 numeric 转成了 Number，
 *      而 formatMilli 只吃整数毫，报 `Cannot convert 36.157 to a BigInt`
 *   3. 金额文本定义在事务回调里、却在回调外引用，报 `originalText is not defined`
 *
 * 三个都是"跑一次就能发现"的错误。本测试把这条路由完整跑一遍，
 * 让它们在本地就暴露，而不是等到生产冒烟。
 *
 * 运行：PIX_TEST_DATABASE_URL=... node --test test/recharge-create-route.test.js
 */

const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const test = require('node:test')

const databaseUrl = process.env.PIX_TEST_DATABASE_URL
const root = path.join(__dirname, '..')
const CHANNEL_ADDRESS = 'TEfCDDuYwYdjCn2WDa7TNWCU9bkBk9EXPX'

test('POST /userRecharge/create 端到端（含金额与预约落库）', { skip: !databaseUrl }, async t => {
  process.env.DATABASE_URL = databaseUrl
  const express = require('express')
  const { Pool } = require('pg')

  const { productionRouter } = require('../server/routes/production')
  const { ProductionRepository } = require('../server/repositories/production-repository')
  const { CoreService } = require('../server/services/core-service')
  const { AccountService } = require('../server/services/account-service')

  const pool = new Pool({ connectionString: databaseUrl })
  const repo = new ProductionRepository(pool)
  const redisStub = { get: async () => null, set: async () => 'OK' }
  const core = new CoreService(repo, redisStub, null, {})
  const accounts = new AccountService(repo, {}, redisStub, {})

  let userId = null
  let packageId = null
  let channelsSnapshot = null
  let channelsExisted = false

  // 造一个商户身份。真实链路走会话解析，这里只替换那一层 ——
  // 被测的是路由处理逻辑，不是鉴权。
  const fakeAuth = {
    middleware() {
      return (req, _res, next) => {
        req.pixUser = { kind: 'main', parent: { id: userId }, account: { id: userId } }
        next()
      }
    }
  }

  const app = express()
  app.use(express.urlencoded({ extended: true }))
  const { sendError } = require('../server/lib/http')
  app.use(productionRouter({
    repository: repo, auth: fakeAuth, core, customers: {}, accounts,
    security: { csrf: (_req, _res, next) => next() }
  }))
  app.use((err, req, res, next) => sendError(err, req, res, next))

  const server = app.listen(0)
  const port = server.address().port

  const post = (urlPath, body) => new Promise((resolve, reject) => {
    const payload = new URLSearchParams(body).toString()
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: urlPath,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
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

  t.after(async () => {
    try {
      if (userId) {
        await pool.query(
          `UPDATE recharge_amount_reservations SET recharge_id=NULL
            WHERE recharge_id IN (SELECT id FROM recharges WHERE user_id=$1)`, [userId])
        const resv = (await pool.query(
          `SELECT amount_reservation_id AS id FROM recharges
            WHERE user_id=$1 AND amount_reservation_id IS NOT NULL`, [userId])).rows.map(r => r.id)
        await pool.query('DELETE FROM recharges WHERE user_id=$1', [userId])
        if (resv.length) {
          await pool.query('DELETE FROM recharge_amount_reservations WHERE id = ANY($1::bigint[])', [resv])
        }
        await pool.query('DELETE FROM users WHERE id=$1', [userId])
      }
      // 还原收款配置，别影响同库的其它测试
      if (channelsExisted) {
        await pool.query(
          `INSERT INTO app_settings(key,value,description) VALUES('payment.channels',$1::jsonb,'收款渠道')
           ON CONFLICT (key) DO UPDATE SET value=$1::jsonb`, [JSON.stringify(channelsSnapshot)])
      } else {
        await pool.query("DELETE FROM app_settings WHERE key='payment.channels'")
      }
    } catch (e) {
      console.error('  测试清理出错:', e.message)
    }
    server.close()
    await pool.end()
  })

  // ---------- 准备数据 ----------
  const pkg = (await pool.query('SELECT id, price FROM packages ORDER BY id LIMIT 1')).rows[0]
  assert.ok(pkg, '测试库缺少套餐数据')
  packageId = pkg.id

  const name = `rc02route_${process.pid}_${Date.now()}`
  const inserted = await pool.query(
    `INSERT INTO users(username,password_hash,nickname,email,email_verified,status,
       package_id,char_balance,char_used,remarks)
     VALUES($1,'scrypt$s$h',$1,$2,false,1,$3,0,0,'') RETURNING id`,
    [name, `${name}@example.test`, packageId])
  userId = inserted.rows[0].id

  const cfg = (await pool.query("SELECT value FROM app_settings WHERE key='payment.channels'")).rows[0]
  channelsExisted = !!cfg
  channelsSnapshot = cfg ? cfg.value : null
  await pool.query(
    `INSERT INTO app_settings(key,value,description) VALUES('payment.channels',$1::jsonb,'收款渠道')
     ON CONFLICT (key) DO UPDATE SET value=$1::jsonb`,
    [JSON.stringify([{ id: 'usdt-trc20', name: 'USDT', network: 'TRC20',
      address: CHANNEL_ADDRESS, note: '', enabled: 1 }])])

  // ---------- 下单 ----------
  const res = await post('/userRecharge/create', { baseid: packageId, month: 1, channelId: 'usdt-trc20' })
  assert.equal(res.status, 200, `下单失败：HTTP ${res.status} ${res.text.slice(0, 200)}`)
  const o = res.json

  // ---------- 响应字段 ----------
  assert.ok(o.orderNum, '缺少订单号')
  assert.match(o.originalAmount, /^\d+\.\d{3}$/, `标准价格式不对：${o.originalAmount}`)
  assert.match(o.payAmount, /^\d+\.\d{3}$/, `实付格式不对：${o.payAmount}`)
  assert.match(o.surchargeAmount, /^\d+\.\d{3}$/, `尾数格式不对：${o.surchargeAmount}`)
  assert.equal(o.matchSuffix, o.surchargeAmount, 'matchSuffix 应与 surchargeAmount 一致')
  assert.equal(o.expiresInMinutes, 30)
  assert.ok(o.expiresAt, '缺少有效期')
  assert.equal(o.channel.address, CHANNEL_ADDRESS, '响应里的收款地址不对')
  assert.equal(o.channel.tokenContract, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', '响应里的合约不对')

  // 金额恒等式（整数毫比较，避开浮点）
  const milli = v => Math.round(Number(v) * 1000)
  assert.equal(
    milli(o.payAmount),
    milli(o.originalAmount) - milli(o.discountAmount) + milli(o.surchargeAmount),
    '实付 ≠ 标准价 − 折扣 + 尾数')
  assert.ok(milli(o.surchargeAmount) >= 1 && milli(o.surchargeAmount) <= 999,
    `尾数越界：${o.surchargeAmount}`)

  // 有效期约 30 分钟
  const leftMin = (new Date(o.expiresAt).getTime() - Date.now()) / 60000
  assert.ok(leftMin > 25 && leftMin <= 30, `有效期异常：${leftMin} 分钟`)

  // ---------- 数据库落库 ----------
  const row = (await pool.query(
    `SELECT id, original_amount, discount_amount, surcharge_amount, paid_amount,
            expires_at, pay_address, pay_token_contract, amount_reservation_id, status
       FROM recharges WHERE order_number=$1`, [o.orderNum])).rows[0]
  assert.ok(row, '订单没有落库')
  assert.equal(milli(row.paid_amount), milli(o.payAmount), 'DB 里的实付与响应不一致')
  assert.equal(milli(row.surcharge_amount), milli(o.surchargeAmount), 'DB 里的尾数与响应不一致')
  assert.equal(row.pay_address, CHANNEL_ADDRESS, 'pay_address 快照没落库')
  assert.equal(row.pay_token_contract, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', '合约快照没落库')
  assert.ok(row.expires_at, 'expires_at 没落库')
  assert.ok(row.amount_reservation_id, 'amount_reservation_id 没关联')
  assert.equal(Number(row.status), 0, '订单初始状态应为 pending')

  // ---------- 预约 ----------
  const resv = (await pool.query(
    `SELECT state, suffix, amount_milli, recharge_id, reusable_after
       FROM recharge_amount_reservations WHERE id=$1`, [row.amount_reservation_id])).rows[0]
  assert.ok(resv, '预约不存在')
  assert.equal(resv.state, 'held', '预约应为 held')
  assert.equal(Number(resv.suffix), milli(o.surchargeAmount), '预约尾数与订单不一致')
  // amount_milli 本身就是「毫」—— 不能再乘 1000（同 toMilli/parseMilli 的坑）
  assert.equal(Number(resv.amount_milli), milli(o.payAmount), '预约金额与订单不一致')
  assert.equal(String(resv.recharge_id), String(row.id), '预约应回填订单归属')
  assert.ok(new Date(resv.reusable_after).getTime() >= new Date(row.expires_at).getTime() + 23 * 3600 * 1000,
    '保护期应至少覆盖到订单有效期 + 23 小时')

  // ---------- 再下一单，金额必须不同 ----------
  const res2 = await post('/userRecharge/create', { baseid: packageId, month: 1, channelId: 'usdt-trc20' })
  assert.equal(res2.status, 200, `第二单失败：HTTP ${res2.status} ${res2.text.slice(0, 200)}`)
  assert.notEqual(milli(res2.json.payAmount), milli(o.payAmount), '两张订单拿到了同一金额')
})
