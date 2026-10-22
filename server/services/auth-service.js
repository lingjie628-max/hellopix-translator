'use strict'

const { ApiError } = require('../lib/http')
const password = require('../lib/password')

/**
 * 账号是否已到期。`null`/空串 = 无限期。
 *
 * 单独抽出来，是因为登录与每次请求都必须用**同一个**口径 ——
 * 两处各写一遍，迟早一处改成 `<`、另一处还是 `<=`，边界上就会出现
 * "刚登录说没过期，下一个请求又说过期"的鬼故事。
 */
function isExpired(expiresAt) {
  if (!expiresAt) return false
  const at = new Date(expiresAt).getTime()
  return Number.isFinite(at) && at <= Date.now()
}

class AuthService {
  constructor(repository, security) {
    this.repository = repository
    this.security = security
  }

  async verify(encoded, supplied) {
    if (typeof this.security.verifyPassword === 'function') {
      return this.security.verifyPassword({ password: encoded }, supplied)
    }
    return password.verifyPassword(encoded, supplied)
  }

  async hash(value) {
    if (!password.validPassword(value)) {
      throw new ApiError(400, '密码需为 6-128 位', 'WEAK_PASSWORD')
    }
    return this.hashSecret(value)
  }

  async hashSecret(value) {
    if (!String(value || '')) throw new ApiError(400, '密码不能为空', 'PASSWORD_REQUIRED')
    if (typeof this.security.hashPassword === 'function') return this.security.hashPassword(value)
    return password.hashPassword(value)
  }

  subject(kind, id) {
    return `${kind === 'sub' ? 'sub' : 'main'}:${id}`
  }

  revokeUser(kind, id) {
    return this.security.revokeSubject('user', this.subject(kind, id))
  }

  async recordLoginFailure(req, account, loginType, reason) {
    try {
      await this.repository.query(
        `INSERT INTO login_logs(account,login_type,success,failure_reason,login_ip,user_agent,device_id)
         VALUES($1,$2,false,$3,NULLIF($4,'')::inet,$5,$6)`,
        [String(account || '').slice(0, 320), loginType, String(reason).slice(0, 300),
          req.ip || '', String(req.headers['user-agent'] || '').slice(0, 1000),
          String(req.headers['x-pix-device'] || '').slice(0, 255) || null]
      )
    } catch (error) {
      console.error('Failed to persist login failure:', error.message)
    }
  }

  async loginUser(req, res, data, clientMode) {
    const username = String(data.username || '').trim()
    const loginType = clientMode ? 'client' : 'merchant'
    const account = username.length <= 64
      ? await this.repository.accountByUsername(username)
      : null
    if (!account || !(await this.verify(account.passwordHash, data.password))) {
      await this.recordLoginFailure(req, username, loginType, 'BAD_CREDENTIALS')
      throw new ApiError(401, '账号或密码错误', 'BAD_CREDENTIALS')
    }
    const session = await this.repository.sessionAccount(this.subject(account.kind, account.id))
    if (!session || Number(session.account.status) !== 1 || Number(session.parent.status) !== 1) {
      await this.recordLoginFailure(req, username, loginType, 'ACCOUNT_DISABLED')
      throw new ApiError(403, '账号已停用', 'ACCOUNT_DISABLED')
    }
    if (isExpired(session.parent.expiresAt)) {
      await this.recordLoginFailure(req, username, loginType, 'ACCOUNT_EXPIRED')
      throw new ApiError(403, '账号已过期', 'ACCOUNT_EXPIRED')
    }
    const deviceId = String(data.deviceId || '').trim()
    if (clientMode && !deviceId) throw new ApiError(400, '缺少设备标识', 'DEVICE_REQUIRED')
    if (clientMode) {
      const table = session.kind === 'sub' ? 'sub_accounts' : 'users'
      const current = String(session.account.boundDevice || '')
      if (current && current !== deviceId) throw new ApiError(409, '账号已绑定其他设备，请先解绑', 'DEVICE_BOUND')
      await this.repository.query(`UPDATE ${table} SET bound_device=$2 WHERE id=$1`, [session.account.id, deviceId])
    }
    await this.security.destroySession(req, res, 'user')
    await this.security.createSession(res, 'user', this.subject(session.kind, session.account.id), {
      remember: clientMode || Boolean(data.remember),
      deviceId
    })
    await this.repository.query(
      `INSERT INTO login_logs(user_id,sub_account_id,account,login_type,success,login_ip,user_agent,device_id)
       VALUES($1,$2,$3,$4,true,NULLIF($5,'')::inet,$6,$7)`,
      [session.parent.id, session.kind === 'sub' ? session.account.id : null, session.account.username,
        loginType, req.ip || '', String(req.headers['user-agent'] || '').slice(0, 1000),
        deviceId || null]
    )
    return session
  }

  /**
   * 只校验超管账号密码，**不建立会话**。
   * 拆出来是为了两步验证：密码通过后若该账号开了 2FA，此时还不能给会话。
   */
  async verifyAdminCredentials(req, data) {
    const username = String(data.username || '').trim()
    const admin = username.length <= 64
      ? await this.repository.adminByUsername(username)
      : null
    if (!admin || !(await this.verify(admin.passwordHash, data.password))) {
      await this.recordLoginFailure(req, username, 'admin', 'BAD_CREDENTIALS')
      throw new ApiError(401, '超管账号或密码错误', 'BAD_CREDENTIALS')
    }
    return admin
  }

