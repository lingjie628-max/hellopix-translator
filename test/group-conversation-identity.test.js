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
 * 列表每来消息都会重排 → 身份每轮都变 → 群聊的自动翻译状态每轮被清空重来
 * → auto 永不触发（手动「译」按钮还在，所以只表现为"自动不翻"）。
 *
 * 0.1.25 那条历史基线闸门已按用户裁定删除（「自动」就该是自动），但**身份必须
 * 只认当前会话**这条结论没变：身份现在用来清"自动翻译排队 + 失败冷却"，
 * 它一抖就会把刚开始翻的那批任务全丢掉，症状还是"自动不翻"。
 *
 * ## 为什么之前 21 条群聊用例全绿
 *
 * `test/group-billing-guard.test.js` 的 harness 是**自己重写的扫描循环**，
 * 且身份由调用方**直接传入**，真 DOM 里也**没有左侧列表**。真实
 * `chatIdentity()` / `whatsappPeer()` 从未被执行过。本文件用 guest-inject.js
 * 的**真实源码**补上这段。
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
  'currentPeer', 'chatDisplayName', 'chatIdentity', 'chatKind', 'isGroupChat'
].map(grab)

/** 在 jsdom 里装配真实函数（document / location 由页面提供）。 */
function mount(document, location, window) {
  return new Function(
    'document', 'location', 'window',
    SOURCE_FNS.join('\n') + '\nreturn { whatsappPeer, whatsappConversationKey, currentPeer, chatIdentity, chatKind, isGroupChat }'
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

function groupMsgIn(gid, body, id) {
  return '<div class="message-in" role="row" data-id="true_' + gid + '_' + id + '">' +
    '<div class="copyable-text"><span class="selectable-text copyable-text">' + body + '</span></div></div>'
}

function groupMsg(body, id) {
  return groupMsgIn(GROUP_ID, body, id)
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
// 端到端：把真实 chatIdentity + 真实 messageAction 接起来，复刻 scan() 的判定，
// 验证「群组翻译=自动」在左侧列表不断重排的情况下依然真的自动翻。
// ---------------------------------------------------------------------------
function scanSim() {
  const self = {
    log: [],
    translateCalls: 0,
    chipRenders: 0,
    identityChanges: 0,
    lastIdentity: null,
    /** 走一遍扫描。sideRows 每次都可以不同 —— 真实里左侧列表一直在重排。 */
    scan: (sideRows, mainRows, note) => {
      const { dom, api } = page(sideRows, mainRows)
      const identity = api.chatIdentity()
      // 换会话 → 清自动翻译排队 + 失败冷却（真实 scan() 里 lastScanIdentity 那一支）
      if (self.lastIdentity !== null && identity !== self.lastIdentity) self.identityChanges++
      self.lastIdentity = identity
      const group = api.isGroupChat()
      for (const node of dom.window.document.querySelectorAll('#main [data-id]')) {
        const parsed = MP.parseForTranslation(node)
        if (!parsed.messageText) continue
        const action = MP.messageAction({
          receiveEnabled: true,
          translatable: !!parsed.translatable,
          emojiOnly: false,
          hasChinese: /[\u4e00-\u9fff]/.test(parsed.messageText),
          includeZh: false,
          sameLang: false,
          group: group,
          transGroup: true     // 「群组翻译 = 自动」
        })
        self.log.push({ note: note, action: action, text: parsed.messageText })
        if (action === 'auto') self.translateCalls++
        if (action === 'chip') self.chipRenders++
      }
      return self
    }
  }
  return self
}

test('★P0★ 群组翻译=自动：左侧列表不断重排，群里每条消息仍必须 auto', () => {
  const s = scanSim()
  const history = [groupMsg('old message', 'M1')]
  s.scan(SIDE_A, history, '首轮')
  s.scan(SIDE_B, history, '列表重排')
  s.scan(SIDE_A, history.concat([groupMsg('BRAND NEW MESSAGE', 'M2')]), '群里来新消息')

  const fresh = s.log.filter(r => r.text === 'BRAND NEW MESSAGE')
  assert.equal(fresh.length, 1, '新消息应被扫到')
  assert.equal(fresh[0].action, 'auto',
    '「群组翻译 = 自动」下新消息必须是 auto；得到 ' + fresh[0].action + ' 说明身份被左侧列表串味了')
  assert.equal(s.translateCalls, s.log.length, '自动模式下每条被扫到的消息都该自动翻')
})

test('★0.1.25 用户裁定★ 群聊=自动：打开会话时已在页面上的历史消息也要自动翻', () => {
  const s = scanSim()
  const rows = [groupMsg('history 1', 'H1'), groupMsg('history 2', 'H2'), groupMsg('history 3', 'H3')]
  s.scan(SIDE_A, rows, '打开群聊')
  s.scan(SIDE_B, rows, '列表重排')
  assert.equal(s.translateCalls, 6, '3 条消息 × 2 轮扫描都应判 auto（=「自动」就该是自动）')
  assert.equal(s.chipRenders, 0,
    '「自动」下不许再出现「译」按钮 —— 真机上就是它造成"一部分翻、一部分没翻"的观感')
})

test('换到另一个群：新群的消息同样全部 auto，且不会因为换会话而漏翻', () => {
  const s = scanSim()
  s.scan(SIDE_A, [groupMsg('g1 history', 'A1')], '群1 首轮')
  s.scan(SIDE_A, [groupMsg('g1 new', 'A2')], '群1 新消息')
  const g2 = [groupMsgIn(GROUP2_ID, 'g2 history', 'B1'), groupMsgIn(GROUP2_ID, 'g2 history 2', 'B2')]
  s.scan(SIDE_B, g2, '群2 首轮')
  s.scan(SIDE_B, g2.concat([groupMsgIn(GROUP2_ID, 'g2 BRAND NEW', 'B3')]), '群2 新消息')
  assert.ok(s.identityChanges > 0, '换群必须被识别出来（用于清排队/冷却）')
  const inG2 = s.log.filter(r => /^g2 /.test(r.text))
  assert.equal(inG2.length, 5, '群2：首轮 2 条 + 新消息轮 3 条（原 2 条仍在页面上）')
  assert.ok(inG2.every(r => r.action === 'auto'), '换群后新群的每条消息也必须是 auto')
  assert.equal(s.chipRenders, 0)
})

test('扫描循环必须从 chatIdentity() 取身份（不许自己重造一份）', () => {
  const scanAt = guest.indexOf('async function scan()')
  assert.ok(scanAt > 0)
  const fn = guest.slice(scanAt, scanAt + 2400)
  // 身份必须来自 chatIdentity()，且**只取一次**再复用（取两次会拿到两个时间点的值）。
  assert.ok(/const identity = chatIdentity\(\)/.test(fn),
    'scan() 必须用 const identity = chatIdentity() 取当前会话身份')
  assert.ok(/if \(identity !== lastScanIdentity\)/.test(fn),
    'scan() 必须用同一个 identity 判断"是否换了会话"')
  assert.ok(/lastScanIdentity = identity/.test(fn), 'scan() 必须把新身份记下来')
  assert.ok(!/historyGate/.test(fn), '历史基线闸门已删除，scan() 不许再引用它')
})

test('★0.1.25★「群聊=自动 但历史消息只给按钮」那条闸门必须真的删干净', () => {
  // 只从 messageAction 里删掉那一行是不够的 —— 判据、初始化、导出都得一起走。
  // 留一段不再影响任何决策的"计费闸门"比没有更危险：下一个人会以为它还在保护什么。
  assert.ok(!/createHistoryGate/.test(guest), 'createHistoryGate 还在（死代码）')
  assert.ok(!/isHistoric/.test(guest), 'isHistoric 还在（死代码）')
  assert.ok(!/s\.historic/.test(guest), 'messageAction 还在消费 historic（闸门没删干净）')
  assert.ok(!/\bhistoryGate\b/.test(guest), 'historyGate 还被引用')
  const src = grab('messageAction')
  assert.ok(/if \(s\.group && !s\.transGroup\) return 'chip'/.test(src),
    '群聊手动 → 只给按钮 这条计费闸门必须保留（它才是防非预期扣费的那一条）')
})

test('★0.1.23★ 私聊判定必须只看 #main，且 @c.us 是硬证据', () => {
  // 真机 P0：中文界面左侧列表 header 里有「群组」筛选标签，老判据查整个文档的
  // header → 命中「群组」→ 每个私聊都被判成群 → 私聊自动翻译全失效。
  const src = grab('chatKind')
  assert.ok(/querySelector\('#main'\)/.test(src), 'chatKind 必须以 #main 为作用域')
  // 允许的 document 查询只有两个：
  //   · `#main`     —— WhatsApp 的会话区
  //   · `.ChatInfo` —— Telegram 的会话信息块（Telegram 页面里没有 #main）
  // 下面还锁住了 `.ChatInfo` 只可能出现在 `if (!main)` 分支里，所以它
  // **在 WhatsApp 上永远不会被执行** —— 不可能再读到左侧列表的 header。
  const docQueries = [...src.matchAll(/document\.querySelector\(\s*'([^']*)'/g)].map(m => m[1])
  assert.deepEqual(docQueries, ['#main', '.ChatInfo'],
    'chatKind 只允许 document.querySelector 取 #main / .ChatInfo，实际：' + JSON.stringify(docQueries))
  assert.ok(src.indexOf("querySelector('.ChatInfo')") > src.indexOf('if (!main)'),
    '.ChatInfo 只能在拿不到 #main（即非 WhatsApp）时读；提前读等于又回到"全文档找会话信息"的老路')
  assert.ok(!/\|\|\s*document\b/.test(src),
    'chatKind 不许退回整份 document 兜底 —— 那会把左侧列表的「群组」标签读进来')
  // 真实装配：带侧边栏 + 私聊
  const dom = new JSDOM('<!doctype html><html><body>' +
    '<div id="side"><header><div role="tablist"><span>全部</span><span>未读</span><span>群组</span></div></header>' +
    '<div data-id="false_9999@c.us_1"><span>群里的某人</span></div></div>' +
    '<div id="main"><header><h1>Alice</h1></header>' + directMsg('hello there', 'D9') + '</div>' +
    '</body></html>', { url: 'https://web.whatsapp.com/' })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    configurable: true, get () { return this.textContent }
  })
  const api = mount(dom.window.document, dom.window.location, dom.window)
  const kind = api.chatKind()
  assert.equal(kind.group, false, '私聊被判成群 → 自动翻译会整个失效（真机 P0 复现）')
  assert.equal(kind.evidence.source, 'dataid:c.us')
  assert.equal(api.isGroupChat(), false)
})

test('★Telegram★ peer id 为负必须判群（否则「群聊翻译」开关在 Telegram 上失效）', () => {
  // Telegram Web A **没有 #main**，会话类型只能从 URL hash 的 peer id 符号拿。
  // 修复前 chatKind 拿不到 #main 就恒返回"私聊"，于是群聊被当成私聊：
  // 「群聊=手动」那条唯一的计费闸门永不命中，用户在 TG 群里的消息照样自动翻、照样扣字符。
  const dom = new JSDOM('<!doctype html><html><body>' +
    '<div id="MiddleColumn"><div class="ChatInfo">' +
    '<div class="title">Some Group</div><div class="subtitle">online</div></div></div>' +
    '</body></html>', { url: 'https://web.telegram.org/a/' })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    configurable: true, get () { return this.textContent }
  })
  // 走 mount 注入的 location（真机里就是页面 location）。
  const api = mount(dom.window.document, { hash: '#-1001234567890' }, dom.window)
  const kind = api.chatKind()
  assert.equal(kind.group, true, 'Telegram 群被漏判成私聊 —— 群聊翻译开关会失效')
  assert.equal(kind.evidence.platform, 'telegram')
  assert.equal(kind.evidence.negativePeer, true)
  assert.equal(kind.evidence.source, 'peer:negative')
  assert.equal(kind.evidence.inMain, false, 'Telegram 上没有 #main，inMain 必须是 false')

  // 个人 id 是正数 → 私聊（私聊始终自动翻译）。
  const apiPrivate = mount(dom.window.document, { hash: '#123456789' }, dom.window)
  assert.equal(apiPrivate.chatKind().group, false, '个人 id 不该判成群')
})

test('whatsappPeer / whatsappConversationKey 都不许扫整个 document', () => {
  for (const name of ['whatsappPeer', 'whatsappConversationKey']) {
    const src = grab(name)
    assert.ok(!/document\.querySelectorAll\('\[data-id\]'\)/.test(src),
      name + ' 用了 document.querySelectorAll(\'[data-id]\') —— 会扫到左侧列表')
  }
})
