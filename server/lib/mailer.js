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

/** 从后台设置里读出 SMTP 配置。缺任何必填项就视为未配置。 */
function readConfig(settings) {
  const raw = (settings && settings.mail && settings.mail.smtp) || {}
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

  /** 后台"测试发信"用：直接把结果返回给管理员，不吞异常。 */
  async verify() {
    const cfg = await this.config()
    if (!cfg.configured) return { ok: false, msg: '尚未配置：' + cfg.missing.join('、') }
    try {
      await this.transport(cfg).verify()
      return { ok: true, msg: 'SMTP 连接正常' }
    } catch (e) {
      return { ok: false, msg: String((e && e.message) || e) }
    }
  }

  // -------------------------------------------------------------------------
  // 邮件模板。所有插值都走 esc()。
  // -------------------------------------------------------------------------

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

module.exports = { Mailer, readConfig, esc }
