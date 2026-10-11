/**
 * 三档套餐改为「价格等幅递增、字符加速增加」的**单调阶梯**。
 *
 * ## 修的是什么
 *
 * 生产实测（2026-10-11）：
 *
 *   基础版  $35.00 / 150 万字符 = **$23.33 / 百万字符**
 *   高级版  $65.00 / 250 万字符 = **$26.00 / 百万字符**   ← 比基础版**更贵**
 *   专业版  $125.00 / 600 万字符 = **$20.83 / 百万字符**
 *
 * 高级版的单位价比基础版高 11.4%。结果有两个：
 *
 *   1. 客户只要把三张卡片上的"每百万字符多少钱"一比，就会发现**升级反而更亏**；
 *   2. "高级版"这个档位名不副实 —— 它的性价比低于入门档，没有任何升级理由。
 *
 * 这不是定价高低的问题，是**阶梯非单调**的问题：一个正常的逐层升级，
 * 单位价必须随档位严格下降。
 *
 * ## 新阶梯（金额一分不动，只调字符额度）
 *
 *   基础版  $35.00 / 150 万字符 = $23.33 / 百万字符   （锚点，保持不变）
 *   高级版  $65.00 / 300 万字符 = $21.67 / 百万字符
 *   专业版  $125.00 / 750 万字符 = $16.67 / 百万字符
 *
 * 三条设计约束都满足了：
 *   · 单位价**严格递减**：23.33 > 21.67 > 16.67；
 *   · 字符数是**干净倍数**：1x / 2x / 5x —— 客户一眼能算（"高级版翻倍，
 *     专业版 5 倍"），比 "$21.67 vs $23.33" 这种小数直观得多；
 *   · 成本仍远低于售价：按已启用通道里最贵的 DeepSeek（$0.8333/百万字符）
 *     满额使用，专业版成本 $6.25，毛利率仍有 **95%**。
 *
 * ## 为什么改额度不亏
 *
 * 翻译成本只占售价的 2.4%–3.3%（见设计文档），加字符的边际成本极低：
 * 专业版从 600 万加到 750 万，最多多花 $1.25。而换来的是"升级有理由"，
 * 这比省那点成本重要得多。
 *
 * ## 对已售订单：无影响
 *
 * 字符额度在下单时**已冻结快照**进 `recharges.chars`
 * （`/userRecharge/create` 写入 `quote.chars`，结算时
 * `recharge-settlement-service` 只读订单上那个值，不再回头看 `packages`）。
 * 所以本迁移**只影响之后的新订单**，已付钱的商户拿到的还是当初承诺的额度。
 *
 * ## 两处刻意的取舍
 *
 * 1. **`included_chars` 按 `code` 定值，不套「钉住旧值」的守卫。**
 *    004/034/040 那类迁移守卫是为了不覆盖**管理员对文案的编辑**。
 *    但这里不同：阶梯是**产品不变量** —— 生产是 250/600 万（管理员手工改过
 *    套餐，从未同步过文案），而全新库重放迁移得到的是 150/150 万。
 *    若加守卫，两边会永远各是一套，而且生产上**这次修复根本不会生效**。
 *    所以额度一律按 `code` 写成目标值；文案仍用守卫（见下）。
 *
 * 2. **文案只改"仍是 040 那份过期文案"的行。**
 *    `highlights` 是自由文本、后台可编辑，管理员改过就不覆盖。
 *    生产上三档都还是 040 写的 `["150万字符","DeepSeek、GPT"]`，
 *    而高级版实际 250 万、专业版实际 600 万 —— 就这一处对不上，
 *    本迁移把它改对，并把「额度文案必须等于额度」纳入 `check:plan-copy`
 *    的机器校验（那正是它能长期漏过去的原因：以前这个脚本只看渠道，不看额度）。
 *
 * 不需要动 `catalog_version`：那套版本快照只固化**通道组合**
 * （`package_engine_versions`），字符额度不在其中，也没有别的读取方回溯它。
 */

/**
 * 目标阶梯 —— 唯一真源。
 * 迁移、`scripts/check-plan-copy.js`、测试都从这里取值，避免三处各写一份。
 */
const LADDER = [
  { code: 'basic', title: '基础版', price: 35, chars: 1500000 },
  { code: 'advanced', title: '高级版', price: 65, chars: 3000000 },
  { code: 'pro', title: '专业版', price: 125, chars: 7500000 }
]

/** 040 写下的那份（本迁移要改掉的"旧文案"）。只改等于它的行。 */
const PRIOR_HIGHLIGHTS = '["150万字符","DeepSeek、GPT"]'

/** 额度文案：额度多少就写多少，单位「万字符」。 */
const copyFor = chars => `["${chars / 10000}万字符","DeepSeek、GPT"]`

/**
 * 生成 up 的 SQL。
 *
 * 抽成函数并导出，是为了让测试能断言**实际执行的语句**，
 * 而不是去 grep 源码里的字面量（动态拼接的 SQL 在源码里根本找不到目标数字）。
 */
function buildUpSql() {
  const quotaUpdates = LADDER.map(p => `
      UPDATE packages SET included_chars = ${p.chars}, updated_at = NOW()
      WHERE code = '${p.code}' AND included_chars <> ${p.chars};`).join('\n')

  // 只改还不是目标文案的行：管理员之后若又改过文案，保留他那一版。
  const copyUpdates = LADDER.filter(p => copyFor(p.chars) !== PRIOR_HIGHLIGHTS).map(p => `
      UPDATE packages SET highlights = '${copyFor(p.chars)}'::jsonb, updated_at = NOW()
      WHERE code = '${p.code}' AND highlights = '${PRIOR_HIGHLIGHTS}'::jsonb;`).join('\n')

  return `
    -- 1) 字符额度：按 code 写成目标值，保证阶梯单调。
    ${quotaUpdates}

    -- 2) 额度文案：额度改了多少，卖点就得跟着写多少。
    --    不跟着改的话，卡片上写着"150万字符"而实际给 300 万 ——
    --    客户不会因此高兴，只会怀疑其他地方是不是也写错了。
    ${copyUpdates}
  `
}

exports.up = pgm => {
  pgm.sql(buildUpSql())
}

exports.down = pgm => {
  // 还原成"迁移前"。字符额度一律回 1500000（= 002 种子的值），**不是**生产
  // 那对 250/600 万：`down` 服务于本地/测试库的重放，而重放链路上从来没
  // 出现过 250/600 万（那是生产上手工改套餐改出来的），回退到种子值才能让
  // "up → down → up" 得到确定的同一条链路。
  const restore = LADDER.map(p => `
      UPDATE packages SET included_chars = 1500000, updated_at = NOW()
      WHERE code = '${p.code}';`).join('\n')

  // 文案还原成 040 的那份，只在仍是本次写进去的目标文案时才动。
  pgm.sql(`
    ${restore}

    UPDATE packages SET highlights = '${PRIOR_HIGHLIGHTS}'::jsonb, updated_at = NOW()
    WHERE highlights IN ('${copyFor(3000000)}'::jsonb, '${copyFor(7500000)}'::jsonb);
  `)
}

// 导出给 `scripts/check-plan-copy.js` 与测试用：目标阶梯只有这一份来源。
exports.LADDER = LADDER
exports.PRIOR_HIGHLIGHTS = PRIOR_HIGHLIGHTS
exports.copyFor = copyFor
exports.buildUpSql = buildUpSql
