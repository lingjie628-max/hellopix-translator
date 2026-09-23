'use strict'

/**
 * 标准化 Transfer 测试。
 *
 * 这一层是所有链上数据的入口，出错的方式很安静：
 * 精度换算差 1000 倍、非 USDT 代币没被滤掉、时间戳单位搞混 ——
 * 都不会抛异常，只会让订单匹配到错误的钱。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  USDT_TRC20_CONTRACT,
  CHAIN_DECIMALS,
  ORDER_DECIMALS,
  CHAIN_UNITS_PER_MILLI,
  makeTransfer,
  chainUnitsToMilli,
  milliToChainUnits,
  checkTransferEligibility,
  TransferError
} = require('../server/services/tron/transfer')

const TX = 'a'.repeat(64)
const FROM = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const TO = 'TEfCDDuYwYdjCn2WDa7TNWCU9bkBk9EXPX'
const TS = 1758600000000

function base(overrides) {
  return Object.assign({
    txId: TX,
    tokenContract: USDT_TRC20_CONTRACT,
    fromAddress: FROM,
    toAddress: TO,
    chainUnits: '35427000',
    blockTimestamp: TS,
    solidified: true
  }, overrides || {})
}

// ------------------------------------------------------------- 精度换算

test('精度常量：链上 6 位小数，订单 3 位小数', () => {
  assert.equal(CHAIN_DECIMALS, 6)
  assert.equal(ORDER_DECIMALS, 3)
  assert.equal(CHAIN_UNITS_PER_MILLI, 1000n)
})

test('链上最小单位 → milli：35.427 USDT 是 35427000 → 35427', () => {
  const r = chainUnitsToMilli('35427000')
  assert.equal(r.milli, 35427n)
  assert.equal(r.exact, true)
})

test('比订单更细的金额被标记为不精确，而不是四舍五入', () => {
  // 35.4270005 USDT —— 它不可能精确等于任何一张订单的应付金额
  const r = chainUnitsToMilli('35427001')
  assert.equal(r.milli, 35427n)
  assert.equal(r.exact, false, '有余数就必须标记为不精确')
  assert.equal(r.remainder, 1n)

  // 四舍五入会把它变成 35.427 然后撞上订单 —— 那正是要避免的
  const half = chainUnitsToMilli('35427500')
  assert.equal(half.milli, 35427n)
  assert.equal(half.exact, false)
})

test('边界：最小可表示金额 0.000001 → 0 milli 且不精确', () => {
  const r = chainUnitsToMilli('1')
  assert.equal(r.milli, 0n)
  assert.equal(r.exact, false)
})

test('大额不丢精度（Number 在这里会挂）', () => {
  // 90 亿 USDT = 9e9 * 1e6 = 9e15 链上单位，超过 2^53
  const big = '9000000000000000'
  const r = chainUnitsToMilli(big)
  assert.equal(r.milli, 9000000000000n)
  assert.equal(r.exact, true)
})

test('milli → 链上单位可逆', () => {
  assert.equal(milliToChainUnits(35427n), 35427000n)
  assert.equal(chainUnitsToMilli(milliToChainUnits(35427n)).milli, 35427n)
})

// ------------------------------------------------------------- 构造校验

test('合法输入构造出冻结的 Transfer', () => {
  const t = makeTransfer(base())
  assert.equal(t.txId, TX)
  assert.equal(t.amountMilli, 35427n)
  assert.equal(t.amountExact, true)
  assert.equal(t.toAddress, TO)
  assert.equal(t.solidified, true)
  assert.ok(Object.isFrozen(t), 'Transfer 必须是不可变的 —— 它是事实，不是草稿')
})

test('交易哈希必须 64 位十六进制', () => {
  assert.throws(() => makeTransfer(base({ txId: 'abc' })), TransferError)
  assert.throws(() => makeTransfer(base({ txId: 'z'.repeat(64) })), /交易哈希格式不合法/)
})

test('缺少合约/地址/时间戳一律拒绝，不静默放过', () => {
  assert.throws(() => makeTransfer(base({ tokenContract: '' })), /缺少代币合约/)
  assert.throws(() => makeTransfer(base({ toAddress: '' })), /缺少转出或转入地址/)
  assert.throws(() => makeTransfer(base({ blockTimestamp: 0 })), /区块时间不合法/)
  assert.throws(() => makeTransfer(base({ blockTimestamp: 'x' })), /区块时间不合法/)
})

test('交易哈希统一小写，避免同一笔被当成两笔', () => {
  const t = makeTransfer(base({ txId: 'A'.repeat(64) }))
  assert.equal(t.txId, 'a'.repeat(64))
})

// ------------------------------------------------------------- 资格过滤

test('正常转账通过资格检查', () => {
  const t = makeTransfer(base())
  assert.equal(checkTransferEligibility(t, { toAddress: TO }).ok, true)
})

test('非指定 USDT 合约必须被过滤', () => {
  // 链上叫 "USDT" 的仿盘合约很多，转进来同样数量但一文不值
  const fake = makeTransfer(base({ tokenContract: 'TFAKEfakeFAKEfakeFAKEfakeFAKEfake1' }))
  const r = checkTransferEligibility(fake, { toAddress: TO })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'WRONG_TOKEN')
})

test('收款地址不是平台地址必须被过滤', () => {
  const other = makeTransfer(base({ toAddress: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8' }))
  const r = checkTransferEligibility(other, { toAddress: TO })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'WRONG_ADDRESS')
})

test('精度比订单更细的金额不参与匹配', () => {
  const fine = makeTransfer(base({ chainUnits: '35427001' }))
  const r = checkTransferEligibility(fine, { toAddress: TO })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'AMOUNT_PRECISION_TOO_FINE')
})

test('零金额与非正金额被过滤', () => {
  const zero = makeTransfer(base({ chainUnits: '0' }))
  const r = checkTransferEligibility(zero, { toAddress: TO })
  assert.equal(r.ok, false)
  // 0 既不是正数、也不可能精确 —— 两条规则都该拦住它
  assert.ok(['NON_POSITIVE_AMOUNT', 'AMOUNT_PRECISION_TOO_FINE'].includes(r.reason))
})

test('默认合约是 TRC20 USDT 官方地址', () => {
  assert.equal(USDT_TRC20_CONTRACT, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')
  const t = makeTransfer(base())
  assert.equal(checkTransferEligibility(t, {}).ok, true, '不传 toAddress 时只校验合约')
})
