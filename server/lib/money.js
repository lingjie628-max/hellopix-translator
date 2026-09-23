'use strict'

/**
 * 金额运算：**全程整数，禁止 JS 浮点**。
 *
 * ## 为什么不用 Number
 *
 * `0.1 + 0.2 === 0.30000000000000004`。金额上这类误差不可接受，
 * 而随机尾数恰恰最容易踩：`35.000 + 0.427` 在浮点下是
 * `35.42700000000001`，四舍五入到 3 位看着没问题，
 * 但一旦拿去做**相等比较**（"链上金额是否等于订单应付金额"）
 * 就会莫名其妙匹配不上 —— 而且只在某些数字上复现，极难排查。
 *
 * 所以：
 *   - 内部一律用 **milli-USDT 整数**（1 USDT = 1000 milli）
 *   - 对外一律用**字符串**（`"35.427"`），绝不返回 Number
 *   - `toMilli()` 收到带小数的 Number 会**直接抛错** ——
 *     这是刻意的：把浮点挡在入口，而不是等到对账时才发现差 1e-15
 *
 * ## 与数据库的配合
 *
 * `recharges` 的三个金额列是 `numeric(14,3)`，精确十进制。
 * node-postgres 把 numeric 读成**字符串**（不经过 Number），
 * 正好可以直接喂给 `toMilli()`。这条链路上没有任何一步碰浮点。
 */

const MILLI_PER_UNIT = 1000n

/** 允许的金额文本：可选负号 + 整数部分 + 最多 3 位小数 */
const AMOUNT_PATTERN = /^-?\d+(\.\d{1,3})?$/

/**
 * 把各种形态的金额转成 milli 整数（BigInt）。
 *
 * 接受：
 *   bigint            直接当作 milli（内部表示）
 *   整数字符串 "35"   → 35000n
 *   小数字符串 "35.427" → 35427n
 *   整数字符串 "35.4"  → 35400n
 *   整数 Number 35     → 35000n
 *
 * **拒绝**：带小数的 Number（39.99）、非数字文本、超过 3 位小数。
 */
function toMilli(value) {
  if (typeof value === 'bigint') return value

  if (typeof value === 'number') {
    // 浮点金额一律拒绝。即使 35.5 恰好能被二进制精确表示，
    // 也挡掉 —— 例外规则比统一规则更容易出错。
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `金额禁止使用 JS 浮点数或超范围整数：${value}。` +
        '请传字符串（如 "35.427"）或整数。'
      )
    }
    return BigInt(value) * MILLI_PER_UNIT
  }

  const text = String(value === undefined || value === null ? '' : value).trim()
  if (!AMOUNT_PATTERN.test(text)) {
    throw new TypeError(`金额格式不合法：${JSON.stringify(text)}（最多 3 位小数）`)
  }
  const negative = text.startsWith('-')
  const [whole, frac = ''] = (negative ? text.slice(1) : text).split('.')
  const milli = BigInt(whole) * MILLI_PER_UNIT + BigInt((frac + '000').slice(0, 3))
  return negative ? -milli : milli
}

/** milli 整数 → 固定 3 位小数的字符串。对外只给字符串。 */
function formatMilli(milli) {
  const value = BigInt(milli)
  const negative = value < 0n
  const abs = negative ? -value : value
  const whole = abs / MILLI_PER_UNIT
  const frac = abs % MILLI_PER_UNIT
  return `${negative ? '-' : ''}${whole}.${String(frac).padStart(3, '0')}`
}

/**
 * 解析**已经是 milli 的**字符串/数字，返回 BigInt。
 *
 * ## 为什么必须和 toMilli 分开（这里踩过一次 1000 倍的坑）
 *
 * 两者接受的文本长得一模一样，含义却差 1000 倍：
 *
 *   toMilli('31500')    → 31_500_000n   「31500 USDT」
 *   parseMilli('31500') →      31_500n   「31500 毫 = 31.5 USDT」
 *
 * `quote()` 返回的 `paidMilli` 是**毫**，若误用 `toMilli()` 去接，
 * 订单金额会静默放大 1000 倍 —— 不报错、不崩溃，只是让用户付 31500 USDT。
 * 所以凡是名字里带 Milli 的字段，一律用这个函数，不要用 toMilli。
 */
function parseMilli(value) {
  if (typeof value === 'bigint') return value
  const text = String(value === undefined || value === null ? '' : value).trim()
  if (!/^-?\d+$/.test(text)) {
    throw new TypeError(
      `milli 必须是整数字符串：${JSON.stringify(text)}。` +
      '（如果你手上是人类可读金额如 "35.427"，请用 toMilli）'
    )
  }
  return BigInt(text)
}

/** 给数据库 numeric(14,3) 列的写入值。与 formatMilli 同形。 */
const toSqlAmount = formatMilli

function addMilli(a, b) { return BigInt(a) + BigInt(b) }
function subMilli(a, b) { return BigInt(a) - BigInt(b) }

/** 比较：a<b 返回 -1，a===b 返回 0，a>b 返回 1 */
function cmpMilli(a, b) {
  const left = BigInt(a)
  const right = BigInt(b)
  return left < right ? -1 : (left > right ? 1 : 0)
}

function eqMilli(a, b) { return BigInt(a) === BigInt(b) }

/** 尾数是否落在合法区间 001–999 对应的 milli 值（1n–999n） */
function isValidSuffixMilli(value) {
  const v = BigInt(value)
  return v >= 1n && v <= 999n
}

/**
 * 由「基数 + 尾数」算应付金额。
 * 两个参数都是 milli 整数 —— 这里没有任何除法或小数。
 */
function applySuffix(baseMilli, suffixMilli) {
  if (!isValidSuffixMilli(suffixMilli)) {
    throw new TypeError(`尾数必须在 1–999 之间（对应 0.001–0.999），收到 ${suffixMilli}`)
  }
  return BigInt(baseMilli) + BigInt(suffixMilli)
}

module.exports = {
  MILLI_PER_UNIT,
  toMilli,
  parseMilli,
  formatMilli,
  toSqlAmount,
  addMilli,
  subMilli,
  cmpMilli,
  eqMilli,
  isValidSuffixMilli,
  applySuffix
}
