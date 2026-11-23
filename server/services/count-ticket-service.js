'use strict'

const crypto = require('crypto')
const { ApiError } = require('../lib/http')
const { mapRow } = require('../repositories/production-repository')
const password = require('../lib/password')
const catalog = require('../lib/client-catalog')

const TICKET_STATUSES = new Set(['active', 'closed'])
const FAN_TYPES = new Set(['new', 'repeat'])
const DEDUP_SCOPES = new Set(['ticket', 'merchant', 'group', 'linked'])
const BASE_IMPORT_MAX = 1000
const BASE_ENTRY_TYPES = new Set(['fan', 'base'])
const ACCOUNT_BINDING_GRACE_MS = 2 * 60 * 1000
const SHARE_DEFAULT_DAYS = 30
const SHARE_MAX_DAYS = 365

function cleanText(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max)
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

function assertCountingPlatform(platform) {
  if (!catalog.supportsCounting(platform)) {
    throw new ApiError(
      400,
      '当前应用还没有接入自动筛粉，请选择 WhatsApp 或 Telegram',
      'COUNT_PLATFORM_UNSUPPORTED'
    )
  }
  return platform
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

function normalizeGroupId(value) {
  if (value == null || value === '') return null
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ApiError(400, '计数工单分组号不合法', 'COUNT_GROUP_BAD_ID')
  }
  return id
}

function normalizeBoolean(value, fallback) {
  if (value == null || value === '') return fallback
  if (value === true || value === 1 || /^(1|true|yes|on)$/i.test(String(value))) return true
  if (value === false || value === 0 || /^(0|false|no|off)$/i.test(String(value))) return false
  throw new ApiError(400, '开关值不合法', 'COUNT_BOOLEAN_BAD')
}

function normalizeBaseLines(value) {
  const text = String(value == null ? '' : value).replace(/\r\n?/g, '\n')
  const byPeer = new Map()
  let totalLines = 0
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    totalLines += 1
    let parts = line.includes('----')
      ? line.split('----')
      : (line.includes('\t') ? line.split('\t') : line.split(','))
    parts = parts.map(part => part.trim())
    const peerKey = cleanText(parts[0], 200)
    if (!peerKey) continue
    if (/^(username|peer|peerkey|用户名|平台id)$/i.test(peerKey)) continue
    byPeer.set(peerKey, {
      peerKey,
      displayName: cleanText(parts[1], 200),
      source: cleanText(parts[2], 120)
    })
  }
  const entries = Array.from(byPeer.values())
  if (entries.length > BASE_IMPORT_MAX) {
    throw new ApiError(
      400,
      `单次最多导入 ${BASE_IMPORT_MAX} 条底库线索，请分批上传`,
      'COUNT_BASE_IMPORT_TOO_MANY'
    )
  }
  return { entries, totalLines }
}

function normalizeShare(data) {
  const passwordProtected = normalizeBoolean(
    data && (data.passwordProtected != null
      ? data.passwordProtected
      : data.password_protected),
    true
  )
  let sharePassword = cleanText(
    data && (data.password != null ? data.password : data.sharePassword),
    32
  )
  if (passwordProtected && !sharePassword) {
    sharePassword = crypto.randomBytes(5).toString('hex')
  }
  if (sharePassword && sharePassword.length < 6) {
    throw new ApiError(400, '分享密码至少 6 位', 'COUNT_SHARE_PASSWORD_WEAK')
  }
  const rawDays = data && (data.expiresInDays != null
    ? data.expiresInDays
    : data.expires_in_days)
  const expiresInDays = rawDays == null || rawDays === ''
    ? SHARE_DEFAULT_DAYS
    : Math.min(Math.max(Math.floor(Number(rawDays) || 0), 0), SHARE_MAX_DAYS)
  return {
    passwordProtected,
    password: passwordProtected ? sharePassword : '',
    expiresInDays
  }
}

function shareTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

function shareState(row) {
  if (!row) return null
  return {
    enabled: row.enabled === true,
    passwordProtected: row.passwordProtected === true || row.password_protected === true,
    tokenPrefix: row.tokenPrefix || row.token_prefix || '',
    expiresAt: row.expiresAt || row.expires_at || null,
    viewCount: Number(row.viewCount != null ? row.viewCount : row.view_count) || 0,
    lastViewedAt: row.lastViewedAt || row.last_viewed_at || null,
    createdAt: row.createdAt || row.created_at || null,
    updatedAt: row.updatedAt || row.updated_at || null
  }
}

