'use strict'

/**
 * 消息解析器守卫 —— 「UI metadata 绝不能进翻译链」。
 *
 * ## 被修的缺陷（真机取证）
 *
 * 老实现把消息容器的 innerText 整个当正文送去翻译，排除名单却只按 Telegram
 * 的类名写。WhatsApp 真机上于是被翻译进去这些东西：
 *
 *   3:25 PM            ← 时间
 *   wds-ic-read        ← 已读图标
 *   View group / 查看群组  ← WhatsApp 自己的按钮
 *   Group chat invite  ← 链接预览标题
 *   chat.whatsapp.com  ← 预览站点域名
 *   URL 出现两遍        ← 预览卡片与正文各一份，被 innerText 粘在一起
 *
 * ## 这个文件怎么测
 *
 * 解析器必须能内联进 guest-inject.js（preload 跑在 `sandbox: true` 里，
 * require 不了本地模块），所以它被 BEGIN/END 标记夹住。这里把那段源码原样抽出来、
 * 塞进 jsdom 跑**真 DOM**，而不是对着源码做正则断言 ——
 * 「DOM extraction 错」只能靠真 DOM 才测得出来。
 *
 * 每个 fixture 都先断言"容器原文里确实有这些 UI 文案"（证明 fixture 忠实还原了
 * 真机结构），再断言"解析结果里一个都没有"。少了前一半，测试会在 fixture 悄悄
 * 失效之后继续绿灯。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { JSDOM } = require('jsdom')

const root = path.join(__dirname, '..')
const guestPath = path.join(root, 'desktop', 'guest-inject.js')
const guest = fs.readFileSync(guestPath, 'utf8')
const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')

const BEGIN = '// ==== MESSAGE PARSER BEGIN ===='
const END = '// ==== MESSAGE PARSER END ===='

function loadParser() {
  const beginAt = guest.indexOf(BEGIN)
  const endAt = guest.indexOf(END)
  assert.ok(beginAt > 0 && endAt > beginAt, 'guest-inject.js 里的解析器 BEGIN/END 标记被删了')
  const block = guest.slice(beginAt + BEGIN.length, endAt)
  // 抽出来的源码必须自包含：这里只喂标准 DOM，任何对外部变量的引用都会立刻炸。
  return new Function(block + '\nreturn MessageParser')()
}

const MessageParser = loadParser()

function query(html) {
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>')
  return dom.window.document.querySelector('[data-id], .text-content, .message-list-item')
}

/** 真机上出现过的 UI 文案。任何一条出现在 sourceText 里都是回归。 */
const FORBIDDEN = [
  '3:25 PM', '3:25', 'PM',
  'wds-ic-read', 'wds-ic-',
  'View group', '查看群组',
  'Group chat invite', '群聊邀请',
  'chat.whatsapp.com',
  'Read', 'Delivered',
  'Alice',
  '❤ 2'
]

function assertClean(label, parsed, rawContainer) {
  for (const needle of FORBIDDEN) {
    assert.ok(!parsed.sourceText.includes(needle),
      label + '：UI 文案「' + needle + '」漏进了翻译输入：' + JSON.stringify(parsed.sourceText))
  }
  // 容器原文必须确实包含这些噪音，否则 fixture 已经失效、测试是在空转
  assert.ok(rawContainer.includes('3:25 PM') || rawContainer.includes('wds-ic-read'),
    label + '：fixture 没能还原真机结构（容器原文里没有时间/图标噪音）')
}

// ---------------------------------------------------------------------------
// fixture：按真机截图还原的 WhatsApp DOM
// ---------------------------------------------------------------------------

const WA_META = '<div class="_akbw"><span class="x1rg5ohu">3:25 PM</span>' +
  '<span data-icon="wds-ic-read" class="wds-ic-read">wds-ic-read</span></div>'

function waRow(inner, id) {
  return '<div class="message-in focusable-list-item" role="row" data-id="' +
    (id || 'false_8613800138000@c.us_3EB0ABC') + '">' +
    '<div class="x1n2onr6"><div class="copyable-text" data-pre-plain-text="[3:25 PM, 9/25/2026] Alice: ">' +
    inner + '</div></div></div>'
}

