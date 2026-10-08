'use strict'

/**
 * 会话身份守卫 —— 「群组翻译 = 自动」必须真的能自动翻。
 *
 * ## 被修的 P0（macOS 0.1.11 真机取证）
 *
 * 现象：新子账号里手动把「群组翻译」切到**自动**，WhatsApp 群里新消息
 * 却始终不出译文；手动点「译」正常。服务端日志证明客户端**从未发出**
 * `POST /translate/run`（auto 与手动都没有），所以断点在客户端。
 *
 * 根因：`chatIdentity()` 先取 `currentPeer()`，而 `whatsappPeer()` 扫的是
 * **整个 document** 的 `[data-id]`。WhatsApp 左侧会话列表的行也带 `[data-id]`
 * （`@c.us`）且排在 `#main` 之前 → 群聊里身份取到"左侧列表里的某个私聊"。
 * 列表每来消息都会重排 → 身份每轮都变 → `historyGate.begin()` 每轮重置
 * → `ready` 恒为 false → `isHistoric()` 对每条消息都返回 true
 * → `messageAction()` 一律给 `chip` → auto 永不触发。
 *
 * ## 为什么之前 21 条群聊用例全绿
 *
 * `test/group-billing-guard.test.js` 的 harness 是**自己重写的扫描循环**，
 * 且 `gate.begin(o.identity || 'peer-1')` 由调用方**直接传入身份**，真 DOM 里
 * 也**没有左侧列表**。真实 `chatIdentity()` / `whatsappPeer()` 从未被执行过。
 * 本文件用 guest-inject.js 的**真实源码**补上这段。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { JSDOM } = require('jsdom')

const root = path.join(__dirname, '..')
const guest = fs.readFileSync(path.join(root, 'desktop', 'guest-inject.js'), 'utf8')

const BEGIN = '// ==== MESSAGE PARSER BEGIN ===='
const END = '// ==== MESSAGE PARSER END ===='

function loadParser() {
  const beginAt = guest.indexOf(BEGIN)
  const endAt = guest.indexOf(END)
  assert.ok(beginAt > 0 && endAt > beginAt, '解析器 BEGIN/END 标记被删了')
  return new Function(guest.slice(beginAt + BEGIN.length, endAt) + '\nreturn MessageParser')()
}
const MP = loadParser()

/** 按大括号配对，把 guest-inject.js 里的真实函数整段抽出来。 */
function grab(name) {
  const start = guest.indexOf('function ' + name + '(')
  assert.ok(start > 0, '找不到函数 ' + name + '（改名了？）')
  let depth = 0
  let started = false
  for (let i = start; i < guest.length; i++) {
    const c = guest[i]
    if (c === '{') { depth++; started = true } else if (c === '}') {
      depth--
      if (started && depth === 0) return guest.slice(start, i + 1)
    }
  }
  throw new Error('大括号不平衡: ' + name)
}

const SOURCE_FNS = [
  'telegramPeer', 'whatsappPeer', 'conversationScope', 'whatsappConversationKey',
  'currentPeer', 'chatDisplayName', 'chatIdentity', 'isGroupChat'
].map(grab)

/** 在 jsdom 里装配真实函数（document / location 由页面提供）。 */
function mount(document, location, window) {
  return new Function(
    'document', 'location', 'window',
    SOURCE_FNS.join('\n') + '\nreturn { whatsappPeer, whatsappConversationKey, currentPeer, chatIdentity, isGroupChat }'
  )(document, location, window)
}

// ---------------------------------------------------------------------------
// 真 DOM：**带左侧会话列表**的 WhatsApp —— 这正是原用例缺失的那一半
// ---------------------------------------------------------------------------
const META = '<div><span>3:25 PM</span><span data-icon="wds-ic-read">wds-ic-read</span></div>'

/** 左侧会话列表的一行（私聊）。真实 WhatsApp 里它在 #main 之前，且带 data-id。 */
function sidebarRow(jid, name) {
  return '<div role="listitem" data-id="false_' + jid + '_1"><span>' + name + '</span></div>'
}

function groupMsg(body, id) {
  return '<div class="message-in" role="row" data-id="true_' + GROUP_ID + '_' + id + '">' +
    '<div class="copyable-text"><span class="selectable-text copyable-text">' + body + '</span></div></div>'
}

