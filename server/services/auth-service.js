'use strict'

const { ApiError } = require('../lib/http')
const password = require('../lib/password')

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
      throw new ApiError(400, '密码需为 10-128 位，并同时包含字母和数字', 'WEAK_PASSWORD')
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
    if (session.parent.expiresAt && new Date(session.parent.expiresAt).getTime() <= Date.now()) {
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

  async loginAdmin(req, res, data) {
    const username = String(data.username || '').trim()
    const admin = username.length <= 64
      ? await this.repository.adminByUsername(username)
      : null
    if (!admin || !(await this.verify(admin.passwordHash, data.password))) {
      await this.recordLoginFailure(req, username, 'admin', 'BAD_CREDENTIALS')
      throw new ApiError(401, '超管账号或密码错误', 'BAD_CREDENTIALS')
    }
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
    await this.repository.audit(null, admin, '登录超管后台', '', req.ip)
    return admin
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
    return Object.assign({ securitySession }, session)
  }

  middleware() {
    return async (req, res, next) => {
      try {
        const path = String(req.path || '').replace(/\/+$/, '') || '/'
        const publicPaths = new Set([
          '/site/info', '/client/lines', '/login', '/client/login', '/admin/login',
          '/user/captcha', '/user/emailCode', '/user/register', '/user/forgot',
          '/order/selectOrderBySerialNumber', '/order/checkSharePwd',
          '/orderDetails/shareOrder', '/orderDetails/getOrderFans', '/orderDetails/getTodayFansCount'
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

module.exports = { AuthService }
