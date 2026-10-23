/**
 * 译文句末句点清理的负向测试。
 *
 * 这个模块的风险全在"删多了"：把 `3.5` 删成 `35`、把 `e.g.` 删成 `e.g`、
 * 把省略号删成两个点 —— 都是用户一眼能看见、而且很难解释的破坏。
 * 所以下面每一条"不该删"的断言都比"该删"的更重要。
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const { trimTrailingDot, trailingDotRemovable } = require('../server/lib/trailing-dot')

test('原文没有句末标点、译文多了句点 → 删掉', () => {
  const cases = [
    ['在吗', 'Are you there.', 'Are you there'],
    ['今天几号', 'What is the date today.', 'What is the date today'],
    ['我到了', 'I have arrived.', 'I have arrived'],
    ['好的', 'Okay.', 'Okay'],
    ['收到', 'Received.', 'Received']
  ]
  for (const [src, out, want] of cases) {
    assert.equal(trimTrailingDot(src, out), want, `${src} → ${out}`)
  }
})

test('原文自带句末标点 → 译文保留不动', () => {
  const cases = [
    ['Are you there?', '你在吗？'],
    ['Are you there.', '你在那里。'],
    ['在吗。', 'Are you there.'],
    ['真的吗！', 'Really!'],
    ['我到了?', 'I arrived.'],
    ['你好，', 'Hello.'],
    ['我到了~', 'I arrived.']
  ]
  for (const [src, out] of cases) {
    assert.equal(trimTrailingDot(src, out), out, `原文 ${src} 有标点，不该动`)
  }
})

// ── 不该删的 ────────────────────────────────────────────────
// 下面这些一旦删了就是数据损坏。

test('数字后收句：删句点；小数/版本号本体：不动', () => {
  // 末尾是小数点的一部分 → 保留（本体就是数字，不是句子）
  assert.equal(trimTrailingDot('价格', 'The price is 2.5'), 'The price is 2.5')
  assert.equal(trimTrailingDot('版本', 'v1.2.0'), 'v1.2.0')
  // 模型在数字后补的句点 → 删
  assert.equal(trimTrailingDot('总共一百', 'Total 100.'), 'Total 100')
  assert.equal(trimTrailingDot('价格', 'The price is 2.5.'), 'The price is 2.5')
  assert.equal(trimTrailingDot('版本 1.2.0', 'Version 1.2.0.'), 'Version 1.2.0')
})

test('英文缩写不能删', () => {
  const cases = ['Mr.', 'Dr.', 'etc.', 'e.g.', 'i.e.', 'Inc.', 'vs.']
  for (const out of cases) {
    assert.equal(trimTrailingDot('称呼', `Hello ${out}`), `Hello ${out}`, `${out} 是缩写，不该删`)
  }
})

test('省略号（连续点）不能删', () => {
  for (const out of ['Wait...', 'Well..', 'Hmm....']) {
    assert.equal(trimTrailingDot('等等', out), out, `${out} 是省略号`)
    assert.equal(trailingDotRemovable(out), false)
  }
})

test('中文句号、感叹、问号一律不删', () => {
  const cases = ['好的。', '太好了！', '真的吗？', '我想想…']
  for (const out of cases) {
    assert.equal(trimTrailingDot('原文', out), out, `${out} 是真实语义`)
  }
})

test('多行文本不动（列表/对话片段的标点属于格式）', () => {
  const out = 'Line one.\nLine two.'
  assert.equal(trimTrailingDot('一行\n两行', out), out)
})

test('空译文、纯空白原样返回', () => {
  assert.equal(trimTrailingDot('在吗', ''), '')
  assert.equal(trimTrailingDot('在吗', '   '), '   ')
  assert.equal(trimTrailingDot('', ''), '')
})

test('没有句点时不做任何事（含换行、问号结尾的英文）', () => {
  assert.equal(trimTrailingDot('在吗', 'Are you there?'), 'Are you there?')
  assert.equal(trimTrailingDot('在吗', 'Are you there'), 'Are you there')
})

test('尾随空白保留：只删点，不吞空格结构', () => {
  assert.equal(trimTrailingDot('在吗', 'Are you there. '), 'Are you there ')
})

test('原文尾部空白不影响判定', () => {
  assert.equal(trimTrailingDot('在吗   ', 'Are you there.'), 'Are you there')
  assert.equal(trimTrailingDot('在吗\n', 'Are you there.'), 'Are you there')
})

test('中间的点不受影响', () => {
  // 版本号本身的小数点保留，末尾模型加的句点删掉
  assert.equal(trimTrailingDot('版本 1.2.0', 'Version 1.2.0.'), 'Version 1.2.0')
  assert.equal(trimTrailingDot('版本 1.2.0', 'Version 1.2.0'), 'Version 1.2.0')
  // 小数在句末：整个就是数字，不能动
  assert.equal(trimTrailingDot('三块五', '3.5'), '3.5')
  assert.equal(trimTrailingDot('价格', 'The price is 2.5'), 'The price is 2.5')
  // 数字后收句：该删
  assert.equal(trimTrailingDot('总共一百', 'Total 100.'), 'Total 100')
})
test('幂等：清理两次结果一致', () => {
  const once = trimTrailingDot('在吗', 'Are you there.')
  assert.equal(trimTrailingDot('在吗', once), once)
})

test('非字符串入参不抛错', () => {
  assert.equal(trimTrailingDot(null, null), '')
  assert.equal(trimTrailingDot(undefined, undefined), '')
  assert.equal(trimTrailingDot(123, 'OK.'), 'OK')
})
