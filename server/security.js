const crypto = require('crypto')

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function parseCookies(req) {
  const out = {}
  String(req.headers.cookie || '').split(';').forEach(part => {
    const index = part.indexOf('=')
    if (index <= 0) return
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  })
  return out
}

function appendCookie(res, value) {
  const current = res.getHeader('Set-Cookie')
  res.setHeader('Set-Cookie', current ? [].concat(current, value) : value)
}

/**
 * 取 IP 的上位网段：IPv4 取 /24，IPv6 取 /48。
 *
 * 用于会话 IP 绑定：网段变了说明"换了地方"，作废会话强制重新登录；
 * 同一网段内换 IP（运营商重拨、手机切基站）不踢人 —— 那是把安全做成骚扰。
 *
 * 取 /48 而不是 /64：同一运营商给一个用户分配的前缀常在 /48~/64 之间浮动。
 *
 * 放在模块顶层（而不是 createSecurity 闭包里），这样 redis-security.js
 * 也能复用**同一份**实现 —— 两份实现迟早会漂移。
 */
function ipPrefix(raw) {
  const ip = String(raw || '').trim().toLowerCase()
  if (!ip) return ''
  // Express 在 trust proxy 下会给出 "::ffff:1.2.3.4" 这种映射形式
  const v4 = ip.replace(/^::ffff:/, '')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
    const parts = v4.split('.')
    return parts.slice(0, 3).join('.') + '.0/24'
  }
  if (ip.includes(':')) {
    const groups = ip.split(':').filter(Boolean).slice(0, 3)
    if (!groups.length) return ''
    return groups.join(':') + '::/48'
  }
  return ''
}

function timingEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(String(password), salt, 64)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

function verifyPassword(record, password) {
  const stored = String(record && record.password || '')
  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$')
    if (parts.length !== 3) return false
    try {
      const actual = crypto.scryptSync(String(password), Buffer.from(parts[1], 'base64'), 64)
      return timingEqual(actual.toString('base64'), parts[2])
    } catch (e) {
      return false
    }
  }
  const valid = timingEqual(stored, password)
  if (valid && record) record.password = hashPassword(password)
  return valid
}