function normalizeGroup(data) {
  const name = cleanText(data.name, 80)
  const platform = assertCountingPlatform(cleanText(data.platform, 32).toLowerCase())
  if (!name) throw new ApiError(400, '请填写分组名称', 'COUNT_GROUP_NAME_REQUIRED')
  if (!platform) throw new ApiError(400, '请选择分组应用', 'COUNT_PLATFORM_REQUIRED')
  return {
    id: data.id == null || data.id === '' ? null : Number(data.id),
    name,
    platform
  }
}

function normalizeTicket(data) {
  const title = cleanText(data.title, 120)
  if (!title) throw new ApiError(400, '请填写计数工单名称', 'COUNT_TITLE_REQUIRED')
  const platform = assertCountingPlatform(cleanText(data.platform, 32).toLowerCase())
  if (!platform) throw new ApiError(400, '请选择计数应用', 'COUNT_PLATFORM_REQUIRED')
  const status = cleanText(data.status || 'active', 16)
  if (!TICKET_STATUSES.has(status)) throw new ApiError(400, '工单状态不合法', 'COUNT_STATUS_BAD')
  return {
    title,
    platform,
    status,
    timezone: validTimezone(data.timezone),
    zeroTime: validZeroTime(data.zeroTime != null ? data.zeroTime : data.zero_time),
    dedupScope: normalizeDedupScope(
      data.dedupScope != null ? data.dedupScope : data.dedup_scope
    ),
    groupId: normalizeGroupId(data.groupId != null ? data.groupId : data.group_id),
    dedupBaseEnabled: normalizeBoolean(
      data.dedupBaseEnabled != null ? data.dedupBaseEnabled : data.dedup_base_enabled,
      false
    )
  }
}

