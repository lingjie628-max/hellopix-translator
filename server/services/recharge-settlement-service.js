'use strict'

/**
 * 充值结算核心。**所有余额变化的唯一入口。**
 *
 * ## 铁律
 *
 * ```
 *   ChainWatcher  ──发现并标准化链上交易──▶  RechargeSettlementService
 *                                                    │
 *                                                    ▼
 *                                          锁订单 → 校验 TXID 唯一
 *                                          → pending→paid → 发放字符
 *                                          → 充值流水 → 字符流水
 *                                          → 审计 → COMMIT
 * ```
 *
 * ChainWatcher 自己**绝不**调 `adjustChars`、绝不改订单状态。
 * 它只回答"链上发生了什么"；"该不该动钱"由这里决定。
 * 把这两件事分开，是为了让资金路径只有一条、也只有一处需要审。
 *
 * ## 幂等锚点是 TXID，不是订单号，也不是扫描时间
 *
 * `chain_transactions.tx_id` 唯一。同一笔链上交易无论被看到多少次
 * （补扫、重启、并发），第二次开始直接短路 —— 不报错、不入账。
 *
 * ## Shadow / Dry-run
 *
 * `AUTO_SETTLEMENT_ENABLED=false` 时，本服务会把链路完整走一遍并**记录结论**，
 * 但绝不改余额、绝不改订单状态。记录里写清"如果开启自动结算本来会做什么"。
 * 先证明看得准，再允许动钱。
 *
 * ## 异常一律不入账
 *
 * 少付、多付、错代币、错地址、过期到账、无法匹配、重复付款、重复 TXID
 * —— 全部进 `recharge_exceptions` 等人工处理。
 * 宁可让钱躺在异常池里被人看见，也不能自动发字符出去：
 * 发错了再收回，用户那边已经是既成事实。
 */

const { ApiError } = require('../lib/http')
const { mapRow } = require('../repositories/production-repository')
const { RechargeAmountService } = require('./recharge-amount-service')
const { STATUS: RECHARGE_STATUS, statusText, assertTransition } = require('./recharge-state')
const { checkTransferEligibility } = require('./tron/transfer')
const { formatMilli } = require('../lib/money')

/** 匹配结论，与 chain_transactions.match_kind 的 CHECK 一致 */
const MATCH_KIND = Object.freeze({
  MATCHED: 'MATCHED',            // 精确匹配到一张待支付且未过期的订单
  LATE_PAYMENT: 'LATE_PAYMENT',  // 金额对得上，但订单已终态（过期/已付/取消）
  NO_MATCH: 'NO_MATCH',          // 金额不落在任何一个预约上
  DUPLICATE_TX: 'DUPLICATE_TX',  // 这笔链上交易已经处理过
  NOT_ELIGIBLE: 'NOT_ELIGIBLE'   // 代币/地址/精度不符合，不参与匹配
})

/** 异常类型，与 recharge_exceptions.kind 的 CHECK 一致 */
const EXCEPTION_KIND = Object.freeze({
  UNDERPAID: 'UNDERPAID',
  OVERPAID: 'OVERPAID',
  WRONG_TOKEN: 'WRONG_TOKEN',
  WRONG_ADDRESS: 'WRONG_ADDRESS',
  EXPIRED_PAYMENT: 'EXPIRED_PAYMENT',
  NO_MATCH: 'NO_MATCH',
  DUPLICATE_PAYMENT: 'DUPLICATE_PAYMENT',
  DUPLICATE_TXID: 'DUPLICATE_TXID'
})

class RechargeSettlementService {
  constructor(repo, options) {
    const opts = options || {}
    this.repo = repo
    this.amountService = opts.amountService || new RechargeAmountService()
    /**
     * 自动结算总闸。默认 **关闭**。
     * 关闭时走 Shadow：照常匹配、照常记录，但不动任何余额。
     * 只有显式配置 AUTO_SETTLEMENT_ENABLED=true 才会真正入账。
     */
    this.autoSettlementEnabled = opts.autoSettlementEnabled === true
    this.expectedTokenContract = opts.tokenContract || undefined
  }

