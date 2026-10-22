'use strict'

/**
 * Redis 前缀只能有**一个**来源。
 *
 * ## 真实事故（2026-10-21）
 *
 *   `redis-client.js` 硬编码 `PREFIX = 'pix:'`
 *   `db/redis.js`     又把 `REDIS_KEY_PREFIX` 交给 ioredis 的 `keyPrefix`
 *   运维设了 `REDIS_KEY_PREFIX=pix:`
 *
 * → 两层叠加，线上键全成了 `pix:pix:*`，共 4632 个。
 *
 * 因为读写两端是同一个客户端，双前缀**自洽**，业务从不报错 —— 直到有人
 * 按单前缀的约定去写运维脚本或做迁移，才发现键名对不上。
 *
 * ## 这里钉三件事
 *
 * 1. ioredis 的 keyPrefix **不许**再被传（否则就是第二层）
 * 2. 前缀的唯一来源是 REDIS_KEY_PREFIX
 * 3. 搬迁脚本遇到"新旧两条并存"时不许无脑删旧的（那会踢人下线）
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

test('ioredis 不能再被传 keyPrefix（第二层前缀的来源）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'db', 'redis.js'), 'utf8')
  // 允许出现在注释里（说明"不要这么做"），但不许出现在实际配置对象里
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.ok(
    !/keyPrefix\s*:/.test(code),
    'redis.js 又把 keyPrefix 传给 ioredis 了 —— 与 redis-client.js 的 PREFIX 叠加就是 pix:pix:*'
  )
})

test('前缀的唯一来源是 REDIS_KEY_PREFIX，且不做隐式兜底', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'stores', 'redis-client.js'), 'utf8')
  assert.match(src, /REDIS_KEY_PREFIX/, '看不见 REDIS_KEY_PREFIX 了，前缀来源变了')
  // 不许再出现写死的 'pix:' 默认值 —— 那正是当年第一层前缀
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.ok(
    !/PREFIX\s*=\s*['"]pix:['"]/.test(code),
    'redis-client.js 又在硬编码 pix: 前缀了'
  )
})

test('搬迁脚本：新旧键并存时按 TTL 决定留哪条，不许无脑删旧的', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'fix-redis-prefix.js'), 'utf8')
  const start = src.indexOf('if (await redis.exists(newKey))')
  assert.ok(start > 0, '找不到"并存"分支')
  // 取到对应的 else 之前
  const tail = src.slice(start)
  const body = tail.slice(0, tail.indexOf('await redis.rename(oldKey, newKey)'))

  assert.match(body, /redis\.ttl\(oldKey\)/, '并存时没查旧键 TTL')
  assert.match(body, /redis\.ttl\(newKey\)/, '并存时没查新键 TTL')
  assert.match(body, /oldTtl\s*>\s*newTtl/, '没按 TTL 比较决定留哪条')
  // 会话键被误删 = 用户当场掉线。这条必须有明确的保护分支。
  assert.match(body, /redis\.del\(newKey\)/, '旧键活得更久时应保留旧的（删新的），否则会把当前有效会话删掉')
})

test('搬迁脚本必须支持预演（不加 --apply 不动数据）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'fix-redis-prefix.js'), 'utf8')
  assert.match(src, /--apply/, '没有预演开关')
  assert.match(src, /if \(!apply/, '预演分支不见了 —— 脚本会无条件改数据')
})
