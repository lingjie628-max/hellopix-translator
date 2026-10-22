'use strict'

/**
 * 用**生产库真实数据**验证近似匹配逻辑（不连数据库）。
 *
 * 数据来源：2026-10-21 从 hello_pix 生产库只读导出的 recharges 全表。
 * 只有两行，所以这里逐字复刻，不做抽象 —— 抽象的测试容易在改动后
 * 仍然通过，而真实数据的形状才是它必须处理的东西。
 *
 * ```
 * 20 | HP1791325610408358 | status=1(已付) | 应付 35.685 | 尾数 0.685 | 基数 35.000
 * 21 | HP1792181934903294 | status=1(已付) | 应付 65.318 | 尾数 0.318 | 基数 65.000
 * ```
 *
 * 链上实际到账（同一份导出）：
 * ```
 * 35685  → 35.685  精确匹配订单 20（正确路径）
 * 65138  → 65.138  订单 21 的笔误（本次修复要抓到的）
 * 80000  → 80.000  与两张订单都无关
 * 7090000 → 7090.000 大额整数，与两张订单都无关
 * ```
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const { findCandidate, MATCH_KIND } = require('../server/lib/near-amount')
const { toMilli } = require('../server/lib/money')

/** 生产库 recharges 表的真实两行，转成 findCandidate 需要的形状 */
const PROD_ORDERS = [
  { id: '20', orderNumber: 'HP1791325610408358', status: 1, statusText: '已支付' },
  { id: '21', orderNumber: 'HP1792181934903294', status: 1, statusText: '已支付' }
].map((row, i) => {
  const paid = i === 0 ? '35.685' : '65.318'
  const surcharge = i === 0 ? '0.685' : '0.318'
  const base = i === 0 ? '35.000' : '65.000'
  return {
    ...row,
    paidAmountMilli: toMilli(paid).toString(),
    surchargeMilli: toMilli(surcharge).toString(),
    baseMilli: toMilli(base).toString()
  }
})

/** 生产库 chain_transactions 的真实到账金额 */
function settled(amountUsdt) {
  return toMilli(amountUsdt)
}

test('生产数据：35.685 精确命中订单 20 时不属于近似匹配', () => {
  const found = findCandidate({
    amountMilli: settled('35.685'),
    candidates: PROD_ORDERS
  })
  assert.equal(found, null, '精确匹配必须留给正常路径，不能被近似逻辑抢走')
})

test('生产数据：65.138 识别为订单 21 的尾数笔误', () => {
  const found = findCandidate({
    amountMilli: settled('65.138'),
    candidates: PROD_ORDERS
  })
  assert.ok(found, '这是 2026-10-16 真实发生的事故，必须能识别')
  assert.equal(found.kind, MATCH_KIND.SUFFIX_TYPO)
  assert.equal(found.order.orderNumber, 'HP1792181934903294')
  assert.equal(found.deltaMilli, toMilli('-0.180'))
  assert.match(found.reason, /318/)
  assert.match(found.reason, /138/)
})

test('生产数据：80.000 不硬凑到任何订单', () => {
  const found = findCandidate({
    amountMilli: settled('80.000'),
    candidates: PROD_ORDERS
  })
  assert.equal(found, null, '80 与 35/65 相差太远，不该给出候选')
})

test('生产数据：7,090.000 大额整数不硬凑', () => {
  const found = findCandidate({
    amountMilli: settled('7090.000'),
    candidates: PROD_ORDERS
  })
  assert.equal(found, null)
})

test('生产数据：3,982.037 与 696.789 不硬凑', () => {
  for (const amount of ['3982.037', '696.789', '14939.607', '10052.000']) {
    const found = findCandidate({
      amountMilli: settled(amount),
      candidates: PROD_ORDERS
    })
    assert.equal(found, null, `${amount} 不该被硬凑到任何订单`)
  }
})

test('生产数据：恰好只付基数（漏掉尾数）也能识别', () => {
  // 商户有时会直接转整数金额，忘记加尾数
  const found = findCandidate({
    amountMilli: settled('65.000'),
    candidates: PROD_ORDERS
  })
  assert.ok(found)
  assert.equal(found.kind, MATCH_KIND.EXACT_BASE)
  assert.equal(found.order.orderNumber, 'HP1792181934903294')
})
