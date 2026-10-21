'use strict'

/**
 * 语种判定闸门 —— 多语种翻译"没反应"的回归测试。
 *
 * ## 现场
 *
 * 真机反馈：英语翻译一直正常，**换成其他语言就完全没变化**。
 *
 * ## 根因（两个方向，同一个函数）
 *
 * 发送与接收都拿 `detectLang()` 当"要不要翻译"的闸门，而它是一个只认
 * zh / ja / ko / th / vi 的正则猜词器，**认不出的一律返回 'en'**。
 *
 * ### 发送方向
 *
 *     if (detectLang(text) === prefs.sendTo) return null   // 不拦，原样发送
 *
 * `sendTo` 默认就是 `'en'`。于是德语、俄语、阿拉伯语、印地语、印尼语、
 * 意大利语…全被判成"本来就是英语"，**直接放行，一次翻译都不调**。
 * 英语恰好是那个"本该跳过"的语种，所以看起来只有英语是对的。
 *
 * ### 接收方向
 *
 *     sameLang = detectLang(text) === prefs.langMine             // zh
 *
 * `こんにちは、会議は3時です` 里的汉字先命中 `[\u4e00-\u9fff]` →
 * 判成中文 → sameLang=true → `messageAction` 返回 `'hide'`。
 * **日语消息连「译」按钮都不给**，用户看到的就是"没反应"。
 *
 * ## 修法
 *
 * 换成 `isDefinitelyLang()`：按 Unicode **书写系统**判断，只回答
 * "能否 100% 确定"。拿不准一律返回 false → 照常翻译，由上游
 * `source='auto'` 自己检测（所有通道都支持，DeepL 的代码里明确写了
 * "auto 时不传 source_lang"）。
 *
 * 这个文件的每一条用例都是**曾经真实判错**的文本，别为了"优化性能"
 * 把它们改回去。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { JSDOM } = require('jsdom')

const root = path.join(__dirname, '..')
const guestSrc = fs.readFileSync(path.join(root, 'desktop', 'guest-inject.js'), 'utf8')

/**
 * 把 `isDefinitelyLang` 从源码里原样取出来。
 *
 * 不 require：guest-inject.js 是 preload，顶层直接摸 window/document。
 * 这里只抽这一个纯函数，保证测的是**真源码**而不是副本。
 */
