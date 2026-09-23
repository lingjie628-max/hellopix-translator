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
 * 换 Provider 时只改这一个文件，`SettlementService` 一行都不用动。
 *
 * ## 两个容易踩的点
 *
 * 1. **金额是 6 位小数的字符串**，不是数字。`value: "35427000"` 表示
 *    35.427 USDT。用 Number 接会在超过 2^53 时丢精度 —— 所以一路 BigInt。
 *
 * 2. **TRC20 列表接口不返回区块高度**，只给 `block_timestamp`。
 *    所以扫描游标用时间戳而不是区块高度。判定 solidified 也是拿
 *    交易时间戳和「最终确认块的时间戳」比 —— TRON 的区块时间单调不减，
 *    所以 `tx.timestamp <= solidBlock.timestamp` 蕴含
 *    `tx.block <= solidBlock`，这个比较是严谨的，不是近似。
 */

const { TronProvider, ProviderError, requestJson } = require('./tron-provider')
const { USDT_TRC20_CONTRACT, makeTransfer } = require('./transfer')

const DEFAULT_BASE_URL = 'https://api.trongrid.io'
/** 单页上限。TronGrid 最大 200，取满以减少翻页次数 */
const PAGE_LIMIT = 200
/**
 * 单次扫描最多翻多少页。
 *
 * 存在的意义是防止「游标落后太多时一次扫描拉几万条」把 worker 拖死。
 * 拉满就返回 hasMore=true，下一轮继续 —— 游标会稳步追上去，
 * 而且因为幂等，重复覆盖一段也没关系。
 */
const MAX_PAGES_PER_SCAN = 10

class TronGridProvider extends TronProvider {
  constructor(options) {
    super()
    const opts = options || {}
    this.baseUrl = String(opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.apiKey = String(opts.apiKey || '').trim()
    this.timeoutMs = Number(opts.timeoutMs) || 15000
    this.pageLimit = Math.min(PAGE_LIMIT, Math.max(1, Number(opts.pageLimit) || PAGE_LIMIT))
    this.maxPages = Math.max(1, Number(opts.maxPagesPerScan) || MAX_PAGES_PER_SCAN)
    // 便于测试注入自己的 fetch
    this.request = opts.request || requestJson
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

  /**
   * 某个 TRC20 交易的区块高度。
   * 列表接口不给这个字段，只能额外问一次；拿不到就返回 null，不抛错。
   */
  async getTransactionBlock(txId) {
    try {
      const body = await this.request(`${this.baseUrl}/wallet/gettransactioninfobyid`, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, this.headers()),
        body: JSON.stringify({ value: txId }),
        timeoutMs: this.timeoutMs
      })
      const number = Number(body && body.blockNumber)
      return Number.isFinite(number) ? number : null
    } catch (_error) {
      // 区块高度只用于留档，查不到不该让整轮扫描失败
      return null
    }
  }

  /**
   * 拉取转入。
   *
   * 翻页用 `fingerprint`（TronGrid 的游标）。
   * **注意不要用 `meta.links.next` 直接请求**：那个 URL 里带了 api key 之外的
   * 全部参数，用它等于把请求构造权交给上游；自己拼更可控。
   */
  async listIncomingTransfers(params) {
    const p = params || {}
    const toAddress = String(p.toAddress || '').trim()
    if (!toAddress) throw new ProviderError('缺少收款地址', { code: 'BAD_REQUEST', retryable: false })
    const tokenContract = String(p.tokenContract || USDT_TRC20_CONTRACT).trim()
    const limit = Math.min(this.pageLimit, Math.max(1, Number(p.limit) || this.pageLimit))
    const fromTimestamp = Number(p.fromTimestamp) || 0
    const toTimestamp = Number.isFinite(Number(p.toTimestamp)) ? Number(p.toTimestamp) : Date.now()

    // solidified 判定基准：最终确认块的时间戳
    const solid = await this.latestSolidBlock()

    const collected = []
    let fingerprint = ''
    let pages = 0
    let hasMore = false

    while (pages < this.maxPages) {
      const query = new URLSearchParams()
      query.set('only_to', 'true')          // 只要转入，减少一半数据量
      query.set('limit', String(limit))
      query.set('min_timestamp', String(fromTimestamp))
      query.set('max_timestamp', String(toTimestamp))
      query.set('contract_address', tokenContract)
      if (fingerprint) query.set('fingerprint', fingerprint)

      const body = await this.request(
        `${this.baseUrl}/v1/accounts/${encodeURIComponent(toAddress)}/transactions/trc20?${query.toString()}`,
        { method: 'GET', headers: this.headers(), timeoutMs: this.timeoutMs }
      )

      if (!body || body.success === false) {
        throw new ProviderError('TronGrid 返回 success=false', { code: 'UPSTREAM_ERROR', retryable: true })
      }
      const rows = Array.isArray(body.data) ? body.data : []
      for (const row of rows) {
        const transfer = this.normalize(row, { toAddress, tokenContract, solid })
        // 上游可能返回不完整或不合规的记录 —— 单条坏数据不该让整轮扫描失败，
        // 跳过并留给上层统计，比整体抛错更稳（抛错会让游标停住，越积越多）
        if (transfer) collected.push(transfer)
      }

      fingerprint = String((body.meta && body.meta.fingerprint) || '')
      pages += 1
      if (!fingerprint || rows.length < limit) break
      if (pages >= this.maxPages) hasMore = true
    }

    // 上游不保证有序；游标推进依赖"处理到哪个时间点"，必须自己排好
    collected.sort((a, b) => (a.blockTimestamp - b.blockTimestamp) || (a.txId < b.txId ? -1 : 1))

    const maxTimestamp = collected.length
      ? collected[collected.length - 1].blockTimestamp
      : fromTimestamp

    return {
      transfers: collected,
      hasMore,
      nextFromTimestamp: maxTimestamp,
      solidBlock: solid
    }
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

    let transfer
    try {
      transfer = makeTransfer({
        txId: row.transaction_id,
        logIndex: 0,
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
    return transfer
  }
}

module.exports = { TronGridProvider, DEFAULT_BASE_URL, PAGE_LIMIT, MAX_PAGES_PER_SCAN }
