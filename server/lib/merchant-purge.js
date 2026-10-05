'use strict'

/**
 * 商户「回收字符」与「删除商户」。
 *
 * 这两件事**必须分开**，因为它们对账务的影响完全不同：
 *
 *   · 回收字符 —— 账号留着，只把余额归零。总账（`char_ledger`）追加一条
 *     `reason='correction'` 的负数流水，"余额为什么少了 N" 有答案。
 *   · 删除商户 —— 连人带账一起清掉。因为 `char_ledger.user_id` 是
 *     `ON DELETE RESTRICT`，删人必然连带删流水，所以**删除的痕迹不能放流水**，
 *     只能放一张不挂外键的存档表 `deleted_merchants`（迁移 038）。
 *
 * ## 删除顺序是被生产库外键实测钉死的
 *
 *   · `translation_reservations` ← `translate_logs`          （RESTRICT）
 *   · `recharges` ↔ `recharge_amount_reservations`           （互成外键，循环引用）
 *
 * 第一版把顺序写反，被外键挡下、靠事务整体回滚（没有产生半删状态）。
 * 顺序改错会立刻被 `test/merchant-purge.test.js` 打红。
 */

const crypto = require('crypto')
const { ApiError } = require('./http')

/**
 * 删除计划：**严格按此顺序执行**。
 *
 * `where` 语义：
 *   user_id          → 本商户直接持有
 *   parent_id        → 主账号（子账号侧的归属列）
 *   recharge_of_user → 间接挂在"本商户的充值单"下
 */
const PURGE_PLAN = Object.freeze([
  { table: 'translation_usage', label: '翻译用量', where: 'user_id' },
  { table: 'translate_logs', label: '翻译记录', where: 'user_id' },
  // 必须在 translation_usage / translate_logs 之后：
  // translate_logs.reservation_id → translation_reservations 是 RESTRICT
  { table: 'translation_reservations', label: '翻译预留', where: 'user_id' },
  // recharges ↔ recharge_amount_reservations 互成外键（循环），
  // 调用方会先把 recharges.amount_reservation_id 置空来断环，再走到这一步
  { table: 'recharge_amount_reservations', label: '金额预约', where: 'recharge_of_user' },
  { table: 'recharges', label: '充值单', where: 'user_id' },
  { table: 'orders', label: '工单', where: 'user_id' },
  { table: 'character_transfers', label: '字符划转', where: 'parent_id' },
  { table: 'char_ledger', label: '字符流水', where: 'user_id' }
])

/**
 * 不属于"删除计划"、但会被 `DELETE FROM users` 顺带处理的表。
 * 列在这里只为**如实告诉操作人**到底会波及多少数据。
 */
const CASCADE_TABLES = Object.freeze([
  ['sub_accounts', 'parent_id'],
  ['conversations', 'user_id'],
  ['messages', 'user_id'],
  ['customer_merchant_links', 'user_id'],
  ['customer_owners', 'user_id'],
  ['scripts', 'user_id'],
  ['login_logs', 'user_id'],
  ['short_links', 'user_id'],
  ['identity_match_events', 'source_user_id']
])

/** 有这些记录 = 账号里有"生意痕迹"，删除需要操作人显式确认。 */
const BUSINESS_TABLES = Object.freeze([
  'recharges',
  'translate_logs',
  'translation_reservations',
  'translation_usage',
  'orders',
  'character_transfers',
  'char_ledger'
])

const LABELS = Object.freeze(
  PURGE_PLAN.reduce((out, step) => Object.assign(out, { [step.table]: step.label }), {
    sub_accounts: '子账号',
    conversations: '会话',
    messages: '消息',
    customer_merchant_links: '客户绑定',
    customer_owners: '客户归属',
    scripts: '脚本',
    login_logs: '登录日志',
    short_links: '短链',
    identity_match_events: '身份匹配'
  })
)

