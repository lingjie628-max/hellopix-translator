'use strict'

/**
 * 「惰性过期」展示与统计语义的线上验证。
 *
 * ## 要证明的事
 *
 * 订单过期是惰性判定的：库里 `status` 不会因为时间到了就变成 2。
 * 于是 `status=0` 不等于"还在等付款"。修好之前：
 *
 *   - 后台列表把早已过期、再也付不了款的僵尸单显示成「未支付」
 *   - 统计把僵尸单算进「待支付」，报表数字虚高
 *   - 商户端按"已过期"筛选得到 0 条，按"未支付"筛选混进僵尸单
 *
 * 这个脚本用**线上那一份路由代码 + 线上数据库**跑真实请求，逐条核对。
 *
 * ## 只替换鉴权层
 *
 * 管理端要超管会话（带 2FA），商户端要验证码 —— 但这些**不是被测对象**，
 * 被测的是「页面拿到的数据对不对」。所以：
 *
 *   - 商户端：走**完整真实 HTTP**（建商户 → 验证码 → 登录 → 带会话请求）
 *   - 管理端：进程内起真实 productionRouter，只把鉴权换成注入的超管身份
 *             （沿用 deploy/probe-admin-mail.js 的既有做法）
 *
 * 其余（仓储、SQL、mapRow、路由处理函数）全部是线上那一份。
 *
 * 用法：node deploy/verify-effective-status.js
 */

const crypto = require('node:crypto')
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
const { STATUS } = require(path.join(APP, 'server/services/recharge-state'))

const PROD_PORT = Number(env.PORT || process.env.PORT || 3000)
const pool = new Pool({ connectionString: env.DATABASE_URL })
const redis = new Redis(env.REDIS_URL, { lazyConnect: true })
const repo = new ProductionRepository(pool)
const accounts = new AccountService(repo, {}, redis, { redisPrefix: env.REDIS_KEY_PREFIX || 'pix' })

let pass = 0
let fail = 0
function check(label, ok, extra) {
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}

// ------------------------------------------------------- 真实 HTTP（商户端）

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
    get(name) { return store.get(name) || '' },
    header() { return [...store].map(([k, v]) => `${k}=${v}`).join('; ') }
  }
}

