/**
 * 邮件发送。
 *
 * 注册、找回密码都依赖它 —— 没有邮件服务，这两个功能就是空壳。
 *
 * 设计取舍：**用 SMTP 而不是各家厂商的 HTTP API**。
 * 阿里云邮件推送、腾讯云 SES、SendGrid、Mailgun 全都提供 SMTP 入口，
 * 一套实现能对接全部；换成 HTTP API 就要为每家写一个适配器，
 * 而它们的差异其实只在认证方式上，SMTP 已经把这层抹平了。
 *
 * 安全上有一条必须守住：**邮件内容里的任何用户输入都要转义**。
 * 注册时用户名是用户可控的，直接拼进 HTML 就是钓鱼邮件的现成载体
 * （攻击者注册一个叫 `<a href="evil">点这里</a>` 的用户名，
 * 系统发出去的验证邮件就成了他发的钓鱼信）。
 */

let nodemailer = null
try { nodemailer = require('nodemailer') } catch (e) { nodemailer = null }

/** HTML 转义。邮件正文里所有插值都必须过一遍。 */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * app_settings 的键是**扁平点号键**（`'mail.smtp'`），不是嵌套对象。
 *
 * repo.settings() 的返回值长这样：`{ 'mail.smtp': {...}, 'site.name': '...' }`。
 * 这里曾经写成 `settings.mail.smtp`（嵌套读法），结果永远是 undefined ——
 * 配置存进去了也读不出来，`configured` 恒为 false，注册接口恒返回 503。
 * 全库统一的读法是 core-service 的 `setting(settings, 'a.b', fallback)`，此处保持一致。
 */
function setting(settings, key, fallback) {
  const value = settings ? settings[key] : undefined
  return value === undefined || value === null ? fallback : value
}

/** 同上，但保证拿到的是对象（jsonb 偶发以字符串形态返回时兜一下）。 */
function objectSetting(settings, key, fallback) {
  const value = setting(settings, key, fallback)
  if (value && typeof value === 'object') return value
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch (_error) { return fallback }
  }
  return fallback
}

/** 从后台设置里读出 SMTP 配置。缺任何必填项就视为未配置。 */
function readConfig(settings) {
  const raw = objectSetting(settings, 'mail.smtp', {})
  const host = String(raw.host || '').trim()
  const user = String(raw.user || '').trim()
  const pass = String(raw.pass || '').trim()
  const from = String(raw.from || '').trim()
  const port = Number(raw.port) || 465
  const secure = raw.secure === undefined ? port === 465 : raw.secure === true
  const configured = !!(host && user && pass && from && nodemailer)
  return {
    configured,
    host, port, secure, user, pass, from,
    fromName: String(raw.fromName || 'Hello Pix').trim(),
    // 为什么没配好，要能说清楚 —— 否则后台只会显示"未配置"，没人知道缺哪个
    missing: [
      !nodemailer && 'nodemailer 未安装',
      !host && 'SMTP 服务器',
      !user && '账号',
      !pass && '密码/授权码',
      !from && '发件地址'
    ].filter(Boolean)
  }
}

/** 运维告警收件地址。它和 SMTP 分开存：SMTP 还没配好时也要能收告警。 */
function readAlertTo(settings) {
  return String(setting(settings, 'mail.alert_to', '') || '').trim()
}

/**
 * SMTP 错误码 → 人话。
 *
 * nodemailer 把底层错误原样抛出来，`err.message` 里可能带着服务器应答，
 * 甚至带认证信息。所以这里做两件事：**给出可执行的判断**、**把敏感信息洗掉**。
 */
const SMTP_ERROR_REASONS = {
  EAUTH: '认证被拒绝：账号或 API Key 不正确，或该账号没有发信权限',
  ECONNECTION: '连不上 SMTP 服务器：主机名或端口不对，或被网络/防火墙拦截',
  ESOCKET: '连接被中断：端口与加密方式不匹配（465 要开 SSL，587 要关 SSL 走 STARTTLS）',
  ETIMEDOUT: '连接超时：主机不可达或端口被拦',
  EDNS: 'SMTP 主机名解析失败：域名拼错了',
  EENVELOPE: '信封被拒绝：发件地址或收件地址不被服务器接受（发件域名通常需要先完成 SPF/DKIM 验证）',
  EMESSAGE: '邮件内容被服务器拒绝',
  ENOEMAIL: 'SMTP 没有返回有效响应',
  MAIL_NOT_CONFIGURED: '邮件服务尚未配置'
}

/**
 * 把异常翻译成 `{ code, reason, detail }`。
 * `secrets` 传入本次用到的口令，命中就替换成 ***。
 */
function describeSmtpError(err, secrets) {
  const code = String((err && err.code) || 'SMTP_ERROR')
  const reason = SMTP_ERROR_REASONS[code] || 'SMTP 发送失败'
  let detail = String((err && err.message) || err || '')
  ;(secrets || []).forEach(secret => {
    const value = String(secret || '')
    // 太短的串不做替换，否则会把正常文本打满星号
    if (value.length >= 4) detail = detail.split(value).join('***')
  })
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 300)
  return { code, reason, detail }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validEmail(value) {
  return EMAIL_PATTERN.test(String(value || '').trim())
}

class Mailer {
  constructor(repo) {
    this.repo = repo
  }

  async config() {
    const settings = await this.repo.settings()
    return readConfig(settings)
  }

  async configured() {
    return (await this.config()).configured
  }