  get mode() {
    return this.autoSettlementEnabled ? 'live' : 'shadow'
  }

  /**
   * 处理一条链上转账。**调用方必须已开启事务**，且必须在同一事务里推进游标。
   *
   * @returns {Promise<{
   *   outcome: 'SETTLED'|'SHADOW_MATCHED'|'DUPLICATE'|'EXCEPTION',
   *   matchKind: string,
   *   rechargeId: number|null,
   *   exceptionKind: string|null,
   *   detail: object
   * }>}
   */
  async handleTransfer(client, transfer, context) {
    const ctx = context || {}
    const mode = this.mode

    // ---- ① 先落库占住 TXID。这一步就是幂等锚点 ----
    const recorded = await this.recordTransaction(client, transfer, { mode })
    if (!recorded.inserted) {
      // 这笔链上交易已经见过。**绝不产生任何余额变化**，也不报错。
      return {
        outcome: 'DUPLICATE',
        matchKind: MATCH_KIND.DUPLICATE_TX,
        rechargeId: recorded.existingRechargeId,
        exceptionKind: null,
        detail: { reason: '该 TXID 已处理过', mode: recorded.existingMode }
      }
    }

    // ---- ② 资格过滤：代币、地址、金额精度 ----
    const eligibility = checkTransferEligibility(transfer, {
      tokenContract: this.expectedTokenContract,
      toAddress: ctx.toAddress
    })
    if (!eligibility.ok) {
      const kind = this.exceptionKindForEligibility(eligibility.reason)
      await this.recordException(client, transfer, {
        kind,
        summary: this.eligibilitySummary(eligibility.reason, transfer),
        detail: { reason: eligibility.reason, expected: ctx.toAddress || null }
      })
      await this.finalizeTransaction(client, recorded.id, {
        status: 'exception', matchKind: MATCH_KIND.NOT_ELIGIBLE, rechargeId: null,
        shadowAction: { wouldSettle: false, action: 'exception', kind, reason: eligibility.reason }
      })
      return {
        outcome: 'EXCEPTION', matchKind: MATCH_KIND.NOT_ELIGIBLE,
        rechargeId: null, exceptionKind: kind, detail: { reason: eligibility.reason }
      }
    }

    // ---- ③ 匹配候选订单 ----
    const match = await this.matchCandidate(client, transfer)

    if (match.kind === MATCH_KIND.NO_MATCH) {
      await this.recordException(client, transfer, {
        kind: EXCEPTION_KIND.NO_MATCH,
        summary: `金额 ${formatMilli(transfer.amountMilli)} USDT 不匹配任何订单`,
        detail: { amountMilli: transfer.amountMilli.toString() }
      })
      await this.finalizeTransaction(client, recorded.id, {
        status: 'exception', matchKind: MATCH_KIND.NO_MATCH, rechargeId: null,
        shadowAction: { wouldSettle: false, action: 'exception', kind: EXCEPTION_KIND.NO_MATCH }
      })
      return {
        outcome: 'EXCEPTION', matchKind: MATCH_KIND.NO_MATCH,
        rechargeId: null, exceptionKind: EXCEPTION_KIND.NO_MATCH, detail: {}
      }
    }

    if (match.kind === MATCH_KIND.LATE_PAYMENT) {
      // 迟到款：金额能找到归属，但那张订单已经结束。
      // **绝不能改配给新订单** —— 新订单要是恰好用了同一金额，
      // 那是 24 小时保护期没生效，属于更严重的 bug，应当暴露而不是掩盖。
      await this.recordException(client, transfer, {
        kind: EXCEPTION_KIND.EXPIRED_PAYMENT,
        rechargeId: match.order.id,
        reservationId: match.reservation && match.reservation.id,
        summary: `迟到款：归属订单 ${match.order.orderNumber}（${match.reason}），已进异常池`,
        detail: {
          orderNumber: match.order.orderNumber,
          orderStatus: Number(match.order.status),
          orderStatusText: statusText(Number(match.order.status)),
          reason: match.reason,
          amountMilli: transfer.amountMilli.toString()
        }
      })
      await this.finalizeTransaction(client, recorded.id, {
        status: 'exception', matchKind: MATCH_KIND.LATE_PAYMENT,
        rechargeId: null, // 不改配给任何订单，只留异常
        shadowAction: {
          wouldSettle: false, action: 'exception',
          kind: EXCEPTION_KIND.EXPIRED_PAYMENT,
          belongedTo: match.order.orderNumber
        }
      })
      return {
        outcome: 'EXCEPTION', matchKind: MATCH_KIND.LATE_PAYMENT,
        rechargeId: null, exceptionKind: EXCEPTION_KIND.EXPIRED_PAYMENT,
        detail: { belongedTo: match.order.orderNumber, reason: match.reason }
      }
    }

    // ---- ④ 精确匹配 ----
    if (!this.autoSettlementEnabled) {
      // Shadow：只记录"本来会做什么"，不动余额、不改订单状态
      const shadowAction = {
        wouldSettle: true,
        action: 'credit',
        rechargeId: match.order.id,
        orderNumber: match.order.orderNumber,
        chars: Number(match.order.chars),
        userId: match.order.userId,
        amountMilli: transfer.amountMilli.toString(),
        note: 'AUTO_SETTLEMENT_ENABLED=false，仅记录不执行'
      }
      await this.finalizeTransaction(client, recorded.id, {
        status: 'seen', matchKind: MATCH_KIND.MATCHED,
        rechargeId: match.order.id, shadowAction
      })
      return {
        outcome: 'SHADOW_MATCHED', matchKind: MATCH_KIND.MATCHED,
        rechargeId: match.order.id, exceptionKind: null, detail: shadowAction
      }
    }

    // ---- ⑤ 真实入账 ----
    const settled = await this.creditOrder(client, {
      transfer, order: match.order, reservation: match.reservation
    })
    await this.finalizeTransaction(client, recorded.id, {
      status: 'settled', matchKind: MATCH_KIND.MATCHED,
      rechargeId: match.order.id,
      settledAt: new Date(),
      shadowAction: { wouldSettle: true, action: 'credit', executed: true, alreadyPaid: settled.alreadyPaid }
    })
    return {
      outcome: settled.alreadyPaid ? 'DUPLICATE' : 'SETTLED',
      matchKind: MATCH_KIND.MATCHED,
      rechargeId: match.order.id, exceptionKind: null, detail: settled
    }
  }

