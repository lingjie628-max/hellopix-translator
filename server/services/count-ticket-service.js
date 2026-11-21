'use strict'

const { ApiError } = require('../lib/http')
const { mapRow } = require('../repositories/production-repository')
const catalog = require('../lib/client-catalog')

const TICKET_STATUSES = new Set(['active', 'closed'])
const FAN_TYPES = new Set(['new', 'repeat'])
const DEDUP_SCOPES = new Set(['ticket', 'merchant', 'linked'])
const ACCOUNT_BINDING_GRACE_MS = 2 * 60 * 1000

function cleanText(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max)
}

function target(value, max) {
  const number = Math.floor(Number(value))
  if (!Number.isFinite(number) || number < 0) return 0
  return Math.min(number, max)
}

function validTimezone(value) {
  const timezone = cleanText(value || 'Asia/Shanghai', 64)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date())
    return timezone
  } catch (_error) {
    throw new ApiError(400, '时区不合法，请填写 IANA 时区，例如 Asia/Shanghai', 'COUNT_TIMEZONE_BAD')
  }
}

function validZeroTime(value) {
  const raw = cleanText(value || '00:00:00', 8)
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(raw)
  if (!match) throw new ApiError(400, '置零时间格式应为 HH:mm 或 HH:mm:ss', 'COUNT_ZERO_TIME_BAD')
  return `${match[1]}:${match[2]}:${match[3] || '00'}`
}

function normalizeDedupScope(value) {
  const scope = cleanText(value || 'merchant', 16)
  if (!DEDUP_SCOPES.has(scope)) {
    throw new ApiError(400, '查重范围不合法', 'COUNT_DEDUP_SCOPE_BAD')
  }
  return scope
}

function normalizeLinkedTicketIds(value) {
  if (value == null || value === '') return []
  const raw = Array.isArray(value) ? value : String(value).split(',')
  const ids = new Set()
  for (const item of raw) {
    if (item == null || item === '') continue
    const id = Number(item)
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ApiError(400, '指定查重工单号不合法', 'COUNT_DEDUP_LINKS_BAD')
    }
    ids.add(id)
  }
  if (ids.size > 100) {
    throw new ApiError(400, '指定查重工单最多选择 100 张', 'COUNT_DEDUP_LINKS_TOO_MANY')
  }
  return Array.from(ids).sort((a, b) => a - b)
}

function normalizeTicket(data) {
  const title = cleanText(data.title, 120)
  if (!title) throw new ApiError(400, '请填写计数工单名称', 'COUNT_TITLE_REQUIRED')
  const platform = cleanText(data.platform, 32).toLowerCase()
  if (!platform) throw new ApiError(400, '请选择计数应用', 'COUNT_PLATFORM_REQUIRED')
  const status = cleanText(data.status || 'active', 16)
  if (!TICKET_STATUSES.has(status)) throw new ApiError(400, '工单状态不合法', 'COUNT_STATUS_BAD')
  return {
    title,
    platform,
    status,
    dayTarget: target(data.dayTarget != null ? data.dayTarget : data.day_target, 1_000_000),
    totalTarget: target(data.totalTarget != null ? data.totalTarget : data.total_target, 1_000_000_000),
    timezone: validTimezone(data.timezone),
    zeroTime: validZeroTime(data.zeroTime != null ? data.zeroTime : data.zero_time),
    dedupScope: normalizeDedupScope(
      data.dedupScope != null ? data.dedupScope : data.dedup_scope
    )
  }
}

function normalizeAccount(data) {
  const platform = cleanText(data.platform, 32).toLowerCase()
  const accountKey = cleanText(data.accountKey != null ? data.accountKey : data.account_key, 200)
  if (!platform) throw new ApiError(400, '请选择聊天平台', 'COUNT_PLATFORM_REQUIRED')
  if (!accountKey) throw new ApiError(400, '请填写聊天账号', 'COUNT_ACCOUNT_REQUIRED')
  return { platform, accountKey }
}

function dateValue(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new ApiError(400, '时间筛选格式不正确', 'COUNT_DATE_BAD')
  return date
}

class CountTicketService {
  constructor(repo) {
    this.repo = repo
  }

  isEntitled(parent) {
    return !!parent && (
      parent.enterprise === true ||
      Number(parent.enterprise) === 1 ||
      catalog.packageAllowsCounter(parent.packageClients)
    )
  }

