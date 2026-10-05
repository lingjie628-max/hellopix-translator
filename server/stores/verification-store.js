'use strict'

const crypto = require('crypto')
const { key, positiveInteger, setJson, getJson, del, evalScript } = require('./redis-client')

const VERIFY_CODE = `
-- pix:verify-code
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local value = cjson.decode(raw)
local matched = value.codeHash == ARGV[1]
if ARGV[2] == '1' or not matched then redis.call('DEL', KEYS[1]) end
if matched then return 1 else return -1 end
`

const RESERVE_SEND = `
-- pix:reserve-send
local result = redis.call('SET', KEYS[1], '1', 'PX', ARGV[1], 'NX')
if result then return {1, tonumber(ARGV[1])} end
return {0, redis.call('PTTL', KEYS[1])}
`

function hashCode(value) {
  return crypto.createHash('sha256').update(String(value || '').trim().toLowerCase()).digest('hex')
}

class RedisVerificationStore {
  constructor(redis, options) {
    if (!redis) throw new TypeError('Redis client is required')
    const opts = options || {}
    this.redis = redis
    this.captchaTtlMs = positiveInteger(opts.captchaTtlMs, 10 * 60_000)
    this.emailTtlMs = positiveInteger(opts.emailTtlMs, 10 * 60_000)
    this.resendTtlMs = positiveInteger(opts.resendTtlMs, 60_000)
  }

  async setCaptcha(imageId, code, ttlMs) {
    await setJson(this.redis, key('captcha', imageId), {
      codeHash: hashCode(code)
    }, positiveInteger(ttlMs, this.captchaTtlMs))
  }

  async verifyCaptcha(imageId, code, consume) {
    const result = Number(await evalScript(
      this.redis,
      VERIFY_CODE,
      [key('captcha', imageId)],
      [hashCode(code), consume === false ? 0 : 1]
    ))
    return { ok: result === 1, missing: result === 0 }
  }

  async setEmailCode(email, code, scene, ttlMs) {
    await setJson(this.redis, key('email-code', normalizeEmail(email)), {
      codeHash: hashCode(code),
      scene: String(scene || '')
    }, positiveInteger(ttlMs, this.emailTtlMs))
  }

  async verifyEmailCode(email, code, scene, consume) {
    const redisKey = key('email-code', normalizeEmail(email))
    const value = await getJson(this.redis, redisKey)
    const ok = !!value &&
      value.codeHash === hashCode(code) &&
      (!scene || !value.scene || value.scene === String(scene))
    if (consume && ok) await del(this.redis, redisKey)
    return { ok, missing: !value }
  }

  async consumeEmail(email) {
    return del(this.redis, key('email-code', normalizeEmail(email)))
  }

  async reserveEmailSend(email, ttlMs) {
    const result = await evalScript(
      this.redis,
      RESERVE_SEND,
      [key('email-resend', normalizeEmail(email))],
      [positiveInteger(ttlMs, this.resendTtlMs)]
    )
    return { allowed: Number(result[0]) === 1, retryAfterMs: Math.max(0, Number(result[1])) }
  }

  putCaptcha(imageId, code, ttlMs) { return this.setCaptcha(imageId, code, ttlMs) }
  checkCaptcha(imageId, code, consume) { return this.verifyCaptcha(imageId, code, consume) }
  putEmailCode(email, code, scene, ttlMs) { return this.setEmailCode(email, code, scene, ttlMs) }
  checkEmailCode(email, code, scene, consume) {
    return this.verifyEmailCode(email, code, scene, consume)
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

module.exports = { RedisVerificationStore, hashCode, normalizeEmail }
