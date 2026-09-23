'use strict'

/**
 * TronProvider 抽象。
 *
 * ## 为什么要有这一层
 *
 * 「从哪里读链」和「读到之后怎么结算」是两件独立的事。把它们混在一起，
 * 换数据源（TronGrid → 备用 Provider → 自建节点）就得改结算代码，
 * 而结算代码是资金路径。
 *
 * 所以本文件定义**业务层唯一允许依赖的三个方法**：
 *
 *   latestSolidBlock()        —— 当前最终确认的区块（用于判定 solidified）
 *   listIncomingTransfers()   —— 拉取某地址在时间窗内的转入，**已标准化**
 *   health()                  —— 可用性探测，供巡检与告警
 *
 * 子类负责把各自的数据源格式翻译成 `NormalizedTransfer`（见 transfer.js）。
 * 业务层拿到的永远是同一种结构，不认识 `token_info` / `value` / `fingerprint`
 * 这类第三方字段名。
 *
 * ## 错误分类
 *
 * 上游的失败必须能区分「可以重试」和「不该重试」：
 *   429 / 5xx / 超时 / 网络抖动 → 可重试，退避后再来
 *   401 / 403（密钥失效）        → 不可重试，要告警让人处理
 *   400（参数写错）              → 不可重试，是代码 bug
 *
 * 分不清会导致两种坏结果：把「密钥失效」当临时故障无限重试（永远好不了），
 * 或者把「限流」当永久故障直接放弃（漏单）。
 */

class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {object} info
   * @param {string} info.code      机器可读错误码
   * @param {boolean} info.retryable 是否值得重试
   * @param {number} [info.status]  HTTP 状态码
   * @param {number} [info.retryAfterMs] 上游要求的退避时间
   */
  constructor(message, info) {
    super(message)
    this.name = 'ProviderError'
    this.code = (info && info.code) || 'PROVIDER_ERROR'
    this.retryable = Boolean(info && info.retryable)
    this.status = (info && info.status) || null
    this.retryAfterMs = (info && info.retryAfterMs) || null
  }
}

/**
 * 把 HTTP 状态码翻译成「能不能重试」。
 *
 * 429 与 5xx 是上游的临时状态；401/403 是凭据问题，重试一万次也没用；
 * 其余 4xx 基本是我们把参数发错了。
 */
function classifyHttpStatus(status, retryAfterHeader) {
  if (status === 429) {
    const seconds = Number(retryAfterHeader)
    return {
      code: 'RATE_LIMITED',
      retryable: true,
      retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
    }
  }
  if (status >= 500) return { code: 'UPSTREAM_ERROR', retryable: true }
  if (status === 401 || status === 403) return { code: 'UNAUTHORIZED', retryable: false }
  if (status >= 400) return { code: 'BAD_REQUEST', retryable: false }
  return { code: 'UNEXPECTED_STATUS', retryable: true }
}

/** 把网络层的异常翻译成 ProviderError */
function classifyNetworkError(error) {
  const name = String((error && error.name) || '')
  const code = String((error && error.code) || '')
  if (name === 'AbortError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new ProviderError('链 API 请求超时', { code: 'TIMEOUT', retryable: true })
  }
  return new ProviderError(`链 API 网络错误：${(error && error.message) || error}`,
    { code: 'NETWORK', retryable: true })
}

/**
 * 带超时的一次 GET/POST。所有 Provider 共用，避免各写一套。
 *
 * 超时是必须的：链 API 卡住时不能让 watcher 一直挂着，
 * 那会让整个扫描周期停摆，而停摆意味着这段时间的到账没人看见。
 */
