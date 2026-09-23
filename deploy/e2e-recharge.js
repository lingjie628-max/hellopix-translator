#!/usr/bin/env node
/**
 * 充值链路端到端验证（TRC20 收款 + 后台确认）。
 *
 * 这是资金路径，所以不只测"能跑通"，重点测**不能出事的几种情况**：
 *   1. 下单金额带唯一匹配尾数（多家商户对账靠它）
 *   2. 确认收款后字符正确到账
 *   3. **重复确认不重复加字符**（幂等）—— 最典型的资金事故
 *   4. **同一笔链上交易不能给两单充值**
 *   5. 商户不能给自己加字符（只能通过后台确认）
 *
 * 在服务器上运行：node e2e-recharge.js
 */
const http = require('http')
const crypto = require('crypto')

const PORT = 3000
const BASE = { host: '127.0.0.1', port: PORT }

function makeJar() {
  const store = new Map()
  return {
    set(list) {
      for (const raw of list || []) {
        const [pair] = String(raw).split(';')
        const idx = pair.indexOf('=')
        if (idx > 0) store.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
      }
    },
    header() { return [...store].map(([k, v]) => `${k}=${v}`).join('; ') },
    get(name) { return store.get(name) || '' },
    all() { return Object.fromEntries(store) }
  }
}