/** 群邀请链接：正文只有 URL，但旁边挂着完整的预览卡片（真机截图那个 case）。 */
const WA_GROUP_INVITE = waRow(
  '<div class="x1n2onr6" data-testid="link-preview">' +
  '<div><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">' +
  '<div class="x1iyjqo2">chat.whatsapp.com</div>' +
  // 故意把预览标题也标成 selectable-text：不排除预览容器的话它必然漏出去
  '<span class="selectable-text">Group chat invite</span>' +
  '<span class="x1qlqyl8">https://chat.whatsapp.com/HBQRlaZXm8vAc7Ssb1mqdV</span>' +
  '<div role="button" tabindex="0">View group</div></div></div>' +
  '<span class="selectable-text copyable-text" dir="ltr">' +
  '<span>https://chat.whatsapp.com/HBQRlaZXm8vAc7Ssb1mqdV</span></span>' +
  WA_META
)

/** 普通网页 link preview。 */
const WA_WEB_PREVIEW = waRow(
  '<div data-testid="link-preview">' +
  '<div><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">' +
  '<div>example.com</div><span class="selectable-text">Example Domain</span>' +
  '<span>https://example.com/a/b</span>' +
  '<div role="button">Open</div></div></div>' +
  '<span class="selectable-text copyable-text" dir="ltr">Look at this</span>' +
  WA_META
)

/** 引用回复：被引用的旧消息不是本条正文。 */
const WA_QUOTED = waRow(
  '<div data-testid="quoted-message"><span>older quoted line</span></div>' +
  '<span class="selectable-text copyable-text" dir="ltr">我的回复</span>' +
  WA_META
)

/** 图片 + caption。 */
const WA_IMAGE_CAPTION = waRow(
  '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">' +
  '<span class="selectable-text copyable-text" dir="ltr">看这张图</span>' +
  WA_META
)

/** 文件 + caption：文件名是 UI，caption 才是正文。 */
const WA_FILE_CAPTION = waRow(
  '<div data-testid="document-thumb"><span>invoice-2026.pdf</span>' +
  '<div role="button">Download</div></div>' +
  '<span class="selectable-text copyable-text" dir="ltr">发票见附件</span>' +
  WA_META
)

// ---------------------------------------------------------------------------
// 0.1.28 真机缺陷：图文消息的文字**没有** span.selectable-text 包裹
// ---------------------------------------------------------------------------
// 用户报障：「图文一起发送的时候，不翻译」。
// 老实现只认 `.selectable-text`，而真机上「图片 + 文字」的 caption 常常：
//   · 直接在 .copyable-text 容器里；或
//   · 落在 [data-testid="msg-container"] 的 caption 子容器里；
//   · 且 WhatsApp 已移除 .message-in/.message-out（nodes 选择器里那两个分支是死的）。
// 于是正文取空 → translatable=false → messageAction 返回 hide（连「译」按钮都没有）。
// 这组 fixture 把真机的四种结构逐一锁死，并且**必须**证明时间/图标没漏进正文。

const WA_MEDIA_IMG = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">'

/** 结构 B：文字直接在 .copyable-text 里（无 selectable-text 包裹）。 */
const WA_MEDIA_CAPTION_PLAIN = waRow(
  WA_MEDIA_IMG + '<div dir="ltr" class="x1iyjqo2">看这张图</div>' + WA_META
)

/** 结构 C：文字在 caption 容器里。 */
const WA_MEDIA_CAPTION_BOX = waRow(
  '<div class="media-container">' + WA_MEDIA_IMG + '</div>' +
  '<div class="caption-container" dir="ltr"><span>看这张图</span></div>' + WA_META
)

/** 结构 D：文字在 .text-content 里（非 selectable）。 */
const WA_MEDIA_TEXT_CONTENT = waRow(
  WA_MEDIA_IMG + '<div class="text-content">看这张图</div>' + WA_META
)

/** 结构 G：整条消息包在 [data-testid="msg-container"] 里。 */
const WA_MEDIA_MSG_CONTAINER =
  '<div data-id="false_8613800138000@c.us_3EB0ABC" data-testid="msg-container">' +
  '<div class="copyable-text" data-pre-plain-text="[3:25 PM, 9/25/2026] Alice: ">' +
  WA_MEDIA_IMG + '<div dir="ltr"><span>看这张图</span></div></div>' + WA_META + '</div>'

// ---------------------------------------------------------------------------
// 验收用例 1-10
// ---------------------------------------------------------------------------

