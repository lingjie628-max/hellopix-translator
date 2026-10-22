/**
 * 邮箱验证码。
 *
 * 这是注册与找回密码的唯一凭证，三个安全问题必须同时解决：
 *
 * 1. **防爆破** —— 6 位数字只有 100 万种，不限制尝试次数的话
 *    几分钟就能撞出来。所以「尝试次数」和「有效期」两个限制缺一不可。
 *
 * 2. **防滥用发信** —— 接口公开，不限制的话会被当成免费发信机，
 *    轻则烧钱、重则发件域名被拉黑（连带正常验证邮件全进垃圾箱）。
 *    所以对「邮箱」和「IP」两个维度都限流。
 *
 * 3. **场景隔离** —— 注册的码不能用来重置密码。否则攻击者用自己邮箱
 *    走注册流程拿到码，再拿去重置别人的密码（如果真的撞上了）。
 *    场景拼进 Redis key，天然隔离。
 *
 * 另外：**验证码不落明文日志**。日志里只记邮箱的掩码与场景。
 */

const crypto = require('crypto')
const { PREFIX } = require('../stores/redis-client')

const CODE_TTL_SECONDS = 600          // 10 分钟
const SEND_INTERVAL_SECONDS = 60      // 同一邮箱 60 秒内只能发一次
const SEND_HOURLY_LIMIT = 8           // 同一邮箱每小时最多 8 封
const IP_HOURLY_LIMIT = 30            // 同一 IP 每小时最多 30 封
const MAX_ATTEMPTS = 5                // 同一验证码最多试 5 次

class VerificationService {
  constructor(redis, prefix) {
    this.redis = redis
    // 前缀必须与 stores/redis-client 同源。
    //
    // 这里原先写 `prefix || 'pix'`，而 ioredis 又配了 `keyPrefix: 'pix:'`，
    // 线上键实际是 `pix:pix:verify:...`。改由 redis-client 统一提供后，
    // 传入的 prefix 只需是空串即可（它会带尾部冒号，这里去掉再拼）。
    const base = prefix === undefined ? PREFIX : String(prefix || '')
    this.prefix = base ? base.replace(/:+$/, '') : ''
  }

  key(kind, ...parts) {
    return (this.prefix ? this.prefix + ':' : '') + ['verify', kind, ...parts].join(':')
  }

  /** 掩码后的邮箱，仅用于日志与提示，避免明文进日志 */
  static mask(email) {
    const v = String(email || '')
    const at = v.indexOf('@')
    if (at <= 1) return '***'
    return v.slice(0, 1) + '***' + v.slice(at)
  }

  /** 6 位数字，用 CSPRNG —— Math.random 可预测，不能用于凭证 */
  static generate() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
  }

  /**
   * 检查是否可以发送。返回 `{ ok, reason, retryAfter }`。
   * **只读检查**，不做写入 —— 这样"检查通过但发信失败"时不会白白占用配额。
   */
  async canSend(email, ip) {
    const last = await this.redis.get(this.key('last', email))
    if (last) return { ok: false, reason: 'TOO_FREQUENT', retryAfter: SEND_INTERVAL_SECONDS }

    const mailCount = Number(await this.redis.get(this.key('quota-mail', email)) || 0)
    if (mailCount >= SEND_HOURLY_LIMIT) return { ok: false, reason: 'MAIL_HOURLY_LIMIT' }

    if (ip) {
      const ipCount = Number(await this.redis.get(this.key('quota-ip', ip)) || 0)
      if (ipCount >= IP_HOURLY_LIMIT) return { ok: false, reason: 'IP_HOURLY_LIMIT' }
    }
    return { ok: true }
  }

  /**
   * 发信成功后调用，落库并占用配额。
   *
   * 顺序很重要：**先发信成功、再写验证码**。
   * 反过来的话，SMTP 挂掉时会留下一个"已发送"的假象，
   * 用户拿着永远收不到的码反复重试，而系统还在限流他。
   */
  async issue(email, scene, code) {
    await this.redis.set(this.key('code', scene, email), code, 'EX', CODE_TTL_SECONDS)
    await this.redis.set(this.key('attempt', scene, email), '0', 'EX', CODE_TTL_SECONDS)
    await this.redis.set(this.key('last', email), '1', 'EX', SEND_INTERVAL_SECONDS)
    await this.bumpQuota(this.key('quota-mail', email))
    return true
  }

  /**
   * 小时配额计数。
   *
   * 用 INCR + 首次设过期，而不是"固定窗口"（比如整点清零）——
   * 固定窗口有个经典漏洞：在窗口边界两侧各打满一次配额，
   * 短时间内实际能发两倍。INCR 的滑动语义没有这个问题。
   */
  async bumpQuota(key) {
    const n = await this.redis.incr(key)
    if (n === 1) await this.redis.expire(key, 3600)
    return n
  }

  async bumpIp(ip) {
    if (!ip) return
    await this.bumpQuota(this.key('quota-ip', ip))
  }

  /**
   * 校验验证码。**成功后立即删除**（一次性），失败则累加尝试次数。
   *
   * 尝试次数用「读-改-写」的近似实现：并发下可能多试一两次，
   * 但对 6 位码来说 5 次与 7 次的差别可以忽略，不值得为它上分布式锁。
   */
  async verify(email, scene, code) {
    const codeKey = this.key('code', scene, email)
    const attemptKey = this.key('attempt', scene, email)

    const saved = await this.redis.get(codeKey)
    if (!saved) return { ok: false, reason: 'CODE_EXPIRED' }

    const attempts = Number(await this.redis.get(attemptKey) || 0)
    if (attempts >= MAX_ATTEMPTS) {
      await this.redis.del(codeKey)
      return { ok: false, reason: 'TOO_MANY_ATTEMPTS' }
    }

    // 定长比较，避免时序侧信道（虽然 6 位数字的时序攻击不现实，但这是习惯）
    const a = Buffer.from(String(code || ''))
    const b = Buffer.from(String(saved))
    const same = a.length === b.length && crypto.timingSafeEqual(a, b)

    if (!same) {
      const n = await this.redis.incr(attemptKey)
      if (n === 1) await this.redis.expire(attemptKey, CODE_TTL_SECONDS)
      // 用完最后一次就**当场作废**，而不是留到下一次请求才判。
      // 差别在用户体验：前者第 5 次就明确告知"次数已用尽，请重新获取"，
      // 后者会返回一个 left=0 的"还有 0 次机会"，用户得再点一次才知道被锁。
      if (n >= MAX_ATTEMPTS) {
        await this.redis.del(codeKey)
        await this.redis.del(attemptKey)
        return { ok: false, reason: 'TOO_MANY_ATTEMPTS' }
      }
      return { ok: false, reason: 'CODE_MISMATCH', left: MAX_ATTEMPTS - n }
    }

    // 一次性：用过就删，防止同一个码重复提交
    await this.redis.del(codeKey)
    await this.redis.del(attemptKey)
    return { ok: true }
  }
}

module.exports = {
  VerificationService,
  CODE_TTL_SECONDS,
  SEND_INTERVAL_SECONDS,
  MAX_ATTEMPTS
}