function request(method, path, { body, jar, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? new URLSearchParams(body).toString() : null
    const req = http.request({
      ...BASE, method, path,
      headers: Object.assign(
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        jar ? { Cookie: jar.header() } : {},
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {},
        headers || {}
      )
    }, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        if (jar) jar.set(res.headers['set-cookie'])
        let json = null
        try { json = JSON.parse(data) } catch (e) { /* 非 JSON 保留原文 */ }
        resolve({ status: res.statusCode, json, text: data, headers: res.headers })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const csrfOf = jar => {
  const all = jar.all()
  const key = Object.keys(all).find(name => /csrf/i.test(name))
  return key ? all[key] : ''
}

const solveCaptcha = svg => {
  const base64 = String(svg || '').split(',')[1] || ''
  const text = Buffer.from(base64, 'base64').toString('utf8')
  return [...text.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(m => m[1]).join('')
}

async function login(jar, username, password, totpSecret) {
  const cap = await request('GET', '/apis/user/captcha', { jar })
  const body = {
    username, password,
    imageId: cap.json.imageId,
    imageCode: solveCaptcha(cap.json.image)
  }
  let res = await request('POST', '/apis/admin/login', { jar, body })
  // 注意：needTotp / ticket 在响应的**顶层**，不在 obj 里
  // （obj 只在完全登录成功、下发会话时才出现）
  if (res.json && res.json.needTotp) {
    const totpLib = require('/opt/hello-pix/server/lib/totp')
    res = await request('POST', '/apis/admin/login/totp', {
      jar, headers: { 'X-CSRF-Token': csrfOf(jar) },
      body: { ticket: res.json.ticket, code: totpLib.totp(totpSecret) }
    })
  }
  return res
}

async function loginMerchant(jar, username, password) {
  const cap = await request('GET', '/apis/user/captcha', { jar })
  return request('POST', '/apis/login', {
    jar,
    body: {
      username, password,
      imageId: cap.json.imageId,
      imageCode: solveCaptcha(cap.json.image)
    }
  })
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`)
}

async function main() {
  const { Client } = require('/opt/hello-pix/node_modules/pg')
  require('/opt/hello-pix/node_modules/dotenv') && 0
  const env = Object.fromEntries(
    require('fs').readFileSync('/etc/hello-pix/hello-pix.env', 'utf8')
      .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )
  const db = new Client({ connectionString: env.DATABASE_URL })
  await db.connect()

  const TEST_USER = `e2etest${crypto.randomInt(1000, 9999)}`
  const TEST_PASS = 'TestPass12345'
  const GOOD_ADDRESS = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  const BAD_ADDRESS = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'.slice(0, 33) + 'u'
  const TX_A = 'e2e-tx-' + crypto.randomBytes(8).toString('hex')
  const TX_B = 'e2e-tx-' + crypto.randomBytes(8).toString('hex')

  const adminPass = require('fs').readFileSync('/root/hello-pix-admin-credentials', 'utf8')
    .split('\n').find(l => l.startsWith('ADMIN_PASS=')).split('=').slice(1).join('=')
  const totpSecret = (await db.query("SELECT totp_secret FROM admins WHERE username='pix'")).rows[0].totp_secret

  const adminJar = makeJar()
  const merchantJar = makeJar()
  let userId = null

  // 这个脚本会临时改写 payment.channels 来测"地址校验"和"未启用时拒绝下单"。
  // 原实现结束时直接 DELETE 这条配置 —— 在生产上跑一次就等于把管理员
  // 配好的真实收款地址抹掉，而收款地址丢失意味着用户没法付款。
  // 现在：先快照，结束时原样还原；快照为空才删。
  const channelSnapshot = (await db.query(
    "SELECT value FROM app_settings WHERE key='payment.channels'")).rows[0]
  const originalChannels = channelSnapshot ? JSON.stringify(channelSnapshot.value) : null

  try {
    // ---------- 超管登录 ----------
    const adminLogin = await login(adminJar, 'pix', adminPass, totpSecret)
    check('超管登录（含 2FA）', adminLogin.status === 200 && !!(adminLogin.json && adminLogin.json.obj),
      `HTTP ${adminLogin.status} ${adminLogin.text.slice(0, 70)}`)

    // ---------- 地址校验 ----------
    const badSave = await request('POST', '/apis/admin/settings/save', {
      jar: adminJar, headers: { 'X-CSRF-Token': csrfOf(adminJar) },
      body: { paymentChannels: JSON.stringify([{ id: 'usdt-trc20', name: 'USDT', address: BAD_ADDRESS, enabled: 1 }]) }
    })
    check('错误地址被拒绝（校验和不匹配）', badSave.status === 400 && /校验和/.test(badSave.text),
      `HTTP ${badSave.status}`)

    const noAddr = await request('POST', '/apis/admin/settings/save', {
      jar: adminJar, headers: { 'X-CSRF-Token': csrfOf(adminJar) },
      body: { paymentChannels: JSON.stringify([{ id: 'usdt-trc20', name: 'USDT', address: '', enabled: 1 }]) }
    })
    check('启用但无地址被拒绝', noAddr.status === 400, `HTTP ${noAddr.status}`)

    const goodSave = await request('POST', '/apis/admin/settings/save', {
      jar: adminJar, headers: { 'X-CSRF-Token': csrfOf(adminJar) },
      body: { paymentChannels: JSON.stringify([{ id: 'usdt-trc20', name: 'USDT', address: GOOD_ADDRESS, note: 'e2e 测试用', enabled: 1 }]) }
    })
    check('合法地址保存成功', goodSave.status === 200, `HTTP ${goodSave.status}`)

    // ---------- 建测试商户 ----------
    const { hashPassword } = require('/opt/hello-pix/server/lib/password')
    const packId = (await db.query('SELECT id FROM packages ORDER BY id LIMIT 1')).rows[0].id
    const inserted = await db.query(
      `INSERT INTO users(username,password_hash,nickname,status,package_id,char_balance,char_used)
       VALUES($1,$2,$3,1,$4,0,0) RETURNING id`,
      [TEST_USER, await hashPassword(TEST_PASS), TEST_USER, packId]
    )
    userId = inserted.rows[0].id
    check('创建测试商户', !!userId, `id=${userId}`)

    // ---------- 商户下单 ----------
    const merLogin = await loginMerchant(merchantJar, TEST_USER, TEST_PASS)
    check('商户登录', merLogin.status === 200, `HTTP ${merLogin.status}`)

    const order1 = await request('POST', '/apis/userRecharge/create', {
      jar: merchantJar, headers: { 'X-CSRF-Token': csrfOf(merchantJar) },
      body: { baseid: packId, month: 1, channelId: 'usdt-trc20' }
    })
    const o1 = order1.json || {}
    check('创建充值订单', order1.status === 200 && !!o1.orderNum, o1.orderNum || order1.text.slice(0, 80))
    check('订单带唯一匹配尾数', Number(o1.matchSuffix) > 0, `尾数 ${o1.matchSuffix}`)
    check('订单返回收款地址', o1.channel && o1.channel.address === GOOD_ADDRESS, o1.channel && o1.channel.address)

    // RC-02：金额恒等式改为 实付 = 标准价 − 折扣 + 尾数。
    // 旧断言是「实付 = 标准价 − 折扣」，加尾数后必然不成立。
    const milli = v => Math.round(Number(v) * 1000)
    check('尾数落在 0.001–0.999',
      milli(o1.matchSuffix) >= 1 && milli(o1.matchSuffix) <= 999,
      `尾数 ${o1.matchSuffix}`)
    check('金额恒等式：实付 = 标准价 − 折扣 + 尾数',
      milli(o1.payAmount) === milli(o1.originalAmount) - milli(o1.discountAmount) + milli(o1.surchargeAmount),
      `${o1.originalAmount} − ${o1.discountAmount} + ${o1.surchargeAmount} ≠ ${o1.payAmount}`)
    check('surchargeAmount 与 matchSuffix 一致',
      milli(o1.surchargeAmount) === milli(o1.matchSuffix),
      `${o1.surchargeAmount} vs ${o1.matchSuffix}`)
    check('订单返回有效期（约 30 分钟）', (() => {
      if (!o1.expiresAt) return false
      const left = (new Date(o1.expiresAt).getTime() - Date.now()) / 60000
      return left > 25 && left <= 30
    })(), o1.expiresAt)
    check('订单快照了代币合约', o1.channel && o1.channel.tokenContract === USDT_CONTRACT,
      o1.channel && o1.channel.tokenContract)

    // ---------- 落库字段检查（冒烟测试的核心）----------
    const dbOrder = (await db.query(
      `SELECT original_amount, discount_amount, surcharge_amount, paid_amount,
              expires_at, pay_address, pay_token_contract, amount_reservation_id, status
         FROM recharges WHERE order_number=$1`, [o1.orderNum])).rows[0]
    check('surcharge_amount 已落库', milli(dbOrder.surcharge_amount) === milli(o1.surchargeAmount),
      dbOrder.surcharge_amount)
    check('paid_amount 三位精度未被截断',
      String(dbOrder.paid_amount).split('.')[1] && String(dbOrder.paid_amount).split('.')[1].length <= 3,
      dbOrder.paid_amount)
    check('pay_address 快照已落库', dbOrder.pay_address === GOOD_ADDRESS, dbOrder.pay_address)
    check('pay_token_contract 快照已落库', dbOrder.pay_token_contract === USDT_CONTRACT,
      dbOrder.pay_token_contract)
    check('expires_at 已落库', !!dbOrder.expires_at, dbOrder.expires_at)
    check('amount_reservation_id 已关联', !!dbOrder.amount_reservation_id, dbOrder.amount_reservation_id)
    const reservation = dbOrder.amount_reservation_id
      ? (await db.query('SELECT state, suffix FROM recharge_amount_reservations WHERE id=$1',
        [dbOrder.amount_reservation_id])).rows[0]
      : null
    check('金额预约处于 held 且尾数一致',
      !!reservation && reservation.state === 'held' && Number(reservation.suffix) === milli(o1.matchSuffix),
      reservation)

    // ---------- 商户不能自己加字符 ----------
    const selfGrant = await request('POST', '/apis/admin/translate/grant', {
      jar: merchantJar, headers: { 'X-CSRF-Token': csrfOf(merchantJar) },
      body: { userId: TEST_USER, chars: 999999 }
    })
    check('商户无法调用超管加字符接口', selfGrant.status === 401 || selfGrant.status === 403,
      `HTTP ${selfGrant.status}`)

    // ---------- 后台确认收款 ----------
    const before = Number((await db.query('SELECT char_balance FROM users WHERE id=$1', [userId])).rows[0].char_balance)
    const orderId = (await db.query('SELECT id FROM recharges WHERE order_number=$1', [o1.orderNum])).rows[0].id

    const paid1 = await request('POST', '/apis/admin/recharges/status', {
      jar: adminJar, headers: { 'X-CSRF-Token': csrfOf(adminJar) },
      body: { id: orderId, providerTransactionId: TX_A }
    })
    const after1 = Number((await db.query('SELECT char_balance FROM users WHERE id=$1', [userId])).rows[0].char_balance)
    check('确认收款成功', paid1.status === 200, `HTTP ${paid1.status}`)
    check('字符正确到账', after1 - before === Number(o1.chars), `+${after1 - before} 字符`)

    // ---------- 幂等：重复确认 ----------
    const paid2 = await request('POST', '/apis/admin/recharges/status', {
      jar: adminJar, headers: { 'X-CSRF-Token': csrfOf(adminJar) },
      body: { id: orderId, providerTransactionId: TX_A }
    })
    const after2 = Number((await db.query('SELECT char_balance FROM users WHERE id=$1', [userId])).rows[0].char_balance)
    check('重复确认不重复加字符（幂等）', after2 === after1,
      `余额 ${after1} → ${after2}${after2 === after1 ? ' 未变 ✓' : ' 被重复加了 ✗'}`)
    check('重复确认返回成功而非报错', paid2.status === 200 && /已确认/.test(paid2.text), paid2.text.slice(0, 60))

    // ---------- 同一笔链上交易不能给两单充值 ----------
    const order2 = await request('POST', '/apis/userRecharge/create', {
      jar: merchantJar, headers: { 'X-CSRF-Token': csrfOf(merchantJar) },
      body: { baseid: packId, month: 1, channelId: 'usdt-trc20' }
    })
    const orderId2 = (await db.query('SELECT id FROM recharges WHERE order_number=$1', [order2.json.orderNum])).rows[0].id
    const reuseTx = await request('POST', '/apis/admin/recharges/status', {
      jar: adminJar, headers: { 'X-CSRF-Token': csrfOf(adminJar) },
      body: { id: orderId2, providerTransactionId: TX_A }
    })
    const after3 = Number((await db.query('SELECT char_balance FROM users WHERE id=$1', [userId])).rows[0].char_balance)
    check('同一交易号不能给第二单充值', reuseTx.status === 409 && after3 === after2,
      `HTTP ${reuseTx.status}${after3 === after2 ? ' 余额未变 ✓' : ' 余额变了 ✗'}`)

    // ---------- 正常第二单可以用新交易号 ----------
    const paid3 = await request('POST', '/apis/admin/recharges/status', {
      jar: adminJar, headers: { 'X-CSRF-Token': csrfOf(adminJar) },
      body: { id: orderId2, providerTransactionId: TX_B }
    })
    const after4 = Number((await db.query('SELECT char_balance FROM users WHERE id=$1', [userId])).rows[0].char_balance)
    check('换新交易号可正常充值', paid3.status === 200 && after4 > after3, `+${after4 - after3} 字符`)

    // ---------- 未配置收款方式时应拒绝下单 ----------
    await request('POST', '/apis/admin/settings/save', {
      jar: adminJar, headers: { 'X-CSRF-Token': csrfOf(adminJar) },
      body: { paymentChannels: JSON.stringify([{ id: 'usdt-trc20', name: 'USDT', address: GOOD_ADDRESS, enabled: 0 }]) }
    })
    const noChannel = await request('POST', '/apis/userRecharge/create', {
      jar: merchantJar, headers: { 'X-CSRF-Token': csrfOf(merchantJar) },
      body: { baseid: packId, month: 1, channelId: 'usdt-trc20' }
    })
    check('未启用收款方式时拒绝下单', noChannel.status === 503, `HTTP ${noChannel.status}`)
  } finally {
    // ---------- 清理 ----------
    try {
      if (userId) {
        await db.query('DELETE FROM recharges WHERE user_id=$1', [userId])
        await db.query("DELETE FROM audit_logs WHERE resource_type='user' AND resource_id=$1", [String(userId)])
        await db.query('DELETE FROM users WHERE id=$1', [userId])
      }
      // 还原收款配置：有快照就写回原值，没快照才删
      if (originalChannels === null) {
        await db.query("DELETE FROM app_settings WHERE key='payment.channels'")
      } else {
        await db.query(
          `INSERT INTO app_settings(key,value,description) VALUES('payment.channels',$1::jsonb,'收款渠道')
           ON CONFLICT (key) DO UPDATE SET value=$1::jsonb`,
          [originalChannels]
        )
      }
      console.log('  收款配置已还原:', originalChannels === null ? '(原本就没有)' : '已恢复原值')
    } catch (e) {
      console.log('  清理时出错（请手动检查）:', e.message)
    }
    await db.end()
  }
  const passed = results.filter(r => r.ok).length
  console.log(`\n  ${passed}/${results.length} 项通过`)
  if (passed !== results.length) process.exitCode = 1
}

main().catch(err => { console.error('  测试异常:', err.message); process.exit(1) })