  // ---------------------------------------------------------------- 落库

  /**
   * 记录链上交易。`tx_id` 唯一 —— 插入 0 行即代表"已经见过"。
   *
   * 这是**重复扫描不重复入账**的底座：补扫、重启、并发都会撞在这里，
   * 撞上就短路，不报错也不入账。
   */
  async recordTransaction(client, transfer, info) {
    const { rows } = await client.query(
      `INSERT INTO chain_transactions
         (tx_id, log_index, token_contract, from_address, to_address, amount_milli,
          block_number, block_timestamp, confirmations, solidified, status, mode, raw)
       VALUES ($1,$2,$3,$4,$5,$6::bigint,$7,$8,$9,$10,'seen',$11,$12::jsonb)
       ON CONFLICT (tx_id) DO NOTHING
       RETURNING id`,
      [
        transfer.txId,
        transfer.logIndex,
        transfer.tokenContract,
        transfer.fromAddress,
        transfer.toAddress,
        transfer.amountMilli.toString(),
        transfer.blockNumber,
        new Date(transfer.blockTimestamp).toISOString(),
        transfer.confirmations === undefined || transfer.confirmations === null ? 0 : transfer.confirmations,
        transfer.solidified,
        (info && info.mode) || this.mode,
        JSON.stringify(transfer.raw || {})
      ]
    )
    if (rows[0]) return { inserted: true, id: rows[0].id, existingRechargeId: null, existingMode: null }

    // 已存在：取出原记录，供上层判断"这笔当初是以什么身份处理的"
    const existing = await client.query(
      'SELECT id, recharge_id, mode, status FROM chain_transactions WHERE tx_id=$1',
      [transfer.txId]
    )
    const row = existing.rows[0] || {}
    return {
      inserted: false,
      id: row.id || null,
      existingRechargeId: row.recharge_id || null,
      existingMode: row.mode || null,
      existingStatus: row.status || null
    }
  }

