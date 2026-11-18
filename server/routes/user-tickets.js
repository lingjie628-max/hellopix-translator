/**
 * 商户端工单（提单 / 查看 / 回复）。
 *
 * ## 为什么单独一个文件，而不是塞进 production.js
 *
 * production.js 已经 1000+ 行，而且里面每条路由的顺序都有历史原因。
 * 工单是新功能，独立文件才能保证「加它不影响任何已有路由」——
 * 这也是它唯一合理的挂载点。
 *
 * ## 隔离边界（最重要的一条）
 *
 * 所有查询**必须**带 `user_id = 当前主账号 id`。
 * 子账号提的工单也挂在主账号名下（子账号没有独立余额，
 * 客服核对充值必须找主账号），但 `submitter_name` 记下是谁提的。
 *
 * 绝不能出现「按 id 取单不校验归属」的写法 —— 那等于任何商户
 * 改一下 URL 里的数字就能读别人和客服的对话。
 */
const { asyncRoute, input, page, ok, ApiError } = require('../lib/http')
const { mapRows } = require('../repositories/production-repository')
const tickets = require('../services/ticket-service')

/** 商户端能看到的分类（管理端有 6 个，这里去掉客服内部才会用的）。 */
const USER_CATEGORIES = ['recharge', 'translation', 'login', 'bug', 'feature', 'other']

const STATUS_LABEL = {
  new: '待处理',
  in_progress: '处理中',
  waiting_user: '待你回复',
  resolved: '已解决',
  closed: '已关闭'
}

const CATEGORY_LABEL = {
  recharge: '充值问题',
  translation: '翻译问题',
  login: '登录异常',
  bug: '功能故障',
  feature: '功能建议',
  other: '其他'
}

/**
 * 从 session 里取「这个商户的所有权身份」。
 *
 * 主账号直接用自己；子账号用 parent。
 * 拿不到就说明鉴权中间件没跑，直接拒绝而不是兜底成某个 id ——
 * 兜底会让一个 bug 变成越权。
 */
function ownerOf (req) {
  const s = req.pixUser
  if (!s || !s.parent || !s.parent.id) {
    throw new ApiError(401, '请先登录', 'USER_AUTH_REQUIRED')
  }
  return {
    userId: s.parent.id,
    parentUsername: s.parent.username || '',
    kind: s.kind === 'sub' ? 'sub' : 'main',
    submitter: (s.account && s.account.username) || ''
  }
}

