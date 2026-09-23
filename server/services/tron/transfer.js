'use strict'

/**
 * 标准化链上转账（Normalized Transfer）。
 *
 * ## 这一层存在的唯一理由
 *
 * 第三方数据源（TronGrid、备用 Provider、自建节点）的**返回格式各不相同**：
 * TronGrid 给 `value` 是 6 位小数的字符串、时间戳是毫秒整数、字段名用下划线；
 * 自建节点的 JSON-RPC 又是另一套。如果让 `SettlementService` 直接读这些字段，
 * 那么换一次数据源就要重写一次结算逻辑 —— 而结算逻辑是资金路径，最不该频繁动。
 *
 * 所以：**Provider 负责把各自格式翻成这里定义的 Transfer，
 * 业务层只认这一个结构。**
 *
 * ## 金额一律 milli-USDT 整数
 *
 * 链上 USDT 是 6 位小数（最小单位 0.000001），而订单金额是 3 位小数。
 * 转换必须精确、且要能判断"链上金额能不能被 3 位小数整除"——
 * 一笔 35.4270005 USDT 的转账不属于任何订单，不能四舍五入后去撞单。
 *
 * ## 不可变
 *
 * 用 Object.freeze：Transfer 从 Provider 出来之后就只是**事实**，
 * 下游任何一步都不该改它。要附加信息（匹配到哪张订单）请另开对象。
 */

const { ApiError } = require('../../lib/http')

const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
/** 链上 USDT 的精度：6 位小数 */
const CHAIN_DECIMALS = 6
/** 订单金额精度：3 位小数 */
const ORDER_DECIMALS = 3

const CHAIN_UNITS_PER_MILLI = 10n ** BigInt(CHAIN_DECIMALS - ORDER_DECIMALS) // 1000

/**
 * 链上最小单位整数 → milli-USDT。
 *
 * 不能整除时返回 `exact: false` —— 这表示"这笔金额的精度比订单更细，
 * 它不可能精确等于任何一张订单的应付金额"。这种交易不该被四舍五入后
 * 拿去撞单，而应当走异常识别。
 */
function chainUnitsToMilli(chainUnits) {
  const units = BigInt(chainUnits)
  const negative = units < 0n
  const abs = negative ? -units : units
  const milli = abs / CHAIN_UNITS_PER_MILLI
  const remainder = abs % CHAIN_UNITS_PER_MILLI
  return {
    milli: negative ? -milli : milli,
    exact: remainder === 0n,
    remainder
  }
}

/** milli-USDT → 链上最小单位（用于测试与反向核对） */
function milliToChainUnits(milli) {
  return BigInt(milli) * CHAIN_UNITS_PER_MILLI
}

/**
 * TRC20 `Transfer(address,address,uint256)` 的事件签名哈希。
 * 只处理这一种事件 —— TRC20 的转账就是它，别的（Approve 等）与充值无关。
 */
const TRANSFER_EVENT_SIGNATURE =
  'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

class TransferError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'TransferError'
    this.code = code || 'BAD_TRANSFER'
  }
}

/**
 * 构造一个标准化 Transfer。
 *
 * @param {object} input
 * @param {string} input.txId             链上交易哈希
 * @param {number} [input.logIndex]       同一交易内的事件序号
 * @param {string} input.tokenContract    代币合约地址
 * @param {string} input.fromAddress      付款方
 * @param {string} input.toAddress        收款方
 * @param {string|number|bigint} input.chainUnits 链上最小单位金额
 * @param {number} input.blockTimestamp   区块时间（毫秒）
 * @param {number} [input.blockNumber]    区块高度（Provider 给不出时为 null）
 * @param {boolean} [input.solidified]    是否已最终确认
 * @param {object} [input.raw]            原始应答，留档用
 */
function makeTransfer(input) {
  const txId = String((input && input.txId) || '').trim()
  if (!/^[0-9a-fA-F]{64}$/.test(txId)) {
    throw new TransferError(`交易哈希格式不合法：${JSON.stringify(txId)}`, 'BAD_TX_ID')
  }
  const tokenContract = String((input && input.tokenContract) || '').trim()
  const fromAddress = String((input && input.fromAddress) || '').trim()
  const toAddress = String((input && input.toAddress) || '').trim()
  if (!tokenContract) throw new TransferError('缺少代币合约地址', 'BAD_TOKEN_CONTRACT')
  if (!fromAddress || !toAddress) throw new TransferError('缺少转出或转入地址', 'BAD_ADDRESS')

  const blockTimestamp = Number(input.blockTimestamp)
  if (!Number.isFinite(blockTimestamp) || blockTimestamp <= 0) {
    throw new TransferError(`区块时间不合法：${input.blockTimestamp}`, 'BAD_BLOCK_TIMESTAMP')
  }

  const { milli, exact, remainder } = chainUnitsToMilli(input.chainUnits)

  return Object.freeze({
    txId: txId.toLowerCase(),
    logIndex: Number.isInteger(input.logIndex) ? input.logIndex : 0,
    tokenContract,
    fromAddress,
    toAddress,
    /** 链上原始最小单位（字符串形式，避免精度问题） */
    chainUnits: BigInt(input.chainUnits).toString(),
    /** milli-USDT 整数（BigInt）—— 下游一律用这个 */
    amountMilli: milli,
    /** 链上金额能否被订单精度整除。false = 比订单更细，不可能精确匹配 */
    amountExact: exact,
    amountRemainder: remainder,
    chainDecimals: CHAIN_DECIMALS,
    blockTimestamp,
    blockNumber: Number.isInteger(input.blockNumber) ? input.blockNumber : null,
    solidified: input.solidified === true,
    raw: input.raw || null
  })
}

/**
 * 判断这个 Transfer 是否"可参与匹配"。
 *
 * 过滤规则集中在这里，而不是散落在扫描、匹配、结算三处 ——
 * 一处漏掉就会出现「非 USDT 代币被当成 USDT 入账」这类事故。
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function checkTransferEligibility(transfer, options) {
  const opts = options || {}
  const expectedContract = opts.tokenContract || USDT_TRC20_CONTRACT

  if (transfer.tokenContract !== expectedContract) {
    return { ok: false, reason: 'WRONG_TOKEN' }
  }
  if (opts.toAddress && transfer.toAddress !== opts.toAddress) {
    return { ok: false, reason: 'WRONG_ADDRESS' }
  }
  if (transfer.amountMilli <= 0n) {
    return { ok: false, reason: 'NON_POSITIVE_AMOUNT' }
  }
  if (!transfer.amountExact) {
    // 精度比订单更细，永远不可能精确等于任何订单金额
    return { ok: false, reason: 'AMOUNT_PRECISION_TOO_FINE' }
  }
  return { ok: true }
}

module.exports = {
  USDT_TRC20_CONTRACT,
  CHAIN_DECIMALS,
  ORDER_DECIMALS,
  CHAIN_UNITS_PER_MILLI,
  TRANSFER_EVENT_SIGNATURE,
  TransferError,
  makeTransfer,
  chainUnitsToMilli,
  milliToChainUnits,
  checkTransferEligibility
}
