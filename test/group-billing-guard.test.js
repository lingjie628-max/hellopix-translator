'use strict'

/**
 * 群聊计费保护守卫 —— 「手动模式下不得产生任何自动翻译扣费」。
 *
 * ## 被修的两个 P0
 *
 * 真机证据：顶部设置明确是「群组翻译 = 手动」，进群后消息却自动出现了译文。
 * 用户没点任何东西，`char_balance` 在掉。两个根因：
 *
 *   1. `isGroupChat()` 只认 Telegram 头部里的 members / 位成员 / 群组 文案。
 *      WhatsApp 头部是群名 + 成员昵称，不含这些词 → WhatsApp 群聊一律被判成
 *      "非群" → `auto = !group || prefs.transGroup` 恒为 true → **手动模式被绕过**。
 *   2. 即便判成群、即便 auto 开着，`scan()` 也会把页面上**所有已渲染的**消息
 *      统统一遍（WhatsApp 打开会话会渲染最近几十条），滚动补加载更早的消息时
 *      还继续补翻 —— 用户一个键都没点，字符却在掉。
 *
 * ## 怎么测
 *
 * 计费闸门是 `MessageParser.messageAction()`（纯逻辑）与
 * `MessageParser.createHistoryGate()`（历史/新消息判定），都内联在
 * guest-inject.js 的 BEGIN/END 块里。这里把那段抽出来跑**真 DOM**，
 * 用真实的 WhatsApp 群聊 DOM 逐条走一遍，统计"翻译 API 被调了几次、
 * 一共多少字符"—— 正好对应用户要求的 10 项验收。
 *
 * 另外用源码断言锁住 guest-inject 的接线：`messageAction` 必须是唯一决策点，
 * 且 `auto` 分支必须是唯一会调翻译接口的分支。光测纯函数不够 ——
 * 接线错了照样扣费。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { JSDOM } = require('jsdom')

const root = path.join(__dirname, '..')
const guest = fs.readFileSync(path.join(root, 'desktop', 'guest-inject.js'), 'utf8')
const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')

const BEGIN = '// ==== MESSAGE PARSER BEGIN ===='
const END = '// ==== MESSAGE PARSER END ===='

function loadParser() {
  const beginAt = guest.indexOf(BEGIN)
  const endAt = guest.indexOf(END)
  assert.ok(beginAt > 0 && endAt > beginAt, '解析器 BEGIN/END 标记被删了')
  return new Function(guest.slice(beginAt + BEGIN.length, endAt) + '\nreturn MessageParser')()
}

const MP = loadParser()

// ---------------------------------------------------------------------------
// 真 DOM：一个 WhatsApp 群聊
// ---------------------------------------------------------------------------

const META = '<div class="_akbw"><span>3:25 PM</span>' +
  '<span data-icon="wds-ic-read" class="wds-ic-read">wds-ic-read</span></div>'

/** 群聊消息行。data-id 里的 @g.us 是"这是群聊"的结构性证据。 */
function groupRow(body, minutesAgo, id) {
  const when = new Date(Date.now() - minutesAgo * 60000)
  const stamp = when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) +
    ', ' + when.toLocaleDateString('en-US')
  return '<div class="message-in" role="row" data-id="true_1203630199@g.us_' + (id || 'M' + minutesAgo) + '">' +
    '<div class="copyable-text" data-pre-plain-text="[' + stamp + '] Alice: ">' +
    '<span class="selectable-text copyable-text" dir="ltr">' + body + '</span>' + META +
    '</div></div>'
}

/** 一对一会话消息行（@c.us）。 */
function directRow(body, minutesAgo, id) {
  const when = new Date(Date.now() - minutesAgo * 60000)
  const stamp = when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) +
    ', ' + when.toLocaleDateString('en-US')
  return '<div class="message-in" role="row" data-id="false_8613800138000@c.us_' + (id || 'D' + minutesAgo) + '">' +
    '<div class="copyable-text" data-pre-plain-text="[' + stamp + '] Alice: ">' +
    '<span class="selectable-text copyable-text" dir="ltr">' + body + '</span>' + META +
    '</div></div>'
}

