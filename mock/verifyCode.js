/**
 * 验证码接口板块。
 * 对外形态对齐官网：GET /user/captcha、POST /user/emailCode。
 * 图形验证码现用本地 SVG；邮件现为本地演示。
 * 后续接入：在 emailProviders.smtp.send（或其它 provider）里真正发信即可。
 */

const crypto = require('crypto')
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const emailProviders = {
  local: {
    name: '本地演示',
    send: function () {
      return { ok: true, demo: true }
    }
  },
  smtp: {
    name: 'SMTP',
    send: function (cfg) {
      if (!cfg.smtpHost || !cfg.smtpUser || !cfg.smtpPass) {
        return { ok: false, msg: '请先填写 SMTP 主机、账号和密码' }
      }
      // 后续接入：用 smtpHost / smtpPort / smtpUser / smtpPass / smtpFrom 发信
      return { ok: false, msg: 'SMTP 发送尚未接入' }
    }
  }
}

function defaultConfig() {
  return {
    captcha: {
      id: 'captcha',
      name: '图形验证码',
      provider: 'local',
      expireMin: 5,
      length: 4,
      endpoint: '',
      apiKey: '',
      note: '本地干扰图验，字段与官网一致（imageId / image）。后续可换第三方图验。'
    },
    email: {
      id: 'email',
      name: '邮箱验证码',
      provider: 'local',
      expireMin: 10,
      length: 6,
      resendSeconds: 60,
      revealDemo: 1,
      smtpHost: '',
      smtpPort: 465,
      smtpSecure: 1,
      smtpUser: '',
      smtpPass: '',
      smtpFrom: '',
      endpoint: '',
      apiKey: '',
      secret: '',
      note: '本地演示会在提示里带出验证码。填好 SMTP 后，在本模块 smtp.send 接入即可发信。'
    }
  }
}

function createStore() {
  return { captchas: {}, emailCodes: {}, lastSend: {} }
}

function validEmail(email) {
  return EMAIL_RE.test(String(email || '').trim())
}

function normEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function randChars(source, length) {
  let out = ''
  for (let i = 0; i < length; i++) out += source[crypto.randomInt(0, source.length)]
  return out
}

function randInt(min, max) {
  return crypto.randomInt(min, max + 1)
}

function randColor(alpha) {
  return 'rgba(' + randInt(20, 160) + ',' + randInt(20, 160) + ',' + randInt(20, 160) + ',' + (alpha || 0.55) + ')'
}

function createCaptchaSvg(code) {
  const w = 120
  const h = 42
  const parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">',
    '<rect width="' + w + '" height="' + h + '" fill="#eef3fb"/>'
  ]
  for (let i = 0; i < 6; i++) {
    parts.push(
      '<line x1="' + randInt(0, w) + '" y1="' + randInt(0, h) +
      '" x2="' + randInt(0, w) + '" y2="' + randInt(0, h) +
      '" stroke="' + randColor(0.45) + '" stroke-width="' + (Math.random() * 1.4 + 0.6).toFixed(1) + '"/>'
    )
  }
  for (let i = 0; i < 28; i++) {
    parts.push(
      '<circle cx="' + randInt(2, w - 2) + '" cy="' + randInt(2, h - 2) +
      '" r="' + (Math.random() * 1.2 + 0.4).toFixed(1) + '" fill="' + randColor(0.4) + '"/>'
    )
  }
  const palette = ['#1d4ed8', '#b45309', '#be123c', '#047857', '#6d28d9']
  for (let i = 0; i < code.length; i++) {
    const x = 14 + i * 26 + randInt(-3, 3)
    const y = 28 + randInt(-5, 5)
    const rot = randInt(-28, 28)
    const size = randInt(20, 25)
    parts.push(
      '<text x="' + x + '" y="' + y + '" font-size="' + size +
      '" font-family="Verdana, Arial, sans-serif" font-weight="700" fill="' + palette[i % palette.length] +
      '" transform="rotate(' + rot + ' ' + x + ' ' + y + ')">' + code[i] + '</text>'
    )
  }
  parts.push('</svg>')
  return parts.join('')
}

function createCaptcha(store, cfg) {
  const length = Math.max(4, Math.min(8, Number((cfg && cfg.length) || 4)))
  const expireMin = Math.max(1, Number((cfg && cfg.expireMin) || 5))
  const code = randChars('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', length)
  const imageId = 'img' + Date.now() + Math.random().toString(36).slice(2, 8)
  store.captchas[imageId] = { code: code.toLowerCase(), exp: Date.now() + expireMin * 60 * 1000 }
  const svg = createCaptchaSvg(code)
  return {
    imageId: imageId,
    image: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
  }
}

