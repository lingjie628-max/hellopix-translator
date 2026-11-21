'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { ApiError } = require('../server/lib/http')
const {
  SignalIntegrationService,
  normalizeEvent,
  normalizeTranslateRequest,
  openApiError
} = require('../server/services/signal-integration-service')

function setEnv(t) {
  const names = [
    'PIX_SIGNAL_API_TOKEN',
    'PIX_SIGNAL_EVENT_TOKEN',
    'PIX_SIGNAL_ACCOUNT_USERNAME',
    'PIX_SIGNAL_WORKORDER_MODE'
  ]
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]))
  process.env.PIX_SIGNAL_API_TOKEN = 'api-token-test'
  process.env.PIX_SIGNAL_EVENT_TOKEN = 'event-token-test'
  process.env.PIX_SIGNAL_ACCOUNT_USERNAME = 'signal-account'
  process.env.PIX_SIGNAL_WORKORDER_MODE = 'failures'
  t.after(() => {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name]
      else process.env[name] = before[name]
    }
  })
}

function session() {
  return {
    kind: 'main',
    account: { id: 1, username: 'signal-account', status: 1 },
    parent: { id: 1, username: 'signal-account', status: 1 }
  }
}

function req(token) {
  return {
    ip: '127.0.0.1',
    headers: { authorization: `Bearer ${token}` }
  }
}

test('Signal 翻译请求严格校验 OpenAPI 字段与长度', () => {
  assert.deepEqual(normalizeTranslateRequest({
    messageId: 'm1',
    sourceLanguage: 'auto',
    targetLanguage: 'zh-CN',
    text: 'hello'
  }), {
    messageId: 'm1',
    sourceLanguage: 'auto',
    targetLanguage: 'zh-CN',
    text: 'hello'
  })
  assert.throws(
    () => normalizeTranslateRequest({ targetLanguage: 'zh-CN', text: 'x', extra: true }),
    error => error.code === 'SIGNAL_TRANSLATE_UNKNOWN_FIELD'
  )
  assert.throws(
    () => normalizeTranslateRequest({ targetLanguage: 'zh-CN', text: 'x'.repeat(12001) }),
    error => error.code === 'TEXT_TOO_LONG'
  )
})

test('Signal 工单事件不接受原文、译文或未知字段', () => {
  assert.throws(
    () => normalizeEvent({
      schemaVersion: 1,
      kind: 'translation.completed',
      eventId: 'e1',
      occurredAt: new Date().toISOString(),
      provider: 'ollama',
      model: 'qwen',
      targetLanguage: 'zh-CN',
      status: 'success',
      cacheHit: false,
      durationMs: 10,
      sourceLength: 5,
      text: 'secret'
    }),
    error => error.code === 'SIGNAL_EVENT_UNKNOWN_FIELD'
  )
})

test('Signal 对外错误码稳定映射', () => {
  assert.deepEqual(openApiError(new ApiError(401, 'bad token', 'SIGNAL_AUTH_FAILED'), 'r1').body, {
    error: {
      code: 'auth-failed',
      message: 'bad token',
      retryable: false,
      providerRequestId: 'r1'
    }
  })
  assert.equal(openApiError(new ApiError(429, 'slow', 'SIGNAL_RATE_LIMITED')).body.error.code, 'rate-limited')
  assert.equal(openApiError(new ApiError(504, 'slow upstream', 'UPSTREAM_TIMEOUT')).body.error.code, 'timeout')
  assert.equal(openApiError(new ApiError(503, 'down', 'UPSTREAM_FAILED')).body.error.code, 'service-unavailable')
  assert.equal(openApiError(Object.assign(new Error('bad json'), {
    status: 400,
    type: 'entity.parse.failed'
  })).body.error.code, 'invalid-request')
})

