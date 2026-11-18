'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { JSDOM } = require('jsdom')
const {
  buildWhatsAppCounterObserverScript
} = require('../desktop/src/translate/whatsapp-counter-observer')

function collectionHarness () {
  const handlers = new Map()
  return {
    models: [],
    on (name, fn) {
      const list = handlers.get(name) || []
      list.push(fn)
      handlers.set(name, list)
    },
    off (name, fn) {
      handlers.set(name, (handlers.get(name) || []).filter(item => item !== fn))
    },
    emit (name, value) {
      for (const fn of handlers.get(name) || []) fn(value)
    },
    handlers
  }
}

async function makeDom () {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://web.whatsapp.com/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  })
  const win = dom.window
  const messages = collectionHarness()
  win.requireLazy = (names, callback) => {
    if (names[0] === 'WAWebMsgCollection') {
      callback({ MsgCollection: messages })
      return 1
    }
    return 0
  }
  const posted = []
  win.addEventListener('message', event => {
    if (event.data && event.data.channel === 'counter:inbound') posted.push(event.data.payload)
  })
  win.eval(buildWhatsAppCounterObserverScript({ testMode: true }))
  await new Promise(resolve => win.setTimeout(resolve, 20))
  return { dom, win, messages, posted }
}

test('counter observer script syntax and WhatsApp-only guard', () => {
  const src = buildWhatsAppCounterObserverScript()
  assert.doesNotThrow(() => new Function(src))
  assert.match(src, /web\.whatsapp\.com/)
})

test('后台私聊事件输出身份骨架，不输出聊天正文', async () => {
  const { dom, win, messages, posted } = await makeDom()
  try {
    assert.equal(win.__pixCounterObserverStatus().ready, true)
    messages.emit('add', {
      id: { id: 'MSG-1', remote: '5511955057471@s.whatsapp.net', fromMe: false },
      from: '5511955057471@s.whatsapp.net',
      type: 'chat',
      t: Math.floor(Date.now() / 1000),
      notifyName: 'Ana',
      body: 'this body must never be forwarded'
    })
    await new Promise(resolve => win.setTimeout(resolve, 0))

    assert.equal(posted.length, 1)
    assert.equal(posted[0].sourceMessageId, 'in:5511955057471@s.whatsapp.net:MSG-1')
    assert.equal(posted[0].phone, '5511955057471')
    assert.equal(posted[0].peerKey, '5511955057471@s.whatsapp.net')
    assert.equal(posted[0].messageType, 'chat')
    assert.equal(posted[0].pushName, 'Ana')
    assert.equal(Object.prototype.hasOwnProperty.call(posted[0], 'body'), false)
  } finally {
    dom.window.close()
  }
})

test('本人、群聊和同会话后续消息不重复上报', async () => {
  const { dom, win, messages, posted } = await makeDom()
  try {
    const now = Math.floor(Date.now() / 1000)
    messages.emit('add', {
      id: { id: 'SELF', remote: '5511@s.whatsapp.net', fromMe: true },
      from: '5511@s.whatsapp.net',
      fromMe: true,
      type: 'chat',
      t: now
    })
    messages.emit('add', {
      id: { id: 'GROUP', remote: '123@g.us', fromMe: false },
      from: '123@g.us',
      type: 'chat',
      t: now
    })
    messages.emit('add', {
      id: { id: 'ONE', remote: '5522@s.whatsapp.net', fromMe: false },
      from: '5522@s.whatsapp.net',
      type: 'image',
      t: now
    })
    messages.emit('add', {
      id: { id: 'TWO', remote: '5522@s.whatsapp.net', fromMe: false },
      from: '5522@s.whatsapp.net',
      type: 'chat',
      t: now + 1
    })
    await new Promise(resolve => win.setTimeout(resolve, 0))

    assert.equal(posted.length, 1)
    assert.equal(posted[0].sourceMessageId, 'in:5522@s.whatsapp.net:ONE')
    assert.equal(win.__pixCounterObserverStatus().skipped.from_me, 1)
    assert.equal(win.__pixCounterObserverStatus().skipped.group_or_broadcast, 1)
    assert.equal(win.__pixCounterObserverStatus().skipped.peer_already_reported, 1)
  } finally {
    dom.window.close()
  }
})

test('只有 LID 的消息也能进入计数链路', async () => {
  const { dom, win, messages, posted } = await makeDom()
  try {
    messages.emit('add', {
      id: { id: 'LID-1', remote: '123456789012345@lid', fromMe: false },
      from: '123456789012345@lid',
      type: 'chat',
      t: Math.floor(Date.now() / 1000)
    })
    await new Promise(resolve => win.setTimeout(resolve, 0))
    assert.equal(posted.length, 1)
    assert.equal(posted[0].phone, '')
    assert.equal(posted[0].whatsappLid, 'lid:123456789012345')
  } finally {
    dom.window.close()
  }
})

test('显式 isNewMsg 的离线补收消息不能被当成历史回放丢弃', async () => {
  const { dom, win, messages, posted } = await makeDom()
  try {
    messages.emit('add', {
      id: { id: 'OFFLINE-NEW', remote: '5533@s.whatsapp.net', fromMe: false },
      from: '5533@s.whatsapp.net',
      type: 'chat',
      isNewMsg: true,
      t: Math.floor(Date.now() / 1000) - 1800
    })
    await new Promise(resolve => win.setTimeout(resolve, 0))
    assert.equal(posted.length, 1)
    assert.equal(posted[0].sourceMessageId, 'in:5533@s.whatsapp.net:OFFLINE-NEW')
    assert.equal(win.__pixCounterObserverStatus().skipped.historical_replay || 0, 0)
  } finally {
    dom.window.close()
  }
})

test('没有实时标记的旧消息仍按历史回补拦截', async () => {
  const { dom, win, messages, posted } = await makeDom()
  try {
    messages.emit('add', {
      id: { id: 'OLD-HISTORY', remote: '5544@s.whatsapp.net', fromMe: false },
      from: '5544@s.whatsapp.net',
      type: 'chat',
      t: Math.floor(Date.now() / 1000) - 1800
    })
    await new Promise(resolve => win.setTimeout(resolve, 0))
    assert.equal(posted.length, 0)
    assert.equal(win.__pixCounterObserverStatus().skipped.historical_replay, 1)
  } finally {
    dom.window.close()
  }
})
