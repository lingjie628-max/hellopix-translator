'use strict'

/**
 * 结算结论构造器单测。**不连数据库。**
 *
 * `recharge-settlement.test.js` 是真库测试，验的是"钱有没有动对"。
 * 这个文件验的是更靠里的一层：**每个闸门给出的结论对象本身对不对**。
 *
 * 为什么要单独测：结论对象是 `handleTransfer` 与调用方（watcher、
 * 异常池页面、对账脚本）之间的契约。字段写错不会让任何 SQL 报错，
 * 只会让上游拿着 undefined 去做判断 —— 那是最难查的一类 bug。
 */

const test = require('node:test')
const assert = require('node:assert')

const verdicts = require('../server/services/recharge/settlement-verdicts')
const { OUTCOME, MATCH_KIND, EXCEPTION_KIND } = require('../server/services/recharge-settlement-constants')

const transfer = Object.freeze({
  txId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  eventIndex: 0,
  tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  fromAddress: 'TFrom',
  toAddress: 'TTo',
  amountMilli: 65318n,
  blockNumber: 12345,
  blockTimestamp: '2026-08-01T00:00:00.000Z',
  confirmations: 20,
  solidified: true
})

const order = Object.freeze({
  id: 42,
  orderNumber: 'RC20260801001',
  status: 1,
  statusText: '待支付',
  chars: 1000000,
  userId: '7'
})

/** 所有结论都必须能安全地交给 JSON.stringify —— 里面有 BigInt 就会当场炸 */
function jsonSafe(value) {
  return assert.doesNotThrow(() => JSON.stringify(value))
}

test('skipUnresolved：不落库结论，字段齐且不带任何入账意图', () => {
  const r = verdicts.skipUnresolved(transfer, '回执没取到')
  assert.equal(r.outcome, OUTCOME.SKIPPED_UNRESOLVED)
  assert.equal(r.matchKind, null)
  assert.equal(r.rechargeId, null)
  assert.equal(r.exceptionKind, null)
  assert.equal(r.detail.txId, transfer.txId)
  jsonSafe(r)
})

test('duplicateEvent：带上已有归属订单，且 mode 透传', () => {
  const r = verdicts.duplicateEvent({ inserted: false, existingRechargeId: 9, existingMode: 'live' })
  assert.equal(r.outcome, OUTCOME.DUPLICATE)
  assert.equal(r.matchKind, MATCH_KIND.DUPLICATE_TX)
  assert.equal(r.rechargeId, 9)
  assert.equal(r.detail.mode, 'live')
  jsonSafe(r)
})

test('duplicateEvent：历史记录没有归属订单时 rechargeId 是 null 而不是 undefined', () => {
  const r = verdicts.duplicateEvent({ inserted: false, existingRechargeId: null, existingMode: null })
  assert.strictEqual(r.rechargeId, null)
})

test('ineligible：WRONG_TOKEN 归到 WRONG_TOKEN，链上终态是 NOT_ELIGIBLE', () => {
  const service = {
    exceptionKindForEligibility: (reason) => (reason === 'WRONG_TOKEN' ? EXCEPTION_KIND.WRONG_TOKEN : EXCEPTION_KIND.NO_MATCH),
    eligibilitySummary: () => '代币不对'
  }
  const v = verdicts.ineligible(service, transfer, { ok: false, reason: 'WRONG_TOKEN' }, { toAddress: 'TTo' })
  assert.equal(v.exception.kind, EXCEPTION_KIND.WRONG_TOKEN)
  assert.equal(v.transactionPatch.status, 'exception')
  assert.equal(v.transactionPatch.matchKind, MATCH_KIND.NOT_ELIGIBLE)
  assert.equal(v.transactionPatch.rechargeId, null)
  assert.equal(v.transactionPatch.shadowAction.wouldSettle, false)
  assert.equal(v.result.outcome, OUTCOME.EXCEPTION)
  assert.equal(v.result.exceptionKind, EXCEPTION_KIND.WRONG_TOKEN)
  jsonSafe(v)
})

test('ineligible：没有 context 时 expected 是 null，不能是 undefined', () => {
  const service = { exceptionKindForEligibility: () => EXCEPTION_KIND.WRONG_ADDRESS, eligibilitySummary: () => 'x' }
  const v = verdicts.ineligible(service, transfer, { ok: false, reason: 'WRONG_ADDRESS' }, null)
  assert.strictEqual(v.exception.detail.expected, null)
})

test('noMatch：疑似候选原样进 detail，但 autoSettle 语义上绝不成立', () => {
  const suspicion = { kind: 'TYPO', orderNumber: 'RC1', autoSettle: false }
  const v = verdicts.noMatch({ noMatchSummary: () => '摘要' }, transfer, suspicion)
  assert.equal(v.exception.kind, EXCEPTION_KIND.NO_MATCH)
  assert.equal(v.exception.summary, '摘要')
  assert.equal(v.result.detail.suspicion, suspicion)
  assert.equal(v.transactionPatch.shadowAction.wouldSettle, false)
  assert.equal(v.transactionPatch.rechargeId, null)
  jsonSafe(v)
})

test('noMatch：无疑似归属时 suspicion 是 null，仍然可序列化', () => {
  const v = verdicts.noMatch({ noMatchSummary: (t, s) => (s ? 'a' : 'b') }, transfer, null)
  assert.strictEqual(v.result.detail.suspicion, null)
  assert.equal(v.exception.summary, 'b')
  jsonSafe(v)
})