function deleteSql(step) {
  if (step.where === 'recharge_of_user') {
    return `DELETE FROM ${step.table} WHERE recharge_id IN (SELECT id FROM recharges WHERE user_id=$1)`
  }
  return `DELETE FROM ${step.table} WHERE ${step.where}=$1`
}

function countSql(table, where) {
  if (where === 'recharge_of_user') {
    return `SELECT count(*)::int AS n FROM recharge_amount_reservations WHERE recharge_id IN (SELECT id FROM recharges WHERE user_id=$1)`
  }
  return `SELECT count(*)::int AS n FROM ${table} WHERE ${where}=$1`
}

async function countOf(repo, table, where, userId, client) {
  const result = await repo.query(countSql(table, where), [userId], client)
  return Number(result.rows[0].n) || 0
}

/**
 * 这张商户被删时会波及多少行 —— 先算清楚再给操作人看，避免"点一下发现删了 3 万条"。
 */
async function removedCounts(repo, userId, client) {
  const counts = {}
  for (const step of PURGE_PLAN) {
    counts[step.table] = await countOf(repo, step.table, step.where, userId, client)
  }
  for (const [table, where] of CASCADE_TABLES) {
    if (counts[table] === undefined) counts[table] = await countOf(repo, table, where, userId, client)
  }
  return counts
}

function describeRemoved(removed) {
  return Object.keys(removed)
    .filter(table => removed[table] > 0)
    .map(table => `${LABELS[table] || table} ${removed[table]} 条`)
}

/**
 * 快照：商户行（剔掉 password_hash）+ 账目类小表的全部行。
 * 高流量表只记条数（见迁移 038 的注释）。
 */
async function buildSnapshot(repo, user, client) {
  const safeUser = Object.assign({}, user)
  delete safeUser.password_hash
  delete safeUser.passwordHash

  const dump = async (table, where) => {
    const result = await repo.query(
      `SELECT * FROM ${table} WHERE ${where}=$1 ORDER BY id`, [user.id], client
    )
    return result.rows
  }

  return {
    user: safeUser,
    recharges: await dump('recharges', 'user_id'),
    char_ledger: await dump('char_ledger', 'user_id'),
    character_transfers: await dump('character_transfers', 'parent_id'),
    orders: await dump('orders', 'user_id')
  }
}

function parseAcknowledge(value) {
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on'
}

/**
 * 回收字符：账号保留，余额归零，总账追加一条 `correction` 负数流水。
 *
 * 为什么必须写流水：总账的用途就是回答"余额对不对得上"。如果直接
 * `UPDATE users SET char_balance=0`，事后看到余额少了却查不到任何变动记录 ——
 * 那正是 024 迁移要消灭的缺口。
 */
async function reclaimChars({ repo, admin, ip, id, note }) {
  const targetId = Number(id)
  if (!Number.isInteger(targetId) || targetId < 1) {
    throw new ApiError(400, '缺少商户 ID', 'USER_ID_REQUIRED')
  }

  return repo.transaction(async client => {
    const found = await repo.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [targetId], client)
    const row = found.rows[0]
    if (!row) throw new ApiError(404, '商户不存在', 'USER_NOT_FOUND')

    const balance = Number(row.char_balance) || 0
    if (balance <= 0) {
      return { username: row.username, userId: row.id, reclaimed: 0, ledgerId: null }
    }

    // 总账是追加写、不可改的：回收也要留一条负数流水，而不是抹掉历史。
    const inserted = await repo.query(
      `INSERT INTO char_ledger(user_id,delta,balance_after,reason,note,idempotency_key)
       VALUES($1,$2,0,'correction',$3,$4) RETURNING id`,
      [
        row.id,
        -balance,
        String(note || '后台回收字符').slice(0, 200),
        `reclaim:${row.id}:${crypto.randomUUID()}`
      ],
      client
    )
    await repo.query('UPDATE users SET char_balance=0,updated_at=NOW() WHERE id=$1', [row.id], client)
    await repo.audit(client, admin, '回收字符', `${row.username} -${balance}`, ip, { type: 'user', id: row.id })

    return { username: row.username, userId: row.id, reclaimed: balance, ledgerId: inserted.rows[0].id }
  })
}

