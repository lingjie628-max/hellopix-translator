/**
 * 注册、找回密码、邮箱验证码。
 *
 * 这三条之前是 stub —— 新商户一个都注册不了，官网的「立即免费注册」
 * 点下去只会拿到 NOT_MIGRATED。这是上线最硬的阻塞项。
 *
 * ## 几个刻意的决定
 *
 * 1. **注册必须绑定邮箱**（产品负责人明确要求）。邮箱经验证码确认后才写入，
 *    `email_verified = true`。这不是形式：找回密码唯一的自主途径就是邮箱，
 *    不绑邮箱的账号一忘密码就只能人工介入。
 *
 * 2. **找回密码不透露邮箱是否存在**。无论邮箱在不在库里，
 *    都返回同一句话。否则这个接口就成了"批量探测哪些邮箱注册过"的工具。
 *    真正的失败只体现在收不到邮件上 —— 这是有意的取舍。
 *
 * 3. **注册不发试用字符**。试用额度由后台的 `registration.trial_chars` 控制，
 *    默认 0。给多少是运营决定，不该写死在代码里。
 *
 * 4. **图形验证码与邮箱验证码都要**。前者挡机器人刷接口，
 *    后者证明邮箱归属。只留一个都不够：只有图形码挡不住人工批量注册，
 *    只有邮箱码则会把邮件服务变成免费发信机。
 */

const { ApiError } = require('../lib/http')
const { VerificationService } = require('./verification-service')
const { Mailer, setting: settingOf } = require('../lib/mailer')

// 复用 lib/password 的 validPassword，而不是在这里另写一套 ——
// 两套规则一旦分叉，就会出现"注册时说密码合法、登录时被拒"的怪事。
const { validPassword } = require('../lib/password')

function assertPassword(pwd, pwd2) {
  if (!validPassword(pwd)) {
    throw new ApiError(400, '密码需 6-128 位', 'WEAK_PASSWORD')
  }
  if (pwd2 !== undefined && String(pwd) !== String(pwd2 || '')) {
    throw new ApiError(400, '两次输入的密码不一致', 'PASSWORD_MISMATCH')
  }
}

function normalizeEmail(raw) {
  const v = String(raw || '').trim().toLowerCase()
  // 长度上限按 RFC 5321；格式只做基本校验 —— 过严的正则会误杀合法地址
  if (!v || v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    throw new ApiError(400, '邮箱格式不正确', 'BAD_EMAIL')
  }
  return v
}

class AccountService {
  constructor(repo, auth, redis, options) {
    this.repo = repo
    this.auth = auth
    this.redis = redis
    this.options = options || {}
    this.mailer = new Mailer(repo)
    this.verification = new VerificationService(redis, (options && options.redisPrefix) || 'pix')
  }

  // -------------------------------------------------------------------------
  // 发验证码
  // -------------------------------------------------------------------------

  async sendEmailCode(data, ctx) {
    const email = normalizeEmail(data.email)
    const scene = data.scene === 'forgot' ? 'forgot' : 'register'

    // 这里**刻意不校验图形验证码**。
    //
    // 原先要求先填图形验证码才能拿邮箱验证码，结果是大多数商户根本不知道
    // 要先填那一格 —— 点「获取验证码」永远得到「图形验证码已过期」，注册卡死。
    // 图形验证码现在只在**真正建号 / 改密**（register / forgot）时才要，
    // 那是必须拦住的写操作；"发一封信"不该设这道门槛。
    //
    // 发信仍有两道限流兜底，不会变成免费发信机：
    //   · 路由层 emailCodeLimit：同一 IP 10 次 / 10 分钟
    //   · 下面 verification.canSend：按邮箱 60 秒冷却 + 邮箱/IP 配额

    const mailReady = await this.mailer.configured()
    if (!mailReady) {
      throw new ApiError(503, '邮件服务尚未配置，请联系客服', 'MAIL_NOT_CONFIGURED')
    }

    const gate = await this.verification.canSend(email, ctx && ctx.ip)
    if (!gate.ok) {
      if (gate.reason === 'TOO_FREQUENT') {
        throw new ApiError(429, '发送太频繁，请稍后再试', 'TOO_FREQUENT')
      }
      throw new ApiError(429, '发送次数已达上限，请稍后再试', 'SEND_LIMIT')
    }

    const code = VerificationService.generate()
    const settings = await this.repo.settings()
    // 键是扁平的 'site.name' —— 写成 settings.site.name 会永远取不到，静默退回默认值
    const siteName = String(settingOf(settings, 'site.name', '') || '').trim() || 'Hello Pix'
    const mail = this.mailer.verificationMail(code, scene, siteName)

    // 先发信成功、再落验证码：反过来的话 SMTP 挂掉会留下"已发送"的假象，
    // 用户拿着永远收不到的码反复重试，系统还在限流他
    await this.mailer.send(email, mail.subject, mail.html)
    await this.verification.issue(email, scene, code)
    await this.verification.bumpIp(ctx && ctx.ip)

    return { ok: true, msg: '验证码已发送，请查收邮件', masked: VerificationService.mask(email) }
  }

