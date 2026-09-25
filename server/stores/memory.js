'use strict'

const crypto = require('crypto')
const { positiveInteger } = require('./redis-client')
const { hashCode, normalizeEmail } = require('./verification-store')
const { cacheDigest } = require('./translation-cache')

class MemorySessionStore {
  constructor(options) {
    this.ttlMs = positiveInteger(options && options.ttlMs, 12 * 60 * 60 * 1000)
    this.sessions = new Map()
    this.subjects = new Map()
  }

  async set(token, session, ttlMs) {
    const value = Object.assign({}, session, {
      type: String(session.type || 'user'),
      subjectId: String(session.subjectId),
      expiresAt: Date.now() + positiveInteger(ttlMs, this.ttlMs)
    })
    this.sessions.set(this._key(value.type, token), value)
    const subjectKey = this._subjectKey(value.type, value.subjectId)
    if (!this.subjects.has(subjectKey)) this.subjects.set(subjectKey, new Set())
    this.subjects.get(subjectKey).add(this._key(value.type, token))
    return value
  }

  async get(token, type) {
    const storeKey = this._key(type, token)
    const value = this.sessions.get(storeKey)
    if (!value || value.expiresAt <= Date.now()) {
      if (value) await this.delete(token, type, value.subjectId)
      return null
    }
    return Object.assign({}, value)
  }

  async delete(token, type, subjectId) {
    const storeKey = this._key(type, token)
    const value = this.sessions.get(storeKey)
    this.sessions.delete(storeKey)
    const id = subjectId == null && value ? value.subjectId : subjectId
    if (id != null) {
      const index = this.subjects.get(this._subjectKey(type, id))
      if (index) index.delete(storeKey)
    }
  }

  async revokeSubject(type, subjectId) {
    const subjectKey = this._subjectKey(type, subjectId)
    const index = this.subjects.get(subjectKey) || new Set()
    for (const storeKey of index) this.sessions.delete(storeKey)
    this.subjects.delete(subjectKey)
    return index.size
  }

  _key(type, token) { return String(type) + ':' + String(token) }
  _subjectKey(type, subjectId) { return String(type) + ':' + String(subjectId) }
  create(token, session, ttlMs) { return this.set(token, session, ttlMs) }
  resolve(token, type) { return this.get(token, type) }
  destroy(token, type, subjectId) { return this.delete(token, type, subjectId) }
  revoke(type, subjectId) { return this.revokeSubject(type, subjectId) }
}

class MemoryFixedWindowStore {
  constructor(options) {
    const opts = options || {}
    this.windowMs = positiveInteger(opts.windowMs, 60_000)
    this.max = positiveInteger(opts.max, 60)
    this.now = opts.now || Date.now
    this.buckets = new Map()
  }

  async consume(identifier, options) {
    const opts = options || {}
    const windowMs = positiveInteger(opts.windowMs, this.windowMs)
    const max = positiveInteger(opts.max, this.max)
    const now = this.now()
    const windowStart = Math.floor(now / windowMs) * windowMs
    const bucketKey = String(identifier) + ':' + windowStart
    const count = (this.buckets.get(bucketKey) || 0) + 1
    this.buckets.set(bucketKey, count)
    const retryAfterMs = windowStart + windowMs - now
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

class MemoryVerificationStore {
  constructor(options) {
    const opts = options || {}
    this.captchaTtlMs = positiveInteger(opts.captchaTtlMs, 5 * 60_000)
    this.emailTtlMs = positiveInteger(opts.emailTtlMs, 10 * 60_000)
    this.resendTtlMs = positiveInteger(opts.resendTtlMs, 60_000)
    this.captchas = new Map()
    this.emails = new Map()
    this.resends = new Map()
  }

  async setCaptcha(imageId, code, ttlMs) {
    this.captchas.set(String(imageId), this._value(code, ttlMs, this.captchaTtlMs))
  }

  async verifyCaptcha(imageId, code, consume) {
    return this._verify(this.captchas, String(imageId), code, consume !== false)
  }

  async setEmailCode(email, code, scene, ttlMs) {
    this.emails.set(normalizeEmail(email), Object.assign(
      this._value(code, ttlMs, this.emailTtlMs),
      { scene: String(scene || '') }
    ))
  }

  async verifyEmailCode(email, code, scene, consume) {
    const key = normalizeEmail(email)
    const item = this._get(this.emails, key)
    const ok = !!item && item.codeHash === hashCode(code) &&
      (!scene || !item.scene || item.scene === String(scene))
    if (ok && consume) this.emails.delete(key)
    return { ok, missing: !item }
  }

  async consumeEmail(email) { return this.emails.delete(normalizeEmail(email)) ? 1 : 0 }

  async reserveEmailSend(email, ttlMs) {
    const key = normalizeEmail(email)
    const current = this._get(this.resends, key)
    if (current) return { allowed: false, retryAfterMs: Math.max(0, current.expiresAt - Date.now()) }
    const ttl = positiveInteger(ttlMs, this.resendTtlMs)
    this.resends.set(key, { expiresAt: Date.now() + ttl })
    return { allowed: true, retryAfterMs: ttl }
  }

  _value(code, ttlMs, fallback) {
    return { codeHash: hashCode(code), expiresAt: Date.now() + positiveInteger(ttlMs, fallback) }
  }

  _get(map, key) {
    const item = map.get(key)
    if (item && item.expiresAt <= Date.now()) {
      map.delete(key)
      return null
    }
    return item || null
  }

  _verify(map, key, code, consume) {
    const item = this._get(map, key)
    const ok = !!item && item.codeHash === hashCode(code)
    if (item && (consume || !ok)) map.delete(key)
    return { ok, missing: !item }
  }

  putCaptcha(imageId, code, ttlMs) { return this.setCaptcha(imageId, code, ttlMs) }
  checkCaptcha(imageId, code, consume) { return this.verifyCaptcha(imageId, code, consume) }
  putEmailCode(email, code, scene, ttlMs) { return this.setEmailCode(email, code, scene, ttlMs) }
  checkEmailCode(email, code, scene, consume) {
    return this.verifyEmailCode(email, code, scene, consume)
  }
}

class MemoryTranslationCache {
  constructor(options) {
    this.ttlMs = positiveInteger(options && options.ttlMs, 24 * 60 * 60_000)
    this.values = new Map()
  }

  _key(tenantId, request) { return String(tenantId) + ':' + cacheDigest(request) }

  async get(tenantId, request) {
    const key = this._key(tenantId, request)
    const item = this.values.get(key)
    if (!item || item.expiresAt <= Date.now()) {
      this.values.delete(key)
      return null
    }
    return item.value
  }

  async set(tenantId, request, value, ttlMs) {
    this.values.set(this._key(tenantId, request), {
      value,
      expiresAt: Date.now() + positiveInteger(ttlMs, this.ttlMs)
    })
    return value
  }

  async delete(tenantId, request) { return this.values.delete(this._key(tenantId, request)) ? 1 : 0 }
  put(tenantId, request, value, ttlMs) { return this.set(tenantId, request, value, ttlMs) }
}

module.exports = {
  MemorySessionStore,
  MemoryFixedWindowStore,
  MemoryVerificationStore,
  MemoryTranslationCache
}
