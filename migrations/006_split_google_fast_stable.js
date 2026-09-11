/**
 * 谷歌通道拆分：稳定（官方 API） / 极速（公共免费端点）
 *
 * 竞品把谷歌拆成两条线路，我们原来只有一个 `google`：
 *   - 谷歌稳定 = Google Cloud Translation 官方 API，按量计费、有 SLA，需要 key
 *   - 谷歌极速 = translate.googleapis.com 公共端点，无需 key、快，但无 SLA、
 *                可能被限流，属于"能用但不保证"的通道
 *
 * 两者是不同的成本结构与稳定性承诺，因此做成两个引擎、各自接线。
 *
 * 套餐归属：`google-fast` 与 `google` 一样放在 advanced / pro。
 * （如果想把它下放到 basic 当作引流通道，只需在本迁移里往 mapping 加一行
 *   ('basic', 'google-fast')。）
 *
 * 注意：极速通道不写死"公共网络"策略 —— 它要等运行时开关
 * PIX_ALLOW_PUBLIC_TRANSLATION 打开后才会真正发请求，默认 fail-closed。
 */
exports.up = pgm => {
  pgm.sql(`
    INSERT INTO engines
      (id, name, provider, tier, enabled, wired, cost_per_million, model, note)
    VALUES
      ('google-fast', '谷歌极速', 'Google', 'advanced', true, false, 0, NULL,
       '公共免费端点，无需凭据；无 SLA、可能被限流，需显式开启 PIX_ALLOW_PUBLIC_TRANSLATION')
    ON CONFLICT (id) DO NOTHING;

    UPDATE engines SET name = '谷歌稳定' WHERE id = 'google';

    INSERT INTO package_engines (package_id, engine_id)
    SELECT p.id, mapping.engine_id
    FROM (
      VALUES
        ('advanced', 'google-fast'), ('pro', 'google-fast')
    ) AS mapping(package_code, engine_id)
    JOIN packages p ON p.code = mapping.package_code
    ON CONFLICT (package_id, engine_id) DO NOTHING;
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DELETE FROM package_engines
    WHERE engine_id = 'google-fast'
      AND package_id IN (SELECT id FROM packages WHERE code IN ('advanced', 'pro'));

    DELETE FROM engines WHERE id = 'google-fast';

    UPDATE engines SET name = '谷歌翻译' WHERE id = 'google';
  `)
}