  /** 凭据（含第二因子）都通过后，才真正发放会话并记账 */
  async startAdminSession(req, res, admin, action) {
    await this.security.destroySession(req, res, 'admin')
    await this.security.createSession(res, 'admin', admin.id, { remember: false })
    await this.repository.query(
      `UPDATE admins SET last_login_at=NOW(),updated_at=NOW() WHERE id=$1`,
      [admin.id]
    )
    await this.repository.query(
      `INSERT INTO login_logs(admin_id,account,login_type,success,login_ip,user_agent)
       VALUES($1,$2,'admin',true,NULLIF($3,'')::inet,$4)`,
      [admin.id, admin.username, req.ip || '', String(req.headers['user-agent'] || '').slice(0, 1000)]
    )
    await this.repository.audit(null, admin, action || '登录超管后台', '', req.ip)
    return admin
  }

  async loginAdmin(req, res, data) {
    const admin = await this.verifyAdminCredentials(req, data)
    return this.startAdminSession(req, res, admin)
  }

  async resolve(req, type) {
    const securitySession = await this.security.resolveSession(req, type)
    if (!securitySession) return null
    if (type === 'admin') {
      const admin = await this.repository.adminById(securitySession.subjectId)
      return admin ? { securitySession, admin } : null
    }
    const session = await this.repository.sessionAccount(securitySession.subjectId)
    if (!session || Number(session.account.status) !== 1 || Number(session.parent.status) !== 1) return null
    // 到期判断必须放在**每次请求**上，而不是只在登录时做一次。
    //
    // 否则「到期」实际效果只是拦住下一次登录：已经登录的客户端把窗口挂着，
    // 就能一直翻译下去 —— 用户只要不主动退出，到期对他没有任何约束。
    // 子账号同理：主账号到期/停用，整个团队一起失效，不能只断主号那一条连接。
    if (isExpired(session.parent.expiresAt)) return null
    return Object.assign({ securitySession }, session)
  }

  middleware() {
    return async (req, res, next) => {
      try {
        const path = String(req.path || '').replace(/\/+$/, '') || '/'
        const publicPaths = new Set([
          '/site/info', '/client/lines', '/login', '/client/login', '/admin/login',
          // 崩溃日志上报：**必须公开**。
          //
          // 闪退最常发生在启动阶段 —— 那时还没登录，甚至登录页都没渲染出来。
          // 若要鉴权，"启动即闪退"这批最有价值的日志反而一份都收不到，
          // 而它们恰恰是排查的重点。滥用风险由 IP 限流（20 次/小时）兜住，
          // 而且落库前会按 crash/memory 白名单再过滤一次。
          '/client/crash-report',
          // 官网内容：未登录的访客必须能看到
          '/site/packages', '/site/faqs', '/site/platforms',
          // 两步验证的第二步：此时还没有会话，靠一次性票据放行
          '/admin/login/totp',
          '/user/captcha', '/user/emailCode', '/user/register', '/user/forgot'
          // 下面这几条曾经在这里，属于**从未实现**的旧项目官网接口：
          //   /order/selectOrderBySerialNumber、/order/checkSharePwd、
          //   /orderDetails/shareOrder、/orderDetails/getOrderFans、
          //   /orderDetails/getTodayFansCount
          //
          // 它们全项目没有任何注册点，留在白名单里只有坏处：将来谁去补实现时，
          // 会看见"它已经在 publicPaths 里了"，于是默认可以不加鉴权 ——
          // 而按序列号查订单这类接口一旦真的公开，就是订单信息泄露。
          // 要用就先实现，再按实际鉴权需求决定要不要加回来。
        ])
        if (publicPaths.has(path)) {
          req.pixPublic = true
          return next()
        }
        if (path.startsWith('/admin/')) {
          const found = await this.resolve(req, 'admin')
          if (!found) throw new ApiError(401, '超管尚未登录', 'ADMIN_AUTH_REQUIRED')
          req.pixAdmin = found.admin
          req.pixSessionType = 'admin'
          // 两步验证是"每个管理员管自己的账号"，不该被角色限制挡住 ——
          // 否则 operator/admin 角色永远无法为自己的账号开启 2FA。
          // 这里只是豁免角色判断，登录态校验照旧（上面已经强制过）。
          if (path === '/admin/totp' || path.startsWith('/admin/totp/')) return next()
          // ★ 角色口径（读代码时别再按旧注释理解）★
          //
          // 原注释只写了"仅限超级管理员"，容易被读成"operator 完全只读"。
          // 真实规则是两层：
          //
          //   1. 命中 superOnly 前缀 → 不管什么方法，非 superadmin 一律 403
          //      （所以 GET /admin/users、/admin/staff、/admin/subs 也挡住）
          //   2. 除此之外 → 非 superadmin 只放行 GET/HEAD，写操作一律 403
          //
          // 也就是：operator 能看大部分列表，但碰不到账号管理与子账号管理，
          // 更不能写。行为由 test/security.test.js 的
          // "operator accounts are read-only" 钉住。
          const superOnly = ['/admin/staff', '/admin/users', '/admin/subs', '/admin/translate/grant']
          if (found.admin.role !== 'superadmin' &&
              (superOnly.some(prefix => path.startsWith(prefix)) || !['GET', 'HEAD'].includes(req.method))) {
            throw new ApiError(403, '该操作仅限超级管理员', 'SUPERADMIN_REQUIRED')
          }
          return next()
        }
        const found = await this.resolve(req, 'user')
        if (!found) throw new ApiError(401, '请先登录', 'AUTH_REQUIRED')
        if ((path.startsWith('/client/') || req.headers['x-pix-device']) &&
            String(found.securitySession.deviceId || '') !== String(req.headers['x-pix-device'] || '')) {
          throw new ApiError(401, '客户端设备凭证无效', 'DEVICE_MISMATCH')
        }
        req.pixUser = found
        req.pixSessionType = 'user'
        next()
      } catch (error) {
        next(error)
      }
    }
  }
}

module.exports = { AuthService, isExpired }