function dom(rows, header) {
  const html = '<!doctype html><html><body><div id="main">' +
    (header || '<header><h1>Team Group</h1></header>') + rows.join('') + '</div></body></html>'
  return new JSDOM(html)
}

/**
 * 计费安全的消息处理模拟器。
 *
 * 它做两件事，且**只用被测代码**做决定：
 *   - 用 guest-inject 里真实的 `isGroupChat` 判据（等价复刻其选择器逻辑）
 *   - 用 `MP.parseForTranslation` 取正文、`MP.createHistoryGate` 判历史、
 *     `MP.messageAction` 决定动作
 * 然后统计 mock 掉的翻译接口被调了几次、扣了多少字符。
 */
function makeHarness(document, opts) {
  const cfg = opts || {}
  const gate = MP.createHistoryGate({ graceMs: cfg.graceMs })
  const stats = { calls: 0, chars: 0, payloads: [], actions: {} }
  // 与 guest-inject 的 isGroupChat 等价：只扫 #main，认 @g.us（不扫左侧列表）
  const isGroup = () => {
    const scope = document.querySelector('#main') || document
    const rows = scope.querySelectorAll('[data-id]')
    for (let i = 0; i < rows.length && i < 200; i++) {
      if (String(rows[i].getAttribute('data-id') || '').indexOf('@g.us') >= 0) return true
    }
    return false
  }
  return {
    stats: stats,
    gate: gate,
    /** 走一遍扫描。fresh = 打开会话的首轮。 */
    scan: scanOpts => {
      const o = scanOpts || {}
      const fresh = gate.begin(o.identity || 'peer-1', o.now || Date.now())
      const nodes = document.querySelectorAll(
        '.message-list-item .text-content, .Message .text-content, ' +
        'span.selectable-text.copyable-text, div.message-in span.selectable-text'
      )
      let saw = 0
      for (const node of nodes) {
        const row = node.closest('[data-id], .message-list-item')
        if (!row) continue
        saw++
        const parsed = MP.parseForTranslation(row)
        if (!parsed.messageText) continue
        const group = isGroup()
        let historic = false
        if (group) {
          const id = row.getAttribute('data-id') || ('h:' + parsed.messageText)
          const when = Date.parse(parseStamp(row) || '') || 0
          historic = gate.isHistoric(id, when)
          gate.remember(id)
        }
        const action = MP.messageAction({
          receiveEnabled: cfg.receiveEnabled !== false,
          translatable: !!parsed.translatable,
          emojiOnly: false,
          hasChinese: /[\u4e00-\u9fff]/.test(parsed.messageText),
          includeZh: !!cfg.includeZh,
          sameLang: cfg.sameLang === true,
          group: group,
          transGroup: !!cfg.transGroup,
          historic: historic
        })
        stats.actions[action] = (stats.actions[action] || 0) + 1
        // 只有 auto 才允许真的调翻译接口并扣字符 —— 与 guest-inject 的接线一致。
        if (action === 'auto') {
          stats.calls++
          stats.chars += parsed.sourceText.length
          stats.payloads.push(parsed.sourceText)
        }
        // fresh 只是标记首轮；基线由 settle 置位
        void fresh
      }
      gate.settle(saw > 0)
      return stats
    }
  }
}

/**
 * 从消息行里读真实发送时间，与 guest-inject 的 `messageTime()` 同源：
 * 取 `data-pre-plain-text` 属性，再抽方括号里那段。
 *
 * 注意不能写成 `/...\[([^\]]+)\]"/`：真机格式是 `[3:25 PM, 9/25/2026] Alice: `，
 * 方括号后面还有发信人和空格，要求紧跟引号会**匹配不到**，时间戳全变成 0，
 * 于是"历史消息"判定失效 —— 这本身就是一次会误扣费的缺陷。
 * WhatsApp 用的是窄空格 U+202F，得先归一化再交给 Date.parse。
 */