function registerUserTickets (router, ctx) {
  const repo = ctx.repo

  /**
   * 我的工单列表。
   *
   * 默认只回未关闭的 —— 商户打开工单页是想知道自己「还有什么没解决」，
   * 历史已关闭的塞一屏只会把正在处理的那条淹掉。要翻历史传 status=closed。
   */
  router.get('/tickets', asyncRoute(async (req, res) => {
    const me = ownerOf(req)
    const data = input(req)
    const values = [me.userId]
    const clauses = ['user_id = $1']
    const status = String(data.status || 'open')
    if (status === 'open') {
      clauses.push("status <> 'closed'")
    } else if (status !== 'all') {
      tickets.assertEnum(status, tickets.STATUSES, 'TICKET_BAD_STATUS', '状态')
      values.push(status)
      clauses.push(`status = $${values.length}`)
    }
    // 分页：商户的工单量不会大，但仍然要设上限，
    // 免得某个商户积累上千条时一次全查出来。
    const size = Math.min(Math.max(Number(data.rows) || 20, 1), 50)
    const current = Math.max(Number(data.page) || 1, 1)
    const result = await repo.query(
      `SELECT id,subject,category,priority,status,last_reply_at,created_at,updated_at
         FROM tickets WHERE ${clauses.join(' AND ')}
         ORDER BY
           -- 未关闭的永远排在已关闭前面，再按最近动静
           (status = 'closed') ASC,
           COALESCE(last_reply_at, created_at) DESC, id DESC
         LIMIT ${size} OFFSET ${(current - 1) * size}`,
      values
    )
    const total = await repo.query(
      `SELECT count(*)::int AS n FROM tickets WHERE ${clauses.join(' AND ')}`, values
    )
    const rows = mapRows(result.rows).map(row => Object.assign({}, row, {
      statusLabel: STATUS_LABEL[row.status] || row.status,
      categoryLabel: CATEGORY_LABEL[row.category] || row.category
    }))
    res.json(page(rows, total.rows[0].n, { page: current, size }))
  }))

  /**
   * 工单详情 + 消息流。
   *
   * `internal = false` 是硬条件：内部备注是客服写给自己的，
   * 商户永远不能看到。这条不能写成「前端不渲染」—— 那样数据仍然发出去了。
   */
  router.get('/tickets/:id', asyncRoute(async (req, res) => {
    const me = ownerOf(req)
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) throw new ApiError(400, '工单号不合法', 'TICKET_BAD_ID')
    const t = await repo.query(
      `SELECT id,subject,category,priority,status,created_at,last_reply_at,closed_at
         FROM tickets WHERE id=$1 AND user_id=$2`,
      [id, me.userId]
    )
    // 不存在和不属于你都回 404：回 403 等于告诉对方"这个单号存在"。
    if (!t.rows.length) throw new ApiError(404, '工单不存在', 'TICKET_NOT_FOUND')
    const msgs = await repo.query(
      `SELECT id,author_type,author_name,body,created_at FROM ticket_messages
        WHERE ticket_id=$1 AND internal = false ORDER BY id ASC`,
      [id]
    )
    // 商户打开详情 = 已读客服的回复
    await repo.query(
      'UPDATE tickets SET user_unread=false, updated_at=updated_at WHERE id=$1 AND user_unread=true', [id]
    )
    const ticket = mapRows(t.rows)[0]
    res.json({
      ticket: Object.assign({}, ticket, {
        statusLabel: STATUS_LABEL[ticket.status] || ticket.status,
        categoryLabel: CATEGORY_LABEL[ticket.category] || ticket.category
      }),
      messages: mapRows(msgs.rows)
    })
  }))

  /**
   * 提单。
   *
   * 状态从 new 开始，admin_unread=true —— 否则客服侧红点不会亮，
   * 新工单就躺在列表里没人管。
   */
  router.post('/tickets/create', asyncRoute(async (req, res) => {
    const me = ownerOf(req)
    const data = input(req)
    const subject = String(data.subject || '').trim()
    const body = String(data.body || '').trim()
    if (subject.length < 2) throw new ApiError(400, '请填写工单标题（至少 2 个字）', 'TICKET_SUBJECT_REQUIRED')
    if (subject.length > 200) throw new ApiError(400, '标题太长了，请控制在 200 字以内', 'TICKET_SUBJECT_TOO_LONG')
    if (body.length < 1) throw new ApiError(400, '请描述一下遇到的问题', 'TICKET_BODY_REQUIRED')
    if (body.length > 5000) throw new ApiError(400, '描述太长了，请控制在 5000 字以内', 'TICKET_BODY_TOO_LONG')
    const category = String(data.category || 'other')
    if (!USER_CATEGORIES.includes(category)) throw new ApiError(400, '分类不合法', 'TICKET_BAD_CATEGORY')
    // 商户不能自选优先级 —— 那会让所有人都选「紧急」。
    // 充值类默认给中等，其余给低，客服按实际情况再调。
    const priority = category === 'recharge' ? 'medium' : 'low'

    const ticketId = await repo.transaction(async client => {
      // Re-check the open-ticket cap inside the same transaction and lock the
      // owner row, so two simultaneous submits cannot both create the 21st
      // ticket while seeing 19 open tickets.
      await repo.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [me.userId], client)
      const open = await repo.query(
        "SELECT count(*)::int AS n FROM tickets WHERE user_id=$1 AND status <> 'closed'", [me.userId], client)
      if (open.rows[0].n >= 20) {
        throw new ApiError(400, '你还有 20 张未关闭的工单，请先在已有工单里继续沟通，或等待处理完成', 'TICKET_TOO_MANY_OPEN')
      }
      const ins = await repo.query(
        `INSERT INTO tickets(user_id,username,submitter_kind,submitter_name,subject,category,priority,status,
                             admin_unread,user_unread,last_reply_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,'new',true,false,NOW()) RETURNING id`,
        [me.userId, me.parentUsername, me.kind, me.submitter, subject, category, priority], client)
      const id = Number(ins.rows[0].id)
      await repo.query(
        "INSERT INTO ticket_messages(ticket_id,author_type,author_name,body,internal) VALUES($1,'user',$2,$3,false)",
        [id, me.submitter || me.parentUsername, body], client)
      return id
    })
    ok(res, '工单已提交，客服会尽快处理', { id: ticketId })
  }))

  /**
   * 商户回复。
   *
   * 状态推进按 tickets.afterUserReply：球在商户那边时回复 → in_progress，
   * 让客服重新看到；其它状态保持不动。同时挂上 admin_unread 点亮客服红点。
   */
  router.post('/tickets/reply', asyncRoute(async (req, res) => {
    const me = ownerOf(req)
    const data = input(req)
    const id = Number(data.id)
    if (!Number.isFinite(id)) throw new ApiError(400, '工单号不合法', 'TICKET_BAD_ID')
    const body = String(data.body || '').trim()
    if (!body) throw new ApiError(400, '回复内容不能为空', 'TICKET_BODY_REQUIRED')
    if (body.length > 5000) throw new ApiError(400, '回复太长了，请控制在 5000 字以内', 'TICKET_BODY_TOO_LONG')

    await repo.transaction(async client => {
      const t = await repo.query(
        'SELECT id,status FROM tickets WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, me.userId], client)
      if (!t.rows.length) throw new ApiError(404, '工单不存在', 'TICKET_NOT_FOUND')
      const current = t.rows[0].status
      if (current === 'closed') {
        throw new ApiError(400, '这张工单已关闭，如需继续请新建工单并附上原单号', 'TICKET_CLOSED')
      }

      await repo.query(
        "INSERT INTO ticket_messages(ticket_id,author_type,author_name,body,internal) VALUES($1,'user',$2,$3,false)",
        [id, me.submitter || me.parentUsername, body], client)
      const next = tickets.afterUserReply(current)
      await repo.query(
        `UPDATE tickets SET status=$2, admin_unread=true, last_reply_at=NOW(), updated_at=NOW() WHERE id=$1`,
        [id, next], client)
    })
    ok(res, '已回复')
  }))

  /** 未读红点：客服回复了，商户还没看。只回数字。 */
  router.get('/tickets-unread', asyncRoute(async (req, res) => {
    const me = ownerOf(req)
    const r = await repo.query(
      "SELECT count(*)::int AS n FROM tickets WHERE user_id=$1 AND user_unread=true AND status <> 'closed'",
      [me.userId]
    )
    res.json({ unread: r.rows[0].n })
  }))
}

module.exports = { registerUserTickets }