  async saveTicket(userId, data) {
    const payload = normalizeTicket(data || {})
    const scopeProvided = !!data && (data.dedupScope != null || data.dedup_scope != null)
    let linkedTicketIds = normalizeLinkedTicketIds(
      data && (data.linkedTicketIds != null ? data.linkedTicketIds : data.linked_ticket_ids)
    )
    const id = data && data.id ? Number(data.id) : null
    if (id != null && !Number.isSafeInteger(id)) {
      throw new ApiError(400, '计数工单号不合法', 'COUNT_TICKET_BAD_ID')
    }
    const result = await this.repo.transaction(async client => {
      let current = null
      if (id != null) {
        current = await this.repo.lockTicket(id, userId, client)
        if (!current) throw new ApiError(404, '计数工单不存在', 'COUNT_TICKET_NOT_FOUND')
        const currentLinks = await this.repo.dedupTicketIds(id, userId, client)
        if (!scopeProvided) {
          // 滚动发布时旧前端不会提交新字段。更新请求必须保留已有口径，
          // 不能把“字段缺失”误当成“用户主动选择同商户全部工单”。
          payload.dedupScope = String(current.dedup_scope || 'merchant')
          linkedTicketIds = currentLinks.slice()
        }
        if (current.has_fans && (
          String(current.timezone) !== payload.timezone ||
          String(current.zero_time) !== payload.zeroTime
        )) {
          throw new ApiError(
            409,
            '该工单已有进粉记录，业务时区和每日置零时间不能再修改',
            'COUNT_BUSINESS_TIME_LOCKED'
          )
        }
        if (String(current.platform) !== payload.platform && (current.has_fans || current.has_accounts)) {
          throw new ApiError(
            409,
            '该工单已绑定接入账号或已有进粉记录，不能再更换计数应用',
            'COUNT_PLATFORM_LOCKED'
          )
        }
        if (current.has_fans) {
          const scopeChanged = String(current.dedup_scope) !== payload.dedupScope
          const linksChanged = currentLinks.length !== linkedTicketIds.length ||
            currentLinks.some((linkedId, index) => linkedId !== linkedTicketIds[index])
          if (scopeChanged || linksChanged) {
            throw new ApiError(
              409,
              '该工单已有进粉记录，查重范围和关联工单不能再修改',
              'COUNT_DEDUP_SCOPE_LOCKED'
            )
          }
        }
      }

      if (payload.dedupScope === 'linked' && !linkedTicketIds.length) {
        throw new ApiError(
          400,
          '指定查重工单至少需要选择一张其它工单',
          'COUNT_DEDUP_LINKS_REQUIRED'
        )
      }
      const linksToApply = payload.dedupScope === 'linked' ? linkedTicketIds : []
      const validLinks = await this.repo.validDedupTicketIds(
        userId, id, payload.platform, linksToApply, client
      )
      if (validLinks.length !== linksToApply.length) {
        throw new ApiError(
          400,
          '指定查重工单必须属于当前商户且与当前工单使用同一个应用',
          'COUNT_DEDUP_LINKS_INVALID'
        )
      }

      const row = id != null
        ? await this.repo.updateTicket(id, userId, payload, client)
        : await this.repo.createTicket(userId, payload, client)
      const ticketId = Number(row.id)
      await this.repo.replaceDedupLinks(
        ticketId,
        userId,
        validLinks,
        client
      )
      return { row, linkedTicketIds: validLinks }
    })
    return {
      id: Number(result.row.id),
      ticket: result.row,
      linkedTicketIds: result.linkedTicketIds
    }
  }

  async saveAccount(userId, data) {
    const ticketId = Number(data.ticketId != null ? data.ticketId : data.ticket_id)
    if (!Number.isSafeInteger(ticketId)) {
      throw new ApiError(400, '计数工单号不合法', 'COUNT_TICKET_BAD_ID')
    }
    const account = normalizeAccount(data || {})
    return this.repo.transaction(async client => {
      const ticket = await this.repo.lockTicket(ticketId, userId, client)
      if (!ticket) throw new ApiError(404, '计数工单不存在', 'COUNT_TICKET_NOT_FOUND')
      if (ticket.status !== 'active') {
        throw new ApiError(400, '已关闭的计数工单不能绑定账号', 'COUNT_TICKET_CLOSED')
      }
      if (String(ticket.platform) !== account.platform) {
        throw new ApiError(
          400,
          '接入账号所属应用与计数工单不一致',
          'COUNT_ACCOUNT_PLATFORM_MISMATCH'
        )
      }
      if (!(await this.repo.accountReported(userId, account.platform, account.accountKey, client))) {
        throw new ApiError(
          400,
          '这个接入账号还没有被客户端上报，请先在客户端打开对应应用会话',
          'COUNT_ACCOUNT_NOT_REPORTED'
        )
      }
      const row = await this.repo.saveAccount(ticketId, userId, account, client)
      return { account: row }
    })
  }

