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

const { base58Decode } = require('../../lib/tron-address')

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

/**
 * base58 地址 → 事件日志里的 20 字节 hex 形式（无 0x41 前缀、无校验和）。
 *
 * 为什么需要：TronGrid 的账户接口给的是 base58（`TR7NHq...`），
 * 而交易回执里的 `log.address` 与 `topics` 给的是 hex。
 * 两边要能对上，才能从 log 数组里定位到"哪一个事件是转给我们的"。
 *
 * 实测：`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`
 *   base58Decode → 41 a614f803b6fd780986a42c78ec9c7f77e6ded13c 710277f5
 *                  ^^ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ ^^^^^^^^
 *                 前缀        20 字节地址                     4 字节校验和
 *   log.address  → a614f803b6fd780986a42c78ec9c7f77e6ded13c  ← 取中间 20 字节
 */
function addressToLogHex(address) {
  const raw = base58Decode(String(address || '').trim())
  if (!raw || raw.length !== 25 || raw[0] !== 0x41) return null
  return Buffer.from(raw.subarray(1, 21)).toString('hex')
}

/** topics 里的地址是 32 字节左填充，取后 40 位 hex */
function topicToLogHex(topic) {
  const text = String(topic || '').trim().toLowerCase().replace(/^0x/, '')
  if (text.length < 40) return null
  return text.slice(-40)
}

/**
 * 解析交易回执里的 `log[]`，找出属于本次收款的事件下标。
 *
 * ## 为什么必须这么做
 *
 * **TronGrid 的 TRC20 账户接口不返回事件序号。** 实测它只给
 * `transaction_id / token_info / block_timestamp / from / to / type / value`
 * 七个字段，没有任何 index/logIndex。
 *
 * 而一笔交易**可以包含多个 Transfer 事件**（合约中转、批量转账都会）。
 * 如果拿 `tx_id` 当唯一键，第二个事件会被唯一约束静默丢掉 ——
 * 钱到了却没人知道。
 *
 * 所以事件位置从**回执数据**里补出来：`log` 数组的下标就是稳定的事件位置
 * （同一笔交易的事件顺序在区块里是固定的，重放多少次都一样）。
 * **不是伪造的序号** —— 它来自链上数据本身。
 *
 * 匹配依据：事件签名 == Transfer、合约地址一致、收款地址一致。
 *
 * @returns {number[]} 命中的 log 下标，升序。空数组 = 没找到
 */
function findTransferLogIndexes(logs, { tokenContract, toAddress }) {
  const contractHex = addressToLogHex(tokenContract)
  const toHex = addressToLogHex(toAddress)
  if (!contractHex || !toHex) return []
  const indexes = []
  const list = Array.isArray(logs) ? logs : []
  for (let i = 0; i < list.length; i++) {
    const entry = list[i]
    if (!entry) continue
    const address = String(entry.address || '').toLowerCase().replace(/^0x/, '')
    if (address !== contractHex) continue
    const topics = Array.isArray(entry.topics) ? entry.topics : []
    if (String(topics[0] || '').toLowerCase().replace(/^0x/, '') !== TRANSFER_EVENT_SIGNATURE) continue
    // Transfer(address,address,uint256)：topics[1]=from, topics[2]=to
    if (topicToLogHex(topics[2]) !== toHex) continue
    indexes.push(i)
  }
  return indexes
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
 * @param {number|null} input.eventIndex  同一交易内的**真实**事件位置。
 *   来自交易回执 `log[]` 的下标。一笔交易可以有多个 Transfer 事件，
 *   所以 (txId + eventIndex) 才是链上事实的唯一标识。
 *   **null 表示没能确定位置** —— 调用方必须跳过，绝不允许编造序号。
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

  const rawEventIndex = input.eventIndex
  // 明确区分「位置是 0」和「位置未知」：前者是合法事件位置，
  // 后者必须为 null，否则会把未知当成第一个事件，静默吞掉真正的事件 0
  const eventIndex = Number.isInteger(rawEventIndex) && rawEventIndex >= 0 ? rawEventIndex : null

  return Object.freeze({
    txId: txId.toLowerCase(),
    eventIndex,
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
  checkTransferEligibility,
  addressToLogHex,
  topicToLogHex,
  findTransferLogIndexes
}
