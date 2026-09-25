'use strict'

/**
 * RC-03 验收前置：引擎预检 + 准备验收商户。
 *
 * ## 为什么必须先做这一步
 *
 * 生产上 9 个引擎只有 deepseek / gpt 接通，而**现有测试商户全在「基础版」**
 * （只含 google + niutrans，两个都没接通）。直接拿它们去跑 Windows 验收，
 * 翻译会稳定地撞 403「当前套餐未包含此通道」——
 * 现象看起来跟「DOM 选择器失效」一模一样，但根因完全不同，
 * 会在错误的方向上浪费大量时间。所以先把前提坐实。
 *
 * 本脚本做两件事：
 *   1. **引擎预检**：用真实 HTTP 打一次 /translate/run，确认引擎真的能翻
 *   2. **准备验收商户**：建一个「专业版 + 有字符余额」的商户，供 Windows 客户端登录
 *
 * 用法：
 *   node deploy/rc03-prep-merchant.js              # 预检 + 建商户
 *   node deploy/rc03-prep-merchant.js --check      # 只做引擎预检（不改任何数据）
 *   node deploy/rc03-prep-merchant.js --cleanup <商户名>
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const APP = process.env.APP_DIR || '/opt/hello-pix'
const PORT = Number(process.env.PORT || 3000)
const PASSWORD = 'Rc03Accept12345'
const SEED_CHARS = 200000

let pass = 0, fail = 0
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
    get(n) { return store.get(n) || '' }
  }
}

function request(method, urlPath, { body, jar, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? new URLSearchParams(body).toString() : null
    const req = http.request({
      host: '127.0.0.1', port: PORT, method, path: '/apis' + urlPath,
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
        try { json = JSON.parse(data) } catch (_e) { /* 原文 */ }
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