function directMsg(body, id) {
  return '<div class="message-in" role="row" data-id="false_8613800138000@c.us_' + id + '">' +
    '<div class="copyable-text"><span class="selectable-text copyable-text">' + body + '</span></div></div>'
}

const GROUP_ID = '1203630199@g.us'
const GROUP2_ID = '1203630777@g.us'

function page(sideRows, mainRows) {
  const html = '<!doctype html><html><body>' +
    '<div id="side">' + sideRows.join('') + '</div>' +
    '<div id="main"><header><h1>Team Group</h1></header>' + mainRows.join('') + '</div>' +
    '</body></html>'
  const dom = new JSDOM(html, { url: 'https://web.whatsapp.com/' })
  return { dom, api: mount(dom.window.document, dom.window.location, dom.window) }
}

const SIDE_A = [sidebarRow('8613800138000@c.us', 'Alice'), sidebarRow('8613900139000@c.us', 'Bob')]
const SIDE_B = [sidebarRow('8613900139000@c.us', 'Bob'), sidebarRow('8613800138000@c.us', 'Alice')]

// ---------------------------------------------------------------------------

test('群聊里 chatIdentity() 必须是当前会话，不能取左侧列表的私聊', () => {
  const { api } = page(SIDE_A, [groupMsg('hello group', 'M1')])
  assert.equal(api.whatsappConversationKey(), GROUP_ID)
  assert.equal(api.chatIdentity(), 'wa:' + GROUP_ID)
  assert.ok(!String(api.chatIdentity()).includes('@c.us'),
    '身份取到了 @c.us 私聊 —— 正是左侧列表串味的老 bug')
})

test('左侧列表重排，会话身份不变（历史基线不得被反复重置）', () => {
  const a = page(SIDE_A, [groupMsg('hello group', 'M1')]).api
  const b = page(SIDE_B, [groupMsg('hello group', 'M1')]).api
  assert.equal(a.chatIdentity(), b.chatIdentity())
  assert.equal(a.chatIdentity(), 'wa:' + GROUP_ID)
})

test('换了群聊，会话身份必须变（否则上一群的历史登记会漏到新群）', () => {
  const g1 = page(SIDE_A, [groupMsg('hello group', 'M1')]).api
  const g2 = page(SIDE_A, [
    '<div class="message-in" role="row" data-id="true_' + GROUP2_ID + '_X1">' +
    '<div class="copyable-text"><span class="selectable-text copyable-text">another group</span></div></div>'
  ]).api
  assert.notEqual(g1.chatIdentity(), g2.chatIdentity())
})

test('whatsappPeer() 只看 #main：群聊不产出客户身份，也不能把左侧私聊当客户', () => {
  const group = page(SIDE_A, [groupMsg('hello group', 'M1')]).api
  assert.equal(group.whatsappPeer(), null, '群聊不该产出客户身份')

  const direct = page(SIDE_A, [directMsg('hi there', 'D1')]).api
  const peer = direct.whatsappPeer()
  assert.ok(peer, '私聊应能取到客户身份')
  assert.equal(peer.peerKey, '8613800138000@c.us')
})

// ---------------------------------------------------------------------------
// 端到端：把真实 chatIdentity + 真实 historyGate + 真实 messageAction 接起来，
// 复刻 scan() 的判定，验证「群组翻译=自动」确实会 auto。
// ---------------------------------------------------------------------------
function scanSim(noteMarker) {
  const self = {
    gate: MP.createHistoryGate(),
    log: [],
    translateCalls: 0,
    lastIdentity: null,
    /**
     * 走一遍扫描。sideRows 每次都可以不同 —— 真实里左侧列表一直在重排。
     */
    scan: (sideRows, mainRows, note) => {
      const { dom, api } = page(sideRows, mainRows)
      const identity = api.chatIdentity()
      self.lastIdentity = identity
      self.gate.begin(identity, Date.now())
      const group = api.isGroupChat()
      let saw = 0
      for (const node of dom.window.document.querySelectorAll('#main [data-id]')) {
        const parsed = MP.parseForTranslation(node)
        if (!parsed.messageText) continue
        saw++
        const id = node.getAttribute('data-id')
        const historic = group ? self.gate.isHistoric(id, 0) : false
        if (group) self.gate.remember(id)
        const action = MP.messageAction({
          receiveEnabled: true,
          translatable: !!parsed.translatable,
          emojiOnly: false,
          hasChinese: /[\u4e00-\u9fff]/.test(parsed.messageText),
          includeZh: false,
          sameLang: false,
          group: group,
          transGroup: true,     // 「群组翻译 = 自动」
          historic: historic
        })
        self.log.push({ note: note, action: action, text: parsed.messageText })
        if (action === 'auto') self.translateCalls++
      }
      self.gate.settle(saw > 0)
      return self
    }
  }
  return self
}

