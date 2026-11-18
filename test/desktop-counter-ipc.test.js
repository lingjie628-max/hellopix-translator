'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { registerCounterIpc } = require('../desktop/src/ipc/counter')
const { CounterOutbox } = require('../desktop/src/counter/outbox')

function harness (options) {
  const handlers = {}
  const unsafe = new Set()
  const calls = []
  const updates = []
  let disk = null
  let offline = !!(options && options.offline)
  const tab = {
    id: 'whatsapp-green-3',
    partition: 'persist:slot1-wa3',
    platform: 'whatsapp-green',
    name: '巴西看群',
    settings: { enableCounter: !options || options.enabled !== false }
  }
  const outbox = new CounterOutbox({
    load: () => disk,
    save: value => { disk = JSON.parse(JSON.stringify(value)) },
    baseDelayMs: 1,
    maxDelayMs: 2
  })
  const controller = registerCounterIpc({
    reg: {
      handle: (name, fn) => { handlers[name] = fn },
      handleUnsafe: (name, fn) => { handlers[name] = fn; unsafe.add(name) }
    },
    outbox,
    state: { tabs: [tab] },
    actions: {
      trustedTabSender: sender => sender && sender.trusted ? tab : null,
      api: async (pathname, opts) => {
        calls.push({ pathname, opts })
        if (offline && pathname === '/counter/inbound') {
          const error = new Error('网络不可达')
          error.code = 'NETWORK_UNREACHABLE'
          throw error
        }
        if (pathname === '/counter/accounts/register') {
          return { id: 91, label: tab.name }
        }
        if (pathname.startsWith('/counter/accounts?')) {
          return [{ id: 91, local_tab_id: '1:whatsapp-green-3' }]
        }
        return { status: 'new', ticketId: 88 }
      },
      ownerKey: () => 'main:tester',
      updateTabSettings: async (id, patch) => {
        updates.push({ id, patch })
        tab.settings = Object.assign({}, tab.settings, patch)
        return { success: true }
      },
      sendToMain: () => {},
      log: () => {}
    },
    env: {
      slot: () => '1',
      qs: query => new URLSearchParams(query || {}).toString(),
      outbox: {
        load: () => disk,
        save: value => { disk = JSON.parse(JSON.stringify(value)) }
      }
    }
  })
  return {
    handlers,
    unsafe,
    calls,
    updates,
    tab,
    outbox,
    controller,
    setOffline: value => { offline = !!value },
    disk: () => disk
  }
}

test('counter:candidate is an explicit guest channel', () => {
  const { unsafe } = harness()
  assert.equal(unsafe.has('counter:candidate'), true)
})

test('counter candidate rejects untrusted sender before any API call', async () => {
  const { handlers, calls } = harness()
  const result = await handlers['counter:candidate'](
    { sender: { trusted: false } },
    { sourceMessageId: 'M1', peerKey: '5511@s.whatsapp.net', sentAt: new Date().toISOString() }
  )
  assert.equal(result.success, false)
  assert.equal(calls.length, 0)
})

test('disabled counter instances never register or ingest', async () => {
  const { handlers, calls } = harness({ enabled: false })
  const result = await handlers['counter:candidate'](
    { sender: { trusted: true } },
    { sourceMessageId: 'M1', peerKey: '5511@s.whatsapp.net', sentAt: new Date().toISOString() }
  )
  assert.deepEqual(result, { success: true, status: 'ignored', reason: 'counter_disabled' })
  assert.equal(calls.length, 0)
})

test('trusted counter event gets trusted platform/account attribution', async () => {
  const h = harness()
  const { handlers, calls, tab } = h
  const result = await handlers['counter:candidate'](
    { sender: { trusted: true } },
    {
      sourceMessageId: 'M1',
      peerKey: '5511955057471@s.whatsapp.net',
      phone: '5511955057471',
      sentAt: new Date().toISOString(),
      day: '2026-11-16',
      platform: 'FORGED',
      counterAccountId: 999
    }
  )
  assert.equal(result.success, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].opts.form.localTabId, '1:whatsapp-green-3')
  assert.equal(calls[0].opts.form.platform, tab.platform)
  assert.equal(calls[1].pathname, '/counter/inbound')
  assert.equal(calls[1].opts.form.counterAccountId, 91)
  assert.equal(calls[1].opts.form.platform, tab.platform)
  assert.equal(h.disk().items.length, 0)
  h.controller.stop()
})

test('dashboard channels use main renderer guards and query encoding', async () => {
  const h = harness()
  const { handlers, calls } = h
  const result = await handlers['counter:events']({}, { from: '2026-11-16', kind: 'new' })
  assert.equal(result.status, 'new')
  assert.equal(calls[0].pathname, '/counter/events?from=2026-11-16&kind=new')
  h.controller.stop()
})

test('断网时事件留在本地，恢复后用同一消息 ID 重试', async () => {
  const h = harness({ offline: true })
  assert.equal((await h.handlers['counter:candidate'](
    { sender: { trusted: true } },
    {
      sourceMessageId: 'OFFLINE-1',
      peerKey: '5511955057471@s.whatsapp.net',
      phone: '5511955057471',
      sentAt: new Date().toISOString()
    }
  )).pending, 1)
  assert.equal(h.outbox.status('main:tester').pending, 1)
  assert.equal(h.disk().items[0].payload.sourceMessageId, 'OFFLINE-1')

  h.calls.length = 0
  h.setOffline(false)
  const retry = await h.handlers['counter:retryFailed']()
  assert.equal(retry.success, true)
  assert.equal(h.outbox.status('main:tester').pending, 0)
  assert.equal(h.calls.find(call => call.pathname === '/counter/inbound').opts.requestId, 'OFFLINE-1')
  h.controller.stop()
})

test('进粉中心开关通过主进程更新实例设置并登记/归档账号', async () => {
  const h = harness()
  const disabled = await h.handlers['counter:toggleTab']({}, { id: h.tab.id, enabled: false })
  assert.equal(disabled.success, true)
  assert.deepEqual(h.updates.at(-1), { id: h.tab.id, patch: { enableCounter: false } })
  assert.ok(h.calls.some(call => call.pathname === '/counter/accounts/archive'))

  const enabled = await h.handlers['counter:toggleTab']({}, { id: h.tab.id, enabled: true })
  assert.equal(enabled.success, true)
  assert.deepEqual(h.updates.at(-1), { id: h.tab.id, patch: { enableCounter: true } })
  h.controller.stop()
})
