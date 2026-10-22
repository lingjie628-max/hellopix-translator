'use strict'

/**
 * 近似金额匹配：识别「钱大概率是对的，只是数字抄错了」的到账。
 *
 * ## 为什么需要
 *
 * 金额是订单的**唯一身份**（地址 + 合约 + 金额三者定位一张订单）。
 * 这个设计本身是对的：多家商户转到同一地址时，精确匹配不会有歧义。
 *
 * 但它的代价是**零容错**：商户把 `65.318` 打成 `65.138`（中间两位写反），
 * 系统就完全认不出这笔钱，直接丢进 `NO_MATCH` 异常池。
 *
 * 2026-10-16 的真实事故：
 *
 * ```
 *   订单 21 应付 65.318  ← 系统分配
 *   链上实际到账 65.138  ← 商户打错了一位
 *   结算结论    NO_MATCH
 *   超管处理    手工「确认收款」，但链上交易与订单**没有绑定**
 *   遗留        chain_tx 43 永远悬着、订单 chain_tx_id 为空、预约 87 还在 held
 * ```
 *
 * 同一笔钱变成三份互不相干的记录，对账时谁也说不清。
 *
 * ## 本模块的边界：只提示，不裁决
 *
 * **绝不自动入账。** 识别结果只写进异常记录，供人工确认。
 * 自动入账一个「看起来像」的金额，等于把全部由金额唯一性提供的安全性
 * 一次性交出去 —— 两个商户恰好都打错时，钱会发错人。
 *
 * 所以这里只回答一个问题：**这笔到账最可能是哪张订单的钱，凭什么这么认为。**
 *
 * ## 三种候选信号
 *
 * | 信号 | 含义 | 置信度 |
 * | --- | --- | --- |
 * | `SUFFIX_TYPO`   | 尾数只是数字顺序/单字符写错 | 高 |
 * | `EXACT_BASE`    | 到账金额恰好是订单基数（漏掉了整个尾数） | 高 |
 * | `NEAR_AMOUNT`   | 金额接近某张待支付订单，但没有明确笔误特征 | 低（仅提示） |
 *
 * 置信度只影响**展示排序**，不影响是否入账 —— 一律人工。
 */

/** 只比对这三档以内的差额。更大的差额不是"打错",是另一笔钱 */
const MAX_SUFFIX_DELTA = 1000   // 1 USDT，即整个尾数区间
const MAX_NEAR_DELTA = 5000     // 5 USDT，松散提示的上限

/** 候选订单必须满足的时间窗：到账发生在订单创建之后多久内 */
const LOOKBACK_HOURS = 72

const MATCH_KIND = Object.freeze({
  EXACT: 'EXACT',
  SUFFIX_TYPO: 'SUFFIX_TYPO',
  EXACT_BASE: 'EXACT_BASE',
  NEAR_AMOUNT: 'NEAR_AMOUNT'
})

/** 置信度：数字越小越可信，仅用于展示排序 */
const CONFIDENCE = Object.freeze({
  EXACT: 0,
  SUFFIX_TYPO: 1,
  EXACT_BASE: 2,
  NEAR_AMOUNT: 3
})

function digits(value) {
  return String(value).replace(/[^0-9]/g, '')
}

/**
 * 尾数是否是「同一个尾数的笔误」。
 *
 * 判据（任一成立）：
 *  - 数字重排：318 ↔ 138、318 ↔ 813（同样三个数字，顺序不同）
 *  - 单字符替换：318 ↔ 358、318 ↔ 218（只错了一位）
 *  - 相邻互换：318 ↔ 138（本质是重排的子集，但可读性更好）
 *
 * 排除「整数尾数 0/1 与 999 相邻」这类只是数值接近、并无笔误特征的情况 ——
 * 那种落在 NEAR_AMOUNT 里，不该冒充高置信度。
 */
function isSuffixTypo(expected, actual) {
  const a = String(Math.abs(Number(expected))).padStart(3, '0')
  const b = String(Math.abs(Number(actual))).padStart(3, '0')
  if (a === b) return false
  if (a.length !== b.length) return false

  // 重排：同样的一组数字（318 ↔ 138 / 813）
  //
  // 但补零位不能参与重排判定：`005` 与 `050` 的字符多重集都是 {0,0,5}，
  // 会被判成"重排"，而它们的含义是尾数 5 与尾数 50 —— 差十倍的两笔钱。
  // 所以先剥掉前导零，再比重排。
  const aStripped = a.replace(/^0+/, '') || '0'
  const bStripped = b.replace(/^0+/, '') || '0'
  if (aStripped.length === bStripped.length && aStripped !== bStripped
      && aStripped.split('').sort().join('') === bStripped.split('').sort().join('')) {
    return true
  }

  // 单字符替换：必须两位都不为 '0'。
  //
  // 补零位之间的差异不算笔误：`005` vs `050` 在字符串上只差一位，
  // 但数值含义是「尾数 5」vs「尾数 50」—— 差了整整十倍，
  // 是两笔不同订单的钱，不是抄错一个数字。同样的，
  // `037` vs `003` 也不是笔误。补零是**格式对齐**，不是金额的一部分。
  let diff = 0
  let crossesPadding = false
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    diff++
    if (diff > 1) return false
    if (a[i] === '0' || b[i] === '0') crossesPadding = true
  }
  return diff === 1 && !crossesPadding
}

