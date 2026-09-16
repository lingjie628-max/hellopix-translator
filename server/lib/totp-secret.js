/**
 * 加密 TOTP 密钥的落盘（修复明文存储）。
 *
 * ## 修的是什么
 *
 * TOTP 共享密钥原本以 base32 **明文**存在 `admins.totp_secret`：
 *
 *     pix: EYWKVCRMFNEZJE...   ← 直接可读
 *
 * 这让两步验证在"数据库被读"的场景下形同虚设 —— 2FA 的意义正是
 * 「即使密码泄露也进不去」，而明文密钥意味着任何能读库的人
 * （运维、DBA、SQL 注入、备份文件泄露）都能直接生成有效动态码。
 *
 * ## 怎么修
 *
 * 复用 `lib/credentials.js` 的 AES-256-GCM（与厂商密钥同一套），
 * 而不是另写一份 —— 两套加密实现会各自演化，
 * 而且密钥管理与格式解析的坑要踩两遍。
 *
 * ## 兼容存量
 *
 * 库里可能已有明文密钥（当前生产就有一条）。所以读取时按格式判断：
 *   · 能解密的密文 → 解密
 *   · 解不开且像 base32 → 视为旧的明文，**原样返回**（否则管理员会被锁在门外）
 *
 * 这个兼容分支是必要的：直接改成"只认密文"会让现有管理员
 * 立刻无法登录，而 2FA 锁死是无法自助恢复的。
 */

const { encryptSecret, decryptSecret, credentialsKeyReady } = require('../lib/credentials')

/** base32（RFC 4648，TOTP 用的就是这套）*/
const BASE32_RE = /^[A-Z2-7]+=*$/

/** 是否是明文 base32（存量数据） */
function looksLikePlaintext(value) {
  const v = String(value || '')
  return v.length >= 16 && BASE32_RE.test(v)
}

/**
 * 存库前加密，返回 **text 列可直接存**的字符串（base64）。
 *
 * 注意 encryptSecret 返回的是 Buffer，不能直接拼字符串 ——
 * 那会走 Buffer 的默认 utf8 解码，把二进制静默损坏。
 *
 * 未配置凭据密钥时**拒绝保存** —— 宁可保存失败，也不能再把明文写回去。
 */
function encryptTotpSecret(plain) {
  if (!plain) return null
  if (!credentialsKeyReady()) {
    const err = new Error('未配置 PIX_CREDENTIAL_KEY，拒绝以明文保存 TOTP 密钥')
    err.code = 'CREDENTIAL_KEY_MISSING'
    throw err
  }
  // **必须 base64 编码**：encryptSecret 返回的是 Buffer（iv|tag|ciphertext），
  // 而 totp_secret 是 text 列。直接字符串拼接会走 Buffer 的默认 utf8 解码，
  // 把二进制静默损坏 —— 存进去能存，读出来解不开，且不报任何错。
  // （通道密钥没这个问题，因为它存的是 bytea 列。）
  return 'enc:' + encryptSecret(String(plain)).toString('base64')
}

/**
 * 读取时解密。
 *
 * 返回空串表示"没有可用密钥"，上层走 fail-closed。
 * **绝不抛错** —— 2FA 读取失败不该让整个登录流程崩掉。
 */
function decryptTotpSecret(stored) {
  const v = String(stored || '').trim()
  if (!v) return ''
  if (v.startsWith('enc:')) {
    try {
      return decryptSecret(Buffer.from(v.slice(4), 'base64'))
    } catch (e) {
      // 密钥轮换或数据损坏：当作没有密钥，管理员用恢复码进入
      return ''
    }
  }
  // 兼容存量明文（迁移完成前必须保留）
  if (looksLikePlaintext(v)) return v
  return ''
}

/** 迁移用：判断某条记录是否还是明文 */
function isPlaintextSecret(stored) {
  const v = String(stored || '').trim()
  return !!v && !v.startsWith('enc:')
}

module.exports = {
  encryptTotpSecret,
  decryptTotpSecret,
  isPlaintextSecret,
  looksLikePlaintext
}
