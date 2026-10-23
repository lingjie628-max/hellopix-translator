'use strict'

/**
 * 发布客户端版本：算安装包哈希 → 写进发布记录 → 让 /client/update 能下发签名清单。
 *
 * ## 为什么要有这个脚本
 *
 * 更新清单的签名校验依赖 `client_releases.sha256`。这个字段没法在后台表单里
 * 手填 —— 让运营对一个上百 MB 的安装包"手抄一个 64 位哈希"，出错只是时间问题，
 * 而且抄错的后果是**所有用户更新失败**（哈希对不上，验签通过但下载校验挂）。
 *
 * 所以哈希必须由脚本从真实文件算出来，一步到位。
 *
 * ## 用法
 *
 *   # 上架一个新版本（记录不存在则创建）
 *   node scripts/release-client.js \
 *     --version 1.3.0 \
 *     --url https://pixfanyi.com/downloads/HelloPix-Setup-1.3.0.exe \
 *     --file ./release/HelloPix-Setup-1.3.0.exe \
 *     --min-version 1.2.0
 *
 *   # 只回填哈希/下限到已存在的记录（后台已经建好了那条记录）
 *   node scripts/release-client.js --version 1.3.0 --file ./release/xxx.exe
 *
 *   # 只看会发生什么，不写库
 *   node scripts/release-client.js --version 1.3.0 --file ./x.exe --dry-run
 *
 * ## 为什么默认要求 --file
 *
 * 没有本地安装包就没法算哈希。允许 `--sha256` 手工传入，但会打警告：
 * 那条路径绕过了"从真实文件算"的保证，只留给"包在另一台机器上"的场景。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const config = require('../server/config')

function arg (name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}
function has (name) {
  return process.argv.includes(`--${name}`)
}
function die (message) {
  console.error(`错误：${message}`)
  process.exit(1)
}

const version = String(arg('version', '')).trim()
const urlArg = String(arg('url', '')).trim()
const filePath = arg('file')
const shaArg = arg('sha256')
const minVersion = String(arg('min-version', '') || '').trim()
const appId = String(arg('app', 'com.hellopix.desktop')).trim()
const note = arg('note')
const dryRun = has('dry-run')

if (!version) die('缺少 --version')
if (!filePath && !shaArg) die('缺少 --file（或 --sha256）')
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  die(`--version 格式无效：${version}（应为 1.2.3 形式）`)
}

/* ------------------------------ 算哈希 ------------------------------ */

let sha256 = ''
if (filePath) {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) die(`找不到安装包：${resolved}`)

  // 流式算：安装包上百 MB，readFileSync 会一次性吃进内存
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(resolved, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let read
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  sha256 = hash.digest('hex')
  const size = fs.statSync(resolved).size
  console.log(`安装包：${resolved}`)
  console.log(`  大小：${(size / 1024 / 1024).toFixed(1)} MB`)
  console.log(`  SHA256：${sha256}`)
} else {
  sha256 = String(shaArg).toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(sha256)) die(`--sha256 无效：${shaArg}`)
  console.warn('⚠ 使用手工传入的 sha256 —— 没有从真实文件校验过')
}

/* ------------------------------ 写库 ------------------------------ */

async function main () {
  const { Pool } = require('pg')
  const pool = new Pool({
    connectionString: config.database.connectionString,
    ssl: config.database.ssl,
    connectionTimeoutMillis: config.database.connectionTimeoutMillis,
    application_name: `${config.database.applicationName || 'hello-pix'}-release`
  })

  try {
    const existing = await pool.query(
      'SELECT id, url, version, sha256, min_version FROM client_releases WHERE version=$1 AND app=$2 ORDER BY id DESC LIMIT 1',
      [version, appId]
    )

    if (existing.rows[0]) {
      const row = existing.rows[0]
      console.log(`\n找到已有记录 #${row.id}（${row.version}）`)
      if (row.sha256 && row.sha256 !== sha256) {
        console.warn(`⚠ 该记录原哈希为 ${row.sha256.slice(0, 16)}…，将被覆盖为新的哈希`)
        console.warn('  如果是同一个版本号换了安装包，建议改用新的补丁版本号 ——')
        console.warn('  否则已经下载过旧包的客户端不会重下（版本号相同）')
      }
      if (dryRun) {
        console.log(`[dry-run] 将更新 #${row.id}：sha256=${sha256.slice(0, 16)}…，min_version=${minVersion || row.min_version || version}`)
        return
      }
      await pool.query(
        'UPDATE client_releases SET sha256=$2, min_version=$3, updated_at=NOW() WHERE id=$1',
        [row.id, sha256, minVersion || row.min_version || version]
      )
      console.log(`已更新 #${row.id}`)
      return
    }

    // 没有记录：只有给了 --url 才能新建
    if (!urlArg) {
      die(`没有找到版本 ${version} 的发布记录，且没有给 --url，无法新建`)
    }
    if (!/^https:\/\//i.test(urlArg)) die('--url 必须是 HTTPS')

    if (dryRun) {
      console.log(`[dry-run] 将新建记录：app=${appId} version=${version} url=${urlArg}`)
      console.log(`          sha256=${sha256.slice(0, 16)}… min_version=${minVersion || version}`)
      return
    }

    const created = await pool.query(
      `INSERT INTO client_releases(release_group, title, os, arch, app, version, url, enabled, note, sha256, min_version)
       VALUES('desktop', $1, $2, $3, $4, $5, $6, true, $7, $8, $9) RETURNING id`,
      [
        arg('title', `Hello Pix ${version}`),
        arg('os', 'Windows'),
        arg('arch', 'x64'),
        appId,
        version,
        urlArg,
        note || `发布 ${version}`,
        sha256,
        minVersion || version
      ]
    )
    console.log(`\n已创建发布记录 #${created.rows[0].id}`)
    console.log('注意：这条记录默认 release_group=desktop / os=Windows / arch=x64 ——')
    console.log('      macOS 或其它架构请用 --os / --arch 覆盖。')
  } finally {
    await pool.end()
  }
}

main().catch(error => {
  console.error('失败：', error.message)
  process.exit(1)
})