test('Signal Provider API 成功、跳过、鉴权失败和限流', async t => {
  setEnv(t)
  let redisCount = 0
  const service = new SignalIntegrationService({
    repo: {
      async accountByUsername() { return { id: 1, username: 'signal-account', status: 1, kind: 'main' } },
      async sessionAccount() { return session() }
    },
    redis: {
      async incr() { redisCount += 1; return redisCount },
      async pexpire() { return 1 }
    },
    core: {
      async translate(_session, data, key) {
        if (data.text === 'same') {
          return { success: true, translation: '', skipped: 'unchanged', from: 'zh-CN', model: 'qwen' }
        }
        assert.equal(key, 'idem-1')
        assert.equal(data.to, 'zh-CN')
        return { success: true, translation: '你好', from: 'en', model: 'qwen' }
      }
    }
  })
  const ok = await service.translate(req('api-token-test'), {
    messageId: 'm1',
    sourceLanguage: 'auto',
    targetLanguage: 'zh-CN',
    text: 'hello'
  }, 'idem-1')
  assert.equal(ok.translation, '你好')
  assert.equal(ok.providerRequestId, 'idem-1')

  const skipped = await service.translate(req('api-token-test'), {
    targetLanguage: 'zh-CN',
    text: 'same'
  }, 'idem-2')
  assert.equal(skipped.skipped, true)
  assert.equal(skipped.translation, '')

  await assert.rejects(
    () => service.translate(req('wrong-token'), {
      targetLanguage: 'zh-CN',
      text: 'hello'
    }, 'idem-3'),
    error => error.code === 'SIGNAL_AUTH_FAILED'
  )

  redisCount = 121
  await assert.rejects(
    () => service.translate(req('api-token-test'), {
      targetLanguage: 'zh-CN',
      text: 'hello'
    }, 'idem-4'),
    error => error.code === 'SIGNAL_RATE_LIMITED'
  )
})

const databaseUrl = process.env.PIX_TEST_DATABASE_URL

test('Signal Webhook 幂等落库，失败自动建脱敏工单', { skip: !databaseUrl }, async t => {
  setEnv(t)
  process.env.DATABASE_URL = databaseUrl
  const { Pool } = require('pg')
  const { ProductionRepository } = require('../server/repositories/production-repository')
  const pool = new Pool({ connectionString: databaseUrl, max: 5 })
  const repo = new ProductionRepository(pool)
  const username = `signal_${process.pid}_${Date.now()}`
  const user = (await pool.query(
    `INSERT INTO users(username,password_hash,nickname,status)
     VALUES($1,'scrypt$s$h',$1,1) RETURNING id`,
    [username]
  )).rows[0]
  process.env.PIX_SIGNAL_ACCOUNT_USERNAME = username
  const service = new SignalIntegrationService({
    repo,
    redis: { async incr() { return 1 }, async pexpire() { return 1 } },
    core: {}
  })
  t.after(async () => {
    await pool.query(
      'DELETE FROM ticket_messages WHERE ticket_id IN (SELECT ticket_id FROM signal_translation_events WHERE user_id=$1 AND ticket_id IS NOT NULL)',
      [user.id]
    ).catch(() => {})
    await pool.query('DELETE FROM tickets WHERE user_id=$1', [user.id]).catch(() => {})
    await pool.query('DELETE FROM signal_translation_events WHERE user_id=$1', [user.id]).catch(() => {})
    await pool.query('DELETE FROM users WHERE id=$1', [user.id]).catch(() => {})
    await pool.end()
  })
  const base = {
    schemaVersion: 1,
    kind: 'translation.completed',
    occurredAt: new Date().toISOString(),
    provider: 'ollama',
    model: 'qwen2.5:1.5b',
    targetLanguage: 'zh-CN',
    cacheHit: false,
    durationMs: 20,
    sourceLength: 30,
    translatedLength: 10
  }
  const good = await service.ingestEvent(
    req('event-token-test'),
    Object.assign({}, base, { eventId: 'event-success-1', messageId: 'msg-1', status: 'success' })
  )
  assert.equal(good.accepted, true)
  assert.equal(good.duplicate, false)
  assert.equal(good.ticketId, null)
  const duplicate = await service.ingestEvent(
    req('event-token-test'),
    Object.assign({}, base, { eventId: 'event-success-1', messageId: 'msg-1', status: 'success' })
  )
  assert.equal(duplicate.duplicate, true)

  const failed = await service.ingestEvent(
    req('event-token-test'),
    Object.assign({}, base, {
      eventId: 'event-error-1',
      messageId: 'msg-2',
      status: 'error',
      reason: 'timeout'
    })
  )
  assert.ok(failed.ticketId)
  const stored = await pool.query(
    `SELECT e.payload,e.ticket_id,t.subject,m.body
     FROM signal_translation_events e
     JOIN tickets t ON t.id=e.ticket_id
     JOIN ticket_messages m ON m.ticket_id=t.id
     WHERE e.event_id='event-error-1'`
  )
  assert.equal(stored.rows.length, 1)
  assert.equal(stored.rows[0].subject, 'Signal 翻译失败 · timeout')
  const serialized = JSON.stringify(stored.rows[0])
  assert.doesNotMatch(serialized, /原文|译文正文|Bearer|event-token-test|api-token-test/)
})