test('latePayment：rechargeId 归 null —— 迟到款绝不改配给任何人', () => {
  const v = verdicts.latePayment(transfer, {
    order, reservation: { id: 3 }, reason: '订单已过期'
  })
  assert.equal(v.exception.kind, EXCEPTION_KIND.EXPIRED_PAYMENT)
  assert.equal(v.exception.rechargeId, order.id, '异常记录要指向原订单，方便人工追溯')
  assert.equal(v.exception.reservationId, 3)
  assert.strictEqual(v.transactionPatch.rechargeId, null, '链上交易不得绑定新订单')
  assert.equal(v.transactionPatch.matchKind, MATCH_KIND.LATE_PAYMENT)
  assert.equal(v.result.detail.belongedTo, order.orderNumber)
  jsonSafe(v)
})

test('latePayment：没有 reservation 时是 null 而不是 undefined', () => {
  const v = verdicts.latePayment(transfer, { order, reservation: null, reason: 'x' })
  assert.strictEqual(v.exception.reservationId, null)
})

test('duplicateTxid：链上终态 DUPLICATE_TX，异常类型 DUPLICATE_TXID', () => {
  const v = verdicts.duplicateTxid(transfer, { order }, { recharge_id: 88, event_index: 1 })
  assert.equal(v.exception.kind, EXCEPTION_KIND.DUPLICATE_TXID)
  assert.equal(v.exception.detail.settledRechargeId, 88)
  assert.equal(v.exception.detail.settledEventIndex, 1)
  assert.equal(v.transactionPatch.matchKind, MATCH_KIND.DUPLICATE_TX)
  assert.strictEqual(v.transactionPatch.rechargeId, null)
  assert.equal(v.result.detail.thisEventIndex, 0)
  jsonSafe(v)
})

test('duplicateTxid：摘要截断 TXID，不把 64 字节全塞进列表页', () => {
  const v = verdicts.duplicateTxid(transfer, { order }, { recharge_id: 1, event_index: 1 })
  assert.ok(v.exception.summary.length < 80, '摘要必须足够短')
  assert.ok(v.exception.summary.includes('a1b2c3d4e5f60718'))
})

test('shadowMatched：状态 seen 而不是 settled —— shadow 绝不留"已结算"痕迹', () => {
  const v = verdicts.shadowMatched(transfer, order)
  assert.equal(v.transactionPatch.status, 'seen')
  assert.equal(v.transactionPatch.shadowAction.wouldSettle, true)
  assert.equal(v.transactionPatch.shadowAction.executed, undefined, 'shadow 不得标记已执行')
  assert.equal(v.result.outcome, OUTCOME.SHADOW_MATCHED)
  assert.equal(v.result.detail.chars, 1000000)
  jsonSafe(v)
})

test('shadowCredit：amountMilli 是字符串，不能把 BigInt 塞进 JSON', () => {
  const action = verdicts.shadowCredit(transfer, order)
  assert.equal(typeof action.amountMilli, 'string')
  assert.equal(action.amountMilli, '65318')
  jsonSafe(action)
})

test('settled：返回结构必须带 result 和 transactionPatch 两段', () => {
  const v = verdicts.settled(transfer, order, { alreadyPaid: false, chars: 1000000, balanceAfter: 5 })
  assert.ok(v.result, 'result 段必须存在')
  assert.ok(v.transactionPatch, 'transactionPatch 段必须存在')
  assert.equal(v.result.outcome, OUTCOME.SETTLED)
  assert.equal(v.result.rechargeId, order.id)
  assert.equal(v.transactionPatch.status, 'settled')
  assert.equal(v.transactionPatch.matchKind, MATCH_KIND.MATCHED)
  assert.equal(v.transactionPatch.rechargeId, order.id)
  assert.ok(v.transactionPatch.settledAt instanceof Date)
  assert.equal(v.transactionPatch.shadowAction.executed, true)
  jsonSafe(v)
})

test('settled：补扫命中已付款订单 → 结论报 DUPLICATE，但链上记录仍是 settled', () => {
  const v = verdicts.settled(transfer, order, { alreadyPaid: true, chars: 0 })
  assert.equal(v.result.outcome, OUTCOME.DUPLICATE)
  assert.equal(v.transactionPatch.status, 'settled', '已付款是终态，不能退回 seen')
  assert.equal(v.transactionPatch.shadowAction.alreadyPaid, true)
})

test('所有结论的 exceptionKind 都必须是合法枚举或 null', () => {
  const service = { exceptionKindForEligibility: () => EXCEPTION_KIND.NO_MATCH, eligibilitySummary: () => '', noMatchSummary: () => '' }
  const allowed = new Set([...Object.values(EXCEPTION_KIND), null])
  const all = [
    verdicts.skipUnresolved(transfer, 'x'),
    verdicts.duplicateEvent({ inserted: false }),
    verdicts.ineligible(service, transfer, { ok: false, reason: 'X' }, {}).result,
    verdicts.noMatch(service, transfer, null).result,
    verdicts.latePayment(transfer, { order, reservation: null, reason: 'r' }).result,
    verdicts.duplicateTxid(transfer, { order }, { recharge_id: 1, event_index: 1 }).result,
    verdicts.shadowMatched(transfer, order).result,
    verdicts.settled(transfer, order, { alreadyPaid: false }).result
  ]
  for (const r of all) assert.ok(allowed.has(r.exceptionKind), `非法 exceptionKind: ${r.exceptionKind}`)
})

test('所有结论的 matchKind 都必须是合法枚举或 null', () => {
  const allowed = new Set([...Object.values(MATCH_KIND), null])
  const all = [
    verdicts.skipUnresolved(transfer, 'x'),
    verdicts.duplicateEvent({ inserted: false }),
    verdicts.shadowMatched(transfer, order).result,
    verdicts.settled(transfer, order, { alreadyPaid: false }).result
  ]
  for (const r of all) assert.ok(allowed.has(r.matchKind), `非法 matchKind: ${r.matchKind}`)
})