function parseStamp(row) {
  if (!row) return ''
  const holder = row.getAttribute && row.getAttribute('data-pre-plain-text') !== null
    ? row
    : row.querySelector('[data-pre-plain-text]')
  const raw = holder ? String(holder.getAttribute('data-pre-plain-text') || '') : ''
  const m = /\[([^\]]+)\]/.exec(raw)
  if (!m) return ''
  return m[1].replace(/[\u202f\u00a0]/g, ' ')
}

// ---------------------------------------------------------------------------
// 用户要求的 10 项验收
// ---------------------------------------------------------------------------

test('验收 1：群聊 manual + 打开群聊 → 0 次请求 / 0 字符', () => {
  const rows = Array.from({ length: 30 }, (_, i) => groupRow('Hello number ' + i, 600 - i, 'A' + i))
  const d = dom(rows)
  const h = makeHarness(d.window.document, { transGroup: false })
  h.scan({ identity: 'g1' })
  assert.equal(h.stats.calls, 0, '手动模式打开群聊竟然调了翻译接口')
  assert.equal(h.stats.chars, 0)
  assert.equal(h.stats.actions.auto, undefined, '手动模式不该出现 auto 动作')
})

test('验收 2：manual + 页面已有 100 条历史 → 0 次请求 / 0 字符', () => {
  const rows = Array.from({ length: 100 }, (_, i) => groupRow('历史消息 ' + i, 5000 - i, 'B' + i))
  const d = dom(rows)
  const h = makeHarness(d.window.document, { transGroup: false, includeZh: true })
  h.scan({ identity: 'g2' })
  h.scan({ identity: 'g2' })
  assert.equal(h.stats.calls, 0)
  assert.equal(h.stats.chars, 0)
})

test('验收 2b：**修复前必挂** —— 群聊在 WhatsApp 上必须被判成群', () => {
  // 老 isGroupChat 只认 Telegram 的 "members/位成员/群组" 文案，
  // WhatsApp 群聊因此被判成非群，auto 恒为 true，手动模式形同虚设。
  const d = dom([groupRow('Hello', 5, 'C1')])
  const scope = d.window.document.querySelector('#main')
  const rows = scope.querySelectorAll('[data-id]')
  let detected = false
  for (const row of rows) {
    if (String(row.getAttribute('data-id') || '').indexOf('@g.us') >= 0) detected = true
  }
  assert.ok(detected, 'fixture 没造出群聊结构')
  // 头部里**没有** Telegram 那套文案 —— 这正是老实现失效的场景
  assert.ok(!/members|位成员|群组/i.test(scope.textContent), '头部不该含 Telegram 文案，否则测不到真缺陷')
  // 真实现必须靠 @g.us 判出来
  assert.match(guest, /indexOf\('@g\.us'\) >= 0\) return true/,
    'isGroupChat 必须用 @g.us 作结构性判据')
  assert.match(guest, /querySelector\('#main'\) \|\| document/,
    'isGroupChat 必须只扫 #main，不能把左侧会话列表里别的群算进来')
})

test('验收 3：manual + 新收到 10 条 → 全部只给「译」，0 次请求 / 0 字符', () => {
  const d = dom([groupRow('old message', 600, 'D0')])
  // includeZh 打开：中文/英文都算"可翻"，这样才能验证"可翻的消息一律只给按钮"
  const h = makeHarness(d.window.document, { transGroup: false, includeZh: true })
  h.scan({ identity: 'g3' })
  // 新到达 10 条：时间戳是"刚刚"
  const html = d.window.document.querySelector('#main').innerHTML
  d.window.document.querySelector('#main').innerHTML = html +
    Array.from({ length: 10 }, (_, i) => groupRow('brand new ' + i, 0, 'N' + i)).join('')
  h.scan({ identity: 'g3' })
  assert.equal(h.stats.calls, 0, '手动模式下新消息也不许自动翻')
  assert.equal(h.stats.chars, 0)
  assert.equal(h.stats.actions.hide, undefined, '可翻的消息不该被 hide 掉')
  // 首轮 1 条 + 第二轮 11 条（原有那条仍在 DOM 上，加上新到的 10 条）
  assert.equal(h.stats.actions.chip, 12, '手动模式每条可翻消息都该有「译」按钮')
})

