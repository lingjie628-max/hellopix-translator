'use strict'

const crypto = require('crypto')
const { key, positiveInteger, setJson, getJson, del } = require('./redis-client')

function cacheDigest(input) {
  const value = typeof input === 'string' ? input : JSON.stringify(input)
  return crypto.createHash('sha256').update(value).digest('hex')
}

class RedisTranslationCache {
  constructor(redis, options) {
    if (!redis) throw new TypeError('Redis client is required')
    this.redis = redis
    this.ttlMs = positiveInteger(options && options.ttlMs, 24 * 60 * 60_000)
  }

  cacheKey(tenantId, request) {
    return key('translation', tenantId, cacheDigest(request))
  }

  async get(tenantId, request) {
    const value = await getJson(this.redis, this.cacheKey(tenantId, request))
    return value && Object.prototype.hasOwnProperty.call(value, 'value') ? value.value : null
  }

  async set(tenantId, request, value, ttlMs) {
    await setJson(this.redis, this.cacheKey(tenantId, request), {
      value,
      cachedAt: Date.now()
    }, positiveInteger(ttlMs, this.ttlMs))
    return value
  }

  async delete(tenantId, request) {
    return del(this.redis, this.cacheKey(tenantId, request))
  }

  put(tenantId, request, value, ttlMs) { return this.set(tenantId, request, value, ttlMs) }
}

module.exports = { RedisTranslationCache, cacheDigest }