function checkCaptcha(store, imageId, imageCode, consume) {
  const id = String(imageId || '')
  const item = store.captchas[id]
  if (!item || Date.now() > item.exp) return '图形验证码已过期，请刷新'
  const ok = String(imageCode || '').trim().toLowerCase() === item.code
  if (consume || !ok) delete store.captchas[id]
  if (!ok) return '图形验证码错误'
  return ''
}

function issueEmailCode(store, email, scene, cfg) {
  const addr = normEmail(email)
  if (!validEmail(addr)) return { ok: false, msg: '请输入邮箱地址' }
  const resend = Math.max(10, Number((cfg && cfg.resendSeconds) || 60))
  const last = store.lastSend[addr]
  if (last && Date.now() - last < resend * 1000) {
    const wait = Math.ceil((resend * 1000 - (Date.now() - last)) / 1000)
    return { ok: false, msg: '请 ' + wait + ' 秒后再获取验证码' }
  }
  const length = Math.max(4, Math.min(8, Number((cfg && cfg.length) || 6)))
  const expireMin = Math.max(1, Number((cfg && cfg.expireMin) || 10))
  const code = randChars('0123456789', length)
  const providerId = (cfg && cfg.provider) || 'local'
  const provider = emailProviders[providerId] || emailProviders.local
  const sent = provider.send(cfg || {}, { email: addr, code: code, scene: scene || 'register' })
  if (!sent || !sent.ok) return { ok: false, msg: (sent && sent.msg) || '验证码发送失败' }
  store.emailCodes[addr] = {
    code: code,
    scene: String(scene || ''),
    exp: Date.now() + expireMin * 60 * 1000
  }
  store.lastSend[addr] = Date.now()
  const demo = !!(sent.demo)
  const reveal = demo && Number((cfg && cfg.revealDemo) !== undefined ? cfg.revealDemo : 1)
  return {
    ok: true,
    demo: demo,
    msg: reveal ? ('验证码已发送（本地演示：' + code + '）') : '验证码已发送'
  }
}

function checkEmailCode(store, email, code, scene) {
  const addr = normEmail(email)
  const item = store.emailCodes[addr]
  if (!item || Date.now() > item.exp) return '邮箱验证码已过期，请重新获取'
  if (String(code || '').trim() !== item.code) return '邮箱验证码错误'
  if (scene && item.scene && item.scene !== String(scene)) return '邮箱验证码与当前操作不匹配'
  return ''
}

function consumeEmail(store, email) {
  delete store.emailCodes[normEmail(email)]
}

function maskSecret(value) {
  return value ? '********' : ''
}

function publicChannel(cfg, extra) {
  const copy = Object.assign({}, cfg, extra || {})
  copy.wired = 0
  copy.wiredText = '待接入'
  copy.hasKey = !!(cfg.apiKey || cfg.smtpPass || cfg.smtpUser)
  copy.apiKey = maskSecret(cfg.apiKey)
  copy.secret = maskSecret(cfg.secret)
  copy.smtpPass = maskSecret(cfg.smtpPass)
  return copy
}

function publicRows(verify) {
  const captcha = (verify && verify.captcha) || defaultConfig().captcha
  const email = (verify && verify.email) || defaultConfig().email
  return [
    publicChannel(captcha, { kind: '图形' }),
    publicChannel(email, { kind: '邮箱', providerName: (emailProviders[email.provider] || emailProviders.local).name })
  ]
}

function applySave(target, query) {
  if (!target || !query) return
  ;['provider', 'note', 'endpoint', 'smtpHost', 'smtpUser', 'smtpFrom'].forEach(key => {
    if (query[key] !== undefined) target[key] = query[key]
  })
  ;['expireMin', 'length', 'resendSeconds', 'smtpPort', 'smtpSecure', 'revealDemo'].forEach(key => {
    if (query[key] !== undefined && query[key] !== '') target[key] = Number(query[key])
  })
  if (query.apiKey && String(query.apiKey).indexOf('****') === -1) target.apiKey = query.apiKey
  if (query.secret && String(query.secret).indexOf('****') === -1) target.secret = query.secret
  if (query.smtpPass && String(query.smtpPass).indexOf('****') === -1) target.smtpPass = query.smtpPass
}

module.exports = {
  emailProviders,
  defaultConfig,
  createStore,
  validEmail,
  createCaptcha,
  checkCaptcha,
  issueEmailCode,
  checkEmailCode,
  consumeEmail,
  publicRows,
  applySave
}
