'use strict'

/**
 * scripts/release-client.js 的查重口径。
 *
 * ## 事故（2026-10-23）
 *
 * 发 1.2.2 时按 Windows → macOS x64 → macOS arm64 连跑三次。脚本原来按
 * `version + app` 查重，后两次走了"找到已有记录 → UPDATE"分支，把 Windows
 * 那条的 sha256 覆盖成了 arm64 dmg 的哈希。os/arch/url 还是 exe，哈希却是 dmg ——
 * 库里看着有数据，实际所有 Windows 客户端更新必然校验失败。
 *
 * 这里不连数据库，只把脚本里那条 SQL 的 WHERE 子句与参数抠出来断言，
 * 防止以后有人"顺手简化"回去。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const source = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'release-client.js'), 'utf8')

test('查重必须带 os 与 arch（否则一个版本只能存一条，后写的覆盖先写的）', () => {
  const match = source.match(/SELECT id,[^;]*?FROM client_releases WHERE ([^'`]*?)'/s)
  assert.ok(match, '找不到查重 SQL')
  const where = match[1]

  assert.match(where, /version\s*=\s*\$1/, '必须按版本号查')
  assert.match(where, /app\s*=\s*\$2/, '必须按 app 查')
  assert.match(where, /os\s*=\s*\$3/, '★ 必须按 os 查 —— 漏了它 macOS 的哈希会盖掉 Windows 的')
  assert.match(where, /arch\s*=\s*\$4/, '★ 必须按 arch 查 —— x64 与 arm64 是两个不同的安装包')
})

test('查重参数顺序与 WHERE 里的占位符一一对应', () => {
  const call = source.match(/client_releases WHERE version=\$1 AND app=\$2 AND os=\$3 AND arch=\$4[^[]*\[([^\]]+)\]/s)
  assert.ok(call, '找不到查重的参数数组')
  const args = call[1].split(',').map(s => s.trim()).filter(Boolean)
  assert.deepEqual(args, ['version', 'appId', 'osArg', 'archArg'],
    '$1..$4 必须依次是 version / appId / osArg / archArg，错位等于查错行')
})

test('INSERT 用的 os/arch 与查重是同一组变量（不能一处用 arg() 一处用常量）', () => {
  const insert = source.match(/INSERT INTO client_releases\([\s\S]*?VALUES\('desktop', \$1, \$2, \$3, \$4[\s\S]*?\]\s*\)/s)
  assert.ok(insert, '找不到 INSERT')
  const vars = insert[0].match(/\[\s*arg\('title'[^\]]*\]/s)
  assert.ok(insert[0].includes('osArg') && insert[0].includes('archArg'),
    'INSERT 必须复用 osArg / archArg —— 否则会出现"查重用 A、写入用 B"的幽灵行')
  assert.ok(vars || insert[0].includes('arg('), 'INSERT 参数段缺失')
})
