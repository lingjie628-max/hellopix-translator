/**
 * 通道分配调整 + 套餐级"是否允许切换通道"开关。
 *
 * 背景：`cost_per_million` 是人民币/百万字符，与套餐定价（美元）一比就能算出毛利。
 * 调整前最坏情况：
 *   基础版 $35（≈¥167/百万字符）里放着谷歌（¥134）→ 毛利只剩 20%，
 *   而基础版是走量款，用户越多越薄。
 *
 * 本次三处改动：
 *
 * 1. 谷歌移出基础版，下放到高级版
 *    基础版只留百度（¥49）与小牛（¥50）→ 最坏毛利 70%
 *    顺带给了高级版一个**客户认得**的升级理由（"能用谷歌翻译了"），
 *    比"能用 Gemini"好卖得多。
 *
 * 2. DeepSeek 加进高级版
 *    成本 ¥6，几乎不影响毛利；但高级版的定位是"智能"，
 *    原来只有 Gemini 一个 AI 通道，显得单薄。
 *
 * 3. 新增 allow_engine_switch（默认 true），基础版设为 false
 *    基础版**保留两个通道但不开放切换**：客户不必做他们判断不了的选择，
 *    成本也锁死在便宜通道上。两个通道的用途是——
 *    超管可以通过启用/停用调整主用通道，不必改套餐；
 *    将来接降级链时，第二个通道就是现成的备用。
 *    "能自己换通道"从此成为高级版以上的权益，是**可感知**的档位差异。
 *
 * 最坏毛利（收入按 150 万字符换算）：
 *   基础版 ¥167/百万字符 − ¥50 = 70%
 *   高级版 ¥286/百万字符 − ¥134 = 53%
 *   专业版 ¥596/百万字符 − ¥168 = 72%
 */

exports.up = pgm => {
  pgm.sql(`
    -- 1) 套餐级开关：是否允许商户自己切换翻译通道
    ALTER TABLE packages ADD COLUMN IF NOT EXISTS allow_engine_switch boolean NOT NULL DEFAULT true;

    UPDATE packages SET allow_engine_switch = false, updated_at = NOW() WHERE code = 'basic';
    UPDATE packages SET allow_engine_switch = true,  updated_at = NOW() WHERE code <> 'basic';

    -- 2) 重新分配通道
    DELETE FROM package_engines
    WHERE package_id IN (SELECT id FROM packages WHERE code IN ('basic', 'advanced'));

    INSERT INTO package_engines (package_id, engine_id)
    SELECT p.id, m.engine_id
    FROM (
      VALUES
        ('basic', 'baidu'), ('basic', 'niutrans'),
        ('advanced', 'baidu'), ('advanced', 'niutrans'),
        ('advanced', 'google'), ('advanced', 'gemini'), ('advanced', 'deepseek')
    ) AS m(package_code, engine_id)
    JOIN packages p ON p.code = m.package_code
    ON CONFLICT (package_id, engine_id) DO NOTHING;

    -- 3) 存量账号若选的通道已不在其套餐内，清空选择，
    --    交给程序按"套餐内第一个已接通且启用"的规则重新解析
    --    （否则会一直撞「当前套餐未包含此通道」）
    UPDATE users u SET active_engine_id = NULL, updated_at = NOW()
    WHERE u.active_engine_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM package_engines pe
        WHERE pe.package_id = u.package_id AND pe.engine_id = u.active_engine_id
      );

    UPDATE sub_accounts s SET active_engine_id = NULL, updated_at = NOW()
    WHERE s.active_engine_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM package_engines pe
        JOIN users u ON u.id = s.parent_id
        WHERE pe.package_id = u.package_id AND pe.engine_id = s.active_engine_id
      );
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DELETE FROM package_engines
    WHERE package_id IN (SELECT id FROM packages WHERE code IN ('basic', 'advanced'));

    INSERT INTO package_engines (package_id, engine_id)
    SELECT p.id, m.engine_id
    FROM (
      VALUES
        ('basic', 'baidu'), ('basic', 'niutrans'), ('basic', 'google'),
        ('advanced', 'baidu'), ('advanced', 'niutrans'), ('advanced', 'google'), ('advanced', 'gemini')
    ) AS m(package_code, engine_id)
    JOIN packages p ON p.code = m.package_code
    ON CONFLICT (package_id, engine_id) DO NOTHING;

    ALTER TABLE packages DROP COLUMN IF EXISTS allow_engine_switch;
  `)
}
