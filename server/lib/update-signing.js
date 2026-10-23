'use strict'

/**
 * 更新清单的服务端签名。
 *
 * ## 私钥从哪来
 *
 * 环境变量 `UPDATE_SIGNING_KEY`（PEM 或单行 base64 PKCS8）。
 *
 * **绝不放数据库、绝不放仓库、绝不进部署包。** 私钥一旦泄露，
 * 攻击者就能给所有用户推任意安装包，而且我们的签名校验会一路放行
 * —— 它验的正是"这把私钥签的"。轮换只能靠客户端内置的 `PREVIOUS` 槽位过渡。
 *
 * 没配私钥时 `signManifest` 直接抛错，`buildManifest` 返回 null：
 * **宁可这一次不发更新，也不能发一份没签名的清单让客户端去降级**。
 *
 * ## 为什么签名在服务端做，而不是发布脚本做
 *
 * 发布操作是在后台页面点「上架」完成的，那时安装包已经传到 CDN 了。
 * 如果签名在脚本里做，运营每次发版都得跑一次 Node 脚本，忘一次就是
 * 一次无声的更新通道瘫痪。
 *
 * 放在服务端 = 私钥必须跟服务一起跑。这是**权衡后的选择**：
 * 私钥泄露面从「构建机」扩大到「生产服务器」。如果哪天要求更高，
 * 应该改成"发布脚本签名 → 把 signature 存进记录"，那时
 * `buildManifest` 只读不签，客户端无需任何改动。
 */

const crypto = require('crypto')

const ALGORITHM = 'ed25519'
const SIGNATURE_BYTES = 64

/**
 * 字段顺序即签名契约，必须与客户端 `desktop/src/update/signature.js`
 * 的 `MANIFEST_FIELDS` **完全一致**。任何一侧改动都会让所有存量客户端
 * 验签失败，所以这里不做"自动同步"，宁可抄一份并加断言。
 */
const MANIFEST_FIELDS = ['appId', 'version', 'url', 'sha256', 'channel', 'minVersion']

function manifestPayload (manifest) {
  return Buffer.from(MANIFEST_FIELDS.map(field => {
    const value = manifest[field]
    if (value === undefined || value === null) return ''
    return String(value)
  }).join('\n'), 'utf8')
}

function parsePrivateKey (value) {
  const raw = String(value || '').trim()
  if (!raw) return null

  const key = raw.includes('-----BEGIN')
    ? crypto.createPrivateKey(raw.replace(/\\n/g, '\n'))
    : crypto.createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' })

  if (key.asymmetricKeyType !== ALGORITHM) {
    throw new Error(`UPDATE_SIGNING_KEY 类型必须是 ${ALGORITHM}，实际是 ${key.asymmetricKeyType}`)
  }
  return key
}

let cached = null
let cachedFrom = null

/** 惰性解析并缓存：解析 PEM 有开销，而更新检查是热路径。 */
function signingKey (env) {
  const raw = String((env || process.env).UPDATE_SIGNING_KEY || '')
  if (cachedFrom === raw) return cached
  cachedFrom = raw
  cached = parsePrivateKey(raw)
  return cached
}

/**
 * 用记录里已有的字段签出一份清单对象。
 *
 * @param {object} release  { appId, version, url, sha256, minVersion, channel }
 * @param {object} [env]
 * @returns {object|null} 没配私钥时返回 null（调用方据此不下发清单）
 */
function signManifest (release, env) {
  const key = signingKey(env)
  if (!key) return null

  const manifest = {
    appId: String(release.appId || ''),
    version: String(release.version || ''),
    url: String(release.url || ''),
    sha256: String(release.sha256 || '').toLowerCase(),
    channel: String(release.channel || 'stable'),
    minVersion: String(release.minVersion || release.version || '')
  }

  const signature = crypto.sign(null, manifestPayload(manifest), key)
  if (signature.length !== SIGNATURE_BYTES) throw new Error('签名长度异常')

  return Object.assign({}, manifest, { signature: signature.toString('base64') })
}

/**
 * 由数据库行生成清单。三个必要条件缺一不可：
 *   · 有 sha256（发布时算过哈希）
 *   · 有签名私钥（服务端配置了）
 *   · URL 是 https
 *
 * 任何一条不满足都返回 null —— 让客户端走「服务端没给清单」的分支，
 * 而不是收到一份半成品再验签失败（那会触发"有人在动更新通道"的告警，
 * 是我们自己配置缺失却让告警看起来像攻击）。
 */
function buildManifest (row, options) {
  const opts = options || {}
  if (!row) return null
  if (!row.sha256) return null

  const appId = String(opts.appId || 'com.hellopix.desktop')
  const url = String(row.url || '').trim()
  if (!/^https:\/\//i.test(url)) return null

  try {
    return signManifest({
      appId,
      version: row.version,
      url,
      sha256: row.sha256,
      channel: opts.channel || 'stable',
      minVersion: row.min_version || row.minVersion || row.version
    }, opts.env)
  } catch (error) {
    // 私钥配错不能静默当成"没更新"—— 那会让更新通道无声瘫痪
    if (opts.onError) opts.onError(error)
    else console.error('[update-signing] 签名失败：', error.message)
    return null
  }
}

module.exports = {
  MANIFEST_FIELDS,
  manifestPayload,
  parsePrivateKey,
  signManifest,
  buildManifest
}
