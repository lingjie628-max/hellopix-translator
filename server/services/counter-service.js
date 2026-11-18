'use strict'

const crypto = require('node:crypto')
const { ApiError } = require('../lib/http')
const identity = require('../lib/identity')

const PLATFORMS = new Set(['whatsapp-green', 'whatsapp-pro', 'whatsapp-biz'])
const TICKET_STATUSES = new Set(['open', 'in_progress', 'pending', 'resolved', 'closed'])
const TICKET_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent'])
const TICKET_TRANSITIONS = {
  open: new Set(['in_progress', 'pending', 'resolved', 'closed']),
  in_progress: new Set(['open', 'pending', 'resolved', 'closed']),
  pending: new Set(['in_progress', 'resolved', 'closed']),
  resolved: new Set(['closed', 'in_progress']),
  closed: new Set(['open'])
}
const NON_COUNTING_TYPES = new Set([
  'reaction',
  'poll',
  'event',
  'protocol',
  'protocolmessage',
  'senderkeydistributionmessage',
  'revoked',
  'notification'
])

function cleanText(value, max) {
  if (value == null) return ''
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max || 200)
}

function asInt(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : 0
}

function validDay(value) {
  const text = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const date = new Date(text + 'T00:00:00.000Z')
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text
}

function dayOf(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 10)
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}

function ticketCode(day, eventId, prefix) {
  return String(prefix || 'IT') + '-' + String(day || '').replace(/-/g, '') + '-' + String(eventId)
}

function timelineFor(priority) {
  const minutes = priority === 'urgent' ? 10 : priority === 'high' ? 30 : 120
  return {
    dueMinutes: minutes,
    resolveMinutes: minutes * 24
  }
}

/**
 * 纯分类函数：数据库只负责提供两个事实，不做“猜”的判断。
 */
function classifyFan({ seenOnAccount, seenInWorkspace }) {
  if (seenOnAccount) return 'duplicate'
  if (seenInWorkspace) return 'repeat'
  return 'new'
}

class CounterService {
  constructor(repo) {
    if (!repo || typeof repo.query !== 'function' || typeof repo.transaction !== 'function') {
      throw new TypeError('CounterService 需要 ProductionRepository')
    }
    this.repo = repo
  }

  _sessionScope(session) {
    if (!session || !session.parent || !session.account) {
      throw new ApiError(401, '请先登录', 'AUTH_REQUIRED')
    }
    return {
      userId: Number(session.parent.id),
      operatorId: session.kind === 'sub' ? Number(session.account.id) : null,
      kind: session.kind === 'sub' ? 'sub' : 'main',
      deviceId: cleanText(session.securitySession && session.securitySession.deviceId, 255)
    }
  }

  async registerAccount(session, input) {
    const scope = this._sessionScope(session)
    if (!scope.deviceId) throw new ApiError(400, '缺少设备标识', 'DEVICE_REQUIRED')
    const data = input || {}
    const localTabId = cleanText(data.localTabId, 255)
    const platform = cleanText(data.platform, 64)
    const label = cleanText(data.label, 120) || 'WhatsApp 账号'
    if (!localTabId) throw new ApiError(400, '缺少本地实例标识', 'COUNTER_TAB_REQUIRED')
    if (!PLATFORMS.has(platform)) throw new ApiError(400, '不支持的计数平台', 'COUNTER_PLATFORM_INVALID')
    const enabled = data.enabled !== false
    const r = await this.repo.query(
      `INSERT INTO counter_accounts(user_id,operator_id,device_id,local_tab_id,platform,label,enabled,last_seen_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (user_id,device_id,local_tab_id) DO UPDATE SET
         operator_id=EXCLUDED.operator_id,
         platform=EXCLUDED.platform,
         label=EXCLUDED.label,
         enabled=EXCLUDED.enabled,
         last_seen_at=now(),
         archived_at=NULL,
         updated_at=now()
       RETURNING id,user_id,operator_id,device_id,local_tab_id,platform,label,enabled,last_seen_at,archived_at`,
      [scope.userId, scope.operatorId, scope.deviceId, localTabId, platform, label, enabled]
    )
    return r.rows[0]
  }

