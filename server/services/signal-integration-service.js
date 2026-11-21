'use strict'

const crypto = require('crypto')

const { ApiError } = require('../lib/http')

const EVENT_REQUIRED = Object.freeze([
  'schemaVersion',
  'kind',
  'eventId',
  'occurredAt',
  'provider',
  'model',
  'targetLanguage',
  'status',
  'cacheHit',
  'durationMs',
  'sourceLength'
])

const EVENT_ALLOWED = new Set([
  ...EVENT_REQUIRED,
  'messageId',
  'reason',
  'translatedLength',
  'sourceTextHmac',
  'translatedTextHmac'
])

const WORKORDER_MODES = new Set(['failures', 'all', 'ledger'])

function text(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max)
}

function bearer(req) {
  const value = String((req.headers && req.headers.authorization) || '')
  const match = /^Bearer\s+(.+)$/i.exec(value)
  return match ? match[1].trim() : ''
}

function equalToken(actual, expected) {
  const left = Buffer.from(String(actual || ''))
  const right = Buffer.from(String(expected || ''))
  return left.length === right.length &&
    left.length > 0 &&
    crypto.timingSafeEqual(left, right)
}

function tokenHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}

function createToken() {
  const value = crypto.randomBytes(32).toString('base64url')
  return {
    value,
    hash: tokenHash(value),
    prefix: value.slice(0, 8)
  }
}

function isoDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function normalizeEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, '事件必须是 JSON 对象', 'SIGNAL_EVENT_INVALID')
  }
  for (const key of Object.keys(value)) {
    if (!EVENT_ALLOWED.has(key)) {
      throw new ApiError(400, `事件包含未知字段：${key}`, 'SIGNAL_EVENT_UNKNOWN_FIELD')
    }
  }
  for (const key of EVENT_REQUIRED) {
    if (!(key in value)) {
      throw new ApiError(400, `事件缺少字段：${key}`, 'SIGNAL_EVENT_REQUIRED_FIELD')
    }
  }
  if (value.schemaVersion !== 1 || value.kind !== 'translation.completed') {
    throw new ApiError(400, '事件版本或类型不合法', 'SIGNAL_EVENT_VERSION')
  }
  const occurredAt = isoDate(value.occurredAt)
  if (!occurredAt) {
    throw new ApiError(400, 'occurredAt 不是合法时间', 'SIGNAL_EVENT_DATE')
  }
  const status = text(value.status, 16)
  if (!['success', 'skipped', 'error', 'disabled'].includes(status)) {
    throw new ApiError(400, '事件状态不合法', 'SIGNAL_EVENT_STATUS')
  }
  const eventId = text(value.eventId, 200)
  const provider = text(value.provider, 80)
  const model = text(value.model, 200)
  const targetLanguage = text(value.targetLanguage, 35)
  if (!eventId || !provider || !model || targetLanguage.length < 2) {
    throw new ApiError(400, '事件标识、Provider、模型或语言不完整', 'SIGNAL_EVENT_REQUIRED_FIELD')
  }
  if (typeof value.cacheHit !== 'boolean') {
    throw new ApiError(400, 'cacheHit 必须是布尔值', 'SIGNAL_EVENT_CACHE_HIT')
  }
  if (value.messageId != null && typeof value.messageId !== 'string') {
    throw new ApiError(400, 'messageId 必须是字符串', 'SIGNAL_EVENT_MESSAGE_ID')
  }
  if (value.reason != null && typeof value.reason !== 'string') {
    throw new ApiError(400, 'reason 必须是字符串', 'SIGNAL_EVENT_REASON')
  }
  const durationMs = Math.floor(Number(value.durationMs))
  const sourceLength = Math.floor(Number(value.sourceLength))
  const translatedLength = value.translatedLength == null
    ? null
    : Math.floor(Number(value.translatedLength))
  if (!Number.isFinite(durationMs) || durationMs < 0 ||
      !Number.isFinite(sourceLength) || sourceLength < 0 ||
      (translatedLength !== null && (!Number.isFinite(translatedLength) || translatedLength < 0))) {
    throw new ApiError(400, '事件长度或耗时字段不合法', 'SIGNAL_EVENT_LENGTH')
  }
  for (const key of ['sourceTextHmac', 'translatedTextHmac']) {
    if (value[key] != null && !/^[a-f0-9]{64}$/.test(String(value[key]))) {
      throw new ApiError(400, `${key} 必须是 64 位小写十六进制`, 'SIGNAL_EVENT_HMAC')
    }
  }
  return {
    schemaVersion: 1,
    kind: 'translation.completed',
    eventId,
    occurredAt,
    messageId: value.messageId == null ? null : text(value.messageId, 200) || null,
    provider,
    model,
    targetLanguage,
    status,
    reason: value.reason == null ? null : text(value.reason, 200) || null,
    cacheHit: value.cacheHit === true,
    durationMs,
    sourceLength,
    translatedLength,
    sourceTextHmac: value.sourceTextHmac || null,
    translatedTextHmac: value.translatedTextHmac || null
  }
}

function normalizeTranslateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, '请求必须是 JSON 对象', 'SIGNAL_TRANSLATE_INVALID')
  }
  const allowed = new Set(['messageId', 'sourceLanguage', 'targetLanguage', 'text'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ApiError(400, `请求包含未知字段：${key}`, 'SIGNAL_TRANSLATE_UNKNOWN_FIELD')
    }
  }
  const sourceLanguage = text(value.sourceLanguage || 'auto', 35)
  const targetLanguage = text(value.targetLanguage, 35)
  const source = String(value.text == null ? '' : value.text)
  if (!source.trim()) {
    throw new ApiError(400, 'text 不能为空', 'TEXT_REQUIRED')
  }
  if (source.length > 12000) {
    throw new ApiError(413, '单次最多 12000 个字符', 'TEXT_TOO_LONG')
  }
  if (!/^(?:auto|[a-z]{2,3}(?:-[a-z0-9]{2,8})?)$/i.test(sourceLanguage)) {
    throw new ApiError(422, '源语言代码不合法', 'UNSUPPORTED_LANGUAGE')
  }
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(targetLanguage)) {
    throw new ApiError(422, '目标语言代码不合法', 'UNSUPPORTED_LANGUAGE')
  }
  return {
    messageId: value.messageId == null ? undefined : text(value.messageId, 200),
    sourceLanguage,
    targetLanguage,
    text: source
  }
}

function openApiError(error, requestId) {
  const source = error && typeof error === 'object' ? error : {}
  const status = Number(source.status || source.statusCode) || 400
  const raw = String(source.code || '')
  let code = 'request-failed'
  let httpStatus = status
  if (status === 413 || raw === 'PAYLOAD_TOO_LARGE') {
    code = 'text-too-long'
    httpStatus = 413
  } else if (raw === 'SIGNAL_AUTH_FAILED' || status === 401 || status === 403) {
    code = 'auth-failed'
    httpStatus = 401
  } else if (raw === 'TEXT_TOO_LONG') {
    code = 'text-too-long'
    httpStatus = 413
  } else if (raw === 'UNSUPPORTED_LANGUAGE') {
    code = 'unsupported-language'
    httpStatus = 422
  } else if (raw === 'SIGNAL_RATE_LIMITED' || status === 429) {
    code = 'rate-limited'
    httpStatus = 429
  } else if (raw === 'TEXT_REQUIRED' || raw === 'BAD_LANGUAGE' ||
      raw === 'IDEMPOTENCY_KEY_REQUIRED' || raw.startsWith('SIGNAL_TRANSLATE_')) {
    code = 'invalid-request'
    httpStatus = 400
  } else if (raw === 'INVALID_PROVIDER_RESPONSE') {
    code = 'invalid-response'
    httpStatus = 503
  } else if (status === 408 || status === 504) {
    code = 'timeout'
    httpStatus = 504
  } else if (status >= 500 || raw === 'ENGINE_NOT_ALLOWED' ||
      raw === 'ENGINE_NOT_CONFIGURED' || raw === 'ENGINE_RETIRED') {
    code = 'service-unavailable'
    httpStatus = 503
  } else if (status === 422) {
    code = 'content-rejected'
  } else if (status >= 400 && status < 500) {
    code = 'invalid-request'
  }
  return {
    httpStatus,
    body: {
      error: {
        code,
        message: String(source.message || source.msg || 'translation request failed').slice(0, 300),
        retryable: [429, 503, 504].includes(httpStatus),
        ...(requestId ? { providerRequestId: requestId } : {})
      }
    }
  }
}

class SignalIntegrationService {
  constructor({ repo, core, redis }) {
    this.repo = repo
    this.core = core
    this.redis = redis
  }

