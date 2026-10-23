'use strict'

const crypto = require('crypto')
const { createSecurity, hashPassword, verifyPassword } = require('./security')
const stores = require('./stores')

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function appendCookie(res, value) {
  const current = res.getHeader('Set-Cookie')
  res.setHeader('Set-Cookie', current ? [].concat(current, value) : value)
}

function timingEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function createRedisSecurity(options) {
  const opts = options || {}
  const production = opts.production === true
  const sessionTtlMs = Number(opts.sessionTtlMs || 12 * 60 * 60 * 1000)
  const sessionStore = opts.sessionStore ||
    new stores.RedisSessionStore(opts.redis, { ttlMs: sessionTtlMs })
  const memorySecurity = createSecurity(opts)
  const cookieNames = memorySecurity.cookieNames

  function cookie(name, value, config) {
    const cfg = config || {}
    const parts = [
      `${name}=${encodeURIComponent(value)}`,
      'Path=/',
      `SameSite=${cfg.sameSite || 'Lax'}`
    ]
    if (cfg.httpOnly) parts.push('HttpOnly')
    if (production) parts.push('Secure')
    if (cfg.maxAge != null) parts.push(`Max-Age=${Math.max(0, Math.floor(cfg.maxAge / 1000))}`)
    return parts.join('; ')
  }

  async function createSession(req, res, type, subjectId, config) {
    const cfg = config || {}
    const token = crypto.randomBytes(32).toString('base64url')
    const csrfToken = crypto.randomBytes(24).toString('base64url')
    const ttl = cfg.remember ? 7 * 24 * 60 * 60 * 1000 : sessionTtlMs
    const session = await sessionStore.set(token, {
      type,
      subjectId: String(subjectId),
      csrf: csrfToken,
      deviceId: String(cfg.deviceId || ''),
      // 与 memory 版同一套 IP 绑定规则 —— 生产走的是这一份，
      // 只改 security.js 不改这里，等于线上没加固（2026-10-23 的教训）。
      ipPrefix: memorySecurity.ipPrefixOf(req && req.ip)
    }, ttl)
    appendCookie(res, cookie(cookieNames[type], token, { httpOnly: true, maxAge: ttl }))
    appendCookie(res, cookie(cookieNames.csrf, csrfToken, {
      httpOnly: false,
      maxAge: ttl,
      sameSite: 'Strict'
    }))
    res.setHeader('X-CSRF-Token', csrfToken)
    return session
  }

  async function resolveSession(req, type) {
    const token = memorySecurity.parseCookies(req)[cookieNames[type]]
    const session = token ? await sessionStore.get(token, type) : null
    if (!session) return null
    // 会话 IP 绑定：网段变了就作废，强制重新登录。
    // 只比上位网段（IPv4 /24、IPv6 /48），运营商换 IP 不会误伤。
    if (session.ipPrefix && req && req.ip) {
      const prefix = memorySecurity.ipPrefixOf(req.ip)
      if (prefix && prefix !== session.ipPrefix) {
        await sessionStore.delete(token, type, session.subjectId)
        return null
      }
    }
    return session
  }

  async function destroySession(req, res, type) {
    const token = memorySecurity.parseCookies(req)[cookieNames[type]]
    if (token) {
      const session = await sessionStore.get(token, type)
      await sessionStore.delete(token, type, session && session.subjectId)
    }
    appendCookie(res, cookie(cookieNames[type], '', { httpOnly: true, maxAge: 0 }))
    appendCookie(res, cookie(cookieNames.csrf, '', {
      httpOnly: false,
      maxAge: 0,
      sameSite: 'Strict'
    }))
  }

  function revokeSubject(type, subjectId) {
    return sessionStore.revokeSubject(type, subjectId)
  }

  async function csrf(req, res, next) {
    try {
      if (SAFE_METHODS.has(String(req.method || '').toUpperCase())) return next()
      if (req.pixPublic) return next()
      if (/\/(login|captcha|emailCode|register|forgot)$/.test(req.path || req.originalUrl || '')) {
        return next()
      }
      const cookies = memorySecurity.parseCookies(req)
      const supplied = String(req.headers['x-csrf-token'] || '')
      const cookieToken = String(cookies[cookieNames.csrf] || '')
      const sessionType = req.pixSessionType === 'admin' ? 'admin' : 'user'
      const authorizedSession = await resolveSession(req, sessionType)
      const sessionMatch = authorizedSession && timingEqual(authorizedSession.csrf, supplied)
      if (!supplied || !cookieToken || !timingEqual(supplied, cookieToken) || !sessionMatch) {
        res.status(403).json({ success: false, msg: '安全校验失败，请刷新页面后重试' })
        return
      }
      next()
    } catch (error) {
      next(error)
    }
  }

  return {
    cookieNames,
    parseCookies: memorySecurity.parseCookies,
    hashPassword,
    verifyPassword,
    createSession,
    resolveSession,
    destroySession,
    revokeSubject,
    csrf,
    headers: memorySecurity.headers,
    originGuard: memorySecurity.originGuard,
    sessionStore
  }
}

function redisRateLimit(options) {
  const opts = options || {}
  const store = opts.store || new stores.RedisFixedWindowStore(opts.redis, opts)
  return async (req, res, next) => {
    try {
      const identifier = String((opts.key && opts.key(req)) || req.ip || 'unknown')
      const result = await store.consume(identifier, opts)
      res.setHeader('X-RateLimit-Limit', String(result.limit))
      res.setHeader('X-RateLimit-Remaining', String(result.remaining))
      if (!result.allowed) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))))
        res.status(429).json({ success: false, msg: '请求过于频繁，请稍后再试' })
        return
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}

module.exports = Object.assign({
  createRedisSecurity,
  redisRateLimit,
  rateLimit: redisRateLimit
}, stores)