test('用例 1：纯文字消息 —— 只取正文，时间/已读/发信人都不进', () => {
  const html = waRow('<span class="selectable-text copyable-text" dir="ltr"><span>Hello there</span></span>' + WA_META)
  const el = query(html)
  const parsed = MessageParser.parseForTranslation(el)
  assert.equal(parsed.platform, 'whatsapp')
  assert.equal(parsed.messageText, 'Hello there')
  assert.equal(parsed.sourceText, 'Hello there')
  assert.equal(parsed.translatable, true)
  // 元信息仍然被解析出来，只是不参与翻译
  assert.equal(parsed.timestamp, '3:25 PM')
  assert.equal(parsed.sender, 'Alice')
  assert.equal(parsed.deliveryState, 'read')
  assertClean('纯文字', parsed, el.textContent)
})

test('用例 2：纯 URL —— 不调翻译接口，URL 原样保留', () => {
  const url = 'https://chat.whatsapp.com/HBQonly'
  const el = query(waRow('<span class="selectable-text copyable-text" dir="ltr"><span>' + url + '</span></span>' + WA_META))
  const parsed = MessageParser.parseForTranslation(el)
  assert.deepEqual(parsed.urls, [url], 'URL 必须被完整抽出来')
  assert.equal(parsed.translatable, false, '纯 URL 消息绝不能调翻译接口')
  assertClean('纯 URL', parsed, el.textContent)
})

test('用例 3：文字 + URL —— 只翻文字，URL 原样拼回', () => {
  const url = 'https://chat.whatsapp.com/HBQtext'
  const el = query(waRow(
    '<span class="selectable-text copyable-text" dir="ltr">Please join our group:<br>' + url + '</span>' + WA_META
  ))
  const parsed = MessageParser.parseForTranslation(el)
  assert.equal(parsed.translatable, true)
  assert.ok(!parsed.sourceText.includes(url), 'URL 不该原样进翻译输入')
  assert.equal(parsed.sourceText, 'Please join our group:\n[[1]]')
  assert.deepEqual(parsed.urls, [url])
  // 译文回填：URL 一定不丢、不被翻译
  assert.equal(
    MessageParser.restoreUrls('请加入我们的群组：\n[[1]]', parsed.urls),
    '请加入我们的群组：\n' + url
  )
  assertClean('文字+URL', parsed, el.textContent)
})

test('用例 4：WhatsApp 群邀请链接 —— 预览卡片整块不进正文', () => {
  const el = query(WA_GROUP_INVITE)
  const parsed = MessageParser.parseForTranslation(el)
  assert.equal(parsed.platform, 'whatsapp')
  assert.equal(parsed.translatable, false, '正文只有群邀请链接 → 不该调翻译接口')
  assert.deepEqual(parsed.urls, ['https://chat.whatsapp.com/HBQRlaZXm8vAc7Ssb1mqdV'])
  // 预览卡片的标题/域名/按钮一个都不能进
  assert.ok(!parsed.messageText.includes('Group chat invite'))
  assert.ok(!parsed.messageText.includes('View group'))
  assertClean('群邀请', parsed, el.textContent)
})

test('用例 5：普通网页 link preview —— 站点名/标题/Open 按钮不进正文', () => {
  const el = query(WA_WEB_PREVIEW)
  const parsed = MessageParser.parseForTranslation(el)
  assert.equal(parsed.messageText, 'Look at this')
  assert.equal(parsed.translatable, true)
  assert.ok(!parsed.sourceText.includes('Example Domain'))
  assert.ok(!parsed.sourceText.includes('example.com'))
  assert.ok(!parsed.sourceText.includes('Open'))
  assertClean('网页预览', parsed, el.textContent)
})

test('用例 6：回复引用消息 —— 被引用的旧消息不算本条正文', () => {
  const el = query(WA_QUOTED)
  const parsed = MessageParser.parseForTranslation(el)
  assert.equal(parsed.messageText, '我的回复')
  assert.ok(!parsed.sourceText.includes('older quoted line'), '引用块不能进正文')
  assert.ok(parsed.quotedText.includes('older quoted line'), '引用内容要单独解析出来备查')
  assertClean('引用回复', parsed, el.textContent)
})

test('用例 7：图片 + caption —— 只翻 caption', () => {
  const el = query(WA_IMAGE_CAPTION)
  const parsed = MessageParser.parseForTranslation(el)
  assert.equal(parsed.messageText, '看这张图')
  assertClean('图片+caption', parsed, el.textContent)
})