/**
 * 给一笔未匹配的到账找候选订单。
 *
 * **调用方必须自己限定这些订单都是「待支付或已支付」且属于同一收款地址与合约** ——
 * 本函数不做权限/地址校验，只做金额形态判断。把校验留在这里会让
 * 「谁能被匹配」这件事有两个出处，迟早分叉。
 *
 * @param {object} input
 * @param {bigint|string|number} input.amountMilli 到账金额（毫 USDT）
 * @param {Array<{id, orderNumber, paidAmountMilli, baseMilli, surchargeMilli, status}>} input.candidates
 * @returns {{kind: string, confidence: number, order: object, deltaMilli: bigint, reason: string}|null}
 *          没有合格候选时返回 null
 */
function findCandidate(input) {
  const amount = BigInt(input.amountMilli)
  const candidates = Array.isArray(input.candidates) ? input.candidates : []
  if (!candidates.length) return null

  let best = null

  for (const order of candidates) {
    const expected = BigInt(order.paidAmountMilli)
    const delta = amount - expected
    const absDelta = delta < 0n ? -delta : delta

    // 精确匹配不归本模块管（走正常匹配路径），这里跳过
    if (absDelta === 0n) continue

    let kind = null
    let reason = ''

    // ① 尾数笔误：差额落在尾数区间内，且两个尾数形态相似
    const expectedSuffix = order.surchargeMilli === null || order.surchargeMilli === undefined
      ? null
      : Number(order.surchargeMilli)
    const actualSuffix = expectedSuffix === null ? null : expectedSuffix + Number(delta)

    if (expectedSuffix !== null && absDelta <= BigInt(MAX_SUFFIX_DELTA)
        && actualSuffix >= 0 && actualSuffix <= 999
        && isSuffixTypo(expectedSuffix, actualSuffix)) {
      kind = MATCH_KIND.SUFFIX_TYPO
      reason = `尾数 ${String(expectedSuffix).padStart(3, '0')} 疑似打成 ${String(actualSuffix).padStart(3, '0')}`
    }

    // ② 漏掉尾数：到账恰好是订单基数
    if (!kind && order.baseMilli !== null && order.baseMilli !== undefined
        && amount === BigInt(order.baseMilli)) {
      kind = MATCH_KIND.EXACT_BASE
      reason = `到账金额恰好是订单基数，漏付了尾数 ${String(expectedSuffix || 0).padStart(3, '0')}`
    }

    // ③ 松散接近：只做提示，置信度最低
    if (!kind && absDelta <= BigInt(MAX_NEAR_DELTA)) {
      kind = MATCH_KIND.NEAR_AMOUNT
      reason = `与订单应付金额相差 ${formatDelta(delta)} USDT`
    }

    if (!kind) continue

    const candidate = {
      kind,
      confidence: CONFIDENCE[kind],
      order,
      deltaMilli: delta,
      reason
    }
    if (!best || candidate.confidence < best.confidence
        || (candidate.confidence === best.confidence
            && absOf(candidate.deltaMilli) < absOf(best.deltaMilli))) {
      best = candidate
    }
  }

  return best
}

function absOf(value) {
  return value < 0n ? -value : value
}

/** 把「毫」格式化成带符号的 USDT 文本，用于提示文案 */
function formatDelta(deltaMilli) {
  const d = BigInt(deltaMilli)
  const neg = d < 0n
  const abs = neg ? -d : d
  const whole = abs / 1000n
  const frac = String(abs % 1000n).padStart(3, '0')
  return `${neg ? '-' : '+'}${whole}.${frac}`
}

module.exports = {
  MATCH_KIND,
  CONFIDENCE,
  MAX_SUFFIX_DELTA,
  MAX_NEAR_DELTA,
  LOOKBACK_HOURS,
  isSuffixTypo,
  findCandidate,
  formatDelta
}
