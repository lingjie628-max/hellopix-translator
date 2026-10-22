'use strict'

/**
 * 迁移文件的可执行性 —— 防「记录了成功、实际是坏的」。
 *
 * ## 真实事故（2026-10-21 审计发现）
 *
 * `048_retire_qwen_fast_channel.js` 里 8 处全部写成 `pgm.query(...)`，
 * 但 node-pg-migrate 的 `pgm` 上**只有 `pgm.db.query`**，没有 `pgm.query`：
 *
 *     const pgm = new MigrationBuilder(db, ...)
 *     // constructor 里只有：this.db = { query, select }
 *
 * 后果分两层：
 *
 *   1. **up 跑不了** —— 直接 `TypeError: pgm.query is not a function`；
 *   2. **更糟的是它看起来成功了**：`pgmigrations` 表里记着
 *      `048 run_on 2026-10-21 14:10:10`，可 `packages.updated_at`
 *      是 14:09:36 —— 数据在登记前 34 秒就被别的办法改过了。
 *      也就是说，这条迁移**从未真正执行**，只是补了个记录。
 *
 * 这种「迁移记录说成功、代码其实是坏的」最危险的地方在于：
 * 下次真正需要它（新环境部署、回滚、迁移重放）时才会炸，
 * 而那时你已经忘了它没跑过。
 *
 * ## 这个测试做什么
 *
 * 用 node-pg-migrate 真实的 MigrationBuilder 构造 `pgm`，把每个迁移的
 * up / down 都真调一遍，断言不抛「API 用错」类错误。
 *
 * 注意**不要**把「故意的 fail-closed」判成失败：
 *
 *   · 019 缺 PIX_CREDENTIAL_KEY 时故意抛错（拒绝明文落库）
 *   · 019 的 down 故意不可回滚（退回明文 = 重新引入漏洞）
 *
 * 这两条是设计意图，不是缺陷。所以下面用白名单显式列出，
 * 且白名单的匹配是**精确到消息文本**的 —— 换个报错就不算数。
 */

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations')

/** 故意抛错、必须保留的迁移（按文件名 + 方向 + 报错片段精确匹配）。 */
const INTENTIONAL_THROWS = [
  {
    file: '019_encrypt_totp_secrets.js',
    direction: 'up',
    match: /未配置 PIX_CREDENTIAL_KEY/,
    why: '缺密钥时必须拒绝，否则 TOTP 密钥明文落库'
  },
  {
    file: '019_encrypt_totp_secrets.js',
    direction: 'down',
    match: /该迁移不可回滚/,
    why: '回滚等于把 TOTP 密钥退回明文'
  }
]

function loadBuilder() {
  // node-pg-migrate 8.x 的 package.json 没有在 exports 里暴露这些子路径 ——
  // `require.resolve('node-pg-migrate/dist/bundle/index.js')` 会被 exports 映射
  // 改写成 legacy/dist/bundle/index.js.js（多拼一个 .js），所以这里直接按
  // node_modules 的物理路径加载。
  const bundled = path.join(
    __dirname, '..', 'node_modules', 'node-pg-migrate', 'dist', 'bundle', 'index.js'
  )
  assert.ok(fs.existsSync(bundled), `找不到 node-pg-migrate 的 bundle：${bundled}`)
  const mod = require(bundled)
  const MigrationBuilder = mod.MigrationBuilder || (mod.default && mod.default.MigrationBuilder)
  assert.ok(MigrationBuilder, '找不到 node-pg-migrate 的 MigrationBuilder')
  return MigrationBuilder
}

/**
 * 尽量真实的假 db：
 *   · `SELECT count(*)` 返回 [{n:0}]，让「有数据就拒绝」的保护不误触发
 *   · 其余返回空行集
 *   · `select` 同理
 */
function fakeDb() {
  const queries = []
  return {
    queries,
    query: async sql => {
      queries.push(String(sql))
      if (/SELECT\s+count\(\*\)/i.test(String(sql))) return { rows: [{ n: 0, count: 0 }] }
      return { rows: [] }
    },
    select: async () => ({ rows: [] })
  }
}

function isIntentional(file, direction, message) {
  return INTENTIONAL_THROWS.find(
    item => item.file === file && item.direction === direction && item.match.test(message)
  )
}

const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.js')).sort()

test('迁移目录非空（防止测试自己静默失效）', () => {
  assert.ok(migrationFiles.length >= 40, `只找到 ${migrationFiles.length} 个迁移，路径或环境不对`)
})

test('每个迁移的 up / down 都能用真实的 pgm 跑通', async () => {
  const MigrationBuilder = loadBuilder()
  const silent = { debug() {}, info() {}, warn() {}, error() {} }
  const failures = []

  for (const file of migrationFiles) {
    const migration = require(path.join(MIGRATIONS_DIR, file))

    for (const direction of ['up', 'down']) {
      const fn = migration[direction]
      if (typeof fn !== 'function') {
        failures.push(`${file} 缺少 exports.${direction}`)
        continue
      }

      const builder = new MigrationBuilder(fakeDb(), {}, false, silent)
      try {
        await fn(builder)
      } catch (error) {
        const message = String(error && error.message)
        if (isIntentional(file, direction, message)) continue
        failures.push(`${file} 的 ${direction} 抛错：${message}`)
      }
    }
  }

  assert.deepEqual(
    failures,
    [],
    '以下迁移无法执行（部署 / 回滚时会炸）：\n' + failures.map(f => '  - ' + f).join('\n')
  )
})

test('★ 回归哨兵：迁移里不能出现 pgm.query（只存在 pgm.db.query）', () => {
  // 这条单独留着，因为报错信息 `pgm.query is not a function`
  // 太容易被当成"环境问题"忽略掉。静态扫描更早、更明确。
  const offenders = []
  for (const file of migrationFiles) {
    const source = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    // 匹配 pgm.query(，但排除 pgm.db.query(
    const re = /\bpgm\s*\.\s*query\s*\(/g
    let m
    while ((m = re.exec(source))) {
      const line = source.slice(0, m.index).split('\n').length
      offenders.push(`${file}:${line}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'node-pg-migrate 的 pgm 上没有 query 方法，必须写 pgm.db.query：\n'
      + offenders.map(o => '  - ' + o).join('\n')
  )
})

test('每个迁移都有 up 和 down（down 可以是显式拒绝，但不能缺失）', () => {
  const missing = []
  for (const file of migrationFiles) {
    const migration = require(path.join(MIGRATIONS_DIR, file))
    if (typeof migration.up !== 'function') missing.push(`${file}: up`)
    if (typeof migration.down !== 'function') missing.push(`${file}: down`)
  }
  assert.deepEqual(missing, [], '迁移必须同时导出 up 与 down')
})