test('★P0★ 群组翻译=自动：左侧列表不断重排，群里新消息仍必须 auto', () => {
  const s = scanSim()
  const history = [groupMsg('old message', 'M1')]
  s.scan(SIDE_A, history, '首轮')
  s.scan(SIDE_B, history, '列表重排')
  s.scan(SIDE_A, history.concat([groupMsg('BRAND NEW MESSAGE', 'M2')]), '群里来新消息')

  const fresh = s.log.filter(r => r.text === 'BRAND NEW MESSAGE')
  assert.equal(fresh.length, 1, '新消息应被扫到')
  assert.equal(fresh[0].action, 'auto',
    '「群组翻译 = 自动」下新消息必须是 auto；得到 ' + fresh[0].action + ' 说明历史基线被左侧列表串味了')
  assert.equal(s.translateCalls, 1)
})

test('打开群聊时的历史消息绝不能被 auto 批量翻掉（计费保护不能被顺手破坏）', () => {
  const s = scanSim()
  s.scan(SIDE_A, [
    groupMsg('history 1', 'H1'), groupMsg('history 2', 'H2'), groupMsg('history 3', 'H3')
  ], '打开群聊')
  s.scan(SIDE_B, [
    groupMsg('history 1', 'H1'), groupMsg('history 2', 'H2'), groupMsg('history 3', 'H3')
  ], '列表重排')
  assert.equal(s.translateCalls, 0, '打开群聊不得产生任何 auto 扣费')
  assert.ok(s.log.every(r => r.action === 'chip'), '历史消息只给「译」按钮')
})

test('换到另一个群：新群的历史只给 chip，新群的新消息才 auto', () => {
  const s = scanSim()
  s.scan(SIDE_A, [groupMsg('g1 history', 'A1')], '群1 首轮')
  s.scan(SIDE_A, [groupMsg('g1 new', 'A2')], '群1 新消息')
  const before = s.translateCalls
  // 换群
  const g2History = [
    '<div class="message-in" role="row" data-id="true_' + GROUP2_ID + '_B1">' +
    '<div class="copyable-text"><span class="selectable-text copyable-text">g2 history</span></div></div>',
    '<div class="message-in" role="row" data-id="true_' + GROUP2_ID + '_B2">' +
    '<div class="copyable-text"><span class="selectable-text copyable-text">g2 history 2</span></div></div>'
  ]
  s.scan(SIDE_B, g2History, '群2 首轮')
  assert.equal(s.translateCalls, before, '换群后不得把新群的历史当新消息自动翻')

  s.scan(SIDE_B, g2History.concat([
    '<div class="message-in" role="row" data-id="true_' + GROUP2_ID + '_B3">' +
    '<div class="copyable-text"><span class="selectable-text copyable-text">g2 BRAND NEW</span></div></div>'
  ]), '群2 新消息')
  assert.equal(s.translateCalls, before + 1, '换群后的新消息仍要 auto')
})

test('扫描循环必须从 chatIdentity() 取身份（不许自己重造一份）', () => {
  const scanAt = guest.indexOf('async function scan()')
  assert.ok(scanAt > 0)
  const fn = guest.slice(scanAt, scanAt + 1200)
  assert.ok(/historyGate\.begin\(chatIdentity\(\)/.test(fn),
    'scan() 必须用 chatIdentity() 建基线')
})

test('whatsappPeer / whatsappConversationKey 都不许扫整个 document', () => {
  for (const name of ['whatsappPeer', 'whatsappConversationKey']) {
    const src = grab(name)
    assert.ok(!/document\.querySelectorAll\('\[data-id\]'\)/.test(src),
      name + ' 用了 document.querySelectorAll(\'[data-id]\') —— 会扫到左侧列表')
  }
})