  // -------------------------------------------------------------------------
  // 注册
  // -------------------------------------------------------------------------

  async register(data) {
    const username = String(data.userName || data.username || '').trim()
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
      throw new ApiError(400, '账号需为 3-32 位字母、数字或下划线', 'BAD_USERNAME')
    }
    const email = normalizeEmail(data.email)
    assertPassword(data.passWord || data.password, data.passWord1)

    await this.consumeCaptcha(data)

    // 先查重再验码：验证码是一次性的，若先验码再因重名失败，
    // 用户得重新收一次码才能改用户名 —— 体验很差
    if (await this.repo.userByUsername(username)) {
      throw new ApiError(409, '该账号已被注册', 'USERNAME_TAKEN')
    }
    if (await this.repo.userByEmail(email)) {
      throw new ApiError(409, '该邮箱已被注册', 'EMAIL_TAKEN')
    }

    const check = await this.verification.verify(email, 'register', data.code)
    if (!check.ok) throw new ApiError(400, this.codeMessage(check), check.reason)

    const trialChars = await this.trialChars()
    const created = await this.repo.createUser({
      username,
      password: data.passWord || data.password,
      email,
      nickname: username,
      charBalance: trialChars
    })
    return {
      ok: true,
      msg: trialChars > 0 ? `注册成功，已赠送 ${trialChars} 字符` : '注册成功',
      userId: created && created.id
    }
  }

  // -------------------------------------------------------------------------
  // 找回密码
  // -------------------------------------------------------------------------

  async forgot(data) {
    const email = normalizeEmail(data.email)
    assertPassword(data.passWord || data.password, data.passWord1)

    await this.consumeCaptcha(data)

    const check = await this.verification.verify(email, 'forgot', data.code)

    const account = await this.repo.userByEmail(email)
    // **不区分"码错"和"邮箱不存在"**：一旦区分，这个接口就成了
    // "批量探测哪些邮箱注册过"的工具。所以两种情况给同一句话。
    // 真正的失败只体现在收不到邮件上。
    if (!check.ok || !account) {
      if (!check.ok && check.reason !== 'CODE_MISMATCH' && check.reason !== 'CODE_EXPIRED') {
        throw new ApiError(400, this.codeMessage(check), check.reason)
      }
      throw new ApiError(400, '验证码不正确或已过期', 'RESET_FAILED')
    }

    await this.repo.updateUserPassword(account.id, data.passWord || data.password)
    // 改密码后必须踢掉所有旧会话 —— 否则"找回密码"防不住已经登录的攻击者。
    // auth.revokeUser(kind, id) 内部走 security.revokeSubject，会清 Redis 里的会话。
    if (this.auth && typeof this.auth.revokeUser === 'function') {
      await this.auth.revokeUser('main', account.id)
    }
    return { ok: true, msg: '密码已重置，请用新密码登录' }
  }

  // -------------------------------------------------------------------------

  /**
   * 图形验证码校验。失败直接抛 400。
   *
   * 错误码透传 lib/captcha 给的值（CAPTCHA_EXPIRED / CAPTCHA_INVALID），
   * 前端据此决定「自动换一张图」还是「提示重填」—— 以前统一叫
   * CAPTCHA_FAILED，前端除了弹一句话什么也做不了。
   */
  async consumeCaptcha(data) {
    const captcha = require('../lib/captcha')
    const check = await captcha.consume(this.redis, data.imageId, data.imageCode)
    if (!check.ok) throw new ApiError(400, check.message, check.code)
  }

  codeMessage(check) {
    if (check.reason === 'CODE_EXPIRED') return '验证码已过期，请重新获取'
    if (check.reason === 'TOO_MANY_ATTEMPTS') return '错误次数过多，请重新获取验证码'
    if (check.reason === 'CODE_MISMATCH') {
      return check.left > 0 ? `验证码不正确，还可尝试 ${check.left} 次` : '验证码不正确'
    }
    return '验证码不正确'
  }

  async trialChars() {
    const raw = await this.repo.setting('registration.trial_chars')
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
}

module.exports = { AccountService, assertPassword, normalizeEmail }
