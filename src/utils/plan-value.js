/**
 * 套餐「值不值」的展示口径 —— 单一真源。
 *
 * ## 为什么要有这个文件
 *
 * 套餐在三个地方展示：官网定价卡（`Landing.vue`）、商户充值页
 * （`UserRechargePage.vue`）、后台套餐表（`AdminPackages.vue`）。
 *
 * 客户判断"升级值不值"靠的就是**每百万字符多少钱**这一个数。这个数如果在
 * 三个页面各写一份除法，迟早会分叉（历史上这个项目已经因为"三处各算一份价格"
 * 出过一次事故 —— 页面显示 35、实际扣 35.427，见 `UserRechargePage` 里的注释）。
 * 所以除数与格式只放在这里。
 *
 * ## 为什么不放在服务端
 *
 * 它是**纯派生展示值**（`price ÷ included_chars × 1e6`），不是业务金额：
 * 不参与扣费、不落库、不影响任何计算。而服务端的金额口径已经在
 * `/user/quote` 里（那里才是真源）。把它塞进接口只会多一个可能不一致的字段。
 *
 * 注意：`included_chars` 在下单时**已冻结进订单**（`recharges.chars`），
 * 所以这里改套餐不会影响任何已售订单。
 */

/** 每百万字符的价格。价格或额度缺失/为 0 时返回 null —— 不能除。 */
export function unitPricePerMillion(price, chars) {
  const p = Number(price)
  const c = Number(chars)
  if (!Number.isFinite(p) || !Number.isFinite(c) || p <= 0 || c <= 0) return null
  return p / c * 1e6
}

/**
 * 单位价的展示串，如 `$23.33 / 百万字符`。
 * 拿不到就返回空串，调用方 `v-if` 掉即可（不要显示 `$NaN`）。
 */
export function formatUnitPrice(price, chars, symbol = '$') {
  const unit = unitPricePerMillion(price, chars)
  if (unit === null) return ''
  return `${symbol}${unit.toFixed(2)} / 百万字符`
}

/**
 * 相对**入门档**的单位价省了多少（正整数百分比）。
 *
 * 只用于"较基础版省 12%"这类文案 —— 让客户不用自己算就知道升级有没有好处。
 * 不比入门档便宜时返回 null（调用方不显示角标，而不是显示"省 -7%"）。
 */
export function savingVsBase(basePrice, baseChars, price, chars) {
  const base = unitPricePerMillion(basePrice, baseChars)
  const self = unitPricePerMillion(price, chars)
  if (base === null || self === null) return null
  const saved = Math.round((1 - self / base) * 100)
  return saved > 0 ? saved : null
}

/** 字符数的中文展示：1500000 → `150万`，非整万则原样。 */
export function formatChars(chars) {
  const n = Number(chars)
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 10000 && n % 10000 === 0) return (n / 10000) + '万'
  return String(n)
}
