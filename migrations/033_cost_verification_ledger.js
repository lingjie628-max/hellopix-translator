/**
 * 让成本台账不再把「查不到价格」伪装成「$0」。
 *
 * ## 起因
 *
 * 用测试账号走了一次真实端到端翻译，`translation_usage` 确实写进了一行
 * （链路是通的），但那行长这样：
 *
 *   engine_id=google  provider=Google  model=  upstream_cost=0  currency=  billed_unit=
 *
 * 于是顺着查下去，发现两个问题。
 *
 * ## 问题一：价目表按 `engines.model` 匹配，google 的 model 是空串
 *
 * `estimateUpstreamCost()` 从 `model` 反查单价，查不到就返回
 * `{ cost: 0, currency: '', verified: false, note: '价目表中查不到该模型…' }`。
 * 而 google 的 model 一直是空串（它的价目表 key 是 `google-translate-v2`），
 * 所以**谷歌这条官方价明明已知（$20/百万字符）的通道，成本被记成 0**。
 *
 * 本迁移把它的 model 补上。安全性：谷歌适配器只发 `{ q, target, format }`，
 * 从头到尾**不使用 `model`**（见 translation-provider.js 的 googleTranslate），
 * 所以这个值只影响"反查单价"与"前台展示"，不会改变实际调用。
 *
 * 注意**不**动 gpt：它的 model 是 `gpt-5.6-luna`，而价目表里是 `gpt-4o-mini`，
 * 同样匹配不上、同样被记成 0 —— 但 `model` 对它是**真会发给 API 的**，
 * 改它等于换模型。那条只能靠补价（或显式标未核实），不能在这里改。
 *
 * ## 问题二：「未核实」这个信号根本没有落库
 *
 * `estimateUpstreamCost` 返回的 `verified` / `note` / `source` / `asOf`
 * 在 `recordUpstreamUsage` 里被丢掉了，只写了 `cost` 和 `currency`。
 * 结果：**一个"价格没查到"的 0，和一个"真的没花钱"的 0，在库里长得一模一样**，
 * 而且没有任何日志。成本对账时没人能发现少算了一整条通道。
 *
 * 本迁移补上四列把它们落库。`cost_verified` 默认 false 是**诚实**的默认值：
 * 已有的历史行确实是未核实的（那次 google 记录成本为 0，正是未核实）。
 *
 * 为什么不只加 `verified`：这个台账是**权威成本口径**（见 031 的注释），
 * 将来有人问"这行为什么是这个数"，必须能答出单价来自哪、截至什么时候。
 * `source` / `asOf` 就是答案，而价目表本身（upstream-pricing.js 的三条纪律）
 * 也要求价格必须带出处与日期。字段免费，答案不免费。
 */

exports.up = pgm => {
  pgm.sql(`
    -- =====================================================================
    -- 1) 成本核验信息落库
    -- =====================================================================

    -- 是否经官方价目表核实过。false 不等于"成本是 0"，只表示"我们不知道"。
    ALTER TABLE translation_usage
      ADD COLUMN IF NOT EXISTS cost_verified boolean NOT NULL DEFAULT false;

    -- 未核实时写明原因（价目表原样给的话术），已核实时为价目表的备注。
    ALTER TABLE translation_usage
      ADD COLUMN IF NOT EXISTS cost_note text NOT NULL DEFAULT '';

    -- 单价出处与日期：对账时回答"这个数从哪来"。
    -- asOf 用 varchar 而不是 date —— 价目表里既有 '2026-09' 也有 '2026-09-11'，
    -- 强行转 date 会把前者变成猜测出来的具体某天。
    ALTER TABLE translation_usage
      ADD COLUMN IF NOT EXISTS cost_source text NOT NULL DEFAULT '';
    ALTER TABLE translation_usage
      ADD COLUMN IF NOT EXISTS cost_as_of varchar(32) NOT NULL DEFAULT '';

    -- 取"未核实"的行要快：这是运营每天要看一眼的异常清单。
    CREATE INDEX IF NOT EXISTS translation_usage_unverified_idx
      ON translation_usage (created_at DESC) WHERE NOT cost_verified;

    -- =====================================================================
    -- 2) 补 google 的 model，让它已知的官方价生效
    -- =====================================================================

    -- 只在仍为空时补，不覆盖管理员后来手工填的值。
    UPDATE engines
    SET model = 'google-translate-v2',
        updated_at = NOW()
    WHERE id = 'google'
      AND (model IS NULL OR model = '');
  `)
}

exports.down = pgm => {
  pgm.sql(`
    -- 只回滚"本迁移写进去的那个值"，管理员后来改成别的就不动它。
    UPDATE engines
    SET model = '',
        updated_at = NOW()
    WHERE id = 'google'
      AND model = 'google-translate-v2';

    DROP INDEX IF EXISTS translation_usage_unverified_idx;
    ALTER TABLE translation_usage DROP COLUMN IF EXISTS cost_as_of;
    ALTER TABLE translation_usage DROP COLUMN IF EXISTS cost_source;
    ALTER TABLE translation_usage DROP COLUMN IF EXISTS cost_note;
    ALTER TABLE translation_usage DROP COLUMN IF EXISTS cost_verified;
  `)
}