  async listAccounts(session, options) {
    const scope = this._sessionScope(session)
    const includeArchived = !!(options && options.includeArchived)
    const values = [scope.userId]
    const clauses = ['a.user_id=$1']
    if (scope.operatorId) {
      values.push(scope.operatorId)
      clauses.push(`a.operator_id=$${values.length}`)
    }
    if (!includeArchived) clauses.push('a.archived_at IS NULL')
    const r = await this.repo.query(
      `SELECT a.id,a.operator_id,a.device_id,a.local_tab_id,a.platform,a.label,a.enabled,
              a.last_seen_at,a.archived_at,a.created_at,a.updated_at,
              count(e.id) FILTER (WHERE e.kind='new')::int AS new_fans,
              count(e.id) FILTER (WHERE e.kind='repeat')::int AS repeat_fans,
              count(e.id)::int AS total_fans
       FROM counter_accounts a
       LEFT JOIN counter_fan_events e ON e.counter_account_id=a.id
       WHERE ${clauses.join(' AND ')}
       GROUP BY a.id
       ORDER BY a.archived_at NULLS FIRST, a.last_seen_at DESC, a.id`,
      values
    )
    return r.rows
  }

  async archiveAccount(session, accountId) {
    const scope = this._sessionScope(session)
    const id = asInt(accountId)
    if (!id) throw new ApiError(400, '计数账号不合法', 'COUNTER_ACCOUNT_BAD_ID')
    const values = [id, scope.userId]
    let extra = ''
    if (scope.operatorId) {
      values.push(scope.operatorId)
      extra = ` AND operator_id=$${values.length}`
    }
    const r = await this.repo.query(
      `UPDATE counter_accounts SET enabled=false,archived_at=COALESCE(archived_at,now()),updated_at=now()
       WHERE id=$1 AND user_id=$2${extra}
       RETURNING id,archived_at`,
      values
    )
    if (!r.rows[0]) throw new ApiError(404, '计数账号不存在', 'COUNTER_ACCOUNT_NOT_FOUND')
    return r.rows[0]
  }

  async _account(scope, accountId, client, options) {
    const id = asInt(accountId)
    if (!id) throw new ApiError(400, '计数账号不合法', 'COUNTER_ACCOUNT_BAD_ID')
    const values = [id, scope.userId]
    const clauses = ['id=$1', 'user_id=$2']
    if (scope.operatorId) {
      values.push(scope.operatorId)
      clauses.push(`operator_id=$${values.length}`)
    }
    if (!(options && options.includeArchived)) clauses.push('archived_at IS NULL')
    const r = await this.repo.query(
      `SELECT * FROM counter_accounts WHERE ${clauses.join(' AND ')} LIMIT 1`,
      values,
      client
    )
    if (!r.rows[0]) throw new ApiError(404, '计数账号不存在或已归档', 'COUNTER_ACCOUNT_NOT_FOUND')
    return r.rows[0]
  }

  _identities(account, data) {
    const lid = cleanText(data.whatsappLid || data.lid, 80)
    const platformUid = lid
      ? (lid.indexOf('lid:') === 0 || /@lid$/i.test(lid) ? lid : 'lid:' + lid)
      : ''
    const candidates = identity.collectIdentities({
      phone: cleanText(data.phone, 40),
      platform: account.platform,
      platformUid
    })
    return candidates.map(candidate => ({
      ...candidate,
      fingerprint: identity.fingerprint(candidate.type, candidate.value)
    }))
  }

