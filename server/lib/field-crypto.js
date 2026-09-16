/**
 * 敏感字段的应用层加密 + 盲索引。
 *
 * ## 为什么不用磁盘加密
 *
 * 磁盘加密需要停机重装系统盘。而**应用层加密有几个磁盘加密给不了的好处**：
 *
 *   · **备份安全** —— pg_dump 出来的只有密文，密钥在
 *     `/etc/hello-pix/hello-pix.env` 里，**不在备份里**。
 *     备份文件被偷也解不开。磁盘加密对此毫无帮助（备份导出后就是明文）。
 *   · **零停机** —— 只改表和代码，服务不用停。
 *   · **粒度细** —— 只加密真正敏感的列，其余照常索引与查询。
 *
 * 它防不住的：拿到 root 的人（密钥在环境变量里）、云快照（同一块盘）。
 * 这两条要靠磁盘加密 + 访问控制，但那是另一个层面的事。
 *
 * ## 盲索引（blind index）
 *
 * 加密之后就没法 `WHERE email = ?` 了。所以每个要查询/唯一的字段
 * 额外存一列 `HMAC(密钥, 规范化值)`：
 *
 *   email        → 密文（用于展示、导出）
 *   email_bidx   → HMAC（用于等值查询与唯一约束）
 *
 * HMAC 而不是裸 SHA256：邮箱空间很小（可枚举），SHA256 能被彩虹表反推。
 * 加平台密钥后，外部无法构造查询。
 *
 * 这与 `platform_identities.fingerprint` 是同一套思路。
 */

const crypto = require('crypto')

const PREFIX = 'enc:'

/** 字段加密用独立的密钥派生，与凭据密钥隔离 —— 轮换一个不影响另一个 */
function fieldKey() {
  const base = String(process.env.PIX_CREDENTIAL_KEY || '').trim()
  if (!base) return null
  // 从主密钥派生出用途专属的子密钥（HKDF 简化版：HMAC 一次）
  // 直接复用主密钥会让"某处泄露"等于"全部泄露"
  return crypto.createHmac('sha256', Buffer.from(base)).update('pix-field-v1').digest()
}

function fieldCryptoReady() {
  return fieldKey() !== null
}

/** 规范化：与加密前 `lower(email)` 的语义保持一致，否则存量数据匹配不上 */
function normalize(value) {
  return String(value == null ? '' : value).trim().toLowerCase()
}

/**
 * 盲索引。**规范化后再 HMAC** —— 否则 "A@B.com" 与 "a@b.com"
 * 会算出两个不同的索引，唯一约束失效、查询查不到。
 */
function blindIndex(value) {
  const key = fieldKey()
  if (!key) return null
  const v = normalize(value)
  if (!v) return null
  return crypto.createHmac('sha256', key).update(v).digest()
}

/**
 * 加密字段值，返回可直接存 text 列的字符串。
 *
 * **必须 base64** —— AES 输出是二进制，text 列直接拼字符串会走
 * Buffer 的默认 utf8 解码把数据损坏。这个坑在 TOTP 密钥上真踩过一次。
 */
function encryptField(value) {
  const key = fieldKey()
  if (!key) throw new Error('未配置 PIX_CREDENTIAL_KEY，拒绝以明文保存敏感字段')
  const v = String(value == null ? '' : value)
  if (!v) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(v, 'utf8'), cipher.final()])
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

/**
 * 解密。**解不开一律返回原值** ——
 * 兼容存量明文（迁移未跑完时不能让人看不到自己的数据），
 * 也避免因密钥问题让整个页面崩掉。
 */
function decryptField(stored) {
  const v = String(stored == null ? '' : stored)
  if (!v) return v
  if (!v.startsWith(PREFIX)) return v          // 存量明文，原样返回
  const key = fieldKey()
  if (!key) return ''                          // 没密钥就当读不到，不抛错
  try {
    const buf = Buffer.from(v.slice(PREFIX.length), 'base64')
    if (buf.length <= 28) return ''
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
    decipher.setAuthTag(buf.subarray(12, 28))
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8')
  } catch (e) {
    return ''   // 密钥轮换或数据损坏：当作读不到，由上层决定怎么提示
  }
}

/** 是否已是密文（迁移脚本用） */
function isEncrypted(stored) {
  return String(stored == null ? '' : stored).startsWith(PREFIX)
}

/**
 * 写库前的统一处理：同时产出密文与盲索引。
 * 调用方拿到后一起写两列，避免只更新一列导致索引与密文不一致。
 */
function seal(value) {
  return { value: encryptField(value), bidx: blindIndex(value) }
}

module.exports = {
  fieldCryptoReady,
  normalize,
  blindIndex,
  encryptField,
  decryptField,
  isEncrypted,
  seal
}
