'use strict'

/**
 * 子账号删除（软删除）。
 *
 * 这个功能真正难的不是"把行标成删了"，而是**删完之后不能留下烂摊子**。
 * 下面每一条都对应一个线上真会踩到的坑：
 *
 *   1. 余额退回主账号 —— 子账号的钱本来就是主账号划过去的，
 *      不退回就等于凭空虚耗，而且流水上查不出任何痕迹；
 *   2. 名额不再被占用 —— 名额判定是 `count(*)`，软删除的行会永远占位，
 *      商户删得越多越开不出新的；
 *   3. 用户名可以复用 —— 唯一索引是全局的，不放开就永远不能重建同名；
 *   4. 旧会话立刻失效 —— 删了还能用旧 token 继续翻译，等于没删；
 *   5. 账本原样保留 —— 这是选择软删除而不是物理删除的**唯一理由**。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const databaseUrl = process.env.PIX_TEST_DATABASE_URL

// ─────────────────────────── 静态护栏（不碰数据库） ───────────────────────────

test('软删除迁移：唯一索引必须是「只约束存活行」的部分索引', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '049_sub_account_soft_delete.js'), 'utf8')

  assert.match(sql, /ADD COLUMN IF NOT EXISTS deleted_at timestamptz/)
  // 两个原索引必须先 drop，再用 WHERE deleted_at IS NULL 重建，
  // 否则删掉的子账号会永久占住用户名/邮箱。
  assert.match(sql, /DROP INDEX IF EXISTS sub_accounts_username_lower_uidx/)
  assert.match(sql, /DROP INDEX IF EXISTS sub_accounts_email_lower_uidx/)
  assert.match(sql, /sub_accounts_username_lower_alive_uidx[\s\S]*?WHERE deleted_at IS NULL/)
  assert.match(sql, /sub_accounts_email_lower_alive_uidx[\s\S]*?WHERE deleted_at IS NULL/)
})

// ─────────────────────────── 真库行为 ───────────────────────────

test('子账号删除：退余额 / 让名额 / 可重建同名 / 账本保留', { skip: !databaseUrl }, async t => {
  process.env.DATABASE_URL = databaseUrl
  const { Pool } = require('pg')
  const { ProductionRepository } = require('../server/repositories/production-repository')
  const { CoreService } = require('../server/services/core-service')

  const pool = new Pool({ connectionString: databaseUrl, max: 5 })
  const repo = new ProductionRepository(pool)

  const engineId = (await pool.query('SELECT id FROM engines ORDER BY id LIMIT 1')).rows[0].id

  // auth 只用到 revokeUser / hash，这里用最小桩即可，
  // 目的是验证"会话被清掉"这一步被调用了，不测 Redis 本身。
  const revoked = []
  const auth = {
    revokeUser: async (kind, id) => { revoked.push(kind + ':' + id) },
    hash: async value => `scrypt$s$${Buffer.from(String(value)).toString('hex')}`,
    verify: async () => true
  }
  // 删号流程不碰 Redis，但 CoreService 构造时要求它像个 ioredis 客户端。
  // 这里给个空桩即可，避免测试被无关的依赖校验挡住。
  const redis = Object.assign(Object.create(null), {
    get: async () => null,
    set: async () => 'OK'
  })
  const core = new CoreService(repo, redis, auth, { translator: {}, translationCache: {} })

  let seq = 0
  const createdParents = []

  async function makeParent(balance, quota) {
    const name = `subdel_${process.pid}_${Date.now()}_${++seq}`
    const { rows } = await pool.query(
      `INSERT INTO users(username,password_hash,nickname,email,email_verified,status,
         char_balance,char_used,translate_count,sub_quota,auto_alloc_master,auto_reply,
         enterprise,port_limit,ports_in_use,remarks,active_engine_id)
       VALUES($1,'scrypt$s$h',$1,$2,false,1,$3,0,0,$4,false,false,false,1,0,'',$5)
       RETURNING id, username, char_balance, sub_quota`,
      [name, `${name}@example.test`, balance, quota, engineId]
    )
    createdParents.push(rows[0].id)
    return rows[0]
  }

  t.after(async () => {
    for (const parentId of createdParents) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        // 账本是 RESTRICT 的，必须先按叶子→根的顺序清掉
        await client.query(
          `DELETE FROM translation_usage WHERE sub_account_id IN (SELECT id FROM sub_accounts WHERE parent_id=$1)`,
          [parentId])
        await client.query(
          `DELETE FROM translate_logs WHERE sub_account_id IN (SELECT id FROM sub_accounts WHERE parent_id=$1)`,
          [parentId])
        await client.query(
          `DELETE FROM translation_reservations WHERE sub_account_id IN (SELECT id FROM sub_accounts WHERE parent_id=$1)`,
          [parentId])
        await client.query('DELETE FROM character_transfers WHERE parent_id=$1', [parentId])
        await client.query('DELETE FROM sub_accounts WHERE parent_id=$1', [parentId])
        await client.query('DELETE FROM users WHERE id=$1', [parentId])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }
    await pool.end()
  })

  const parent = await makeParent(100000, 5)
  const session = {
    kind: 'main',
    account: parent,
    parent: Object.assign({}, parent, { subQuota: 5, activeEngineId: engineId })
  }

  // ── 建一个子账号，并从主账号划 3 万字符过去 ──
  await core.saveSub(session, { username: `kid_${parent.id}`, password: 'secret123', nickname: '小明' })
  const kid = (await pool.query(
    'SELECT * FROM sub_accounts WHERE parent_id=$1 AND deleted_at IS NULL', [parent.id])).rows[0]
  assert.ok(kid, '子账号应已创建')
  await core.transferChars(session, { id: kid.id, chars: 30000, requestId: `t-${kid.id}` })

  const afterTransfer = (await pool.query(
    'SELECT char_balance FROM users WHERE id=$1', [parent.id])).rows[0]
  assert.equal(Number(afterTransfer.char_balance), 70000, '划出后主账号应为 70000')

  // 造一条翻译账本，验证删除后**必须留着**
  await pool.query(
    `INSERT INTO translate_logs(user_id,sub_account_id,engine_id,source_language,target_language,
       chars,source_hash,snippet,created_at)
     VALUES($1,$2,$3,'en','zh',5,repeat('a',64),'hello',NOW())`,
    [parent.id, kid.id, engineId])

  // ── 删除 ──
  const result = await core.deleteSub(session, { id: kid.id })
  assert.equal(result.refund, 30000, '应退回 30000 字符')
  assert.match(result.msg, /退回/)

  // 1) 行还在，但已标删除
  const gone = (await pool.query('SELECT deleted_at, char_balance, status FROM sub_accounts WHERE id=$1', [kid.id])).rows[0]
  assert.ok(gone.deleted_at, '子账号应被软删除')
  assert.equal(Number(gone.char_balance), 0, '子账号余额应归零')
  assert.equal(Number(gone.status), 0, '子账号应同时置为停用')

  // 2) 余额回到主账号
  const back = (await pool.query('SELECT char_balance FROM users WHERE id=$1', [parent.id])).rows[0]
  assert.equal(Number(back.char_balance), 100000, '余额应完整退回主账号')

  // 3) 退回动作有流水可查
  const refundRow = (await pool.query(
    `SELECT amount FROM character_transfers WHERE parent_id=$1 AND sub_account_id=$2 ORDER BY id DESC LIMIT 1`,
    [parent.id, kid.id])).rows[0]
  assert.equal(Number(refundRow.amount), -30000, '应留下一条负向划转，金额 -30000')

  // 4) 账本保留（这就���软删除的全部意义）
  const logKeep = (await pool.query(
    'SELECT count(*)::int AS n FROM translate_logs WHERE sub_account_id=$1', [kid.id])).rows[0]
  assert.equal(logKeep.n, 1, '翻译记录必须原样保留')

  // 5) 会话被清掉
  assert.ok(revoked.includes(`sub:${kid.id}`), '删除后必须清理该子账号的会话')

  // 6) 列表和名额都不再算它
  const list = await repo.list('subs', {
    where: 'parent_id=$1 AND deleted_at IS NULL', values: [parent.id], limit: 100, offset: 0
  })
  assert.equal(list.rows.filter(row => String(row.id) === String(kid.id)).length, 0, '列表中不该再出现')
  const info = await core.teamInfo(session)
  assert.equal(info.subCount, 0, '已删除的子账号不该占用名额')

  // 7) 同名可以重建 —— 这条最容易漏：merchant_identities 的唯一索引
  await core.saveSub(session, { username: `kid_${parent.id}`, password: 'secret123', nickname: '小明2' })
  const recreated = (await pool.query(
    'SELECT id, deleted_at FROM sub_accounts WHERE parent_id=$1 AND deleted_at IS NULL', [parent.id])).rows[0]
  assert.ok(recreated, '删掉之后应能用同名重建')
  assert.notEqual(String(recreated.id), String(kid.id), '重建的应是新行')

  // 8) 再删一次同一个 id 应报 404，而不是"删了两遍退两次钱"
  await assert.rejects(
    () => core.deleteSub(session, { id: kid.id }),
    error => error.code === 'SUB_NOT_FOUND'
  )

  // 9) 别人家的子账号删不动（租户隔离）
  const otherParent = await makeParent(5000, 5)
  const otherSession = {
    kind: 'main',
    account: otherParent,
    parent: Object.assign({}, otherParent, { subQuota: 5, activeEngineId: engineId })
  }
  await assert.rejects(
    () => core.deleteSub(otherSession, { id: recreated.id }),
    error => error.code === 'SUB_NOT_FOUND'
  )
})

test('子账号删除：子账号自己不能调用（仅主账号）', async t => {
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/none'
  const { CoreService } = require('../server/services/core-service')
  const core = new CoreService({}, { get() {}, set() {} }, {}, { translator: {}, translationCache: {} })
  await assert.rejects(
    () => core.deleteSub({ kind: 'sub', account: { id: 1 }, parent: { id: 1 } }, { id: 1 }),
    error => error.code === 'MAIN_ACCOUNT_REQUIRED'
  )
})
