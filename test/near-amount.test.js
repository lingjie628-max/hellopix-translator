'use strict'

/**
 * 近似金额匹配的单元测试。
 *
 * 这些用例全部来自**真实事故**，不是编出来的边界值：
 *
 *   2026-10-16  订单 21 应付 65.318，商户打成 65.138，系统判 NO_MATCH，
 *               超管手工确认收款但链上交易没绑定，同一笔钱散成三份记录。
 *
 * 所以这里的核心断言是两条：
 *   1. 该认出来的笔误要认出来（不然运维还得靠肉眼）
 *   2. **绝不出现在"自动入账"路径上**（认出来 ≠ 同意发钱）
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const nearAmount = require('../server/lib/near-amount')

const { isSuffixTypo, findCandidate, formatDelta, MATCH_KIND, CONFIDENCE } = nearAmount

// ---------------------------------------------------------------- 尾数形态

test('尾数笔误：数字重排能认出来', () => {
  // 真实事故：318 → 138
  assert.equal(isSuffixTypo(318, 138), true)
  assert.equal(isSuffixTypo(138, 318), true)
  // 其它重排
  assert.equal(isSuffixTypo(318, 813), true)
  assert.equal(isSuffixTypo(318, 831), true)
})

test('尾数笔误：单字符写错能认出来', () => {
  assert.equal(isSuffixTypo(318, 358), true)  // 中间一位
  assert.equal(isSuffixTypo(318, 218), true)  // 首位
  assert.equal(isSuffixTypo(318, 316), true)  // 末位
})

test('尾数笔误：只是数值接近不算笔误', () => {
  // 318 与 128 差两位数字，是另一笔钱而不是抄错
  assert.equal(isSuffixTypo(318, 128), false)
  // 318 与 423 无共同特征
  assert.equal(isSuffixTypo(318, 423), false)
})

test('尾数笔误：相同尾数不重复判定', () => {
  assert.equal(isSuffixTypo(318, 318), false)
})

test('尾数笔误：必须按三位补零比较', () => {
  // 37 与 73 是 037 vs 073 的重排
  assert.equal(isSuffixTypo(37, 73), true)
  // 5 与 50 → 005 vs 050，不是重排
  assert.equal(isSuffixTypo(5, 50), false)
})

// ---------------------------------------------------------------- 候选订单

/** 造一张订单：paid = base + suffix */
function order(id, baseMilli, suffixMilli, status) {
  return {
    id: String(id),
    orderNumber: `HP${id}`,
    status: status === undefined ? 0 : status,
    statusText: '待支付',
    baseMilli: String(baseMilli),
    surchargeMilli: suffixMilli === null ? null : String(suffixMilli),
    paidAmountMilli: String(BigInt(baseMilli) + BigInt(suffixMilli === null ? 0 : suffixMilli))
  }
}

test('真实事故复现：65.138 应识别为订单 65.318 的笔误', () => {
  // 订单 21：原价 65.000 + 尾数 0.318 = 65.318
  const found = findCandidate({
    amountMilli: 65138n,
    candidates: [order(21, 65000n, 318n, 1)]
  })
  assert.ok(found, '应当识别出候选订单')
  assert.equal(found.kind, MATCH_KIND.SUFFIX_TYPO)
  assert.equal(found.confidence, CONFIDENCE.SUFFIX_TYPO)
  assert.equal(found.order.orderNumber, 'HP21')
  assert.equal(found.deltaMilli, -180n)
  assert.match(found.reason, /318/)
  assert.match(found.reason, /138/)
})

test('漏付整个尾数：到账恰好等于订单基数', () => {
  const found = findCandidate({
    amountMilli: 65000n,
    candidates: [order(21, 65000n, 318n, 0)]
  })
  assert.ok(found)
  assert.equal(found.kind, MATCH_KIND.EXACT_BASE)
  assert.equal(found.deltaMilli, -318n)
})

test('精确相等不归近似匹配处理', () => {
  const found = findCandidate({
    amountMilli: 65318n,
    candidates: [order(21, 65000n, 318n, 0)]
  })
  assert.equal(found, null, '精确匹配必须走正常路径，不能落到近似逻辑')
})

test('差额超出尾数区间时不认作笔误', () => {
  // 差 5 USDT：不是抄错一个尾数能做到的
  const found = findCandidate({
    amountMilli: 70000n,
    candidates: [order(21, 65000n, 318n, 0)]
  })
  assert.ok(found)
  assert.equal(found.kind, MATCH_KIND.NEAR_AMOUNT, '只应给出低置信度提示')
  assert.equal(found.confidence, CONFIDENCE.NEAR_AMOUNT)
})

test('相差过大时不给任何候选', () => {
  const found = findCandidate({
    amountMilli: 14939607n,
    candidates: [order(21, 65000n, 318n, 0)]
  })
  assert.equal(found, null, '14 USDT 与 65 USDT 毫无关系，不该硬凑')
})

test('多个候选时取置信度最高、差额最小的那个', () => {
  const found = findCandidate({
    amountMilli: 65138n,
    candidates: [
      order(1, 65000n, 100n, 0),   // 差 38，但尾数是 100 vs 138 —— 两位不同，不算笔误
      order(2, 65000n, 318n, 0),   // 差 180，是笔误 ← 应当胜出
      order(3, 65000n, 140n, 0)    // 差 2，但尾数 140 vs 138 差一位… 这是单字符替换
    ]
  })
  assert.ok(found)
  // 3 号也是单字符替换（138 vs 140 差两位，实际不同），所以 2 号胜出
  assert.equal(found.order.orderNumber, 'HP2')
  assert.equal(found.kind, MATCH_KIND.SUFFIX_TYPO)
})

test('没有候选订单时返回 null', () => {
  assert.equal(findCandidate({ amountMilli: 65138n, candidates: [] }), null)
  assert.equal(findCandidate({ amountMilli: 65138n }), null)
})

test('早期没有尾数字段的订单：不能拿 0 冒充尾数做笔误比对', () => {
  const legacy = order(9, 65000n, null, 0)
  const found = findCandidate({ amountMilli: 65138n, candidates: [legacy] })
  // 差额 138 在松散范围内 → 只能是低置信度提示，绝不能是笔误
  assert.ok(found)
  assert.equal(found.kind, MATCH_KIND.NEAR_AMOUNT)
})

// ---------------------------------------------------------------- 展示

test('差额格式化：带符号、三位小数', () => {
  assert.equal(formatDelta(-180n), '-0.180')
  assert.equal(formatDelta(5000n), '+5.000')
  assert.equal(formatDelta(-1n), '-0.001')
  assert.equal(formatDelta(0n), '+0.000')
})

test('近似匹配永远不允许自动入账', () => {
  // 这条不是形式主义：near-amount 模块的返回结构里**不能**有"已确认"语义，
  // 任何调用方都必须自己决定是否人工处理。这里守住结构契约。
  const found = findCandidate({
    amountMilli: 65138n,
    candidates: [order(21, 65000n, 318n, 1)]
  })
  assert.ok(found)
  assert.equal(found.autoSettle, undefined, '模块本身不携带入账许可')
})
