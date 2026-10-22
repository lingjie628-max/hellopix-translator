'use strict'

/**
 * 结算结论的**唯一构造器**。
 *
 * `handleTransfer` 拆出来的七个闸门，每个都以「写异常池 → 落终态 → 返回结论」
 * 收尾。以前这四件套在各闸门里抄了五遍：改一处要改五遍，漏一处就少写一条异常。
 * 现在统一收敛到这里 —— 结论的形状只有这一份定义。
 *
 * 设计约束：这里是**纯函数**（除了 `rejectWithException` 会落库），
 * 不读 this、不碰余额。任何涉及钱的动作仍然只允许在 `creditOrder` 里发生。
 */

const { OUTCOME, MATCH_KIND, EXCEPTION_KIND } = require('../recharge-settlement-constants')

/**
 * 跳过：不落库、不写异常、不推进游标。调用方看到它必须原地重试。
 */
function skipUnresolved(transfer, reason) {
  return {
    outcome: OUTCOME.SKIPPED_UNRESOLVED,
    matchKind: null,
    rechargeId: null,
    exceptionKind: null,
    detail: { reason, txId: transfer.txId }
  }
}

/**
 * 重复：这笔链上事件的身份（txId + eventIndex）已经落库过。
 * **绝不产生任何余额变化，也不报错** —— 补扫、重启、并发都会撞在这里。
 */
function duplicateEvent(recorded) {
  return {
    outcome: OUTCOME.DUPLICATE,
    matchKind: MATCH_KIND.DUPLICATE_TX,
    rechargeId: recorded.existingRechargeId || null,
    exceptionKind: null,
    detail: { reason: '该 TXID 已处理过', mode: recorded.existingMode }
  }
}

/**
 * Shadow：只记录「本来会做什么」，不动余额、不改订单状态。
 */
function shadowCredit(transfer, order) {
  return {
    wouldSettle: true,
    action: 'credit',
    rechargeId: order.id,
    orderNumber: order.orderNumber,
    chars: Number(order.chars),
    userId: order.userId,
    amountMilli: transfer.amountMilli.toString(),
    note: 'AUTO_SETTLEMENT_ENABLED=false，仅记录不执行'
  }
}

/**
 * 入账完成的结论。
 *
 * `alreadyPaid` 是补扫常见路径：订单早已是 paid，字符没重复发。
 * 对上层报告 DUPLICATE，但对链上交易记录来说是 settled —— 两者都要归位。
 */
function settled(transfer, order, settledResult) {
  return {
    result: {
      outcome: settledResult.alreadyPaid ? OUTCOME.DUPLICATE : OUTCOME.SETTLED,
      matchKind: MATCH_KIND.MATCHED,
      rechargeId: order.id,
      exceptionKind: null,
      detail: settledResult
    },
    transactionPatch: {
      status: 'settled',
      matchKind: MATCH_KIND.MATCHED,
      rechargeId: order.id,
      settledAt: new Date(),
      shadowAction: {
        wouldSettle: true,
        action: 'credit',
        executed: true,
        alreadyPaid: settledResult.alreadyPaid
      }
    }
  }
}
/**
 * 不合格：代币 / 地址 / 精度不满足入账条件。
 *
 * 用 `AMOUNT_PRECISION_TOO_FINE` 说明为什么**永远**不会匹配上，
 * 而不是笼统归到 NO_MATCH 让人反复查。
 */
function ineligible(service, transfer, eligibility, context) {
  const kind = service.exceptionKindForEligibility(eligibility.reason)
  return {
    exception: {
      kind,
      summary: service.eligibilitySummary(eligibility.reason, transfer),
      detail: { reason: eligibility.reason, expected: (context && context.toAddress) || null }
    },
    transactionPatch: {
      status: 'exception', matchKind: MATCH_KIND.NOT_ELIGIBLE, rechargeId: null,
      shadowAction: {
        wouldSettle: false, action: 'exception', kind, reason: eligibility.reason
      }
    },
    result: {
      outcome: OUTCOME.EXCEPTION, matchKind: MATCH_KIND.NOT_ELIGIBLE,
      rechargeId: null, exceptionKind: kind, detail: { reason: eligibility.reason }
    }
  }
}

/**
 * 金额无归属。
 *
 * 但**先找疑似归属再下结论**：金额精确匹配失败不等于这笔钱与平台无关，
 * 最常见的原因是商户抄错数字。疑似结果只进 detail 供人工确认，**绝不自动入账**。
 */
