'use strict'

/**
 * 内置的更新签名公钥。
 *
 * ## 为什么写死在代码里，而不是放 resources/config.json
 *
 * 放进配置文件等于没防：那个文件就在安装目录里，用户（或任何能跑一段
 * 脚本的东西）改一行就能换成自己的公钥，然后推自己的包 —— 验签照常通过。
 * 这是养号系统踩过的坑（那份 config.json 里 `updatePublicKey` 甚至是空的，
 * 结果是所有客户端静默失去更新能力）。
 *
 * 放进 app.asar 后用户要改就必须重新打包整个应用，攻击门槛从「改个 JSON」
 * 变成「改并重签安装包」，量级完全不同。
 *
 * ## 格式
 *
 * 单行 base64(DER/SPKI)，因为不含换行，不会被格式化工具折断、也不会
 * 因为 CRLF/LF 差异导致解析失败。
 *
 * ## 当前状态（2026-10-23 启用）
 *
 * PRIMARY 已填入正式公钥，对应私钥在 `keys/update-signing.key`
 * （已 gitignore，只放构建机/服务器环境变量 `UPDATE_SIGNING_KEY`）。
 *
 * ★ 这把私钥丢了 = 以后再也签不出新版本，现有客户端只能靠 PREVIOUS 轮换 ★
 *   生成时已经在仓库外留了一份备份是必须的，这里再强调一次。
 *
 * ## 换钥必须走轮换（否则旧客户端永久失去更新）
 *
 *   1. `node scripts/update-keygen.js ./keys-new`
 *   2. 新钥 → PRIMARY，**旧钥挪到 PREVIOUS**（这一步绝不能省）
 *   3. 发一版客户端，让用户升上来（这版新旧都认）
 *   4. 服务端换成新私钥开始签
 *   5. 旧版本覆盖率足够低后，清空 PREVIOUS
 *
 * 跳过 2、3 直接换服务端私钥 = 所有旧客户端立即失去更新能力，
 * 而它们恰恰是最需要被更新的那批（它们没有别的路径能修好自己）。
 */

const PLACEHOLDER_PREFIX = '__UPDATE_PUBLIC_KEY_'

/** 正式公钥：ed25519 SPKI，单行 base64。对应私钥在服务器 UPDATE_SIGNING_KEY。 */
const PRIMARY = 'MCowBQYDK2VwAyEAJ9JmC+Fo/BhqSultIVhCUPkciNrnayVz52+rvYOSysY='

/**
 * 上一把公钥。轮换期间保留，让还没升级的用户仍能拿到更新；
 * 等旧版本覆盖率足够低再清空。留空是合法的。
 */
const PREVIOUS = ''

function isPlaceholder (value) {
  return !value || String(value).startsWith(PLACEHOLDER_PREFIX)
}

const PUBLIC_KEYS = [PRIMARY, PREVIOUS].filter(value => !isPlaceholder(value))

module.exports = {
  PUBLIC_KEYS,
  /** 构建脚本据此判断是否还没注入公钥，避免把空钥打进正式包。 */
  configured: PUBLIC_KEYS.length > 0
}
