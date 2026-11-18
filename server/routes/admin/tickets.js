'use strict'

/**
 * 后台 · 工单系统（客服 ←→ 商户）。
 *
 * ## 边界
 *
 * 后台支持代客开单；商户端提单、查看和回复在 `routes/user-tickets.js`，
 * 两端共用同一张会话表和状态机。
 *
 * ## 为什么权限分两档
 *
 * 工单正文里会有商户贴的账号、充值单号、聊天截图说明 —— 这些**不是**全站
 * 客户名单（`admin.data.customers` 那个口子），而是单个商户主动提供的信息，
 * 客服必须能看才能干活。所以读档给 `admin.read.ticket`，operator 也有。
 *
 * 写档给 `admin.write.ticket`，也在 operator 能力里 —— 客服就是 operator。
 * **但删除类操作不开放**：工单是审计证据，写错了只能关闭，不能抹掉。
 *
 * ## 为什么写操作不标高危
 *
 * `HIGH_RISK_CAPS` 会强制每次调用带管理员密码（X-Pix-Reauth）。客服一天要
 * 回几十条工单，每条都输密码等于让这个功能不可用。这里没有「动钱」「动账号」
 * 的能力，最坏的滥用是把工单改乱 —— 有审计日志兜底，不值得用二次认证换掉可用性。
 */

const { asyncRoute, input, pagination, page, ok, ApiError } = require('../../lib/http')
const { mapRows } = require('../../repositories/production-repository')
const tickets = require('../../services/ticket-service')

const MAX_SUBJECT = 200
const MAX_BODY = 20000