  async configuration() {
    const row = (await this.repo.query(
      `SELECT * FROM signal_integration_settings WHERE id=1`
    )).rows[0]
    const databaseConfigured = Boolean(row && (
      row.updated_by ||
      row.api_token_hash ||
      row.event_token_hash ||
      row.account_user_id
    ))
    if (databaseConfigured) {
      if (!row.enabled) {
        throw new ApiError(503, 'Signal 对接已关闭', 'SIGNAL_DISABLED')
      }
      if (!row.account_user_id || !row.api_token_hash || !row.event_token_hash) {
        throw new ApiError(503, 'Signal 对接尚未完整配置', 'SIGNAL_NOT_CONFIGURED')
      }
      const mode = String(row.workorder_mode || 'failures').toLowerCase()
      if (!WORKORDER_MODES.has(mode)) {
        throw new ApiError(503, 'Signal 工单模式配置不合法', 'SIGNAL_NOT_CONFIGURED')
      }
      return {
        source: 'database',
        accountUserId: Number(row.account_user_id),
        accountUsername: '',
        apiToken: '',
        apiTokenHash: String(row.api_token_hash),
        eventToken: '',
        eventTokenHash: String(row.event_token_hash),
        engineId: String(row.engine_id || ''),
        mode
      }
    }
    const apiToken = String(process.env.PIX_SIGNAL_API_TOKEN || '')
    const eventToken = String(process.env.PIX_SIGNAL_EVENT_TOKEN || '')
    const username = String(process.env.PIX_SIGNAL_ACCOUNT_USERNAME || '').trim()
    const mode = String(process.env.PIX_SIGNAL_WORKORDER_MODE || 'failures').toLowerCase()
    if (!username) {
      throw new ApiError(503, 'Signal 对接尚未配置', 'SIGNAL_NOT_CONFIGURED')
    }
    if (!WORKORDER_MODES.has(mode)) {
      throw new ApiError(503, 'Signal 工单模式配置不合法', 'SIGNAL_NOT_CONFIGURED')
    }
    return {
      source: 'environment',
      accountUserId: null,
      accountUsername: username,
      apiToken,
      apiTokenHash: '',
      eventToken,
      eventTokenHash: '',
      engineId: String(process.env.PIX_SIGNAL_TRANSLATE_ENGINE || ''),
      mode
    }
  }

  async accountSession(config) {
    let subject
    if (config.accountUserId) {
      subject = `main:${config.accountUserId}`
    } else {
      const account = await this.repo.accountByUsername(config.accountUsername)
      if (!account || Number(account.status) !== 1) {
        throw new ApiError(401, 'Signal 对接账号不可用', 'SIGNAL_AUTH_FAILED')
      }
      subject = `${account.kind === 'sub' ? 'sub' : 'main'}:${account.id}`
    }
    const session = await this.repo.sessionAccount(subject)
    if (!session || Number(session.account.status) !== 1 || Number(session.parent.status) !== 1) {
      throw new ApiError(401, 'Signal 对接账号不可用', 'SIGNAL_AUTH_FAILED')
    }
    return session
  }

  async authenticate(req, kind) {
    const config = await this.configuration()
    const supplied = bearer(req)
    const expectedToken = kind === 'event' ? config.eventToken : config.apiToken
    const expectedHash = kind === 'event' ? config.eventTokenHash : config.apiTokenHash
    if (!expectedToken && !expectedHash) {
      throw new ApiError(503, 'Signal 对接令牌尚未配置', 'SIGNAL_NOT_CONFIGURED')
    }
    const valid = expectedHash
      ? equalToken(tokenHash(supplied), expectedHash)
      : equalToken(supplied, expectedToken)
    if (!valid) {
      throw new ApiError(401, 'Bearer Token 不正确', 'SIGNAL_AUTH_FAILED')
    }
    const session = await this.accountSession(config)
    return { config, session, tokenHash: tokenHash(supplied) }
  }

  async enforceRateLimit(namespace, key, max) {
    if (!this.redis || typeof this.redis.incr !== 'function') return
    const redisKey = `pix:signal:${namespace}:${key}`
    const count = await this.redis.incr(redisKey)
    if (count === 1) await this.redis.pexpire(redisKey, 60_000)
    if (count > max) {
      throw new ApiError(429, 'Signal 对接请求过于频繁', 'SIGNAL_RATE_LIMITED')
    }
  }

