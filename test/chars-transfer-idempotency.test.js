'use strict'

/**
 * 主账号 → 子账号划字符的幂等。
 *
 * 线上形态：用户点了「确定」，网络慢没收到响应，又点了一次 ——
 * 或者前端超时自动重试。如果没有幂等键，就会扣两次、加两次。
 *
 * 原来的写法是 `data.requestId || null`，而 `character_transfers` 上的
 * `UNIQUE (parent_id, idempotency_key)` 在 PostgreSQL 里**对 NULL 不生效**
 * （NULL 互不相等），所以「没有键」等于「幂等完全失效」。
 *
 * 这里连真库跑，直接看余额，不看返回值。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const databaseUrl = process.env.PIX_TEST_DATABASE_URL
const redisUrl = process.env.PIX_TEST_REDIS_URL

function reachable(rawUrl) {
  let url
  try { url = new URL(rawUrl) } catch (e) { return false }
  const port = Number(url.port || (url.protocol === 'redis:' ? 6379 : 5432))
  const host = url.hostname || '127.0.0.1'
  const probe = `
    const net = require('node:net')
    const s = net.connect(${port}, ${JSON.stringify(host)})
    const done = ok => { try { s.destroy() } catch (e) {} process.exit(ok ? 0 : 1) }
    s.setTimeout(1200, () => done(false))
    s.on('connect', () => done(true))
    s.on('error', () => done(false))
  `
  const r = require('node:child_process').spawnSync(process.execPath, ['-e', probe], { timeout: 4000 })
  return r.status === 0
}

const unreachable = []
if (databaseUrl && !reachable(databaseUrl)) unreachable.push('PIX_TEST_DATABASE_URL')
if (redisUrl && !reachable(redisUrl)) unreachable.push('PIX_TEST_REDIS_URL')

test('同一 requestId 划字符只扣一次', {
  skip: !databaseUrl || !redisUrl
    ? '未配置 PIX_TEST_DATABASE_URL / PIX_TEST_REDIS_URL'
    : unreachable.length ? unreachable.join(' / ') + ' 连不上' : false
}, async () => {
  process.env.DATABASE_URL = databaseUrl
  const isolated = new URL(redisUrl)
  isolated.pathname = '/15'
  process.env.REDIS_URL = isolated.toString()

  const { pool } = require('../server/db/postgres')
  const { getRedis, closeRedis } = require('../server/db/redis')
  const { ProductionRepository } = require('../server/repositories/production-repository')
  const { CoreService } = require('../server/services/core-service')
  const { hashPassword } = require('../server/security')

  const redis = getRedis()
  await redis.connect()
  const repo = new ProductionRepository(pool)
  const core = new CoreService(repo, redis, {}, { translator: null })

  const suffix = `${process.pid}_${Date.now()}`
  let parentId
  let subId

  try {
    const pkg = await repo.query('SELECT id FROM packages ORDER BY id LIMIT 1')
    assert.ok(pkg.rows[0], '库里没有套餐，先跑 npm run test:env 初始化')

    parentId = (await repo.query(
      `INSERT INTO users(username,password_hash,nickname,status,package_id,char_balance)
       VALUES($1,$2,$1,1,$3,1000000) RETURNING id`,
      [`idem_${suffix}`, hashPassword('Idem-Pass9!'), pkg.rows[0].id]
    )).rows[0].id

    subId = (await repo.query(
      `INSERT INTO sub_accounts(parent_id,username,password_hash,nickname,status,char_balance)
       VALUES($1,$2,$3,$2,1,0) RETURNING id`,
      [parentId, `idemsub_${suffix}`, hashPassword('Idem-Pass9!')]
    )).rows[0].id

    const session = await repo.sessionAccount(`main:${parentId}`)
    assert.ok(session, '会话装配失败')

    const before = async () => ({
      parent: Number((await pool.query('SELECT char_balance FROM users WHERE id=$1', [parentId])).rows[0].char_balance),
      sub: Number((await pool.query('SELECT char_balance FROM sub_accounts WHERE id=$1', [subId])).rows[0].char_balance)
    })

    const start = await before()

    // 同一个 requestId 提交两次 —— 模拟"点两下 / 超时重试"
    const once = await core.transferChars(session, { id: subId, chars: 5000, requestId: `rid_${suffix}` })
    const twice = await core.transferChars(session, { id: subId, chars: 5000, requestId: `rid_${suffix}` })
    assert.equal(once.chars, 5000)
    assert.equal(twice.replayed, true, '第二次同 requestId 必须识别为重放，而不是再扣一次')

    const after = await before()
    assert.equal(after.parent, start.parent - 5000, `主账号应只扣 5000，实际扣了 ${start.parent - after.parent}`)
    assert.equal(after.sub, start.sub + 5000, `子账号应只加 5000，实际加了 ${after.sub - start.sub}`)

    // 不同 requestId 才是真的第二笔
    await core.transferChars(session, { id: subId, chars: 1000, requestId: `rid2_${suffix}` })
    const final = await before()
    assert.equal(final.parent, start.parent - 6000)
    assert.equal(final.sub, start.sub + 6000)

    // 不传 requestId 也要落一个非空幂等键，否则唯一约束形同虚设
    await core.transferChars(session, { id: subId, chars: 1 })
    const keys = await pool.query(
      'SELECT idempotency_key FROM character_transfers WHERE parent_id=$1', [parentId])
    assert.ok(keys.rows.every((r) => r.idempotency_key), 'character_transfers 里出现了 NULL 幂等键')
    assert.equal(new Set(keys.rows.map((r) => r.idempotency_key)).size, keys.rows.length, '幂等键出现重复')
  } finally {
    if (subId) {
      await pool.query('DELETE FROM character_transfers WHERE parent_id=$1', [parentId])
      await pool.query('DELETE FROM sub_accounts WHERE id=$1', [subId])
    }
    if (parentId) await pool.query('DELETE FROM users WHERE id=$1', [parentId])
    try { await redis.flushdb() } catch (e) {}
    await closeRedis()
    await pool.end()
  }
})