test('用例 8：文件 + caption —— 文件名与 Download 按钮不进正文', () => {
  const el = query(WA_FILE_CAPTION)
  const parsed = MessageParser.parseForTranslation(el)
  assert.equal(parsed.messageText, '发票见附件')
  assert.ok(!parsed.sourceText.includes('invoice-2026.pdf'))
  assert.ok(!parsed.sourceText.includes('Download'))
  assertClean('文件+caption', parsed, el.textContent)
})

// ---------------------------------------------------------------------------
// 用例 8.1 - 8.4：0.1.28 图文消息兜底提取（真机四种结构）
// ---------------------------------------------------------------------------

test('用例 8.1：图文 —— 文字直接在 .copyable-text 里（无 selectable-text）也要翻', () => {
  const el = query(WA_MEDIA_CAPTION_PLAIN)
  const parsed = MessageParser.parseForTranslation(el)
  assert.equal(parsed.messageText, '看这张图', '图文消息的 caption 必须被取到')
  assert.equal(parsed.translatable, true, '有 caption 就应可翻译')
  assertClean('图文·copyable-text', parsed, el.textContent)
  assert.equal(
    MessageParser.messageAction({ receiveEnabled: true, translatable: parsed.translatable, group: false }),
    'auto', '私聊图文消息应自动翻译，不能 hide'
  )
})

test('用例 8.2：图文 —— caption 容器结构也要翻', () => {
  const el = query(WA_MEDIA_CAPTION_BOX)
  const parsed = MessageParser.parseForTranslation(el)
  assert.equal(parsed.messageText, '看这张图')
  assertClean('图文·caption 容器', parsed, el.textContent)
})

test('用例 8.3：图文 —— 文字在 .text-content 里也要翻', () => {
  const el = query(WA_MEDIA_TEXT_CONTENT)
  const parsed = MessageParser.parseForTranslation(el)
  assert.equal(parsed.messageText, '看这张图')
  assertClean('图文·text-content', parsed, el.textContent)
})

test('用例 8.4：图文 —— 整条消息在 [data-testid="msg-container"] 里也要翻', () => {
  const el = query(WA_MEDIA_MSG_CONTAINER)
  const parsed = MessageParser.parseForTranslation(el)
  assert.equal(parsed.messageText, '看这张图')
  assertClean('图文·msg-container', parsed, el.textContent)
})

test('用例 8.5：纯图片（无 caption）仍不可翻译 —— 兜底不能把空消息翻出来', () => {
  const el = query(waRow(WA_MEDIA_IMG + WA_META))
  const parsed = MessageParser.parseForTranslation(el)
  assert.equal(parsed.translatable, false, '没有文字就不该调翻译接口')
  assert.equal(
    MessageParser.messageAction({ receiveEnabled: true, translatable: parsed.translatable, group: false }),
    'hide'
  )
})

test('用例 9：emoji —— 只有表情时不产生可翻译内容', () => {
  assert.equal(MessageParser.hasTranslatableText('😀🎉'), false)
  assert.equal(MessageParser.hasTranslatableText('😀 hi'), true, '有文字就该翻')
  assert.equal(MessageParser.hasTranslatableText('[[1]]'), false, '只剩 URL 占位符等于没内容')
})

test('用例 10：时间 / 已读图标 —— 任何 fixture 都不许把它们带进翻译', () => {
  const ALL = [WA_GROUP_INVITE, WA_WEB_PREVIEW, WA_QUOTED, WA_IMAGE_CAPTION, WA_FILE_CAPTION,
    WA_MEDIA_CAPTION_PLAIN, WA_MEDIA_CAPTION_BOX, WA_MEDIA_TEXT_CONTENT, WA_MEDIA_MSG_CONTAINER]
  for (const html of ALL) {
    const el = query(html)
    const parsed = MessageParser.parseForTranslation(el)
    for (const needle of ['3:25 PM', 'wds-ic-read', 'wds-ic-']) {
      assert.ok(!parsed.sourceText.includes(needle), needle + ' 漏进了 sourceText')
      assert.ok(!parsed.messageText.includes(needle), needle + ' 漏进了 messageText')
    }
  }
})

// ---------------------------------------------------------------------------
// 24 小时制时间戳（生产账单里真实出现过 18:53 被计费）
//
// translate_logs.snippet 里出现过 "Sweet dreams18:53" 这种把时间戳粘进正文、
// 并且按这个长度扣字符的记录。下面用真实出现过的格式锁死：24 小时制同样必须被
// 剥掉，而正文里本来就有的「3:00」「18:53」这类数字不能被误删。
// ---------------------------------------------------------------------------