async function requestJson(url, options) {
  const opts = options || {}
  const timeoutMs = Number(opts.timeoutMs) || 15000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: opts.method || 'GET',
      headers: Object.assign({ Accept: 'application/json' }, opts.headers || {}),
      body: opts.body,
      signal: controller.signal
    })
    if (!response.ok) {
      const cls = classifyHttpStatus(response.status, response.headers.get('retry-after'))
      // 401/403 之类的响应体可能含敏感信息，只截一小段用于排查
      let excerpt = ''
      try { excerpt = String(await response.text()).slice(0, 200) } catch (_e) { /* 读不到就算了 */ }
      throw new ProviderError(
        `链 API 返回 ${response.status}${excerpt ? '：' + excerpt : ''}`,
        Object.assign({ status: response.status }, cls)
      )
    }
    return await response.json()
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw classifyNetworkError(error)
  } finally {
    clearTimeout(timer)
  }
}

class TronProvider {
  /** 供日志与审计用的可读名字 */
  get name() {
    return 'abstract'
  }

  /**
   * 当前最终确认（solidified）区块。
   *
   * @returns {Promise<{blockNumber: number, blockTimestamp: number}>}
   */
  async latestSolidBlock() {
    throw new Error('TronProvider.latestSolidBlock 未实现')
  }

  /**
   * 拉取某收款地址在时间窗内的 TRC20 转入。
   *
   * ## 契约
   *
   *   - 只返回 **转入**（to === toAddress）且 **代币合约匹配** 的记录
   *   - `fromTimestamp` / `toTimestamp` 是**扫描窗口**（闭区间），不是分页游标
   *   - 每条 transfer 必须带 `eventIndex`（见下）
   *   - 结果按 blockTimestamp 升序
   *
   * ## 分页：cursor 是**不透明**的
   *
   * `cursor` 与返回的 `nextCursor` 都是**不透明字符串** —— 调用方拿到什么就原样传回，
   * 不要解析、不要拼装、不要假设它和时间有关。
   *
   * 为什么不能拿时间戳当分页游标：一个时间点上可能有多笔交易，
   * 用"上次扫到的时间"翻页，同一时间戳的记录要么重复要么被跳过。
   * TronGrid 给的是 `meta.fingerprint`（一个长 base64 串），
   * 别的 Provider 可能给别的形式 —— 不透明化之后换数据源不用改调用方。
   *
   * **时间戳只承担三件事**：扫描窗口、solidified 上界、overlap replay。
   * 翻页交给 cursor。
   *
   * ## eventIndex 为什么必须由 Provider 提供
   *
   * 一笔交易**可以包含多个 Transfer 事件**（合约中转、批量转账）。
   * TronGrid 的账户接口不返回事件序号，所以 Provider 必须从交易回执的
   * `log[]` 里把真实下标补出来。**返回 null 表示没能确定位置** ——
   * 调用方必须跳过该条并且不推进游标，绝不能编一个序号顶上。
   *
   * @returns {Promise<{
   *   transfers: object[],
   *   hasMore: boolean,
   *   nextCursor: string|null
   * }>}
   */
  async listIncomingTransfers(/* {
    tokenContract, toAddress, fromTimestamp, toTimestamp, cursor, limit
  } */) {
    throw new Error('TronProvider.listIncomingTransfers 未实现')
  }

  /**
   * 查某笔交易所在的区块高度。
   *
   * 可选能力：TronGrid 的 TRC20 列表接口**不返回区块高度**，
   * 需要额外一问。所以默认返回 null，由调用方决定要不要为它多打一次接口。
   * 区块高度只用于留档与展示 —— 扫描游标走的是时间戳，
   * 拿不到区块高度不影响正确性。
   */
  async getTransactionBlock(/* txId */) {
    return null
  }

  /** 可用性探测。失败不抛异常，返回结果供巡检使用。 */
  async health() {
    const started = Date.now()
    try {
      const block = await this.latestSolidBlock()
      return { ok: true, provider: this.name, latencyMs: Date.now() - started, solidBlock: block.blockNumber }
    } catch (error) {
      return {
        ok: false,
        provider: this.name,
        latencyMs: Date.now() - started,
        code: (error && error.code) || 'PROVIDER_ERROR',
        message: String((error && error.message) || error).slice(0, 200)
      }
    }
  }
}

module.exports = {
  TronProvider,
  ProviderError,
  classifyHttpStatus,
  classifyNetworkError,
  requestJson
}
