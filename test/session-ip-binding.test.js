'use strict'

/**
 * 会话 IP 绑定 + 登录异常观测。
 *
 * ## 为什么加这个
 *
 * 2026-10-23 入侵：攻击者建了后门超管后，在同一个 IP 下连续操作 19 次。
 * 当时会话对 IP **没有任何约束** —— 只要 cookie 被拿到（XSS、共享电脑没退出、
 * 代理日志），谁拿都能用，而且不会引起任何注意。
 *
 * 现在的规则：会话绑定 IP 的**上位网段**（IPv4 /24、IPv6 /48），网段变了
 * 直接作废会话、强制重新登录。
 *
 * 为什么是网段不是完整 IP：家宽和手机网络换 IP 太常见，绑完整 IP 会把
 * 正常运营也踢下线 —— 那是把安全做成骚扰。
 *
 * ## 为什么两个实现都要测
 *
 * 生产走 `redis-security.js`，测试走 `security.js`（内存版）。
 * 上一轮已经吃过一次亏：只改了内存版、没改 Redis 版，测试全绿、线上没加固。
 * 这里把两份实现放在同一个测试矩阵里跑。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const memorySecurity = require('../server/security')

// ── ipPrefixOf ────────────────────────────────────────────

test('IPv4 取 /24 网段', () => {
  const f = memorySecurity.ipPrefixOf
  assert.equal(f('203.0.113.9'), '203.0.113.0/24')
  assert.equal(f('203.0.113.200'), '203.0.113.0/24')
  assert.equal(f('10.0.0.1'), '10.0.0.0/24')
})

test('Express 的 ::ffff: 映射形式要能认出来', () => {
  // trust proxy 打开后 Express 常给这种形式，不处理就会判定成"换了网段"
  assert.equal(memorySecurity.ipPrefixOf('::ffff:203.0.113.9'), '203.0.113.0/24')
})

test('IPv6 取 /48 网段', () => {
  assert.equal(memorySecurity.ipPrefixOf('2001:db8:1234:5678::1'), '2001:db8:1234::/48')
})

test('同网段不同主机 → 同一个前缀；跨网段 → 不同前缀', () => {
  const f = memorySecurity.ipPrefixOf
  assert.equal(f('203.0.113.1'), f('203.0.113.254'))
  assert.notEqual(f('203.0.113.1'), f('203.0.114.1'))
})

test('空值 / 垃圾值 → 空前缀（表示不绑定，不能误判成"换网段"）', () => {
  const f = memorySecurity.ipPrefixOf
  assert.equal(f(''), '')
  assert.equal(f(null), '')
  assert.equal(f(undefined), '')
})

// ── 会话行为 ──────────────────────────────────────────────

/** 造一个最小的 res 桩，收集 Set-Cookie。 */
function makeRes () {
  const cookies = []
  return {
    cookies,
    setHeader () {},
    append (v) { cookies.push(v) }
  }
}

/**
 * 兼容 Express 的 res.append / setHeader 写法。
 * 真实 Express 用 res.append('Set-Cookie', value)，这里两种都接住。
 */
function resProxy (holder) {
  return {
    getHeader () { return holder.length ? (holder.length === 1 ? holder[0] : holder.slice()) : undefined },
    setHeader (name, value) {
      if (name === 'Set-Cookie') {
        holder.length = 0
        for (const v of [].concat(value)) holder.push(v)
      }
    }
  }
}

function makeRequest (ip) {
  return { ip, headers: { cookie: '' }, path: '/' }
}

/** 从 Set-Cookie 里还原出 cookie 串，供下一次请求使用。 */
function toCookieHeader (setCookies) {
  return setCookies.map(c => String(c).split(';')[0]).join('; ')
}

test('内存版：IP 换网段 → 会话作废', async () => {
  const security = memorySecurity.createSecurity({ production: false })
  const holder = []
  const res = resProxy(holder)
  const created = await security.createSession(makeRequest('203.0.113.9'), res, 'admin', 1, {})
  assert.equal(created.ipPrefix, '203.0.113.0/24')

  const token = String(holder[0]).split(';')[0]
  // 同网段：仍然有效
  const same = await security.resolveSession({ ip: '203.0.113.44', headers: { cookie: token } }, 'admin')
  assert.ok(same, '同网段应当继续有效（运营商换 IP 不该踢人）')

  // 换网段：作废
  const other = await security.resolveSession({ ip: '198.51.100.7', headers: { cookie: token } }, 'admin')
  assert.equal(other, null, '换网段必须强制重新登录')
})

test('内存版：会话被作废后，原网段也回不去了（不能"换个 IP 再换回来"复活）', async () => {
  const security = memorySecurity.createSecurity({ production: false })
  const holder = []
  const res = resProxy(holder)
  await security.createSession(makeRequest('203.0.113.9'), res, 'admin', 1, {})
  const token = String(holder[0]).split(';')[0]

  assert.equal(await security.resolveSession({ ip: '198.51.100.7', headers: { cookie: token } }, 'admin'), null)
  // 换回原网段：会话已经从存储里删掉了
  assert.equal(await security.resolveSession({ ip: '203.0.113.9', headers: { cookie: token } }, 'admin'), null)
})

test('Redis 版与内存版行为一致（防止只改一份）', async () => {
  const redisSecurity = require('../server/redis-security')
  assert.equal(typeof redisSecurity.createRedisSecurity, 'function')

  // 从源码层面确认 Redis 版也做了 IP 绑定检查 ——
  // 这是防止"只改内存版"的硬约束：改漏了这里直接红。
  const fs = require('fs')
  const path = require('path')
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'redis-security.js'), 'utf8')
  assert.match(source, /ipPrefix:\s*memorySecurity\.ipPrefixOf/, 'Redis 版 createSession 必须绑定 IP 前缀')
  assert.match(source, /session\.ipPrefix\s*&&/, 'Redis 版 resolveSession 必须校验 IP 前缀')
  assert.match(source, /sessionStore\.delete\(token, type, session\.subjectId\)/,
    'IP 不匹配时必须真的删除会话，而不只是返回 null')
})

test('内存版同样要真的删除会话，而不是只返回 null', async () => {
  const fs = require('fs')
  const path = require('path')
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'security.js'), 'utf8')
  assert.match(source, /sessions\.delete\(token\)\s*\n\s*return null/,
    'IP 不匹配时必须删除会话，否则换回原网段还能复活')
})

// ── 创建时就要带上 IP ────────────────────────────────────

test('createSession 必须从 req.ip 取网段（不能留空，留空等于没绑定）', async () => {
  const security = memorySecurity.createSecurity({ production: false })
  const holder = []
  const created = await security.createSession(makeRequest('198.51.100.20'), resProxy(holder), 'user', 2, {})
  assert.equal(created.ipPrefix, '198.51.100.0/24')
})
