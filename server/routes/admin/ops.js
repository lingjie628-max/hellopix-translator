'use strict'

/**
 * 后台 · 运营工具：FAQ、分流短链、话术库、账号在线、粉丝。
 *
 * 这一组都是"给客服/运营看的"数据，不涉及资金，出问题影响面最小。
 */

const { asyncRoute, input, pagination, page, ok, ApiError } = require('../../lib/http')
const { mapRows } = require('../../repositories/production-repository')

function registerAdminOps(router, ctx) {
  const { repo } = ctx

  const ACCOUNT_ONLINE_WINDOW_MINUTES = 10

  const ONLINE_WINDOW_SQL = Number.isInteger(ACCOUNT_ONLINE_WINDOW_MINUTES) && ACCOUNT_ONLINE_WINDOW_MINUTES > 0
    ? String(ACCOUNT_ONLINE_WINDOW_MINUTES)
    : '10'

  router.get('/admin/faqs', asyncRoute(async (_req, res) => {
    res.json(mapRows((await repo.query(
      'SELECT id,question,answer,sort_order AS sort,enabled FROM faqs ORDER BY sort_order,id'
    )).rows))
  }))

  router.post('/admin/faqs/save', asyncRoute(async (req, res) => {
    const data = input(req)
    const question = String(data.question || '').trim()
    if (!question) throw new ApiError(400, '问题不能为空', 'FAQ_QUESTION_REQUIRED')
    const answer = String(data.answer || '').slice(0, 10000)
    const sort = Math.max(0, Math.floor(Number(data.sort) || 0))
    const enabled = Number(data.enabled) ? true : false
    if (data.id) {
      const updated = await repo.query(
        `UPDATE faqs SET question=$2,answer=$3,sort_order=$4,enabled=$5,updated_at=NOW()
         WHERE id=$1 RETURNING id`, [Number(data.id), question, answer, sort, enabled])
      if (!updated.rows[0]) throw new ApiError(404, 'FAQ 不存在', 'FAQ_NOT_FOUND')
    } else {
      await repo.query(
        'INSERT INTO faqs(question,answer,sort_order,enabled) VALUES($1,$2,$3,$4)',
        [question, answer, sort, enabled])
    }
    await repo.audit(null, req.pixAdmin, data.id ? '编辑FAQ' : '新增FAQ', question.slice(0, 60), req.ip, { type: 'faq', id: data.id || null })
    ok(res, data.id ? 'FAQ 已更新' : 'FAQ 已新增')
  }))

  router.get('/admin/links', asyncRoute(async (req, res) => {
    const data = input(req)
    const paging = pagination(req, { size: 50 })
    const values = []
    let filter = ''
    if (data.keyword) {
      values.push(`%${data.keyword}%`)
      filter = ' AND (l.code ILIKE $1 OR l.message ILIKE $1 OR u.username ILIKE $1)'
    }
    const total = await repo.query(
      `SELECT count(*)::bigint AS total FROM short_links l LEFT JOIN users u ON u.id=l.user_id WHERE TRUE${filter}`, values)
    const rows = await repo.query(
      `SELECT l.id, COALESCE(u.username,'') AS username, l.order_serial AS "orderNum", l.code,
              l.target, l.hits, l.accounts, l.message
       FROM short_links l LEFT JOIN users u ON u.id=l.user_id
       WHERE TRUE${filter} ORDER BY l.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      values.concat([paging.size, paging.offset]))
    res.json(Object.assign(page(mapRows(rows.rows), total.rows[0].total, paging), {
      rows: rows.rows.map(row => Object.assign(row, {
        orderNum: row.orderNum || '',
        shareLink: row.target
      }))
    }))
  }))

  router.get('/admin/scripts', asyncRoute(async (req, res) => {
    const data = input(req)
    const paging = pagination(req, { size: 50 })
    const values = []
    let filter = ''
    if (data.keyword) {
      values.push(`%${data.keyword}%`)
      filter = ' AND (s.keyword ILIKE $1 OR s.source ILIKE $1 OR s.target ILIKE $1 OR u.username ILIKE $1)'
    }
    const total = await repo.query(
      `SELECT count(*)::bigint AS total FROM scripts s LEFT JOIN users u ON u.id=s.user_id WHERE TRUE${filter}`, values)
    const rows = await repo.query(
      `SELECT s.id, COALESCE(u.username,'') AS username, s.group_title AS "groupTitle",
              s.keyword, s.source, s.target
       FROM scripts s LEFT JOIN users u ON u.id=s.user_id
       WHERE TRUE${filter} ORDER BY s.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      values.concat([paging.size, paging.offset]))
    res.json(page(mapRows(rows.rows), total.rows[0].total, paging))
  }))

  router.get('/admin/accounts', asyncRoute(async (req, res) => {
    const data = input(req)
    const paging = pagination(req, { size: 50 })
    const values = []
    const clauses = ['TRUE']
    if (data.keyword) {
      values.push(`%${data.keyword}%`)
      clauses.push(`(u.username ILIKE $${values.length} OR c.account_key ILIKE $${values.length}`
        + ` OR c.peer_key ILIKE $${values.length} OR c.display_name ILIKE $${values.length})`)
    }
    if (data.online !== undefined && data.online !== '') {
      clauses.push(Number(data.online) === 1
        ? `c.last_message_at > now() - interval '${ONLINE_WINDOW_SQL} minutes'`
        : `(c.last_message_at IS NULL OR c.last_message_at <= now() - interval '${ONLINE_WINDOW_SQL} minutes')`)
    }
    const where = clauses.join(' AND ')
    const total = await repo.query(
      `SELECT count(*)::bigint AS total FROM conversations c JOIN users u ON u.id=c.user_id WHERE ${where}`, values)
    const rows = await repo.query(
      `SELECT c.id, COALESCE(u.username,'') AS username, c.platform,
              COALESCE(c.account_key,'') AS account,
              COALESCE(c.peer_key,'') AS peer_key,
              COALESCE(c.display_name,'') AS nick_name,
              CASE WHEN c.last_message_at > now() - interval '${ONLINE_WINDOW_SQL} minutes'
                   THEN 1 ELSE 0 END AS online_status,
              COALESCE(co.status,'') AS owner_status,
              COALESCE(cu.public_id,'') AS customer_no,
              c.last_message_at,
              c.created_at
         FROM conversations c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN customers cu ON cu.id = c.customer_id
         LEFT JOIN customer_owners co
                ON co.user_id = c.user_id AND co.customer_id = c.customer_id
        WHERE ${where}
        ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      values.concat([paging.size, paging.offset]))
    res.json(page(mapRows(rows.rows), total.rows[0].total, paging))
  }))

  router.get('/admin/fans', asyncRoute(async (req, res) => {
    const data = input(req)
    const paging = pagination(req, { size: 50 })
    const values = []
    const clauses = ['TRUE']
    if (data.keyword) {
      values.push(`%${data.keyword}%`)
      clauses.push(`(u.username ILIKE $${values.length} OR c.account_key ILIKE $${values.length}`
        + ` OR c.peer_key ILIKE $${values.length} OR c.display_name ILIKE $${values.length})`)
    }

    // 新粉 / 重粉：同一个客户被几个会话见过。
    // 「重粉」正是撞单信号 —— 同一个客户在别的账号/商户那里也出现过，
    // 这正是运营最需要先看到的那批人，所以放在列表里而不是藏进详情页。
    const seenCount = `(SELECT count(*) FROM conversations c2 WHERE c2.customer_id = c.customer_id)`
    const fanTypeExpr = `CASE WHEN c.customer_id IS NOT NULL AND ${seenCount} > 1 THEN '重粉' ELSE '新粉' END`
    if (data.type) {
      values.push(String(data.type))
      clauses.push(`${fanTypeExpr} = $${values.length}`)
    }

    const where = clauses.join(' AND ')
    const total = await repo.query(
      `SELECT count(*)::bigint AS total FROM conversations c JOIN users u ON u.id=c.user_id WHERE ${where}`, values)
    const rows = await repo.query(
      `SELECT c.id, COALESCE(u.username,'') AS username, c.platform,
              COALESCE(c.peer_key,'') AS account,
              COALESCE(c.display_name,'') AS nick_name,
              ${fanTypeExpr} AS fan_type,
              ${seenCount}::int AS seen_count,
              COALESCE(c.account_key,'') AS login_account,
              c.created_at AS create_time
         FROM conversations c
         JOIN users u ON u.id = c.user_id
        WHERE ${where}
        ORDER BY c.id DESC
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      values.concat([paging.size, paging.offset]))
    res.json(page(mapRows(rows.rows), total.rows[0].total, paging))
  }))

}

module.exports = { registerAdminOps }

/** 本文件包含的路由（仅供文档与调试参考）
 *   GET   /admin/faqs
 *   POST  /admin/faqs/save
 *   GET   /admin/links
 *   GET   /admin/scripts
 *   GET   /admin/accounts
 *   GET   /admin/fans
 */
