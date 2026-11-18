'use strict'

process.env.PIX_IDENTITY_KEY = process.env.PIX_IDENTITY_KEY || 'flow-test-key-000000000000000000000000000'

const assert = require('node:assert/strict')
const test = require('node:test')
const { CounterService } = require('../server/services/counter-service')

function session () {
  return {
    kind: 'main',
    parent: { id: 7 },
    account: { id: 7 },
    securitySession: { deviceId: 'desktop-flow-test' }
  }
}

function inbound (suffix) {
  return {
    counterAccountId: 91,
    sourceMessageId: 'in:5511955057471@s.whatsapp.net:MSG-' + suffix,
    peerKey: '5511955057471@s.whatsapp.net',
    phone: '5511955057471',
    pushName: 'Ana',
    messageType: 'chat',
    sentAt: '2026-11-16T10:00:00.000Z',
    day: '2026-11-16'
  }
}

function fakeRepo (options) {
  const state = {
    sourceSeen: !!(options && options.sourceSeen),
    workspaceSeen: !!(options && options.workspaceSeen),
    eventKind: '',
    ticketPriority: '',
    eventColumns: null,
    ticketColumns: null
  }
  const repo = {
    async transaction (fn) {
      return fn({ tx: true })
    },
    async query (sql, values) {
      if (/FROM counter_accounts WHERE/.test(sql)) {
        return { rows: [{ id: 91, platform: 'whatsapp-green', user_id: 7, archived_at: null }] }
      }
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] }
      if (/WHERE e\.counter_account_id=\$1 AND e\.source_message_id=\$2/.test(sql)) {
        return {
          rows: state.sourceSeen
            ? [{ id: 73, customer_id: 42, customer_public_id: 'C_42', ticket_id: 88 }]
            : []
        }
      }
      if (/FROM customer_identities ci/.test(sql)) return { rows: [] }
      if (/INSERT INTO customers/.test(sql)) return { rows: [{ id: 42, public_id: 'C_42' }] }
      if (/INSERT INTO platform_identities/.test(sql)) return { rows: [] }
      if (/INSERT INTO customer_identities/.test(sql)) return { rows: [] }
      if (/INSERT INTO customer_merchant_links/.test(sql)) return { rows: [] }
      if (/UPDATE platform_identities pi/.test(sql)) return { rows: [] }
      if (/WHERE e\.counter_account_id=\$1 AND e\.customer_id=\$2/.test(sql)) return { rows: [] }
      if (/SELECT 1 FROM counter_fan_events WHERE user_id=\$1 AND customer_id=\$2/.test(sql)) {
        return { rows: state.workspaceSeen ? [{ 1: 1 }] : [] }
      }
      if (/INSERT INTO counter_fan_events/.test(sql)) {
        state.eventColumns = sql.replace(/\s+/g, ' ').trim()
        state.eventKind = values[3]
        return {
          rows: [{
            id: 73,
            user_id: 7,
            counter_account_id: 91,
            customer_id: 42,
            kind: values[3],
            source_message_id: values[4],
            first_msg_at: values[9],
            day: values[10]
          }]
        }
      }
      if (/INSERT INTO counter_tickets/.test(sql)) {
        state.ticketColumns = sql.replace(/\s+/g, ' ').trim()
        state.ticketPriority = values[6]
        return {
          rows: [{
            id: 88,
            code: 'IT-20261116-73',
            status: 'open',
            priority: values[6],
            created_at: '2026-11-16T10:00:01.000Z'
          }]
        }
      }
      if (/INSERT INTO counter_ticket_events/.test(sql)) return { rows: [] }
      if (/UPDATE counter_accounts SET last_seen_at/.test(sql)) return { rows: [] }
      if (/FILTER \(WHERE e\.kind='new'\)/.test(sql)) {
        return {
          rows: [{
            today_new: state.eventKind === 'new' ? 1 : 0,
            today_repeat: state.eventKind === 'repeat' ? 1 : 0,
            today_total: 1,
            today_unique: 1
          }]
        }
      }
      throw new Error('未覆盖的 SQL：' + sql.replace(/\s+/g, ' ').slice(0, 160))
    }
  }
  return { repo, state }
}

test('首次进粉：识别为新粉，并与自动工单一同返回', async () => {
  const { repo, state } = fakeRepo()
  const service = new CounterService(repo)
  const result = await service.ingest(session(), inbound('new'))

  assert.equal(result.status, 'new')
  assert.equal(result.eventId, 73)
  assert.equal(result.customerId, 'C_42')
  assert.equal(result.ticketId, 88)
  assert.equal(result.summary.todayNew, 1)
  assert.equal(state.eventKind, 'new')
  assert.equal(state.ticketPriority, 'normal')
  assert.match(state.eventColumns, /source_message_id/)
  assert.doesNotMatch(state.eventColumns, /MSG-new/, '平台消息 ID 不能明文入库')
})

test('同一消息重放：不再建单，返回公开客户号', async () => {
  const { repo } = fakeRepo({ sourceSeen: true })
  const service = new CounterService(repo)
  const result = await service.ingest(session(), inbound('replay'))

  assert.equal(result.status, 'duplicate')
  assert.equal(result.reason, 'source_message_seen')
  assert.equal(result.eventId, 73)
  assert.equal(result.customerId, 'C_42')
  assert.equal(result.ticketId, 88)
})

test('主账号历史见过但当前账号首次见：识别为重粉并提高工单优先级', async () => {
  const { repo, state } = fakeRepo({ workspaceSeen: true })
  const service = new CounterService(repo)
  const result = await service.ingest(session(), inbound('repeat'))

  assert.equal(result.status, 'repeat')
  assert.equal(state.eventKind, 'repeat')
  assert.equal(state.ticketPriority, 'high')
})