function request(port, method, urlPath, { body, jar, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? new URLSearchParams(body).toString() : null
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: `/apis${urlPath}`,
      headers: Object.assign(
        payload ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) } : {},
        jar && jar.header() ? { Cookie: jar.header() } : {},
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

/** 验证码是 SVG，文字直接写在 <text> 节点里 */
const solveCaptcha = svg => {
  const b64 = String(svg || '').split(',')[1] || ''
  const text = Buffer.from(b64, 'base64').toString('utf8')
  return [...text.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(m => m[1]).join('')
}

const csrfOf = jar => jar.get('pix_csrf') || jar.get('csrf') || ''

// --------------------------------------------------- 进程内真实路由（管理端）

const fakeAuth = {
  middleware() {
    return (req, _res, next) => {
      req.pixAdmin = { id: 1, username: 'effstatus-probe', role: 'superadmin' }
      next()
    }
  }
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/apis${urlPath}` }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(data) } catch (_e) { /* 保留原文 */ }
        resolve({ status: res.statusCode, json, raw: data })
      })
    }).on('error', reject)
  })
}

// --------------------------------------------------------------------- 主流程

async function main() {
  await redis.connect()

  const app = express()
  app.use(express.urlencoded({ extended: true }))
  app.use(express.json())
  // 线上是 app.use('/apis', productionRouter(...))（见 server/register-production-api.js），
  // 路由自身不含前缀 —— 这里要自己补上，否则全部 404。
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

  const uname = `effprobe${crypto.randomInt(100000, 999999)}`
  const password = 'EffProbe12345'
  let userId = null
  let liveId = null
  let zombieId = null

  try {
    // 造一个商户 + 两张订单：一张真的还在有效期，一张已过点但 status 仍是 0
    const { hashPassword } = require(path.join(APP, 'server/lib/password'))
    const packId = (await pool.query('SELECT id FROM packages ORDER BY id LIMIT 1')).rows[0].id
    userId = (await pool.query(
      `INSERT INTO users(username,password_hash,nickname,email,email_verified,status,package_id,char_balance,char_used)
       VALUES($1,$2,$1,$3,false,1,$4,0,0) RETURNING id`,
      [uname, await hashPassword(password), `${uname}@effprobe.test`, packId]
    )).rows[0].id

    const mkOrder = async (tag, amount, expires, created) => (await pool.query(
      `INSERT INTO recharges(order_number,user_id,kind,payment_type,original_amount,discount_amount,
         paid_amount,surcharge_amount,chars,status,expires_at,created_at,idempotency_key)
       VALUES($1,$2,'characters','usdt-trc20',$3,0,$3,0,1000,0,
              now()+$4::interval, now()+$5::interval, $6) RETURNING id`,
      [`EFFP${Date.now()}${tag}`, userId, amount, expires, created, `effprobe:${uname}:${tag}`]
    )).rows[0].id

    liveId = await mkOrder('L', '88.101', '+25 minutes', '-10 minutes')
    zombieId = await mkOrder('Z', '88.202', '-1 hour', '-2 hours')

    console.log('=== 0. 前置：两张订单的库内真实状态 ===')
    const raw = (await pool.query(
      `SELECT order_number, status, to_char(expires_at,'MM-DD HH24:MI:SS') AS expires,
              (expires_at <= now()) AS passed
         FROM recharges WHERE id = ANY($1::bigint[]) ORDER BY id`, [[liveId, zombieId]]
    )).rows
    console.log('  ' + JSON.stringify(raw))
    check('两张订单库内 status 都是 0（惰性过期未落状态）',
      raw.every(r => Number(r.status) === 0), raw.map(r => r.status))
    check('一张未过点、一张已过点', raw[0].passed === false && raw[1].passed === true)

    // ───────────────── 一、商户端：打线上真实服务 ─────────────────
    // 刻意不用进程内实例：商户端鉴权（验证码 + 会话）是真实可走的，
    // 直接打 127.0.0.1:$PROD_PORT 就是 100% 线上那一套。
    console.log('\n=== 1. 商户端（真实 HTTP：验证码 → 登录 → 带会话请求，打到线上服务）===')
    const jar = makeJar()
    const cap = await request(PROD_PORT, 'GET', '/user/captcha', { jar })
    const login = await request(PROD_PORT, 'POST', '/login', {
      jar,
      body: {
        username: uname,
        password,
        imageId: cap.json && cap.json.imageId,
        imageCode: solveCaptcha(cap.json && cap.json.image)
      }
    })
    check('商户登录成功', login.status === 200, { status: login.status, body: login.text.slice(0, 120) })

    const listAll = await request(PROD_PORT, 'GET', '/userRecharge/getUserRecharge?page=1&rows=50', { jar })
    const all = (listAll.json && listAll.json.rows) || []
    console.log('  不带筛选返回 ' + all.length + ' 条: '
      + JSON.stringify(all.map(r => ({ 单号: r.orderNum, 原始: r.status, 有效: r.effectiveStatus }))))
    check('不带筛选：两条都返回（有效状态只影响展示，不隐藏历史订单）', all.length === 2, all.length)
    const byId = Object.fromEntries(all.map(r => [String(r.id), r]))
    check('有效期内的那单 effectiveStatus=0（待支付）',
      byId[String(liveId)] && Number(byId[String(liveId)].effectiveStatus) === STATUS.PENDING,
      byId[String(liveId)])
    check('已过点的那单 effectiveStatus=2（已过期），原始 status 仍是 0',
      byId[String(zombieId)] && Number(byId[String(zombieId)].effectiveStatus) === STATUS.EXPIRED
        && Number(byId[String(zombieId)].status) === STATUS.PENDING,
      byId[String(zombieId)])

    const q0 = await request(PROD_PORT, 'GET', '/userRecharge/getUserRecharge?page=1&rows=50&status=0', { jar })
    const r0 = (q0.json && q0.json.rows) || []
    console.log('  筛选 status=0 → ' + r0.length + ' 条: ' + JSON.stringify(r0.map(r => r.orderNum)))
    check('按「未支付」筛选只返回那 1 张真正还能付款的单',
      r0.length === 1 && String(r0[0].id) === String(liveId),
      r0.map(r => ({ id: r.id, orderNum: r.orderNum })))

    const q2 = await request(PROD_PORT, 'GET', '/userRecharge/getUserRecharge?page=1&rows=50&status=2', { jar })
    const r2 = (q2.json && q2.json.rows) || []
    console.log('  筛选 status=2 → ' + r2.length + ' 条: ' + JSON.stringify(r2.map(r => r.orderNum)))
    check('按「已过期」筛选能找到僵尸单（修复前这里是 0 条）',
      r2.length === 1 && String(r2[0].id) === String(zombieId),
      r2.map(r => ({ id: r.id, orderNum: r.orderNum })))

    // ───────────────── 二、管理端：真实路由 + 注入超管身份 ─────────────────
    console.log('\n=== 2. 管理端 /admin/recharges（注入超管身份，路由代码是线上那份）===')
    const list = await getJson(port, '/admin/recharges?page=1&rows=200')
    check('HTTP 200', list.status === 200, list.status)
    const rows = (list.json && list.json.rows) || []
    check('返回了订单', rows.length > 0, rows.length)

    const real = rows.filter(r => ['HP1790182973367652', 'HP1790258903678251', 'HP1790282720576125']
      .includes(r.orderNum))
    console.log('  三张真实订单: ' + JSON.stringify(real.map(r => ({
      单号: r.orderNum, 原始: r.status, 有效: r.effectiveStatus, 已付款: r.paidAt
    }))))
    check('三张真实订单都下发了 effectiveStatus 字段',
      real.length === 3 && real.every(r => r.effectiveStatus !== undefined), real.length)
    check('三张真实订单的有效状态都是 2（已过期）',
      real.length === 3 && real.every(r => Number(r.effectiveStatus) === STATUS.EXPIRED),
      real.map(r => r.effectiveStatus))
    check('原始 status 字段依然如实返回 0（有效状态是叠加的，不篡改原始值）',
      real.length === 3 && real.every(r => Number(r.status) === STATUS.PENDING),
      real.map(r => r.status))
    check('三张真实订单都未付款', real.every(r => !r.paidAt), real.map(r => r.paidAt))

    console.log('\n=== 3. 管理端 /admin/stats（待支付口径）===')
    const stats = await getJson(port, '/admin/stats')
    check('HTTP 200', stats.status === 200, stats.status)
    const s = stats.json || {}
    console.log('  ' + JSON.stringify({
      recharge_pending: s.rechargePending,
      recharge_pending_stale: s.rechargePendingStale,
      recharge_sum: s.rechargeSum
    }))
    check('下发了有效待支付统计 rechargePending', s.rechargePending !== undefined)
    check('下发了惰性过期统计 rechargePendingStale', s.rechargePendingStale !== undefined)
    // 与独立 SQL 对照：证明接口算的就是这个口径，而不是碰巧相等
    const expect = (await pool.query(
      `SELECT count(*) FILTER (WHERE status=0 AND expires_at > now())::int AS pending,
              count(*) FILTER (WHERE status=0 AND expires_at <= now())::int AS stale
         FROM recharges`)).rows[0]
    check('有效待支付与独立 SQL 计算一致',
      Number(s.rechargePending) === expect.pending, { api: s.rechargePending, sql: expect.pending })
    check('惰性过期与独立 SQL 计算一致',
      Number(s.rechargePendingStale) === expect.stale, { api: s.rechargePendingStale, sql: expect.stale })

    // 此刻库里唯一的"真待支付"应当只有本次探针造的那张活单
    const pendingOrders = (await pool.query(
      `SELECT order_number FROM recharges WHERE status=0 AND expires_at > now()`)).rows
    console.log('  全库仅有的待支付订单: ' + JSON.stringify(pendingOrders.map(r => r.order_number)))
    check('有效待支付只有 1 张 —— 就是本次探针新造的活单，三张真实订单一张都没被算进去',
      Number(s.rechargePending) === 1 && pendingOrders.length === 1
        && pendingOrders[0].order_number.startsWith('EFFP'),
      pendingOrders.map(r => r.order_number))

    // 三张真实订单对"有效待支付"的贡献必须是 0
    const realPending = (await pool.query(
      `SELECT count(*)::int AS n FROM recharges
        WHERE order_number = ANY($1) AND status=0 AND expires_at > now()`,
      [['HP1790182973367652', 'HP1790258903678251', 'HP1790282720576125']])).rows[0].n
    check('三张真实订单对「有效待支付」的贡献为 0（修复前它们贡献 3）', realPending === 0, realPending)

    // 反向：探针的活单在后台列表里必须显示为待支付 —— 证明不是"一律显示已过期"
    const probeLive = rows.find(r => String(r.id) === String(liveId))
    check('后台列表里探针的活单 effectiveStatus=0（待支付），没有被误判成过期',
      probeLive && Number(probeLive.effectiveStatus) === STATUS.PENDING,
      probeLive && { 单号: probeLive.orderNum, 原始: probeLive.status, 有效: probeLive.effectiveStatus })
    const probeZombie = rows.find(r => String(r.id) === String(zombieId))
    check('后台列表里探针的僵尸单 effectiveStatus=2（已过期）',
      probeZombie && Number(probeZombie.effectiveStatus) === STATUS.EXPIRED,
      probeZombie && { 单号: probeZombie.orderNum, 原始: probeZombie.status, 有效: probeZombie.effectiveStatus })

    check('已支付金额仍为 0（Shadow 未入账）', Number(s.rechargeSum) === 0, s.rechargeSum)

    console.log('\n=== 4. 线上真实数据未被本次验证改动 ===')
    const money = (await pool.query(
      `SELECT (SELECT count(*) FILTER (WHERE char_balance <> 0) FROM users) AS nonzero,
              (SELECT coalesce(sum(char_balance),0) FROM users) AS balance,
              (SELECT count(*) FROM char_ledger) AS ledger,
              (SELECT count(*) FROM recharges WHERE status=1 OR paid_at IS NOT NULL) AS paid`
    )).rows[0]
    check('没有用户余额非零', Number(money.nonzero) === 0, money.nonzero)
    check('字符余额合计为 0', Number(money.balance) === 0, money.balance)
    check('char_ledger 无流水', Number(money.ledger) === 0, money.ledger)
    check('没有订单被置为已支付', Number(money.paid) === 0, money.paid)

    const exc = (await pool.query(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE status='open') AS open,
              count(*) FILTER (WHERE recharge_id IS NOT NULL) AS bound
         FROM recharge_exceptions`)).rows[0]
    check('50.000 USDT 那笔仍在异常池且未被绑定到任何订单',
      Number(exc.total) === 3 && Number(exc.open) === 3 && Number(exc.bound) === 0, exc)
  } finally {
    if (userId) {
      await pool.query(
        'DELETE FROM recharge_amount_reservations WHERE recharge_id IN (SELECT id FROM recharges WHERE user_id=$1)',
        [userId]).catch(() => {})
      await pool.query('DELETE FROM recharge_exceptions WHERE recharge_id IN (SELECT id FROM recharges WHERE user_id=$1)', [userId]).catch(() => {})
      await pool.query('DELETE FROM recharges WHERE user_id=$1', [userId]).catch(() => {})
      await pool.query('DELETE FROM users WHERE id=$1', [userId]).catch(() => {})
      console.log('\n  已清理探针商户与两张探针订单')
    }
    server.close()
    await pool.end()
    await redis.quit().catch(() => {})
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail) process.exitCode = 1
}

main().catch(err => { console.error('验证脚本异常：', (err && err.stack) || err); process.exit(1) })