/**
 * 删除商户：存档 → 断环 → 按顺序删 → 删主表。
 *
 * 全部在**一个事务**里：任一步失败整体回滚，不会留下"删了一半"的商户 ——
 * 一个只剩下 users 行、业务数据已被清空，而 user_id 又指着它的账号。
 */
async function deleteMerchant({ repo, admin, ip, id, confirmUsername, acknowledge, reason }) {
  const targetId = Number(id)
  if (!Number.isInteger(targetId) || targetId < 1) {
    throw new ApiError(400, '缺少商户 ID', 'USER_ID_REQUIRED')
  }

  const committed = await repo.transaction(async client => {
    const found = await repo.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [targetId], client)
    const user = found.rows[0]
    if (!user) throw new ApiError(404, '商户不存在', 'USER_NOT_FOUND')

    // 二次确认：必须一字不差地打出账号名。
    // 删除是不可逆的，"点错行"不能只靠一个 OK 按钮来防。
    const typed = String(confirmUsername == null ? '' : confirmUsername).trim()
    if (typed !== user.username) {
      throw new ApiError(400, `请在确认框里输入完整账号「${user.username}」`, 'CONFIRM_USERNAME_MISMATCH')
    }

    const removed = await removedCounts(repo, user.id, client)
    const business = BUSINESS_TABLES.filter(table => removed[table] > 0)

    // 有生意痕迹 → 第一次返回 409 并把"会删掉什么"带回去，
    // 由前端渲染成确认弹窗，操作人再点一次才真正执行。
    if (business.length && !parseAcknowledge(acknowledge)) {
      throw new ApiError(
        409,
        `该商户有 ${describeRemoved(removed).join('、')}，删除后将一并清除且不可恢复`,
        'NEED_ACKNOWLEDGE',
        { removed, business }
      )
    }

    const snapshot = await buildSnapshot(repo, user, client)

    // 1) 存档先落地：它不挂外键，商户删掉之后仍然查得到。
    await repo.query(
      `INSERT INTO deleted_merchants(user_id,username,nickname,email,char_balance,char_used,
         removed,snapshot,reason,actor,ip)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,NULLIF($11,'')::inet)`,
      [
        user.id, user.username, user.nickname || null, user.email || null,
        Number(user.char_balance) || 0, Number(user.char_used) || 0,
        JSON.stringify(removed), JSON.stringify(snapshot),
        String(reason || '').slice(0, 200),
        String((admin && admin.username) || admin || 'system').slice(0, 64),
        ip || ''
      ],
      client
    )

    // 2) 断开循环引用：recharges → recharge_amount_reservations 的指针
    await repo.query(
      'UPDATE recharges SET amount_reservation_id=NULL WHERE user_id=$1 AND amount_reservation_id IS NOT NULL',
      [user.id], client
    )

    // 3) 按实测顺序删受限子表
    for (const step of PURGE_PLAN) {
      await repo.query(deleteSql(step), [user.id], client)
    }

    // 4) 主表：其余子表走 CASCADE / SET NULL
    await repo.query('DELETE FROM users WHERE id=$1', [user.id], client)

    await repo.audit(
      client, admin, '删除商户',
      `${user.username}（余额 ${Number(user.char_balance) || 0}${business.length ? '；' + describeRemoved(removed).join('、') : ''}）`,
      ip, { type: 'user', id: user.id }
    )

    return { user, removed, business }
  })

  return {
    username: committed.user.username,
    userId: committed.user.id,
    charBalance: Number(committed.user.char_balance) || 0,
    removed: committed.removed,
    business: committed.business
  }
}

module.exports = {
  PURGE_PLAN,
  CASCADE_TABLES,
  BUSINESS_TABLES,
  LABELS,
  reclaimChars,
  deleteMerchant,
  removedCounts,
  describeRemoved,
  parseAcknowledge
}
