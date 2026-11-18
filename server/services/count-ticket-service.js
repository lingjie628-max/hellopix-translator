'use strict'

const { ApiError } = require('../lib/http')
const { mapRow } = require('../repositories/production-repository')
const catalog = require('../lib/client-catalog')

const TICKET_STATUSES = new Set(['active', 'closed'])
const FAN_TYPES = new Set(['new', 'repeat'])

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
    zeroTime: validZeroTime(data.zeroTime != null ? data.zeroTime : data.zero_time)
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
    return !!parent && catalog.packageAllowsCounter(parent.packageClients)
  }

  async saveTicket(userId, data) {
    const payload = normalizeTicket(data || {})
    const id = data && data.id ? Number(data.id) : null
    if (id != null && !Number.isSafeInteger(id)) {
      throw new ApiError(400, '计数工单号不合法', 'COUNT_TICKET_BAD_ID')
    }
    const row = await this.repo.transaction(async client => {
      if (id != null) {
        const current = await this.repo.lockTicket(id, userId, client)
        if (!current) throw new ApiError(404, '计数工单不存在', 'COUNT_TICKET_NOT_FOUND')
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
        return this.repo.updateTicket(id, userId, payload, client)
      }
      return this.repo.createTicket(userId, payload, client)
    })
    return { id: Number(row.id), ticket: row }
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
    if (!platform || !accountKey || !peerKey || !Number.isSafeInteger(conversationId)) {
      return { captured: false, reason: 'invalid_event' }
    }
    const eventAt = payload.eventAt ? new Date(payload.eventAt) : new Date()
    if (Number.isNaN(eventAt.getTime())) return { captured: false, reason: 'invalid_event_at' }

    return this.repo.transaction(async client => {
      const ticket = await this.repo.activeTicketForAccount(userId, platform, accountKey, client)
      if (!ticket) return { captured: false, reason: 'account_not_bound' }

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
      const prior = Number.isSafeInteger(customerId)
        ? await this.repo.priorFanForCustomer(customerId, platform, client)
        : await this.repo.priorFanForPeer(
          Number(ticket.id), platform, accountKey, peerKey, client
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
        fanType,
        repeatOfId: prior ? Number(prior.id) : null,
        eventAt,
        timezone: ticket.timezone,
        zeroTime: ticket.zero_time
      }, client)
      if (inserted) {
        return {
          captured: true,
          ticketId: Number(ticket.id),
          fanId: Number(inserted.id),
          fanType
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
    const page = Math.max(Number(data.page) || 1, 1)
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
    const [metrics, accounts] = await Promise.all([
      this.repo.metrics(id),
      this.repo.accounts(id)
    ])
    return { ticket: mapRow(ticket), metrics, accounts }
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
    const page = Math.max(Number(data.page) || 1, 1)
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
  validTimezone,
  validZeroTime,
  normalizeAccess
}
