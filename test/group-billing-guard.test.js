'use strict'

/**
 * 群聊计费保护守卫 —— 「群聊=手动 时不得产生任何自动翻译扣费」。
 *
 * ## 现在的语义（用户裁定，2026-10-11）
 *
 *   | 会话类型 | 自动翻译 |
 *   |---|---|
 *   | 私聊 | **始终自动**（与「群聊自动翻译」开关无关） |
 *   | 群聊 = 手动 | 一条都不自动翻，只给「译」按钮（0 自动扣费） |
 *   | 群聊 = 自动 | 会话里出现的消息**全部自动翻**，**不再出现「译」按钮** |
 *
 * ## 被删掉的第三条闸门（0.1.24 及以前）
 *
 * 0.1.24 还有「群聊=自动 且 历史消息 → 只给按钮」，用来防"一进群就翻满屏历史"。
 * 真机上它把「自动」变成了**半自动**：打开群聊时页面上那批消息永远只有按钮，
 * 只有之后新到的才自动翻。用户看到的就是"一部分翻译，还有一部分没有翻译"
 * （真机日志同群同分钟：MANUAL_CHIP_RENDERED × 43 + auto_receive × 26）。
 *
 * ⚠️ 别把它加回来。加回来的话这套测试**仍然会全绿**（它当年就是这么活下来的），
 * 而真机上「自动」又只剩一半。
 *
 * ## 被修过的两个 P0（这两条防的是"手动模式还在自动扣费"）
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
 * 计费闸门是 `MessageParser.messageAction()`（纯逻辑）与 guest-inject 里的派发
 * 池（有界并发），都内联在 guest-inject.js 的 BEGIN/END 块以及扫描循环里。
 * 这里把那段抽出来跑**真 DOM**，用真实的 WhatsApp 群聊 DOM 逐条走一遍，
 * 统计"翻译 API 被调了几次、一共多少字符"。
 *
 * 另外用源码断言锁住 guest-inject 的接线：`messageAction` 必须是唯一决策点，
 * 且 `auto` 分支必须是唯一会调翻译接口的分支。光测纯函数不够 —— 接线错了照样扣费。
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

/** 按大括号配对，把 guest-inject.js 里的真实函数整段抽出来。 */
function grabFn(name) {
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

/**
 * ★把 guest-inject.js 里**真实的** chatKind() 抽出来跑★
 *
 * 踩过的坑：这个文件原来的 makeHarness 自己**复刻**了一份
 * `isGroup = () => 扫 #main 认 @g.us`，注释还写着"与 guest-inject 的
 * isGroupChat 等价"。可真实的 isGroupChat() 还有另外两条判据
 * （头部文案 / aria-label 通配 group），复刻版一条都没覆盖 ——
 * 于是真机上"中文界面会话列表 header 里的「群组」筛选 → 每个私聊都被判成群"
 * 这个 P0，整套测试**完全看不见**。
 *
 * 现在改成从源码里切真函数出来评：判据改一处，测试立刻跟着变。
 */
const CHAT_KIND_SRC = grabFn('chatKind')

/** 用真函数判一个 jsdom 文档 —— 返回 { group, evidence }。 */
function chatKindOf(doc) {
  return new Function('document', CHAT_KIND_SRC + '\nreturn chatKind()')(doc)
}

/** jsdom 不实现 innerText（真机 Chromium 有），不补就没法测"头部文案"那条判据。 */
function withInnerText(dom) {
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get () { return this.textContent }
  })
  return dom
}

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
  return withInnerText(new JSDOM(html))
}

/**
 * ★真机形状★ 的整页：左侧会话列表（带筛选标签 header）+ 右侧当前会话。
 *
 * 为什么必须建这一层：真机的 P0 就出在"左侧列表的 header 排在 #main 之前"。
 * 原来的 dom() 只有 #main，等于把出问题的那一半 DOM 直接删掉了 ——
 * 测试当然全绿，真机照样坏。`lang` 决定筛选标签是「群组」还是「Groups」。
 */
function domRealistic(rows, opts) {
  const o = opts || {}
  const zh = o.lang !== 'en'
  const tabs = zh
    ? '<div role="tablist"><span>全部</span><span>未读</span><span>收藏</span><span>群组</span></div>'
    : '<div role="tablist"><span>All</span><span>Unread</span><span>Favourites</span><span>Groups</span></div>'
  // 左侧列表里混着别的群（真实存在）—— 判据绝不能被它带跑。
  const sidebarItem = '<div data-testid="cell-frame-container"><span>' + (zh ? '某个群' : 'Some Group') + '</span></div>'
  const sidebar = '<div id="side"><div id="pane-side">' +
    '<header>' + tabs + '</header>' +
    '<div data-testid="chat-list">' + sidebarItem + '</div>' +
    '</div></div>'
  const mainHeader = o.mainHeader || (zh ? '<header><h1>Alice</h1></header>' : '<header><h1>Alice</h1></header>')
  const extra = o.extraInsideMain || ''
  const html = '<!doctype html><html><body>' +
    sidebar +
    '<div id="main">' + mainHeader + '<div id="msg-list">' + rows.join('') + '</div>' + extra + '</div>' +
    '</body></html>'
  return withInnerText(new JSDOM(html))
}

/**
 * 计费安全的消息处理模拟器（0.1.25）。
 *
 * 它只用被测代码做决定：
 *   - 用 guest-inject 里真实的 `chatKind()` 判会话类型
 *   - 用 `MP.parseForTranslation` 取正文
 *   - 用 `MP.messageAction` 决定动作（auto / chip / hide）
 * 然后统计 mock 掉的翻译接口被调了几次、扣了多少字符。
 *
 * ⚠️ 这里**没有**"历史基线"这一层：那条闸门已被用户裁定删除。
 * 加回来会让「群聊=自动」重新退化成半自动，而测试仍然全绿。
 */
