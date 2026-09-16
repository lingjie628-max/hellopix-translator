'use strict'

/**
 * 超管两步验证（TOTP）业务逻辑。
 *
 * 单独成模块而不塞进 AuthService：这里的状态大多是短期的 Redis 数据
 * （登录中间票据、防重放步长、待确认密钥），和账号密码那套持久化逻辑
 * 不是一回事，混在一起会让两边都难测。
 *
 * 三道防线，缺一不可：
 *   1. 中间票据一次性 —— 密码校验通过后只发一张短期票据，不直接给会话；
 *      票据用 Lua 原子地"取出即删"，重放同一张票据拿不到第二次。
 *   2. 票据有尝试上限 —— 6 位动态码只有 100 万种组合，若不限制次数，
 *      拿到密码的人可以在有效期内穷举。错够次数直接作废票据，
 *      逼回"重新输密码"这一步，而密码那一步是有账号级限流的。
 *   3. 动态码防重放 —— 记录已用过的步长，同一个 30 秒窗口内的码只能用一次，
 *      避免肩窥/截屏拿到后用整个窗口期。
 */

const crypto = require('crypto')
const { ApiError } = require('../lib/http')
const { key, setJson, del, evalScript, positiveInteger } = require('../stores/redis-client')
const totpLib = require('../lib/totp')

const ISSUER = 'Hello Pix'

