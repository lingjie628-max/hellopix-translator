/**
 * 通道补齐与套餐归属修正（对齐竞品渠道清单）
 *
 * 1) 新增 Papago（Naver）：竞品把 Papago 与 DeepL/ChatGPT 并列，我们此前没有
 *    任何 Naver 系通道，韩语/小语种是缺口。
 * 2) 修正遗漏：gpt / grok 在 002 里种进了 engines，但没有写进 package_engines，
 *    结果任何套餐都选不到这两个通道 —— 引擎存在却"没上桌"。
 *
 * 注意：新通道一律 wired=false。真实厂商凭据与适配器就绪、并显式置 wired=true
 * 之后才会对外可用（core-service 在扣费前就会以 ENGINE_NOT_CONFIGURED 拒绝）。
 */
exports.up = pgm => {
  pgm.sql(`
    INSERT INTO engines
      (id, name, provider, tier, enabled, wired, cost_per_million, model, note)
    VALUES
      ('papago', 'Papago 翻译', 'Naver', 'pro', true, false, 72, NULL,
       '凭据未配置，默认不接通厂商；单价待与 Naver 账单核对')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO package_engines (package_id, engine_id)
    SELECT p.id, mapping.engine_id
    FROM (
      VALUES
        ('pro', 'gpt'), ('pro', 'grok'), ('pro', 'papago')
    ) AS mapping(package_code, engine_id)
    JOIN packages p ON p.code = mapping.package_code
    ON CONFLICT (package_id, engine_id) DO NOTHING;
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DELETE FROM package_engines
    WHERE engine_id IN ('gpt', 'grok', 'papago')
      AND package_id IN (SELECT id FROM packages WHERE code = 'pro');

    DELETE FROM engines WHERE id = 'papago';
  `)
}
