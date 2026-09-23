'use strict'

/**
 * TronGrid Provider。
 *
 * TronGrid 是 Tron 官方的托管 API。选它而不是自建节点：
 * 免费额度够用、无需维护、且自带 `walletsolidity` 端点直接给最终确认块。
 *
 * ## 这个文件是"隔离层"
 *
 * 下面所有第三方字段名（`token_info` / `value` / `block_timestamp` /
 * `fingerprint` / `meta.links.next`）**只允许出现在这里**。
 * 出了这个文件，业务层看到的一律是 `NormalizedTransfer`。
 *
 * ## 实测过的三件事（都不是推测）
 *
 * 1. **TRC20 账户接口不返回事件序号。**
 *    它只给 `transaction_id / token_info / block_timestamp / from / to /
 *    type / value` 七个字段，没有任何 index / logIndex。
 *
 * 2. **分页游标是 `meta.fingerprint`**（一长串不透明 base64）。
 *    实测翻页两页零重叠，fingerprint 随页推进。
 *    它对外**原样透传**为 `nextCursor` —— 调用方不该解析它。
 *
 * 3. **事件位置可以从交易回执补出来。**
 *    `POST /wallet/gettransactioninfobyid` 返回 `log[]`，数组下标就是稳定的事件位置
 *    （同一笔交易的事件顺序在区块里固定，重放多少次都一样）。
 *    这不是伪造序号，是链上数据本身。
 *
 * ## 限流
 *
 * TRC20 账户端点免费额度是 **1 请求/秒**，超了会被挂起 5 秒
 * （实测报文：`allowed_rps(1), and the query server is suspended for 5 s`）。
 * 所以：单次扫描最多翻 maxPages 页，且 `gettransactioninfobyid` 按交易去重后
 * 才调用 —— 同一笔交易在一页里出现多次只查一次回执。
 */

const { TronProvider, ProviderError, requestJson } = require('./tron-provider')
const {
  USDT_TRC20_CONTRACT, makeTransfer, findTransferLogIndexes
} = require('./transfer')

const DEFAULT_BASE_URL = 'https://api.trongrid.io'
/** 单页上限。TronGrid 最大 200，取满以减少翻页次数 */
const PAGE_LIMIT = 200
/**
 * 单次扫描最多翻多少页。
 *
 * 防的是"游标落后太多时一次拉几万条"把 worker 拖死，也顺手照顾了 1 rps 限流。
 * 拉满就返回 hasMore=true，下一轮继续 —— 游标会稳步追上去，
 * 而且因为幂等，重复覆盖一段也没关系。
 */
const MAX_PAGES_PER_SCAN = 10
/** 解事件序号时，单轮最多为多少笔交易查回执（1 rps 限流下要克制） */
const MAX_RECEIPT_LOOKUPS = 50

