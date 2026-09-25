'use strict'

/**
 * 消息归档（messages 表）落库验证。
 *
 * ## 背景
 *
 * `messages` 表一直是空的。根因在客户端：`reportClue(body, direction)` 全文
 * 只有 `reportIfPeerChanged()` 一个调用点，而它传的 body 恒为空字符串，
 * 服务端的写入条件 `if (payload.body)` 永远进不去 ——
 * conversations / customers 建得好好的，消息正文一条都不写。
 *
 * 现在客户端在 `scan()` 里对每条真实消息调用 `reportMessage()`，
 * 这个脚本用**线上那一份路由 + 线上数据库**验证服务端这一段接得住：
 * 真的写进 messages、方向/溯源字段正确、重复上报不会写两遍。
 *
 * 用法：node deploy/probe-messages.js
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
const { CustomerRepository } = require(path.join(APP, 'server/repositories/customer-repository'))
const { CustomerIdentityService } = require(path.join(APP, 'server/services/customer-identity-service'))
const { AccountService } = require(path.join(APP, 'server/services/account-service'))

const pool = new Pool({ connectionString: env.DATABASE_URL })
const redis = new Redis(env.REDIS_URL, { lazyConnect: true })
const repo = new ProductionRepository(pool)
const customers = new CustomerIdentityService(new CustomerRepository(repo))
const accounts = new AccountService(repo, {}, redis, { redisPrefix: env.REDIS_KEY_PREFIX || 'pix' })

// 商户身份注入：被测的是"消息有没有落库"，不是登录。
// 取一个真实存在的商户，保证外键与隔离边界都是真的。
let merchantId = null
const fakeAuth = {
  middleware() {
    return (req, _res, next) => {
      req.pixUser = { kind: 'user', parent: { id: merchantId }, account: { id: merchantId } }
      next()
    }
  }
}

let pass = 0, fail = 0
function check(label, ok, extra) {
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}

function post(port, urlPath, form) {
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams(form).toString()
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/apis' + urlPath,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(data) } catch (_e) { /* 原文 */ }
        resolve({ status: res.statusCode, json, raw: data })
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

