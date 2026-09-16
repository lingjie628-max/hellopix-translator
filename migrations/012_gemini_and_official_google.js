/**
 * Gemini 翻译通道 + 谷歌通道改用官方 API。
 *
 * 两件事放在同一个迁移里，因为它们源自同一个决定：把翻译通道全部收拢到
 * **官方、可计费、有 SLA** 的端点上。
 *
 * 一、谷歌改官方端点
 * 011 已把谷歌合并成一条；那条当时走的是 translate.googleapis.com 公共接口，
 * 而该接口在生产环境**根本不可能启用** —— config.js 把
 * PIX_ALLOW_PUBLIC_TRANSLATION 列为生产禁止标志，进程会直接拒绝启动。
 * 也就是说合并后的谷歌通道在生产永远是不可用状态。
 * 现改为 Cloud Translation 官方 API（v2，API Key 认证，有 SLA、按量计费），
 * 本迁移只更新 note 与成本估算；实现见 translation-provider.js 的 googleTranslate。
 *
 * 二、新增 Gemini
 * 与 deepseek 同属"用 LLM 按指令翻译"，但接口约定差别很大：
 *   - 结构是 contents[].parts[].text，角色 user / model；
 *   - system 指令是顶层 systemInstruction 字段；
 *   - 鉴权用 ?key= 查询参数；
 *   - 2.5 系列**默认开思考**，翻译必须 thinkingBudget:0 关掉（否则变慢、token 翻倍，
 *     且思考模式下 temperature 不生效）。
 * 这些差异已在适配层里逐条处理。
 *
 * 计费说明：两个通道厂商都按量计费，Google 按字符、Gemini 按 token。
 * cost_per_million 只是折算近似值，上线后应拿真实账单在后台「翻译通道」页校准 ——
 * 它是计费侧的定价输入，不影响调用是否成功。
 *
 * 默认 wired=false：没配凭据前不会被选中，也不产生任何计费。
 */

exports.up = pgm => {
  pgm.sql(`
    -- 谷歌：改为官方 Cloud Translation API 的说明与成本估算
    UPDATE engines
    SET provider = 'Google',
        cost_per_million = 20,
        note = 'Cloud Translation 官方 API（v2），有 SLA、按量计费。需在后台配置 API Key；官方定价约 $20/百万字符，请按真实账单校准',
        updated_at = NOW()
    WHERE id = 'google';

    -- Gemini：新增通道
    INSERT INTO engines
      (id, name, provider, tier, enabled, wired, cost_per_million, model, note)
    VALUES
      ('gemini', 'Gemini 翻译', 'Google', 'pro', true, false, 8, 'gemini-2.5-flash',
       '对话式翻译（generateContent）。已关闭思考模式以保证速度与 temperature 生效。需在后台配置 API Key；模型可在后台覆盖（如 gemini-2.5-pro）；按 token 计费，此处成本为折算近似值，请按真实账单校准')
    ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name,
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          note = EXCLUDED.note,
          updated_at = NOW();

    -- 归属：与 deepseek 一致放进 pro；advanced 也放，方便按套餐差异化售卖
    INSERT INTO package_engines (package_id, engine_id)
    SELECT p.id, mapping.engine_id
    FROM (
      VALUES
        ('advanced', 'gemini'), ('pro', 'gemini')
    ) AS mapping(package_code, engine_id)
    JOIN packages p ON p.code = mapping.package_code
    ON CONFLICT (package_id, engine_id) DO NOTHING;
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DELETE FROM package_engines
    WHERE engine_id = 'gemini'
      AND package_id IN (SELECT id FROM packages WHERE code IN ('advanced', 'pro'));

    DELETE FROM engines WHERE id = 'gemini';
  `)
}
