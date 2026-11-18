'use strict'

/**
 * 结算服务的枚举常量。
 *
 * 单独成文件是为了让 `settlement-verdicts.js`（纯结论构造）能引用它们，
 * 而不必反向 require 服务本体 —— 那会形成循环依赖，Node 在 CJS 下
 * 会静默给出半初始化的 `undefined`，排查起来极其恶心。
 *
 * 这些取值与数据库 CHECK 约束一一对应，改动前先查迁移。
 */

/** 链标识。与 chain_transactions.network 对应 */
const NETWORK = 'tron'

/**
 * 处理结论。
 *
 * `SKIPPED_UNRESOLVED`：**事件位置未知**（回执没取到）时跳过，
 * 且调用方**不得推进游标越过它** —— 否则这一笔永久漏掉了。
 */
const OUTCOME = Object.freeze({
  SETTLED: 'SETTLED',
  SHADOW_MATCHED: 'SHADOW_MATCHED',
  DUPLICATE: 'DUPLICATE',
  EXCEPTION: 'EXCEPTION',
  SKIPPED_UNRESOLVED: 'SKIPPED_UNRESOLVED',
  /**
   * 与本平台无关的进款 —— 直接忽略，不进异常池、不告警。
   *
   * ## 为什么需要这个
   *
   * 这个收款地址**同时被多个项目共用**（业主 2026-10-27 明确说明）。
   * 别的项目的客户转账、测试款、外部资金都会打到同一个地址上。
   * 原实现只要金额对不上本平台订单就写 `recharge_exceptions`，
   * 结果是：无关进款持续堆积 → 巡检一直判定「异常积压」→ 无限告警，
   * 真正的订单异常被淹没在里面（2026-10-27 那次 59998 USDT 的误报就是这么来的）。
   *
   * 现在的语义：
   *   - 有对应金额的预约（含已过期）→ 照常走 MATCHED / LATE_PAYMENT
   *   - 完全没有 → IGNORED_UNRELATED，链上记录标 ignored 留痕，不进异常池
   *
   * 留痕是必要的：日对账时仍能查到「这个地址收到过这些钱」，
   * 只是不再当成平台的应收来处理。
   */
  IGNORED_UNRELATED: 'IGNORED_UNRELATED'
})

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

module.exports = { NETWORK, OUTCOME, MATCH_KIND, EXCEPTION_KIND }