function connectDb() {
  const env = Object.fromEntries(
    fs.readFileSync('/etc/hello-pix/hello-pix.env', 'utf8')
      .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
  const { Client } = require(path.join(APP, 'node_modules/pg'))
  const db = new Client({ connectionString: env.DATABASE_URL })
  return db.connect().then(() => db)
}

/** 找一个「套餐里真的有已接通引擎」的套餐 */
async function findUsablePackage(db) {
  return (await db.query(`
    SELECT p.id, p.title,
           (SELECT count(*) FROM package_engines pe JOIN engines e ON e.id=pe.engine_id
             WHERE pe.package_id=p.id AND e.wired AND e.enabled)::int AS wired_count,
           (SELECT string_agg(pe.engine_id, ',' ORDER BY pe.engine_id)
              FROM package_engines pe JOIN engines e ON e.id=pe.engine_id
             WHERE pe.package_id=p.id AND e.wired AND e.enabled) AS wired_engines
      FROM packages p
     ORDER BY wired_count DESC, p.id
     LIMIT 1`)).rows[0]
}

async function cleanup(db, username) {
  const found = await db.query('SELECT id FROM users WHERE username=$1', [username])
  if (!found.rows.length) { console.log(`  没有找到商户 ${username}`); return }
  const uid = found.rows[0].id
  await db.query('DELETE FROM translate_logs WHERE user_id=$1', [uid])
  await db.query('DELETE FROM translation_reservations WHERE user_id=$1', [uid])
  await db.query('DELETE FROM messages WHERE user_id=$1', [uid])
  await db.query('DELETE FROM customers WHERE user_id=$1', [uid])
  await db.query('DELETE FROM recharges WHERE user_id=$1', [uid])
  await db.query('DELETE FROM users WHERE id=$1', [uid])
  console.log(`  已清理商户 ${username} 及其流水`)
}

async function main() {
  const db = await connectDb()
  try {
    if (process.argv[2] === '--cleanup') return cleanup(db, process.argv[3]), 0

    const checkOnly = process.argv[2] === '--check'

    console.log('=== 0. 生产引擎接线现状 ===')
    const engines = (await db.query('SELECT id, name, enabled, wired FROM engines ORDER BY id')).rows
    const wired = engines.filter(e => e.wired && e.enabled)
    for (const e of engines) {
      console.log(`  ${e.wired ? '✓' : '★'} ${e.id.padEnd(10)} ${e.name.padEnd(16)} enabled=${e.enabled} wired=${e.wired}`)
    }
    console.log('')
    check('至少有一个已接通引擎', wired.length > 0, wired.map(e => e.id))
    if (!wired.length) { console.log('\n  没有任何已接通引擎，后续验证无意义，中止。'); return 1 }

    const pkg = await findUsablePackage(db)
    console.log(`  可用的最好套餐： #${pkg.id} ${pkg.title}  已接通=${pkg.wired_count} (${pkg.wired_engines})`)
    check('存在含已接通引擎的套餐', pkg.wired_count > 0, pkg)

    if (checkOnly) {
      console.log('\n  --check 模式：只做只读预检，未改动任何数据。')
      console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
      return fail ? 1 : 0
    }

    console.log('\n=== 1. 创建验收商户 ===')
    const username = `rc03win${crypto.randomInt(100000, 999999)}`
    const created = await db.query(
      `INSERT INTO users(username,password_hash,nickname,email,email_verified,status,
         package_id,char_balance,char_used,translate_count,remarks)
       VALUES($1,$2,$1,$3,false,1,$4,$5,0,0,'RC-03 Windows 验收专用')
       RETURNING id`,
      [username, await require(path.join(APP, 'server/lib/password')).hashPassword(PASSWORD),
        `${username}@rc03.test`, pkg.id, SEED_CHARS])
    const userId = created.rows[0].id
    console.log(`  ${username}  id=${userId}  套餐=${pkg.title}  初始余额=${SEED_CHARS}`)
    check('验收商户已创建', !!userId)

    console.log('\n=== 2. 真实 HTTP 登录 ===')
    const jar = makeJar()
    const cap = await request('GET', '/user/captcha', { jar })
    const login = await request('POST', '/login', {
      jar,
      body: { username, password: PASSWORD,
        imageId: cap.json && cap.json.imageId,
        imageCode: solveCaptcha(cap.json && cap.json.image) }
    })
    check('登录成功', login.status === 200, { status: login.status, body: login.text.slice(0, 140) })

    console.log('\n=== 3. 引擎预检：真实翻译一次 ===')
    const enginesRes = await request('GET', '/translate/engines', { jar })
    const active = (enginesRes.json && enginesRes.json.activeEngine) || ''
    console.log(`  套餐当前通道 activeEngine=${active}`)
    check('解析出了可用通道', !!active, enginesRes.json)

    const SAMPLE = 'Hello, I would like to confirm the delivery date of my order.'
    const rid = crypto.randomBytes(16).toString('hex')
    const tr = await request('POST', '/translate/run', {
      jar,
      headers: { 'Idempotency-Key': rid, 'X-CSRF-Token': (/pix_csrf=([^;]+)/.exec(jar.header()) || [])[1] || '' },
      body: { text: SAMPLE, from: 'auto', to: 'zh', engine: active, requestId: rid }
    })
    const tj = tr.json || {}
    console.log(`  HTTP ${tr.status}  engine=${tj.engine}  chars=${tj.chars}  cached=${tj.cached}`)
    console.log(`  原文「${SAMPLE}」`)
    console.log(`  译文「${tj.translation || ''}」`)
    check('翻译返回 200', tr.status === 200, { status: tr.status, body: tr.text.slice(0, 200) })
    check('拿到了真实译文', !!(tj.translation && tj.translation.length), tj.translation)
    check('译文与原文不同（确实是翻译而非原样返回）',
      !!tj.translation && tj.translation !== SAMPLE, tj.translation)
    check('扣费字符数 > 0', Number(tj.chars) > 0, tj.chars)

    // 注意：重试**必须同样带上 CSRF**，否则会被 CSRF 中间件拦成 403 ——
    // 那样测的是 CSRF 而不是幂等，会得到一个"看起来通过"的假结果。
    const csrf2 = (/pix_csrf=([^;]+)/.exec(jar.header()) || [])[1] || ''
    const seedBalance = (await db.query(
      'SELECT char_balance FROM users WHERE id=$1', [userId])).rows[0].char_balance

    console.log('\n=== 4. 幂等：同一 requestId 再打一次，不得重复扣费 ===')
    const tr2 = await request('POST', '/translate/run', {
      jar,
      headers: { 'Idempotency-Key': rid, 'X-CSRF-Token': csrf2 },
      body: { text: SAMPLE, from: 'auto', to: 'zh', engine: active, requestId: rid }
    })
    const tj2 = tr2.json || {}
    console.log(`  HTTP ${tr2.status}  chars=${tj2.chars}  cached=${tj2.cached}  ` +
      `译文与首次一致=${tj2.translation === tj.translation}`)
    // 真正的幂等断言：HTTP 必须 200（不是被 CSRF/限流拦掉），
    // 且第二次不能再产生扣费字符
    check('重复请求返回 200（没有被 CSRF/限流拦掉，确实打到了业务逻辑）',
      tr2.status === 200, { status: tr2.status, body: tr2.text.slice(0, 160) })
    // 关键：幂等命中时服务端**原样回放**首次响应（core-service 里
    // `if (reservation.responseJson) return reservation.responseJson`），
    // 所以响应里的 chars 仍是首次那个数 —— 它不代表又扣了一次。
    // 真正该断言的是**账本**：余额、已用、流水条数都不能再动。
    const afterRetry = (await db.query(
      'SELECT char_balance, char_used, translate_count FROM users WHERE id=$1', [userId])).rows[0]
    const logCount = (await db.query(
      'SELECT count(*)::int AS n FROM translate_logs WHERE user_id=$1', [userId])).rows[0].n
    check('重复请求后余额未变（账本没被再扣一次）',
      Number(afterRetry.char_balance) === Number(seedBalance),
      { before: seedBalance, after: afterRetry.char_balance })
    check('重复请求后 translate_logs 仍只有 1 条', logCount === 1, logCount)
    check('重复请求回放的 chars 仍为首次值（说明是原样回放，不是新扣费）',
      Number(tj2.chars) === Number(tj.chars), { first: tj.chars, replay: tj2.chars })
    check('重复请求返回同一译文', tj2.translation === tj.translation,
      { first: tj.translation, second: tj2.translation })

    console.log('\n=== 5. 落库核对 ===')
    const after = (await db.query(
      'SELECT char_balance, char_used, translate_count FROM users WHERE id=$1', [userId])).rows[0]
    const logs = (await db.query(
      `SELECT id, engine_id, source_language, target_language, chars, cached, duration_ms, snippet
         FROM translate_logs WHERE user_id=$1 ORDER BY id`, [userId])).rows
    console.log(`  余额 ${SEED_CHARS} → ${after.char_balance}   已用 ${after.char_used}   次数 ${after.translate_count}`)
    check('余额已正确扣减', Number(after.char_balance) < SEED_CHARS,
      { before: SEED_CHARS, after: after.char_balance })
    check('已用字符与扣费一致', Number(after.char_used) === Number(tj.chars),
      { used: after.char_used, billed: tj.chars })
    check('translate_logs 写了恰好 1 条（幂等生效，没有重复）', logs.length === 1, logs.length)
    if (logs.length) {
      console.log(`  流水 #${logs[0].id} ${logs[0].engine_id} ${logs[0].source_language}→${logs[0].target_language} ` +
        `chars=${logs[0].chars} ${logs[0].duration_ms}ms`)
      console.log(`       「${logs[0].snippet}」`)
    }

    console.log('\n' + '═'.repeat(68))
    console.log('  Windows 客户端登录用凭据')
    console.log('═'.repeat(68))
    console.log(`  用户名    ${username}`)
    console.log(`  密码      ${PASSWORD}`)
    console.log(`  套餐      ${pkg.title}`)
    console.log(`  字符余额  ${after.char_balance}`)
    console.log(`  默认通道  ${active}`)
    console.log('═'.repeat(68))
    console.log(`  清理命令： node deploy/rc03-prep-merchant.js --cleanup ${username}`)
    console.log('')
    console.log(`结果：${pass} 通过 / ${fail} 失败`)
    return fail ? 1 : 0
  } finally {
    await db.end()
  }
}

main()
  .then(code => { process.exitCode = code || 0 })
  .catch(e => { console.error('异常:', (e && e.stack) || e); process.exitCode = 1 })
