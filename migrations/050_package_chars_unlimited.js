/**
 * 套餐「不限字符」（`packages.chars_unlimited`）。
 *
 * ## 起因
 *
 * 要上一个「单人账号 · 包月 · 不限字符」的套餐，但数据模型里根本没有
 * 「不限」这个概念 —— `included_chars` 是个 bigint，只能填数字。
 *
 * 当时的备选是"填一个足够大的数"（比如 1 亿）。不用它，因为那不是不限，
 * 是**一个说不清上限的数**：
 *
 *   · 商户在充值页会看到"1 亿字符"，然后拿它去除价格算单位价，
 *     得出的数字没有任何意义，还会污染阶梯单调性校验；
 *   · 用完了不会有人发现是"额度按设计用尽"还是"套餐买到假的不限"；
 *   · 官网文案写「不限」，后台数据写「1 亿」，两边迟早对不上。
 *
 * 所以单独加一个布尔列，让「不限」是一个**明确的商品属性**，
 * 而不是一个碰巧很大的数字。
 *
 * ## included_chars 怎么办
 *
 * 不限的套餐仍**必须**填一个数字（列是 NOT NULL），它承担两个职责：
 *
 *   1. 作为发放到 `users.char_balance` 的初始额度（见 core-service 的 quote）。
 *      给 5 亿：正常单人用户一辈子也用不完，但库里有具体数值可对账，
 *      不用在扣费路径上引入"余额是 Infinity"这种特殊值。
 *   2. 作为商城排序/展示的兜底（详情页文案由 `chars_unlimited` 覆盖）。
 *
 * 不要把它当成真正的上限 —— 它是"发放量"，不是"承诺量"。
 *
 * ## 单人账号
 *
 * 「单人」= 不含子账号额度，即 `sub_quota = 0`。这不需要新字段：
 * 开子账号的判定本来就看 `sub_quota`（企业账号除外），填 0 就是单人。
 */

exports.up = async pgm => {
  await pgm.db.query(`
    ALTER TABLE packages
      ADD COLUMN IF NOT EXISTS chars_unlimited boolean NOT NULL DEFAULT false
  `)
}

exports.down = async pgm => {
  await pgm.db.query('ALTER TABLE packages DROP COLUMN IF EXISTS chars_unlimited')
}