function registerAdminTickets (router, ctx) {
  const { repo } = ctx

  /**
   * 取一张票，不存在则 404。所有写操作都先过这里。
   *
   * 列必须和详情接口一致：状态机要 resolved_at/closed_at，未读标记要
   * admin_unread/user_unread —— 少一列，写操作就会拿到 undefined 并
   * 「当成 false」或「当成 null」，静默把红点或首次解决时间抹掉。
   */
  async function mustGet (id, client, lock) {
    const result = await repo.query(
      `SELECT id,user_id,username,submitter_kind,submitter_name,subject,category,priority,status,assignee,
              version,package_code,admin_unread,user_unread,last_reply_at,
              resolved_at,closed_at,created_at,updated_at
       FROM tickets WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [Number(id)], client)
    const row = result.rows[0]
    if (!row) throw new ApiError(404, '工单不存在', 'TICKET_NOT_FOUND')
    return row
  }

  /** 写一条消息（会话历史只追加，永不 UPDATE/DELETE）。 */
  async function addMessage (ticketId, { authorType, authorName, body, internal }, client) {
    const result = await repo.query(
      `INSERT INTO ticket_messages(ticket_id,author_type,author_name,body,internal)
       VALUES($1,$2,$3,$4,$5) RETURNING id,created_at`,
      [ticketId, authorType, String(authorName || '').slice(0, 64), String(body).slice(0, MAX_BODY), Boolean(internal)],
      client)
    return result.rows[0]
  }

  // ── 列表 ──────────────────────────────────────────────────
  //
  // 支持按状态 / 分类 / 负责人 / 关键词筛选。关键词同时搜主题和商户名 ——
  // 客服手里通常只有一个商户名或一句话描述，不知道单号。
  router.get('/admin/tickets', asyncRoute(async (req, res) => {
    const data = input(req)
    const paging = pagination(req, { size: 30 })
    const values = []
    const conditions = []

    if (data.status && data.status !== 'all') {
      // 「未关闭」是个高频视图：已关闭的不该混在日常列表里
      if (data.status === 'open') {
        conditions.push("status <> 'closed'")
      } else {
        values.push(tickets.assertEnum(data.status, tickets.STATUSES, 'TICKET_BAD_STATUS', '状态'))
        conditions.push(`status = $${values.length}`)
      }
    }
    if (data.category && data.category !== 'all') {
      values.push(tickets.normalizeCategory(data.category))
      conditions.push(`category = $${values.length}`)
    }
    if (data.assignee) {
      values.push(String(data.assignee).slice(0, 64))
      conditions.push(`assignee = $${values.length}`)
    }
    if (data.keyword) {
      values.push(`%${String(data.keyword).slice(0, 64)}%`)
      conditions.push(`(subject ILIKE $${values.length} OR username ILIKE $${values.length})`)
    }
    const where = conditions.length ? conditions.join(' AND ') : 'TRUE'

    const total = await repo.query(`SELECT count(*)::bigint AS total FROM tickets WHERE ${where}`, values)
    const rows = await repo.query(
      `SELECT id,user_id,username,submitter_name,subject,category,priority,status,assignee,
              admin_unread,last_reply_at,created_at,updated_at
       FROM tickets WHERE ${where}
       ORDER BY
         -- 未关闭优先，其次按紧急程度，最后按最新动静
         (status = 'closed') ASC,
         CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
         COALESCE(last_reply_at, created_at) DESC, id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      values.concat([paging.size, paging.offset]))

    res.json(page(mapRows(rows.rows), total.rows[0].total, paging))
  }))

  // ── 未读数（侧栏红点） ────────────────────────────────────
  //
  // 只回一个数字，不带任何工单内容 —— 这是刻意的：侧栏每个页面都要轮询它，
  // 如果顺带返回工单正文，等于把「读工单」的权限在每个页面都开了一遍。
  // 数字本身不敏感（客服看一眼就知道有几单没处理），所以任何已登录管理员都能拿。
  router.get('/admin/tickets-unread', asyncRoute(async (_req, res) => {
    const result = await repo.query(
      "SELECT count(*)::int AS n FROM tickets WHERE admin_unread = true AND status <> 'closed'")
    res.json({ unread: Number((result.rows[0] || {}).n || 0) })
  }))

  // ── 详情：票 + 全部消息（含内部备注，后台看得到） ─────────
  router.get('/admin/tickets/:id', asyncRoute(async (req, res) => {
    const ticket = await mustGet(req.params.id)
    const messages = await repo.query(
      `SELECT id,author_type,author_name,body,internal,created_at
       FROM ticket_messages WHERE ticket_id=$1 ORDER BY id`, [ticket.id])
    // 打开详情即视为客服已读
    if (ticket.admin_unread) {
      await repo.query('UPDATE tickets SET admin_unread=false,updated_at=NOW() WHERE id=$1', [ticket.id])
    }
    res.json({
      ...mapRows([ticket])[0],
      adminUnread: false,
      messages: mapRows(messages.rows)
    })
  }))

  // ── 开单 ──────────────────────────────────────────────────
  //
  // 客服代客开单：subject + 首条消息必填。user_id 只做关联，能不能对上
  // 商户由客服负责 —— 后台本来就有商户列表可查，这里不重复做身份匹配。
  router.post('/admin/tickets/create', asyncRoute(async (req, res) => {
    const data = input(req)
    const subject = String(data.subject || '').trim().slice(0, MAX_SUBJECT)
    const body = String(data.body || '').trim()
    if (!subject) throw new ApiError(400, '请填写工单主题', 'TICKET_SUBJECT_REQUIRED')
    if (!body) throw new ApiError(400, '请填写工单内容', 'TICKET_BODY_REQUIRED')

    const category = tickets.normalizeCategory(data.category)
    const priority = tickets.normalizePriority(data.priority)

    // 商户名从库里查，不信任前端传的快照（避免把 A 商户的票挂到 B 名下）
    let userId = null
    let username = ''
    if (data.userId) {
      const found = await repo.query('SELECT id,username FROM users WHERE id=$1', [Number(data.userId)])
      if (!found.rows[0]) throw new ApiError(404, '商户不存在', 'USER_NOT_FOUND')
      userId = found.rows[0].id
      username = found.rows[0].username || ''
    }

    const id = await repo.transaction(async client => {
      const created = await repo.query(
        `INSERT INTO tickets(user_id,username,submitter_kind,submitter_name,subject,category,priority,status,
                             assignee,admin_unread,user_unread)
         VALUES($1,$2,'main',$3,$4,$5,$6,'in_progress',$7,false,true) RETURNING id`,
        [userId, username, String(data.submitterName || username).slice(0, 64), subject, category, priority,
          String(req.pixAdmin && req.pixAdmin.username || '')], client)
      const ticketId = created.rows[0].id

      await addMessage(ticketId, {
        authorType: 'admin',
        authorName: String(req.pixAdmin && req.pixAdmin.nickname || req.pixAdmin && req.pixAdmin.username || '客服'),
        body,
        internal: Boolean(data.internal)
      }, client)
      await repo.query('UPDATE tickets SET last_reply_at=NOW(),updated_at=NOW() WHERE id=$1', [ticketId], client)
      return ticketId
    })

    await repo.audit(null, req.pixAdmin, '代客开单', `${subject}`.slice(0, 60), req.ip, { type: 'ticket', id })
    ok(res, '工单已创建', { id })
  }))

  // ── 回复 ──────────────────────────────────────────────────
  //
  // internal=true 是内部备注：商户端永远看不到。做成同一个接口而不是单独
  // 一条路由，是因为 UI 上就是「回复」和「内部备注」两个按钮共用一个输入框。
  router.post('/admin/tickets/reply', asyncRoute(async (req, res) => {
    const data = input(req)
    const body = String(data.body || '').trim()
    if (!body) throw new ApiError(400, '回复内容不能为空', 'TICKET_BODY_REQUIRED')
    const internal = Boolean(data.internal)
    await repo.transaction(async client => {
      // Lock the ticket before checking status and writing the message. This
      // prevents a close/reopen race and keeps the message and state atomic.
      const ticket = await mustGet(data.id, client, true)
      if (ticket.status === 'closed') {
        throw new ApiError(400, '工单已关闭，请让商户新建工单', 'TICKET_CLOSED')
      }

      await addMessage(ticket.id, {
        authorType: 'admin',
        authorName: String(req.pixAdmin && req.pixAdmin.nickname || req.pixAdmin && req.pixAdmin.username || '客服'),
        body,
        internal
      }, client)

      // 内部备注不通知商户，也不改状态 —— 它只是给自己人看的。
      // 正式回复：商户未读置 true；若球在商户那边，客服回复等于接手，推回 in_progress。
      if (internal) {
        await repo.query('UPDATE tickets SET last_reply_at=NOW(),updated_at=NOW() WHERE id=$1', [ticket.id], client)
      } else {
        const status = ['waiting_user', 'resolved'].includes(ticket.status)
          ? tickets.nextState(ticket, 'in_progress').status
          : ticket.status
        // resolved_at 刻意不在 SET 里：从 resolved 回到 in_progress 时
        // 「这单曾经解决过」是事实，擦掉会让平均解决时长和复发率失真。
        await repo.query(
          `UPDATE tickets SET last_reply_at=NOW(),updated_at=NOW(),user_unread=true,
                  status=$2, assignee=CASE WHEN assignee='' THEN $3 ELSE assignee END
           WHERE id=$1`,
          [ticket.id, status, String(req.pixAdmin && req.pixAdmin.username || '')], client)
      }
    })
    ok(res, internal ? '内部备注已保存' : '回复已发送')
  }))

  // ── 改状态 / 优先级 / 分类 / 负责人 ───────────────────────
  //
  // 所有字段都可选，但至少要改一个。状态流转走 ticket-service 的状态机，
  // 非法流转直接 400 —— 路由不做自己的判断，规则只有一份。
  router.post('/admin/tickets/update', asyncRoute(async (req, res) => {
    const data = input(req)
    const ticket = await repo.transaction(async client => {
      const current = await mustGet(data.id, client, true)
      const sets = []
      const values = [current.id]

      if (data.status !== undefined && data.status !== '') {
        const next = tickets.nextState(current, String(data.status))
        values.push(next.status); sets.push(`status=$${values.length}`)
        values.push(next.resolvedAt); sets.push(`resolved_at=$${values.length}`)
        values.push(next.closedAt); sets.push(`closed_at=$${values.length}`)
        // 解决/关闭时：客服侧红点清掉（这个会话已处理完），商户侧标未读
        // —— 商户下次登录要知道「你的单有结论了」。
        if (next.status === 'closed' || next.status === 'resolved') {
          sets.push('admin_unread=false')
          sets.push('user_unread=true')
        }
        // 转入「待商户回复」：球交给商户，必须点亮商户未读。
        if (next.status === 'waiting_user') {
          sets.push('user_unread=true')
        }
      }
      if (data.priority !== undefined && data.priority !== '') {
        values.push(tickets.normalizePriority(data.priority)); sets.push(`priority=$${values.length}`)
      }
      if (data.category !== undefined && data.category !== '') {
        values.push(tickets.normalizeCategory(data.category)); sets.push(`category=$${values.length}`)
      }
      if (data.assignee !== undefined) {
        values.push(String(data.assignee || '').slice(0, 64)); sets.push(`assignee=$${values.length}`)
      }
      if (!sets.length) throw new ApiError(400, '没有要修改的字段', 'TICKET_NOTHING_TO_UPDATE')

      await repo.query(`UPDATE tickets SET ${sets.join(',')},updated_at=NOW() WHERE id=$1`, values, client)
      return current
    })

    if (data.status && String(data.status) !== ticket.status) {
      await repo.audit(null, req.pixAdmin, '工单状态',
        `#${ticket.id} ${tickets.label(ticket.status)} → ${tickets.label(data.status)}`, req.ip,
        { type: 'ticket', id: ticket.id })
    }
    ok(res, '工单已更新')
  }))
}

module.exports = { registerAdminTickets }
