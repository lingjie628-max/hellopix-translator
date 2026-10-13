/**
 * Telegram Web A 的接收翻译：真 guest-inject.js 装进 JSDOM 跑完整链路。
 *
 * 0.1.25 之前收消息的判定写死了 WhatsApp 的结构（#main / [data-id] / .selectable-text），
 * 内嵌 Telegram 里：私聊照样调翻译扣费，但译文永远画不上去；群聊手动模式连「译」按钮都没有。
 * 这里锁住：扣费 ⇒ 必须画出来；手动群聊 ⇒ 只给按钮、不扣费。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const guestSrc = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'guest-inject.js'), 'utf8')

const TG_HTML = `<div id="Main"><div id="MiddleColumn">
<div class="ChatInfo"><div class="info"><h3>Alice</h3><span class="status">last seen recently</span></div></div>
<div class="MessageList"><div class="messages-container"><div class="message-date-group">
<div id="message-101" class="Message message-list-item first-in-group allow-selection shown" data-message-id="101">
  <div class="message-content-wrapper"><div class="message-content text has-shadow">
    <div class="content-inner" dir="auto"><div class="text-content clearfix with-meta" dir="auto">Hello, how are you today?<span class="MessageMeta"><span class="message-time">10:21</span></span></div></div>
  </div></div>
</div>
</div></div></div>
<div class="Composer"><div id="editable-message-text" contenteditable="true" role="textbox"></div></div>
</div></div>`

function mount (url, prefsOverride) {
  const dom = new JSDOM('<!doctype html><body>' + TG_HTML + '</body>', {
    runScripts: 'outside-only', pretendToBeVisual: true, url
  })
  const win = dom.window
  win.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 })
  const prefs = Object.assign({
    transRecv: true, transSend: true, transGroup: false,
    langMine: 'zh', langOther: 'auto', sendTo: 'en', includeZh: false
  }, prefsOverride)
  const calls = []
  win.require = () => ({
    ipcRenderer: {
      invoke: (ch, p) => {
        if (ch === 'translate:guestPrefs') return Promise.resolve(prefs)
        if (ch === 'translate:run') { calls.push(p); return Promise.resolve({ success: true, translation: '你好，今天怎么样？' }) }
        return Promise.resolve({ success: true })
      },
      on: () => {},
      removeAllListeners: () => {}
    }
  })
  win.console.info = () => {}
  win.console.log = () => {}
  win.eval(guestSrc)
  return { win, doc: win.document, calls, close: () => win.close() }
}

async function waitFor (fn, ms) {
  const end = Date.now() + (ms || 3000)
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise(r => setTimeout(r, 30))
  }
  return fn()
}

test('Telegram 私聊：自动翻译调用了 ⇒ 译文必须真的画在那条消息上', async () => {
  const h = mount('https://web.telegram.org/a/#123456789')
  try {
    const painted = await waitFor(() => !!h.doc.querySelector('.pix-trans'))
    assert.equal(h.calls.length, 1, '私聊应自动翻译恰好一次')
    assert.ok(painted, '扣了费却没画出译文（P0 回归）')
    const box = h.doc.querySelector('.pix-trans')
    assert.ok(box.closest('.Message[data-message-id="101"]'), '译文没挂在对应的 Telegram 消息行里')
    assert.match(box.textContent, /你好/)
  } finally { h.close() }
})

test('Telegram 群聊 + 手动：不扣费，只给「译」按钮', async () => {
  const h = mount('https://web.telegram.org/a/#-1001234567890')
  try {
    const chip = await waitFor(() => !!h.doc.querySelector('.pix-click'))
    assert.ok(chip, '群聊手动模式没有渲染「译」按钮')
    assert.equal(h.calls.length, 0, '群聊手动模式不应自动调翻译')
    assert.ok(!h.doc.querySelector('.pix-trans'), '群聊手动模式不应出现译文')
    assert.ok(h.doc.querySelector('.pix-click').closest('.Message[data-message-id]'),
      '「译」按钮没挂在 Telegram 消息行里')
  } finally { h.close() }
})

test('平台判定：web.telegram.org 用 Telegram 结构，其余（WhatsApp）保持原结构', () => {
  const begin = guestSrc.indexOf('// ==== SITE ADAPTERS BEGIN ====')
  const end = guestSrc.indexOf('// ==== SITE ADAPTERS END ====')
  assert.ok(begin > 0 && end > begin, 'SITE ADAPTERS 标记被删了')
  const load = hostname => new Function('location', guestSrc.slice(begin, end) + '\nreturn SITE')({ hostname })
  const tg = load('web.telegram.org')
  assert.equal(tg.id, 'telegram')
  assert.equal(tg.scope, '#MiddleColumn')
  const wa = load('web.whatsapp.com')
  assert.equal(wa.id, 'whatsapp')
  assert.equal(wa.scope, '#main')
  assert.equal(wa.row, '[data-id]')
  assert.equal(wa.keyAttr, 'data-id')
  assert.equal(wa.text, '.selectable-text')
})

test('群聊/私聊判定未经真机验证的平台：私聊也只给按钮，绝不自动扣费', () => {
  const BEGIN = '// ==== MESSAGE PARSER BEGIN ===='
  const END = '// ==== MESSAGE PARSER END ===='
  const MP = new Function(guestSrc.slice(guestSrc.indexOf(BEGIN) + BEGIN.length, guestSrc.indexOf(END)) + '\nreturn MessageParser')()
  const base = { receiveEnabled: true, translatable: true, sameLang: false, group: false, transGroup: true }
  assert.equal(MP.messageAction(base), 'auto', '已验证平台的私聊应自动翻译')
  assert.equal(MP.messageAction(Object.assign({}, base, { chatKindUnverified: true })), 'chip')
  assert.equal(MP.messageAction(Object.assign({}, base, { chatKindUnverified: true, group: true })), 'chip')
  assert.equal(MP.messageAction(Object.assign({}, base, { chatKindUnverified: true, receiveEnabled: false })), 'hide',
    '接收翻译关闭时仍然什么都不显示')
})