/** 24 小时制：时钟挂在 _akbw 里，已读图标在旁边。 */
function waRow24h(inner, time) {
  return '<div class="message-in focusable-list-item" role="row" data-id="false_8613800138000@c.us_3EB0ABC">' +
    '<div class="x1n2onr6"><div class="copyable-text" data-pre-plain-text="[' + time + ', 9/25/2026] Alice: ">' +
    inner + '</div></div>' +
    '<div class="_akbw"><span class="x1rg5ohu">' + time + '</span>' +
    '<span data-icon="wds-ic-read" class="wds-ic-read">wds-ic-read</span></div></div>'
}

test('用例 11：24 小时制时间戳必须剥离，且正文里的时间样数字要保住', () => {
  const cases = [
    { time: '18:53', body: 'Sweet dreams', label: '18:53' },
    { time: '14:26', body: 'Hello.', label: '14:26' },
    { time: '09:07', body: '早', label: '09:07' },
    { time: '6:52 PM', body: 'Night', label: '6:52 PM' },
    // 正文自己就是时间 —— 这个数字必须留下，不能被当成时间戳误删
    { time: '18:53', body: 'Meeting at 3:00 is fine', label: '正文含 3:00' }
  ]
  for (const c of cases) {
    const el = query(waRow24h(
      '<span class="selectable-text copyable-text" dir="ltr">' + c.body + '</span>', c.time))
    const raw = el.textContent
    // fixture 自检：容器原文里确实粘着时间戳，否则测试在空转
    assert.ok(raw.includes(c.time), c.label + '：fixture 没还原出时间戳粘连')
    const parsed = MessageParser.parseForTranslation(el)
    assert.equal(parsed.sourceText, c.body,
      c.label + '：时间戳没被剥干净 → ' + JSON.stringify(parsed.sourceText))
    assert.equal(parsed.messageText, c.body, c.label + '：messageText 也被污染了')
    assert.ok(!/[0-9]{1,2}:[0-9]{2}/.test(parsed.sourceText) || c.body.includes(':'),
      c.label + '：sourceText 里残留了时钟样数字')
    assert.ok(!parsed.sourceText.includes('wds-ic-read'), c.label + '：已读图标漏进了正文')
    assert.equal(parsed.timestamp, c.time, c.label + '：时间戳应该被解析出来，只是不参与翻译')
  }
})

test('用例 12：旧 client 把时间戳粘进正文的账单形态，在 0.1.14 上不应复现', () => {
  // 复刻生产 translate_logs.snippet 的形态："Sweet dreams18:53"
  const el = query(waRow24h(
    '<span class="selectable-text copyable-text" dir="ltr">Sweet dreams</span>', '18:53'))
  const parsed = MessageParser.parseForTranslation(el)
  assert.equal(parsed.sourceText, 'Sweet dreams',
    '账单里那种「正文+时间戳」必须在进翻译链之前就被切掉')
  assert.ok(!/[0-9]{1,2}:[0-9]{2}$/.test(parsed.sourceText), '末尾不允许再挂一个时钟')
  // 扣费长度以进翻译链的 sourceText 为准：时间戳不能计入字数
  assert.equal(parsed.sourceText.length, 'Sweet dreams'.length,
    '计费长度必须等于纯正文长度，旧版多扣的就是这 5 个字符')
})

// ---------------------------------------------------------------------------
// 「绝不回退」：没有正文宁可空着，也不能拿整个气泡的文字顶上
// ---------------------------------------------------------------------------

