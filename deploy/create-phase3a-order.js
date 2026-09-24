'use strict'

/**
 * Phase 3A：创建全新测试商户 + 一张 fresh pending 充值订单，并打印付款指令。
 *
 * ## 这一轮要验证什么
 *
 * 真实链上的完整链路：
 *
 *   用户付款 → TronGrid → fingerprint 分页 → event_index 解析
 *   → chain_transactions → 候选订单匹配 → WOULD_SETTLE
 *
 * **不开启 Live Settlement**，订单不会被改成 paid，字符不会增加。
 *
 * ## 与 create-shadow-test-order.js 的区别
 *
 * 那个复用固定的 `shadowprobe` 商户，用来做"长期挂一张 pending 单"的稳定性观察；
 * 这个每次都建**全新商户**，且订单金额是当下按正式随机尾数规则生成的，
 * 用于"真实付款必须精确匹配"的验证。
 *
 * 用法：
 *   cd /opt/hello-pix && node deploy/create-phase3a-order.js
 *   node deploy/create-phase3a-order.js --cleanup <用户名>
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const APP = process.env.APP_DIR || '/opt/hello-pix'
const PORT = Number(process.env.PORT || 3000)
const BASE = { host: '127.0.0.1', port: PORT }
const PASSWORD = 'Phase3AProbe12345'

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

async function cleanup(db, username) {
  const found = await db.query('SELECT id FROM users WHERE username=$1', [username])
  if (!found.rows.length) { console.log(`  没有找到商户 ${username}`); return }
  const uid = found.rows[0].id
  const resv = (await db.query(
    `SELECT amount_reservation_id AS id FROM recharges
      WHERE user_id=$1 AND amount_reservation_id IS NOT NULL`, [uid])).rows.map(r => r.id)
  await db.query('UPDATE recharge_amount_reservations SET recharge_id=NULL WHERE recharge_id IN (SELECT id FROM recharges WHERE user_id=$1)', [uid])
  const del = await db.query('DELETE FROM recharges WHERE user_id=$1', [uid])
  if (resv.length) await db.query('DELETE FROM recharge_amount_reservations WHERE id = ANY($1::bigint[])', [resv])
  await db.query('DELETE FROM users WHERE id=$1', [uid])
  console.log(`  已清理：${del.rowCount} 张订单 / ${resv.length} 条预约 / 商户 ${username}`)
}

async function main() {
  const db = await connectDb()
  try {
    const cleanupIdx = process.argv.indexOf('--cleanup')
    if (cleanupIdx >= 0) {
      const who = process.argv[cleanupIdx + 1]
      if (!who) { console.log('用法: --cleanup <用户名>'); return 1 }
      console.log('=== 清理 ===')
      await cleanup(db, who)
      return 0
    }

    console.log('=== 0. 前置检查 ===')
    const channelRow = (await db.query(
      "SELECT value FROM app_settings WHERE key='payment.channels'")).rows[0]
    const live = (Array.isArray(channelRow && channelRow.value) ? channelRow.value : [])
      .filter(c => Number(c.enabled) && c.address)
    if (!live.length) { console.log('  收款方式未配置或未启用'); return 1 }
    const channel = live[0]
    console.log(`  收款渠道 ${channel.id}`)

    console.log('=== 1. 创建全新测试商户 ===')
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const username = `p3a${stamp}`
    const packId = (await db.query('SELECT id FROM packages ORDER BY id LIMIT 1')).rows[0].id
    const { hashPassword } = require(path.join(APP, 'server/lib/password'))
    const created = await db.query(
      `INSERT INTO users(username,password_hash,nickname,email,email_verified,status,
         package_id,char_balance,char_used,remarks)
       VALUES($1,$2,$1,$3,false,1,$4,0,0,'Phase 3A 真实付款验证用') RETURNING id`,
      [username, await hashPassword(PASSWORD), `${username}@phase3a.test`, packId])
    const userId = created.rows[0].id
    console.log(`  商户 ${username}  id=${userId}`)
    console.log(`  初始字符余额 0（验证期间必须保持 0）`)

    console.log('=== 2. 登录并下单（走正式随机三位尾数规则）===')
    const jar = makeJar()
    const cap = await request('GET', '/apis/user/captcha', { jar })
    const login = await request('POST', '/apis/login', {
      jar,
      body: { username, password: PASSWORD, imageId: cap.json && cap.json.imageId,
        imageCode: solveCaptcha(cap.json && cap.json.image) }
    })
    if (login.status !== 200) { console.log('  登录失败:', login.status, login.text.slice(0, 160)); return 1 }
    const csrf = /(__Host-pix_csrf|pix_csrf)=([^;]+)/.exec(jar.header())
    const res = await request('POST', '/apis/userRecharge/create', {
      jar, headers: csrf ? { 'X-CSRF-Token': csrf[2] } : {},
      body: { baseid: packId, month: 1, channelId: channel.id }
    })
    if (res.status !== 200) { console.log('  下单失败:', res.status, res.text.slice(0, 200)); return 1 }
    const o = res.json

    // 落库核对
    const row = (await db.query(
      `SELECT r.id, r.status, r.paid_amount, r.surcharge_amount, r.original_amount,
              r.discount_amount, r.pay_address, r.pay_token_contract, r.expires_at,
              r.amount_reservation_id, res.state AS res_state, res.suffix, res.reusable_after
         FROM recharges r
         LEFT JOIN recharge_amount_reservations res ON res.id = r.amount_reservation_id
        WHERE r.order_number = $1`, [o.orderNum])).rows[0]

    const now = new Date()
    const expires = new Date(o.expiresAt)
    const minutesLeft = Math.floor((expires.getTime() - now.getTime()) / 60000)

    console.log('')
    console.log('╔══════════════════════════════════════════════════════════════════╗')
    console.log('║  Phase 3A 付款指令 —— 请严格按此金额转账，多一分少一分都不行      ║')
    console.log('╚══════════════════════════════════════════════════════════════════╝')
    console.log('')
    console.log(`  网络        TRC20（波场）`)
    console.log(`  代币合约    ${o.channel.tokenContract}`)
    console.log(`  收款地址    ${o.channel.address}`)
    console.log('')
    console.log(`  转账金额    ${o.payAmount} USDT   ←←← 必须完全一致`)
    console.log('')
    console.log(`  订单号      ${o.orderNum}`)
    console.log(`  标准价      ${o.originalAmount}`)
    console.log(`  折扣        ${o.discountAmount}`)
    console.log(`  匹配尾数    ${o.surchargeAmount}`)
    console.log('')
    console.log(`  有效期至    ${expires.toISOString()}  （剩 ${minutesLeft} 分钟）`)
    console.log(`  测试商户    ${username}`)
    console.log('')
    console.log('  当前状态（付款前基线，全部应为 0/pending）：')
    console.log(`    订单状态    ${row.status} (0=pending)`)
    console.log(`    金额预约    ${row.res_state}  suffix=${row.suffix}`)
    console.log(`    保护期至    ${new Date(row.reusable_after).toISOString()}`)
    console.log(`    字符余额    0`)
    console.log('')
    console.log('  ⚠ 本轮不会真实入账：AUTO_SETTLEMENT_ENABLED=false')
    console.log('     预期结果是 shadow 输出 WOULD_SETTLE，订单保持 pending，余额保持 0')
    console.log('')
    console.log(`  验证命令：node deploy/verify-phase3a.js ${o.orderNum}`)
    console.log(`  清理命令：node deploy/create-phase3a-order.js --cleanup ${username}`)
    return 0
  } finally {
    await db.end()
  }
}

main()
  .then(code => { process.exitCode = code || 0 })
  .catch(error => { console.error('异常:', (error && error.stack) || error); process.exitCode = 1 })
