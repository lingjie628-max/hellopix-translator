'use strict'

/**
 * 创建一张**不付款**的测试充值订单，用于观察 ChainWatcher 在有 pending 订单时的行为。
 *
 * 与 deploy/smoke-recharge-create.js 的区别：那个跑完会把自己清干净；
 * 这个**故意留下来**，因为它的用途就是"让系统里长期存在一张待支付订单"。
 *
 * 观察点：
 *   - watcher 每分钟照常跑，不因为存在 pending 订单而报错或卡住
 *   - 订单状态始终是 0（pending），不会被任何东西误改
 *   - 金额预约始终是 held
 *   - 用户的字符余额始终是 0
 *
 * 清理方式（观察结束后）：
 *   node deploy/create-shadow-test-order.js --cleanup
 *
 * 用法：
 *   cd /opt/hello-pix && node deploy/create-shadow-test-order.js
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const APP = process.env.APP_DIR || '/opt/hello-pix'
const PORT = Number(process.env.PORT || 3000)
const BASE = { host: '127.0.0.1', port: PORT }
/** 固定用户名，便于反复查找与清理 */
const TEST_USER = 'shadowprobe'

function makeJar() {
  const store = new Map()
  return {
    set(list) {
      for (const raw of list || []) {
        const [pair] = String(raw).split(';')
        const i = pair.indexOf('=')
        if (i > 0) store.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
      }
    },
    header() { return [...store].map(([k, v]) => `${k}=${v}`).join('; ') }
  }
}

function request(method, urlPath, { body, jar, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? new URLSearchParams(body).toString() : null
    const req = http.request({
      ...BASE, method, path: urlPath,
      headers: Object.assign(
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        jar ? { Cookie: jar.header() } : {},
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {},
        headers || {}
      )
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (jar) jar.set(res.headers['set-cookie'])
        let json = null
        try { json = JSON.parse(data) } catch (_e) { /* 保留原文 */ }
        resolve({ status: res.statusCode, json, text: data })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const solveCaptcha = svg => {
  const b64 = String(svg || '').split(',')[1] || ''
  const text = Buffer.from(b64, 'base64').toString('utf8')
  return [...text.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(m => m[1]).join('')
}

async function connectDb() {
  const env = Object.fromEntries(
    fs.readFileSync('/etc/hello-pix/hello-pix.env', 'utf8')
      .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
  const { Client } = require(path.join(APP, 'node_modules/pg'))
  const db = new Client({ connectionString: env.DATABASE_URL })
  await db.connect()
  return db
}

async function cleanup(db) {
  const { rows } = await db.query('SELECT id FROM users WHERE username=$1', [TEST_USER])
  if (!rows.length) {
    console.log('  没有需要清理的测试订单')
    return
  }
  const userId = rows[0].id
  const resvIds = (await db.query(
    `SELECT amount_reservation_id AS id FROM recharges
      WHERE user_id=$1 AND amount_reservation_id IS NOT NULL`, [userId])).rows.map(r => r.id)
  await db.query(
    `UPDATE recharge_amount_reservations SET recharge_id=NULL
      WHERE recharge_id IN (SELECT id FROM recharges WHERE user_id=$1)`, [userId])
  const del = await db.query('DELETE FROM recharges WHERE user_id=$1', [userId])
  if (resvIds.length) {
    await db.query('DELETE FROM recharge_amount_reservations WHERE id = ANY($1::bigint[])', [resvIds])
  }
  await db.query('DELETE FROM users WHERE id=$1', [userId])
  console.log(`  已清理：${del.rowCount} 张订单 / ${resvIds.length} 条预约 / 1 个测试商户`)
}

async function main() {
  const db = await connectDb()
  try {
    if (process.argv.includes('--cleanup')) {
      console.log('=== 清理测试订单 ===')
      await cleanup(db)
      return 0
    }

    console.log('=== 1. 前置检查 ===')
    const channelRow = (await db.query(
      "SELECT value FROM app_settings WHERE key='payment.channels'")).rows[0]
    const live = (Array.isArray(channelRow && channelRow.value) ? channelRow.value : [])
      .filter(c => Number(c.enabled) && c.address)
    if (!live.length) {
      console.log('  收款方式未配置或未启用，无法下单')
      return 1
    }
    const channel = live[0]
    console.log(`  渠道 ${channel.id} / ${channel.address}`)

    console.log('=== 2. 建/复用测试商户 ===')
    const packId = (await db.query('SELECT id FROM packages ORDER BY id LIMIT 1')).rows[0].id
    let userId
    const existing = await db.query('SELECT id FROM users WHERE username=$1', [TEST_USER])
    if (existing.rows.length) {
      userId = existing.rows[0].id
      console.log(`  复用已有商户 id=${userId}`)
    } else {
      const { hashPassword } = require(path.join(APP, 'server/lib/password'))
      const pass = 'ShadowProbe12345'
      const inserted = await db.query(
        `INSERT INTO users(username,password_hash,nickname,email,email_verified,status,
           package_id,char_balance,char_used,remarks)
         VALUES($1,$2,$1,$3,false,1,$4,0,0,'RC-02 Shadow 观察用，勿删') RETURNING id`,
        [TEST_USER, await hashPassword(pass), `${TEST_USER}@shadow.test`, packId])
      userId = inserted.rows[0].id
      console.log(`  已创建商户 ${TEST_USER} / ${pass}  id=${userId}`)
    }

    console.log('=== 3. 登录并下单 ===')
    const jar = makeJar()
    const cap = await request('GET', '/apis/user/captcha', { jar })
    const login = await request('POST', '/apis/login', {
      jar,
      body: {
        username: TEST_USER, password: 'ShadowProbe12345',
        imageId: cap.json && cap.json.imageId,
        imageCode: solveCaptcha(cap.json && cap.json.image)
      }
    })
    if (login.status !== 200) {
      console.log('  登录失败:', login.status, login.text.slice(0, 160))
      return 1
    }
    const csrf = /(__Host-pix_csrf|pix_csrf)=([^;]+)/.exec(jar.header())
    const created = await request('POST', '/apis/userRecharge/create', {
      jar,
      headers: csrf ? { 'X-CSRF-Token': csrf[2] } : {},
      body: { baseid: packId, month: 1, channelId: channel.id }
    })
    if (created.status !== 200) {
      console.log('  下单失败:', created.status, created.text.slice(0, 200))
      return 1
    }
    const o = created.json

    console.log('=== 4. 订单已创建（故意不付款）===')
    console.log(`  订单号   ${o.orderNum}`)
    console.log(`  标准价   ${o.originalAmount}`)
    console.log(`  折扣     ${o.discountAmount}`)
    console.log(`  匹配尾数 ${o.surchargeAmount}`)
    console.log(`  应付     ${o.payAmount} USDT`)
    console.log(`  收款地址 ${o.channel.address}`)
    console.log(`  合约     ${o.channel.tokenContract}`)
    console.log(`  有效期至 ${o.expiresAt}`)
    console.log('')
    console.log('  ⚠ 不要付款。本单只用于观察 watcher 在存在 pending 订单时的行为。')
    console.log('  观察结束后清理：node deploy/create-shadow-test-order.js --cleanup')
    return 0
  } finally {
    await db.end()
  }
}

main()
  .then(code => { process.exitCode = code || 0 })
  .catch(error => { console.error('异常:', (error && error.stack) || error); process.exitCode = 1 })
