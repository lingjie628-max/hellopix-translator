'use strict'

const crypto = require('crypto')
const { key, positiveInteger, setJson, getJson, del } = require('./redis-client')

class RedisShareGrantStore {
  constructor(redis, options) {
    if (!redis) throw new TypeError('Redis client is required')
    this.redis = redis
    this.ttlMs = positiveInteger(options && options.ttlMs, 60 * 60_000)
  }

  async issue(serialNumber, options) {
    const opts = options || {}
    const token = opts.token || crypto.randomBytes(24).toString('base64url')
    let ttl = positiveInteger(opts.ttlMs, this.ttlMs)
    if (opts.expiresAt != null) ttl = Math.min(ttl, Math.max(1, Number(opts.expiresAt) - Date.now()))
    const grant = {
      serialNumber: String(serialNumber),
      expiresAt: Date.now() + ttl
    }
    await setJson(this.redis, key('share-grant', token), grant, ttl)
    return token
  }

  async validate(token, serialNumber) {
    const redisKey = key('share-grant', token)
    const grant = await getJson(this.redis, redisKey)
    const valid = !!grant &&
      grant.expiresAt > Date.now() &&
      grant.serialNumber === String(serialNumber || '')
    if (grant && !valid) await del(this.redis, redisKey)
    return valid
  }

  async revoke(token) {
    return del(this.redis, key('share-grant', token))
  }

  create(serialNumber, options) { return this.issue(serialNumber, options) }
  verify(token, serialNumber) { return this.validate(token, serialNumber) }
}

module.exports = { RedisShareGrantStore }
