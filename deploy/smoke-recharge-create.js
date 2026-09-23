'use strict'

/**
 * 充值下单冒烟测试（生产环境安全版）。
 *
 * 只做一件事：真实调一次 `/userRecharge/create`，确认 RC-02 新增的
 * 落库字段全部正常。**绝不修改 payment.channels** —— 那里面是管理员
 * 配好的真实收款地址，丢了下游就没法付款。
 *
 * 与 deploy/e2e-recharge.js 的区别：那个脚本为了测"地址校验"和
 * "未启用时拒绝下单"会临时改写收款配置，属于破坏性测试；
 * 本脚本只读配置、只写自己创建的测试数据，跑完清干净。
 *
 * 用法（在服务器上）：
 *   cd /opt/hello-pix && node deploy/smoke-recharge-create.js
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const APP = process.env.APP_DIR || '/opt/hello-pix'
const PORT = Number(process.env.PORT || 3000)
const BASE = { host: '127.0.0.1', port: PORT }

let pass = 0
let fail = 0
function check(label, ok, extra) {
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}

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
    header() { return [...store].map(([k, v]) => `${k}=${v}`).join('; ') },
    get(name) { return store.get(name) || '' }
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
        let json = null
        try { json = JSON.parse(data) } catch (_e) { /* 保留原文 */ }
        resolve({ status: res.statusCode, json, text: data, headers: res.headers })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const csrfOf = jar => {
  const m = /(__Host-pix_csrf|pix_csrf)=([^;]+)/.exec(jar.header())
  return m ? m[2] : ''
}
/** 图形验证码是内联 SVG，文字就在 <text> 里 —— 服务端自己生成的，不是绕过 */
const solveCaptcha = svg => {
  const b64 = String(svg || '').split(',')[1] || ''
  const text = Buffer.from(b64, 'base64').toString('utf8')
  return [...text.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(m => m[1]).join('')
}

/** 三位小数精度下的整数比较，避免浮点误差 */
const milli = v => Math.round(Number(v) * 1000)

async function main() {
  const env = Object.fromEntries(
    fs.readFileSync('/etc/hello-pix/hello-pix.env', 'utf8')
      .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )
  const { Client } = require(path.join(APP, 'node_modules/pg'))
  const db = new Client({ connectionString: env.DATABASE_URL })
  await db.connect()

  const TEST_USER = `smoke${crypto.randomInt(100000, 999999)}`
  const TEST_PASS = 'SmokeTest12345'
  const jar = makeJar()
  let userId = null
  let rechargeId = null
  let reservationId = null

  console.log('=== 0. 前置检查（只读，不修改收款配置）===')
  const channelRow = (await db.query(
    "SELECT value FROM app_settings WHERE key='payment.channels'")).rows[0]
  const channels = Array.isArray(channelRow && channelRow.value) ? channelRow.value : []
  const live = channels.filter(c => Number(c.enabled) && c.address)
  check('收款渠道已启用且有地址', live.length > 0,
    channels.map(c => ({ id: c.id, enabled: c.enabled, address: c.address })))
  if (!live.length) {
    console.log('\n  收款方式未配置或未启用，无法下单。请先在后台「收款方式」里配置。')
    await db.end()
    process.exit(1)
  }
  const channel = live[0]
  console.log(`  使用渠道: ${channel.id} / ${channel.address}`)
  console.log('  （本脚本全程不修改 payment.channels）')

  try {
    console.log('\n=== 1. 建测试商户 ===')
    const packId = (await db.query('SELECT id FROM packages ORDER BY id LIMIT 1')).rows[0].id
    const { hashPassword } = require(path.join(APP, 'server/lib/password'))
    const inserted = await db.query(
      `INSERT INTO users(username,password_hash,nickname,email,email_verified,status,package_id,char_balance,char_used)
       VALUES($1,$2,$1,$3,false,1,$4,0,0) RETURNING id`,
      [TEST_USER, await hashPassword(TEST_PASS), `${TEST_USER}@smoke.test`, packId]
    )
    userId = inserted.rows[0].id
    check('测试商户已创建', !!userId, { username: TEST_USER, id: userId })

    console.log('\n=== 2. 商户登录 ===')
    const cap = await request('GET', '/apis/user/captcha', { jar })
    const login = await request('POST', '/apis/login', {
      jar,
      body: {
        username: TEST_USER,
        password: TEST_PASS,
        imageId: cap.json && cap.json.imageId,
        imageCode: solveCaptcha(cap.json && cap.json.image)
      }
    })
    check('商户登录成功', login.status === 200, { status: login.status, body: login.text.slice(0, 120) })

    console.log('\n=== 3. 真实下单 /userRecharge/create ===')
    const created = await request('POST', '/apis/userRecharge/create', {
      jar,
      headers: { 'X-CSRF-Token': csrfOf(jar) },
      body: { baseid: packId, month: 1, channelId: channel.id }
    })
    const o = created.json || {}
    check('下单返回 200', created.status === 200, { status: created.status, body: created.text.slice(0, 160) })
    if (created.status !== 200) throw new Error('下单失败，后续检查无法进行')

    console.log(`  订单号 ${o.orderNum}`)
    console.log(`  标准价 ${o.originalAmount}  折扣 ${o.discountAmount}  尾数 ${o.surchargeAmount}  实付 ${o.payAmount}`)
    console.log(`  有效期至 ${o.expiresAt}`)

    console.log('\n=== 4. 金额恒等式与尾数范围 ===')
    check('尾数落在 0.001–0.999',
      milli(o.matchSuffix) >= 1 && milli(o.matchSuffix) <= 999, o.matchSuffix)
    check('实付 = 标准价 − 折扣 + 尾数',
      milli(o.payAmount) === milli(o.originalAmount) - milli(o.discountAmount) + milli(o.surchargeAmount),
      { original: o.originalAmount, discount: o.discountAmount, surcharge: o.surchargeAmount, paid: o.payAmount })
    check('surchargeAmount 与 matchSuffix 一致',
      milli(o.surchargeAmount) === milli(o.matchSuffix), { a: o.surchargeAmount, b: o.matchSuffix })
    check('有效期约 30 分钟', (() => {
      if (!o.expiresAt) return false
      const left = (new Date(o.expiresAt).getTime() - Date.now()) / 60000
      return left > 25 && left <= 30
    })(), o.expiresAt)

    console.log('\n=== 5. 数据库落库字段（冒烟测试的核心）===')
    const row = (await db.query(
      `SELECT id, original_amount, discount_amount, surcharge_amount, paid_amount,
              expires_at, pay_address, pay_token_contract, amount_reservation_id, status
         FROM recharges WHERE order_number=$1`, [o.orderNum])).rows[0]
    check('订单已落库', !!row, o.orderNum)
    if (!row) throw new Error('订单没落库')
    rechargeId = row.id
    reservationId = row.amount_reservation_id

    check('surcharge_amount 落库正确', milli(row.surcharge_amount) === milli(o.surchargeAmount), row.surcharge_amount)
    check('paid_amount 落库值与接口一致（三位精度未被截断）',
      milli(row.paid_amount) === milli(o.payAmount),
      { db: row.paid_amount, api: o.payAmount })
    check('paid_amount 确实带三位小数（尾数没被 numeric(14,2) 抹掉）',
      milli(o.surchargeAmount) > 0 && milli(row.surcharge_amount) === milli(o.surchargeAmount),
      { surcharge: row.surcharge_amount })
    check('expires_at 已落库', !!row.expires_at, row.expires_at)
    check('pay_address 快照已落库', row.pay_address === channel.address, row.pay_address)
    check('pay_token_contract 快照已落库',
      row.pay_token_contract === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', row.pay_token_contract)
    check('amount_reservation_id 已关联', !!row.amount_reservation_id, row.amount_reservation_id)
    check('订单初始状态为 pending(0)', Number(row.status) === 0, row.status)

    console.log('\n=== 6. 金额预约状态 ===')
    const resv = reservationId
      ? (await db.query(
        'SELECT state, suffix, amount_milli, reusable_after, recharge_id FROM recharge_amount_reservations WHERE id=$1',
        [reservationId])).rows[0]
      : null
    check('预约存在', !!resv, reservationId)
    check('预约状态为 held', resv && resv.state === 'held', resv && resv.state)
    check('预约尾数与订单一致', resv && Number(resv.suffix) === milli(o.matchSuffix),
      { resv: resv && resv.suffix, order: milli(o.matchSuffix) })
    check('预约金额与订单实付一致', resv && milli(resv.amount_milli) === milli(o.payAmount),
      { resv: resv && resv.amount_milli, order: o.payAmount })
    check('预约已回填订单归属', resv && String(resv.recharge_id) === String(rechargeId),
      { resv: resv && resv.recharge_id, order: rechargeId })
    check('保护期晚于订单有效期（24 小时保护）', (() => {
      if (!resv || !row.expires_at) return false
      return new Date(resv.reusable_after).getTime() >= new Date(row.expires_at).getTime() + 23 * 3600 * 1000
    })(), resv && resv.reusable_after)

    console.log('\n=== 7. 并发下单拿到不同金额 ===')
    const second = await request('POST', '/apis/userRecharge/create', {
      jar,
      headers: { 'X-CSRF-Token': csrfOf(jar) },
      body: { baseid: packId, month: 1, channelId: channel.id }
    })
    const o2 = second.json || {}
    check('第二单也成功', second.status === 200, second.status)
    check('两张订单金额不同（尾数唯一）',
      milli(o2.payAmount) !== milli(o.payAmount),
      { first: o.payAmount, second: o2.payAmount })
    if (o2.orderNum) {
      const row2 = (await db.query('SELECT id, amount_reservation_id FROM recharges WHERE order_number=$1',
        [o2.orderNum])).rows[0]
      if (row2) {
        // 记下来一起清
        await db.query('UPDATE recharge_amount_reservations SET recharge_id=NULL WHERE recharge_id=$1', [row2.id])
        await db.query('DELETE FROM recharges WHERE id=$1', [row2.id])
        if (row2.amount_reservation_id) {
          await db.query('DELETE FROM recharge_amount_reservations WHERE id=$1', [row2.amount_reservation_id])
        }
      }
    }
  } finally {
    console.log('\n=== 8. 清理（只删本次创建的测试数据）===')
    try {
      if (rechargeId) {
        await db.query('UPDATE recharge_amount_reservations SET recharge_id=NULL WHERE recharge_id=$1', [rechargeId])
        await db.query('DELETE FROM recharges WHERE id=$1', [rechargeId])
      }
      if (reservationId) {
        await db.query('DELETE FROM recharge_amount_reservations WHERE id=$1', [reservationId])
      }
      if (userId) {
        await db.query('DELETE FROM recharges WHERE user_id=$1', [userId])
        await db.query('DELETE FROM users WHERE id=$1', [userId])
      }
      console.log('  已清理测试订单、预约与测试商户')
    } catch (e) {
      console.log('  清理出错（请手动检查）:', e.message)
    }
    // 复核收款配置没被动过
    const after = (await db.query(
      "SELECT value FROM app_settings WHERE key='payment.channels'")).rows[0]
    const same = JSON.stringify(after && after.value) === JSON.stringify(channelRow && channelRow.value)
    check('收款配置未被本脚本改动', same,
      { before: channelRow && channelRow.value, after: after && after.value })
    await db.end()
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail) process.exitCode = 1
}

main().catch(err => { console.error('冒烟测试异常：', err && err.stack || err); process.exit(1) })
