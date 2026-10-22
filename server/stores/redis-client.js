'use strict'

/**
 * Redis 键前缀 —— **只能有一个来源**。
 *
 * 历史事故：这里曾硬编码 `'pix:'`，而 `server/db/redis.js` 又把
 * `REDIS_KEY_PREFIX` 传给 ioredis 的 `keyPrefix`。运维在
 * `/etc/hello-pix/hello-pix.env` 里设了 `REDIS_KEY_PREFIX=pix:`，
 * 于是两处各加一次，线上实际键全变成 `pix:pix:session:...`。
 * 因为读写两端用的是同一个客户端，双前缀**自洽**、业务不报错，
 * 所以这个 bug 潜伏了很久（线上堆积了 4600+ 个双前缀键）。
 *
 * 现在两边都读同一个环境变量，前缀恰好加一次：
 *
 *   · 本地 / 测试：`REDIS_KEY_PREFIX` 未设置 → 空串 → 键为 `session:...`
 *   · 生产：`REDIS_KEY_PREFIX=pix:` → ioredis 加一次 → `pix:session:...`
 *
 * ⚠️ 改这里之前先读 `migrations/050_redis_double_prefix.js`：
 * 前缀变更会让存量的会话、翻译缓存、限流计数全部"消失"（不是真的删，
 * 是查不到），必须配套迁移。
 */
const PREFIX = String(process.env.REDIS_KEY_PREFIX || '')

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.ceil(number) : fallback
}

function segment(value) {
  return encodeURIComponent(String(value == null ? '' : value))
}

function key(namespace, ...parts) {
  return PREFIX + namespace + (parts.length ? ':' + parts.map(segment).join(':') : '')
}

function usesPositionalArguments(redis) {
  return !!(redis &&
    typeof redis.status === 'string' &&
    redis.options &&
    typeof redis.pipeline === 'function')
}

async function setJson(redis, redisKey, value, ttlMs) {
  const payload = JSON.stringify(value)
  const ttl = positiveInteger(ttlMs, 1)
  if (usesPositionalArguments(redis)) {
    return redis.set(redisKey, payload, 'PX', ttl)
  }
  try {
    return await redis.set(redisKey, payload, { PX: ttl })
  } catch (error) {
    // ioredis uses positional SET arguments; node-redis uses an options object.
    if (!/argument|syntax|option/i.test(String(error && error.message))) throw error
    return redis.set(redisKey, payload, 'PX', ttl)
  }
}

async function del(redis, ...keys) {
  if (!keys.length) return 0
  try {
    return await redis.del(keys)
  } catch (error) {
    return redis.del(...keys)
  }
}

async function evalScript(redis, script, keys, args) {
  if (usesPositionalArguments(redis)) {
    return redis.eval(script, keys.length, ...keys, ...args.map(String))
  }
  try {
    return await redis.eval(script, {
      keys,
      arguments: args.map(String)
    })
  } catch (error) {
    if (!/argument|syntax|option|number of keys/i.test(String(error && error.message))) throw error
    return redis.eval(script, keys.length, ...keys, ...args.map(String))
  }
}

async function getJson(redis, redisKey) {
  const raw = await redis.get(redisKey)
  if (raw == null) return null
  try {
    return JSON.parse(raw)
  } catch (error) {
    await del(redis, redisKey)
    return null
  }
}

module.exports = {
  PREFIX,
  positiveInteger,
  segment,
  key,
  usesPositionalArguments,
  setJson,
  getJson,
  del,
  evalScript
}
