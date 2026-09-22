'use strict'

/**
 * 邮件通道端到端验收（在服务器上对着真实服务跑）。
 *
 * 覆盖四件事，每一件都对应一个真实发生过的故障：
 *   1. 配置能不能从库里读出来 —— 曾经因为读成 `settings.mail.smtp`（嵌套）
 *      而 repo.settings() 返回的是扁平键 `'mail.smtp'`，导致 configured 恒为 false。
 *   2. 真实 SMTP 能不能发出去 —— 曾经线上根本没装 nodemailer。
 *   3. /apis/user/emailCode 还会不会返回 MAIL_NOT_CONFIGURED。
 *   4. 发出的验证码是不是真的落到了 Redis（而不是"接口说成功但没发信"）。
 *
 * 用法（在 /opt/hello-pix 下）：
 *   TO=你的邮箱 node deploy/verify-mail-e2e.js
 *
 * 只读 + 一次真实发信，不改任何配置。
 */

const http = require('http')
const path = require('path')

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000'
const PARSED = new URL(BASE_URL)
const BASE = {
  host: PARSED.hostname,
  port: PARSED.port ? Number(PARSED.port) : 80
}
const TO = String(process.env.TO || '').trim()

const APP = process.env.APP_DIR || '/opt/hello-pix'
const { Mailer, readConfig } = require(path.join(APP, 'server/lib/mailer'))

let pass = 0, fail = 0
function check(label, ok, extra) {
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}${extra ? '  → ' + JSON.stringify(extra) : ''}`) }
}
function mask(v) {
  const s = String(v || '')
  if (!s) return '(空)'
  return s.length <= 6 ? '***' : s.slice(0, 3) + '***' + s.slice(-3)
}

function request(method, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = body ? new URLSearchParams(body).toString() : null
    const req = http.request({
      ...BASE, method, path: urlPath,
      headers: Object.assign(
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        cookie ? { Cookie: cookie } : {},
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}
      )
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(data) } catch (_e) { /* 非 JSON 就保留原文 */ }
        resolve({ status: res.statusCode, json, raw: data, headers: res.headers })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** 图形验证码是内联 SVG，文字就在 <text> 里 —— 这是服务端自己生成的，不是绕过。 */
const solveCaptcha = svg => {
  const base64 = String(svg || '').split(',')[1] || ''
  const text = Buffer.from(base64, 'base64').toString('utf8')
  return [...text.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(m => m[1]).join('')
}
const cookieOf = res => {
  const raw = res.headers['set-cookie'] || []
  return raw.map(c => c.split(';')[0]).join('; ')
}

;(async () => {
  console.log('=== 1. 配置是否真的能从库里读出来（扁平键）===')
  const { Client } = require(path.join(APP, 'node_modules/pg'))
  // 生产用的是 DATABASE_URL / REDIS_URL（不是 PGUSER 那一组），照实际取
  const env = {}
  require('fs').readFileSync('/etc/hello-pix/hello-pix.env', 'utf8').split('\n').forEach(line => {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  })
  const db = new Client({ connectionString: env.DATABASE_URL })
  await db.connect()
  const row = (await db.query("SELECT value FROM app_settings WHERE key='mail.smtp'")).rows[0]
  const flat = { 'mail.smtp': row ? row.value : {} }
  const cfg = readConfig(flat)
  console.log('    库里的配置（口令打码）：')
  const stored = (row && row.value) || {}
  console.log('      host =', stored.host || '(空)')
  console.log('      port =', stored.port, '| secure =', stored.secure)
  console.log('      user =', stored.user || '(空)')
  console.log('      pass =', mask(stored.pass))
  console.log('      from =', stored.from || '(空)')
  check('readConfig 从扁平键读到了配置', cfg.configured, { missing: cfg.missing })
  check('口令已配置', Boolean(stored.pass))
  check('发件地址已配置', Boolean(stored.from))
  if (!cfg.configured) {
    console.log('\n  ⚠ 配置不完整（缺少：' + cfg.missing.join('、') + '）——')
    console.log('    后面的步骤会跑，但预期会看到 503。补齐配置后再跑一次即为验收。')
  }

  console.log('\n=== 2. 真实 SMTP 发信 ===')
  if (!cfg.configured) {
    console.log('  跳过（配置不完整）')
  } else if (!TO) {
    console.log('  跳过（未提供 TO=收件邮箱）')
  } else {
    const mailer = new Mailer({
      async settings() { return flat }
    })
    const r = await mailer.sendTest(TO)
    check('sendTest 成功', r.ok, r)
    console.log('    stage =', r.stage, '| code =', r.code)
    console.log('    msg   =', r.msg)
    if (r.messageId) console.log('    messageId =', r.messageId)
    if (r.detail) console.log('    detail =', r.detail)
  }

  console.log('\n=== 3. /apis/user/emailCode 不再返回 MAIL_NOT_CONFIGURED ===')
  const email = TO || 'acceptance@example.com'
  const cap = await request('GET', '/apis/user/captcha')
  check('取得图形验证码', cap.status === 200 && cap.json && cap.json.imageId,
    { status: cap.status })
  const code = solveCaptcha(cap.json && cap.json.image)
  const sent = await request('POST', '/apis/user/emailCode', {
    email, scene: 'register', imageId: cap.json.imageId, imageCode: code
  }, cookieOf(cap))
  console.log('    HTTP', sent.status, '|', JSON.stringify(sent.json))
  check('接口不再返回 503', sent.status !== 503, { status: sent.status })
  check('接口不再返回 MAIL_NOT_CONFIGURED',
    !(sent.json && sent.json.code === 'MAIL_NOT_CONFIGURED'), sent.json)
  check('接口返回发送成功', sent.status === 200 && sent.json && sent.json.ok === true, sent.json)

  console.log('\n=== 4. 验证码真的落到了 Redis（不是"接口说成功但没发信"）===')
  const Redis = require(path.join(APP, 'node_modules/ioredis'))
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true })
  await redis.connect()
  // 不猜前缀：直接按模式扫真实键名（前缀由 REDIS_KEY_PREFIX 决定，可能是空也可能是 'pix:'）
  const pattern = `*verify:code:register:${email.toLowerCase()}`
  const found = await redis.keys(pattern)
  const redisKey = found[0] || pattern
  console.log('    键模式:', pattern)
  if (!found.length) console.log('    实际未找到任何匹配键')
  const issued = found.length ? await redis.get(redisKey) : null
  check('Redis 里存在该邮箱的验证码', Boolean(issued), { key: redisKey })
  if (issued) {
    check('验证码是 6 位数字', /^\d{6}$/.test(issued), { value: issued })
    const ttl = await redis.ttl(redisKey)
    check('验证码有 10 分钟有效期', ttl > 0 && ttl <= 600, { ttl })
  }
  await redis.quit()
  await db.end()

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
})().catch(e => {
  console.error('验收脚本异常：', e && e.stack || e)
  process.exit(1)
})
