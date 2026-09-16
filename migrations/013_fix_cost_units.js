/**
 * 修正 012 引入的成本单位错误。
 *
 * `engines.cost_per_million` 的单位是**人民币元/百万字符**（后台列头写的就是
 * 「成本元/百万字」，历史种子也按人民币填：deepl 168、aws 100、google 134）。
 *
 * 012 把 google 写成了 20，用的是 Google 官网的**美元**报价（$20/百万字符），
 * 没有换算成人民币 —— 单位混用导致这一行的成本被低估约 6.7 倍。
 * 该列是后台「翻译通道」页的成本输入，也是超管判断毛利的依据，
 * 填错会让整个套餐的盈利测算失真。
 *
 * 顺便把 Gemini 的成本按同一口径重新估一遍（012 的 8 偏低）：
 *   Gemini 2.5 Flash 约 $0.30/百万输入 token、$2.50/百万输出 token；
 *   按中英混排约 0.6 token/字符估算，1 百万字符 ≈ 60 万输入 + 60 万输出 token
 *   → 0.6×0.30 + 0.6×2.50 ≈ $1.68 ≈ ¥12。
 * 两个值都只是**折算近似**：厂商按字符或 token 计费，与"按字符卖给商户"
 * 不是同一口径，上线后必须拿真实账单在本页校准（列头即为此而设）。
 */

exports.up = pgm => {
  pgm.sql(`
    -- 谷歌：恢复人民币口径（$20/百万字符，按 1:6.7 折算，与历史种子一致）
    UPDATE engines
    SET cost_per_million = 134,
        note = 'Cloud Translation 官方 API（v2）。约 $20/百万字符 ≈ 134 元（按 1:6.7 折算），需按真实账单校准。有 SLA、按量计费，需在后台配置 API Key',
        updated_at = NOW()
    WHERE id = 'google';

    -- Gemini：按 token 口径重新折算（原 8 偏低）
    UPDATE engines
    SET cost_per_million = 12,
        note = '对话式翻译（generateContent），已关闭思考模式以保证速度与 temperature 生效。约 $0.30/百万输入 token、$2.50/百万输出 token，按 0.6 token/字符折算 ≈ 12 元/百万字符，需按真实账单校准。需在后台配置 API Key，模型可覆盖（如 gemini-2.5-pro）',
        updated_at = NOW()
    WHERE id = 'gemini';
  `)
}

exports.down = pgm => {
  // 不提供回滚：回滚只会把错误的单位再写回去。需要旧值时可直接改后台字段。
  pgm.sql('SELECT 1')
}
