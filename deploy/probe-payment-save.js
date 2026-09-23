'use strict'

/**
 * 收款方式保存链路验证（在服务器上对着真实服务跑）。
 *
 * 不修改任何配置：读出当前的 paymentChannels，用**真实的 encodeForm**
 * 编码后原样 POST 回去，断言成功且数据未变。
 *
 * 关键点是**用真源码**而不是在探针里重写一遍编码逻辑 ——
 * 否则测的是探针自己的实现，改坏了前端也发现不了。
 * 所以这里读取 deploy/encode-form.js（从 src/utils/encode-form.js 原样拷来），
 * 去掉 export 后求值。
 *
 * 同时带一个对照组：用旧写法（对象数组 join 逗号）发同样的数据，
 * 断言服务端确实会返回 BAD_JSON —— 证明这次修的是真问题。
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

// 用真实源码里的 encodeForm
const ENC_PATH = path.join(__dirname, 'encode-form.js')
const encSource = fs.readFileSync(ENC_PATH, 'utf8')
  .replace(/^export\s+default\s+.*$/gm, '')
  .replace(/^export\s+/gm, '')
const encodeForm = new Function(encSource + '\nreturn encodeForm')()

const pool = new Pool({ connectionString: env.DATABASE_URL })
const redis = new Redis(env.REDIS_URL, { lazyConnect: true })
const repo = new ProductionRepository(pool)
const accounts = new AccountService(repo, {}, redis, { redisPrefix: env.REDIS_KEY_PREFIX || 'pix' })

const fakeAuth = {
  middleware() {
    return (req, _res, next) => {
      req.pixAdmin = { id: 1, username: 'probe', role: 'superadmin' }
      next()
    }
  }
}

let pass = 0, fail = 0
function check(label, ok, extra) {
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}

function call(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : body
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: Object.assign(
        { 'Content-Type': 'application/x-www-form-urlencoded' },
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}
      )
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(data) } catch (_e) { /* 保留原文 */ }
        resolve({ status: res.statusCode, json, raw: data })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

;(async () => {
  await redis.connect()
  const { sendError } = require(path.join(APP, 'server/lib/http'))
  const app = express()
  app.use(express.urlencoded({ extended: true }))
  app.use(productionRouter({
    repository: repo, auth: fakeAuth, core: { redis }, customers: {}, accounts,
    security: { csrf: (_req, _res, next) => next() }
  }))
  // 必须挂上真实应用的错误处理中间件，否则 Express 默认错误页是 HTML，
  // 探针拿到的就不是 {code:'BAD_JSON'} 而是 null —— 对照组会假失败
  app.use((err, req, res, next) => sendError(err, req, res, next))
  const server = app.listen(0)
  const port = server.address().port

  console.log('=== 1. 读取当前收款配置 ===')
  const before = await call(port, 'GET', '/admin/settings')
  check('GET /admin/settings 成功', before.status === 200, before.status)
  const channelsBefore = (before.json && before.json.paymentChannels) || []
  console.log('    当前渠道数:', channelsBefore.length)
  channelsBefore.forEach((c, i) => {
    console.log(`      [${i}] id=${c.id} name=${c.name} enabled=${c.enabled} address=${c.address || '(空)'}`)
  })
  check('paymentChannels 是数组', Array.isArray(channelsBefore), typeof channelsBefore)

  console.log('\n=== 2. 对照组：旧写法（对象数组 join 逗号）应当被服务端拒绝 ===')
  const brokenBody = 'paymentChannels=' + encodeURIComponent(channelsBefore.join(','))
  console.log('    旧写法实际发出:', decodeURIComponent(brokenBody).slice(0, 80))
  const brokenRes = await call(port, 'POST', '/admin/settings/save', brokenBody)
  console.log('    HTTP', brokenRes.status, '|', JSON.stringify(brokenRes.json))
  check('旧写法确实返回 BAD_JSON（证明这次修的是真问题）',
    brokenRes.status === 400 && brokenRes.json && brokenRes.json.code === 'BAD_JSON',
    { status: brokenRes.status, code: brokenRes.json && brokenRes.json.code })

  console.log('\n=== 3. 新写法：用真实 encodeForm 编码后原样回存 ===')
  const goodBody = encodeForm({ paymentChannels: channelsBefore })
  console.log('    新写法实际发出:', decodeURIComponent(goodBody).slice(0, 120) + (goodBody.length > 120 ? '…' : ''))
  const goodRes = await call(port, 'POST', '/admin/settings/save', goodBody)
  console.log('    HTTP', goodRes.status, '|', JSON.stringify(goodRes.json))
  check('新写法保存成功', goodRes.status === 200, { status: goodRes.status, body: goodRes.json })
  check('不再返回 BAD_JSON', !(goodRes.json && goodRes.json.code === 'BAD_JSON'), goodRes.json)

  console.log('\n=== 4. 回存后数据未被改动（非破坏性）===')
  const after = await call(port, 'GET', '/admin/settings')
  const channelsAfter = (after.json && after.json.paymentChannels) || []
  check('渠道数与回存前一致', channelsAfter.length === channelsBefore.length,
    { before: channelsBefore.length, after: channelsAfter.length })
  check('内容与回存前逐字段一致',
    JSON.stringify(channelsAfter) === JSON.stringify(channelsBefore),
    { before: channelsBefore, after: channelsAfter })

  console.log('\n=== 5. 带真实地址的往返（不落库，只验证解析与校验通过）===')
  // 用二维码解出的真值做一次「如果保存会怎样」的验证：
  // 先保存当前值，再单独走一遍解析逻辑，确认合法地址不会被误拒
  const { validTronAddress } = require(path.join(APP, 'server/lib/tron-address'))
  const sample = 'TEfCDDuYwYdjCn2WDa7TNWCU9bkBk9EXPX'
  check('样例地址通过服务端校验', validTronAddress(sample), sample)
  const sampleBody = encodeForm({
    paymentChannels: [{ id: 'usdt-trc20', name: 'USDT', network: 'TRC20', address: sample, note: '', enabled: 1 }]
  })
  const parsedBack = JSON.parse(new URLSearchParams(sampleBody).get('paymentChannels'))
  check('含地址的对象数组能被正确编码/解码', parsedBack[0].address === sample, parsedBack)

  server.close()
  await redis.quit()
  await pool.end()
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
})().catch(e => {
  console.error('探针异常：', (e && e.stack) || e)
  process.exit(1)
})