function makeHarness(document, opts) {
  const cfg = opts || {}
  const stats = { calls: 0, chars: 0, payloads: [], actions: {}, chips: 0 }
  // 用**真函数**判会话类型（不再自己复刻一份，见 CHAT_KIND_SRC 的注释）。
  const isGroup = () => chatKindOf(document).group
  return {
    stats: stats,
    /** 走一遍扫描（模拟 scan() 的决策；翻译派发在 guest 里由有界池完成）。 */
    scan: () => {
      const nodes = document.querySelectorAll(
        '.message-list-item .text-content, .Message .text-content, ' +
        'span.selectable-text.copyable-text, div.message-in span.selectable-text'
      )
      for (const node of nodes) {
        const row = node.closest('[data-id], .message-list-item')
        if (!row) continue
        const parsed = MP.parseForTranslation(row)
        if (!parsed.messageText) continue
        const action = MP.messageAction({
          receiveEnabled: cfg.receiveEnabled !== false,
          translatable: !!parsed.translatable,
          emojiOnly: false,
          hasChinese: /[\u4e00-\u9fff]/.test(parsed.messageText),
          includeZh: !!cfg.includeZh,
          sameLang: cfg.sameLang === true,
          group: isGroup(),
          transGroup: !!cfg.transGroup
        })
        stats.actions[action] = (stats.actions[action] || 0) + 1
        if (action === 'chip') stats.chips++
        // 只有 auto 才允许真的调翻译接口并扣字符 —— 与 guest-inject 的接线一致。
        if (action === 'auto') {
          stats.calls++
          stats.chars += parsed.sourceText.length
          stats.payloads.push(parsed.sourceText)
        }
      }
      return stats
    }
  }
}

// ---------------------------------------------------------------------------
// 用户要求的验收：手动模式（这些是"绝不非预期扣费"的底线，一条都不能松）
// ---------------------------------------------------------------------------

test('验收 1：群聊 manual + 打开群聊 → 0 次请求 / 0 字符', () => {
  const rows = Array.from({ length: 30 }, (_, i) => groupRow('Hello number ' + i, 600 - i, 'A' + i))
  const d = dom(rows)
  const h = makeHarness(d.window.document, { transGroup: false })
  h.scan()
  assert.equal(h.stats.calls, 0, '手动模式打开群聊竟然调了翻译接口')
  assert.equal(h.stats.chars, 0)
  assert.equal(h.stats.actions.auto, undefined, '手动模式不该出现 auto 动作')
})

test('验收 2：manual + 页面已有 100 条历史 → 0 次请求 / 0 字符', () => {
  const rows = Array.from({ length: 100 }, (_, i) => groupRow('历史消息 ' + i, 5000 - i, 'B' + i))
  const d = dom(rows)
  const h = makeHarness(d.window.document, { transGroup: false, includeZh: true })
  h.scan()
  h.scan()
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
  // 直接跑真函数：必须凭 @g.us 判成群
  const kind = chatKindOf(d.window.document)
  assert.equal(kind.group, true, '@g.us 在 #main 里 → 必须判成群')
  assert.equal(kind.evidence.source, 'dataid:g.us', '群聊应凭 @g.us 结构性证据判出')
  // 源码级：@g.us 判据和 #main 作用域都还在
  assert.match(guest, /indexOf\('@g\.us'\)\s*>=\s*0\)\s*\{\s*evidence\.sawGUs = true/,
    'chatKind 必须用 @g.us 作结构性判据')
  assert.match(guest, /querySelector\('#main'\)/,
    'chatKind 必须只扫 #main，不能把左侧会话列表里别的群算进来')
})

