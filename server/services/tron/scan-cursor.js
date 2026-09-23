'use strict'

/**
 * 扫描游标：checkpoint 与 replay。
 *
 * ## 唯一必须守住的原则
 *
 * **绝不因为「先推进 checkpoint、后处理交易」而丢单。**
 *
 * 做法是：把「交易落库」和「游标推进」放进**同一个数据库事务**。
 *
 * ```
 *   BEGIN
 *     INSERT INTO chain_transactions ... ON CONFLICT (tx_id) DO NOTHING   ← 落库
 *     UPDATE chain_scan_cursor SET last_scanned_timestamp = ...           ← 推进
 *   COMMIT
 * ```
 *
 * 两者要么一起成立、要么一起回滚。进程在 COMMIT 前挂掉，游标停在原处，
 * 下一轮从头再扫一遍 —— 重复由 `chain_transactions.tx_id` 唯一约束消解。
 *
 * **宁可重复扫，也不能跳过未处理交易。** 重复扫描的代价是几条无用的
 * INSERT 冲突；漏扫的代价是用户付了钱但余额没到。
 *
 * ## 为什么还要额外回退一段
 *
 * 即使事务是对的，仍有边界情况：上游的时间戳精度、我们按 `<=` 取窗口、
 * 以及"交易在窗口末尾到达但排序靠前"。所以每次扫描都从
 * `last_scanned_timestamp - REWIND_MS` 开始，用一小段重复换掉边界风险。
 *
 * ## 为什么用时间戳而不是区块高度
 *
 * TronGrid 的 TRC20 列表接口只给 `block_timestamp`，不给区块高度。
 * 按时间戳做游标可以直接用它自己的过滤参数，不需要为每条记录再查一次区块。
 * 区块高度仍然会存下来（拿得到时），但**仅用于留档**，不参与游标判断。
 */

const DEFAULT_REWIND_MS = 10 * 60 * 1000        // 每次回退 10 分钟重扫
const DEFAULT_INITIAL_LOOKBACK_MS = 24 * 3600 * 1000  // 首次扫描回看 24 小时

class ScanCursorService {
  constructor(options) {
    const opts = options || {}
    this.rewindMs = Number.isFinite(opts.rewindMs) ? Number(opts.rewindMs) : DEFAULT_REWIND_MS
    this.initialLookbackMs = Number.isFinite(opts.initialLookbackMs)
      ? Number(opts.initialLookbackMs)
      : DEFAULT_INITIAL_LOOKBACK_MS
  }

  /**
   * 取游标；不存在就建一条。
   *
   * 用 `ON CONFLICT DO NOTHING` 之后再 SELECT，而不是先查后插 ——
   * 后者在并发下会撞唯一约束。
   */
  async ensure(client, { address, tokenContract }) {
    await client.query(
      `INSERT INTO chain_scan_cursor (address, token_contract, last_scanned_timestamp)
       VALUES ($1, $2, 0)
       ON CONFLICT (address, token_contract) DO NOTHING`,
      [address, tokenContract]
    )
  }

  /** 读游标（不加锁），用于展示与诊断 */
  async get(client, { address, tokenContract }) {
    const { rows } = await client.query(
      `SELECT address, token_contract, last_scanned_timestamp, last_scanned_block,
              last_scanned_at, consecutive_failures, last_error
         FROM chain_scan_cursor WHERE address=$1 AND token_contract=$2`,
      [address, tokenContract]
    )
    return rows[0] || null
  }

  /**
   * 取本轮扫描窗口。
   *
   * **加 FOR UPDATE 行锁**：同一地址的扫描必须串行。
   * 两个 worker 同时扫同一地址，会因为游标竞争而互相覆盖进度，
   * 轻则重复劳动，重则其中一个把游标推到自己没处理完的位置 —— 那就会丢单。
   */
  async beginScan(client, { address, tokenContract, now, toTimestamp }) {
    await this.ensure(client, { address, tokenContract })
    const { rows } = await client.query(
      `SELECT last_scanned_timestamp FROM chain_scan_cursor
        WHERE address=$1 AND token_contract=$2 FOR UPDATE`,
      [address, tokenContract]
    )
    const last = Number(rows[0] && rows[0].last_scanned_timestamp) || 0
    const at = Number(now) || Date.now()
    const from = last > 0 ? Math.max(0, last - this.rewindMs) : Math.max(0, at - this.initialLookbackMs)
    return {
      fromTimestamp: from,
      toTimestamp: Number(toTimestamp) || at,
      rewoundMs: last > 0 ? this.rewindMs : 0,
      isFirstScan: last === 0
    }
  }

  /**
   * 推进游标。**必须在写 chain_transactions 的同一个事务里调用。**
   *
   * 只允许前进：`GREATEST` 保证并发或重放时不会把游标往回拨
   * （往回拨会让下一轮重复扫一大段，虽不致命但会浪费额度）。
   */
  async advance(client, { address, tokenContract, toTimestamp, solidBlockNumber, scannedCount }) {
    await client.query(
      `UPDATE chain_scan_cursor
          SET last_scanned_timestamp = GREATEST(last_scanned_timestamp, $3::bigint),
              last_scanned_block = COALESCE($4::bigint, last_scanned_block),
              last_scanned_at = now(),
              consecutive_failures = 0,
              last_error = '',
              updated_at = now()
        WHERE address=$1 AND token_contract=$2`,
      [address, tokenContract, String(Math.floor(toTimestamp)), solidBlockNumber === undefined || solidBlockNumber === null ? null : String(solidBlockNumber)]
    )
  }

  /**
   * 记录一次失败。
   *
   * **不动 checkpoint** —— 失败即"这一段还没扫完"，游标必须留在原处。
   * 只累加失败计数与错误摘要，供告警与退避使用。
   */
  async recordFailure(client, { address, tokenContract, error }) {
    const message = String((error && error.message) || error || '').slice(0, 300)
    const code = String((error && error.code) || 'UNKNOWN')
    await this.ensure(client, { address, tokenContract })
    await client.query(
      `UPDATE chain_scan_cursor
          SET consecutive_failures = consecutive_failures + 1,
              last_error = $3,
              updated_at = now()
        WHERE address=$1 AND token_contract=$2`,
      [address, tokenContract, `${code}: ${message}`.slice(0, 300)]
    )
  }
}

module.exports = { ScanCursorService, DEFAULT_REWIND_MS, DEFAULT_INITIAL_LOOKBACK_MS }
