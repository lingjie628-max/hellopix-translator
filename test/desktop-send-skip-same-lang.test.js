'use strict'

/**
 * 发送方向：「原文已经是目标语言就跳过翻译」。
 *
 * ## 现场
 *
 * 用户反馈：输入英文发出去，被翻译成了中文。
 *
 * ## 为什么会这样
 *
 * `isDefinitelyLang` 的注释里写得很清楚：拉丁字母区（英/德/意/荷…）**无法
 * 凭字符区分**，所以一律返回 false —— 意思是"拿不准，照常翻译"。
 *
 * 这个判断对"要不要翻"是对的，但它回答不了另一半问题：
 *
 *     原文是不是**已经就是目标语言**了？
 *
 * 于是 `sendTo='en'` 时输入英文：isDefinitelyLang → false → 不跳过 → 送翻。
 * 英翻英模型通常原样返回，用户无感**但每次都扣钱**；而一旦 sendTo 设成别的
 * 语言（比如葡语或中文），**英文就会被真的翻译成那个语言发出去**。
 *
 * 线上数据印证：`manual_send` 里有一批记录的 target 是 `pt-BR`，而 snippet
 * 全是完全正确的葡萄牙语 —— 原文已经是目标语言，却被送去"翻译"了一遍。
 *
 * ## 修法
 *
 * 另加一道闸门 `isAlreadyTarget(text, to)`，只在**有强证据**时返回 true：
 *
 *   · 目标英语：全 ASCII + 至少两个词 + 命中常见功能词 + 没有别的语言特征
 *   · 其他拉丁语系：必须出现该语言独有的变音字符（葡语 ã õ、西语 ñ、德语 ß…）
 *
 * 证据不足一律 false（照常翻译）。这条线的原则没变：
 *
 *     **跳过错了 = 该翻的没翻（用户直接看得见）**
 *     **多翻一次  = 浪费几个字符（用户看不见）**
 *
 * 所以每一条"跳过"的用例都必须有硬证据，每一条"不跳过"的用例都允许保守。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const guestSrc = fs.readFileSync(path.join(root, 'desktop', 'guest-inject.js'), 'utf8')

/** 从源码里原样取出一个具名函数（测真源码，不是副本）。 */
function extractFn (name) {
  // 两种写法都要认：`function foo (a)` 与 `function foo(a)`
  let start = guestSrc.indexOf('function ' + name + ' (')
  if (start < 0) start = guestSrc.indexOf('function ' + name + '(')
  assert.ok(start > 0, name + ' 必须存在')
  let depth = 0
  let end = -1
  for (let i = guestSrc.indexOf('{', start); i < guestSrc.length; i++) {
    if (guestSrc[i] === '{') depth++
    else if (guestSrc[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  assert.ok(end > start, name + ' 函数体必须完整')
  return guestSrc.slice(start, end)
}

/** 连 LATIN_LANG_SIGNS / LATIN_LANG_WORDS 一起取出来 —— isAlreadyTarget 依赖它们。 */
function loadIsAlreadyTarget () {
  function grabConst (name) {
    const s = guestSrc.indexOf('const ' + name)
    assert.ok(s > 0, name + ' 必须存在')
    let depth = 0
    let e = -1
    for (let i = guestSrc.indexOf('{', s); i < guestSrc.length; i++) {
      if (guestSrc[i] === '{') depth++
      else if (guestSrc[i] === '}') { depth--; if (depth === 0) { e = i + 1; break } }
    }
    assert.ok(e > s, name + ' 必须完整')
    return guestSrc.slice(s, e + 1)
  }
  const code = grabConst('LATIN_LANG_SIGNS') + '\n' +
    grabConst('LATIN_LANG_WORDS') + '\n' +
    extractFn('isAlreadyTarget') + '\nreturn isAlreadyTarget'
  // eslint-disable-next-line no-new-func
  return new Function(code)()
}

const isAlreadyTarget = loadIsAlreadyTarget()

// ---------------------------------------------------------------------------
// 1 · 目标英语 + 输入英语 → 必须跳过（这就是用户报的那条路）
// ---------------------------------------------------------------------------

test('英语原文 + 目标英语 → 跳过，不送翻（用户报的核心场景）', () => {
  const samples = [
    'hello there, how are you?',
    'Meeting at 3pm, see you tomorrow',
    'Please send me the file when you can',
    'I think we should wait for the results',
    'Thanks for your help today'
  ]
  for (const s of samples) {
    assert.equal(isAlreadyTarget(s, 'en'), true, '应跳过：' + JSON.stringify(s))
  }
})

test('英语文本对中文目标是**必须翻译**的（不能因为修 bug 反过来漏翻）', () => {
  // 这是最重要的反向用例：用户 sendTo='zh' 时输入英文就该翻成中文。
  for (const s of ['hello there, how are you?', 'Please send me the file']) {
    assert.equal(isAlreadyTarget(s, 'zh'), false, '目标中文时英文必须翻译：' + JSON.stringify(s))
  }
})

// ---------------------------------------------------------------------------
// 2 · 别的拉丁语言不能被误判成英语（这是原设计的核心顾虑）
// ---------------------------------------------------------------------------

test('★ 纯 ASCII 的其他语言绝不能被当成英语跳过', () => {
  // 这些全部不带变音符 —— 只看"是不是 ASCII"就会全判成英语，
  // 那正是这次要避免的 bug 换个壳。
  const notEnglish = [
    'Guten Tag, Besprechung um 15 Uhr',
    'Ciao, riunione alle 15',
    'Hoi, vergadering om 15 uur',
    'Halo, rapat jam 3 sore',
    'Witaj, spotkanie o 15:00'
  ]
  for (const s of notEnglish) {
    assert.equal(isAlreadyTarget(s, 'en'), false, '不能判成英语：' + JSON.stringify(s))
  }
})

test('带变音符的葡语/西语/德语也不会被判成英语', () => {
  assert.equal(isAlreadyTarget('Bom dia, tudo bem com você?', 'en'), false)
  assert.equal(isAlreadyTarget('Mañana nos vemos en la oficina', 'en'), false)
  assert.equal(isAlreadyTarget('Grüße aus Berlin, bis später', 'en'), false)
})

// ---------------------------------------------------------------------------
// 3 · 其他拉丁语系：有强特征字符时跳过
// ---------------------------------------------------------------------------

test('葡语原文 + 目标葡语 → 跳过（线上几百条白白送翻的就是这种）', () => {
  assert.equal(isAlreadyTarget('Não se preocupe, vai dar tudo certo', 'pt-BR'), true)
  assert.equal(isAlreadyTarget('Bom dia, tudo bem com você?', 'pt-BR'), true)
  // 大小写主语言码也要认
  assert.equal(isAlreadyTarget('Não se preocupe', 'pt'), true)
})

test('西语 ñ / 德语 ß / 越南语声调 → 各自跳过', () => {
  assert.equal(isAlreadyTarget('Mañana nos vemos en la oficina', 'es'), true)
  assert.equal(isAlreadyTarget('Grüße aus Berlin, bis später', 'de'), true)
  assert.equal(isAlreadyTarget('Tôi sẽ gọi lại cho bạn sau', 'vi'), true)
})

test('★ 越南语字符在 U+1E00–U+1EFF，不能被判成"非拉丁"（曾出过这个 bug）', () => {
  // ẽ(U+1EBD) ọ(U+1ECD) ạ(U+1EA1) 全在拉丁扩展附加区。
  // 范围只写到 U+024F 时，整句会被判成"非拉丁字母"→ 直接 false → 永远不跳过。
  // 这条用例锁住那个范围，别再收窄回去。
  for (const s of ['Tôi sẽ gọi lại cho bạn sau', 'Chào bạn, hôm nay thế nào']) {
    assert.equal(isAlreadyTarget(s, 'vi'), true, '越南语应能识别：' + s)
  }
})

test('★ 葡语原文对英语目标必须翻译（不然就是漏翻）', () => {
  assert.equal(isAlreadyTarget('Não se preocupe, vai dar tudo certo', 'en'), false)
})

test('没有特征字符的拉丁文本无法判断 → 照常翻译', () => {
  // 纯 ASCII 的西语（不带 ñ）没有硬证据，宁可翻
  assert.equal(isAlreadyTarget('Hola, nos vemos manana', 'es'), false)
})

// ---------------------------------------------------------------------------
// 4 · 跨书写系统：永远不跳过
// ---------------------------------------------------------------------------

test('★ 中文/日文/俄文文本对拉丁目标必须翻译', () => {
  assert.equal(isAlreadyTarget('你好，今天过得怎么样', 'en'), false)
  assert.equal(isAlreadyTarget('こんにちは、会議は3時です', 'en'), false)
  assert.equal(isAlreadyTarget('Привет, как дела', 'en'), false)
})

test('★ 中英混排必须翻译（不能因为含英文就跳过）', () => {
  assert.equal(isAlreadyTarget('hello 你好', 'en'), false)
  assert.equal(isAlreadyTarget('请 send me the file', 'en'), false)
})

// ---------------------------------------------------------------------------
// 5 · 边界与保守性
// ---------------------------------------------------------------------------

test('空串 / 纯数字 / 纯标点 / 纯 emoji 一律不跳过', () => {
  for (const s of ['', '   ', '123 456', '!!!???', '😀😀']) {
    assert.equal(isAlreadyTarget(s, 'en'), false, '不应跳过：' + JSON.stringify(s))
  }
})

test('★ 单个单词无法判断语言 → 不跳过（ok / yes / hello 三种语言都这么说）', () => {
  for (const s of ['ok', 'yes', 'hello', 'thanks']) {
    assert.equal(isAlreadyTarget(s, 'en'), false, '单词不该被当成确定英语：' + s)
  }
})

test('目标语言缺失或未知时不跳过', () => {
  assert.equal(isAlreadyTarget('hello there, how are you', ''), false)
  assert.equal(isAlreadyTarget('hello there, how are you', 'xx'), false)
})

// ---------------------------------------------------------------------------
// 6 · 接线：拦截点必须真的用上这道闸门
// ---------------------------------------------------------------------------

test('★ 发送拦截点必须调用 isAlreadyTarget（否则等于没改）', () => {
  const start = guestSrc.indexOf('function decideIntercept')
  assert.ok(start > 0, 'decideIntercept 必须存在')
  // 取到函数结尾
  let depth = 0
  let end = -1
  for (let i = guestSrc.indexOf('{', start); i < guestSrc.length; i++) {
    if (guestSrc[i] === '{') depth++
    else if (guestSrc[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  const body = guestSrc.slice(start, end)
  assert.match(body, /isAlreadyTarget\s*\(/,
    '★ decideIntercept 里必须调用 isAlreadyTarget，否则"英文被翻成中文"根本没修')
  assert.match(body, /if\s*\(isAlreadyTarget\([^)]*\)\)\s*\{\s*[\s\S]*?return null/,
    '★ 命中时必须 return null（放行原文），而不是继续往下走翻译')
})

test('★ 原闸门不能被移除：非拉丁语言仍然靠 isDefinitelyLang 先判', () => {
  const start = guestSrc.indexOf('function decideIntercept')
  const body = guestSrc.slice(start, start + 4000)
  assert.match(body, /isDefinitelyLang\s*\(/,
    '★ isDefinitelyLang 是第一道闸门（中文/日文等），删了会让它们被送翻')
})

test('跳过时不能产生翻译计费：命中分支必须在 sendActionId 赋值之前', () => {
  const start = guestSrc.indexOf('function decideIntercept')
  const body = guestSrc.slice(start, start + 6000)
  const idxGuard = body.indexOf('isAlreadyTarget(')
  const idxBill = body.indexOf('sendActionId = newSendActionId()')
  assert.ok(idxGuard > 0 && idxBill > 0)
  assert.ok(idxGuard < idxBill,
    '★ 跳过判断必须在"开始计费/开新 actionId"之前 —— 否则跳过了还记账')
})