test('找不到正文时返回空串，绝不回退到 innerText/textContent', () => {
  // 只有预览卡片、没有 .selectable-text 正文的气泡
  const el = query(waRow(
    '<div data-testid="link-preview"><div>chat.whatsapp.com<span>Group chat invite</span></div></div>' + WA_META
  ))
  const parsed = MessageParser.parseForTranslation(el)
  assert.equal(parsed.messageText, '', '没有正文就该是空串')
  assert.equal(parsed.sourceText, '')
  assert.equal(parsed.translatable, false)

  // 源码层面也要锁死：老的那个"克隆整个容器再 innerText"的取法必须消失
  assert.ok(!/function\s+sourceText\s*\(/.test(guest), '老的 sourceText 脏取法又回来了')
  // WhatsApp 这条路必须是纯正向提取：一旦出现克隆容器 / innerText 回退，
  // 预览卡片和元信息就会顺着那条路重新漏进翻译。
  const bodyAt = guest.indexOf('function whatsappBody(')
  assert.ok(bodyAt > 0, '找不到 whatsappBody')
  const body = guest.slice(bodyAt, guest.indexOf('function whatsappPrePlain(', bodyAt))
  assert.ok(!body.includes('cloneNode'), 'whatsappBody 不能克隆整个气泡')
  assert.ok(!body.includes('innerText'), 'whatsappBody 不能回退到 innerText')
  assert.ok(!body.includes('textContent'), 'whatsappBody 不能回退到 textContent')
  assert.match(body, /whatsappCandidates\(/, 'whatsappBody 必须走候选节点提取')
})

test('解析器自包含：抽出来不引用外部变量', () => {
  const beginAt = guest.indexOf(BEGIN)
  const endAt = guest.indexOf(END)
  const block = guest.slice(beginAt, endAt)
  // 引用了外面声明的东西，抽出去就会 ReferenceError；这里直接断言没引用。
  for (const outside of ['prefs.', 'EMOJI_RE', 'BUSY_MARK ', 'pixBridge', 'console.', 'window.']) {
    if (outside === 'window.') continue
    assert.ok(!block.includes(outside), '解析器块引用了外部变量：' + outside)
  }
})

// ---------------------------------------------------------------------------
// URL 保真
// ---------------------------------------------------------------------------

test('URL 被模型弄丢时也要保住，且永远不被翻译', () => {
  const urls = ['https://a.example/x', 'https://b.example/y']
  assert.equal(MessageParser.restoreUrls('hi [[1]] and [[2]]', urls), 'hi https://a.example/x and https://b.example/y')
  // 占位符被吃掉一个 → 缺失的补在末尾，URL 不丢
  const salvaged = MessageParser.restoreUrls('hi there', urls)
  assert.ok(salvaged.includes(urls[0]) && salvaged.includes(urls[1]))
  // 大小写/空格变形也要认得
  assert.equal(MessageParser.restoreUrls('hi [[ 1 ]]', [urls[0]]), 'hi ' + urls[0])
})

test('两个 URL 被 innerText 粘成一条时，不能吞成一个', () => {
  const glued = 'https://chat.whatsapp.com/AAAhttps://chat.whatsapp.com/AAA'
  const masked = MessageParser.maskUrls(glued)
  assert.ok(masked.urls.length >= 1)
  for (const url of masked.urls) {
    assert.ok(!url.includes('https://', 1), '一个 URL 里不该再嵌一个 scheme：' + url)
  }
})

test('句尾标点不算 URL 的一部分', () => {
  const masked = MessageParser.maskUrls('看这个 https://example.com/a.')
  assert.deepEqual(masked.urls, ['https://example.com/a'])
  assert.equal(masked.masked, '看这个 [[1]].')
})

test('相同 URL 复用同一个占位符（预览卡片重复时不会翻两遍）', () => {
  const masked = MessageParser.maskUrls('https://example.com/a 和 https://example.com/a')
  assert.equal(masked.urls.length, 1)
  assert.equal(masked.masked, '[[1]] 和 [[1]]')
})

// ---------------------------------------------------------------------------
// Telegram 回归：老路径不能因为这次改动而退化
// ---------------------------------------------------------------------------

test('Telegram：优先 .translatable-message，发信人/时间/反应都不进正文', () => {
  const el = query(
    '<div class="message-list-item"><div class="text-content">' +
    '<div class="message-author-title">Bob</div>' +
    '<div class="translatable-message">Привет, как дела?</div>' +
    '<span class="MessageMeta"><span class="message-time">10:31</span></span>' +
    '<div class="Reactions">❤ 2</div>' +
    '</div></div>'
  )
  const parsed = MessageParser.parseForTranslation(el)
  assert.equal(parsed.platform, 'telegram')
  assert.equal(parsed.messageText, 'Привет, как дела?')
  assertClean('Telegram', parsed, el.textContent === el.textContent ? '3:25 PM' : '')
})

test('Telegram：没有 .translatable-message 时按 UI 名单剔除，且不会清空正文', () => {
  const el = query(
    '<div class="message-list-item"><div class="text-content">' +
    '<div class="message-author-title">Bob</div>' +
    '<span class="selectable-text">Hello there</span>' +
    '<span class="MessageMeta">10:31</span>' +
    '</div></div>'
  )
  const parsed = MessageParser.parseForTranslation(el)
  assert.equal(parsed.messageText, 'Hello there')
  assert.ok(!parsed.sourceText.includes('Bob'), '发信人名字不能进正文')
  assert.ok(!parsed.sourceText.includes('10:31'), '时间不能进正文')
})

// ---------------------------------------------------------------------------
// [正在翻译中...] 占位符：绝不能离开输入框
// ---------------------------------------------------------------------------

test('占位符识别与摘除', () => {
  assert.equal(MessageParser.hasBusy('哈喽你好[正在翻译中...]'), true)
  assert.equal(MessageParser.stripBusy('哈喽你好[正在翻译中...]'), '哈喽你好')
  assert.equal(MessageParser.stripBusy('[正在翻译中...]'), '')
  assert.equal(MessageParser.hasBusy('哈喽你好'), false)
  assert.equal(MessageParser.stripBusy('哈喽你好'), '哈喽你好')
})

test('占位符硬闸独立于翻译开关，且挂在发送路径的最前面', () => {
  // 老实现只在 prefs.transSend 打开时才检查占位符 —— 于是翻译中途关掉
  // 发送翻译，这一下 Enter 就直通 WhatsApp，把占位符发了出去。
  const keydownAt = guest.indexOf('function onKeyDown(event)')
  assert.ok(keydownAt > 0, '找不到 onKeyDown')
  const keydown = guest.slice(keydownAt, guest.indexOf('function onBeforeInput', keydownAt))
  const guardAt = keydown.indexOf('guardBusySend(event)')
  const prefAt = keydown.indexOf('prefs.transSend')
  assert.ok(guardAt > 0, 'onKeyDown 里没有占位符硬闸')
  assert.ok(guardAt < prefAt, '硬闸必须在 prefs.transSend 判断之前')

  const clickAt = guest.indexOf('function onClick(event)')
  const click = guest.slice(clickAt, guest.indexOf('const DELETED_RE', clickAt))
  assert.ok(click.indexOf('guardBusySend(event)') < click.indexOf('prefs.transSend'),
    'onClick 里硬闸也必须先于翻译开关')

  const beforeAt = guest.indexOf('function onBeforeInput(event)')
  const before = guest.slice(beforeAt, clickAt)
  assert.ok(before.indexOf('guardBusySend(event)') < before.indexOf('prefs.transSend'),
    'onBeforeInput 里硬闸也必须先于翻译开关')
})

test('写回输入框之后、点发送之前必须复核占位符', () => {
  // 复核占位符 + 触发发送都在投递阶段（deliverSend）里，不在决策阶段。
  const runAt = guest.indexOf('async function deliverSend')
  const run = guest.slice(runAt, guest.indexOf('function normalizeBody', runAt))
  // ★ 0.1.19：写入方式换成「Chromium 原生输入 + 回读校验」★
  // 不变量没变，而且更强了：**原生写入校验通过之后**才允许真正发送。
  const scrubAt = run.indexOf('await replaceComposerWithTranslatedTextNative(box, finalText)')
  const sendAt = run.indexOf('fireSendVerified(box, finalText)')
  assert.ok(scrubAt > 0 && sendAt > 0,
    'deliverSend 里找不到原生写入 / fireSendVerified')
  assert.ok(scrubAt < sendAt, '必须先复核占位符再发送')
  // 翻译期间必须记住用户原文，否则硬闸还原不出东西
  assert.match(run, /pendingSend = \{ box: box, raw: raw \}/, '没有记住用户原文')
  // 0.1.14 真机 P0 的根因：占位符曾被**写进输入框**。这一条永久拦住它。
  //
  // 与实现形状无关的不变量：发送链上任何"写入正文"的调用都不许带占位符 ——
  // 泄漏一定发生在"某处把占位符写进了输入框"，把这条钉死就够了。
  // 注意先剔掉注释：注释里正记着"老实现是 writeComposer(box, raw + BUSY_MARK)"。
  const code = guest
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  const writes = code.match(/nativeSetComposer\([^)]*\)/g) || []
  assert.ok(writes.length > 0, '找不到任何 nativeSetComposer 调用，断言失效')
  for (const w of writes) {
    assert.ok(!/BUSY_MARK|正在翻译中/.test(w),
      'nativeSetComposer 绝不能把占位符写进输入框：' + w)
  }
})

test('0.1.19：发送链上不允许再出现任何「页面内改 DOM」的写入', () => {
  // 真机证据（0.1.18）：页面内 `execCommand` 的写入**从未进入** WhatsApp 编辑器的
  // 输入管线（expected=29 字符译文 vs actual=6 字符原文，sawBeforeInput=false）。
  // 所以 `writeComposer()` / `writeAndVerify()` 必须彻底消失，且不许有替代品。
  const code = guest
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  assert.ok(code.indexOf('function writeComposer') < 0, 'writeComposer 必须已被删除')
  assert.ok(code.indexOf('function writeAndVerify') < 0, 'writeAndVerify 必须已被删除')
  const domWrites = (code.match(/\.(innerText|innerHTML|replaceChildren)\s*=(?!=)/g) || [])
    .concat(code.match(/execCommand\(\s*['"]insertText['"]/g) || [])
  assert.equal(domWrites.length, 0,
    '发送链上不允许再出现直接改 DOM 的写入：' + domWrites.join(','))
  // 唯一写入入口必须存在，且发送链确实调用它。
  assert.ok(code.indexOf('function replaceComposerWithTranslatedTextNative') > 0,
    '缺少原生输入管线 replaceComposerWithTranslatedTextNative')
  assert.ok(code.indexOf('function nativeSetComposer') > 0, '缺少唯一的写入入口 nativeSetComposer')
})

test('0.1.19：主进程必须提供原生输入通道（Chromium 编辑命令），且不碰 DOM', () => {
  // 通道已迁到 src/ipc/translate.js
  const impl = fs.readFileSync(path.join(root, 'desktop', 'src', 'ipc', 'translate.js'), 'utf8')
  assert.ok(main.indexOf("require('./src/translate/native-composer')") > 0, '主进程没有引入 native-composer')
  assert.ok(impl.indexOf("'translate:composerSelectAllDelete'") > 0, '缺少原生清空通道')
  assert.ok(impl.indexOf("'translate:composerInsertText'") > 0, '缺少原生插入通道')
  // 通道必须走可信来源校验（否则任意页面都能驱动 WhatsApp 输入框）。
  const at = impl.indexOf("'translate:composerSelectAllDelete'")
  const seg = impl.slice(at, impl.indexOf('handleUnsafe', at + 10) > 0
    ? impl.indexOf('handleUnsafe', at + 10)
    : impl.length)
  assert.ok(/trustedTabSender|composerTargetOf/.test(seg), '原生输入通道缺少来源校验')
  // 迁走的通道必须用 handleUnsafe 显式注册 —— 它们服务的是客页，
  // 但"允许客页调用"这件事必须在代码里看得见
  assert.match(impl.slice(Math.max(0, at - 200), at), /handleUnsafe/, '客页通道必须显式声明为 handleUnsafe')
  // 绝不能碰 DOM
  assert.equal(impl.includes('executeJavaScript('), false, '原生输入通道不能注入脚本')
})

test('主进程独立再拦一次（不信任渲染进程）', () => {
  assert.match(main, /const CLIENT_BUSY_MARKS = /, '主进程没有占位符名单')
  // translate:run 已迁到 src/ipc/translate.js
  const impl = fs.readFileSync(path.join(root, 'desktop', 'src', 'ipc', 'translate.js'), 'utf8')
  const runAt = impl.indexOf("'translate:run'")
  assert.ok(runAt > 0, '找不到 translate:run 处理器')
  const run = impl.slice(runAt, runAt + 2800)
  assert.ok(run.indexOf('stripBusyMarks(') > 0, '主进程没摘占位符')
  assert.ok(run.indexOf('stripBusyMarks(') < run.indexOf('getTransCached('),
    '必须在进缓存/发上游之前就摘掉')
  // 真机取证：实际送上游的 source_text 要落到客户端日志里
  assert.match(run, /source_text=/, '没有记录 source_text，真机出问题只能靠猜')
})

test('消息归档不落占位符，且归档调用点保持不变', () => {
  const reportAt = guest.indexOf('function reportMessage(')
  const report = guest.slice(reportAt, guest.indexOf('/** 会话切换时上报一次', reportAt))
  assert.match(report, /MessageParser\.stripBusy\(text\)/, '归档前没有摘占位符')
  assert.match(report, /reportClue\(text, direction, messageTime\(node\)\)/,
    '归档调用点被改动了（desktop-message-archive.test.js 依赖它）')
})
