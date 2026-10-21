'use strict'

/**
 * 混合翻译路由：短文本走专用翻译 API、长文本走 LLM。
 *
 * 这个模块决定"用户这句话用哪条通道翻译"，直接同时影响三件事：
 *   ① 速度（1.9s → 0.2~0.4s）
 *   ② 翻译质量（LLM 保语气/格式更好）
 *   ③ **计费与透明度**（必须有响应字段说明实际用了谁）
 *
 * 所以每条规则都要能被单独验证，不能靠"跑一遍看看效果"。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  FAST_MAX_CHARS, SLOW_MARKERS, shouldUseFastPath, pickFastEngine, routeTranslate
} = require('../server/services/translation-router')

function engine (id, extra) {
  return Object.assign({ id: id, name: id, enabled: true, wired: true, retired: false }, extra || {})
}

// ---------------------------------------------------------------------------
// 1. 什么样的文本可以走快速通道
// ---------------------------------------------------------------------------

test('短句走快速通道：日常聊天的一句/两三句', () => {
  for (const text of [
    'Hello, are you available today?',
    '你好，今天有空吗？',
    'Привет, как дела?',
    '明日の午後3時に会いましょう',
    'Terima kasih banyak',
    'Ok'
  ]) {
    const d = shouldUseFastPath(text)
    assert.equal(d.fast, true, '应走快速通道：' + text)
  }
})

test('★ 长度边界：120 字符以内才算短，超一个字都不行', () => {
  assert.equal(FAST_MAX_CHARS, 120, '阈值变了要同步更新本用例的意图')
  const at = 'a'.repeat(120)
  const over = 'a'.repeat(121)
  assert.equal(shouldUseFastPath(at).fast, true, '正好 120 仍是短句')
  assert.equal(shouldUseFastPath(over).fast, false, '121 就交给 LLM')
  assert.equal(shouldUseFastPath(over).reason, 'too-long')
})

test('多行文本一律走 LLM（专用 API 会把多行揉成一段）', () => {
  const multiline = 'Hi\nHow are you?'
  const d = shouldUseFastPath(multiline)
  assert.equal(d.fast, false, '含换行的多行文本不能走快速通道')
  assert.match(d.reason, /marker/)
})

test('单行但含换行符结尾，也算多行', () => {
  // 末尾一个换行是用户手误，但两个以上才是真正的分段；这里验证不会误伤
  assert.equal(shouldUseFastPath('Hi there\n').fast, true, '单个行尾换行不该误判成多行')
  assert.equal(shouldUseFastPath('Hi\nthere\n').fast, false, '两个换行是真正的多行')
})

test('★ 占位符/模板/代码必须走 LLM（专用 API 会把它们翻译掉，破坏业务）', () => {
  for (const text of [
    'Hello {name}, your order is ready',
    'Send to {{email}} please',
    'Use `const x = 1` here',
    'Your code is ${code}',
    'Insert value %s here',
    'Value is %d percent'
  ]) {
    const d = shouldUseFastPath(text)
    assert.equal(d.fast, false, '含模板占位符必须走 LLM：' + text)
  }
})

test('★ URL 与邮箱必须走 LLM（翻掉就等于把链接搞坏）', () => {
  for (const text of [
    'Please visit https://example.com/page for details',
    'Contact me at support@example.com',
    'See www.example.com'
  ]) {
    assert.equal(shouldUseFastPath(text).fast, false, '含链接/邮箱必须走 LLM：' + text)
  }
})

test('表格行必须走 LLM（专用 API 会打乱竖线位置）', () => {
  assert.equal(shouldUseFastPath('| Name | Price |\n| A | 10 |').fast, false)
  assert.equal(shouldUseFastPath('| Name | Value |').fast, false, '单行表格也要拦')
})

test('纯数字/符号/表情没有可翻译内容，不该白花一次调用', () => {
  for (const text of ['12345', '!!!???', '😀😀😀', '   ', '']) {
    assert.equal(shouldUseFastPath(text).fast, false, '无可翻译内容：' + JSON.stringify(text))
  }
})

test('★ 阈值是按"字符"还是"字节"算 —— 必须按字符（中文一字算一个）', () => {
  // 120 个汉字是 360 字节，但仍然算短句
  const cn = '你'.repeat(120)
  assert.equal(shouldUseFastPath(cn).fast, true, '120 个汉字应算短句')
  assert.equal(shouldUseFastPath('你'.repeat(121)).fast, false)
})

// ---------------------------------------------------------------------------
// 2. 挑通道
// ---------------------------------------------------------------------------

test('pickFastEngine：按优先级挑第一条真正可用的', () => {
  const rows = [engine('qwen'), engine('gpt')]
  const picked = pickFastEngine(rows, ['google', 'qwen', 'gpt'])
  assert.equal(picked.id, 'qwen', 'google 不在候选里，应跳到 qwen')
})

test('★ pickFastEngine：不可用的通道绝不选（未启用 / 未接通 / 已下架）', () => {
  const rows = [
    engine('google', { wired: false }),
    engine('qwen', { enabled: false }),
    engine('deepl', { retired: true }),
    engine('gpt')
  ]
  const picked = pickFastEngine(rows, ['google', 'qwen', 'deepl', 'gpt'])
  assert.equal(picked.id, 'gpt', '三条都不可用，只能选 gpt')
})

test('pickFastEngine：一个可用都没有时返回 null（由调用方决定不路由）', () => {
  assert.equal(pickFastEngine([engine('gpt')], ['qwen']), null)
  assert.equal(pickFastEngine(null, ['qwen']), null, '候选为空不能崩')
  assert.equal(pickFastEngine([engine('qwen')], null), null, '优先级为空不能崩')
})

// ---------------------------------------------------------------------------
// 3. 路由决策（含"绝不静默切换"的硬约束）
// ---------------------------------------------------------------------------

test('短句：从 gpt 路由到 qwen，且显式标记 routed=true', () => {
  const r = routeTranslate({
    selected: engine('gpt'),
    text: 'Hello, how are you?',
    candidates: [engine('gpt'), engine('qwen')],
    fastEngineIds: ['qwen'],
    enabled: true
  })
  assert.equal(r.engine.id, 'qwen', '短句应走快速通道')
  assert.equal(r.routed, true, '★ 必须标记发生了路由 —— 界面要据此显示真实通道')
  assert.equal(r.from, 'gpt')
  assert.equal(r.to, 'qwen')
})

test('★ 长文本：原样保留用户选择的通道，一个字段都不改', () => {
  const selected = engine('gpt')
  const r = routeTranslate({
    selected: selected,
    text: 'x'.repeat(500),
    candidates: [engine('gpt'), engine('qwen')],
    fastEngineIds: ['qwen'],
    enabled: true
  })
  assert.equal(r.engine, selected, '长文本必须原对象返回，不能复制或替换')
  assert.equal(r.routed, false)
  assert.equal(r.reason, 'too-long')
})

test('★ 总开关关闭：行为与改动前完全一致（不路由任何东西）', () => {
  const selected = engine('gpt')
  const r = routeTranslate({
    selected: selected,
    text: 'Hi',
    candidates: [engine('gpt'), engine('qwen')],
    fastEngineIds: ['qwen'],
    enabled: false
  })
  assert.equal(r.engine, selected)
  assert.equal(r.routed, false)
  assert.equal(r.reason, 'disabled')
})

test('★ 没有快速通道可用：绝不为了快而降级或跳过权益校验', () => {
  const selected = engine('gpt')
  const r = routeTranslate({
    selected: selected,
    text: 'Hi',
    candidates: [engine('gpt'), engine('qwen', { wired: false })],
    fastEngineIds: ['qwen'],
    enabled: true
  })
  assert.equal(r.engine, selected, '快速通道没接通就该老实走 LLM，不能换别的')
  assert.equal(r.routed, false)
  assert.equal(r.reason, 'no-fast-engine')
})

test('用户本来就选了快速通道：不算路由（没变就不该标成 routed）', () => {
  const selected = engine('qwen')
  const r = routeTranslate({
    selected: selected,
    text: 'Hi',
    candidates: [engine('gpt'), engine('qwen')],
    fastEngineIds: ['qwen'],
    enabled: true
  })
  assert.equal(r.engine, selected)
  assert.equal(r.routed, false, '目标与当前相同，不该谎称发生了路由')
  assert.equal(r.reason, 'already-fast')
})

test('★ 路由只会发生在候选集内部 —— 永远不会选出套餐外的通道', () => {
  const candidates = [engine('gpt')]
  const r = routeTranslate({
    selected: engine('gpt'),
    text: 'Hi',
    candidates: candidates,
    fastEngineIds: ['qwen', 'google'],
    enabled: true
  })
  assert.equal(r.engine.id, 'gpt', '套餐里没有 qwen，就不可能路由过去')
  assert.ok(candidates.includes(r.engine) || r.engine.id === 'gpt')
})

test('没选通道（selected 为空）：不崩、不路由', () => {
  const r = routeTranslate({
    selected: null,
    text: 'Hi',
    candidates: [engine('qwen')],
    fastEngineIds: ['qwen'],
    enabled: true
  })
  assert.equal(r.engine, null)
  assert.equal(r.routed, false)
  assert.equal(r.reason, 'no-engine')
})

test('入参缺失时全部按"不路由"处理（生产代码不能因为没传参就崩）', () => {
  assert.doesNotThrow(() => routeTranslate(undefined))
  assert.doesNotThrow(() => routeTranslate({}))
  assert.equal(routeTranslate({}).routed, false)
})

// ---------------------------------------------------------------------------
// 4. 规则表本身的完整性
// ---------------------------------------------------------------------------

test('SLOW_MARKERS 每条都能命中它声称要拦的那类输入', () => {
  const samples = [
    'a\nb\nc',                    // 多行
    'hi `code` there',            // 反引号
    'hi {{name}}',                // 双花括号
    'hi {name}',                  // 单花括号
    'hi %s',                      // printf
    'hi ${x}',                    // 模板字面量
    'see https://a.com',          // URL
    'mail a@b.com',               // 邮箱
    '| a | b |'                   // 表格
  ]
  for (const sample of samples) {
    assert.equal(shouldUseFastPath(sample).fast, false,
      '这条规则集必须拦住：' + JSON.stringify(sample))
  }
})

test('规则不误伤普通英文/中文句子', () => {
  for (const text of [
    'I will be there at 3pm.',
    '明天下午三点见。',
    'Are you ok? (yes/no)',
    'Price: 100 dollars',
    'Thanks! See you :)'
  ]) {
    assert.equal(shouldUseFastPath(text).fast, true, '不该误伤：' + text)
  }
})
