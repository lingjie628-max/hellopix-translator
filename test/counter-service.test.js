'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.join(__dirname, '..')
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const { CounterService, classifyFan, ticketCode } = require('../server/services/counter-service')

test('进粉分类：账号已见 > 主账号历史 > 新粉', () => {
  assert.equal(classifyFan({ seenOnAccount: true, seenInWorkspace: true }), 'duplicate')
  assert.equal(classifyFan({ seenOnAccount: true, seenInWorkspace: false }), 'duplicate')
  assert.equal(classifyFan({ seenOnAccount: false, seenInWorkspace: true }), 'repeat')
  assert.equal(classifyFan({ seenOnAccount: false, seenInWorkspace: false }), 'new')
})

test('进粉工单编号稳定且按事件唯一', () => {
  assert.equal(ticketCode('2026-11-16', 73), 'IT-20261116-73')
  assert.notEqual(ticketCode('2026-11-16', 73), ticketCode('2026-11-16', 74))
})

test('迁移必须保证账号/客户和账号/消息双重幂等', () => {
  const src = read('migrations/053_counter_integration.js')
  assert.match(src, /UNIQUE \(counter_account_id, customer_id\)/)
  assert.match(src, /UNIQUE \(counter_account_id, source_message_id\)/)
  assert.match(src, /fan_event_id bigint NOT NULL UNIQUE REFERENCES counter_fan_events/)
})

test('判重和建单必须在同一事务内，并对身份指纹加锁', () => {
  const src = read('server/services/counter-service.js')
  assert.match(src, /repo\.transaction\(async client =>/)
  assert.match(src, /pg_advisory_xact_lock/)
  assert.match(src, /INSERT INTO counter_fan_events/)
  assert.match(src, /INSERT INTO counter_tickets/)
  assert.ok(
    src.indexOf('INSERT INTO counter_fan_events') < src.indexOf('INSERT INTO counter_tickets'),
    '必须先落进粉事实，再在同事务里建工单'
  )
})

test('计数接口复用现有会话，不出现邀请码或 CENTRAL_TOKEN', () => {
  const route = read('server/routes/user-counter.js')
  const service = read('server/services/counter-service.js')
  assert.match(route, /req\.pixUser/)
  assert.doesNotMatch(route + service, /CENTRAL_TOKEN|inviteCode|邀请码/)
})

test('归档账号后当前汇总仍排除归档实例，历史流水不删除', () => {
  const src = read('server/services/counter-service.js')
  const archiveAt = src.indexOf('async archiveAccount')
  const archive = src.slice(archiveAt, src.indexOf('async _account', archiveAt))
  assert.match(archive, /archived_at=COALESCE\(archived_at,now\(\)\)/)
  assert.doesNotMatch(archive, /DELETE FROM counter_fan_events/)
  assert.match(src, /`\$\{account\}\.archived_at IS NULL`/)
})

test('进粉流水 JOIN 使用 a 别名时，范围条件也必须使用 a', async () => {
  const calls = []
  const repo = {
    transaction: fn => fn({}),
    query: async () => ({ rows: [] })
  }
  repo.query = async (sql, values) => {
    calls.push({ sql, values: values || [] })
    if (/SELECT e\.id,e\.kind/.test(sql)) return { rows: [] }
    return { rows: [{ total: 0 }] }
  }
  const service = new CounterService(repo)
  const session = {
    kind: 'sub',
    parent: { id: 7 },
    account: { id: 19 },
    securitySession: { deviceId: 'desktop-test' }
  }

  await service.events(session, { from: '2026-11-01' })

  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.match(call.sql, /JOIN counter_accounts a ON a\.id=e\.counter_account_id/)
    assert.match(call.sql, /a\.operator_id=\$3/)
    assert.match(call.sql, /a\.archived_at IS NULL/)
    assert.doesNotMatch(call.sql, /ca\./)
  }
})

test('消息重放返回公开客户号，不泄露内部 customer_id', () => {
  const src = read('server/services/counter-service.js')
  const seen = src.slice(
    src.indexOf('const sourceSeen = await this.repo.query'),
    src.indexOf('const resolved = await this._resolveCustomer', src.indexOf('const sourceSeen = await this.repo.query'))
  )
  assert.match(seen, /c\.public_id AS customer_public_id/)
  assert.match(seen, /customerId: sourceSeen\.rows\[0\]\.customer_public_id/)
  assert.doesNotMatch(seen, /customerId: sourceSeen\.rows\[0\]\.customer_id/)
})