function noMatch(service, transfer, suspicion) {
  return {
    exception: {
      kind: EXCEPTION_KIND.NO_MATCH,
      summary: service.noMatchSummary(transfer, suspicion),
      detail: { amountMilli: transfer.amountMilli.toString(), suspicion }
    },
    transactionPatch: {
      status: 'exception', matchKind: MATCH_KIND.NO_MATCH, rechargeId: null,
      shadowAction: {
        wouldSettle: false, action: 'exception', kind: EXCEPTION_KIND.NO_MATCH, suspicion
      }
    },
    result: {
      outcome: OUTCOME.EXCEPTION, matchKind: MATCH_KIND.NO_MATCH,
      rechargeId: null, exceptionKind: EXCEPTION_KIND.NO_MATCH,
      detail: { suspicion }
    }
  }
}

/**
 * 迟到款：金额能找到归属，但那张订单已经结束。
 *
 * **绝不改配给新订单** —— 新订单若恰好用了同一金额，说明 24 小时保护期
 * 没生效，是更严重的 bug。应当暴露，不该掩盖。
 */
function latePayment(transfer, match) {
  return {
    exception: {
      kind: EXCEPTION_KIND.EXPIRED_PAYMENT,
      rechargeId: match.order.id,
      reservationId: match.reservation && match.reservation.id,
      summary: `迟到款：归属订单 ${match.order.orderNumber}（${match.reason}），已进异常池`,
      detail: {
        orderNumber: match.order.orderNumber,
        orderStatus: Number(match.order.status),
        orderStatusText: match.order.statusText,
        reason: match.reason,
        amountMilli: transfer.amountMilli.toString()
      }
    },
    transactionPatch: {
      status: 'exception', matchKind: MATCH_KIND.LATE_PAYMENT,
      rechargeId: null, // 不改配给任何订单，只留异常
      shadowAction: {
        wouldSettle: false, action: 'exception',
        kind: EXCEPTION_KIND.EXPIRED_PAYMENT,
        belongedTo: match.order.orderNumber
      }
    },
    result: {
      outcome: OUTCOME.EXCEPTION, matchKind: MATCH_KIND.LATE_PAYMENT,
      rechargeId: null, exceptionKind: EXCEPTION_KIND.EXPIRED_PAYMENT,
      detail: { belongedTo: match.order.orderNumber, reason: match.reason }
    }
  }
}

/**
 * 同一 TXID 的另一个事件已结算过别的订单。
 *
 * 一笔交易里可有多个 Transfer（合约中转、批量转账），若两个都指向平台地址
 * 且各自匹配上订单，钱其实只有一笔 —— 自动发放会把一次付款记成两次充值。
 * 规则：**一个 TXID 最多结算一张订单**。
 */
function duplicateTxid(transfer, match, sameTx) {
  return {
    exception: {
      kind: EXCEPTION_KIND.DUPLICATE_TXID,
      rechargeId: match.order ? match.order.id : null,
      summary: `同一交易 ${transfer.txId.slice(0, 16)}… 的另一个事件已结算过订单，本事件不自动入账`,
      detail: {
        settledRechargeId: sameTx.recharge_id,
        settledEventIndex: sameTx.event_index,
        thisEventIndex: transfer.eventIndex,
        amountMilli: transfer.amountMilli.toString()
      }
    },
    transactionPatch: {
      status: 'exception', matchKind: MATCH_KIND.DUPLICATE_TX,
      rechargeId: null,
      shadowAction: {
        wouldSettle: false, action: 'exception', kind: EXCEPTION_KIND.DUPLICATE_TXID,
        settledRechargeId: sameTx.recharge_id
      }
    },
    result: {
      outcome: OUTCOME.EXCEPTION, matchKind: MATCH_KIND.DUPLICATE_TX,
      rechargeId: null, exceptionKind: EXCEPTION_KIND.DUPLICATE_TXID,
      detail: { settledRechargeId: sameTx.recharge_id, thisEventIndex: transfer.eventIndex }
    }
  }
}

/**
 * Shadow 模式的精确匹配结论。
 */
function shadowMatched(transfer, order) {
  const action = shadowCredit(transfer, order)
  return {
    transactionPatch: {
      status: 'seen', matchKind: MATCH_KIND.MATCHED,
      rechargeId: order.id, shadowAction: action
    },
    result: {
      outcome: OUTCOME.SHADOW_MATCHED, matchKind: MATCH_KIND.MATCHED,
      rechargeId: order.id, exceptionKind: null, detail: action
    }
  }
}

module.exports = {
  skipUnresolved,
  duplicateEvent,
  ineligible,
  noMatch,
  latePayment,
  duplicateTxid,
  shadowMatched,
  settled,
  shadowCredit
}