function normalizeAccount(data) {
  const platform = assertCountingPlatform(cleanText(data.platform, 32).toLowerCase())
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
    const groupProvided = !!data && (data.groupId !== undefined || data.group_id !== undefined)
    const baseProvided = !!data && (
      data.dedupBaseEnabled !== undefined || data.dedup_base_enabled !== undefined
    )
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
        if (!groupProvided) payload.groupId = current.group_id == null ? null : Number(current.group_id)
        if (!baseProvided) payload.dedupBaseEnabled = current.dedup_base_enabled === true
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
          const groupChanged = (current.group_id == null ? null : Number(current.group_id)) !== payload.groupId
          const baseChanged = current.dedup_base_enabled !== payload.dedupBaseEnabled
          if (scopeChanged || linksChanged || groupChanged || baseChanged) {
            throw new ApiError(
              409,
              '该工单已有进粉记录，查重范围、分组、底库和关联工单不能再修改',
              'COUNT_DEDUP_SCOPE_LOCKED'
            )
          }
        }
      }

      if (payload.dedupScope === 'group' && !payload.groupId) {
        throw new ApiError(400, '组内查重必须先选择命名分组', 'COUNT_GROUP_REQUIRED')
      }
      if (payload.dedupScope === 'linked' && !linkedTicketIds.length) {
        throw new ApiError(
          400,
          '指定查重工单至少需要选择一张其它工单',
          'COUNT_DEDUP_LINKS_REQUIRED'
        )
      }
      if (payload.groupId) {
        const group = await this.repo.validGroupForTicket(
          payload.groupId, userId, payload.platform, client
        )
        if (!group) {
          throw new ApiError(
            400,
            '计数工单分组必须属于当前商户并使用同一个应用',
            'COUNT_GROUP_INVALID'
          )
        }
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
          repeatType: existing.repeat_type,
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
      const baseHit = ticket.dedup_base_enabled
        ? await this.repo.baseEntryForPeer(userId, platform, peerKey, client)
        : null
      const fanType = prior || baseHit ? 'repeat' : 'new'
      const repeatType = prior ? 'fan' : (baseHit ? 'base' : 'fan')
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
        repeatType,
        baseMatched: !!baseHit,
        repeatOfId: prior ? Number(prior.id) : null,
        eventAt,
        timezone: ticket.timezone,
        zeroTime: ticket.zero_time,
        cycleNo: Number(ticket.cycle_no) || 1
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
          repeatType: finalFan.repeat_type,
          repeatOfId: finalFan.repeat_of_id == null ? null : Number(finalFan.repeat_of_id)
        }
      }
      const raced = await this.repo.fanByConversation(Number(ticket.id), conversationId, client)
      return {
        captured: false,
        reason: 'conversation_already_counted',
        ticketId: Number(ticket.id),
        fanType: raced ? raced.fan_type : null,
        repeatType: raced ? raced.repeat_type : null,
        fanId: raced ? Number(raced.id) : null
      }
    })
  }

  async resetCycle(userId, data) {
    const ticketId = Number(data && data.id)
    if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
      throw new ApiError(400, '计数工单号不合法', 'COUNT_TICKET_BAD_ID')
    }
    return this.repo.transaction(async client => {
      const ticket = await this.repo.lockTicket(ticketId, userId, client)
      if (!ticket) throw new ApiError(404, '计数工单不存在', 'COUNT_TICKET_NOT_FOUND')
      const currentCycle = Number(ticket.cycle_no) || 1
      const promoted = await this.repo.promoteTicketFansToBase(ticket, client)
      const cycle = await this.repo.startNextCycle(ticketId, userId, client)
      return {
        ticketId,
        previousCycle: currentCycle,
        cycleNo: Number(cycle.cycle_no),
        cycleStartedAt: cycle.cycle_started_at,
        promoted
      }
    })
  }

  async shareState(userId, ticketId) {
    const id = Number(ticketId)
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ApiError(400, '计数工单号不合法', 'COUNT_TICKET_BAD_ID')
    }
    const ticket = await this.repo.ticketForOwner(id, userId)
    if (!ticket) throw new ApiError(404, '计数工单不存在', 'COUNT_TICKET_NOT_FOUND')
    return shareState(await this.repo.shareForOwner(id, userId))
  }

  async createShare(userId, ticketId, data) {
    const id = Number(ticketId)
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ApiError(400, '计数工单号不合法', 'COUNT_TICKET_BAD_ID')
    }
    const payload = normalizeShare(data || {})
    const token = crypto.randomBytes(24).toString('base64url')
    // scrypt 放到事务外，避免一次分享轮换把该工单的计粉写入锁住上百毫秒。
    const passwordHash = payload.password
      ? await password.hashPassword(payload.password)
      : null
    const expiresAt = payload.expiresInDays
      ? new Date(Date.now() + payload.expiresInDays * 24 * 60 * 60 * 1000)
      : null
    return this.repo.transaction(async client => {
      const ticket = await this.repo.lockTicket(id, userId, client)
      if (!ticket) throw new ApiError(404, '计数工单不存在', 'COUNT_TICKET_NOT_FOUND')

      const row = await this.repo.upsertShare(id, userId, {
        tokenHash: shareTokenHash(token),
        tokenPrefix: token.slice(0, 8),
        passwordHash,
        expiresAt
      }, client)
      return {
        token,
        sharePath: `/#/share/count/${encodeURIComponent(token)}`,
        password: payload.password || '',
        state: shareState(row)
      }
    })
  }

  async revokeShare(userId, ticketId) {
    const id = Number(ticketId)
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ApiError(400, '计数工单号不合法', 'COUNT_TICKET_BAD_ID')
    }
    return this.repo.transaction(async client => {
      const ticket = await this.repo.lockTicket(id, userId, client)
      if (!ticket) throw new ApiError(404, '计数工单不存在', 'COUNT_TICKET_NOT_FOUND')
      const row = await this.repo.revokeShare(id, userId, client)
      if (!row) throw new ApiError(404, '该工单还没有分享链接', 'COUNT_SHARE_NOT_FOUND')
      return { ok: true }
    })
  }

  /**
   * 公开只读对账页。
   *
   * token 与密码都走 POST body，不放进 URL/query，避免进入 Nginx 访问日志。
   * 密码错误固定返回 403 而不是 401，防止前端通用拦截器把访客当成“掉线”。
   */
  async viewShare(data) {
    const token = cleanText(data && data.token, 200)
    const suppliedPassword = String(data && data.password || '')
    if (!token) throw new ApiError(404, '分享链接无效', 'COUNT_SHARE_NOT_FOUND')
    const row = await this.repo.shareByTokenHash(shareTokenHash(token))
    if (!row || row.enabled !== true) {
      throw new ApiError(404, '分享链接无效或已停用', 'COUNT_SHARE_NOT_FOUND')
    }
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      throw new ApiError(410, '分享链接已过期，请向商户索取新链接', 'COUNT_SHARE_EXPIRED')
    }
    if (row.password_hash) {
      const valid = await password.verifyPassword(row.password_hash, suppliedPassword)
      if (!valid) {
        throw new ApiError(403, '分享密码不正确', 'COUNT_SHARE_PASSWORD_BAD')
      }
    }

    const limit = Math.min(Math.max(Number(data.rows || data.size) || 30, 1), 100)
    const page = Math.min(Math.max(Number(data.page) || 1, 1), 1_000_000)
    const ticketId = Number(row.ticket_id)
    const type = cleanText(data.type || 'all', 16)
    if (type !== 'all' && !FAN_TYPES.has(type)) {
      throw new ApiError(400, '粉丝类型不合法', 'COUNT_FAN_TYPE_BAD')
    }
    const repeatType = cleanText(data.repeatType || data.repeat_type || 'all', 16)
    if (repeatType !== 'all' && !BASE_ENTRY_TYPES.has(repeatType)) {
      throw new ApiError(400, '重粉依据不合法', 'COUNT_REPEAT_TYPE_BAD')
    }
    const [metrics, accounts, fanResult] = await Promise.all([
      this.repo.metrics(ticketId),
      this.repo.accounts(ticketId),
      this.repo.listFans(ticketId, {
        type,
        repeatType,
        keyword: cleanText(data.keyword, 120),
        limit,
        offset: (page - 1) * limit
      })
    ])
    await this.repo.recordShareView(Number(row.share_id))

    return {
      share: {
        passwordProtected: !!row.password_hash,
        expiresAt: row.expires_at || null
      },
      ticket: {
        id: ticketId,
        title: row.title,
        platform: row.platform,
        status: row.status,
        timezone: row.timezone,
        zeroTime: row.zero_time,
        cycleNo: Number(row.cycle_no) || 1,
        cycleStartedAt: row.cycle_started_at || null,
        lastCycleResetAt: row.last_cycle_reset_at || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      },
      metrics,
      accounts,
      fans: fanResult.rows,
      total: fanResult.total,
      page,
      pageSize: limit
    }
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
    const [metrics, accounts, dedupTicketIds, share] = await Promise.all([
      this.repo.metrics(id),
      this.repo.accounts(id),
      this.repo.dedupTicketIds(id, Number(ticket.user_id)),
      this.repo.shareForOwner(id, Number(ticket.user_id))
    ])
    return { ticket: mapRow(ticket), metrics, accounts, dedupTicketIds, share: shareState(share) }
  }

  async dedupOptions(userId, data) {
    const ticketId = data.ticketId != null ? Number(data.ticketId) : 0
    if (ticketId && (!Number.isSafeInteger(ticketId) || ticketId <= 0)) {
      throw new ApiError(400, '计数工单号不合法', 'COUNT_TICKET_BAD_ID')
    }
    const platform = assertCountingPlatform(cleanText(data.platform, 32).toLowerCase())
    if (!platform) throw new ApiError(400, '请选择计数应用', 'COUNT_PLATFORM_REQUIRED')
    return this.repo.dedupTicketOptions(userId, ticketId, platform)
  }

  async groups(userId, data) {
    const platform = assertCountingPlatform(cleanText(data.platform, 32).toLowerCase())
    return this.repo.listGroups(userId, platform)
  }

  async saveGroup(userId, data) {
    const payload = normalizeGroup(data || {})
    if (payload.id != null && (!Number.isSafeInteger(payload.id) || payload.id <= 0)) {
      throw new ApiError(400, '分组号不合法', 'COUNT_GROUP_BAD_ID')
    }
    try {
      const row = await this.repo.saveGroup(userId, payload)
      if (!row) throw new ApiError(404, '计数工单分组不存在', 'COUNT_GROUP_NOT_FOUND')
      return mapRow(row)
    } catch (error) {
      if (error && error.code === '23505') {
        throw new ApiError(409, '同一应用下已存在同名分组', 'COUNT_GROUP_NAME_DUPLICATE')
      }
      throw error
    }
  }

  async deleteGroup(userId, data) {
    const id = Number(data.id)
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ApiError(400, '分组号不合法', 'COUNT_GROUP_BAD_ID')
    }
    return this.repo.transaction(async client => {
      const group = await this.repo.groupForOwner(id, userId, client)
      if (!group) throw new ApiError(404, '计数工单分组不存在', 'COUNT_GROUP_NOT_FOUND')
      const assigned = await this.repo.groupTicketCount(id, userId, client)
      if (assigned > 0) {
        throw new ApiError(
          409,
          '分组下还有计数工单，请先把工单移出分组',
          'COUNT_GROUP_NOT_EMPTY'
        )
      }
      await this.repo.deleteGroup(id, userId, client)
      return { ok: true }
    })
  }

  async baseStats(userId, data) {
    const platform = assertCountingPlatform(cleanText(data.platform, 32).toLowerCase())
    if (!platform) throw new ApiError(400, '请选择底库应用', 'COUNT_PLATFORM_REQUIRED')
    return this.repo.baseStats(userId, platform)
  }

  async baseEntries(userId, data) {
    const platform = assertCountingPlatform(cleanText(data.platform, 32).toLowerCase())
    if (!platform) throw new ApiError(400, '请选择底库应用', 'COUNT_PLATFORM_REQUIRED')
    const limit = Math.min(Math.max(Number(data.rows || data.size) || 30, 1), 100)
    const page = Math.min(Math.max(Number(data.page) || 1, 1), 1_000_000)
    const result = await this.repo.listBaseEntries(userId, {
      platform,
      keyword: cleanText(data.keyword, 200),
      limit,
      offset: (page - 1) * limit
    })
    return { rows: result.rows, total: result.total, page, pageSize: limit }
  }

  async importBase(userId, data) {
    const platform = assertCountingPlatform(cleanText(data.platform, 32).toLowerCase())
    if (!platform) throw new ApiError(400, '请选择底库应用', 'COUNT_PLATFORM_REQUIRED')
    const { entries, totalLines } = normalizeBaseLines(data.text)
    if (!entries.length) {
      throw new ApiError(400, '没有可导入的底库线索', 'COUNT_BASE_IMPORT_EMPTY')
    }
    return this.repo.transaction(async client => {
      const existing = await this.repo.existingBasePeers(
        userId, platform, entries.map(item => item.peerKey), client
      )
      const insertedCount = entries.filter(item => !existing.has(item.peerKey)).length
      const updatedCount = entries.length - insertedCount
      const batch = await this.repo.createBaseBatch(userId, {
        platform,
        filename: cleanText(data.filename, 200),
        totalLines,
        insertedCount,
        updatedCount
      }, client)
      await this.repo.upsertBaseEntries(
        userId, platform, Number(batch.id), entries, client
      )
      return {
        batchId: Number(batch.id),
        totalLines,
        accepted: entries.length,
        inserted: insertedCount,
        updated: updatedCount
      }
    })
  }

  async clearBase(userId, data) {
    const platform = assertCountingPlatform(cleanText(data.platform, 32).toLowerCase())
    if (!platform) throw new ApiError(400, '请选择底库应用', 'COUNT_PLATFORM_REQUIRED')
    return { removed: await this.repo.clearBase(userId, platform) }
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
    const repeatType = cleanText(data.repeatType || data.repeat_type || 'all', 16)
    if (repeatType !== 'all' && !BASE_ENTRY_TYPES.has(repeatType)) {
      throw new ApiError(400, '重粉依据不合法', 'COUNT_REPEAT_TYPE_BAD')
    }
    const limit = Math.min(Math.max(Number(data.rows || data.size) || 30, 1), 100)
    const page = Math.min(Math.max(Number(data.page) || 1, 1), 1_000_000)
    const result = await this.repo.listFans(id, {
      type,
      repeatType,
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
  normalizeGroup,
  normalizeBaseLines,
  normalizeShare,
  shareTokenHash,
  validTimezone,
  validZeroTime,
  normalizeAccess
}