  transport(cfg) {
    return nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      // 超时必须有：SMTP 服务器无响应时不能让注册请求一直挂着
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000
    })
  }

  async send(to, subject, html, text) {
    const cfg = await this.config()
    if (!cfg.configured) {
      const err = new Error('邮件服务尚未配置：' + cfg.missing.join('、'))
      err.code = 'MAIL_NOT_CONFIGURED'
      throw err
    }
    const info = await this.transport(cfg).sendMail({
      from: cfg.fromName ? `"${cfg.fromName}" <${cfg.from}>` : cfg.from,
      to,
      subject,
      text: text || html.replace(/<[^>]+>/g, ''),
      html
    })
    return { messageId: info && info.messageId, accepted: (info && info.accepted) || [] }
  }

  /** 后台"测试发信"用。任何失败都不抛异常，一律返回结构化结果。 */
  /**
   * 把「连接」「认证」「投递」三步分开报。
   *
   * 只回一句"失败"等于没说 —— 排障时最需要知道的恰恰是卡在哪一步。
   * 早期版本这里是 `verify()` + 一个吞掉异常的 try/catch，
   * 结果后台只能看到一句原始报错，既分不清成因，也可能带出服务器应答里的敏感信息。
   */
  async sendTest(to) {
    const cfg = await this.config()
    if (!cfg.configured) {
      return {
        ok: false, stage: 'config', code: 'MAIL_NOT_CONFIGURED',
        msg: '邮件服务尚未配置，缺少：' + cfg.missing.join('、'),
        missing: cfg.missing
      }
    }
    if (!validEmail(to)) {
      return { ok: false, stage: 'input', code: 'BAD_EMAIL', msg: '收件邮箱格式不正确' }
    }

    const transporter = this.transport(cfg)

    try {
      await transporter.verify()
    } catch (e) {
      const d = describeSmtpError(e, [cfg.pass])
      return {
        ok: false, stage: 'connect', code: d.code,
        msg: `连接或认证失败（${d.code}）：${d.reason}`, detail: d.detail
      }
    }

    try {
      const mail = this.testMail()
      const info = await transporter.sendMail({
        from: cfg.fromName ? `"${cfg.fromName}" <${cfg.from}>` : cfg.from,
        to,
        subject: mail.subject,
        text: mail.html.replace(/<[^>]+>/g, ''),
        html: mail.html
      })
      const accepted = (info && info.accepted) || []
      if (!accepted.length) {
        // 连接与认证都过了、但收件人没被接受 —— 多半是发件域名没验证
        return {
          ok: false, stage: 'deliver', code: 'SMTP_NOT_ACCEPTED',
          msg: 'SMTP 接受了连接，但拒绝投递该收件人',
          detail: String((info && info.response) || '').slice(0, 300)
        }
      }
      return {
        ok: true, stage: 'done', code: 'OK',
        msg: `测试邮件已投递至 ${to}`,
        messageId: (info && info.messageId) || '',
        accepted
      }
    } catch (e) {
      const d = describeSmtpError(e, [cfg.pass])
      return {
        ok: false, stage: 'deliver', code: d.code,
        msg: `投递失败（${d.code}）：${d.reason}`, detail: d.detail
      }
    }
  }

  // -------------------------------------------------------------------------
  // 邮件模板。所有插值都走 esc()。
  // -------------------------------------------------------------------------

  /**
   * 后台「发送测试邮件」用的模板。
   *
   * 刻意**不含任何验证码**：早期版本直接复用了验证码模板（正文里是 000000），
   * 结果测试信长得和真实验证信一模一样 —— 收件人容易把 000000 当成真码去输，
   * 也分不清这封到底是在测什么。测试信就该一眼看出是测试信。
   */
  testMail() {
    return {
      subject: '【Hello Pix】邮件服务测试（无需操作）',
      html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1f2328">
  <h2 style="margin:0 0 16px;font-size:18px">Hello Pix</h2>
  <p style="margin:0 0 12px;line-height:1.7">这是一封<strong>测试邮件</strong>，用来确认邮件服务已经配好。</p>
  <p style="margin:0 0 8px;line-height:1.7;color:#5b6675">你看到它，就说明 SMTP 连接、认证、投递三步都通了，注册与找回密码的发信通道可用。</p>
  <p style="margin:0 0 16px;line-height:1.7;color:#5b6675"><strong>本邮件不包含验证码，不需要做任何操作。</strong></p>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
  <p style="margin:0;font-size:12px;color:#8a94a3">本邮件由系统自动发送，请勿直接回复。</p>
</div>`
    }
  }

  verificationMail(code, scene, siteName) {
    const name = esc(siteName || 'Hello Pix')
    const purpose = scene === 'forgot' ? '重置密码' : '注册账号'
    const safeCode = esc(code)
    return {
      subject: `【${name}】${purpose}验证码：${safeCode}`,
      html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1f2328">
  <h2 style="margin:0 0 16px;font-size:18px">${name}</h2>
  <p style="margin:0 0 12px;line-height:1.7">你正在${purpose}，验证码是：</p>
  <p style="margin:0 0 16px;font-size:30px;font-weight:700;letter-spacing:6px;color:#2563eb">${safeCode}</p>
  <p style="margin:0 0 8px;line-height:1.7;color:#5b6675">验证码 10 分钟内有效，只能使用一次。</p>
  <p style="margin:0;line-height:1.7;color:#5b6675">如果这不是你本人操作，忽略本邮件即可，你的账号不会受到影响。</p>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
  <p style="margin:0;font-size:12px;color:#8a94a3">本邮件由系统自动发送，请勿直接回复。</p>
</div>`
    }
  }
}

module.exports = {
  Mailer, readConfig, readAlertTo, esc,
  describeSmtpError, validEmail, setting, objectSetting,
  SMTP_ERROR_REASONS
}
