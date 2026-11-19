'use strict'

const { mapRow, mapRows } = require('./production-repository')

/**
 * 计数工单数据访问层。
 *
 * 商户查询一律强制 userId；超管查询使用 `userId = null`，只允许由
 * `/admin/count-tickets*` 路由调用。内容层查询不允许出现“有 id 就返回”的
 * 兜底，否则改一个 URL 里的数字就能看见别人的客户名单。
 */
class CountTicketRepository {
  constructor(db) {
    this.db = db
  }

  query(text, values, client) {
    return this.db.query(text, values || [], client)
  }

  transaction(work) {
    return this.db.transaction(work)
  }

  async activeTicketForAccount(userId, platform, accountKey, client) {
    const result = await this.query(
      `SELECT t.id, t.user_id, t.title, t.timezone, t.zero_time,
              GREATEST(a.created_at, a.updated_at) AS account_active_since
       FROM count_ticket_accounts a
       JOIN count_tickets t ON t.id = a.ticket_id AND t.user_id = a.user_id
       WHERE a.user_id = $1
         AND a.platform = $2
         AND a.account_key = $3
         AND a.active = true
         AND t.platform = a.platform
         AND t.status = 'active'
       LIMIT 1`,
      [userId, platform, accountKey], client
    )
    return result.rows[0] || null
  }

  async fanByConversation(ticketId, conversationId, client) {
    const result = await this.query(
      `SELECT id, fan_type, event_at, day_key
       FROM count_ticket_fans
       WHERE ticket_id = $1 AND conversation_id = $2`,
      [ticketId, conversationId], client
    )
    return result.rows[0] || null
  }

  async fanById(fanId, client) {
    const result = await this.query(
      `SELECT id, ticket_id, conversation_id, customer_id, fan_type, repeat_of_id, event_at
       FROM count_ticket_fans WHERE id = $1`,
      [fanId], client
    )
    return result.rows[0] || null
  }

  /**
   * 按真实事件时间重排同一客户在同一应用内的事件。
   *
   * 消息补扫、跨设备同步都可能乱序到达。仅按“先到先算”会把较晚事件钉成
   * new、较早事件错标 repeat。每次插入后重排，保证最早事件始终是新粉。
   */
  async rerankCustomerFans(customerId, platform, client) {
    const result = await this.query(
      `WITH ranked AS (
         SELECT id,
                first_value(id) OVER (
                  PARTITION BY platform ORDER BY event_at ASC, id ASC
                ) AS first_id,
                row_number() OVER (
                  PARTITION BY platform ORDER BY event_at ASC, id ASC
                ) AS position
         FROM count_ticket_fans
         WHERE customer_id = $1 AND platform = $2
       )
       UPDATE count_ticket_fans f
       SET fan_type = CASE WHEN ranked.position = 1 THEN 'new' ELSE 'repeat' END,
           repeat_of_id = CASE WHEN ranked.position = 1 THEN NULL ELSE ranked.first_id END
       FROM ranked
       WHERE f.id = ranked.id
       RETURNING f.id, f.fan_type, f.repeat_of_id`,
      [customerId, platform], client
    )
    return result.rows
  }