;(async () => {
  await redis.connect()
  const app = express()
  app.use(express.urlencoded({ extended: true }))
  app.use(express.json())
  app.use('/apis', productionRouter({
    repository: repo, auth: fakeAuth, core: { redis }, customers, accounts,
    security: { csrf: (_q, _s, n) => n() }
  }))
  const server = app.listen(0)
  const port = server.address().port

  const peer = 'probe_' + crypto.randomInt(100000, 999999)
  const account = 'probe_acct'

  try {
    merchantId = (await pool.query('SELECT id FROM users ORDER BY id LIMIT 1')).rows[0].id
    console.log(`═══ 用商户 #${merchantId} 做归档验证，客户标识 ${peer} ═══`)

    const before = (await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n
    console.log(`  归档前 messages 条数: ${before}`)

    console.log('\n═══ 1. 上报一条「接收」消息（带正文）═══')
    const sentAt = new Date(Date.now() - 3600_000).toISOString()  // 1 小时前
    const r1 = await post(port, '/customer/ingest', {
      platform: 'telegram-z', accountKey: account, peerKey: peer,
      platformUid: peer, displayName: '归档验证客户',
      body: 'Hello, this is a real archived message.',
      direction: 'in', senderKey: peer, sourceConvId: peer,
      sentAt
    })
    check('上报返回 200', r1.status === 200, { status: r1.status, body: r1.raw.slice(0, 200) })

    const rows1 = (await pool.query(
      `SELECT id, conversation_id, customer_id, direction, sender_key, body, lang_detected,
              source_platform, source_account, source_conv_id, sent_at
         FROM messages WHERE source_conv_id = $1 ORDER BY id`, [peer])).rows
    check('messages 真的写进去了', rows1.length === 1, rows1.length)
    if (rows1.length) {
      const m = rows1[0]
      console.log('  ' + JSON.stringify({
        id: m.id, conv: m.conversation_id, 方向: m.direction, 发送方: m.sender_key,
        正文: m.body, 平台: m.source_platform, 账号: m.source_account,
        发送时间: m.sent_at
      }))
      check('正文一致', m.body === 'Hello, this is a real archived message.', m.body)
      check('方向为 in', m.direction === 'in', m.direction)
      check('溯源字段完整（平台/账号/会话）',
        m.source_platform === 'telegram-z' && m.source_account === account && m.source_conv_id === peer,
        { p: m.source_platform, a: m.source_account, c: m.source_conv_id })
      check('发送时间用的是客户端给的真实时间，不是 now()',
        Math.abs(new Date(m.sent_at).getTime() - new Date(sentAt).getTime()) < 2000,
        { got: m.sent_at, want: sentAt })
      check('关联到了 conversation', !!m.conversation_id, m.conversation_id)
    }

    console.log('\n═══ 2. 重复上报同一条（客户端去重失效时的兜底）═══')
    const r2 = await post(port, '/customer/ingest', {
      platform: 'telegram-z', accountKey: account, peerKey: peer,
      platformUid: peer, displayName: '归档验证客户',
      body: 'Hello, this is a real archived message.',
      direction: 'in', senderKey: peer, sourceConvId: peer,
      // 平台原始消息 ID 多数为空，此时唯一索引不生效，靠同样的 sentAt+正文
      sourceMsgId: 'PROBE_MSG_1',
      sentAt
    })
    check('重复上报返回 200', r2.status === 200, r2.status)
    const rows2 = (await pool.query(
      `SELECT count(*)::int AS n FROM messages WHERE source_conv_id = $1`, [peer])).rows[0].n
    // 第一次没带 sourceMsgId、第二次带了 → 唯一索引（仅对 source_msg_id<>'' 生效）
    // 拦不住，所以这里预期是 2 条。真正保证"不重复"的是客户端的去重键。
    console.log(`  带 sourceMsgId 重报一次后条数: ${rows2}`)
    check('带相同 sourceMsgId 再报一次不会重复写',
      await (async () => {
        await post(port, '/customer/ingest', {
          platform: 'telegram-z', accountKey: account, peerKey: peer, platformUid: peer,
          displayName: '归档验证客户', body: 'Hello, this is a real archived message.',
          direction: 'in', senderKey: peer, sourceConvId: peer,
          sourceMsgId: 'PROBE_MSG_1', sentAt
        })
        const n = (await pool.query(
          `SELECT count(*)::int AS n FROM messages WHERE source_conv_id = $1 AND source_msg_id = 'PROBE_MSG_1'`,
          [peer])).rows[0].n
        return n === 1
      })(), 'sourceMsgId 相同的消息被唯一索引挡住了')

    console.log('\n═══ 3. 上报一条「发出」消息 ═══')
    const outAt = new Date().toISOString()
    const r3 = await post(port, '/customer/ingest', {
      platform: 'telegram-z', accountKey: account, peerKey: peer, platformUid: peer,
      displayName: '归档验证客户',
      body: 'This one is sent by me.',
      direction: 'out', senderKey: account, sourceConvId: peer, sentAt: outAt
    })
    check('出向消息上报返回 200', r3.status === 200, r3.status)
    const outRow = (await pool.query(
      `SELECT direction, sender_key FROM messages
        WHERE source_conv_id = $1 AND direction = 'out' ORDER BY id DESC LIMIT 1`, [peer])).rows[0]
    check('出向消息已落库且方向正确', outRow && outRow.direction === 'out', outRow)
    check('出向消息的发送方是本账号而不是客户',
      outRow && outRow.sender_key === account, outRow && outRow.sender_key)

    console.log('\n═══ 4. 空正文仍然不写消息（保持原语义）═══')
    const peer2 = peer + '_nocontent'
    const n3before = (await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n
    await post(port, '/customer/ingest', {
      platform: 'telegram-z', accountKey: account, peerKey: peer2,
      platformUid: peer2, displayName: '只打开会话', body: '', direction: 'in',
      sentAt: new Date().toISOString()
    })
    const n3after = (await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n
    check('body 为空时不写 messages（"只是打开了会话"不该产生消息）', n3after === n3before,
      { before: n3before, after: n3after })
    // conversations 表没有 source_conv_id 列（那是 messages 的溯源字段），
    // 会话是按 (user_id, platform, account_key, peer_key) 定位的。
    const convAny = (await pool.query(
      `SELECT count(*)::int AS n FROM conversations WHERE peer_key = $1`, [peer2])).rows[0].n
    check('但 conversation 仍然建了（撞单检测的触发点保住了）', convAny === 1, convAny)

    console.log('\n═══ 5. 清理探针数据 ═══')
    await pool.query(`DELETE FROM messages WHERE source_conv_id IN ($1, $2)`, [peer, peer2])
    await pool.query(`DELETE FROM conversations WHERE peer_key IN ($1, $2)`, [peer, peer2])
    const after = (await pool.query('SELECT count(*)::int AS n FROM messages')).rows[0].n
    check('探针消息已清理，条数回到基线', after === before, { before, after })
  } finally {
    server.close()
    await pool.end()
    await redis.quit().catch(() => {})
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail) process.exitCode = 1
})().catch(e => { console.error('异常:', (e && e.stack) || e); process.exitCode = 1 })