test('验收 3：manual + 新收到 10 条 → 全部只给「译」，0 次请求 / 0 字符', () => {
  const d = dom([groupRow('old message', 600, 'D0')])
  // includeZh 打开：中文/英文都算"可翻"，这样才能验证"可翻的消息一律只给按钮"
  const h = makeHarness(d.window.document, { transGroup: false, includeZh: true })
  h.scan()
  // 新到达 10 条：时间戳是"刚刚"
  const html = d.window.document.querySelector('#main').innerHTML
  d.window.document.querySelector('#main').innerHTML = html +
    Array.from({ length: 10 }, (_, i) => groupRow('brand new ' + i, 0, 'N' + i)).join('')
  h.scan()
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
  h.scan()
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
  h.scan()
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
  // 三层保证，缺一不可：
  //   ① addClick 在 host 已有 .pix-trans/.pix-click 时直接 return；
  //   ② scan 的 chip 分支以"没有 .pix-trans"为前提；
  //   ③ chip 自身 busy/done 态拒绝重复点击（见 runManualTranslate）。
  assert.match(guest, /function addClick\(host, incoming, root, span\) \{[\s\S]{0,420}?host\.querySelector\('\.pix-click'\)/,
    'addClick 没有"已经挂过入口就不再挂"的守卫')
  assert.match(guest, /function addClick\(host, incoming, root, span\) \{[\s\S]{0,160}?isMessageHost\(host\)/,
    'addClick 必须先验证宿主是真消息气泡，否则按钮会挂到聊天根/列表根上（译文随之漂移）')
  assert.match(guest, /action === 'chip'\) \{\s*\n\s*.*!host\.querySelector\(':scope > \.pix-trans'\)\) addClick/,
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

test('验收 10：重启客户端后 manual 设置恢复 → 打开群聊仍 0 自动调用', () => {
  // 重启后 transGroup 仍是 false，就一条都不会翻 —— 手动模式不依赖任何运行期状态。
  const rows = Array.from({ length: 60 }, (_, i) => groupRow('after restart ' + i, 9000 - i, 'K' + i))
  const d = dom(rows)
  const h = makeHarness(d.window.document, { transGroup: false })
  h.scan()
  h.scan()
  assert.equal(h.stats.calls, 0)
  assert.equal(h.stats.chars, 0)
})

// ---------------------------------------------------------------------------
// 用户要求的验收：自动模式（0.1.25 新语义 —— 「自动」就该是自动）
// ---------------------------------------------------------------------------

test('验收 7（新语义）：auto + 打开群聊 → 页面上每条可翻消息立刻自动翻，一条「译」都没有', () => {
  const d = dom([groupRow('historic message', 600, 'G0')])
  const h = makeHarness(d.window.document, { transGroup: true })
  h.scan()
  assert.equal(h.stats.actions.chip, undefined,
    '「群聊=自动」下还出现「译」按钮 —— 这正是用户报的"开了自动还要点按钮"')
  assert.equal(h.stats.calls, 1, '打开会话时已经在页面上的消息也要自动翻（用户裁定）')
  assert.deepEqual(h.stats.payloads, ['historic message'])
})

test('验收 8（新语义）：auto + 打开有 500 条历史的群 → 全部自动翻，且 0 个「译」按钮', () => {
  const rows = Array.from({ length: 500 }, (_, i) => groupRow('backlog ' + i, 20000 - i, 'H' + i))
  const d = dom(rows)
  const h = makeHarness(d.window.document, { transGroup: true })
  h.scan()
  assert.equal(h.stats.calls, 500, '「自动」就该把会话里显示的消息全部翻掉（用户 2026-10-11 裁定）')
  assert.equal(h.stats.actions.chip, undefined, '自动模式下不许再给「译」按钮')
  // 注意：这 500 次是**决策次数**，不是扣费次数。同一条消息翻多少次都只计一次费，
  // 见下面「计费上限是没翻过的正文」那条用例。
})

test('验收 8b（新语义）：auto + 滚动补加载更早的历史 → 同样自动翻，不留「译」', () => {
  const d = dom([groupRow('recent', 5, 'I0')])
  const h = makeHarness(d.window.document, { transGroup: true })
  h.scan()
  assert.equal(h.stats.calls, 1)
  // 滚动补加载出 20 条很旧的消息。原有那条仍在页面上（真实滚动就是这样）。
  d.window.document.querySelector('#main').innerHTML =
    Array.from({ length: 20 }, (_, i) => groupRow('older ' + i, 10000 - i, 'I' + (i + 1))).join('') +
    groupRow('recent', 5, 'I0')
  h.scan()
  assert.equal(h.stats.actions.chip, undefined, '滚动出来的历史也不该退化成按钮')
  assert.equal(h.stats.calls, 22, '1（首轮）+ 21（滚动后页面上的全部）')
})

test('验收 9（新语义）：手动 → 自动 切换后，页面上已有的消息立刻开始自动翻', () => {
  const rows = Array.from({ length: 40 }, (_, i) => groupRow('history ' + i, 3000 - i, 'J' + i))
  const d = dom(rows)
  const manual = makeHarness(d.window.document, { transGroup: false })
  manual.scan()
  assert.equal(manual.stats.calls, 0, '手动模式：一条都不许自动翻')
  assert.equal(manual.stats.actions.chip, 40, '手动模式：每条都给「译」')
  // 用户把开关切到「自动」——同一次会话、同一批消息，立刻全部转自动
  const auto = makeHarness(d.window.document, { transGroup: true })
  auto.scan()
  assert.equal(auto.stats.actions.chip, undefined, '切成自动后不该还需要用户点「译」')
  assert.equal(auto.stats.calls, 40, '页面上已有的 40 条要立刻自动翻')
})

test('★计费上限★「全部自动翻」的成本上限是"没翻过的正文"，不是"翻了多少次"', () => {
  // 这是允许删掉历史闸门的**前提**，必须锁住：
  // 客户端 requestId 对同一段正文 + 同一通道是恒定的 → 服务端按 Idempotency-Key
  // 幂等 → 同一条消息翻多少次都只计一次费。少任何一环，删闸门就变成"重复扣费"。
  const at = main.indexOf('function transFingerprint')
  assert.ok(at > 0, '找不到 transFingerprint')
  const fp = main.slice(at, main.indexOf('function transRequestId', at))
  assert.ok(/currentPixUser\(\)/.test(fp), '指纹必须含用户身份（不同子账号不能共用预留）')
  for (const piece of ['engine', 'from', 'to', 'text']) {
    assert.ok(new RegExp('String\\(' + piece + " \\|\\| ''\\)").test(fp),
      '指纹少了 ' + piece + ' —— 换通道/换语种会复用旧号，等于白送一次翻译')
  }
  const idAt = main.indexOf('function transRequestId')
  const idFn = main.slice(idAt, idAt + 400)
  assert.ok(/transAttempt\.get\(fingerprint\) \|\| 0/.test(idFn),
    'requestId 的"代"必须默认复用（只有显式换号才 +1），否则每次重放都会变成新的计费')
  assert.ok(!/Date\.now\(\)|Math\.random\(\)/.test(idFn),
    'requestId 里出现时间/随机数 → 每次重放都是新号 → 幂等失效、重复扣费')

  const server = fs.readFileSync(path.join(root, 'server', 'services', 'core-service.js'), 'utf8')
  assert.ok(/SELECT \* FROM translation_reservations WHERE user_id=\$1 AND idempotency_key=\$2/.test(server),
    '服务端必须按 idempotency_key 查已有预留')
  assert.ok(/if \(existing\) \{[\s\S]{0,900}?return existing/.test(server),
    '服务端命中已有预留后必须直接复用，不能重新扣字符')
  // 换通道重译是**新的一次计费**（厂商侧真花钱），这条不能被我顺手改掉。
  assert.ok(/ENGINE_SWITCH_REQUIRES_NEW_REQUEST/.test(server),
    '换通道重译必须要求新请求号（否则换通道重译不扣费）')
})

// ---------------------------------------------------------------------------
// 私聊：始终自动翻译（与「群聊自动翻译」开关无关）
// ---------------------------------------------------------------------------

test('私聊恒为自动翻译：不受「群组自动/手动」开关影响', () => {
  const base = {
    receiveEnabled: true, translatable: true, emojiOnly: false, hasChinese: false,
    includeZh: false, sameLang: false, group: false, transGroup: false
  }
  assert.equal(MP.messageAction(base), 'auto', '私聊 + 开关=手动 → 仍必须自动翻（私聊始终自动）')
  assert.equal(MP.messageAction(Object.assign({}, base, { transGroup: true })), 'auto')
})

test('群聊跟随「自动/手动」开关（用户要的行为）', () => {
  const base = {
    receiveEnabled: true, translatable: true, emojiOnly: false, hasChinese: false,
    includeZh: false, sameLang: false, group: true, transGroup: false
  }
  assert.equal(MP.messageAction(base), 'chip', '群聊 + 手动 → 只给按钮，绝不自动扣费')
  assert.equal(MP.messageAction(Object.assign({}, base, { transGroup: true })), 'auto',
    '群聊 + 自动 → 自动翻（含打开会话时页面上的那批）')
})

test('★P0★ 中文界面：私聊不能被左侧列表 header 里的「群组」筛选标签判成群', () => {
  const d = domRealistic([directRow('Hello there', 1, 'X1')], { lang: 'zh' })
  const kind = chatKindOf(d.window.document)
  assert.equal(kind.group, false,
    '私聊被判成了群 —— 左侧列表 header 的「群组」筛选标签把人骗了（真机 P0）')
  assert.equal(kind.evidence.source, 'dataid:c.us', '应凭 @c.us 结构性证据判为私聊')
})

test('★P0★ 英文界面：私聊不能被左侧列表 header 里的「Groups」筛选标签判成群', () => {
  const d = domRealistic([directRow('Hello there', 1, 'X2')], { lang: 'en' })
  assert.equal(chatKindOf(d.window.document).group, false, '私聊被判成了群（英文界面同样中招）')
})

test('★P0★ 私聊 + 中文界面 → 必须走自动翻译（这是用户要的行为）', () => {
  const d = domRealistic([directRow('Hello there', 1, 'X3')], { lang: 'zh' })
  const h = makeHarness(d.window.document, { transGroup: false })
  h.scan()
  assert.equal(h.stats.actions.auto, 1,
    '私聊新消息必须自动翻译，实际动作=' + JSON.stringify(h.stats.actions))
  assert.equal(h.stats.actions.chip, undefined, '私聊不该只给「译」按钮（那样用户就得手动点）')
})

// ---------------------------------------------------------------------------
// messageAction 的判定语义
// ---------------------------------------------------------------------------

test('messageAction 的判定顺序与语义', () => {
  const base = {
    receiveEnabled: true, translatable: true, emojiOnly: false, hasChinese: false,
    includeZh: false, sameLang: false, group: true, transGroup: false
  }
  assert.equal(MP.messageAction(base), 'chip', '群聊手动 → 只给按钮')
  assert.equal(MP.messageAction(Object.assign({}, base, { transGroup: true })), 'auto', '群聊自动 → 自动翻')
  assert.equal(MP.messageAction(Object.assign({}, base, { group: false })), 'auto', '一对一会话维持自动')
  assert.equal(MP.messageAction(Object.assign({}, base, { receiveEnabled: false })), 'hide')
  assert.equal(MP.messageAction(Object.assign({}, base, { translatable: false })), 'hide', '纯 URL/图片 → 不给按钮')
  assert.equal(MP.messageAction(Object.assign({}, base, { emojiOnly: true })), 'hide')
  assert.equal(MP.messageAction(Object.assign({}, base, { hasChinese: true })), 'hide', '中文 + includeZh 关闭')
  assert.equal(MP.messageAction(Object.assign({}, base, { hasChinese: true, includeZh: true })), 'chip')
  assert.equal(MP.messageAction(Object.assign({}, base, { sameLang: true })), 'hide')
})

test('「群聊=自动 但历史消息只给按钮」那条闸门必须真的删干净', () => {
  // 只从 messageAction 里删掉那一行是不够的：判据、初始化、导出、状态都得一起走。
  // 留一段不再影响任何决策的"计费闸门"比没有更危险 ——
  // 下一个人会以为它还在保护什么，从而不敢动真正的决策点。
  assert.ok(!/\bhistoryGate\b/.test(guest), 'historyGate 还被引用')
  assert.ok(!/createHistoryGate/.test(guest), 'createHistoryGate 还在（死代码）')
  assert.ok(!/isHistoric/.test(guest), 'isHistoric 还在（死代码）')
  assert.ok(!/s\.historic/.test(guest), 'messageAction 还在消费 historic —— 闸门没删干净')
  const src = grabFn('messageAction')
  assert.ok(/if \(s\.group && !s\.transGroup\) return 'chip'/.test(src),
    '群聊手动 → 只给按钮 这条计费闸门必须保留（它才是防非预期扣费的那一条）')
})

// ---------------------------------------------------------------------------
// 接线：光测纯函数不够，接错了照样扣费 / 照样漏翻
// ---------------------------------------------------------------------------

test('scan() 必须从 chatIdentity() 取身份，且 groupMode 进 CHAT_KIND 指纹', () => {
  const scanAt = guest.indexOf('async function scan()')
  const scan = guest.slice(scanAt, guest.indexOf('function schedule()', scanAt))
  assert.match(scan, /const identity = chatIdentity\(\)/, 'scan 没有用 chatIdentity()')
  assert.match(scan, /if \(identity !== lastScanIdentity\)/, 'scan 没有识别"换会话"')
  assert.match(scan, /const kind = chatKind\(\)/, 'scan 没有用 chatKind()')
  assert.match(scan, /trace\('CHAT_KIND'/, '缺少 CHAT_KIND 取证 —— 本次真机排查只能靠猜就是这个原因')
  assert.match(scan, /group: group,/, 'CHAT_KIND 没记 group 结论')
  assert.match(scan, /evidence: kind\.evidence\.source/, 'CHAT_KIND 没记判据来源')
  // ★ 指纹必须含 groupMode ★
  // 不含的话：用户把「群聊翻译」手动→自动，指纹没变 → 一行 CHAT_KIND 都不再打，
  // 日志永远停在旧的 manual。2026-10-11 排查就卡在这里（日志说 manual，实际在自动翻）。
  assert.match(scan, /const kindKey = identity \+ '\|' \+ group \+ '\|' \+ kind\.evidence\.source \+ '\|' \+ groupModeLabel\(\)/,
    'kindKey 必须含 groupMode，否则模式切换在日志里看不见')
  assert.match(scan, /tabId: prefs\.tabId \|\| '-',/, 'CHAT_KIND 必须记 tabId（多开时要能分清是哪个窗口）')
  // 头部证据的"形状"必须留档，才能在不泄露人名的前提下事后确认判据。
  assert.match(scan, /subtitleShape: kind\.evidence\.subtitleShape/, 'CHAT_KIND 没记副标题形状')
  assert.match(scan, /memberList: kind\.evidence\.memberList/, 'CHAT_KIND 没记成员名单判据')
})

test('翻译接口只在派发池里被调用：scan() 自己不许直接发请求', () => {
  const scanAt = guest.indexOf('async function scan()')
  const scan = guest.slice(scanAt, guest.indexOf('function schedule()', scanAt))
  assert.equal([...scan.matchAll(/translateParsed\(/g)].length, 0,
    'scan() 又变回"扫到一条就 await 一条" —— 打开群聊时会串行翻几十条，用户要盯着"翻一半"看半分钟')
  assert.match(scan, /autoJobs\.push\(/, 'scan() 必须把待翻消息交给派发池')
  assert.match(scan, /enqueueAuto\(autoJobs\)/, 'scan() 必须调用 enqueueAuto')

  const pumpAt = guest.indexOf('function autoPump()')
  assert.ok(pumpAt > 0, '找不到派发池 autoPump()')
  const pump = guest.slice(pumpAt, guest.indexOf('function enqueueAuto', pumpAt))
  assert.equal([...pump.matchAll(/translateParsed\(/g)].length, 1, '派发池里只该有一处 translateParsed 调用')
  assert.match(pump, /translateParsed\(job\.parsed, true, TRIGGER_AUTO\)/, '自动翻译必须打上 auto_receive 标记')
})

test('自动翻译必须是有界并发，且**新的先翻**', () => {
  const pumpAt = guest.indexOf('function autoPump()')
  const pump = guest.slice(pumpAt, guest.indexOf('function enqueueAuto', pumpAt))
  assert.match(pump, /while \(autoRunning < AUTO_POOL_SIZE && autoQueue\.length\)/,
    '没有并发上限 —— 几十条一起打上去会占满连接池（拖慢发送）并撞账号级限流')
  assert.match(guest, /const AUTO_POOL_SIZE = \d+/, '并发上限必须是显式常量，别写成魔法数字')
  const qAt = guest.indexOf('function enqueueAuto(')
  const q = guest.slice(qAt, guest.indexOf('async function scan()', qAt))
  assert.match(q, /for \(let i = jobs\.length - 1; i >= 0; i--\)/,
    '入队必须从后往前（最新的先翻）—— 打开会话时人在底部，眼前那几条要最先出结果')
  assert.match(q, /autoFailedAt\.get\(job\.id\)/,
    '失败消息必须有冷却，否则 scan 每 220ms 一轮会把同一条失败消息反复重发（重试风暴）')
})

test('自动接手时必须收掉手动留下的「译」按钮', () => {
  const scanAt = guest.indexOf('async function scan()')
  const scan = guest.slice(scanAt, guest.indexOf('function schedule()', scanAt))
  assert.match(scan, /action === 'auto'\) \{[\s\S]{0,240}?removeStaleChip\(host\)/,
    'auto 分支没有清理残留的「译」——真机上就是"开了自动还挂着按钮"')
})

test('★不能自激★ paint 内容没变时不许写 DOM', () => {
  // 我们的扫描挂在 MutationObserver 上，而 `textContent = ...` 本身会产生
  // childList 变更 → paint → 变更 → schedule → scan → paint → …
  // 0.1.24 真机日志里同一条消息的渲染 trace 一秒 33 次就是这么来的。
  // 0.1.25 把「自动」扩到整个会话之后，这个循环会被放大到每一条消息。
  const paintAt = guest.indexOf('function paint(')
  const paint = guest.slice(paintAt, guest.indexOf('// ==== MANUAL CHIP BEGIN ====', paintAt))
  assert.match(paint, /box\.textContent === translated[\s\S]{0,900}?return true/,
    'paint 缺少"内容没变就不写 DOM"的守卫 —— 会形成 repaint ↔ MutationObserver 自激循环')
})

// ---------------------------------------------------------------------------
// ★0.1.23 真机 P0★ 私聊被判成群 → 自动翻译整个失效，只能手动点「译」
//
// 真机证据：`trigger=auto_receive` 全天只出现 1 次，其余 180 次全是手动 chip；
// 用户在私聊里也必须一条条点「译」。
//
// 根因：老 isGroupChat() 第一条判据是 `document.querySelector('.ChatInfo, header')`
// —— 查**整个文档**，而 document order 上排在 #main 之前的是**左侧会话列表**的
// header。中文界面的会话列表 header 里有「全部 / 未读 / 收藏 / **群组**」筛选标签，
// 正则命中「群组」→ **每个会话（含私聊）都被判成群** → 私聊自动翻译全部失效。
// ---------------------------------------------------------------------------

test('两种错的代价不对等：@g.us 与 @c.us 同时出现时必须偏向"群"', () => {
  // 把群误判成私聊 → 打开群聊自动翻（现在这是用户要的行为），但会话类型错会让
  // 「群聊=手动」这条唯一的计费闸门失效 —— 所以仍必须偏向"群"。
  const rows = [groupRow('hi', 1, 'G1') + directRow('yo', 2, 'C1')]
  const d = domRealistic(rows, { lang: 'zh' })
  const kind = chatKindOf(d.window.document)
  assert.equal(kind.group, true, '只要出现 @g.us 就必须判群（宁可少翻，不可误扣）')
  assert.equal(kind.evidence.source, 'dataid:g.us')
})

test('#main 内的弱信号（群名含「群组」等）不能盖过 @c.us 硬证据', () => {
  const rows = [directRow('Hello', 1, 'X4')]
  const d = domRealistic(rows, {
    lang: 'en',
    // 连群名/头部文案和 aria-label 都长得像群 —— 结构性证据仍然优先。
    mainHeader: '<header><h1>群组 · Alice</h1></header>',
    extraInsideMain: '<div aria-label="Groups"><span>1 member</span></div>'
  })
  assert.equal(chatKindOf(d.window.document).group, false,
    '有 @c.us 就在 #main 内确定为私聊，弱信号不许翻盘')
})

test('拿不到 #main 时判"私聊"而不是"群"（自动翻译优先，不拿别的会话猜）', () => {
  const d = withInnerText(new JSDOM('<!doctype html><html><body><div id="side"></div></body></html>'))
  const kind = chatKindOf(d.window.document)
  assert.equal(kind.group, false, '没有会话区时应偏向私聊，绝不能靠文档其它部分猜成"群"')
  assert.equal(kind.evidence.inMain, false)
})

test('isGroupChat 用 #main 作用域，不会把左侧列表里别的群算成本会话', () => {
  const fnAt = guest.indexOf('function chatKind()')
  const fn = guest.slice(fnAt, guest.indexOf('function hostOf', fnAt))
  assert.match(fn, /querySelector\('#main'\)/, '没用 #main 限定作用域 —— 这会取到左侧列表')
  assert.ok(!/document\.querySelector\('\.ChatInfo, header'\)/.test(fn),
    '又回到全文档找 .ChatInfo/header 了：中文界面左侧列表 header 里的「群组」筛选标签会让每个私聊都被判成群')
  assert.ok(!/const scope = document\.querySelector\('#main'\) \|\| document/.test(fn),
    '不许再退回整份 document —— 拿不到 #main 就必须判"私聊"（自动翻译优先），不能拿别的会话来猜')
})

// ---------------------------------------------------------------------------
// ★真 DOM★ 自动接手时「译」按钮的清理（0.1.25 真机缺陷）
// ---------------------------------------------------------------------------

test('（真 DOM）切到自动后，手动留下的「译」必须被收掉；busy 态不许动', () => {
  const d = new JSDOM('<!doctype html><html><body><div id="main">' +
    '<div data-id="A1"><div class="copyable-text"><span class="selectable-text">hello</span></div>' +
    '<div class="pix-trans-action-row"><span class="pix-click" data-pix-state="idle">译</span></div></div>' +
    '<div data-id="A2"><div class="copyable-text"><span class="selectable-text">world</span></div>' +
    '<div class="pix-trans-action-row"><span class="pix-click" data-pix-state="busy">翻译中…</span></div></div>' +
    '</div></body></html>')
  const doc = d.window.document
  const removeStaleChip = new Function('document', 'isMessageHost', 'host',
    grabFn('removeStaleChip') + '\nreturn removeStaleChip(host)')
  const idleHost = doc.querySelector('[data-id="A1"]')
  const busyHost = doc.querySelector('[data-id="A2"]')
  assert.equal(removeStaleChip(doc, () => true, busyHost), 0,
    'busy 态被收掉了 —— 会把用户点出来的那次翻译半途掐死')
  assert.equal(busyHost.querySelector('.pix-click').textContent, '翻译中…')
  assert.equal(removeStaleChip(doc, () => true, idleHost), 1)
  assert.equal(idleHost.querySelector('.pix-click'), null, 'idle 的「译」必须被收掉')
  assert.equal(idleHost.querySelector('.pix-trans-action-row'), null,
    '空掉的操作行要一起收掉，别留一条空白行把气泡撑高')
  void doc
})

// ---------------------------------------------------------------------------
// ★0.1.24★ 真机 DOM 回归 —— 这一节是"0.1.23 为什么修错"的答案。
//
// 0.1.23 的判据是 `main.querySelector('[data-testid*="group" i], [aria-label*="group" i]')`
// —— 扫**整个 #main**，而 #main 里除了头部还装着**消息**。
//
// 真机探针（desktop/scripts/_probe-wa-dom2.js）在用户会话上抓到的实测结构：
//   · data-id 是**纯消息哈希**（`3EB0F866490405692F3C`），不含 @c.us/@g.us；
//     `jidHitCount = 0` —— 整个 document 里 @c.us/@g.us 出现 0 次。
//   · 7 条消息带 WhatsApp **群邀请链接** → 渲染出链接预览卡片，内含
//     `button[data-testid="group-invite-link-action"]` + `title="Join group"`。
//   · 于是 `#main` 内 `[data-testid*="group"]` **恒为真** → 私聊被判成群
//     → 自动翻译被整个关掉（真机现象：`auto_receive` 全天只有 1 次）。
//
// 这一节用**真结构**（真 testid、真 data-id 形状）锁死：
// 消息区的任何 group 字样都不许再影响会话类型判定。
// ---------------------------------------------------------------------------

/** 真机头部结构（复刻自探针输出；人名一律用占位符，避免把 PII 写进仓库）。 */
function realHeader (subtitle) {
  return '<header data-testid="conversation-header"><div>' +
    '<div aria-label="Avatar" title="Avatar" role="button"><div><img/></div></div>' +
    '<div role="button" data-testid="conversation-info-header"><div><div>' +
    '<div data-testid="conversation-info-header-chat-title-name"><div><div>' +
    '<span data-testid="you-label">You: </span>' +
    '</div></div></div>' +
    '<div><span data-testid="conversation-info-header-chat-title">Some Chat</span></div>' +
    '</div></div>' +
    '<div data-testid="chat-subtitle"><span data-testid="selectable-text" title="' + subtitle + '">' +
    subtitle + '</span></div>' +
    '</div></div>' +
    '<div><div><span><div><button aria-label="Search">Search</button></div></span></div></div>' +
    '</header>'
}

/** 真机消息行（data-id 是纯哈希；含群邀请链接预览卡片）。 */
function realInviteRow (id) {
  return '<div class="focusable-list-item" data-id="' + id + '" data-testid="conv-msg-' + id + '">' +
    '<div data-testid="msg-container"><div class="copyable-text">' +
    '<span class="selectable-text copyable-text" dir="ltr">Join this group https://chat.whatsapp.com/XXXXXXXX</span>' +
    '<div data-testid="link-preview-container"><div data-testid="url-element">' +
    '<div data-testid="link-preview-title"><span title="Join this group">Join this group</span></div>' +
    '<button data-testid="group-invite-link-action" title="Join group">Join group</button>' +
    '</div></div>' +
    '<div data-testid="msg-meta"><span>3:25 PM</span></div>' +
    '</div></div></div>'
}

/** 复刻真机整页：侧栏（含 Groups 筛选）+ #main（真头部 + 真消息行）。 */
function waRealistic (subtitle, rows) {
  const sidebar = '<div id="side"><div id="pane-side">' +
    '<header data-testid="chatlist-header"><span>All</span><span>Unread</span><span>Favourites</span><span>Groups</span></header>' +
    '<div data-testid="filter-button">Groups</div>' +
    '<div data-testid="chat-list"><div data-testid="cell-frame-container"><span data-testid="cell-frame-title">Some Group</span></div></div>' +
    '</div></div>'
  return withInnerText(new JSDOM('<!doctype html><html><body>' + sidebar +
    '<div id="main">' + realHeader(subtitle) + '<div data-testid="conversation-panel-messages">' +
    rows.join('') + '</div></div></body></html>'))
}

test('★P0 真机回归★ 会话里有群邀请链接预览时，私聊绝不能被判成群', () => {
  const rows = [realInviteRow('3EB0F866490405692F3C'), realInviteRow('3EB0DD27492B60B3EEAEB3')]
  const d = waRealistic('Message yourself', rows)
  const kind = chatKindOf(d.window.document)
  assert.equal(kind.group, false,
    '私聊里有群邀请链接 → 被 #main 内消息区的 group-invite-link-action 骗判成"群"（真机 P0）')
  assert.equal(kind.evidence.headerMarker, false,
    '头部才该被搜 group 字样；消息区的链接预览不算头部证据')
  assert.equal(kind.evidence.sawCUs, false, '真机 data-id 是纯哈希，本来就不该出现 @c.us')
  assert.equal(kind.evidence.sawGUs, false, '真机 data-id 是纯哈希，本来就不该出现 @g.us')
})

test('★P0 真机回归★ 上述私聊必须走自动翻译（用户要的行为），不能被群规则拦掉', () => {
  const d = waRealistic('Message yourself', [realInviteRow('3EB0F866490405692F3C')])
  const h = makeHarness(d.window.document, { transGroup: false })
  h.scan()
  assert.equal(h.stats.actions.auto, 1,
    '私聊必须自动翻译，实际动作=' + JSON.stringify(h.stats.actions))
  assert.equal(h.stats.actions.chip, undefined, '不该退化成手动「译」按钮')
})

test('消息区的 group 字样（链接预览/按钮/群名）一律不参与判定', () => {
  const rows = [
    realInviteRow('3EB0F866490405692F3C'),
    '<div data-id="3EB0DD27492B60B3EEAEB3"><div data-testid="msg-container">' +
    '<div class="copyable-text"><span class="selectable-text">Group members list</span></div>' +
    '<div aria-label="Open group info"><span>1 member</span></div></div></div>'
  ]
  const d = waRealistic('online', rows)
  assert.equal(chatKindOf(d.window.document).group, false,
    '消息正文/预览里的 group、members 都不能把私聊判成群')
})

// ⚠ 待真机确认的启发式：这条不是"已验证的真机行为"，而是 0.1.24 新加的判据，
// 需要真机跑一次群聊才能确认 WhatsApp 群的副标题确实长这样。若真机推翻，改这里而不是改代码绕过。
test('（待真机确认）群聊正判候选：头部副标题是成员名单（You, Alice, Bob）→ 判群', () => {
  const d = waRealistic('You, Alice, Bob', [realInviteRow('3EB0F866490405692F3C')])
  const kind = chatKindOf(d.window.document)
  assert.equal(kind.group, true, '群聊副标题是逗号分隔的成员名单，应判成群')
  assert.equal(kind.evidence.memberList, true)
  assert.equal(kind.evidence.source, 'header-member-list')
})

test('（待真机确认）群聊正判候选：头部副标题是「N members」→ 判群', () => {
  const d = waRealistic('12 members', [])
  const kind = chatKindOf(d.window.document)
  assert.equal(kind.group, true, '副标题写 N members 应判成群')
  assert.ok(/members/.test(kind.evidence.subtitleShape) || kind.evidence.memberList || kind.evidence.headerText,
    '证据要能看出是成员数：' + JSON.stringify(kind.evidence))
})

test('（待真机确认）私聊正判候选：副标题是在线状态（online / last seen）→ 绝不判群', () => {
  for (const sub of ['online', 'last seen today at 3:25 PM', 'click here for contact info']) {
    const d = waRealistic(sub, [realInviteRow('3EB0F866490405692F3C')])
    assert.equal(chatKindOf(d.window.document).group, false, '私聊在线状态被误判成群：' + sub)
  }
})

test('真机 data-id 形状（纯哈希）下，私聊默认就是私聊（不靠 @c.us 兜底）', () => {
  const d = waRealistic('online', [realInviteRow('3AA9E3543D377EB89684')])
  const kind = chatKindOf(d.window.document)
  assert.equal(kind.group, false)
  assert.equal(kind.evidence.inMain, true, '确实读到了 #main（不是"没读到就默认私聊"）')
  assert.equal(kind.evidence.source, 'none', '没有头部证据时应明确记为 none，别假装有证据')
})

test('判定只在头部搜 group 字样（源码锁：不许再出现扫整个 #main 的 group 选择器）', () => {
  const at = guest.indexOf('function chatKind()')
  const fn = guest.slice(at, guest.indexOf('function isGroupChat()', at))
  assert.ok(fn.indexOf('header.querySelectorAll') > 0, '群标记必须限定在 header 内查找')
  assert.ok(fn.indexOf("main.querySelector('[data-testid*=\"group\" i]") < 0,
    '又出现了扫整个 #main 的 group 选择器 —— 群邀请链接会再次把私聊判成群')
})

// ---------------------------------------------------------------------------
// ★Telegram★ —— 页面里**没有** #main，另走一条分支
// ---------------------------------------------------------------------------
//
// 修复前的缺陷：`chatKind()` 只认 WhatsApp 的 `#main`，拿不到就恒返回"私聊"。
// 于是 Telegram 上 `messageAction` 拿到的 `group` 永远是 false ——
// 「群聊翻译 = 手动」那条**唯一的计费闸门**永不命中，用户把群聊设成手动，
// 群消息照样全自动翻译、照样扣字符。这组用例锁死这个行为。

/**
 * Telegram Web A 整页：**没有 #main**。
 * 会话类型只能从 URL hash 的 peer id 符号 / `.ChatInfo` 的成员数文案拿。
 */
function tgDom (rows, opts) {
  const o = opts || {}
  const peer = o.peer === undefined ? '123456789' : o.peer
  const info = o.chatInfo === false
    ? ''
    : '<div class="ChatInfo">' +
        '<div class="title">' + (o.title || 'Peer') + '</div>' +
        '<div class="subtitle">' + (o.subtitle === undefined ? 'online' : o.subtitle) + '</div>' +
      '</div>'
  // 左侧会话列表照样塞一个"群"，证明判据不会被列里的别的东西带跑。
  const sidebar = '<div id="column-left"><div class="chat-list-item">' +
    '<span>Some Group</span><span>1 234 members</span></div></div>'
  const html = '<!doctype html><html><body>' + sidebar +
    '<div id="MiddleColumn">' + info + rows.join('') + '</div>' +
    '</body></html>'
  return withInnerText(new JSDOM(html, { url: 'https://web.telegram.org/a/#' + peer }))
}

/** Telegram Web A 消息行：`.message-list-item > .text-content > .translatable-message`。 */
function tgRow (body, id) {
  return '<div class="message-list-item" data-message-id="' + (id || 'T1') + '">' +
    '<div class="text-content">' +
    '<div class="message-author-title">Bob</div>' +
    '<div class="translatable-message">' + body + '</div>' +
    '<span class="MessageMeta"><span class="message-time">10:31</span></span>' +
    '</div></div>'
}

test('Telegram：群 / 频道的 peer id 是负数 → 必须判成群（结构性硬证据）', () => {
  const d = tgDom([tgRow('Hello there', 'G1')], { peer: '-1001234567890' })
  const kind = chatKindOf(d.window.document)
  assert.equal(kind.group, true, 'Telegram 群被漏判成私聊 —— 群聊翻译开关又失效了')
  assert.equal(kind.evidence.platform, 'telegram')
  assert.equal(kind.evidence.negativePeer, true)
  assert.equal(kind.evidence.source, 'peer:negative')
})

test('Telegram：个人 peer id 是正数 → 判私聊（私聊始终自动翻译）', () => {
  const d = tgDom([tgRow('Hello there', 'D1')], { peer: '123456789' })
  const kind = chatKindOf(d.window.document)
  assert.equal(kind.group, false, '个人 id 被判成了群 —— 私聊的自动翻译会被关掉')
  assert.equal(kind.evidence.source, 'peer:positive')
})

test('Telegram：公开群（#@username）靠 .ChatInfo 成员数文案判群，但必须带数字', () => {
  const group = tgDom([tgRow('Hello there', 'P1')], { peer: '@somepublicgroup', subtitle: '1 234 members, 56 online' })
  const gk = chatKindOf(group.window.document)
  assert.equal(gk.group, true, '公开群的成员数文案没被识别')
  assert.equal(gk.evidence.source, 'header-members')

  // ★没有数字就不许判群★ —— 否则一个恰好叫 "Members" 的私聊会被判成群，
  // 那是 0.1.23 那次"左栏筛选标签把私聊判成群" P0 的同类错误。
  const fake = tgDom([tgRow('Hello there', 'P2')], { peer: '@alice', subtitle: 'Members' })
  assert.equal(chatKindOf(fake.window.document).group, false,
    '私聊副标题里出现 members 但没有数字，不该判成群')

  // 频道（subscribers）也是群聊语义：同样要按"手动"闸门走。
  const channel = tgDom([tgRow('Hello there', 'P3')], { peer: '@somechannel', subtitle: '9 subscribers' })
  assert.equal(chatKindOf(channel.window.document).group, true, '频道应判成群（有 subscribers 计数）')
})

test('Telegram：私聊的在线的状态文案（online / last seen）绝不判群', () => {
  for (const sub of ['online', 'last seen recently', 'last seen today at 10:31']) {
    const d = tgDom([tgRow('Hello there', 'D2')], { peer: '@alice', subtitle: sub })
    assert.equal(chatKindOf(d.window.document).group, false, '私聊在线状态被误判成群：' + sub)
  }
})

test('Telegram：消息区里的 members / 群名字样一律不参与会话类型判定', () => {
  const d = tgDom([
    tgRow('We are 1 234 members in this group', 'M1') + tgRow('Join our subscribers channel', 'M2')
  ], { peer: '@alice', subtitle: 'online' })
  assert.equal(chatKindOf(d.window.document).group, false,
    '消息正文里的 members 把私聊判成群了 —— 会话类型绝不能看消息区')
})

test('Telegram：拿不到任何证据时判"私聊"（不拿别的会话猜）', () => {
  const d = tgDom([], { peer: '@alice', chatInfo: false })
  const kind = chatKindOf(d.window.document)
  assert.equal(kind.group, false)
  assert.equal(kind.evidence.source, 'none', '证据不足时必须明确记为 none，别假装有证据')
})

// ---------------------------------------------------------------------------
// ★验收：Telegram 群聊 = 手动 → 0 次请求 / 0 字符（这是修复前必挂的那条）★
// ---------------------------------------------------------------------------

test('★修复前必挂★ Telegram 群聊 + 手动 → 0 次请求 / 0 字符', () => {
  const rows = Array.from({ length: 20 }, (_, i) => tgRow('Hello number ' + i, 'TG' + i))
  const d = tgDom(rows, { peer: '-1001234567890' })
  const h = makeHarness(d.window.document, { transGroup: false, includeZh: true })
  h.scan()
  assert.equal(h.stats.calls, 0, 'Telegram 群聊在手动模式下竟然调了翻译接口（修复前就是这个现象）')
  assert.equal(h.stats.chars, 0)
  assert.equal(h.stats.actions.auto, undefined, '手动模式不该出现 auto 动作')
  assert.equal(h.stats.actions.chip, 20, '群聊手动模式应给每一条都挂「译」按钮')
})

test('Telegram 群聊 + 自动 → 全部自动翻（含打开会话时页面上的那批）', () => {
  const rows = Array.from({ length: 20 }, (_, i) => tgRow('Hello number ' + i, 'TA' + i))
  const d = tgDom(rows, { peer: '-1001234567890' })
  const h = makeHarness(d.window.document, { transGroup: true, includeZh: true })
  h.scan()
  assert.equal(h.stats.actions.auto, 20)
  assert.equal(h.stats.actions.chip, undefined, '开了自动就不该再挂「译」按钮')
  assert.equal(h.stats.calls, 20)
})

test('Telegram 私聊 → 始终自动翻译（与「群聊翻译」开关无关）', () => {
  const d = tgDom([tgRow('Hello there', 'DP1')], { peer: '123456789' })
  const h = makeHarness(d.window.document, { transGroup: false, includeZh: true })
  h.scan()
  assert.equal(h.stats.actions.auto, 1, '私聊必须自动翻译，用户不该手动点「译」')
  assert.equal(h.stats.actions.chip, undefined)
})

test('源码锁：Telegram 判据必须用 peer id 符号，且只读 .ChatInfo（不扫消息区）', () => {
  const at = guest.indexOf('function chatKind()')
  const fn = guest.slice(at, guest.indexOf('function isGroupChat()', at))
  assert.ok(fn.includes('^-\\d{4,}$'), 'chatKind 必须用"负号 peer id = 群"作 Telegram 的结构性判据')
  assert.ok(fn.indexOf("querySelector('.ChatInfo')") > 0, 'Telegram 的头部证据必须限定在 .ChatInfo 内查找')
  assert.ok(fn.indexOf("document.querySelector('.ChatInfo, header')") < 0,
    '又回到全文档找 .ChatInfo/header 了 —— 那个 P0 就是这么来的')
  assert.ok(!/querySelector(All)?\(\s*['"][^'"]*(message-list-item|text-content)/.test(fn),
    'chatKind 不许把消息区选择器当判据（消息正文里的 members 会把私聊判成群）')
})
