/**
 * 下架百度翻译。
 *
 * 原因：产品负责人明确不要这个通道。
 *
 * 需要说明的是 —— 百度从来就**没有真正实现过**，它一直是
 * `notWired('百度翻译')` 占位：`configured()` 恒为 false，
 * 就算填了 key 也用不了，界面会一直显示"未接通"。
 * 所以这次下架没有功能损失，只是把界面上一个用不了的选项去掉。
 *
 * ## 顺带说明：其余通道已全部实现
 *
 * 与本迁移同时，niutrans / deepl / aws / gpt / grok / papago
 * 六个占位都补上了真实适配器。现在界面上留下的每一个通道
 * 都是真能调通的（前提是填了有效凭据）。
 *
 * ## 套餐归属
 *
 * 百度原先在三个套餐里都有（基础版靠它 + 小牛 + 谷歌）。
 * 下架后：
 *   基础版 = 小牛 + 谷歌
 *   高级版 = 小牛 + 谷歌 + Gemini + DeepSeek
 *   专业版 = 其余 9 个
 * 每个套餐都仍有可用通道，不会出现"买了却没通道可用"。
 */

exports.up = pgm => {
  pgm.sql(`
    -- 1) 从套餐里摘掉（先做，避免外键挡住删 engines）
    DELETE FROM package_engines WHERE engine_id = 'baidu';

    -- 2) 存量账号若正用着百度，清空选择：
    --    否则商户会一直撞「当前套餐未包含此通道」，
    --    而界面上已经找不到这个通道，会让人以为是系统坏了
    UPDATE users SET active_engine_id = NULL, updated_at = NOW()
    WHERE active_engine_id = 'baidu';

    UPDATE sub_accounts SET active_engine_id = NULL, updated_at = NOW()
    WHERE active_engine_id = 'baidu';

    -- 3) 默认通道若指向百度，一并清掉（由程序按"套餐内第一个已接通"重新解析）
    UPDATE app_settings
    SET value = '""'::jsonb, updated_at = NOW()
    WHERE key = 'translation.active_engine'
      AND value = '"baidu"'::jsonb;

    -- 4) 删除通道本身
    DELETE FROM engines WHERE id = 'baidu';
  `)
}

exports.down = pgm => {
  pgm.sql(`
    INSERT INTO engines
      (id, name, provider, tier, enabled, wired, cost_per_million, model, note)
    VALUES
      ('baidu', '百度翻译', '百度', 'basic', true, false, 49, NULL, '凭据未配置，默认不接通厂商')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO package_engines (package_id, engine_id)
    SELECT p.id, 'baidu'
    FROM packages p WHERE p.code IN ('basic', 'advanced', 'pro')
    ON CONFLICT (package_id, engine_id) DO NOTHING;
  `)
}