  async adminState() {
    const row = (await this.repo.query(
      'SELECT * FROM signal_integration_settings WHERE id=1'
    )).rows[0]
    const accounts = (await this.repo.query(
      `SELECT id,username,nickname,status
       FROM users
       WHERE status=1
       ORDER BY updated_at DESC, id DESC
       LIMIT 500`
    )).rows
    return {
      configured: Boolean(row && (
        row.updated_by ||
        row.api_token_hash ||
        row.event_token_hash ||
        row.account_user_id
      )),
      enabled: Boolean(row && row.enabled),
      accountUserId: row && row.account_user_id ? Number(row.account_user_id) : null,
      accountUsername: row ? row.account_username : '',
      apiTokenPrefix: row ? row.api_token_prefix : '',
      eventTokenPrefix: row ? row.event_token_prefix : '',
      apiTokenConfigured: Boolean(row && row.api_token_hash),
      eventTokenConfigured: Boolean(row && row.event_token_hash),
      engineId: row ? row.engine_id : '',
      workorderMode: row ? row.workorder_mode : 'failures',
      updatedAt: row ? row.updated_at : null,
      environmentFallback: Boolean(
        process.env.PIX_SIGNAL_API_TOKEN &&
        process.env.PIX_SIGNAL_EVENT_TOKEN &&
        process.env.PIX_SIGNAL_ACCOUNT_USERNAME
      ),
      accounts
    }
  }

  async saveAdminSettings(admin, data, ip) {
    const enabled = data.enabled === true
    const accountUserId = Number(data.accountUserId)
    if (!Number.isSafeInteger(accountUserId) || accountUserId <= 0) {
      throw new ApiError(400, '请选择 Signal 计费商户', 'SIGNAL_ACCOUNT_REQUIRED')
    }
    const mode = String(data.workorderMode || 'failures').toLowerCase()
    if (!WORKORDER_MODES.has(mode)) {
      throw new ApiError(400, 'Signal 工单模式不合法', 'SIGNAL_WORKORDER_MODE_BAD')
    }
    const session = await this.repo.sessionAccount(`main:${accountUserId}`)
    if (!session || Number(session.account.status) !== 1 || Number(session.parent.status) !== 1) {
      throw new ApiError(400, 'Signal 计费商户不可用', 'SIGNAL_ACCOUNT_INVALID')
    }
    const engineId = text(data.engineId, 64)
    const engineState = await this.core.engines(session)
    if (!engineState.rows.some(item => item.allowed && item.enabled && !item.retired)) {
      throw new ApiError(
        400,
        '该商户当前没有已接通可用的翻译通道',
        'SIGNAL_ACCOUNT_NO_ENGINE'
      )
    }
    if (engineId) {
      const engine = engineState.rows.find(item =>
        item.id === engineId && item.allowed && !item.retired
      )
      if (!engine) {
        throw new ApiError(
          400,
          '所选翻译通道不在该商户当前套餐内或尚未接通',
          'SIGNAL_ENGINE_INVALID'
        )
      }
    }

    const current = (await this.repo.query(
      'SELECT * FROM signal_integration_settings WHERE id=1'
    )).rows[0] || {}
    const rotateApi = data.rotateApiToken === true
    const rotateEvent = data.rotateEventToken === true
    const api = rotateApi ? createToken() : null
    const event = rotateEvent ? createToken() : null
    const apiHash = api ? api.hash : current.api_token_hash
    const eventHash = event ? event.hash : current.event_token_hash
    if (enabled && (!apiHash || !eventHash)) {
      throw new ApiError(
        400,
        '启用 Signal 对接前必须生成 API Token 和事件 Token',
        'SIGNAL_TOKENS_REQUIRED'
      )
    }

    await this.repo.query(
      `UPDATE signal_integration_settings
       SET enabled=$1,
           account_user_id=$2,
           account_username=$3,
           api_token_hash=$4,
           api_token_prefix=$5,
           event_token_hash=$6,
           event_token_prefix=$7,
           engine_id=$8,
           workorder_mode=$9,
           updated_by=$10,
           updated_at=NOW()
       WHERE id=1`,
      [
        enabled,
        accountUserId,
        session.parent.username || '',
        apiHash || null,
        api ? api.prefix : current.api_token_prefix || '',
        eventHash || null,
        event ? event.prefix : current.event_token_prefix || '',
        engineId,
        mode,
        admin && admin.id ? admin.id : null
      ]
    )
    await this.repo.audit(
      null,
      admin,
      'Signal 对接配置',
      `${session.parent.username || accountUserId} · ${enabled ? '启用' : '关闭'} · ${mode}`,
      ip,
      { type: 'settings' }
    )
    return {
      state: await this.adminState(),
      apiToken: api ? api.value : null,
      eventToken: event ? event.value : null
    }
  }

