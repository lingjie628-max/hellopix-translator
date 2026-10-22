'use strict'

/**
 * Redis 键前缀只能加一次。
 *
 * ## 背景（真实事故）
 *
 * 前缀被加了两遍：`stores/redis-client.js` 硬编码 `PREFIX='pix:'`，
 * `db/redis.js` 又把 `REDIS_KEY_PREFIX` 交给 ioredis 的 `keyPrefix`，
 * 运维设了 `REDIS_KEY_PREFIX=pix:` —— 线上键全成了 `pix:pix:*`（4632 个）。
 *
 * 因为读写同一个客户端，双前缀**自洽**，业务一声不响地跑了很久。
 * 这类 bug 靠人眼审查很难发现，只能靠测试钉住。
 *
 * 更阴险的是同一批代码里还有三处自己拼前缀（verification-service、
 * core-service 的锁键），它们各自也叠加了一次。任何一处漏改，
 * 都会出现"部分键单前缀、部分双前缀"的撕裂状态，比全双前缀更难排。
 */

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const { key, PREFIX } = require('../server/stores/redis-client')

const root = path.join(__dirname, '..')

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

// ─────────────────────────── 静态结构 ───────────────────────────

test('ioredis 客户端不得再配 keyPrefix —— 前缀只由 redis-client 加', () => {
  const source = read('server/db/redis.js')
  // 允许出现在注释里（解释历史），但不能作为选项传给 new Redis
  const code = source
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')
  assert.equal(
    /keyPrefix\s*:/.test(code), false,
    'db/redis.js 又给 ioredis 配了 keyPrefix —— 会和 stores/redis-client 的 PREFIX 叠加成 pix:pix:*'
  )
})

test('redis-client 的 PREFIX 必须来自环境变量，不能硬编码', () => {
  const source = read('server/stores/redis-client.js')
  const code = source
    .split('\n')
    .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  assert.equal(
    /const PREFIX = 'pix:'/.test(code), false,
    'PREFIX 被写死成 \'pix:\' 了 —— 必须读 REDIS_KEY_PREFIX，否则与 ioredis 叠加'
  )
  assert.match(code, /const PREFIX = String\(process\.env\.REDIS_KEY_PREFIX \|\| ''\)/)
})

test('业务代码里不得再硬编码 pix: 前缀', () => {
  // core-service 的翻译锁键曾是 `pix:translate:lock:...`，也叠加过。
  const code = read('server/services/core-service.js')
    .split('\n')
    .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  assert.equal(
    /`pix:translate:lock:/.test(code), false,
    'core-service 又硬编码 pix: 了 —— 应使用 redis-client 导出的 PREFIX'
  )
  assert.match(code, /PREFIX: redisPrefix/)
})

test('verification-service 的前缀默认值必须来自 redis-client', () => {
  const source = read('server/services/verification-service.js')
    .split('\n')
    .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  assert.equal(
    /prefix \|\| 'pix'/.test(source), false,
    'verification-service 又把默认前缀写死成 \'pix\' —— 会和客户端前缀叠加'
  )
})

// ─────────────────────────── 运行期行为 ───────────────────────────

test('key() 只加一层前缀', () => {
  const built = key('session', 'user', 'token-abc')
  if (!PREFIX) {
    assert.equal(built, 'session:user:token-abc')
  } else {
    assert.equal(built.startsWith(PREFIX), true)
    assert.equal(
      built.startsWith(PREFIX + PREFIX), false,
      `出现了双前缀：${built}`
    )
  }
})

test('所有命名空间都不产生连续重复前缀', () => {
  const namespaces = [
    'session', 'session-subject', 'translation', 'rate',
    'captcha', 'email-code', 'email-resend',
    'admin-totp-ticket', 'admin-totp-counter', 'admin-totp-pending'
  ]
  for (const ns of namespaces) {
    const built = key(ns, 'x')
    const prefixPart = PREFIX || ''
    const rest = built.slice(prefixPart.length)
    assert.equal(
      rest.startsWith(prefixPart) && prefixPart !== '', false,
      `${ns} 的键出现重复前缀：${built}`
    )
  }
})

test('修复脚本：拒绝把本来就带双前缀的键再叠一层（回滚时）', () => {
  const source = read('scripts/fix-redis-prefix.js')
  // 回滚路径必须过滤掉已经是双前缀的键，否则 pix:pix:x → pix:pix:pix:x
  assert.match(source, /rollback \? keys\.filter\(k => !k\.startsWith\(DOUBLE\)\) : keys/)
  // 必须用 RENAME（保留 TTL），而不是 GET+SET
  assert.match(source, /redis\.rename\(/)
})

test('修复脚本：预演模式默认不写数据', () => {
  const source = read('scripts/fix-redis-prefix.js')
  assert.match(source, /const apply = process\.argv\.includes\('--apply'\)/)
  assert.match(source, /if \(!apply \|\| !targets\.length\)/)
})