function createSecurity(options) {
  const opts = options || {}
  const production = opts.production === true
  const sessionTtlMs = Number(opts.sessionTtlMs || 12 * 60 * 60 * 1000)
  const sessions = new Map()
  const cookieNames = {
    user: production ? '__Host-pix_user' : 'pix_user',
    admin: production ? '__Host-pix_admin' : 'pix_admin_session',
    csrf: production ? '__Host-pix_csrf' : 'pix_csrf'
  }

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

  function createSession(req, res, type, subjectId, config) {
    const cfg = config || {}
    if (sessions.size >= 10_000) {
      const now = Date.now()
      for (const [sessionToken, value] of sessions) {
        if (value.expiresAt <= now) sessions.delete(sessionToken)
      }
      if (sessions.size >= 10_000) sessions.delete(sessions.keys().next().value)
    }
    const token = crypto.randomBytes(32).toString('base64url')
    const csrf = crypto.randomBytes(24).toString('base64url')
    const ttl = cfg.remember ? 7 * 24 * 60 * 60 * 1000 : sessionTtlMs
    sessions.set(token, {
      type,
      subjectId: String(subjectId),
      csrf,
      deviceId: String(cfg.deviceId || ''),
      // 会话绑定的 IP 前缀（/24 或 /48）。为空表示不绑定。
      // 用前缀而不是完整 IP：家宽/运营商会换 IP，绑太死会把正常用户踢下线。
      ipPrefix: ipPrefixOf(req && req.ip),
      expiresAt: Date.now() + ttl
    })
    appendCookie(res, cookie(cookieNames[type], token, { httpOnly: true, maxAge: ttl }))
    appendCookie(res, cookie(cookieNames.csrf, csrf, { httpOnly: false, maxAge: ttl, sameSite: 'Strict' }))
    res.setHeader('X-CSRF-Token', csrf)
    return sessions.get(token)
  }

  function resolveSession(req, type) {
    const token = parseCookies(req)[cookieNames[type]]
    const session = token && sessions.get(token)
    if (!session || session.type !== type) return null
    if (session.expiresAt <= Date.now()) {
      sessions.delete(token)
      return null
    }
    // ★ 会话 IP 绑定 ★
    //
    // 2026-10-23 入侵：攻击者建了后门超管后在同一个 IP 下连续操作 19 次，
    // 而会话本身对 IP 没有任何约束 —— 只要 cookie 被拿到（XSS、共享电脑、
    // 中间件日志），谁拿都能用。
    //
    // 这里比对上位网段而不是完整 IP：运营商换 IP、手机切基站都很常见，
    // 绑完整 IP 会把正常运营也踢下线。网段变化才说明"换了地方"。
    // IP 变了直接作废会话，强制重新登录 —— 登录时正好会走二次认证/TOTP。
    if (session.ipPrefix && req && req.ip) {
      const prefix = ipPrefixOf(req.ip)
      if (prefix && prefix !== session.ipPrefix) {
        sessions.delete(token)
        return null
      }
    }
    return session
  }

  /**
   * 取 IP 的上位网段：IPv4 取 /24，IPv6 取 /48。
   *
   * 取 /48 而不是 /64：同一运营商给一个用户分配的前缀常在 /48~/64 之间浮动。
   */
  function ipPrefixOf(raw) {
    return ipPrefix(raw)
  }

  function destroySession(req, res, type) {
    const token = parseCookies(req)[cookieNames[type]]
    if (token) sessions.delete(token)
    appendCookie(res, cookie(cookieNames[type], '', { httpOnly: true, maxAge: 0 }))
    appendCookie(res, cookie(cookieNames.csrf, '', { httpOnly: false, maxAge: 0, sameSite: 'Strict' }))
  }

  function revokeSubject(type, subjectId) {
    const expected = String(subjectId)
    for (const [token, value] of sessions) {
      if (value.type === type && value.subjectId === expected) sessions.delete(token)
    }
  }

  function csrf(req, res, next) {
    if (SAFE_METHODS.has(String(req.method || '').toUpperCase())) return next()
    if (req.pixPublic) return next()
    if (/\/(login|captcha|emailCode|register|forgot)$/.test(req.path || req.originalUrl || '')) return next()
    const cookies = parseCookies(req)
    const supplied = String(req.headers['x-csrf-token'] || '')
    const cookieToken = String(cookies[cookieNames.csrf] || '')
    const sessionType = req.pixSessionType === 'admin' ? 'admin' : 'user'
    const authorizedSession = resolveSession(req, sessionType)
    const sessionMatch = authorizedSession && timingEqual(authorizedSession.csrf, supplied)
    if (!supplied || !cookieToken || !timingEqual(supplied, cookieToken) || !sessionMatch) {
      res.status(403).json({ success: false, msg: '安全校验失败，请刷新页面后重试' })
      return
    }
    next()
  }

  function headers(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    const connectSrc = production ? "'self'" : "'self' http: https: ws: wss:"
    res.setHeader('Content-Security-Policy', `default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src ${connectSrc}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`)
    next()
  }

  function originGuard(req, res, next) {
    const origin = String(req.headers.origin || '')
    if (!origin) return next()
    const allowed = new Set((opts.allowedOrigins || []).map(String))
    const sameOrigin = `${req.protocol}://${req.get('host')}`
    if (origin === sameOrigin || allowed.has(origin)) return next()
    res.status(403).json({ success: false, msg: '不允许的请求来源' })
  }

  return {
    cookieNames,
    parseCookies,
    ipPrefixOf,
    hashPassword,
    verifyPassword,
    createSession,
    resolveSession,
    destroySession,
    revokeSubject,
    csrf,
    headers,
    originGuard
  }
}

function rateLimit(options) {
  const opts = options || {}
  const windowMs = Number(opts.windowMs || 60_000)
  const max = Number(opts.max || 60)
  const maxBuckets = Number(opts.maxBuckets || 10_000)
  const buckets = new Map()
  return (req, res, next) => {
    const key = String((opts.key && opts.key(req)) || req.ip || 'unknown')
    const now = Date.now()
    if (buckets.size >= maxBuckets) {
      for (const [bucketKey, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(bucketKey)
      }
      if (buckets.size >= maxBuckets) buckets.delete(buckets.keys().next().value)
    }
    let bucket = buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs }
      buckets.set(key, bucket)
    }
    bucket.count += 1
    res.setHeader('X-RateLimit-Limit', String(max))
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)))
    if (bucket.count > max) {
      const retry = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      res.setHeader('Retry-After', String(retry))
      res.status(429).json({ success: false, msg: '请求过于频繁，请稍后再试' })
      return
    }
    next()
  }
}

module.exports = { createSecurity, rateLimit, hashPassword, verifyPassword, ipPrefixOf: ipPrefix }