class TronGridProvider extends TronProvider {
  constructor(options) {
    super()
    const opts = options || {}
    this.baseUrl = String(opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.apiKey = String(opts.apiKey || '').trim()
    this.timeoutMs = Number(opts.timeoutMs) || 15000
    this.pageLimit = Math.min(PAGE_LIMIT, Math.max(1, Number(opts.pageLimit) || PAGE_LIMIT))
    this.maxPages = Math.max(1, Number(opts.maxPagesPerScan) || MAX_PAGES_PER_SCAN)
    this.maxReceiptLookups = Math.max(0, Number(opts.maxReceiptLookups) || MAX_RECEIPT_LOOKUPS)
    // 便于测试注入自己的 fetch
    this.request = opts.request || requestJson
    /** 回执缓存：同一笔交易在一页里出现多次只查一次 */
    this.receiptCache = new Map()
  }

  get name() {
    return 'trongrid'
  }

  headers() {
    const headers = {}
    // 没配 key 也能用，只是额度低很多 —— 所以这里是可选而不是必填
    if (this.apiKey) headers['TRON-PRO-API-KEY'] = this.apiKey
    return headers
  }

  /**
   * 最终确认块（solidified）。
   *
   * 用 `walletsolidity` 而不是 `wallet`：后者给的是最新块，
   * 最新块上的交易还可能被回滚，拿它当"已确认"会提前入账。
   */
  async latestSolidBlock() {
    const body = await this.request(`${this.baseUrl}/walletsolidity/getnowblock`, {
      method: 'POST',
      headers: this.headers(),
      timeoutMs: this.timeoutMs
    })
    const raw = body && body.block_header && body.block_header.raw_data
    const blockNumber = Number(raw && raw.number)
    const blockTimestamp = Number(raw && raw.timestamp)
    if (!Number.isFinite(blockNumber) || !Number.isFinite(blockTimestamp)) {
      throw new ProviderError('TronGrid 返回的区块结构不认识', { code: 'BAD_RESPONSE', retryable: true })
    }
    return { blockNumber, blockTimestamp }
  }

  /** 交易回执（带 `log[]`）。结果缓存，同一轮内同一笔只查一次 */
  async transactionInfo(txId) {
    const key = String(txId).toLowerCase()
    if (this.receiptCache.has(key)) return this.receiptCache.get(key)
    if (this.receiptCache.size >= this.maxReceiptLookups) return null
    let value = null
    try {
      value = await this.request(`${this.baseUrl}/wallet/gettransactioninfobyid`, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, this.headers()),
        body: JSON.stringify({ value: txId }),
        timeoutMs: this.timeoutMs
      })
    } catch (_error) {
      // 单笔回执查不到不该让整轮扫描失败 —— 但它会导致该条 eventIndex 为 null，
      // 调用方据此跳过并**不推进游标**，下一轮会重来
      value = null
    }
    this.receiptCache.set(key, value)
    return value
  }

  /**
   * 某个 TRC20 交易的区块高度（可选能力，拿不到返回 null）。
   *
   * 注意 `Number(null)` 是 **0** 而不是 NaN —— 只判 isFinite 会把
   * "拿不到" 返回成 0，看起来像个合法块高。所以这里额外要求 > 0。
   */
  async getTransactionBlock(txId) {
    const info = await this.transactionInfo(txId)
    if (!info) return null
    const number = Number(info.blockNumber)
    return Number.isFinite(number) && number > 0 ? number : null
  }

  /**
   * 拉取转入。
   *
   * 翻页用 `meta.fingerprint`（不透明游标）。
   * **不要用 `meta.links.next` 直接请求**：那个 URL 把全部参数都带上了，
   * 用它等于把请求构造权交给上游；自己拼更可控，也避免把 api key 之外的
   * 东西一并带出去。
   */
  async listIncomingTransfers(params) {
    const p = params || {}
    const toAddress = String(p.toAddress || '').trim()
    if (!toAddress) throw new ProviderError('缺少收款地址', { code: 'BAD_REQUEST', retryable: false })
    const tokenContract = String(p.tokenContract || USDT_TRC20_CONTRACT).trim()
    const limit = Math.min(this.pageLimit, Math.max(1, Number(p.limit) || this.pageLimit))
    const fromTimestamp = Number(p.fromTimestamp) || 0
    const toTimestamp = Number.isFinite(Number(p.toTimestamp)) ? Number(p.toTimestamp) : Date.now()
    // 不透明游标：原样带回给上游，不做任何解析
    let cursor = p.cursor ? String(p.cursor) : ''

    const solid = await this.latestSolidBlock()

    const rows = []
    let pages = 0
    let hasMore = false
    this.receiptCache.clear()

    while (pages < this.maxPages) {
      const query = new URLSearchParams()
      query.set('only_to', 'true')          // 只要转入，减少一半数据量
      query.set('limit', String(limit))
      query.set('min_timestamp', String(fromTimestamp))
      query.set('max_timestamp', String(toTimestamp))
      query.set('contract_address', tokenContract)
      if (cursor) query.set('fingerprint', cursor)

      const body = await this.request(
        `${this.baseUrl}/v1/accounts/${encodeURIComponent(toAddress)}/transactions/trc20?${query.toString()}`,
        { method: 'GET', headers: this.headers(), timeoutMs: this.timeoutMs }
      )

      if (!body || body.success === false) {
        throw new ProviderError('TronGrid 返回 success=false', { code: 'UPSTREAM_ERROR', retryable: true })
      }
      const page = Array.isArray(body.data) ? body.data : []
      rows.push(...page)

      // 官方分页游标。拿不到就说明没有下一页。
      cursor = String((body.meta && body.meta.fingerprint) || '')
      pages += 1
      if (!cursor || page.length < limit) break
      if (pages >= this.maxPages) hasMore = true
    }

    const transfers = await this.normalizeAll(rows, { toAddress, tokenContract, solid })

    // 上游不保证有序；游标推进依赖"处理到哪个时间点"，必须自己排好
    transfers.sort((a, b) => (a.blockTimestamp - b.blockTimestamp) || (a.txId < b.txId ? -1 : 1))

    return {
      transfers,
      hasMore,
      // 不透明游标原样交给调用方；null 表示没有更多页
      nextCursor: cursor || null,
      solidBlock: solid
    }
  }

  /**
   * 把账户接口的一批记录转成 NormalizedTransfer，并**补上真实事件序号**。
   *
   * 事件序号来自交易回执的 `log[]` 下标。同一笔交易若在结果里出现多次
   * （说明它有多个 Transfer 事件），按出现顺序依次分配回执里的命中下标 ——
   * 这样每个事件都有自己独立的位置，不会被 `tx_id` 唯一约束吃掉。
   */
  async normalizeAll(rows, context) {
    // 先按 txId 分组，避免同一笔交易查多次回执（1 rps 限流下很关键）
    const byTx = new Map()
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      if (row.type && row.type !== 'Transfer') continue
      const txId = String(row.transaction_id || '').trim().toLowerCase()
      if (!txId) continue
      if (!byTx.has(txId)) byTx.set(txId, [])
      byTx.get(txId).push(row)
    }

    const out = []
    for (const [txId, group] of byTx) {
      const info = await this.transactionInfo(txId)
      const logs = (info && info.log) || null
      // 命中回执里的哪些 log 才是"转给我们这笔代币"的
      const indexes = logs
        ? findTransferLogIndexes(logs, {
          tokenContract: context.tokenContract,
          toAddress: context.toAddress
        })
        : []

      group.forEach((row, i) => {
        // 事件位置：优先用回执里命中的下标；命中数不够时留 null 交给上层跳过
        const eventIndex = i < indexes.length ? indexes[i] : null
        const transfer = this.normalize(row, Object.assign({ eventIndex }, context))
        if (transfer) out.push(transfer)
      })
    }
    return out
  }

  /**
   * TronGrid 单条记录 → NormalizedTransfer。
   * 不认识的形状返回 null（跳过），而不是抛错。
   */
  normalize(row, context) {
    if (!row || typeof row !== 'object') return null
    // 只认标准 Transfer 事件；Approve / TransferFrom 之类与充值无关
    if (row.type && row.type !== 'Transfer') return null
    const tokenInfo = row.token_info || {}
    const contract = String(tokenInfo.address || '').trim()
    if (!contract) return null
    const to = String(row.to || '').trim()
    if (!to) return null
    const value = row.value
    if (value === undefined || value === null || value === '') return null

    const blockTimestamp = Number(row.block_timestamp)
    if (!Number.isFinite(blockTimestamp) || blockTimestamp <= 0) return null

    try {
      return makeTransfer({
        txId: row.transaction_id,
        // null 表示"没能确定事件位置" —— 上层必须跳过，不得编造
        eventIndex: context.eventIndex === undefined ? null : context.eventIndex,
        tokenContract: contract,
        fromAddress: String(row.from || '').trim(),
        toAddress: to,
        chainUnits: value,
        blockTimestamp,
        blockNumber: null, // 列表接口不提供，需要时用 getTransactionBlock 另查
        // 交易时间早于最终确认块的时间 ⇒ 它所在区块 <= 最终确认块 ⇒ 已不可回滚
        solidified: blockTimestamp <= context.solid.blockTimestamp,
        raw: row
      })
    } catch (_error) {
      return null
    }
  }
}

module.exports = {
  TronGridProvider, DEFAULT_BASE_URL, PAGE_LIMIT,
  MAX_PAGES_PER_SCAN, MAX_RECEIPT_LOOKUPS
}
