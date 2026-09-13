/**
 * DeepSeek 翻译通道。
 *
 * 与 gpt / grok 同属"对话式翻译"：DeepSeek 没有翻译专用端点，走 OpenAI 兼容的
 * /chat/completions，由 system 提示词控制目标语言，译文取 choices[0].message.content。
 *
 * 与有道/百度那类专用翻译 API 的差异（已在本迁移的 note 里写明）：
 *   - 需要两项配置：API Key 与 model（默认 deepseek-chat）；
 *   - 厂商计费按 token 而非字符，所以 cost_per_million 只是换算后的近似值，
 *     上线后应拿真实账单在后台「翻译通道」页校准 —— 它是计费侧的定价输入，
 *     不参与调用是否成功。
 *
 * 默认 wired=false：没配凭据前绝不被 core-service 选中，也不会产生任何计费。
 * 后台填好 API Key 并在「翻译通道」页把它设为使用中之后才真正接通。
 */
exports.up = pgm => {
  pgm.sql(`
    INSERT INTO engines
      (id, name, provider, tier, enabled, wired, cost_per_million, model, note)
    VALUES
      ('deepseek', 'DeepSeek 翻译', 'DeepSeek', 'pro', true, false, 8, 'deepseek-chat',
       '对话式翻译（OpenAI 兼容 /chat/completions）。需在后台配置 API Key；按 token 计费，此处成本为折算近似值，请按真实账单校准')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO package_engines (package_id, engine_id)
    SELECT p.id, mapping.engine_id
    FROM (
      VALUES
        ('pro', 'deepseek')
    ) AS mapping(package_code, engine_id)
    JOIN packages p ON p.code = mapping.package_code
    ON CONFLICT (package_id, engine_id) DO NOTHING;
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DELETE FROM package_engines
    WHERE engine_id = 'deepseek'
      AND package_id IN (SELECT id FROM packages WHERE code IN ('pro'));

    DELETE FROM engines WHERE id = 'deepseek';
  `)
}