function loadIsDefinitelyLang () {
  const start = guestSrc.indexOf('function isDefinitelyLang(text')
  assert.ok(start > 0, 'isDefinitelyLang 必须存在（多语种判定闸门）')
  let depth = 0
  let end = -1
  for (let i = guestSrc.indexOf('{', start); i < guestSrc.length; i++) {
    if (guestSrc[i] === '{') depth++
    else if (guestSrc[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  assert.ok(end > start, 'isDefinitelyLang 函数体必须完整')
  // eslint-disable-next-line no-new-func
  return new Function('return (' + guestSrc.slice(start, end) + ')')()
}

const isDefinitelyLang = loadIsDefinitelyLang()

// ---------------------------------------------------------------------------
// 1 · 非拉丁语言：必须判为"不确定"，也就是**必须交给上游翻译**
// ---------------------------------------------------------------------------
// 这些是原来的 P0：全被判成 'en'，sendTo='en' 时直接放行。

test('非拉丁语言在 sendTo=en 时绝不能被当成英语放行', () => {
  const mustTranslate = [
    ['Guten Tag, Besprechung um 15 Uhr', '德语'],
    ['Bonjour, réunion à 15 heures', '法语'],
    ['Hola, reunión a las 3 de la tarde', '西班牙语'],
    ['Olá, reunião às 15 horas', '葡萄牙语'],
    ['Ciao, riunione alle 15', '意大利语'],
    ['Halo, rapat jam 3 sore', '印尼语'],
    ['Привет, встреча в 15:00', '俄语'],
    ['مرحبا، الاجتماع الساعة الثالثة', '阿拉伯语'],
    ['नमस्ते, बैठक तीन बजे है', '印地语'],
    ['Merhaba, toplantı saat 15', '土耳其语'],
    ['Witaj, spotkanie o 15:00', '波兰语'],
    ['Hoi, vergadering om 15 uur', '荷兰语'],
    ['Xin chào, họp lúc 3 giờ chiều', '越南语'],
    ['นี่คือการทดสอบ', '泰语'],
    ['이것은 테스트입니다', '韩语'],
    ['これはテストです', '日语'],
    ['这是一个测试', '中文'],
    ['Szia, találkozó 15-kor', '匈牙利语'],
    ['Hej, möte klockan 15', '瑞典语'],
    ['Γεια σας, συνάντηση στις 3', '希腊语'],
    ['שלום, פגישה בשלוש', '希伯来语'],
    ['Merhaba dünya', '土耳其语（带变音）']
  ]
  for (const [text, name] of mustTranslate) {
    assert.equal(isDefinitelyLang(text, 'en'), false,
      name + ' 被判成了"已经是英语" → 原文会不经翻译直接发出去：' + text)
  }
})

// ---------------------------------------------------------------------------
// 2 · 接收方向：日语绝不能被判成中文
// ---------------------------------------------------------------------------
// 这是"接收翻译对其他语言没反应"的直接原因：sameLang=true → hide。

test('日语消息不能被判成中文（否则接收方向直接 hide，连按钮都没有）', () => {
  const japanese = [
    'こんにちは、会議は3時です',
    '会議は3時です',
    'ありがとうございます',
    'カタカナのテスト',
    'よろしくお願いします'
  ]
  for (const text of japanese) {
    assert.equal(isDefinitelyLang(text, 'zh'), false,
      '日语被判成母语 → messageAction 返回 hide：' + text)
  }
})

test('纯中文消息仍然判为母语（不能因为修 bug 把正常路径也翻了）', () => {
  for (const text of ['你好，下午三点开会', '收到', '明天见', '这个多少钱']) {
    assert.equal(isDefinitelyLang(text, 'zh'), true, '纯中文应当判为母语：' + text)
  }
})

// ---------------------------------------------------------------------------
// 3 · 其他语言之间也不能互相误判
// ---------------------------------------------------------------------------

test('拉丁语言之间不互相误判（法语/西语/葡语曾全被判成越南语）', () => {
  // 原来的正则里 à ã é ó 属于越南语字符集，法/西/葡会先命中
  for (const [text, lang] of [
    ['Bonjour, réunion à 15 heures', 'fr'],
    ['Hola, reunión a las 3', 'es'],
    ['Olá, reunião às 15 horas', 'pt-BR'],
    ['Ciao, riunione alle 15', 'it']
  ]) {
    assert.equal(isDefinitelyLang(text, 'vi'), false,
      '被判成了越南语（不应确定）：' + text)
  }
})

test('俄语 / 阿拉伯语 / 泰语 / 韩语 / 日语各自判为母语', () => {
  assert.equal(isDefinitelyLang('Привет, как дела', 'ru'), true)
  assert.equal(isDefinitelyLang('مرحبا كيف حالك', 'ar'), true)
  assert.equal(isDefinitelyLang('สวัสดีครับ', 'th'), true)
  assert.equal(isDefinitelyLang('안녕하세요', 'ko'), true)
  assert.equal(isDefinitelyLang('こんにちは', 'ja'), true)
})

test('跨书写系统的消息不误判（俄语文本对中文用户必须翻译）', () => {
  assert.equal(isDefinitelyLang('Привет', 'zh'), false)
  assert.equal(isDefinitelyLang('你好', 'ru'), false)
  assert.equal(isDefinitelyLang('مرحبا', 'en'), false)
  assert.equal(isDefinitelyLang('Hello', 'ru'), false)
})

// ---------------------------------------------------------------------------
// 4 · 拉丁字母语言一律交给上游（含英语）
// ---------------------------------------------------------------------------
// 曾经想用"纯 ASCII = 英语"省一次调用，但纯 ASCII 的德语/意大利语/荷兰语
// 全都不带变音符 —— 那条捷径等于把同一个 bug 换个壳引回来。

test('纯 ASCII 的其他语言同样必须翻译', () => {
  assert.equal(isDefinitelyLang('Guten Tag, Besprechung um 15 Uhr', 'en'), false)
  assert.equal(isDefinitelyLang('Ciao, riunione alle 15', 'en'), false)
  assert.equal(isDefinitelyLang('Hoi, vergadering om 15 uur', 'en'), false)
  assert.equal(isDefinitelyLang('Halo, rapat jam 3 sore', 'en'), false)
  assert.equal(isDefinitelyLang('Witaj, spotkanie o 15:00', 'en'), false)
})

test('英语文本也交给上游（本地不再猜"是不是英语"）', () => {
  // 这不是回归：漏翻比多翻一次代价大得多，重复成本由 translation-cache 兜住
  assert.equal(isDefinitelyLang('hello there', 'en'), false)
  assert.equal(isDefinitelyLang('Meeting at 3pm, see you', 'en'), false)
})

// ---------------------------------------------------------------------------
// 5 · 边界
// ---------------------------------------------------------------------------

test('空串 / 纯数字 / 纯 emoji 不参与判定', () => {
  for (const text of ['', '   ', '123 456', '😀😀', '!!!???']) {
    assert.equal(isDefinitelyLang(text, 'en'), false, '不该判为确定语种：' + JSON.stringify(text))
  }
})

test('语言码带地区后缀时按主语言判断', () => {
  assert.equal(isDefinitelyLang('Привет', 'ru-RU'), true)
  assert.equal(isDefinitelyLang('你好', 'zh-CN'), true)
  assert.equal(isDefinitelyLang('Olá', 'pt-BR'), false)
})

// ---------------------------------------------------------------------------
// 6 · 端到端：接收方向真的会调翻译接口
// ---------------------------------------------------------------------------
// 上面测的是纯函数。这里走真 DOM + 整份 guest-inject，确认判决结果
// 真的传到了 messageAction / translate:run —— 纯函数对了但接线错了
// 一样是"没反应"。

const TG_HTML = `<div id="Main"><div id="MiddleColumn">
<div class="ChatInfo"><div class="info"><h3>Alice</h3><span class="status">last seen recently</span></div></div>
<div class="MessageList"><div class="messages-container"><div class="message-date-group">
<div id="message-101" class="Message message-list-item first-in-group allow-selection shown" data-message-id="101">
  <div class="message-content-wrapper"><div class="message-content text has-shadow">
    <div class="content-inner" dir="auto"><div class="text-content clearfix with-meta" dir="auto">こんにちは、会議は3時です<span class="MessageMeta"><span class="message-time">10:21</span></span></div></div>
  </div></div>
</div>
</div></div></div>
<div class="Composer"><div id="editable-message-text" contenteditable="true" role="textbox"></div></div>
</div></div>`

function mountReceive (prefsOverride) {
  const dom = new JSDOM('<!doctype html><body>' + TG_HTML + '</body>', {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://web.telegram.org/a/#123456789'
  })
  const win = dom.window
  win.Element.prototype.getBoundingClientRect = () => ({
    width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20
  })
  const prefs = Object.assign({
    transRecv: true, transSend: true, transGroup: false,
    langMine: 'zh', langOther: 'auto', sendTo: 'en', includeZh: false
  }, prefsOverride)
  const calls = []
  win.require = () => ({
    ipcRenderer: {
      invoke: (ch, p) => {
        if (ch === 'translate:guestPrefs') return Promise.resolve(prefs)
        if (ch === 'translate:run') {
          calls.push(p)
          return Promise.resolve({ success: true, translation: '你好，会议在三点。' })
        }
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('接收方向：日语消息必须真的触发翻译请求（不能 hide）', async () => {
  const h = mountReceive()
  try {
    // scan 由 MutationObserver / 定时扫描驱动，给足一拍
    await sleep(600)
    const jaCalls = h.calls.filter(c => String(c.text || '').includes('こんにちは'))
    assert.ok(jaCalls.length > 0,
      '日语消息被判成中文母语后 hide 了 —— 用户看到的就是"其他语言没反应"')
    assert.equal(jaCalls[0].incoming, true)
  } finally { h.close() }
})

// ---------------------------------------------------------------------------
// 7 · hasChinese：CJK 汉字区间不是"中文"的同义词
// ---------------------------------------------------------------------------
// 这是最隐蔽的一处。`messageAction` 里有：
//
//     if (s.hasChinese && !s.includeZh) return 'hide'
//
// 而 hasChinese 原来只看 `[\u4e00-\u9fff]` —— 日语、韩语里的汉字全在这个
// 区间。于是日语消息 hasChinese=true，includeZh 默认关闭 → **直接 hide，
// 连「译」按钮都不给**。前面把所有语种判定都修对了，日语照样不翻。

test('含假名的日语消息不算中文（includeZh 关着也不能 hide）', async () => {
  const h = mountReceive()
  try {
    await sleep(600)
    assert.ok(h.calls.length > 0, '日语消息被当成中文 hide 了')
    assert.ok(h.doc.querySelector('.pix-trans'), '日语消息必须画出译文')
  } finally { h.close() }
})
