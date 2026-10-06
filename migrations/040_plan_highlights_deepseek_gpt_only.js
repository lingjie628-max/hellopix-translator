/**
 * 套餐卡片宣传卖点对齐「只开放 DeepSeek + GPT」（2026-10-06）。
 *
 * ## 起因
 *
 * 迁移 039 把开放通道收窄到 {DeepSeek, GPT} 后，`check:plan-copy` 立刻报错：
 * 三档套餐的宣传文案仍在点名已下架的通道，而它们已不在任何一档的权益里。
 *
 *   基础版  宣传「通义千问」               → 039 已下架
 *   高级版  宣传「豆包、GLM、MiniMax、Mistral」→ 全部下架
 *   专业版  宣传「Claude、谷歌翻译、Grok、Kimi」→ 全部下架
 *
 * 这与 034 修的是同一类事故：**宣传的渠道必须真的在该档授权里**。
 * 卖点与权益对不上，客户为某个宣传名买套餐，一翻译必然撞「当前套餐未包含此通道」——
 * 报错文案商户还看不懂，只会来问「为什么翻译坏了」。
 *
 * ## 改宣传，不改权益（与 034 同一判断）
 *
 * 方向很明确：这些通道是**规则要求下架**的（V1.0.x 前期只留两条），
 * 所以改宣传去对齐权益，而不是把权益补回去迁就一句广告词。
 *
 * ## 文案怎么写
 *
 * 三档权益现在都只有 {DeepSeek, GPT}，因此三档的宣传卖点统一为
 * `["150万字符", "DeepSeek、GPT"]` —— 通道不再是分档依据。
 * 038/035/036 已经摘掉了与通道无关的「独立应用版 / 手机版」承诺，
 * 当前在架的非通道卖点只剩「150万字符」，原样保留。
 *
 * ⚠️ 这意味着三档套餐在「翻译通道」这一维度上已经没有差异了。
 * 这是「只开放两条」的直接结果，不是遗漏；要重新做分档，等 V1.1 有了成本结论
 * 再开新版本（`packages.catalog_version`）并同步更新本迁移的目标文案，
 * **不要回头改这份已发布的文案**。
 *
 * ## 防护（沿用 034 的做法）
 *
 * 每条 UPDATE 都**钉住当时的确切值**（jsonb 相等，不是 LIKE 子串）：
 * 文案是后台可编辑的数据，管理员改过就不覆盖 —— 只改「确实还是那份过期文案」的行。
 * 用 jsonb 相等而不是 `LIKE '%通义千问%'`，是为了避免管理员在文案里
 * 恰好提到这些词（例如「不含豆包」）时被误伤。
 */

// 三档统一的目标文案：通道只剩 DeepSeek 与 GPT。
const ALIGNED = '["150万字符","DeepSeek、GPT"]'

// 040 之前三档各自的文案（035/036 手术后的实际值）。
// down 原样还回来；up 用它做"确实还没改过"的守卫。
const BEFORE = {
  1: '["150万字符","DeepSeek、GPT、通义千问"]',
  2: '["150万字符","豆包、GLM、MiniMax、Mistral","+基础版各翻译通道"]',
  3: '["150万字符","Claude、谷歌翻译、Grok、Kimi","+高级版各翻译通道"]'
}

exports.up = pgm => {
  pgm.sql(`
    -- 基础版：原宣传里的「通义千问」已随 039 下架。
    UPDATE packages
    SET highlights = '${ALIGNED}'::jsonb, updated_at = NOW()
    WHERE id = 1
      AND highlights = '${BEFORE[1]}'::jsonb;

    -- 高级版：原宣传的豆包 / GLM / MiniMax / Mistral 已全部下架。
    UPDATE packages
    SET highlights = '${ALIGNED}'::jsonb, updated_at = NOW()
    WHERE id = 2
      AND highlights = '${BEFORE[2]}'::jsonb;

    -- 专业版：原宣传的 Claude / 谷歌翻译 / Grok / Kimi 已全部下架。
    UPDATE packages
    SET highlights = '${ALIGNED}'::jsonb, updated_at = NOW()
    WHERE id = 3
      AND highlights = '${BEFORE[3]}'::jsonb;
  `)
}

exports.down = pgm => {
  // 还原成 040 之前的文案。守卫钉住**本迁移写进去的确切值**：
  // 管理员之后又改过的，留给人家的版本，不覆盖。
  pgm.sql(`
    UPDATE packages
    SET highlights = '${BEFORE[1]}'::jsonb, updated_at = NOW()
    WHERE id = 1 AND highlights = '${ALIGNED}'::jsonb;

    UPDATE packages
    SET highlights = '${BEFORE[2]}'::jsonb, updated_at = NOW()
    WHERE id = 2 AND highlights = '${ALIGNED}'::jsonb;

    UPDATE packages
    SET highlights = '${BEFORE[3]}'::jsonb, updated_at = NOW()
    WHERE id = 3 AND highlights = '${ALIGNED}'::jsonb;
  `)
}

// 导出给测试用：目标文案与"改动前"文案各只有一份来源，测试直接读它。
exports.alignedHighlights = ALIGNED
exports.previousHighlights = BEFORE
