/**
 * 合并谷歌通道：`google-fast`（极速）+ `google`（稳定）→ 一条「谷歌翻译」。
 *
 * 背景：006 把谷歌拆成"稳定 / 极速"两条，实际跑下来这个拆分没有价值 ——
 * 「谷歌稳定」（官方付费 API）在适配层里**从来就是个 notWired 空壳**，
 * 商户选中它只会拿到"尚未接入"。留一条永远不可用的通道比没有更糟，
 * 用户会以为是自己的配置问题。
 *
 * 合并策略：
 *   - 保留 `google` 这个 id（标准名，存量账号与套餐引用的都是它）；
 *   - 「极速」的真实实现（公共端点）成为唯一实现，由适配层挂到 `google` 上；
 *   - `google-fast` 整个删掉，并把指向它的账号选择改回 `google`。
 *
 * **安全门禁不变**：合并后的公共端点实现仍然受 PIX_ALLOW_PUBLIC_TRANSLATION
 * 控制，未显式开启时 fail-closed。合并只去掉重复的通道名，不放宽这个约定。
 */

exports.up = pgm => {
  pgm.sql(`
    -- 1) 存量账号先改指向，再删通道（避免留下悬空引用）
    UPDATE users SET active_engine_id = 'google', updated_at = NOW()
    WHERE active_engine_id = 'google-fast';
    UPDATE sub_accounts SET active_engine_id = 'google', updated_at = NOW()
    WHERE active_engine_id = 'google-fast';

    -- 2) 默认通道设置指向极速的也改回 google
    UPDATE app_settings
    SET value = '"google"'::jsonb
    WHERE key = 'translation.active_engine' AND value = '"google-fast"'::jsonb;

    -- 3) 套餐关联：极速原本挂在 advanced / pro，google 已在其中，
    --    去掉重复项即可（ON CONFLICT 由主键保证不会重复）
    DELETE FROM package_engines WHERE engine_id = 'google-fast';

    -- 4) 通道本体
    DELETE FROM engines WHERE id = 'google-fast';

    -- 5) 名称统一成「谷歌翻译」，不再有稳定/极速之分
    UPDATE engines SET name = '谷歌翻译', updated_at = NOW() WHERE id = 'google';

    -- 6) 套餐卖点里可能写着「谷歌极速」/「谷歌稳定」，统一成「谷歌翻译」
    UPDATE packages
    SET highlights = (
      SELECT jsonb_agg(
        CASE WHEN value IN ('"谷歌极速"', '"谷歌稳定"') THEN '"谷歌翻译"'::jsonb ELSE value END
      )
      FROM jsonb_array_elements(highlights) AS value
    ), updated_at = NOW()
    WHERE highlights @> '["谷歌极速"]'::jsonb OR highlights @> '["谷歌稳定"]'::jsonb;
  `)
}

exports.down = pgm => {
  // 有意不提供回滚：合并是产品决定，恢复两条通道要连同适配层一起恢复，
  // 单靠回滚数据库只会造出"数据库有、代码没有"的悬空通道（与 010 同理）。
  pgm.sql('SELECT 1')
}