  async removeAccount(userId, data) {
    const ticketId = Number(data.ticketId != null ? data.ticketId : data.ticket_id)
    if (!Number.isSafeInteger(ticketId)) {
      throw new ApiError(400, '计数工单号不合法', 'COUNT_TICKET_BAD_ID')
    }
    const account = normalizeAccount(data || {})
    const row = await this.repo.transaction(async client => {
      const ticket = await this.repo.lockTicket(ticketId, userId, client)
      if (!ticket) throw new ApiError(404, '计数工单不存在', 'COUNT_TICKET_NOT_FOUND')
      return this.repo.deactivateAccount(ticketId, userId, account, client)
    })
    if (!row) throw new ApiError(404, '这个账号没有绑定在该工单上', 'COUNT_ACCOUNT_NOT_FOUND')
    return { ok: true }
  }

  async availableAccounts(userId, ticketId) {
    const id = Number(ticketId)
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ApiError(400, '计数工单号不合法', 'COUNT_TICKET_BAD_ID')
    }
    const ticket = await this.repo.ticketForOwner(id, userId)
    if (!ticket) throw new ApiError(404, '计数工单不存在', 'COUNT_TICKET_NOT_FOUND')
    return this.repo.availableAccounts(userId, ticket.platform)
  }

  /**
   * 把一个真实会话接入计数工单。
   *
   * 只认 ticket_accounts 的绑定关系：未绑定账号的会话不会靠“猜”进任何工单。
   * 本方法是幂等的，同一 conversationId 重复上报只会返回第一次的事件。
   */
  async captureFan(userId, payload) {
    const platform = cleanText(payload.platform, 32).toLowerCase()
    const accountKey = cleanText(payload.accountKey, 200)
    const peerKey = cleanText(payload.peerKey, 200)
    const conversationId = Number(payload.conversationId)
    const direction = cleanText(payload.direction || 'in', 8)
    const body = String(payload.body == null ? '' : payload.body).trim()
    const eventType = cleanText(payload.eventType || (body ? 'message' : 'conversation'), 16)
    if (!platform || !accountKey || !peerKey || !Number.isSafeInteger(conversationId)) {
      return { captured: false, reason: 'invalid_event' }
    }
    if (eventType !== 'message' || direction !== 'in') {
      return { captured: false, reason: 'not_an_inbound_message' }
    }
    const eventAt = payload.eventAt ? new Date(payload.eventAt) : new Date()
    if (Number.isNaN(eventAt.getTime())) return { captured: false, reason: 'invalid_event_at' }
    if (eventAt.getTime() > Date.now() + 10 * 60 * 1000) {
      return { captured: false, reason: 'event_at_in_future' }
    }

    return this.repo.transaction(async client => {
      const ticket = await this.repo.activeTicketForAccount(userId, platform, accountKey, client)
      if (!ticket) return { captured: false, reason: 'account_not_bound' }
      const activeSince = ticket.account_active_since
        ? new Date(ticket.account_active_since).getTime()
        : 0
      if (activeSince && eventAt.getTime() + ACCOUNT_BINDING_GRACE_MS < activeSince) {
        return { captured: false, reason: 'before_account_binding' }
      }

      const existing = await this.repo.fanByConversation(Number(ticket.id), conversationId, client)
      if (existing) {
        return {
          captured: false,
          reason: 'conversation_already_counted',
          ticketId: Number(ticket.id),
          fanType: existing.fan_type,
          fanId: Number(existing.id)
        }
      }

      const customerId = payload.customerId == null ? null : Number(payload.customerId)
      await this.repo.lockCustomer(Number.isSafeInteger(customerId) ? customerId : null, client)
      await this.repo.lockDedupKey(
        userId,
        platform,
        Number.isSafeInteger(customerId) ? customerId : null,
        peerKey,
        client
      )
      const prior = Number.isSafeInteger(customerId)
        ? await this.repo.priorFanForCustomer(
          userId, Number(ticket.id), customerId, platform, client
        )
        : await this.repo.priorFanForPeer(
          userId, Number(ticket.id), platform, peerKey, client
        )
      const fanType = prior ? 'repeat' : 'new'
      const inserted = await this.repo.insertFan({
        ticketId: Number(ticket.id),
        userId,
        conversationId,
        customerId: Number.isSafeInteger(customerId) ? customerId : null,
        platform,
        accountKey,
        peerKey,
        displayName: cleanText(payload.displayName, 200),
        eventType,
        direction,
        fanType,
        repeatOfId: prior ? Number(prior.id) : null,
        eventAt,
        timezone: ticket.timezone,
        zeroTime: ticket.zero_time
      }, client)
      if (inserted) {
        let finalFan = inserted
        if (Number.isSafeInteger(customerId)) {
          await this.repo.rerankCustomerFans(customerId, platform, client)
          finalFan = await this.repo.fanById(inserted.id, client) || inserted
        } else {
          await this.repo.rerankPeerFans(userId, platform, peerKey, client)
          finalFan = await this.repo.fanById(inserted.id, client) || inserted
        }
        return {
          captured: true,
          ticketId: Number(ticket.id),
          fanId: Number(inserted.id),
          fanType: finalFan.fan_type,
          repeatOfId: finalFan.repeat_of_id == null ? null : Number(finalFan.repeat_of_id)
        }
      }
      const raced = await this.repo.fanByConversation(Number(ticket.id), conversationId, client)
      return {
        captured: false,
        reason: 'conversation_already_counted',
        ticketId: Number(ticket.id),
        fanType: raced ? raced.fan_type : null,
        fanId: raced ? Number(raced.id) : null
      }
    })
  }

  async list(userId, data) {
    const status = cleanText(data.status || 'all', 16)
    if (status !== 'all' && !TICKET_STATUSES.has(status)) {
      throw new ApiError(400, '工单状态不合法', 'COUNT_STATUS_BAD')
    }
    const limit = Math.min(Math.max(Number(data.rows || data.size) || 50, 1), 100)
    const page = Math.min(Math.max(Number(data.page) || 1, 1), 1_000_000)
    const result = await this.repo.listTickets({
      userId,
      keyword: cleanText(data.keyword, 120),
      status,
      limit,
      offset: (page - 1) * limit
    })
    return {
      rows: result.rows,
      total: result.total,
      page,
      pageSize: limit
    }
  }

  async detail(ticketId, access) {
    const id = Number(ticketId)
    if (!Number.isSafeInteger(id)) {
      throw new ApiError(400, '计数工单号不合法', 'COUNT_TICKET_BAD_ID')
    }
    const scope = normalizeAccess(access)
    const ticket = scope.admin
      ? await this.repo.ticketForAdmin(id)
      : await this.repo.ticketForOwner(id, scope.userId)
    if (!ticket) throw new ApiError(404, '计数工单不存在', 'COUNT_TICKET_NOT_FOUND')
    const [metrics, accounts, dedupTicketIds] = await Promise.all([
      this.repo.metrics(id),
      this.repo.accounts(id),
      this.repo.dedupTicketIds(id, Number(ticket.user_id))
    ])
    return { ticket: mapRow(ticket), metrics, accounts, dedupTicketIds }
  }

  async dedupOptions(userId, data) {
    const ticketId = data.ticketId != null ? Number(data.ticketId) : 0
    if (ticketId && (!Number.isSafeInteger(ticketId) || ticketId <= 0)) {
      throw new ApiError(400, '计数工单号不合法', 'COUNT_TICKET_BAD_ID')
    }
    const platform = cleanText(data.platform, 32).toLowerCase()
    if (!platform) throw new ApiError(400, '请选择计数应用', 'COUNT_PLATFORM_REQUIRED')
    return this.repo.dedupTicketOptions(userId, ticketId, platform)
  }

  async fans(ticketId, access, data) {
    const id = Number(ticketId)
    if (!Number.isSafeInteger(id)) {
      throw new ApiError(400, '计数工单号不合法', 'COUNT_TICKET_BAD_ID')
    }
    const scope = normalizeAccess(access)
    const ticket = scope.admin
      ? await this.repo.ticketForAdmin(id)
      : await this.repo.ticketForOwner(id, scope.userId)
    if (!ticket) throw new ApiError(404, '计数工单不存在', 'COUNT_TICKET_NOT_FOUND')
    const type = cleanText(data.type || 'all', 16)
    if (type !== 'all' && !FAN_TYPES.has(type)) {
      throw new ApiError(400, '粉丝类型不合法', 'COUNT_FAN_TYPE_BAD')
    }
    const limit = Math.min(Math.max(Number(data.rows || data.size) || 30, 1), 100)
    const page = Math.min(Math.max(Number(data.page) || 1, 1), 1_000_000)
    const result = await this.repo.listFans(id, {
      type,
      platform: cleanText(data.platform, 32).toLowerCase(),
      accountKey: cleanText(data.accountKey != null ? data.accountKey : data.account_key, 200),
      keyword: cleanText(data.keyword, 120),
      after: dateValue(data.after),
      before: dateValue(data.before),
      limit,
      offset: (page - 1) * limit
    })
    return { rows: result.rows, total: result.total, page, pageSize: limit }
  }
}

function normalizeAccess(access) {
  if (access && access.admin === true) return { admin: true, userId: null }
  const userId = access && Number(access.userId)
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new ApiError(500, '计数工单查询缺少访问作用域', 'COUNT_ACCESS_SCOPE_REQUIRED')
  }
  return { admin: false, userId }
}

module.exports = {
  CountTicketService,
  normalizeTicket,
  normalizeAccount,
  normalizeDedupScope,
  normalizeLinkedTicketIds,
  validTimezone,
  validZeroTime,
  normalizeAccess
}
