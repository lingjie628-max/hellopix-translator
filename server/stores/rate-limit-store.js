'use strict'

const { key, positiveInteger, evalScript } = require('./redis-client')

const INCREMENT_WINDOW = `
-- pix:fixed-window
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`

class RedisFixedWindowStore {
  constructor(redis, options) {
    if (!redis) throw new TypeError('Redis client is required')
    const opts = options || {}
    this.redis = redis
    this.windowMs = positiveInteger(opts.windowMs, 60_000)
    this.max = positiveInteger(opts.max, 60)
    this.namespace = String(opts.namespace || 'default')
    this.now = opts.now || Date.now
  }

  async consume(identifier, options) {
    const opts = options || {}
    const windowMs = positiveInteger(opts.windowMs, this.windowMs)
    const max = positiveInteger(opts.max, this.max)
    const now = this.now()
    const windowStart = Math.floor(now / windowMs) * windowMs
    const redisKey = key('rate', this.namespace, identifier, windowStart)
    const result = await evalScript(this.redis, INCREMENT_WINDOW, [redisKey], [windowMs])
    const count = Number(result[0])
    const redisTtl = Number(result[1])
    const retryAfterMs = redisTtl > 0 ? redisTtl : Math.max(1, windowStart + windowMs - now)
    return {
      allowed: count <= max,
      count,
      limit: max,
      remaining: Math.max(0, max - count),
      retryAfterMs,
      resetAt: now + retryAfterMs
    }
  }

  increment(identifier, options) { return this.consume(identifier, options) }
}

module.exports = { RedisFixedWindowStore }
