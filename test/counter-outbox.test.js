'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { CounterOutbox } = require('../desktop/src/counter/outbox')

function harness (options) {
  let now = 1000
  let disk = null
  const outbox = new CounterOutbox({
    load: () => disk,
    save: data => { disk = JSON.parse(JSON.stringify(data)) },
    now: () => now,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    maxAttempts: (options && options.maxAttempts) || 3
  })
  return {
    outbox,
    disk: () => disk,
    advance: ms => { now += ms },
    now: () => now
  }
}

function event (suffix) {
  return {
    kind: 'event',
    ownerKey: 'main:alice',
    localTabId: '1:whatsapp-green-1',
    tabId: 'whatsapp-green-1',
    platform: 'whatsapp-green',
    label: '巴西一号',
    payload: {
      sourceMessageId: 'MSG-' + suffix,
      peerKey: '5511@s.whatsapp.net',
      phone: '5511955057471',
      sentAt: '2026-11-16T10:00:00.000Z'
    }
  }
}

test('事件先落盘，成功后移除并保留稳定消息 ID', async () => {
  const h = harness()
  h.outbox.enqueue(event('1'))
  assert.equal(h.disk().items.length, 1)
  assert.equal(h.disk().items[0].payload.sourceMessageId, 'MSG-1')
  const seen = []
  const result = await h.outbox.flush({
    ownerKey: 'main:alice',
    resolve: async item => {
      seen.push(item.payload.sourceMessageId)
      return { status: 'new' }
    }
  })
  assert.deepEqual(result, { sent: 1, failed: 0, skipped: 0, pending: 0 })
  assert.deepEqual(seen, ['MSG-1'])
  assert.equal(h.disk().items.length, 0)
})

test('同一消息重复入队只保留一条，失败后指数退避', async () => {
  const h = harness()
  h.outbox.enqueue(event('same'))
  h.outbox.enqueue(event('same'))
  assert.equal(h.outbox.status('main:alice').pending, 1)

  const first = await h.outbox.flush({
    ownerKey: 'main:alice',
    resolve: async () => { throw new Error('断网') }
  })
  assert.equal(first.failed, 1)
  assert.equal(h.disk().items[0].attempts, 1)
  assert.equal(h.outbox.status('main:alice').lastError, '断网')

  h.advance(99)
  await h.outbox.flush({ ownerKey: 'main:alice', resolve: async () => ({ status: 'new' }) })
  assert.equal(h.outbox.status('main:alice').pending, 1, '退避时间未到现在不能重试')

  h.advance(101)
  const recovered = await h.outbox.flush({
    ownerKey: 'main:alice',
    resolve: async () => ({ status: 'new' })
  })
  assert.equal(recovered.sent, 1)
})

test('归档命令必须排在同实例的待传事件之后', async () => {
  const h = harness()
  h.outbox.enqueue(event('before-archive'))
  h.outbox.enqueue({
    kind: 'archive',
    ownerKey: 'main:alice',
    localTabId: '1:whatsapp-green-1',
    tabId: 'whatsapp-green-1'
  })
  let rejectEvent = true
  const order = []
  await h.outbox.flush({
    ownerKey: 'main:alice',
    resolve: async item => {
      order.push(item.kind)
      if (item.kind === 'event' && rejectEvent) throw new Error('暂时断网')
      return { ok: true }
    }
  })
  assert.deepEqual(order, ['event'], '事件尚未成功时不能先归档账号')

  rejectEvent = false
  h.advance(200)
  await h.outbox.flush({
    ownerKey: 'main:alice',
    resolve: async item => {
      order.push(item.kind)
      return { ok: true }
    }
  })
  assert.deepEqual(order, ['event', 'event', 'archive'])
})

test('只处理当前登录主账号的队列，不把 A 的进粉记到 B', async () => {
  const h = harness()
  h.outbox.enqueue(event('alice'))
  const bob = event('bob')
  bob.ownerKey = 'main:bob'
  h.outbox.enqueue(bob)
  const seen = []
  await h.outbox.flush({
    ownerKey: 'main:bob',
    resolve: async item => {
      seen.push(item.payload.sourceMessageId)
      return { status: 'new' }
    }
  })
  assert.deepEqual(seen, ['MSG-bob'])
  assert.equal(h.outbox.status('main:alice').pending, 1)
})

test('永久错误和达到重试上限都会进入失败区，可人工重试', async () => {
  const h = harness({ maxAttempts: 2 })
  h.outbox.enqueue(event('bad'))
  const permanent = new Error('事件字段不合法')
  permanent.permanent = true
  await h.outbox.flush({
    ownerKey: 'main:alice',
    resolve: async () => { throw permanent }
  })
  assert.equal(h.outbox.status('main:alice').failed, 1)
  assert.equal(h.outbox.retryFailed('main:alice'), 1)
  assert.equal(h.outbox.status('main:alice').pending, 1)
})