  async finalizeTransaction(client, id, patch) {
    if (!id) return
    await client.query(
      `UPDATE chain_transactions
          SET status=$2, match_kind=$3, recharge_id=$4, shadow_action=$5::jsonb,
              settled_at=$6
        WHERE id=$1`,
      [
        id,
        patch.status,
        patch.matchKind || null,
        patch.rechargeId === null || patch.rechargeId === undefined ? null : String(patch.rechargeId),
        patch.shadowAction ? JSON.stringify(patch.shadowAction) : null,
        patch.settledAt ? patch.settledAt.toISOString() : null
      ]
    )
  }

  // ---------------------------------------------------------------- 匹配

  /**
   * 找这笔金额归属哪张订单。
   *
   * 走金额预约表（含已 released 的历史行）—— 这正是迟到款能找回原订单的依据。
   * 只查 held 的话，保护期外的老订单就彻底查不到了。
   *
   * **有效期以「链上交易发生的时间」为准，不是「我们发现它的时间」。**
   * 用户在前 29 分钟转出、链上 31 分钟才确认，那是有效支付，不该判过期。
   */
  async matchCandidate(client, transfer) {
    const reservation = await this.amountService.lookupByAmount(client, {
      payAddress: transfer.toAddress,
      tokenContract: transfer.tokenContract,
      amountMilli: transfer.amountMilli
    })
    if (!reservation || !reservation.recharge_id) {
      return { kind: MATCH_KIND.NO_MATCH, reservation: null, order: null, reason: '金额无归属' }
    }

    const found = await client.query('SELECT * FROM recharges WHERE id=$1', [reservation.recharge_id])
    const order = mapRow(found.rows[0])
    if (!order) {
      return { kind: MATCH_KIND.NO_MATCH, reservation, order: null, reason: '预约指向的订单不存在' }
    }

    if (Number(order.status) !== RECHARGE_STATUS.PENDING) {
      return {
        kind: MATCH_KIND.LATE_PAYMENT, reservation, order,
        reason: `订单已是「${statusText(Number(order.status))}」`
      }
    }

    const txTime = new Date(transfer.blockTimestamp)
    if (order.expiresAt && txTime.getTime() >= new Date(order.expiresAt).getTime()) {
      return { kind: MATCH_KIND.LATE_PAYMENT, reservation, order, reason: '链上交易时间晚于订单有效期' }
    }

    return { kind: MATCH_KIND.MATCHED, reservation, order, reason: '精确匹配' }
  }

  // ---------------------------------------------------------------- 入账

