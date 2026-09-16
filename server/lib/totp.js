'use strict'

/**
 * TOTP（RFC 6238）与 base32（RFC 4648）实现。
 *
 * 为什么自己写而不引三方库：
 *   TOTP 算法本身只有几十行（HMAC + 动态截断），而它是整个超管后台的第二因子 ——
 *   引一个依赖就等于把最关键的鉴权环节交给别人的发布节奏和供应链。
 *   这里用 Node 自带 crypto 实现，并用 RFC 6238 附录 B 的官方测试向量做回归。
 *
 * 兼容性：Google Authenticator / Authy / 1Password / 微软验证器 全部使用
 *   SHA1 + 6 位 + 30 秒，即下面的默认值。
 */

const crypto = require('crypto')

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const DEFAULT_STEP = 30
const DEFAULT_DIGITS = 6

/** 生成 TOTP 共享密钥（返回原始 Buffer 与 base32 文本） */
function generateSecret(bytes = 20) {
  // 160 bit 是 RFC 4226 建议的最小长度，也是各验证器 App 的通行值
  const raw = crypto.randomBytes(bytes)
  return { raw, base32: base32Encode(raw) }
}

function base32Encode(buffer) {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

function base32Decode(input) {
  // 容忍用户从验证器里复制时带入的空格、连字符与小写
  const clean = String(input || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  if (!clean) throw new Error('base32 内容为空')
  let bits = 0
  let value = 0
  const output = []
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) throw new Error(`base32 含非法字符：${char}`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(output)
}

/** 计数器 → HMAC → 动态截断。counter 为 bigint 或数字。 */
function hotp(secret, counter, digits = DEFAULT_DIGITS, algorithm = 'sha1') {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const digest = crypto.createHmac(algorithm, secret).update(buf).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  return String(binary % 10 ** digits).padStart(digits, '0')
}

/** 某一时刻的 TOTP 值。timeMs 缺省取当前时间。 */
function totp(secretInput, timeMs = Date.now(), options = {}) {
  const step = Number(options.step || DEFAULT_STEP)
  const digits = Number(options.digits || DEFAULT_DIGITS)
  const algorithm = options.algorithm || 'sha1'
  const secret = Buffer.isBuffer(secretInput) ? secretInput : base32Decode(secretInput)
  const counter = Math.floor(Number(timeMs) / 1000 / step)
  return hotp(secret, counter, digits, algorithm)
}

/** 计算某时刻所属的时间步（用于防重放：同一个步长内只允许用一次） */
function counterAt(timeMs = Date.now(), step = DEFAULT_STEP) {
  return Math.floor(Number(timeMs) / 1000 / step)
}

/**
 * 校验用户输入的验证码。
 *
 * window 允许前后各偏几个时间步 —— 手机与服务器时钟不可能完全一致，
 * 不给容差会让用户"明明填对了却说错误"。默认 ±1 步（±30 秒）。
 *
 * 注意：这里只判断"是不是有效码"，**不负责防重放** ——
 * 同一个码在它所属的 30 秒窗口内会一直通过校验，必须由调用方结合
 * counterAt() 记录已用过的步长来拒绝二次使用。
 */
function verify(secretInput, token, options = {}) {
  const code = String(token || '').replace(/\D/g, '')
  if (!code) return { ok: false, reason: 'empty' }
  const digits = Number(options.digits || DEFAULT_DIGITS)
  if (code.length !== digits) return { ok: false, reason: 'length' }

  const step = Number(options.step || DEFAULT_STEP)
  const window = options.window == null ? 1 : Number(options.window)
  const now = options.timeMs == null ? Date.now() : Number(options.timeMs)
  const secret = Buffer.isBuffer(secretInput) ? secretInput : base32Decode(secretInput)
  const current = counterAt(now, step)

  for (let offset = -window; offset <= window; offset++) {
    const counter = current + offset
    if (counter < 0) continue
    const expected = hotp(secret, counter, digits, options.algorithm || 'sha1')
    // 定长比较，避免通过响应时间侧信道推断
    const a = Buffer.from(expected)
    const b = Buffer.from(code)
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return { ok: true, counter }
    }
  }
  return { ok: false, reason: 'mismatch' }
}

/** 供验证器 App 扫码/手输的 otpauth 链接 */
function otpauthUrl({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret: String(secret).replace(/=+$/, ''),
    issuer,
    algorithm: 'SHA1',
    digits: String(DEFAULT_DIGITS),
    period: String(DEFAULT_STEP)
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

/**
 * 一次性恢复码。
 * 熵足够（10 位 base32 ≈ 50 bit），所以用 SHA-256 直接索引即可 ——
 * 不需要 scrypt 那种慢哈希，而且能 O(1) 命中，不必逐个比对。
 */
function generateRecoveryCodes(count = 10, length = 10) {
  const codes = []
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(length)
    let code = ''
    for (let j = 0; j < length; j++) code += BASE32_ALPHABET[raw[j] % 32]
    // 每 5 位加连字符，便于用户抄写与核对
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`)
  }
  return codes
}

function hashRecoveryCode(code) {
  const normalized = String(code || '').toUpperCase().replace(/[\s-]/g, '')
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

module.exports = {
  generateSecret,
  base32Encode,
  base32Decode,
  hotp,
  totp,
  counterAt,
  verify,
  otpauthUrl,
  generateRecoveryCodes,
  hashRecoveryCode,
  DEFAULT_STEP,
  DEFAULT_DIGITS
}