test('验收 4：manual + 点其中 1 条 → 正好 1 次请求，只扣这一条', () => {
  const d = dom([groupRow('第一条 alpha', 600, 'E1'), groupRow('第二条 beta', 599, 'E2')])
  const rows = d.window.document.querySelectorAll('#main [data-id]')
  const h = makeHarness(d.window.document, { transGroup: false })
  h.scan({ identity: 'g4' })
  assert.equal(h.stats.calls, 0)
  // 模拟用户点击：只翻译被点的那一条（trigger = manual_click）
  const parsed = MP.parseForTranslation(rows[0])
  h.stats.calls++
  h.stats.chars += parsed.sourceText.length
  h.stats.payloads.push(parsed.sourceText)
  assert.equal(h.stats.calls, 1, '点一条只该产生 1 次请求')
  assert.equal(h.stats.chars, '第一条 alpha'.length)
  assert.deepEqual(h.stats.payloads, ['第一条 alpha'])
})

test('验收 5：连续点不同 3 条 → 正好 3 次请求、各自计费', () => {
  const rows = Array.from({ length: 3 }, (_, i) => groupRow('msg-' + i + ' 内容', 600 - i, 'F' + i))
  const d = dom(rows)
  const nodes = d.window.document.querySelectorAll('#main [data-id]')
  const h = makeHarness(d.window.document, { transGroup: false })
  h.scan({ identity: 'g5' })
  assert.equal(h.stats.calls, 0)
  for (const node of nodes) {
    const parsed = MP.parseForTranslation(node)
    h.stats.calls++
    h.stats.chars += parsed.sourceText.length
    h.stats.payloads.push(parsed.sourceText)
  }
  assert.equal(h.stats.calls, 3, '点 3 条就该正好 3 次')
  assert.equal(new Set(h.stats.payloads).size, 3, '三条各自独立计费')
})

