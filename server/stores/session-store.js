'use strict'

const { key, positiveInteger, getJson, evalScript } = require('./redis-client')

const PUT_SESSION = `
-- pix:put-session
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('SADD', KEYS[2], KEYS[1])
local current = redis.call('PTTL', KEYS[2])
if current < tonumber(ARGV[2]) then redis.call('PEXPIRE', KEYS[2], ARGV[2]) end
return 1
`

const DELETE_SESSION = `
-- pix:delete-session
redis.call('DEL', KEYS[1])
if ARGV[1] ~= '' then redis.call('SREM', KEYS[2], KEYS[1]) end
return 1
`

const REVOKE_SUBJECT = `
-- pix:revoke-subject
local sessions = redis.call('SMEMBERS', KEYS[1])
for _, sessionKey in ipairs(sessions) do redis.call('DEL', sessionKey) end
redis.call('DEL', KEYS[1])
return #sessions
`

class RedisSessionStore {
  constructor(redis, options) {
    if (!redis) throw new TypeError('Redis client is required')
    this.redis = redis
    this.ttlMs = positiveInteger(options && options.ttlMs, 12 * 60 * 60 * 1000)
  }

  sessionKey(type, token) {
    return key('session', type, token)
  }

  subjectKey(type, subjectId) {
    return key('session-subject', type, subjectId)
  }

  async set(token, session, ttlMs) {
    const value = Object.assign({}, session)
    value.type = String(value.type || 'user')
    value.subjectId = String(value.subjectId)
    const ttl = positiveInteger(ttlMs, this.ttlMs)
    value.expiresAt = Date.now() + ttl
    await evalScript(this.redis, PUT_SESSION, [
      this.sessionKey(value.type, token),
      this.subjectKey(value.type, value.subjectId)
    ], [JSON.stringify(value), ttl])
    return value
  }

  async get(token, type) {
    const value = await getJson(this.redis, this.sessionKey(type, token))
    if (!value || value.type !== String(type) || value.expiresAt <= Date.now()) {
      if (value) await this.delete(token, type, value.subjectId)
      return null
    }
    return value
  }

  async delete(token, type, subjectId) {
    const subjectKey = subjectId == null ? '' : this.subjectKey(type, subjectId)
    await evalScript(this.redis, DELETE_SESSION, [
      this.sessionKey(type, token),
      subjectKey || key('session-subject', 'none')
    ], [subjectKey])
  }

  async revokeSubject(type, subjectId) {
    return Number(await evalScript(
      this.redis,
      REVOKE_SUBJECT,
      [this.subjectKey(type, subjectId)],
      []
    ))
  }

  create(token, session, ttlMs) { return this.set(token, session, ttlMs) }
  resolve(token, type) { return this.get(token, type) }
  destroy(token, type, subjectId) { return this.delete(token, type, subjectId) }
  revoke(type, subjectId) { return this.revokeSubject(type, subjectId) }
}

module.exports = { RedisSessionStore }
