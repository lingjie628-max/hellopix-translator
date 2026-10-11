'use strict'

/**
 * 重置商户密码（运维一次性脚本）。
 *
 * ## 为什么需要它
 *
 * 商户忘记密码时，后台原本只有「编辑商户」弹窗里一个密码框 —— 那接口开头就
 * `repo.package(versionId)`，不传套餐直接 404「套餐不存在」；且它一条 UPDATE
 * 会顺带碰套餐、状态、到期等一串字段。改密码是安全敏感操作，不该借道那种接口。
 *
 * 0.1.25 之后已补上超管后台的「重置密码」按钮与 `/admin/users/resetPassword`。
 * 本脚本是**同一件事的命令行版本**，用于没有超管会话（比如运维手边只有 SSH）时。
 *
 * ## 规则与一致性
 *
 *   · 密码规则与落库格式**都复用 app 自己的实现**（`server/lib/password`），
 *     所以 6 位规则、scrypt 格式、DB 的 CHECK 约束天然一致，不会各写一套。
 *   · 会话撤销复用 app 的 `RedisSessionStore`，键前缀取 `REDIS_KEY_PREFIX`，
 *     与 `server/config` 完全一致 —— 避免踩那个「双前缀」坑
 *     （见 docs/代码审查.md：REDIS_KEY_PREFIX 之上代码里还有一层 pix:）。
 *
 * ## 用法（在生产机上，app 目录内）
 *
 *   cd /opt/hello-pix
 *   node deploy/reset-merchant-password.js <username> <newPassword>
 *   node deploy/reset-merchant-password.js <username> <newPassword> --no-revoke
 *
 * 环境变量：
 *   APP_DIR    app 根目录，默认 /opt/hello-pix
 *   ENV_FILE   环境文件，默认 /etc/hello-pix/hello-pix.env
 *
 * 说明：本脚本**不会**把密码回显出来。传进来的明文只在进程内用于计算哈希。
 */

const fs = require('node:fs')
const path = require('node:path')

const APP = process.env.APP_DIR || '/opt/hello-pix'
const ENV_FILE = process.env.ENV_FILE || '/etc/hello-pix/hello-pix.env'

/** 把 env 文件读进 process.env（不覆盖已存在的变量），供 ioredis/pg 使用 */
function loadEnvFile() {
  let text
  try {
    text = fs.readFileSync(ENV_FILE, 'utf8')
  } catch (error) {
    throw new Error(`读不到环境文件 ${ENV_FILE}：${error.message}`)
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const name = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!(name in process.env)) process.env[name] = value
  }
}

async function main() {
  const args = process.argv.slice(2)
  const flags = new Set(args.filter(a => a.startsWith('--')))
  const positional = args.filter(a => !a.startsWith('--'))
  const [username, password] = positional

  if (!username || !password) {
    throw new Error('用法: node deploy/reset-merchant-password.js <username> <newPassword> [--no-revoke]')
  }

  loadEnvFile()

  const passwordLib = require(path.join(APP, 'server/lib/password'))
  const { RedisSessionStore } = require(path.join(APP, 'server/stores'))

  // 复用 app 的规则：不合规（如 <6 位）在这里就拒绝，不必等到服务端 400
  if (!passwordLib.validPassword(password)) {
    throw new Error('密码不符合规则：需 6-128 位（server/lib/password.js）')
  }

  const { Client } = require(path.join(APP, 'node_modules/pg'))
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()

  let redis
  try {
    const found = await db.query(
      'SELECT id, username FROM users WHERE lower(username) = lower($1)', [username])
    if (!found.rows.length) throw new Error(`找不到商户：${username}`)
    const user = found.rows[0]

    const hash = await passwordLib.hashPassword(password)
    await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [user.id, hash])
    console.log(`✔ 已重置 ${user.username}（id=${user.id}）的密码`)

    if (flags.has('--no-revoke')) {
      console.log('· 跳过会话撤销（--no-revoke）')
    } else {
      const Redis = require(path.join(APP, 'node_modules/ioredis'))
      redis = new Redis(process.env.REDIS_URL, {
        lazyConnect: true,
        keyPrefix: String(process.env.REDIS_KEY_PREFIX || '')
      })
      await redis.connect()
      const sessions = new RedisSessionStore(redis, { ttlMs: 12 * 60 * 60 * 1000 })
      const revoked = await sessions.revokeSubject('user', user.id)
      console.log(`✔ 已撤销该商户的 ${revoked} 个登录会话`)
    }
  } finally {
    await db.end()
    if (redis) {
      try { await redis.quit() } catch (_e) { redis.disconnect() }
    }
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`失败: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { loadEnvFile }
