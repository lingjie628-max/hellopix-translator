/**
 * 成本口径统一为**美元/百万字符**，与套餐售价同币种。
 *
 * ## 为什么必须改
 *
 * `engines.cost_per_million` 一直是「人民币元/百万字符」（见 013 的文件头），
 * 而套餐售价 `packages.price` 是按 `billing.currency` 计的 —— 生产上那个值是
 * **USD**。于是超管看到的毛利其实是**拿美元收入减人民币成本**，
 * 两个币种直接相减，数字没有任何意义。
 *
 * 更糟的是它已经**显示错了**：`translate_logs.cost_amount` 由
 * `cost_per_million × 字符数 ÷ 1e6` 算出（core-service 的计费事务），
 * 所以那一列也是人民币；而超管总览与「翻译计费」页都用 `currencySymbol`
 * 给它加了「$」前缀。也就是说：
 *
 *   · 后台写着「通道成本 $X」，
 *   · 实际 X 是人民币。
 *
 * 用户看到的"乱"就是这个 —— 不是排版问题，是币种标错。
 *
 * ## 本次做法
 *
 * 把存储本身换算成美元，而不是只在显示层换算：
 *   1. 显示层换算要改三处（通道页、总览、翻译计费），漏一处就又不一致；
 *   2. 聚合（SUM(cost_amount)）发生在 SQL 里，显示层拿到的已是合计值，
 *      没法在拿到之后再换算；
 *   3. 换算一次落库，之后所有读取方天然正确。
 *
 * ## 汇率取 7.2
 *
 * 不是随手取的，是**倒推**：031 里这批估值本身就是用 7.2 从美元官方价
 * 折算成人民币的（见 031 的 `cost` 字段注释），`scripts/translation-cost-report.js`
 * 也用 `FX = { USD: 7.2 }`。用同一个汇率除回去，等于把这批估值**还原到
 * 它们被折算前的口径**，不引入新的误差。
 *
 * ## 精度
 *
 * `cost_per_million` 是 numeric(14,4)、`cost_amount` 是 numeric(16,6)，
 * 除法会按列精度截断，down 再乘回来有极小漂移（十万分之一量级）。
 * 这两列本来就是**规划用粗估**（权威成本在 `translation_usage`：
 * 厂商真实 token × 官方单价），这点漂移不影响任何决策，但如实记在这里。
 *
 * ## 后续注意
 *
 * 换算后该列**与套餐售价同币种**。若将来在「系统设置 → 价格货币」
 * 把 `billing.currency` 改成非 USD，这一列必须同步重设 ——
 * 前端已在编辑框旁标出当前币种，避免再出现"表头写美元、数值是人民币"。
 * 这里刻意**不**做成自动跟随：成本是人手填的估值，
 * 跟着设置项自动乘除会让"这个数到底是谁填的"变得无法追溯。
 */

// 与 031 的估值折算、cost-report 的 FX 表保持一致；改这里必须同时改那两处。
const FX_USD_CNY = 7.2

exports.up = pgm => {
  pgm.sql(`
    -- 通道成本表：人民币元/百万字符 → 美元/百万字符
    UPDATE engines
    SET cost_per_million = ROUND(cost_per_million / ${FX_USD_CNY}, 4),
        updated_at = NOW();

    -- 历史翻译日志的成本快照同样换算，否则新旧记录会混着两个币种，
    -- 总览页的 SUM 就成了"人民币 + 美元"。
    -- 只动非零行：该列 NOT NULL DEFAULT 0，0 换算与否都是 0，
    -- 但跳过它们能少写 30 倍的行（生产上绝大多数记录的成本是 0）。
    UPDATE translate_logs
    SET cost_amount = ROUND(cost_amount / ${FX_USD_CNY}, 6)
    WHERE cost_amount <> 0;
  `)
}

exports.down = pgm => {
  // 对称还原：乘回同一汇率。刻意不用"写死一批旧值"——
  // 那等于把管理员后来在后台手工校准过的成本一并抹掉。
  pgm.sql(`
    UPDATE engines
    SET cost_per_million = ROUND(cost_per_million * ${FX_USD_CNY}, 4),
        updated_at = NOW();

    UPDATE translate_logs
    SET cost_amount = ROUND(cost_amount * ${FX_USD_CNY}, 6)
    WHERE cost_amount <> 0;
  `)
}