// 票据取出即删：GET 与 DEL 之间不能有间隙，否则并发下同一张票能用两次
const TAKE_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if not value then return nil end
redis.call('DEL', KEYS[1])
return value
`

// 防重放：只有严格大于上次用过的步长才放行（同窗口重放与更旧的码都会被拒）
const CONSUME_COUNTER_SCRIPT = `
local last = redis.call('GET', KEYS[1])
if last and tonumber(last) >= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1
`

class AdminTotpService {
  constructor(repository, redis, options) {
    if (!repository) throw new TypeError('AdminTotpService 需要 repository')
    if (!redis) throw new TypeError('AdminTotpService 需要 redis')
    const opts = options || {}
    this.repository = repository
    this.redis = redis
    this.ticketTtlMs = positiveInteger(opts.ticketTtlMs, 5 * 60_000)
    this.pendingTtlMs = positiveInteger(opts.pendingTtlMs, 10 * 60_000)
    // 记录已用步长的存活时间要盖住 ±1 步的容差窗口，否则窗口滑走后旧码又能用
    this.replayTtlMs = positiveInteger(opts.replayTtlMs, 3 * 60_000)
    this.maxAttempts = positiveInteger(opts.maxAttempts, 5)
    this.recoveryCount = positiveInteger(opts.recoveryCount, 10)
  }

  /* ------------------------------------------------------------ 登录第二步 */

  /** 密码已通过：发一张短期票据，此时还没有任何会话 */
  async issueLoginTicket(admin) {
    const ticket = crypto.randomBytes(32).toString('base64url')
    await setJson(
      this.redis,
      key('admin-totp-ticket', ticket),
      { adminId: String(admin.id), username: admin.username, attempts: 0 },
      this.ticketTtlMs
    )
    return { ticket, expiresInMs: this.ticketTtlMs }
  }

  async takeTicket(ticket) {
    if (!ticket) return null
    const raw = await evalScript(
      this.redis,
      TAKE_SCRIPT,
      [key('admin-totp-ticket', String(ticket))],
      []
    )
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch (error) {
      return null
    }
  }

  /** 校验失败时把票据放回，但次数加一；超限直接作废 */
  async returnTicket(ticket, payload) {
    const attempts = Number(payload.attempts || 0) + 1
    if (attempts >= this.maxAttempts) {
      await del(this.redis, key('admin-totp-ticket', String(ticket)))
      return { remaining: 0 }
    }
    // 放回时给完整 TTL：票据总寿命由尝试次数兜住（最多 maxAttempts 次即作废）
    await setJson(
      this.redis,
      key('admin-totp-ticket', String(ticket)),
      Object.assign({}, payload, { attempts }),
      this.ticketTtlMs
    )
    return { remaining: this.maxAttempts - attempts }
  }

  /**
   * 完成第二步。code 可以是 6 位动态码，也可以是一次性恢复码。
   * 返回 { admin, usedRecovery }。
   */
  async completeLogin(ticket, code, ip) {
    const payload = await this.takeTicket(ticket)
    if (!payload) {
      throw new ApiError(401, '验证已超时，请重新登录', 'TOTP_TICKET_INVALID')
    }
    const admin = await this.repository.adminById(payload.adminId)
    if (!admin || !admin.totpEnabled) {
      throw new ApiError(401, '验证状态已变化，请重新登录', 'TOTP_STATE_CHANGED')
    }

    const normalized = String(code || '').trim()
    // 恢复码带连字符，动态码是纯数字 —— 据此分流，避免互相干扰
    const looksLikeRecovery = /[A-Za-z-]/.test(normalized)

    if (!looksLikeRecovery) {
      const result = totpLib.verify(admin.totpSecret, normalized)
      if (result.ok && await this.consumeCounter(admin.id, result.counter)) {
        return { admin, usedRecovery: false }
      }
      if (result.ok) {
        // 码是对的但这一步已经用过 —— 明确告知，否则用户会反复重试到票据作废
        await this.repository.recordAdminTotpEvent(admin.id, 'verify_failed', '验证码已被使用过', ip)
        const { remaining } = await this.returnTicket(ticket, payload)
        throw new ApiError(
          401,
          `该验证码刚被使用过，请等验证器刷新出下一个码（剩余 ${remaining} 次机会）`,
          'TOTP_REPLAYED'
        )
      }
    } else {
      const used = await this.repository.consumeAdminRecoveryCode(
        admin.id,
        totpLib.hashRecoveryCode(normalized),
        ip
      )
      if (used) {
        await this.repository.recordAdminTotpEvent(admin.id, 'recovery_used', '使用恢复码登录', ip)
        return { admin, usedRecovery: true }
      }
    }

    await this.repository.recordAdminTotpEvent(admin.id, 'verify_failed', '两步验证码错误', ip)
    const { remaining } = await this.returnTicket(ticket, payload)
    if (remaining <= 0) {
      throw new ApiError(401, '验证码错误次数过多，请重新登录', 'TOTP_TOO_MANY_ATTEMPTS')
    }
    throw new ApiError(401, `验证码不正确，还可尝试 ${remaining} 次`, 'TOTP_INVALID')
  }

  async consumeCounter(adminId, counter) {
    const result = await evalScript(
      this.redis,
      CONSUME_COUNTER_SCRIPT,
      [key('admin-totp-counter', adminId)],
      [counter, this.replayTtlMs]
    )
    return Number(result) === 1
  }

  /* ------------------------------------------------------------ 开启与关闭 */

  async status(admin) {
    const remaining = admin.totpEnabled
      ? await this.repository.countAdminRecoveryCodes(admin.id)
      : 0
    return {
      enabled: !!admin.totpEnabled,
      confirmedAt: admin.totpConfirmedAt || null,
      recoveryRemaining: remaining
    }
  }

  /**
   * 生成待确认的密钥。**先不写库**，只放 Redis：
   * 没被动态码确认过的密钥写进库里毫无意义，反而会留下半配置状态。
   */
  async beginSetup(admin) {
    if (admin.totpEnabled) {
      throw new ApiError(400, '两步验证已开启，如需重置请先关闭', 'TOTP_ALREADY_ENABLED')
    }
    const { base32 } = totpLib.generateSecret()
    await setJson(this.redis, key('admin-totp-pending', admin.id), { secret: base32 }, this.pendingTtlMs)
    return {
      secret: base32,
      // 手输时按 4 位分组更好抄
      secretGrouped: base32.replace(/(.{4})/g, '$1 ').trim(),
      otpauth: totpLib.otpauthUrl({ secret: base32, account: admin.username, issuer: ISSUER }),
      issuer: ISSUER,
      digits: totpLib.DEFAULT_DIGITS,
      period: totpLib.DEFAULT_STEP
    }
  }

  /** 用一次正确的动态码确认开启，并一次性下发恢复码 */
  async enable(admin, code, ip) {
    if (admin.totpEnabled) {
      throw new ApiError(400, '两步验证已开启', 'TOTP_ALREADY_ENABLED')
    }
    const pending = await this.redis.get(key('admin-totp-pending', admin.id))
    let secret = ''
    if (pending) {
      try {
        secret = JSON.parse(pending).secret
      } catch (error) {
        secret = ''
      }
    }
    if (!secret) {
      throw new ApiError(400, '密钥已过期，请重新获取', 'TOTP_NOT_STARTED')
    }

    const result = totpLib.verify(secret, code)
    if (!result.ok) {
      await this.repository.recordAdminTotpEvent(admin.id, 'verify_failed', '开启两步验证时验证码错误', ip)
      throw new ApiError(400, '验证码不正确，请确认验证器里的 6 位数字', 'TOTP_INVALID')
    }

    const recoveryCodes = totpLib.generateRecoveryCodes(this.recoveryCount)
    await this.repository.enableAdminTotp(
      admin.id,
      secret,
      recoveryCodes.map(totpLib.hashRecoveryCode)
    )
    // 刻意**不**消费防重放计数器：这里用掉的是"刚生成给用户扫码的那个码"，
    // 而计数器与登录共用。一旦消费，用户开启完 2FA 立刻重新登录就会被告知
    // "该验证码已被使用"，得干等一个 30 秒窗口 —— 实测踩到过。
    // 开启动作本身发生在已登录会话里，消费它换不来任何安全收益。
    await del(this.redis, key('admin-totp-pending', admin.id))
    await this.repository.recordAdminTotpEvent(admin.id, 'enabled', '开启两步验证', ip)
    return { recoveryCodes }
  }

  /** 关闭需要当前动态码或一个未用的恢复码，防止会话被盗后直接关掉 2FA */
  async disable(admin, code, ip) {
    if (!admin.totpEnabled) {
      throw new ApiError(400, '两步验证未开启', 'TOTP_NOT_ENABLED')
    }
    const normalized = String(code || '').trim()
    let ok = false
    let replayed = false
    if (/[A-Za-z-]/.test(normalized)) {
      ok = await this.repository.consumeAdminRecoveryCode(
        admin.id, totpLib.hashRecoveryCode(normalized), ip
      )
    } else {
      const result = totpLib.verify(admin.totpSecret, normalized)
      if (result.ok) {
        ok = await this.consumeCounter(admin.id, result.counter)
        replayed = !ok
      }
    }
    if (!ok) {
      await this.repository.recordAdminTotpEvent(admin.id, 'verify_failed', '关闭两步验证时校验失败', ip)
      // 关闭是高危操作，故意要求一个"尚未用过"的码：会话被劫持时，
      // 攻击者无法拿用户刚用过的那个码直接把 2FA 关掉。
      throw new ApiError(
        400,
        replayed ? '该验证码刚被使用过，请等验证器刷新出下一个码' : '验证码不正确',
        replayed ? 'TOTP_REPLAYED' : 'TOTP_INVALID'
      )
    }
    await this.repository.disableAdminTotp(admin.id)
    await this.repository.recordAdminTotpEvent(admin.id, 'disabled', '关闭两步验证', ip)
    return true
  }

  async regenerateRecovery(admin, code, ip) {
    if (!admin.totpEnabled) {
      throw new ApiError(400, '两步验证未开启', 'TOTP_NOT_ENABLED')
    }
    const normalized = String(code || '').trim()
    const result = totpLib.verify(admin.totpSecret, normalized)
    const ok = result.ok && await this.consumeCounter(admin.id, result.counter)
    if (!ok) throw new ApiError(400, '验证码不正确', 'TOTP_INVALID')

    const recoveryCodes = totpLib.generateRecoveryCodes(this.recoveryCount)
    await this.repository.regenerateAdminRecoveryCodes(
      admin.id,
      recoveryCodes.map(totpLib.hashRecoveryCode)
    )
    await this.repository.recordAdminTotpEvent(admin.id, 'recovery_regenerated', '重新生成恢复码', ip)
    return { recoveryCodes }
  }
}

module.exports = {
  AdminTotpService,
  ISSUER,
  // 导出脚本原文，供部署时的真 Redis 验证脚本使用同一份文本 ——
  // 复制一份到别处校验等于没校验（改了一处忘了另一处就会失真）。
  scripts: { TAKE_SCRIPT, CONSUME_COUNTER_SCRIPT }
}
