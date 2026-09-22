'use strict'

/**
 * 后台两个邮件相关接口的真实响应探针。
 *
 * 为什么单独写：管理端接口要超管会话才能调，而这里要验证的**不是鉴权**
 * —— 是「页面拿到的数据对不对」。所以用真实的 productionRouter + 真实数据库，
 * 只把鉴权那一层换成注入的 admin 身份，其余原样。
 *
 * 特别要确认两件事：
 *   1. /admin/verify 的接口状态是否由真实配置推导（而不是写死的"未接通"）
 *   2. /admin/mail 与 /admin/verify 是否只回口令掩码，绝不明文
 *
 * 用法：node deploy/probe-admin-mail.js
 */

const fs = require('fs')
const http = require('http')
const path = require('path')

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

const pool = new Pool({ connectionString: env.DATABASE_URL })
const redis = new Redis(env.REDIS_URL, { lazyConnect: true })
const repo = new ProductionRepository(pool)
const accounts = new AccountService(repo, {}, redis, { redisPrefix: env.REDIS_KEY_PREFIX || 'pix' })

// 只替换鉴权：真实中间件要超管会话，这里原样占位并注入一个超管身份。
// 其余（仓储、账号服务、限流、路由处理函数）全部是线上那一份。
const fakeAuth = {
  middleware() {
    return (req, _res, next) => {
      req.pixAdmin = { id: 1, username: 'probe', role: 'superadmin' }
      next()
    }
  }
}

let router = null
function buildRouter() {
  return productionRouter({
    repository: repo,
    auth: fakeAuth,
    // 路由构造时就会用 core.redis 建限流器，必须给真实的 redis
    core: { redis },
    customers: {},
    accounts,
    // 这里全是 GET，CSRF 不是被测对象，放行即可
    security: { csrf: (_req, _res, next) => next() }
  })
}

const app = express()
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, res => {
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

let pass = 0, fail = 0
function check(label, ok, extra) {
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}

;(async () => {
  await redis.connect()
  // 路由构造时就会建限流器，需要已连接的 redis —— 所以放在 connect 之后
  app.use(buildRouter())
  const server = app.listen(0)
  const port = server.address().port

  console.log('=== GET /apis/admin/verify（「验证码接口」页的数据源）===')
  const verify = await get(port, '/admin/verify')
  check('HTTP 200', verify.status === 200, verify.status)
  const email = ((verify.json || {}).rows || []).find(r => r.id === 'email') || {}
  console.log('    邮箱通道行：')
  console.log('      当前实现 =', email.providerName)
  console.log('      接口     =', email.wiredText, '(wired =', email.wired + ')')
  console.log('      配置     =', email.hasKey ? '已填' : '空')
  console.log('      SMTP     =', email.smtpHost + ':' + email.smtpPort, '| SSL =', email.smtpSecure, '| 账号 =', email.smtpUser)
  console.log('      口令     =', email.smtpPass)
  console.log('      note     =', verify.json.note)
  check('接口状态为「已接通」', email.wiredText === '已接通', email.wiredText)
  check('wired 为 true', email.wired === true, email.wired)
  check('当前实现显示 SMTP（已接通）', email.providerName === 'SMTP（已接通）', email.providerName)
  check('配置显示「已填」', email.hasKey === true, email.hasKey)
  check('smtpReady 为 true', verify.json.smtpReady === true, verify.json.smtpReady)
  check('口令只回掩码，不回明文', email.smtpPass === '********', email.smtpPass)
  check('返回体里没有明文 Key', !JSON.stringify(verify.json).includes('re_'), '发现 re_ 前缀')

  console.log('\n=== GET /apis/admin/mail（「邮件服务」页的数据源）===')
  const mail = await get(port, '/admin/mail')
  check('HTTP 200', mail.status === 200, mail.status)
  const m = mail.json || {}
  console.log('    host =', m.host, '| port =', m.port, '| secure =', m.secure)
  console.log('    user =', m.user, '| from =', m.from, '| fromName =', m.fromName)
  console.log('    pass =', m.pass, '| configured =', m.configured, '| missing =', JSON.stringify(m.missing))
  check('configured 为 true', m.configured === true, m.configured)
  check('missing 为空', Array.isArray(m.missing) && m.missing.length === 0, m.missing)
  check('口令只回掩码', m.pass === '********', m.pass)
  check('host/from 正确回显', m.host === 'smtp.resend.com' && m.from === 'noreply@pixfanyi.com', { host: m.host, from: m.from })
  check('返回体里没有明文 Key', !JSON.stringify(mail.json).includes('re_'), '发现 re_ 前缀')

  server.close()
  await redis.quit()
  await pool.end()

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
})().catch(e => {
  console.error('探针异常：', (e && e.stack) || e)
  process.exit(1)
})