  async _lockFingerprints(client, candidates) {
    const keys = Array.from(new Set(candidates.map(candidate => candidate.fingerprint.toString('hex')))).sort()
    for (const key of keys) {
      await this.repo.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [key],
        client
      )
    }
  }

  async _existingCustomers(client, candidates) {
    const customers = new Map()
    for (const candidate of candidates) {
      const r = await this.repo.query(
        `SELECT c.id,c.public_id,c.merged_into,
                COALESCE(final.id,c.id) AS resolved_id,
                COALESCE(final.public_id,c.public_id) AS resolved_public_id
         FROM customer_identities ci
         JOIN customers c ON c.id=ci.customer_id
         LEFT JOIN customers final ON final.id=c.merged_into
         WHERE ci.fingerprint=$1`,
        [candidate.fingerprint],
        client
      )
      if (r.rows[0]) customers.set(Number(r.rows[0].resolved_id), r.rows[0])
    }
    return Array.from(customers.values()).sort((a, b) => Number(a.resolved_id) - Number(b.resolved_id))
  }

  async _mergeCustomers(client, fromId, toId) {
    if (!fromId || !toId || Number(fromId) === Number(toId)) return

    // counter_fan_events 每个 (账号, 客户) 只能有一条。合并前先把同账号的
    // 两条流水归并到较早的一条，并把工单时间线迁过去，避免丢审计。
    const fromEvents = await this.repo.query(
      'SELECT * FROM counter_fan_events WHERE customer_id=$1 ORDER BY first_msg_at,id',
      [fromId], client
    )
    for (const event of fromEvents.rows) {
      const existing = await this.repo.query(
        `SELECT * FROM counter_fan_events
         WHERE counter_account_id=$1 AND customer_id=$2 LIMIT 1`,
        [event.counter_account_id, toId], client
      )
      if (!existing.rows[0]) {
        await this.repo.query(
          'UPDATE counter_fan_events SET customer_id=$2 WHERE id=$1',
          [event.id, toId], client
        )
        await this.repo.query(
          'UPDATE counter_tickets SET customer_id=$2 WHERE fan_event_id=$1',
          [event.id, toId], client
        )
        continue
      }

      const keep = Date.parse(existing.rows[0].first_msg_at) <= Date.parse(event.first_msg_at)
        ? existing.rows[0]
        : event
      const drop = keep.id === existing.rows[0].id ? event : existing.rows[0]
      if (keep.id === event.id) {
        await this.repo.query(
          `UPDATE counter_fan_events
           SET customer_id=$2,kind='new',first_msg_at=$3,day=$4,
               phone_tail=COALESCE(phone_tail,$5),push_name=CASE WHEN push_name='' THEN $6 ELSE push_name END
           WHERE id=$1`,
          [keep.id, toId, keep.first_msg_at, keep.day, keep.phone_tail, keep.push_name], client
        )
      }
      const keepTicket = await this.repo.query(
        'SELECT id,code FROM counter_tickets WHERE fan_event_id=$1',
        [keep.id], client
      )
      const dropTicket = await this.repo.query(
        'SELECT id,code FROM counter_tickets WHERE fan_event_id=$1',
        [drop.id], client
      )
      if (keepTicket.rows[0] && dropTicket.rows[0]) {
        await this.repo.query(
          'UPDATE counter_ticket_events SET counter_ticket_id=$2 WHERE counter_ticket_id=$1',
          [dropTicket.rows[0].id, keepTicket.rows[0].id], client
        )
        await this.repo.query(
          `INSERT INTO counter_ticket_events(counter_ticket_id,kind,author_kind,body)
           VALUES($1,'merge','system',$2)`,
          [keepTicket.rows[0].id, '已合并重复工单 ' + dropTicket.rows[0].code], client
        )
        await this.repo.query('DELETE FROM counter_tickets WHERE id=$1', [dropTicket.rows[0].id], client)
      } else if (!keepTicket.rows[0] && dropTicket.rows[0]) {
        await this.repo.query(
          'UPDATE counter_tickets SET fan_event_id=$2,customer_id=$3 WHERE id=$1',
          [dropTicket.rows[0].id, keep.id, toId], client
        )
      }
      await this.repo.query('DELETE FROM counter_fan_events WHERE id=$1', [drop.id], client)
    }

    await this.repo.query('UPDATE customer_identities SET customer_id=$2 WHERE customer_id=$1', [fromId, toId], client)
    await this.repo.query('UPDATE conversations SET customer_id=$2 WHERE customer_id=$1', [fromId, toId], client)
    await this.repo.query('UPDATE messages SET customer_id=$2 WHERE customer_id=$1', [fromId, toId], client)
    await this.repo.query(
      `UPDATE customer_owners o SET status='LOST',released_at=now()
       WHERE o.customer_id=$1 AND o.status='FOLLOWING' AND EXISTS (
         SELECT 1 FROM customer_owners t
         WHERE t.customer_id=$2 AND t.user_id=o.user_id AND t.status='FOLLOWING')`,
      [fromId, toId], client
    )
    await this.repo.query('UPDATE customer_owners SET customer_id=$2 WHERE customer_id=$1', [fromId, toId], client)
    await this.repo.query('UPDATE collision_events SET customer_id=$2 WHERE customer_id=$1', [fromId, toId], client)
    await this.repo.query(
      `UPDATE customer_merchant_links l SET customer_id=$2
       WHERE l.customer_id=$1 AND NOT EXISTS (
         SELECT 1 FROM customer_merchant_links t
         WHERE t.customer_id=$2 AND t.user_id=l.user_id)`,
      [fromId, toId], client
    )
    await this.repo.query('DELETE FROM customer_merchant_links WHERE customer_id=$1', [fromId], client)
    await this.repo.query('UPDATE customers SET merged_into=$2,merged_at=now() WHERE id=$1', [fromId, toId], client)
  }

  async _resolveCustomer(client, candidates) {
    const existing = await this._existingCustomers(client, candidates)
    let customerId
    let publicId
    let existedBefore = false
    if (existing.length) {
      existedBefore = true
      customerId = Number(existing[0].resolved_id)
      publicId = existing[0].resolved_public_id
      for (const customer of existing.slice(1)) {
        await this._mergeCustomers(client, customer.resolved_id, customerId)
      }
    } else {
      const created = await this.repo.query(
        `INSERT INTO customers(public_id)
         VALUES('C_' || nextval('customers_id_seq')::text)
         RETURNING id,public_id`,
        [], client
      )
      customerId = Number(created.rows[0].id)
      publicId = created.rows[0].public_id
    }

    for (const candidate of candidates) {
      await this.repo.query(
        `INSERT INTO platform_identities(fingerprint,identity_type)
         VALUES($1,$2)
         ON CONFLICT(fingerprint) DO UPDATE
           SET last_seen_at=now(),touch_count=platform_identities.touch_count+1`,
        [candidate.fingerprint, candidate.type],
        client
      )
      await this.repo.query(
        `INSERT INTO customer_identities(fingerprint,customer_id,confidence)
         VALUES($1,$2,$3)
         ON CONFLICT(fingerprint) DO NOTHING`,
        [candidate.fingerprint, customerId, candidate.confidence],
        client
      )
    }
    return { customerId, publicId, existedBefore }
  }

  async _summaryForDay(client, userId, day, operatorId) {
    const values = [userId, day]
    let operator = ''
    if (operatorId) {
      values.push(operatorId)
      operator = ` AND a.operator_id=$${values.length}`
    }
    const r = await this.repo.query(
      `SELECT
         count(*) FILTER (WHERE e.kind='new')::int AS today_new,
         count(*) FILTER (WHERE e.kind='repeat')::int AS today_repeat,
         count(*)::int AS today_total,
         count(DISTINCT e.customer_id)::int AS today_unique
       FROM counter_fan_events e
       JOIN counter_accounts a ON a.id=e.counter_account_id
       WHERE e.user_id=$1 AND e.day=$2 AND a.archived_at IS NULL${operator}`,
      values,
      client
    )
    return {
      todayNew: Number(r.rows[0] && r.rows[0].today_new) || 0,
      todayRepeat: Number(r.rows[0] && r.rows[0].today_repeat) || 0,
      todayTotal: Number(r.rows[0] && r.rows[0].today_total) || 0,
      todayUnique: Number(r.rows[0] && r.rows[0].today_unique) || 0
    }
  }

  async ingest(session, input) {
    const scope = this._sessionScope(session)
    const data = input || {}
    const sourceMessageId = cleanText(data.sourceMessageId, 300)
    const peerKey = cleanText(data.peerKey, 300)
    const messageType = cleanText(data.messageType, 64).toLowerCase()
    const sentAt = new Date(data.sentAt)
    if (!sourceMessageId) throw new ApiError(400, '缺少消息 ID', 'COUNTER_MESSAGE_ID_REQUIRED')
    if (!peerKey) throw new ApiError(400, '缺少客户会话标识', 'COUNTER_PEER_REQUIRED')
    if (Number.isNaN(sentAt.getTime())) throw new ApiError(400, '消息时间不合法', 'COUNTER_TIME_INVALID')
    if (NON_COUNTING_TYPES.has(messageType)) {
      return { status: 'ignored', reason: 'message_type' }
    }
    // 平台消息 ID 可能包含手机号（WhatsApp 的 _serialized 形态）。
    // 事实表只存稳定摘要，幂等和隐私同时成立。
    const sourceMessageKey = digest(sourceMessageId)
    const peerHash = digest(peerKey)
    const day = validDay(data.day) ? String(data.day) : dayOf(sentAt)
    const initialAccount = await this._account(scope, data.counterAccountId, null)
    const candidates = this._identities(initialAccount, data)
    if (!candidates.length) return { status: 'ignored', reason: 'no_identity' }

    return this.repo.transaction(async client => {
      const account = await this._account(scope, data.counterAccountId, client)
      await this._lockFingerprints(client, candidates)

      const sourceSeen = await this.repo.query(
        `SELECT e.*,c.public_id AS customer_public_id,t.id AS ticket_id
         FROM counter_fan_events e
         JOIN customers c ON c.id=e.customer_id
         LEFT JOIN counter_tickets t ON t.fan_event_id=e.id
        WHERE e.counter_account_id=$1 AND e.source_message_id=$2 LIMIT 1`,
        [account.id, sourceMessageKey],
        client
      )
      if (sourceSeen.rows[0]) {
        return {
          status: 'duplicate',
          reason: 'source_message_seen',
          eventId: Number(sourceSeen.rows[0].id),
          customerId: sourceSeen.rows[0].customer_public_id,
          ticketId: sourceSeen.rows[0].ticket_id || null,
          summary: await this._summaryForDay(client, scope.userId, day, scope.operatorId)
        }
      }

      const resolved = await this._resolveCustomer(client, candidates)
      await this.repo.query(
        `INSERT INTO customer_merchant_links(customer_id,user_id)
         VALUES($1,$2)
         ON CONFLICT(customer_id,user_id) DO UPDATE SET last_seen_at=now()`,
        [resolved.customerId, scope.userId],
        client
      )
      await this.repo.query(
        `UPDATE platform_identities pi
         SET merchant_count=(
           SELECT count(*)::int FROM customer_merchant_links
           WHERE customer_id=$1
         )
         WHERE pi.fingerprint IN (
           SELECT fingerprint FROM customer_identities WHERE customer_id=$1
         )`,
        [resolved.customerId],
        client
      )

      const accountSeen = await this.repo.query(
        `SELECT e.*,t.id AS ticket_id FROM counter_fan_events e
         LEFT JOIN counter_tickets t ON t.fan_event_id=e.id
         WHERE e.counter_account_id=$1 AND e.customer_id=$2 LIMIT 1`,
        [account.id, resolved.customerId],
        client
      )
      const workspaceSeen = await this.repo.query(
        'SELECT 1 FROM counter_fan_events WHERE user_id=$1 AND customer_id=$2 LIMIT 1',
        [scope.userId, resolved.customerId],
        client
      )
      const outcome = classifyFan({
        seenOnAccount: !!accountSeen.rows[0],
        seenInWorkspace: !!workspaceSeen.rows[0]
      })
      if (outcome === 'duplicate') {
        return {
          status: 'duplicate',
          eventId: accountSeen.rows[0] ? Number(accountSeen.rows[0].id) : null,
          customerId: resolved.publicId,
          ticketId: accountSeen.rows[0] ? accountSeen.rows[0].ticket_id || null : null,
          summary: await this._summaryForDay(client, scope.userId, day, scope.operatorId)
        }
      }

      const phone = candidates.find(candidate => candidate.type === 'phone')
      const pushName = cleanText(data.pushName, 120)
      const eventInsert = await this.repo.query(
        `INSERT INTO counter_fan_events(
           user_id,counter_account_id,customer_id,kind,source_message_id,peer_key,
           phone_tail,push_name,message_type,first_msg_at,day
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          scope.userId, account.id, resolved.customerId, outcome, sourceMessageKey, peerHash,
          phone ? phone.value.slice(-4) : null, pushName, messageType, sentAt.toISOString(), day
        ],
        client
      )
      const event = eventInsert.rows[0]
      const priority = outcome === 'repeat' ? 'high' : 'normal'
      const timing = timelineFor(priority)
      const code = ticketCode(day, event.id, 'IT')
      const title = (outcome === 'repeat' ? '重粉跟进 · ' : '新粉跟进 · ') +
        (pushName || (phone ? '+' + phone.value : resolved.publicId))
      const ticketInsert = await this.repo.query(
        `INSERT INTO counter_tickets(
           code,user_id,counter_account_id,customer_id,fan_event_id,title,status,priority,
           due_at,resolve_due_at
         ) VALUES($1,$2,$3,$4,$5,$6,'open',$7,
                  now() + ($8::text || ' minutes')::interval,
                  now() + ($9::text || ' minutes')::interval)
         RETURNING id,code,status,priority,due_at,resolve_due_at,created_at`,
        [
          code, scope.userId, account.id, resolved.customerId, event.id, title,
          priority, timing.dueMinutes, timing.resolveMinutes
        ],
        client
      )
      const ticket = ticketInsert.rows[0]
      await this.repo.query(
        `INSERT INTO counter_ticket_events(counter_ticket_id,kind,author_kind,body)
         VALUES($1,'create','system',$2)`,
        [ticket.id, title],
        client
      )
      await this.repo.query(
        'UPDATE counter_accounts SET last_seen_at=now(),updated_at=now() WHERE id=$1',
        [account.id],
        client
      )
      return {
        status: outcome,
        eventId: Number(event.id),
        customerId: resolved.publicId,
        ticketId: Number(ticket.id),
        ticket,
        summary: await this._summaryForDay(client, scope.userId, day, scope.operatorId)
      }
    })
  }

  _rangeScope(session, query, alias, accountAlias) {
    const scope = this._sessionScope(session)
    const account = accountAlias || 'ca'
    const values = [scope.userId]
    const clauses = [`${alias}.user_id=$1`]
    const data = query || {}
    if (data.from) {
      if (!validDay(data.from)) throw new ApiError(400, '开始日期不合法', 'COUNTER_BAD_DATE')
      values.push(data.from)
      clauses.push(`${alias}.day >= $${values.length}`)
    }
    if (data.to) {
      if (!validDay(data.to)) throw new ApiError(400, '结束日期不合法', 'COUNTER_BAD_DATE')
      values.push(data.to)
      clauses.push(`${alias}.day <= $${values.length}`)
    }
    if (data.accountId) {
      const accountId = asInt(data.accountId)
      if (!accountId) throw new ApiError(400, '计数账号不合法', 'COUNTER_ACCOUNT_BAD_ID')
      values.push(accountId)
      clauses.push(`${alias}.counter_account_id=$${values.length}`)
    }
    if (scope.operatorId) {
      values.push(scope.operatorId)
      clauses.push(`${account}.operator_id=$${values.length}`)
    }
    if (!data.includeArchived) clauses.push(`${account}.archived_at IS NULL`)
    return { scope, where: clauses.join(' AND '), values }
  }

  async summary(session, query) {
    const range = this._rangeScope(session, query, 'e')
    const r = await this.repo.query(
      `SELECT
         count(*) FILTER (WHERE e.kind='new')::int AS new_fans,
         count(*) FILTER (WHERE e.kind='repeat')::int AS repeat_fans,
         count(*)::int AS total,
         count(DISTINCT e.customer_id)::int AS unique_customers
       FROM counter_fan_events e
       JOIN counter_accounts ca ON ca.id=e.counter_account_id
       WHERE ${range.where}`,
      range.values
    )
    return {
      new: Number(r.rows[0] && r.rows[0].new_fans) || 0,
      repeat: Number(r.rows[0] && r.rows[0].repeat_fans) || 0,
      total: Number(r.rows[0] && r.rows[0].total) || 0,
      unique: Number(r.rows[0] && r.rows[0].unique_customers) || 0
    }
  }

  async events(session, query) {
    const data = query || {}
    const page = Math.max(1, asInt(data.page) || 1)
    const rows = Math.min(500, Math.max(1, asInt(data.rows) || 100))
    const range = this._rangeScope(session, data, 'e', 'a')
    const values = range.values.slice()
    let where = range.where
    if (data.kind) {
      const kind = String(data.kind)
      if (kind !== 'new' && kind !== 'repeat') {
        throw new ApiError(400, '进粉类型不合法', 'COUNTER_BAD_KIND')
      }
      values.push(kind)
      where += ` AND e.kind=$${values.length}`
    }
    const offset = (page - 1) * rows
    const list = await this.repo.query(
      `SELECT e.id,e.kind,c.public_id AS customer_public_id,
              e.counter_account_id,a.label AS account_label,
              e.phone_tail,e.push_name,e.message_type,e.first_msg_at,e.day,e.created_at,
              t.id AS ticket_id,t.code AS ticket_code,t.status AS ticket_status,t.priority
       FROM counter_fan_events e
       JOIN counter_accounts a ON a.id=e.counter_account_id
       JOIN customers c ON c.id=e.customer_id
       LEFT JOIN counter_tickets t ON t.fan_event_id=e.id
       WHERE ${where}
       ORDER BY e.first_msg_at DESC,e.id DESC
       LIMIT ${rows} OFFSET ${offset}`,
      values
    )
    const total = await this.repo.query(
      `SELECT count(*)::int AS total
       FROM counter_fan_events e
       JOIN counter_accounts a ON a.id=e.counter_account_id
       WHERE ${where}`,
      values
    )
    return { rows: list.rows, total: Number(total.rows[0] && total.rows[0].total) || 0, page, rowsPerPage: rows }
  }

  async repeats(session, query) {
    const data = query || {}
    const page = Math.max(1, asInt(data.page) || 1)
    const rows = Math.min(200, Math.max(1, asInt(data.rows) || 50))
    const range = this._rangeScope(session, data, 'e')
    const offset = (page - 1) * rows
    const list = await this.repo.query(
      `SELECT c.public_id AS customer_public_id,
              max(e.phone_tail) AS phone_tail,max(e.push_name) AS push_name,
              count(DISTINCT e.counter_account_id)::int AS account_count,
              count(*)::int AS seen_count,
              min(e.first_msg_at) AS first_at,max(e.first_msg_at) AS last_at
       FROM counter_fan_events e
       JOIN counter_accounts ca ON ca.id=e.counter_account_id
       JOIN customers c ON c.id=e.customer_id
       WHERE ${range.where}
       GROUP BY e.customer_id,c.public_id
       HAVING count(DISTINCT e.counter_account_id)>1
       ORDER BY account_count DESC,last_at DESC
       LIMIT ${rows} OFFSET ${offset}`,
      range.values
    )
    return { rows: list.rows, page, rowsPerPage: rows }
  }

  async listTickets(session, query) {
    const scope = this._sessionScope(session)
    const data = query || {}
    const values = [scope.userId]
    const clauses = ['t.user_id=$1']
    if (data.status) {
      const status = String(data.status)
      if (!TICKET_STATUSES.has(status)) throw new ApiError(400, '工单状态不合法', 'COUNTER_TICKET_BAD_STATUS')
      values.push(status)
      clauses.push(`t.status=$${values.length}`)
    }
    if (data.priority) {
      const priority = String(data.priority)
      if (!TICKET_PRIORITIES.has(priority)) throw new ApiError(400, '工单优先级不合法', 'COUNTER_TICKET_BAD_PRIORITY')
      values.push(priority)
      clauses.push(`t.priority=$${values.length}`)
    }
    const limit = Math.min(500, Math.max(1, asInt(data.rows) || 100))
    const page = Math.max(1, asInt(data.page) || 1)
    const offset = (page - 1) * limit
    const r = await this.repo.query(
      `SELECT t.*,c.public_id AS customer_public_id,a.label AS account_label,
              e.kind AS fan_kind
       FROM counter_tickets t
       JOIN customers c ON c.id=t.customer_id
       JOIN counter_accounts a ON a.id=t.counter_account_id
       JOIN counter_fan_events e ON e.id=t.fan_event_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY
         CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'pending' THEN 2
                       WHEN 'resolved' THEN 3 ELSE 4 END,
         CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         t.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      values
    )
    return { rows: r.rows, page, rowsPerPage: limit }
  }

  async getTicket(session, id) {
    const scope = this._sessionScope(session)
    const ticketId = asInt(id)
    if (!ticketId) throw new ApiError(400, '工单号不合法', 'COUNTER_TICKET_BAD_ID')
    const ticket = await this.repo.query(
      `SELECT t.*,c.public_id AS customer_public_id,a.label AS account_label,
              e.phone_tail,e.push_name,e.first_msg_at,e.kind AS fan_kind
       FROM counter_tickets t
       JOIN customers c ON c.id=t.customer_id
       JOIN counter_accounts a ON a.id=t.counter_account_id
       JOIN counter_fan_events e ON e.id=t.fan_event_id
       WHERE t.id=$1 AND t.user_id=$2 LIMIT 1`,
      [ticketId, scope.userId]
    )
    if (!ticket.rows[0]) throw new ApiError(404, '工单不存在', 'COUNTER_TICKET_NOT_FOUND')
    const events = await this.repo.query(
      'SELECT * FROM counter_ticket_events WHERE counter_ticket_id=$1 ORDER BY id',
      [ticketId]
    )
    return { ticket: ticket.rows[0], events: events.rows }
  }

  async transitionTicket(session, data) {
    const scope = this._sessionScope(session)
    const id = asInt(data && data.id)
    const status = cleanText(data && data.status, 16)
    if (!id) throw new ApiError(400, '工单号不合法', 'COUNTER_TICKET_BAD_ID')
    if (!TICKET_STATUSES.has(status)) throw new ApiError(400, '工单状态不合法', 'COUNTER_TICKET_BAD_STATUS')
    return this.repo.transaction(async client => {
      const r = await this.repo.query(
        'SELECT * FROM counter_tickets WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [id, scope.userId], client
      )
      const ticket = r.rows[0]
      if (!ticket) throw new ApiError(404, '工单不存在', 'COUNTER_TICKET_NOT_FOUND')
      if (ticket.status !== status && !(TICKET_TRANSITIONS[ticket.status] || new Set()).has(status)) {
        throw new ApiError(400, '工单状态不能这样流转', 'COUNTER_TICKET_BAD_TRANSITION')
      }
      if (ticket.status === status) return ticket
      const firstResponse = ticket.first_response_at ? ticket.first_response_at : new Date().toISOString()
      const update = await this.repo.query(
        `UPDATE counter_tickets SET status=$2,first_response_at=$3,
           resolved_at=CASE WHEN $2='resolved' THEN now() ELSE resolved_at END,
           closed_at=CASE WHEN $2='closed' THEN now() ELSE closed_at END,
           updated_at=now()
         WHERE id=$1 RETURNING *`,
        [id, status, firstResponse], client
      )
      await this.repo.query(
        `INSERT INTO counter_ticket_events(counter_ticket_id,kind,author_kind,author_id,body)
         VALUES($1,'status',$2,$3,$4)`,
        [id, scope.kind, scope.operatorId || scope.userId, ticket.status + ' → ' + status], client
      )
      return update.rows[0]
    })
  }

  async replyTicket(session, data) {
    const scope = this._sessionScope(session)
    const id = asInt(data && data.id)
    const body = cleanText(data && data.body, 5000)
    if (!id) throw new ApiError(400, '工单号不合法', 'COUNTER_TICKET_BAD_ID')
    if (!body) throw new ApiError(400, '回复内容不能为空', 'COUNTER_TICKET_REPLY_REQUIRED')
    return this.repo.transaction(async client => {
      const r = await this.repo.query(
        'SELECT id,status FROM counter_tickets WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [id, scope.userId], client
      )
      if (!r.rows[0]) throw new ApiError(404, '工单不存在', 'COUNTER_TICKET_NOT_FOUND')
      if (r.rows[0].status === 'closed') {
        throw new ApiError(400, '工单已关闭', 'COUNTER_TICKET_CLOSED')
      }
      await this.repo.query(
        `INSERT INTO counter_ticket_events(counter_ticket_id,kind,author_kind,author_id,body)
         VALUES($1,'reply',$2,$3,$4)`,
        [id, scope.kind, scope.operatorId || scope.userId, body], client
      )
      await this.repo.query(
        `UPDATE counter_tickets SET first_response_at=COALESCE(first_response_at,now()),
           status=CASE WHEN status='open' THEN 'in_progress' ELSE status END,
           updated_at=now() WHERE id=$1`,
        [id], client
      )
      return { ok: true }
    })
  }
}

module.exports = {
  CounterService,
  classifyFan,
  ticketCode,
  cleanText,
  validDay,
  PLATFORMS,
  TICKET_STATUSES,
  TICKET_PRIORITIES,
  TICKET_TRANSITIONS
}