  async lockCustomer(customerId, client) {
    if (!customerId) return
    await this.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [customerId], client)
  }

  async priorFanForCustomer(customerId, platform, client) {
    const result = await this.query(
      `SELECT id, ticket_id, conversation_id, fan_type, event_at
       FROM count_ticket_fans
       WHERE customer_id = $1 AND platform = $2
       ORDER BY event_at ASC, id ASC
       LIMIT 1`,
      [customerId, platform], client
    )
    return result.rows[0] || null
  }

  async priorFanForPeer(ticketId, platform, accountKey, peerKey, client) {
    const result = await this.query(
      `SELECT id, ticket_id, conversation_id, fan_type, event_at
       FROM count_ticket_fans
       WHERE ticket_id = $1 AND platform = $2 AND account_key = $3 AND peer_key = $4
       ORDER BY event_at ASC, id ASC
       LIMIT 1`,
      [ticketId, platform, accountKey, peerKey], client
    )
    return result.rows[0] || null
  }

  async insertFan(payload, client) {
    const result = await this.query(
      `INSERT INTO count_ticket_fans
         (ticket_id, user_id, conversation_id, customer_id, platform, account_key,
          peer_key, display_name, fan_type, repeat_of_id, event_at, day_key)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
              (($11::timestamptz AT TIME ZONE $12) - $13::time)::date
       ON CONFLICT (ticket_id, conversation_id)
         WHERE conversation_id IS NOT NULL
         DO NOTHING
       RETURNING id, ticket_id, conversation_id, customer_id, fan_type, event_at, day_key`,
      [
        payload.ticketId, payload.userId, payload.conversationId, payload.customerId || null,
        payload.platform, payload.accountKey, payload.peerKey, payload.displayName || '',
        payload.fanType, payload.repeatOfId || null, payload.eventAt,
        payload.timezone, payload.zeroTime
      ], client
    )
    return result.rows[0] || null
  }

  async ticketForOwner(ticketId, userId, client) {
    const result = await this.query(
      `SELECT t.*, u.username
       FROM count_tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = $1 AND t.user_id = $2`,
      [ticketId, userId], client
    )
    return result.rows[0] || null
  }

  async ticketForAdmin(ticketId, client) {
    const result = await this.query(
      `SELECT t.*, u.username
       FROM count_tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = $1`,
      [ticketId], client
    )
    return result.rows[0] || null
  }

  async lockTicket(ticketId, userId, client) {
    const result = await this.query(
      `SELECT t.id, t.user_id, t.status, t.platform, t.timezone, t.zero_time,
              EXISTS(
                SELECT 1 FROM count_ticket_fans f
                WHERE f.ticket_id = t.id AND f.user_id = t.user_id
              ) AS has_fans,
              EXISTS(
                SELECT 1 FROM count_ticket_accounts a
                WHERE a.ticket_id = t.id AND a.user_id = t.user_id
              ) AS has_accounts
       FROM count_tickets t
       WHERE t.id = $1 AND t.user_id = $2
       FOR UPDATE`,
      [ticketId, userId], client
    )
    return result.rows[0] || null
  }

  async createTicket(userId, payload, client) {
    const result = await this.query(
      `INSERT INTO count_tickets
         (user_id, title, platform, status, day_target, total_target, timezone, zero_time, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::time,
               CASE WHEN $4 = 'closed' THEN now() ELSE NULL END)
       RETURNING *`,
      [
        userId, payload.title, payload.platform, payload.status, payload.dayTarget, payload.totalTarget,
        payload.timezone, payload.zeroTime
      ], client
    )
    return result.rows[0]
  }

  async updateTicket(ticketId, userId, payload, client) {
    const result = await this.query(
      `UPDATE count_tickets
       SET title = $3,
           platform = $4,
           status = $5,
           day_target = $6,
           total_target = $7,
           timezone = $8,
           zero_time = $9::time,
           closed_at = CASE
             WHEN $5 = 'closed' THEN COALESCE(closed_at, now())
             ELSE NULL
           END,
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [
        ticketId, userId, payload.title, payload.platform, payload.status, payload.dayTarget,
        payload.totalTarget, payload.timezone, payload.zeroTime
      ], client
    )
    const ticket = result.rows[0] || null
    if (ticket && payload.status === 'closed') {
      // 关闭 = 停止计数。绑定记录留着供历史账号统计查看，但不再占用
      // “一个账号只能属于一个进行中工单”的唯一键。
      await this.query(
        `UPDATE count_ticket_accounts
         SET active = false, updated_at = now()
         WHERE ticket_id = $1 AND user_id = $2 AND active = true`,
        [ticketId, userId], client
      )
    }
    return ticket
  }

  async saveAccount(ticketId, userId, payload, client) {
    // 重新绑定一个账号时，旧工单上的账本必须保留，只停用绑定关系。
    await this.query(
      `UPDATE count_ticket_accounts
       SET active = false, updated_at = now()
       WHERE user_id = $1 AND platform = $2 AND account_key = $3
         AND active = true AND ticket_id <> $4`,
      [userId, payload.platform, payload.accountKey, ticketId], client
    )
    const result = await this.query(
      `INSERT INTO count_ticket_accounts(ticket_id, user_id, platform, account_key, active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (ticket_id, platform, account_key) DO UPDATE
         SET active = true, updated_at = now()
       RETURNING *`,
      [ticketId, userId, payload.platform, payload.accountKey], client
    )
    return result.rows[0]
  }

  async deactivateAccount(ticketId, userId, payload, client) {
    const result = await this.query(
      `UPDATE count_ticket_accounts
       SET active = false, updated_at = now()
       WHERE ticket_id = $1 AND user_id = $2 AND platform = $3 AND account_key = $4
       RETURNING *`,
      [ticketId, userId, payload.platform, payload.accountKey], client
    )
    return result.rows[0] || null
  }

  /**
   * 已经由客户端真实上报过的接入账号。
   *
   * account_key 是客户端主进程生成的稳定 slug，不是聊天平台里的手机号。
   * 让商户手填几乎必然对不上，所以绑定弹窗直接从这张列表里选。
   */
  async availableAccounts(userId, platform, client) {
    const result = await this.query(
      `SELECT c.platform, c.account_key,
              count(*)::int AS conversation_count,
              max(c.last_message_at) AS last_seen_at,
              max(c.display_name) AS sample_name
       FROM conversations c
       WHERE c.user_id = $1 AND c.platform = $2
       GROUP BY c.platform, c.account_key
       ORDER BY max(c.last_message_at) DESC NULLS LAST, c.platform, c.account_key`,
      [userId, platform], client
    )
    return mapRows(result.rows)
  }

  async listTickets({ userId, keyword, status, limit, offset }, client) {
    const values = []
    const clauses = []
    if (userId != null) {
      values.push(userId)
      clauses.push(`t.user_id = $${values.length}`)
    }
    if (status && status !== 'all') {
      values.push(status)
      clauses.push(`t.status = $${values.length}`)
    }
    if (keyword) {
      values.push(`%${keyword}%`)
      clauses.push(`(t.title ILIKE $${values.length} OR u.username ILIKE $${values.length})`)
    }
    const where = clauses.length ? clauses.join(' AND ') : 'TRUE'
    values.push(limit, offset)
    const result = await this.query(
      `SELECT t.id, t.user_id, u.username, t.title, t.platform, t.status, t.day_target, t.total_target,
              t.timezone, t.zero_time, t.created_at, t.updated_at, t.closed_at,
              (SELECT count(*)::int FROM count_ticket_accounts a
               WHERE a.ticket_id = t.id AND a.user_id = t.user_id AND a.active = true) AS account_count,
              (SELECT count(*)::int FROM count_ticket_fans f
               WHERE f.ticket_id = t.id AND f.user_id = t.user_id) AS total_fans,
              (SELECT count(*)::int FROM count_ticket_fans f
               WHERE f.ticket_id = t.id AND f.user_id = t.user_id AND f.fan_type = 'repeat') AS repeat_fans,
              (SELECT count(*)::int FROM count_ticket_fans f
               WHERE f.ticket_id = t.id AND f.user_id = t.user_id
                 AND f.day_key = ((now() AT TIME ZONE t.timezone) - t.zero_time)::date) AS today_fans,
              (SELECT count(*)::int FROM count_ticket_fans f
               WHERE f.ticket_id = t.id AND f.user_id = t.user_id
                 AND f.fan_type = 'repeat'
                 AND f.day_key = ((now() AT TIME ZONE t.timezone) - t.zero_time)::date) AS today_repeat_fans
       FROM count_tickets t
       JOIN users u ON u.id = t.user_id
       WHERE ${where}
       ORDER BY (t.status = 'closed') ASC, t.updated_at DESC, t.id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values, client
    )
    const countValues = values.slice(0, -2)
    const total = await this.query(
      `SELECT count(*)::int AS n
       FROM count_tickets t JOIN users u ON u.id = t.user_id
       WHERE ${where}`,
      countValues, client
    )
    return { rows: mapRows(result.rows), total: Number(total.rows[0] && total.rows[0].n) || 0 }
  }

  async metrics(ticketId, client) {
    const result = await this.query(
      `SELECT t.id,
              count(f.id)::int AS total_fans,
              count(f.id) FILTER (WHERE f.fan_type = 'new')::int AS new_fans,
              count(f.id) FILTER (WHERE f.fan_type = 'repeat')::int AS repeat_fans,
              count(f.id) FILTER (
                WHERE f.day_key = ((now() AT TIME ZONE t.timezone) - t.zero_time)::date
              )::int AS today_fans,
              count(f.id) FILTER (
                WHERE f.fan_type = 'new'
                  AND f.day_key = ((now() AT TIME ZONE t.timezone) - t.zero_time)::date
              )::int AS today_new_fans,
              count(f.id) FILTER (
                WHERE f.fan_type = 'repeat'
                  AND f.day_key = ((now() AT TIME ZONE t.timezone) - t.zero_time)::date
              )::int AS today_repeat_fans,
              ((now() AT TIME ZONE t.timezone) - t.zero_time)::date AS business_date
       FROM count_tickets t
       LEFT JOIN count_ticket_fans f ON f.ticket_id = t.id AND f.user_id = t.user_id
       WHERE t.id = $1
       GROUP BY t.id, t.timezone, t.zero_time`,
      [ticketId], client
    )
    return mapRow(result.rows[0]) || {}
  }

  async accounts(ticketId, client) {
    const result = await this.query(
      `SELECT a.id, a.platform, a.account_key, a.active, a.created_at, a.updated_at,
              count(f.id)::int AS total_fans,
              count(f.id) FILTER (WHERE f.fan_type = 'repeat')::int AS repeat_fans,
              count(f.id) FILTER (
                WHERE f.day_key = ((now() AT TIME ZONE t.timezone) - t.zero_time)::date
              )::int AS today_fans
       FROM count_ticket_accounts a
       JOIN count_tickets t ON t.id = a.ticket_id AND t.user_id = a.user_id
       LEFT JOIN count_ticket_fans f
         ON f.ticket_id = a.ticket_id
        AND f.user_id = a.user_id
        AND f.platform = a.platform
        AND f.account_key = a.account_key
       WHERE a.ticket_id = $1
       GROUP BY a.id, t.timezone, t.zero_time
       ORDER BY a.active DESC, a.id ASC`,
      [ticketId], client
    )
    return mapRows(result.rows)
  }

  async listFans(ticketId, filters, client) {
    const values = [ticketId]
    const clauses = ['f.ticket_id = $1']
    if (filters.type && filters.type !== 'all') {
      values.push(filters.type)
      clauses.push(`f.fan_type = $${values.length}`)
    }
    if (filters.platform) {
      values.push(filters.platform)
      clauses.push(`f.platform = $${values.length}`)
    }
    if (filters.accountKey) {
      values.push(filters.accountKey)
      clauses.push(`f.account_key = $${values.length}`)
    }
    if (filters.keyword) {
      values.push(`%${filters.keyword}%`)
      clauses.push(`(f.peer_key ILIKE $${values.length} OR f.display_name ILIKE $${values.length})`)
    }
    if (filters.after) {
      values.push(filters.after)
      clauses.push(`f.event_at >= $${values.length}`)
    }
    if (filters.before) {
      values.push(filters.before)
      clauses.push(`f.event_at < $${values.length}`)
    }
    const where = clauses.join(' AND ')
    const total = await this.query(
      `SELECT count(*)::int AS n FROM count_ticket_fans f WHERE ${where}`,
      values, client
    )
    values.push(filters.limit, filters.offset)
    const rows = await this.query(
      `SELECT f.id, f.conversation_id, f.customer_id, c.public_id AS customer_public_id,
              f.platform, f.account_key, f.peer_key, f.display_name, f.fan_type,
              f.repeat_of_id, f.event_at, f.day_key
       FROM count_ticket_fans f
       LEFT JOIN customers c ON c.id = f.customer_id
       WHERE ${where}
       ORDER BY f.event_at DESC, f.id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values, client
    )
    return { rows: mapRows(rows.rows), total: Number(total.rows[0] && total.rows[0].n) || 0 }
  }
}

module.exports = { CountTicketRepository }