  async translate(req, data, idempotencyKey) {
    const auth = await this.authenticate(req, 'api')
    await this.enforceRateLimit('translate-ip', req.ip || 'unknown', 240)
    await this.enforceRateLimit('translate-token', auth.tokenHash, 120)
    const request = normalizeTranslateRequest(data)
    const key = text(idempotencyKey, 200)
    if (!key) {
      throw new ApiError(400, '缺少有效的 Idempotency-Key', 'IDEMPOTENCY_KEY_REQUIRED')
    }
    const result = await this.core.translate(auth.session, {
      text: request.text,
      from: request.sourceLanguage,
      to: request.targetLanguage,
      requestId: request.messageId || key,
      engine: auth.config.engineId || undefined,
      trigger: 'integration'
    }, key)
    const skipped = Boolean(result.skipped)
    return {
      translation: skipped ? '' : String(result.translation || ''),
      targetLanguage: request.targetLanguage,
      detectedSourceLanguage: String(result.from || request.sourceLanguage),
      skipped,
      providerRequestId: key,
      model: String(result.model || '')
    }
  }

  async createTicket(client, session, event, mode) {
    const shouldCreate = mode === 'all' || (mode === 'failures' && event.status === 'error')
    if (!shouldCreate) return null
    const subject = event.status === 'error'
      ? `Signal 翻译失败 · ${event.reason || 'unknown-error'}`
      : 'Signal 翻译完成'
    const inserted = await client.query(
      `INSERT INTO tickets(
         user_id,username,submitter_kind,submitter_name,subject,category,priority,status,
         admin_unread,user_unread,last_reply_at
       ) VALUES($1,$2,'main','signal-integration',$3,'translation',$4,'new',true,false,NOW())
       RETURNING id`,
      [
        session.parent.id,
        session.parent.username || '',
        subject.slice(0, 200),
        event.status === 'error' ? 'medium' : 'low'
      ]
    )
    const ticketId = Number(inserted.rows[0].id)
    const body = [
      'Signal Desktop 自动事件',
      `eventId=${event.eventId}`,
      `messageId=${event.messageId || '-'}`,
      `provider=${event.provider}`,
      `model=${event.model}`,
      `targetLanguage=${event.targetLanguage}`,
      `status=${event.status}`,
      `reason=${event.reason || '-'}`,
      `cacheHit=${event.cacheHit}`,
      `durationMs=${event.durationMs}`,
      `sourceLength=${event.sourceLength}`,
      `translatedLength=${event.translatedLength == null ? '-' : event.translatedLength}`
    ].join('\n')
    await client.query(
      `INSERT INTO ticket_messages(ticket_id,author_type,author_name,body,internal)
       VALUES($1,'system','Signal 对接',$2,false)`,
      [ticketId, body]
    )
    return ticketId
  }

  async ingestEvent(req, data) {
    const auth = await this.authenticate(req, 'event')
    await this.enforceRateLimit('event-ip', req.ip || 'unknown', 240)
    await this.enforceRateLimit('event-token', auth.tokenHash, 120)
    const event = normalizeEvent(data)
    const result = await this.repo.transaction(async client => {
      const inserted = await client.query(
        `INSERT INTO signal_translation_events(
           user_id,username,schema_version,kind,event_id,occurred_at,message_id,provider,model,
           target_language,status,reason,cache_hit,duration_ms,source_length,translated_length,
           source_text_hmac,translated_text_hmac,payload
         ) VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb
         )
         ON CONFLICT (event_id) DO NOTHING
         RETURNING id`,
        [
          auth.session.parent.id,
          auth.session.parent.username || '',
          event.schemaVersion,
          event.kind,
          event.eventId,
          event.occurredAt,
          event.messageId,
          event.provider,
          event.model,
          event.targetLanguage,
          event.status,
          event.reason,
          event.cacheHit,
          event.durationMs,
          event.sourceLength,
          event.translatedLength,
          event.sourceTextHmac,
          event.translatedTextHmac,
          JSON.stringify(event)
        ]
      )
      if (!inserted.rows.length) {
        const existing = await client.query(
          `SELECT id,ticket_id FROM signal_translation_events WHERE event_id=$1`,
          [event.eventId]
        )
        return {
          duplicate: true,
          eventRowId: Number(existing.rows[0].id),
          ticketId: existing.rows[0].ticket_id == null ? null : Number(existing.rows[0].ticket_id)
        }
      }
      const eventRowId = Number(inserted.rows[0].id)
      const ticketId = await this.createTicket(
        client, auth.session, event, auth.config.mode
      )
      if (ticketId) {
        await client.query(
          'UPDATE signal_translation_events SET ticket_id=$2 WHERE id=$1',
          [eventRowId, ticketId]
        )
      }
      return { duplicate: false, eventRowId, ticketId }
    })
    return Object.assign({ accepted: true }, result)
  }
}

module.exports = {
  SignalIntegrationService,
  normalizeEvent,
  normalizeTranslateRequest,
  openApiError
}