  /**
   * 真正的入账。**只有 live 模式会走到这里。**
   *
   * 全程在一个事务里，订单行 `FOR UPDATE` 串行化并发：
   * 链监听与用户「我已付款」同时命中同一单时，后到的那个会看到 status 已变，
   * 直接短路返回，不会重复发字符。
   */
  async creditOrder(client, { transfer, order, reservation }) {
    const found = await client.query('SELECT * FROM recharges WHERE id=$1 FOR UPDATE', [order.id])
    const locked = mapRow(found.rows[0])
    if (!locked) throw new ApiError(404, '订单不存在', 'RECHARGE_NOT_FOUND')

    if (Number(locked.status) === RECHARGE_STATUS.PAID) {
      // 已入账：不重复发字符，也不报错（补扫会走到这里）
      return { alreadyPaid: true, orderNumber: locked.orderNumber, chars: 0 }
    }
    assertTransition(Number(locked.status), RECHARGE_STATUS.PAID)

    const chars = Number(locked.chars)
    // 余额变化 **只经过这里**
    const updated = await this.repo.adjustChars(client, 'main', locked.userId, chars)
    await client.query(
      `INSERT INTO char_ledger
         (user_id, delta, balance_after, reason, reference_type, reference_id, idempotency_key, note)
       VALUES ($1,$2,$3,'recharge','recharge',$4,$5,$6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        String(locked.userId), String(chars), String(updated.charBalance),
        String(locked.id), `recharge:${locked.id}`,
        `链上自动入账 ${locked.orderNumber} tx:${transfer.txId}`
      ]
    )
    await client.query(
      `UPDATE recharges
          SET status=$2::smallint, paid_at=now(),
              terminal_at=now(), terminal_reason='chain_settled',
              provider_transaction_id=$3,
              chain_tx_id=$3, chain_seen_at=now(),
              chain_confirmations=$4,
              chain_block_number=COALESCE($5::bigint, chain_block_number),
              chain_from_address=$6,
              updated_at=now()
        WHERE id=$1`,
      [
        String(locked.id), RECHARGE_STATUS.PAID, transfer.txId,
        transfer.confirmations === undefined || transfer.confirmations === null ? 0 : transfer.confirmations,
        transfer.blockNumber, transfer.fromAddress
      ]
    )
    // 订单进终态 → 金额进 24 小时保护期
    await this.amountService.extendProtection(
      client, reservation && reservation.id ? reservation.id : locked.amountReservationId, new Date())
    // 系统动作：admin_id 为 NULL，actor 记为 system
    await this.repo.audit(client, null, '链上自动入账',
      `${locked.orderNumber} +${chars} 字符 tx:${transfer.txId}`, null,
      { type: 'user', id: locked.userId })

    return {
      alreadyPaid: false,
      orderNumber: locked.orderNumber,
      chars,
      balanceAfter: Number(updated.charBalance)
    }
  }

  // ---------------------------------------------------------------- 异常池

  exceptionKindForEligibility(reason) {
    if (reason === 'WRONG_TOKEN') return EXCEPTION_KIND.WRONG_TOKEN
    if (reason === 'WRONG_ADDRESS') return EXCEPTION_KIND.WRONG_ADDRESS
    return EXCEPTION_KIND.NO_MATCH
  }

  eligibilitySummary(reason, transfer) {
    if (reason === 'WRONG_TOKEN') {
      return `代币合约不是指定 USDT：${transfer.tokenContract}`
    }
    if (reason === 'WRONG_ADDRESS') {
      return `收款地址不是平台地址：${transfer.toAddress}`
    }
    if (reason === 'AMOUNT_PRECISION_TOO_FINE') {
      return `金额精度比订单更细（余数 ${transfer.amountRemainder}），不可能精确匹配`
    }
    return `不符合入账条件：${reason}`
  }

  /**
   * 写异常池。`(tx_id, kind)` 部分唯一 —— 补扫反复看到同一笔时只留一条，
   * 否则池子会被同一笔交易刷屏，真正要处理的异常被淹没。
   */
  async recordException(client, transfer, info) {
    const { rows } = await client.query(
      `INSERT INTO recharge_exceptions
         (kind, tx_id, log_index, to_address, from_address, token_contract, amount_milli,
          block_number, block_timestamp, confirmations, recharge_id, reservation_id,
          detail, summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7::bigint,$8,$9,$10,$11,$12,$13::jsonb,$14)
       ON CONFLICT (tx_id, kind) WHERE tx_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        info.kind,
        transfer.txId,
        transfer.logIndex,
        transfer.toAddress,
        transfer.fromAddress,
        transfer.tokenContract,
        transfer.amountMilli.toString(),
        transfer.blockNumber,
        new Date(transfer.blockTimestamp).toISOString(),
        transfer.confirmations === undefined || transfer.confirmations === null ? 0 : transfer.confirmations,
        info.rechargeId ? String(info.rechargeId) : null,
        info.reservationId ? String(info.reservationId) : null,
        JSON.stringify(info.detail || {}),
        String(info.summary || '').slice(0, 300)
      ]
    )
    return rows[0] ? rows[0].id : null
  }
}

module.exports = {
  RechargeSettlementService,
  MATCH_KIND,
  EXCEPTION_KIND
}
