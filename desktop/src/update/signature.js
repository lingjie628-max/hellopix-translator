'use strict'

/**
 * 更新清单的 Ed25519 签名校验。
 *
 * ## 为什么现有的域名白名单不够
 *
 * `app:checkUpdate` 现在只做一件事：把服务端给的下载地址过一遍
 * `DOWNLOAD_HOSTS` 白名单（见 src/ipc/app.js）。
 *
 * 白名单防的是「服务端把用户引到 evil.com」，防不住「服务端被攻破，
 * 在白名单域名上放一个恶意安装包」—— 那时 URL 完全合法，白名单一路放行。
 * 域名信任把**完整性**押在了服务端的健康上，而更新通道恰恰是最该假设
 * 服务端会出问题的通道（它能给所有用户推代码执行）。
 *
 * 所以加一层与服务端无关的校验：安装包的哈希由**私钥签名**，客户端内置
 * 对应公钥。私钥在构建机上，服务器被攻破也签不出合法清单。
 *
 * ## 签名原文为什么不用 JSON
 *
 * 原文是字段按固定顺序 `join('\n')`：
 *
 *     appId \n version \n url \n sha256 \n channel \n minVersion
 *
 * JSON.stringify 的 key 顺序、空格、转义都会随实现与版本变化
 * （不同 Node 版本、不同序列化库、任何一次「顺手 format」），
 * 任何一处变化都会让验签失败，而且失败得完全看不出原因。
 * 定长字段顺序是唯一稳定的做法。
 *
 * ## 顺序：先验签，再做别的判断
 *
 * 任何「先看通道对不对 / 先看版本号格式」的写法都会把校验器变成一个
 * 信息泄露的 oracle —— 攻击者能只靠错误信息区分「签名对了但通道错」
 * 和「签名错了」。所以这里先 verify，通过后再谈策略。
 */

const crypto = require('crypto')

const ALGORITHM = 'ed25519'
const SIGNATURE_BYTES = 64

/** 字段顺序即签名契约。改动等于让所有存量客户端失效，必须同步发版。 */
const MANIFEST_FIELDS = ['appId', 'version', 'url', 'sha256', 'channel', 'minVersion']

function manifestPayload (manifest) {
  const parts = MANIFEST_FIELDS.map(field => {
    const value = manifest[field]
    if (value === undefined || value === null) return ''
    if (typeof value === 'object') throw new Error(`清单字段 ${field} 不能是对象`)
    return String(value)
  })
  return Buffer.from(parts.join('\n'), 'utf8')
}

/**
 * 解析公钥并**强制**校验类型。
 *
 * 只靠 `crypto.verify(null, ...)` 隐式表示 Ed25519 是不够的：将来谁把
 * 公钥换成 RSA 而忘了改算法参数，verify 会抛错而不是静默通过。
 * 显式断言 key type 是最省事、也最难被漏掉的防线。
 *
 * 支持 PEM 与单行 base64(DER) 两种写法：前者便于本地调试，
 * 后者便于构建时注入进常量（不含换行，不会被格式化工具折断）。
 */
function parsePublicKey (value) {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('未内置更新公钥，拒绝更新')

  const key = raw.includes('-----BEGIN')
    ? crypto.createPublicKey(raw)
    : crypto.createPublicKey({
      key: Buffer.from(raw, 'base64'),
      format: 'der',
      type: 'spki'
    })

  if (key.asymmetricKeyType !== ALGORITHM) {
    throw new Error(`更新公钥类型必须是 ${ALGORITHM}，实际是 ${key.asymmetricKeyType}`)
  }
  return key
}

/**
 * 用一组公钥依次尝试，任意一把通过即算通过。
 *
 * 支持多把是为了**密钥轮换**：换钥后旧客户端仍认旧钥、新客户端认新钥，
 * 过渡期内两边都能更新，否则换钥那天所有旧版本会永久失去更新能力
 * （而它们恰恰是最需要被更新的那批）。
 */
function verifySignature (payload, signature, publicKeys) {
  const keys = (Array.isArray(publicKeys) ? publicKeys : [publicKeys]).filter(Boolean)
  if (!keys.length) throw new Error('未内置更新公钥，拒绝更新')

  let sig
  try {
    sig = Buffer.from(String(signature || ''), 'base64')
  } catch (_) {
    throw new Error('更新签名不是合法 base64')
  }
  if (sig.length !== SIGNATURE_BYTES) {
    throw new Error(`更新签名长度应为 ${SIGNATURE_BYTES} 字节，实际 ${sig.length}`)
  }

  let lastError = null
  for (const raw of keys) {
    try {
      if (crypto.verify(null, payload, parsePublicKey(raw), sig)) return true
      lastError = new Error('更新清单签名验证失败')
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('更新清单签名验证失败')
}

/** 版本比较：'1.10.0' 必须大于 '1.9.0'，字符串比较会判反。 */
function compareVersions (left, right) {
  const parse = value => String(value || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map(part => {
      const n = Number.parseInt(part, 10)
      return Number.isNaN(n) ? 0 : n
    })
  const a = parse(left)
  const b = parse(right)
  const length = Math.max(a.length, b.length, 3)
  for (let i = 0; i < length; i += 1) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

module.exports = {
  MANIFEST_FIELDS,
  manifestPayload,
  parsePublicKey,
  verifySignature,
  compareVersions
}
