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
      `SELECT t.id, t.user_id, t.title, t.timezone, t.zero_time, t.dedup_scope,
              t.group_id, t.dedup_base_enabled, t.cycle_no, t.cycle_started_at,
              GREATEST(a.created_at, a.updated_at) AS account_active_since
       FROM count_ticket_accounts a
       JOIN count_tickets t ON t.id = a.ticket_id AND t.user_id = a.user_id
       WHERE a.user_id = $1
         AND a.platform = $2
         AND a.account_key = $3
         AND a.active = true
         AND t.platform = a.platform
         AND t.status = 'active'
         AND t.deleted_at IS NULL
       LIMIT 1
       FOR UPDATE OF t`,
      [userId, platform, accountKey], client
    )
    return result.rows[0] || null
  }

  async fanByConversation(ticketId, conversationId, client) {
    const result = await this.query(
      `SELECT f.id, f.fan_type, f.repeat_type, f.event_at, f.day_key
       FROM count_ticket_fans f
       JOIN count_tickets t ON t.id = f.ticket_id AND t.user_id = f.user_id
       WHERE f.ticket_id = $1
         AND f.conversation_id = $2
         AND f.cycle_no = t.cycle_no`,
      [ticketId, conversationId], client
    )
    return result.rows[0] || null
  }

  /**
   * 同一查重桶内的客户身份串行化。
   *
   * customer 行锁只能覆盖已建档客户；peerKey 兜底路径没有稳定的行可锁，
   * 两个账号并发进入时就会同时判成 new。advisory lock 不写业务表，事务结束
   * 自动释放，失败回滚也不会留下锁。
   */
  async lockDedupKey(userId, platform, customerId, peerKey, client) {
    const identity = customerId
      ? `customer:${customerId}`
      : `peer:${peerKey}`
    await this.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`count-ticket:${userId}:${platform}:${identity}`], client
    )
  }

  async fanById(fanId, client) {
    const result = await this.query(
      `SELECT id, ticket_id, conversation_id, customer_id, fan_type, repeat_type,
              repeat_of_id, event_at
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
      `WITH firsts AS (
       SELECT f.id,
              count_ticket_first_fan_id(
                f.user_id, f.ticket_id, f.platform, f.customer_id, NULL
              ) AS first_id
       FROM count_ticket_fans f
       JOIN count_tickets t ON t.id = f.ticket_id AND t.user_id = f.user_id
       WHERE f.customer_id = $1
         AND f.platform = $2
         AND t.deleted_at IS NULL
         AND f.cycle_no = t.cycle_no
         AND f.event_at >= COALESCE(t.cycle_started_at, '-infinity'::timestamptz)
       )
       UPDATE count_ticket_fans f
       SET fan_type = CASE
             WHEN f.id = firsts.first_id AND f.base_matched THEN 'repeat'
             WHEN f.id = firsts.first_id THEN 'new'
             ELSE 'repeat'
           END,
           repeat_type = CASE
             WHEN f.id = firsts.first_id AND f.base_matched THEN 'base'
             ELSE 'fan'
           END,
           repeat_of_id = CASE WHEN f.id = firsts.first_id THEN NULL ELSE firsts.first_id END
       FROM firsts
       WHERE f.id = firsts.id
       RETURNING f.id, f.fan_type, f.repeat_of_id`,
      [customerId, platform], client
    )
    return result.rows
  }

  async rerankPeerFans(userId, platform, peerKey, client) {
    const result = await this.query(
      `WITH firsts AS (
         SELECT f.id,
                count_ticket_first_fan_id(
                  f.user_id, f.ticket_id, f.platform, NULL, f.peer_key
                ) AS first_id
       FROM count_ticket_fans f
       JOIN count_tickets t ON t.id = f.ticket_id AND t.user_id = f.user_id
       WHERE f.user_id = $1
         AND f.platform = $2
         AND f.peer_key = $3
         AND f.customer_id IS NULL
         AND t.deleted_at IS NULL
         AND f.cycle_no = t.cycle_no
         AND f.event_at >= COALESCE(t.cycle_started_at, '-infinity'::timestamptz)
       )
       UPDATE count_ticket_fans f
       SET fan_type = CASE
             WHEN f.id = firsts.first_id AND f.base_matched THEN 'repeat'
             WHEN f.id = firsts.first_id THEN 'new'
             ELSE 'repeat'
           END,
           repeat_type = CASE
             WHEN f.id = firsts.first_id AND f.base_matched THEN 'base'
             ELSE 'fan'
           END,
           repeat_of_id = CASE WHEN f.id = firsts.first_id THEN NULL ELSE firsts.first_id END
       FROM firsts
       WHERE f.id = firsts.id
       RETURNING f.id, f.fan_type, f.repeat_of_id`,
      [userId, platform, peerKey], client
    )
    return result.rows
  }

  async lockCustomer(customerId, client) {
    if (!customerId) return
    await this.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [customerId], client)
  }

  async priorFanForCustomer(userId, ticketId, customerId, platform, client) {
    const result = await this.query(
      `SELECT f.id, f.ticket_id, f.conversation_id, f.fan_type, f.event_at
       FROM count_ticket_fans f
       WHERE f.id = count_ticket_first_fan_id($1, $2, $4, $3, NULL)`,
      [userId, ticketId, customerId, platform], client
    )
    return result.rows[0] || null
  }

  async priorFanForPeer(userId, ticketId, platform, peerKey, client) {
    const result = await this.query(
      `SELECT f.id, f.ticket_id, f.conversation_id, f.fan_type, f.event_at
       FROM count_ticket_fans f
       WHERE f.id = count_ticket_first_fan_id($1, $2, $3, NULL, $4)`,
      [userId, ticketId, platform, peerKey], client
    )
    return result.rows[0] || null
  }

  async baseEntryForPeer(userId, platform, peerKey, client) {
    const result = await this.query(
      `SELECT id, peer_key, display_name, source
       FROM count_ticket_base_entries
       WHERE user_id = $1 AND platform = $2 AND peer_key = $3
       LIMIT 1`,
      [userId, platform, peerKey], client
    )
    return result.rows[0] || null
  }

  async insertFan(payload, client) {
    const result = await this.query(
      `INSERT INTO count_ticket_fans
         (ticket_id, user_id, conversation_id, customer_id, platform, account_key,
          peer_key, display_name, event_type, direction, fan_type, repeat_type,
          base_matched, repeat_of_id, event_at, day_key, cycle_no)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
              (($15::timestamptz AT TIME ZONE $16) - $17::time)::date, $18
       ON CONFLICT (ticket_id, cycle_no, conversation_id)
         WHERE conversation_id IS NOT NULL
         DO NOTHING
       RETURNING id, ticket_id, conversation_id, customer_id, event_type, direction,
                 fan_type, repeat_type, base_matched, event_at, day_key, cycle_no`,
      [
        payload.ticketId, payload.userId, payload.conversationId, payload.customerId || null,
        payload.platform, payload.accountKey, payload.peerKey, payload.displayName || '',
        payload.eventType, payload.direction,
        payload.fanType, payload.repeatType || 'fan',
        payload.baseMatched === true,
        payload.repeatOfId || null, payload.eventAt,
        payload.timezone, payload.zeroTime, payload.cycleNo
      ], client
    )
    return result.rows[0] || null
  }

  async ticketForOwner(ticketId, userId, client) {
    const result = await this.query(
      `SELECT t.*, u.username
       FROM count_tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = $1 AND t.user_id = $2 AND t.deleted_at IS NULL`,
      [ticketId, userId], client
    )
    return result.rows[0] || null
  }

  async ticketForAdmin(ticketId, client) {
    const result = await this.query(
      `SELECT t.*, u.username
       FROM count_tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = $1 AND t.deleted_at IS NULL`,
      [ticketId], client
    )
    return result.rows[0] || null
  }

  async lockTicket(ticketId, userId, client) {
    const result = await this.query(
      `SELECT t.id, t.user_id, t.status, t.platform, t.timezone, t.zero_time, t.dedup_scope,
              t.group_id, t.dedup_base_enabled, t.cycle_no, t.cycle_started_at,
              t.last_cycle_reset_at,
              EXISTS(
                SELECT 1 FROM count_ticket_fans f
                WHERE f.ticket_id = t.id AND f.user_id = t.user_id
              ) AS has_fans,
              EXISTS(
                SELECT 1 FROM count_ticket_accounts a
                WHERE a.ticket_id = t.id AND a.user_id = t.user_id
              ) AS has_accounts
       FROM count_tickets t
       WHERE t.id = $1 AND t.user_id = $2 AND t.deleted_at IS NULL
       FOR UPDATE`,
      [ticketId, userId], client
    )
    return result.rows[0] || null
  }

  async createTicket(userId, payload, client) {
    const result = await this.query(
      `INSERT INTO count_tickets
         (user_id, title, platform, status, timezone, zero_time,
          dedup_scope, group_id, dedup_base_enabled, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6::time, $7, $8, $9,
               CASE WHEN $4 = 'closed' THEN now() ELSE NULL END)
       RETURNING *`,
      [
        userId, payload.title, payload.platform, payload.status,
        payload.timezone, payload.zeroTime, payload.dedupScope,
        payload.groupId || null, payload.dedupBaseEnabled
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
           timezone = $6,
           zero_time = $7::time,
           dedup_scope = $8,
           group_id = $9,
           dedup_base_enabled = $10,
           closed_at = CASE
             WHEN $5 = 'closed' THEN COALESCE(closed_at, now())
             ELSE NULL
           END,
           updated_at = now()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [
        ticketId, userId, payload.title, payload.platform, payload.status,
        payload.timezone, payload.zeroTime, payload.dedupScope,
        payload.groupId || null, payload.dedupBaseEnabled
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

  async softDeleteTicket(ticketId, userId, client) {
    const result = await this.query(
      `UPDATE count_tickets
       SET status = 'closed',
           closed_at = COALESCE(closed_at, now()),
           deleted_at = COALESCE(deleted_at, now()),
           updated_at = now()
       WHERE id = $1
         AND user_id = $2
         AND deleted_at IS NULL
       RETURNING id, title`,
      [ticketId, userId], client
    )
    return result.rows[0] || null
  }

  async deactivateTicketAccounts(ticketId, userId, client) {
    await this.query(
      `UPDATE count_ticket_accounts
       SET active = false, updated_at = now()
       WHERE ticket_id = $1 AND user_id = $2 AND active = true`,
      [ticketId, userId], client
    )
  }

  async removeDedupLinksForTicket(ticketId, userId, client) {
    await this.query(
      `DELETE FROM count_ticket_dedup_links
       WHERE user_id = $1
         AND (ticket_id = $2 OR linked_ticket_id = $2)`,
      [userId, ticketId], client
    )
  }

  async dedupTicketIds(ticketId, userId, client) {
    const result = await this.query(
      `SELECT linked_ticket_id
       FROM count_ticket_dedup_links
       WHERE ticket_id = $1 AND user_id = $2
       ORDER BY linked_ticket_id`,
      [ticketId, userId], client
    )
    return result.rows.map(row => Number(row.linked_ticket_id))
  }

  async validDedupTicketIds(userId, sourceTicketId, platform, ticketIds, client) {
    if (!ticketIds.length) return []
    const result = await this.query(
      `SELECT id
       FROM count_tickets
       WHERE user_id = $1
         AND platform = $2
         AND id = ANY($3::bigint[])
         AND id <> $4
         AND deleted_at IS NULL
       ORDER BY id`,
      [userId, platform, ticketIds, sourceTicketId || 0], client
    )
    return result.rows.map(row => Number(row.id))
  }

  async replaceDedupLinks(ticketId, userId, ticketIds, client) {
    await this.query(
      'DELETE FROM count_ticket_dedup_links WHERE ticket_id=$1 AND user_id=$2',
      [ticketId, userId], client
    )
    if (!ticketIds.length) return
    await this.query(
      `INSERT INTO count_ticket_dedup_links(ticket_id,user_id,linked_ticket_id)
       SELECT $1, $2, unnest($3::bigint[])`,
      [ticketId, userId, ticketIds], client
    )
  }

  async dedupTicketOptions(userId, ticketId, platform, client) {
    const result = await this.query(
      `SELECT id, title, platform, status
       FROM count_tickets
       WHERE user_id = $1
         AND platform = $2
         AND id <> $3
         AND deleted_at IS NULL
       ORDER BY (status = 'closed') ASC, updated_at DESC, id DESC
       LIMIT 500`,
      [userId, platform, ticketId || 0], client
    )
    return mapRows(result.rows)
  }

  async listGroups(userId, platform, client) {
    const values = [userId]
    const clauses = ['g.user_id = $1']
    if (platform) {
      values.push(platform)
      clauses.push(`g.platform = $${values.length}`)
    }
    const result = await this.query(
      `SELECT g.id, g.user_id, g.name, g.platform, g.created_at, g.updated_at,
              count(t.id)::int AS ticket_count,
              count(t.id) FILTER (WHERE t.status = 'active')::int AS active_ticket_count
       FROM count_ticket_groups g
       LEFT JOIN count_tickets t
         ON t.group_id = g.id AND t.user_id = g.user_id AND t.deleted_at IS NULL
       WHERE ${clauses.join(' AND ')}
       GROUP BY g.id
       ORDER BY g.updated_at DESC, g.id DESC`,
      values, client
    )
    return mapRows(result.rows)
  }

  async groupForOwner(groupId, userId, client) {
    const result = await this.query(
      `SELECT id, user_id, name, platform, created_at, updated_at
       FROM count_ticket_groups
       WHERE id = $1 AND user_id = $2`,
      [groupId, userId], client
    )
    return result.rows[0] || null
  }

  async validGroupForTicket(groupId, userId, platform, client) {
    if (!groupId) return null
    const result = await this.query(
      `SELECT id, user_id, name, platform
       FROM count_ticket_groups
       WHERE id = $1 AND user_id = $2 AND platform = $3`,
      [groupId, userId, platform], client
    )
    return result.rows[0] || null
  }

  async saveGroup(userId, payload, client) {
    if (payload.id) {
      const result = await this.query(
        `UPDATE count_ticket_groups
         SET name = $3, platform = $4, updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [payload.id, userId, payload.name, payload.platform], client
      )
      return result.rows[0] || null
    }
    const result = await this.query(
      `INSERT INTO count_ticket_groups(user_id,name,platform)
       VALUES($1,$2,$3)
       RETURNING *`,
      [userId, payload.name, payload.platform], client
    )
    return result.rows[0]
  }

  async groupTicketCount(groupId, userId, client) {
    const result = await this.query(
      `SELECT count(*)::int AS n
       FROM count_tickets
       WHERE group_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [groupId, userId], client
    )
    return Number(result.rows[0] && result.rows[0].n) || 0
  }

  async deleteGroup(groupId, userId, client) {
    const result = await this.query(
      `DELETE FROM count_ticket_groups
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [groupId, userId], client
    )
    return result.rows[0] || null
  }

  async createBaseBatch(userId, payload, client) {
    const result = await this.query(
      `INSERT INTO count_ticket_base_batches
         (user_id,platform,filename,total_lines,inserted_count,updated_count)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        userId, payload.platform, payload.filename || '', payload.totalLines,
        payload.insertedCount, payload.updatedCount
      ], client
    )
    return result.rows[0]
  }

  async existingBasePeers(userId, platform, peerKeys, client) {
    if (!peerKeys.length) return new Set()
    const result = await this.query(
      `SELECT peer_key
       FROM count_ticket_base_entries
       WHERE user_id = $1 AND platform = $2 AND peer_key = ANY($3::text[])`,
      [userId, platform, peerKeys], client
    )
    return new Set(result.rows.map(row => row.peer_key))
  }

  async upsertBaseEntries(userId, platform, batchId, entries, client) {
    if (!entries.length) return
    await this.query(
      `INSERT INTO count_ticket_base_entries
         (user_id,platform,peer_key,display_name,source,batch_id,imported_at)
       SELECT $1, $2, item.peer_key, item.display_name, item.source, $3, now()
       FROM unnest($4::text[], $5::text[], $6::text[])
         AS item(peer_key, display_name, source)
       ON CONFLICT (user_id, platform, peer_key) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           source = EXCLUDED.source,
           batch_id = EXCLUDED.batch_id,
           imported_at = now()`,
      [
        userId, platform, batchId,
        entries.map(item => item.peerKey),
        entries.map(item => item.displayName),
        entries.map(item => item.source)
      ], client
    )
  }

  async baseStats(userId, platform, client) {
    const result = await this.query(
      `SELECT count(*)::int AS total_entries,
              max(imported_at) AS last_imported_at
       FROM count_ticket_base_entries
       WHERE user_id = $1 AND platform = $2`,
      [userId, platform], client
    )
    return mapRow(result.rows[0]) || { totalEntries: 0, lastImportedAt: null }
  }

  async listBaseEntries(userId, filters, client) {
    const values = [userId, filters.platform]
    const clauses = ['user_id = $1', 'platform = $2']
    if (filters.keyword) {
      values.push(`%${filters.keyword}%`)
      clauses.push(`(peer_key ILIKE $${values.length} OR display_name ILIKE $${values.length})`)
    }
    const where = clauses.join(' AND ')
    const total = await this.query(
      `SELECT count(*)::int AS n FROM count_ticket_base_entries WHERE ${where}`,
      values, client
    )
    values.push(filters.limit, filters.offset)
    const rows = await this.query(
      `SELECT id, platform, peer_key, display_name, source, batch_id, imported_at
       FROM count_ticket_base_entries
       WHERE ${where}
       ORDER BY imported_at DESC, id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values, client
    )
    return {
      rows: mapRows(rows.rows),
      total: Number(total.rows[0] && total.rows[0].n) || 0
    }
  }

  async clearBase(userId, platform, client) {
    const result = await this.query(
      `DELETE FROM count_ticket_base_entries
       WHERE user_id = $1 AND platform = $2`,
      [userId, platform], client
    )
    return result.rowCount
  }

  async promoteTicketFansToBase(ticket, client) {
    const result = await this.query(
      `INSERT INTO count_ticket_base_entries
         (user_id, platform, peer_key, display_name, source, imported_at)
       SELECT DISTINCT ON (f.peer_key)
              f.user_id, f.platform, f.peer_key, f.display_name, $3, now()
       FROM count_ticket_fans f
       WHERE f.ticket_id = $1 AND f.user_id = $2
       ORDER BY f.peer_key, f.event_at DESC, f.id DESC
       ON CONFLICT (user_id, platform, peer_key) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           source = EXCLUDED.source,
           imported_at = now()
       RETURNING id`,
      [
        ticket.id,
        ticket.user_id,
        `工单 #${ticket.id} 第 ${ticket.cycle_no || 1} 周期归档`
      ], client
    )
    return result.rowCount
  }

  async startNextCycle(ticketId, userId, client) {
    const result = await this.query(
      `UPDATE count_tickets
       SET cycle_no = cycle_no + 1,
           cycle_started_at = now(),
           last_cycle_reset_at = now(),
           updated_at = now()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING cycle_no, cycle_started_at, last_cycle_reset_at`,
      [ticketId, userId], client
    )
    return result.rows[0] || null
  }

  async shareForOwner(ticketId, userId, client) {
    const result = await this.query(
      `SELECT id, ticket_id, user_id, token_prefix, enabled, expires_at,
              view_count, last_viewed_at, created_at, updated_at,
              (password_hash IS NOT NULL) AS password_protected
       FROM count_ticket_shares
       WHERE ticket_id = $1 AND user_id = $2`,
      [ticketId, userId], client
    )
    return mapRow(result.rows[0]) || null
  }

  async upsertShare(ticketId, userId, payload, client) {
    const result = await this.query(
      `INSERT INTO count_ticket_shares
         (ticket_id, user_id, token_hash, token_prefix, password_hash, enabled,
          expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, true, $6, now())
       ON CONFLICT (ticket_id, user_id) DO UPDATE
       SET token_hash = EXCLUDED.token_hash,
           token_prefix = EXCLUDED.token_prefix,
           password_hash = EXCLUDED.password_hash,
           enabled = true,
           expires_at = EXCLUDED.expires_at,
           view_count = 0,
           last_viewed_at = NULL,
           updated_at = now()
       RETURNING id, ticket_id, token_prefix, enabled, expires_at,
                 (password_hash IS NOT NULL) AS password_protected,
                 created_at, updated_at`,
      [
        ticketId, userId, payload.tokenHash, payload.tokenPrefix,
        payload.passwordHash || null, payload.expiresAt || null
      ], client
    )
    return mapRow(result.rows[0])
  }

  async revokeShare(ticketId, userId, client) {
    const result = await this.query(
      `UPDATE count_ticket_shares
       SET enabled = false, updated_at = now()
       WHERE ticket_id = $1 AND user_id = $2
       RETURNING id`,
      [ticketId, userId], client
    )
    return result.rows[0] || null
  }

  async shareByTokenHash(tokenHash, client) {
    const result = await this.query(
      `SELECT s.id AS share_id, s.ticket_id, s.user_id, s.password_hash,
              s.enabled, s.expires_at, s.token_prefix, s.view_count,
              s.last_viewed_at, s.created_at AS share_created_at,
              t.title, t.platform, t.status, t.timezone, t.zero_time,
              t.cycle_no, t.cycle_started_at, t.last_cycle_reset_at,
              t.created_at, t.updated_at
       FROM count_ticket_shares s
       JOIN count_tickets t
         ON t.id = s.ticket_id AND t.user_id = s.user_id
       WHERE s.token_hash = $1 AND t.deleted_at IS NULL`,
      [tokenHash], client
    )
    return result.rows[0] || null
  }

  async recordShareView(shareId, client) {
    await this.query(
      `UPDATE count_ticket_shares
       SET view_count = view_count + 1,
           last_viewed_at = now()
       WHERE id = $1`,
      [shareId], client
    )
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
         SET active = true,
             updated_at = CASE
               WHEN count_ticket_accounts.active = false THEN now()
               ELSE count_ticket_accounts.updated_at
             END
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

  async accountReported(userId, platform, accountKey, client) {
    const result = await this.query(
      `SELECT 1 FROM conversations
       WHERE user_id=$1 AND platform=$2 AND account_key=$3
       LIMIT 1`,
      [userId, platform, accountKey], client
    )
    return result.rows.length > 0
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
    clauses.unshift('t.deleted_at IS NULL')
    const where = clauses.join(' AND ')
    values.push(limit, offset)
    const result = await this.query(
      `SELECT t.id, t.user_id, u.username, t.title, t.platform, t.status,
              t.timezone, t.zero_time, t.dedup_scope, t.group_id, g.name AS group_name,
              t.dedup_base_enabled, t.cycle_no, t.cycle_started_at, t.last_cycle_reset_at,
              t.created_at, t.updated_at, t.closed_at,
              ARRAY(
                SELECT l.linked_ticket_id
                FROM count_ticket_dedup_links l
                WHERE l.ticket_id = t.id AND l.user_id = t.user_id
                ORDER BY l.linked_ticket_id
              ) AS dedup_ticket_ids,
              (SELECT count(*)::int FROM count_ticket_accounts a
               WHERE a.ticket_id = t.id AND a.user_id = t.user_id AND a.active = true) AS account_count,
              (SELECT count(*)::int FROM count_ticket_fans f
               WHERE f.ticket_id = t.id AND f.user_id = t.user_id
                 AND f.cycle_no = t.cycle_no
                 AND f.event_at >= COALESCE(t.cycle_started_at, '-infinity'::timestamptz)) AS total_fans,
              (SELECT count(*)::int FROM count_ticket_fans f
               WHERE f.ticket_id = t.id AND f.user_id = t.user_id AND f.fan_type = 'repeat'
                 AND f.cycle_no = t.cycle_no
                 AND f.event_at >= COALESCE(t.cycle_started_at, '-infinity'::timestamptz)) AS repeat_fans,
              (SELECT count(*)::int FROM count_ticket_fans f
               WHERE f.ticket_id = t.id AND f.user_id = t.user_id
                 AND f.cycle_no = t.cycle_no
                 AND f.event_at >= COALESCE(t.cycle_started_at, '-infinity'::timestamptz)
                 AND f.day_key = ((now() AT TIME ZONE t.timezone) - t.zero_time)::date) AS today_fans,
              (SELECT count(*)::int FROM count_ticket_fans f
               WHERE f.ticket_id = t.id AND f.user_id = t.user_id
                 AND f.fan_type = 'repeat'
                 AND f.cycle_no = t.cycle_no
                 AND f.event_at >= COALESCE(t.cycle_started_at, '-infinity'::timestamptz)
                 AND f.day_key = ((now() AT TIME ZONE t.timezone) - t.zero_time)::date) AS today_repeat_fans
       FROM count_tickets t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN count_ticket_groups g ON g.id = t.group_id AND g.user_id = t.user_id
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
      `SELECT t.id, t.cycle_no, t.cycle_started_at, t.last_cycle_reset_at,
              count(f.id)::int AS total_fans,
              count(f.id) FILTER (WHERE f.fan_type = 'new')::int AS new_fans,
              count(f.id) FILTER (WHERE f.fan_type = 'repeat')::int AS repeat_fans,
              count(f.id) FILTER (
                WHERE f.repeat_type = 'base'
              )::int AS base_repeat_fans,
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
              count(f.id) FILTER (
                WHERE f.repeat_type = 'base'
                  AND f.day_key = ((now() AT TIME ZONE t.timezone) - t.zero_time)::date
              )::int AS today_base_repeat_fans,
              ((now() AT TIME ZONE t.timezone) - t.zero_time)::date AS business_date
       FROM count_tickets t
       LEFT JOIN count_ticket_fans f
         ON f.ticket_id = t.id
        AND f.user_id = t.user_id
        AND f.cycle_no = t.cycle_no
        AND f.event_at >= COALESCE(t.cycle_started_at, '-infinity'::timestamptz)
       WHERE t.id = $1 AND t.deleted_at IS NULL
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
                WHERE f.fan_type = 'repeat'
                  AND f.day_key = ((now() AT TIME ZONE t.timezone) - t.zero_time)::date
              )::int AS today_repeat_fans,
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
        AND f.cycle_no = t.cycle_no
        AND f.event_at >= COALESCE(t.cycle_started_at, '-infinity'::timestamptz)
       WHERE a.ticket_id = $1
         AND t.deleted_at IS NULL
       GROUP BY a.id, t.timezone, t.zero_time
       ORDER BY a.active DESC, a.id ASC`,
      [ticketId], client
    )
    return mapRows(result.rows)
  }

  async listFans(ticketId, filters, client) {
    const values = [ticketId]
    const clauses = [
      'f.ticket_id = $1',
      `f.cycle_no = t.cycle_no`,
      `f.event_at >= COALESCE(t.cycle_started_at, '-infinity'::timestamptz)`,
      't.deleted_at IS NULL'
    ]
    if (filters.type && filters.type !== 'all') {
      values.push(filters.type)
      clauses.push(`f.fan_type = $${values.length}`)
    }
    if (filters.repeatType && filters.repeatType !== 'all') {
      values.push(filters.repeatType)
      clauses.push(`f.repeat_type = $${values.length}`)
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
      `SELECT count(*)::int AS n
       FROM count_ticket_fans f
       JOIN count_tickets t ON t.id = f.ticket_id AND t.user_id = f.user_id
       WHERE ${where}`,
      values, client
    )
    values.push(filters.limit, filters.offset)
    const rows = await this.query(
      `SELECT f.id, f.conversation_id, f.customer_id, c.public_id AS customer_public_id,
              f.platform, f.account_key, f.peer_key, f.display_name, f.fan_type, f.repeat_type,
              f.repeat_of_id, f.event_at, f.day_key
       FROM count_ticket_fans f
       JOIN count_tickets t ON t.id = f.ticket_id AND t.user_id = f.user_id
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