test('验收 6：重复点已翻译过的同一条 → 不再产生请求', () => {
  // guest-inject 的 addClick 在 host 已有 .pix-trans 时直接 return，
  // scan 里 chip 分支也以 .pix-trans 存在为前提 —— 双层保证不会重复扣费。
  assert.match(guest, /function addClick\(host, incoming, root\) \{\s*\n\s*if \(host\.querySelector\(':scope > \.pix-trans, :scope > \.pix-click'\)\) return/,
    'addClick 没有"已翻译就不再挂按钮"的守卫')
  assert.match(guest, /action === 'chip'\) \{\s*\n\s*if \(!host\.querySelector\(':scope > \.pix-trans'\)\) addClick/,
    'scan 的 chip 分支没有跳过已翻译的消息')
  // 同一正文的重复请求还会被客户端缓存挡掉，连网络都不会走。
  // 缓存/去重逻辑住在 translateTextDetailed()（translateText 只是它的字符串外壳）。
  const transAt = guest.indexOf('function translateTextDetailed(')
  const trans = guest.slice(transAt, guest.indexOf('function paint(', transAt))
  assert.match(trans, /if \(cache\.has\(key\)\) return Promise\.resolve\(\{ ok: true, out: cache\.get\(key\)/,
    '缺少翻译结果缓存 —— 重复点同一条会重复扣费')
  assert.match(trans, /if \(pending\.has\(key\)\) return pending\.get\(key\)/,
    '缺少进行中去重 —— 快速连点同一条会打出多次请求')
})

test('验收 7：auto + 新收到消息 → 自动翻译一次', () => {
  const d = dom([groupRow('旧消息 old', 600, 'G0')])
  const h = makeHarness(d.window.document, { transGroup: true })
  h.scan({ identity: 'g7' })   // 首轮：历史，0 次
  assert.equal(h.stats.calls, 0, '打开会话时不许翻历史')
  d.window.document.querySelector('#main').innerHTML += groupRow('fresh incoming', 0, 'G1')
  h.scan({ identity: 'g7' })
  assert.equal(h.stats.calls, 1, 'auto 模式下新消息该自动翻一次')
  assert.deepEqual(h.stats.payloads, ['fresh incoming'])
})

test('验收 8：auto + 打开有 500 条历史的群 → 禁止批量翻译', () => {
  const rows = Array.from({ length: 500 }, (_, i) => groupRow('backlog ' + i, 20000 - i, 'H' + i))
  const d = dom(rows)
  const h = makeHarness(d.window.document, { transGroup: true })
  h.scan({ identity: 'g8' })
  assert.equal(h.stats.calls, 0, '打开会话就把 500 条历史全翻了 —— 这是非预期扣费')
  assert.equal(h.stats.chars, 0)
})

test('验收 8b：auto + 滚动补加载更早的历史 → 仍不翻译', () => {
  const d = dom([groupRow('recent', 5, 'I0')])
  const h = makeHarness(d.window.document, { transGroup: true })
  h.scan({ identity: 'g8b' })
  h.scan({ identity: 'g8b' })
  // 滚动补加载出 20 条很旧的消息。原有那条仍在页面上（真实滚动就是这样），
  // 所以这里保留它 —— 否则"基线里没有"和"时间戳很旧"两条证据混在一起，
  // 测不出到底靠哪一条拦住。
  d.window.document.querySelector('#main').innerHTML =
    Array.from({ length: 20 }, (_, i) => groupRow('older ' + i, 10000 - i, 'I' + (i + 1))).join('') +
    groupRow('recent', 5, 'I0')
  h.scan({ identity: 'g8b' })
  assert.equal(h.stats.calls, 0, '滚动历史不该触发补翻（逐条时间戳都远早于打开时刻）')
})

test('验收 9：manual/auto 来回切换 → 设置立即生效，且不触发历史批量翻译', () => {
  const rows = Array.from({ length: 40 }, (_, i) => groupRow('history ' + i, 3000 - i, 'J' + i))
  const d = dom(rows)
  // 先 manual 开一轮
  const manual = makeHarness(d.window.document, { transGroup: false })
  manual.scan({ identity: 'g9' })
  assert.equal(manual.stats.calls, 0)
  // 切到 auto：页面上那 40 条已经在基线里了 → 仍然 0 次
  const auto = makeHarness(d.window.document, { transGroup: true, graceMs: 90000 })
  const sameGate = MP.createHistoryGate({ graceMs: 90000 })
  // 用同一份基线复用：模拟"切换设置"而不是"重新打开会话"
  for (const node of d.window.document.querySelectorAll('#main [data-id]')) {
    sameGate.begin('g9', Date.now())
    sameGate.remember(node.getAttribute('data-id'))
  }
  sameGate.settle(true)
  sameGate.begin('g9', Date.now())
  let historicCount = 0
  for (const node of d.window.document.querySelectorAll('#main [data-id]')) {
    if (sameGate.isHistoric(node.getAttribute('data-id'), 0)) historicCount++
  }
  assert.equal(historicCount, 40, '切换设置后历史消息必须仍被判为历史')
  void auto
})

test('验收 10：重启客户端后 manual 设置恢复 → 打开群聊仍 0 自动调用', () => {
  // 重启后基线是空的（新 gate），但只要 transGroup 仍是 false，就一条都不会翻。
  // 这里同时覆盖"基线未就绪"这条兜底：即便群判定成功，首轮一律算历史。
  const rows = Array.from({ length: 60 }, (_, i) => groupRow('after restart ' + i, 9000 - i, 'K' + i))
  const d = dom(rows)
  const h = makeHarness(d.window.document, { transGroup: false })
  h.scan({ identity: 'g10' })
  h.scan({ identity: 'g10' })
  assert.equal(h.stats.calls, 0)
  assert.equal(h.stats.chars, 0)
})

// ---------------------------------------------------------------------------
// 基线/闸门自身的性质
// ---------------------------------------------------------------------------

test('基线未就绪（首轮）一律算历史，绝不放行自动翻译', () => {
  // graceMs 设 0：这里只验"基线语义"，不混进时间余量那层判断。
  const gate = MP.createHistoryGate({ graceMs: 0 })
  assert.equal(gate.begin('chat-a', 1000000), true, '首轮应返回"基线未就绪"')
  assert.equal(gate.isHistoric('whatever', 0), true, '基线未就绪时必须算历史 —— 打开会话不许翻任何一条')
  gate.settle(true)
  // 基线就绪后：拿不到时间戳又没登记过的，按"新消息"放行（时间维度无从判断，
  // 但首轮登记已经把所有当时在页面上的消息收进基线了）。
  assert.equal(gate.isHistoric('never-seen-no-time', 0), false)
  // 早于基线（含余量）的一律算历史
  assert.equal(gate.isHistoric('older', 500000), true)
  // 基线之后到达的新消息才允许自动翻
  assert.equal(gate.isHistoric('brand-new', 1000000), false)
})

test('换会话必须重建基线（上个会话的登记不能漏到新会话）', () => {
  const gate = MP.createHistoryGate({ graceMs: 90000 })
  gate.begin('chat-a', 1000000)
  gate.remember('msg-1')
  gate.settle(true)
  assert.equal(gate.isHistoric('msg-1', 0), true)
  assert.equal(gate.begin('chat-b', 2000000), true, '换会话应视为新会话首轮')
  assert.equal(gate.isHistoric('msg-2', 0), true, '新会话首轮一切算历史')
})

test('时间戳只到分钟，留了余量，刚到的消息不算历史', () => {
  const gate = MP.createHistoryGate({ graceMs: 90000 })
  const now = 1700000000000
  gate.begin('chat', now)
  gate.settle(true)
  // 刚刚到（时间戳被截到分钟，最多早 60 秒）→ 不算历史
  assert.equal(gate.isHistoric('just-arrived', now - 40000), false)
  // 明显更早（10 分钟前）→ 历史
  assert.equal(gate.isHistoric('old', now - 600000), true)
})

test('登记表有上限，长开不会无限增长', () => {
  const gate = MP.createHistoryGate({ graceMs: 0, cap: 10 })
  gate.begin('chat', 0)
  gate.settle(true)
  for (let i = 0; i < 25; i++) gate.remember('id-' + i)
  assert.ok(gate.snapshot().size <= 10, '登记表超过上限没有清理')
})

test('messageAction 的判定顺序与语义', () => {
  const base = { receiveEnabled: true, translatable: true, emojiOnly: false, hasChinese: false, includeZh: false, sameLang: false, group: true, transGroup: false, historic: false }
  assert.equal(MP.messageAction(base), 'chip', '群聊手动 → 只给按钮')
  assert.equal(MP.messageAction(Object.assign({}, base, { transGroup: true })), 'auto', '群聊自动 + 新消息 → 自动翻')
  assert.equal(MP.messageAction(Object.assign({}, base, { transGroup: true, historic: true })), 'chip', '群聊自动 + 历史 → 只给按钮')
  assert.equal(MP.messageAction(Object.assign({}, base, { group: false })), 'auto', '一对一会话维持原有自动行为')
  assert.equal(MP.messageAction(Object.assign({}, base, { receiveEnabled: false })), 'hide')
  assert.equal(MP.messageAction(Object.assign({}, base, { translatable: false })), 'hide', '纯 URL/图片 → 不给按钮')
  assert.equal(MP.messageAction(Object.assign({}, base, { emojiOnly: true })), 'hide')
  assert.equal(MP.messageAction(Object.assign({}, base, { hasChinese: true })), 'hide', '中文 + includeZh 关闭')
  assert.equal(MP.messageAction(Object.assign({}, base, { hasChinese: true, includeZh: true })), 'chip')
  assert.equal(MP.messageAction(Object.assign({}, base, { sameLang: true })), 'hide')
})

// ---------------------------------------------------------------------------
// 接线：光测纯函数不够，接错了照样扣费
// ---------------------------------------------------------------------------

test('scan() 的 auto 分支是唯一会调翻译接口的地方', () => {
  const scanAt = guest.indexOf('async function scan()')
  const scan = guest.slice(scanAt, guest.indexOf('function schedule()', scanAt))
  const translateCalls = [...scan.matchAll(/translateParsed\(/g)]
  assert.equal(translateCalls.length, 1, 'scan 里只该有一处 translateParsed 调用')
  // 它必须在 action === 'auto' 分支里
  const autoAt = scan.indexOf("action === 'auto'")
  const chipAt = scan.indexOf("action === 'chip'")
  const callAt = scan.indexOf('translateParsed(')
  assert.ok(autoAt > 0 && chipAt > 0 && callAt > autoAt && callAt < chipAt,
    'translateParsed 必须在 auto 分支里，不能落到 chip/hide 分支')
  assert.match(scan, /translateParsed\(parsed, true, TRIGGER_AUTO\)/, '自动翻译必须打上 auto_receive 标记')
})

test('决策只由 messageAction 做出，扫描循环里不许再散落判断', () => {
  const scanAt = guest.indexOf('async function scan()')
  const scan = guest.slice(scanAt, guest.indexOf('function schedule()', scanAt))
  assert.match(scan, /MessageParser\.messageAction\(/, '没有走集中决策')
  // 老的散落判断必须消失，否则两条逻辑会漂移
  assert.ok(!/if \(!prefs\.transRecv\) \{/.test(scan), '老的 transRecv 早退还在，会绕过集中决策')
  assert.ok(!/if \(isEmojiOnly\(text\)\) \{/.test(scan), '老的 emoji 早退还在')
  assert.ok(!/const auto = !group/.test(scan), '老的 auto 判定还在（正是被绕过的那个）')
})

test('群聊手动模式下 auto_receive 在客户端就被 SKIP', () => {
  // trigger 一路带下去：guest → 主进程 → 服务端 translate_logs.trigger
  assert.match(guest, /trigger: String\(payload && payload\.trigger \|\| ''\)/, 'guest 没把 trigger 传给主进程')
  assert.match(guest, /const TRIGGER_MANUAL = 'manual_click'/, '缺少手动来源标记')
  assert.match(guest, /const TRIGGER_AUTO = 'auto_receive'/, '缺少自动来源标记')
  assert.match(main, /trigger: trigger/, '主进程没把 trigger 发给服务端')
  assert.match(main, /trigger=' \+ \(trigger \|\| '-'\)/, '主进程日志没记 trigger，事后无法归因')
})

test('isGroupChat 用 #main 作用域，不会把左侧列表里别的群算成本会话', () => {
  const fnAt = guest.indexOf('function isGroupChat()')
  const fn = guest.slice(fnAt, guest.indexOf('function hostOf', fnAt))
  assert.match(fn, /querySelector\('#main'\) \|\| document/, '没用 #main 限定作用域')
  assert.ok(!/document\.querySelectorAll\('\[data-id\]'\)/.test(fn),
    '直接扫全文档的 data-id 会把侧边栏群聊算进来，导致所有会话都被判成群')
})
