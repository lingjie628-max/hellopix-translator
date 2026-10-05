'use strict'

/**
 * 商户「回收字符」与「删除商户」。
 *
 * 重点在**不可逆操作的两个护栏**，以及那条曾经把实现绊倒的外键删除顺序：
 *
 *   1. `translate_logs.reservation_id → translation_reservations`（RESTRICT）
 *      决定了 translate_logs 必须先删；
 *   2. `recharges ↔ recharge_amount_reservations` 互成外键（循环引用），
 *      必须先断开 `recharges.amount_reservation_id` 才能删预约。
 *
 * 把顺序写反时，PostgreSQL 会直接报外键错误 —— 若没有事务，就会留下
 * "删了一半"的商户。所以这里既锁顺序，也锁"中途失败必须整体回滚"。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  PURGE_PLAN, parseAcknowledge, describeRemoved, reclaimChars, deleteMerchant
} = require('../server/lib/merchant-purge')
const { ApiError } = require('../server/lib/http')

const databaseUrl = process.env.PIX_TEST_DATABASE_URL

// ─────────────────────────── 纯逻辑（不碰数据库） ───────────────────────────

test('删除顺序：必须满足生产库实测的外键约束', () => {
  const order = PURGE_PLAN.map(step => step.table)
  const at = table => order.indexOf(table)

  assert.ok(at('translate_logs') < at('translation_reservations'),
    'translate_logs 必须先于 translation_reservations（translate_logs_reservation_fk）')
  assert.ok(at('recharge_amount_reservations') < at('recharges'),
    'recharge_amount_reservations 必须先于 recharges（recharge_amount_reservations_recharge_id_fkey）')
  assert.ok(at('translation_usage') < at('translation_reservations'),
    '用量记录是叶子，必须最早删')
})

test('acknowledge 只认明确的真值', () => {
  for (const value of [true, 'true', 1, '1', 'on']) {
    assert.equal(parseAcknowledge(value), true, `${JSON.stringify(value)} 应视为已确认`)
  }
  for (const value of [false, 'false', 0, '0', '', null, undefined, 'yes', 'ok']) {
    assert.equal(parseAcknowledge(value), false, `${JSON.stringify(value)} 不该视为已确认`)
  }
})

test('影响清单只报真的删到了的表', () => {
  assert.deepEqual(
    describeRemoved({ recharges: 5, translate_logs: 34, orders: 0, char_ledger: 0 }),
    ['充值单 5 条', '翻译记录 34 条']
  )
  assert.deepEqual(describeRemoved({}), [])
})

// ─────────────────────────── 真库（没有就跳过） ───────────────────────────

test('商户回收 / 删除：护栏与外键顺序', { skip: !databaseUrl }, async t => {
  process.env.DATABASE_URL = databaseUrl
  const { Pool } = require('pg')
  const { ProductionRepository } = require('../server/repositories/production-repository')

  const pool = new Pool({ connectionString: databaseUrl, max: 5 })
  const repo = new ProductionRepository(pool)
  const admin = { id: null, username: 'purge-test' }
  const ip = '127.0.0.1'

  const engineId = (await pool.query('SELECT id FROM engines ORDER BY id LIMIT 1')).rows[0].id

  let seq = 0
  const userIds = []

  async function makeUser(balance) {
    const name = `purge_${process.pid}_${Date.now()}_${++seq}`
    const { rows } = await pool.query(
      `INSERT INTO users(username,password_hash,nickname,email,email_verified,status,
         char_balance,char_used,translate_count,sub_quota,auto_alloc_master,auto_reply,
         enterprise,port_limit,ports_in_use,remarks)
       VALUES($1,'scrypt$s$h',$1,$2,false,1,$3,0,0,0,false,false,false,1,0,'') RETURNING id, username`,
      [name, `${name}@example.test`, balance || 0]
    )
    userIds.push(rows[0].id)
    return rows[0]
  }

  async function alive(userId) {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users WHERE id=$1', [userId])
    return rows[0].n === 1
  }

  /** 兜底清场：顺序与 `PURGE_PLAN` 一致，失败用例留下的残局靠它收尾。 */
  async function hardCleanup(userId) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM translation_usage WHERE user_id=$1', [userId])
      await client.query('DELETE FROM translate_logs WHERE user_id=$1', [userId])
      await client.query('DELETE FROM translation_reservations WHERE user_id=$1', [userId])
      await client.query('UPDATE recharges SET amount_reservation_id=NULL WHERE user_id=$1', [userId])
      await client.query(
        'DELETE FROM recharge_amount_reservations WHERE recharge_id IN (SELECT id FROM recharges WHERE user_id=$1)',
        [userId])
      await client.query('DELETE FROM recharges WHERE user_id=$1', [userId])
      await client.query('DELETE FROM character_transfers WHERE parent_id=$1', [userId])
      await client.query('DELETE FROM char_ledger WHERE user_id=$1', [userId])
      await client.query('DELETE FROM users WHERE id=$1', [userId])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  t.after(async () => {
    for (const userId of userIds) {
      await pool.query('DELETE FROM deleted_merchants WHERE user_id=$1', [userId]).catch(() => {})
      await hardCleanup(userId).catch(() => {})
    }
    await pool.end()
  })

  await t.test('回收字符：余额归零，且总账留下一条 correction 负数流水', async () => {
    const user = await makeUser(5000)

    const result = await reclaimChars({ repo, admin, ip, id: user.id })
    assert.equal(result.reclaimed, 5000)

    const balance = await pool.query('SELECT char_balance FROM users WHERE id=$1', [user.id])
    assert.equal(Number(balance.rows[0].char_balance), 0, '余额必须归零')

    const ledger = await pool.query(
      'SELECT delta, balance_after, reason FROM char_ledger WHERE user_id=$1', [user.id])
    assert.equal(ledger.rows.length, 1, '必须恰好一条流水')
    assert.equal(Number(ledger.rows[0].delta), -5000)
    assert.equal(Number(ledger.rows[0].balance_after), 0)
    assert.equal(ledger.rows[0].reason, 'correction')

    // 幂等：余额已是 0 时再回收，不能又追加一条 0 金额流水（char_ledger 有 delta<>0 约束）
    const second = await reclaimChars({ repo, admin, ip, id: user.id })
    assert.equal(second.reclaimed, 0)
    const count = await pool.query('SELECT count(*)::int AS n FROM char_ledger WHERE user_id=$1', [user.id])
    assert.equal(count.rows[0].n, 1, '不该产生第二条流水')
  })

  await t.test('删除：账号名对不上必须拒绝，且不动任何数据', async () => {
    const user = await makeUser(0)

    await assert.rejects(
      () => deleteMerchant({ repo, admin, ip, id: user.id, confirmUsername: 'wrong-name' }),
      error => error instanceof ApiError && error.code === 'CONFIRM_USERNAME_MISMATCH'
    )
    assert.ok(await alive(user.id), '确认失败时商户必须原样保留')

    const archive = await pool.query('SELECT count(*)::int AS n FROM deleted_merchants WHERE user_id=$1', [user.id])
    assert.equal(archive.rows[0].n, 0, '确认失败时不该留下存档')
  })

  await t.test('删除：干净账号不需要 acknowledge，并写入存档', async () => {
    const user = await makeUser(0)

    const result = await deleteMerchant({
      repo, admin, ip, id: user.id, confirmUsername: user.username, reason: '单测清理'
    })
    assert.deepEqual(result.business, [])
    assert.equal(await alive(user.id), false, '商户必须已删除')

    const archive = await pool.query(
      'SELECT username, reason, removed FROM deleted_merchants WHERE user_id=$1', [user.id])
    assert.equal(archive.rows.length, 1)
    assert.equal(archive.rows[0].username, user.username)
    assert.equal(archive.rows[0].reason, '单测清理')
  })

  await t.test('删除：有业务记录先 409，确认后再删，且中途拒绝必须整体回滚', async () => {
    const user = await makeUser(3000)

    // 造出两道外键陷阱：translate_logs→translation_reservations，
    // 以及 amount_reservation 侧（这里只造前者，后者由 order 相关用例覆盖）
    // 注意：source_hash / request_hash 有 `^[0-9a-f]{64}$` 的约束，不能随便填。
    const sourceHash = 'a'.repeat(64)
    const requestHash = 'b'.repeat(64)
    const reservation = await pool.query(
      `INSERT INTO translation_reservations(user_id,engine_id,idempotency_key,reserved_chars,expires_at,
         source_language,target_language,source_hash,request_hash)
       VALUES($1,$2,$3,10,NOW()+interval '1 hour','zh','en',$4,$5) RETURNING id`,
      [user.id, engineId, `purgetest:${user.id}:${Date.now()}`, sourceHash, requestHash]
    )
    await pool.query(
      `INSERT INTO translate_logs(user_id,engine_id,source_language,target_language,chars,source_hash,reservation_id)
       VALUES($1,$2,'zh','en',10,$3,$4)`,
      [user.id, engineId, sourceHash, reservation.rows[0].id]
    )

    await assert.rejects(
      () => deleteMerchant({ repo, admin, ip, id: user.id, confirmUsername: user.username }),
      error => error instanceof ApiError
        && error.code === 'NEED_ACKNOWLEDGE'
        && error.details.removed.translate_logs === 1
        && error.details.business.includes('translation_reservations')
    )

    // 被拒绝之后事务必须整体回滚：商户还在、存档还没写
    assert.ok(await alive(user.id), '未确认时商户必须原样保留')
    const noArchive = await pool.query('SELECT count(*)::int AS n FROM deleted_merchants WHERE user_id=$1', [user.id])
    assert.equal(noArchive.rows[0].n, 0, '未确认时不该留下存档')

    // 带上 acknowledge 才真正执行 —— 此时 translate_logs 必须先于 reservations 被删，
    // 顺序错了这里会直接抛外键错误。
    const result = await deleteMerchant({
      repo, admin, ip, id: user.id, confirmUsername: user.username, acknowledge: 'true', reason: '单测：带历史'
    })
    assert.deepEqual(result.business.slice().sort(), ['translate_logs', 'translation_reservations'])
    assert.equal(await alive(user.id), false)

    for (const table of ['translate_logs', 'translation_reservations', 'translation_usage']) {
      const left = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`, [user.id])
      assert.equal(left.rows[0].n, 0, `${table} 应当已清空`)
    }

    const archive = await pool.query('SELECT removed, snapshot FROM deleted_merchants WHERE user_id=$1', [user.id])
    assert.equal(archive.rows.length, 1)
    assert.equal(Number(archive.rows[0].removed.translate_logs), 1)
    assert.equal(Number(archive.rows[0].removed.translation_reservations), 1)
    // 存档里绝不能出现口令材料
    assert.equal(archive.rows[0].snapshot.user.password_hash, undefined, '存档不得包含 password_hash')
    assert.equal(archive.rows[0].snapshot.user.username, user.username)
  })
})
