'use strict'

/**
 * 充值异常池的人工处置。
 *
 * ## 为什么需要这个模块
 *
 * `recharge_exceptions` 在 023 迁移里就建好了，字段也齐了
 * （`status` / `resolved_by` / `resolved_at` / `resolution_note` / `resolved_action`），
 * 但**代码里从来没有写入过它们** —— 异常一旦进来就只能永远 `open`。
 *
 * 结果：2026-10-21 审计时池子里躺着 11 条、最早一条挂了 28 天。
 * 其中 10 条是测试款/旧地址款项，与平台应收无关；只有 1 条是真实订单付款。
 *
 * **没人能关掉那 10 条，于是那 1 条真的需要处理的混在里面看不出来。**
 * 异常池的价值在于"未处理的异常数"这个信号 ——
 * 一堆永远不会被处理的记录会把这个信号彻底淹没。
 *
 * ## 三种处置
 *
 * | 动作 | status | resolved_action | 含义 |
 * | --- | --- | --- | --- |
 * | 确认入账 | `resolved` | `credit`  | 人工核对后已入账（入账本身走订单确认接口） |
 * | 退回     | `resolved` | `reject`  | 已退款 / 确认非平台应收 |
 * | 忽略     | `ignored`  | `reject`  | 测试款、外部转账、旧地址款项 —— 不存在应收 |
 *
 * `ignored` 与 `resolved` 的区别只影响统计口径：
 * `resolved` 是"这笔钱处理完了"，`ignored` 是"这笔钱跟我们没关系"。
 * 两者都不再计入 `open`，都不会再触发告警。
 *
 * ## 铁律：处置本身绝不改余额
 *
 * 这个模块只关账，不发钱。要发钱必须走订单确认（`/admin/recharges/status`），
 * 那里才有 `FOR UPDATE` 锁、TXID 唯一索引、字符流水幂等键。
 * 如果在这里顺手加余额，就等于绕开了全部资金安全机制。
 *
 * ## 每一条处置都必须留痕
 *
 * `resolution_note` 记**判断依据**而不只是结论：
 * 「整数金额，非订单体系付款（测试/刷量），非平台应收」比「已忽略」有用一万倍 ——
 * 三个月后没人记得当初为什么这么判。
 */

const { ApiError } = require('../lib/http')
const { formatMilli } = require('../lib/money')

/** 允许的处置动作 */
const ACTION = Object.freeze({
  CREDIT: 'credit',
  REJECT: 'reject',
  IGNORE: 'reject'      // 忽略也是一种"不收这笔钱"
})

/** 动作 → 落库状态 */
const STATE_FOR = Object.freeze({
  credit: 'resolved',
  reject: 'resolved',
  ignore: 'ignored'
})

const VALID_ACTIONS = Object.freeze(['credit', 'reject', 'ignore'])

/** 处置说明的最小长度。太短的说明等于没写。 */
const MIN_NOTE_LENGTH = 4
const MAX_NOTE_LENGTH = 500

class RechargeExceptionService {
  constructor(repo) {
    this.repo = repo
  }

  /**
   * 处置一条异常。**调用方必须已开启事务**。
   *
   * @param {object} client 事务连接
   * @param {object} input
   * @param {string|number} input.id        异常 ID
   * @param {string} input.action           credit / reject / ignore
   * @param {string} input.note             判断依据（必填）
   * @param {object} [input.admin]          超管身份（传进审计日志）
   * @param {string} [input.ip]
   * @returns {Promise<object>} 处置结果
   */
  async resolve(client, input) {
    const id = String(input.id === undefined || input.id === null ? '' : input.id).trim()
    if (!/^\d+$/.test(id)) {
      throw new ApiError(400, '缺少或非法的异常 ID', 'EXCEPTION_ID_REQUIRED')
    }

    const action = String(input.action || '').trim()
    if (!VALID_ACTIONS.includes(action)) {
      throw new ApiError(400,
        `处置动作只能是 ${VALID_ACTIONS.join(' / ')}`, 'BAD_RESOLVE_ACTION')
    }

    const note = String(input.note || '').trim()
    if (note.length < MIN_NOTE_LENGTH) {
      // 不写理由就等于把判断变成了不可审计的操作。
      // 「已忽略」这种说明三个月后完全无法解释当时的依据。
      throw new ApiError(400,
        `请填写处置依据（至少 ${MIN_NOTE_LENGTH} 个字）—— 否则日后无法解释为什么这么判`,
        'RESOLUTION_NOTE_REQUIRED')
    }

    // 只在仍为 open 时才允许处置：重复处置会覆盖掉前一个人的判断依据。
    const found = await client.query(
      'SELECT * FROM recharge_exceptions WHERE id = $1::bigint FOR UPDATE',
      [id]
    )
    const row = found.rows[0]
    if (!row) throw new ApiError(404, '异常记录不存在', 'EXCEPTION_NOT_FOUND')
    if (row.status !== 'open') {
      throw new ApiError(409,
        `该异常已处置过（${row.status}），不能重复处置`,
        'EXCEPTION_ALREADY_RESOLVED')
    }

    const state = STATE_FOR[action]
    const resolvedAction = action === 'credit' ? ACTION.CREDIT : ACTION.REJECT

    const updated = await client.query(
      `UPDATE recharge_exceptions
          SET status = $2,
              resolved_by = $3::bigint,
              resolved_at = NOW(),
              resolution_note = $4,
              resolved_action = $5
        WHERE id = $1::bigint
        RETURNING *`,
      [id, state, input.admin ? String(input.admin) : null,
        note.slice(0, MAX_NOTE_LENGTH), resolvedAction]
    )

    const result = updated.rows[0]

    // 审计日志。资金相关的处置**必须**能追溯到人，
    // 否则"这条是谁判的、凭什么判"永远说不清。
    if (this.repo && typeof this.repo.audit === 'function') {
      await this.repo.audit(client, input.admin || null, '处置充值异常',
        `#${id} ${formatMilli(result.amount_milli)} USDT`
        + ` → ${state}${resolvedAction === 'credit' ? '（已入账）' : ''}；依据：${note}`,
        input.ip,
        result.recharge_id ? { type: 'recharge', id: result.recharge_id } : null)
    }

    return {
      id: String(result.id),
      status: result.status,
      resolvedAction: result.resolved_action,
      amountText: result.amount_milli ? formatMilli(result.amount_milli) : null,
      note: result.resolution_note,
      alreadyResolved: false
    }
  }

  /**
   * 批量处置。**同一个事务**，任一条失败则整体回滚。
   *
   * 批量是有必要的：这次 10 条测试款性质完全相同，逐条点十次
   * 只会让人想直接改数据库 —— 而绕开接口改库就不留审计日志了。
   *
   * @returns {Promise<{resolved: object[], skipped: object[]}>}
   */
  async resolveMany(client, input) {
    const ids = Array.isArray(input.ids) ? input.ids : []
    if (!ids.length) throw new ApiError(400, '没有要处置的异常', 'IDS_REQUIRED')
    if (ids.length > 200) {
      throw new ApiError(400, '一次最多处置 200 条', 'TOO_MANY_IDS')
    }

    const resolved = []
    for (const id of ids) {
      resolved.push(await this.resolve(client, {
        id, action: input.action, note: input.note,
        admin: input.admin, ip: input.ip
      }))
    }
    return { resolved, skipped: [] }
  }
}

module.exports = {
  RechargeExceptionService,
  ACTION,
  STATE_FOR,
  VALID_ACTIONS,
  MIN_NOTE_LENGTH,
  MAX_NOTE_LENGTH
}
