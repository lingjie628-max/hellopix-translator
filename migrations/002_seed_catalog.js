exports.up = pgm => {
  pgm.sql(`
    INSERT INTO engines
      (id, name, provider, tier, enabled, wired, cost_per_million, model, note)
    VALUES
      ('niutrans', '小牛翻译', '小牛', 'basic', true, false, 50, NULL, '凭据未配置，默认不接通厂商'),
      ('google', '谷歌翻译', 'Google', 'advanced', true, false, 134, NULL, '凭据未配置，默认不接通厂商'),
      ('deepl', 'DeepL 翻译', 'DeepL', 'pro', true, false, 168, NULL, '凭据未配置，默认不接通厂商'),
      ('aws', '亚马逊 AWS 翻译', 'Amazon', 'pro', true, false, 100, NULL, '凭据未配置，默认不接通厂商'),
      ('gpt', 'GPT 翻译', 'OpenAI', 'pro', true, false, 5, 'gpt-4o-mini', '凭据未配置，默认不接通厂商'),
      ('grok', 'Grok 翻译', 'xAI', 'pro', true, false, 29, 'grok-4.3', '凭据未配置，默认不接通厂商');

    INSERT INTO packages
      (code, title, subtitle, port_limit, port_unlimited, included_chars, price,
       clients, highlights, features, sort_order)
    VALUES
      (
        'basic', 'Hello Pix 基础版', '基本功能，适合小型企业', 0, true, 1500000, 200,
        '{"standalone":true,"mobile":true,"counter":false}'::jsonb,
        '["150万字符","百度翻译","小牛翻译","独立应用版","手机版"]'::jsonb,
        '{"autoFill":true,"export":true,"moveMaster":true,"fanStats":true,"autoReply":true,"assistant":true,"repeatFan":true,"rotate":true,"keepChat":false,"counterRepeat":true,"ssl":true,"aws":false,"support":false,"feedback":true}'::jsonb,
        10
      ),
      (
        'advanced', 'Hello Pix 高级版', '高级功能，适合中大型企业', 0, true, 1500000, 350,
        '{"standalone":true,"mobile":true,"counter":false}'::jsonb,
        '["150万字符","谷歌翻译","+基础版各翻译通道","独立应用版","手机版"]'::jsonb,
        '{"autoFill":true,"export":true,"moveMaster":true,"fanStats":true,"autoReply":true,"assistant":true,"repeatFan":true,"rotate":true,"keepChat":true,"counterRepeat":true,"ssl":true,"aws":false,"support":true,"feedback":true}'::jsonb,
        20
      ),
      (
        'pro', 'Hello Pix 专业版', '定制化解决方案', 0, true, 1500000, 850,
        '{"standalone":true,"mobile":true,"counter":true}'::jsonb,
        '["150万字符","DeepL 翻译","亚马逊 AWS 翻译","+高级版各翻译通道","独立应用版","手机版"]'::jsonb,
        '{"autoFill":true,"export":true,"moveMaster":true,"fanStats":true,"autoReply":true,"assistant":true,"repeatFan":true,"rotate":true,"keepChat":true,"counterRepeat":true,"ssl":true,"aws":true,"support":true,"feedback":true}'::jsonb,
        30
      );

    INSERT INTO package_engines (package_id, engine_id)
    SELECT p.id, mapping.engine_id
    FROM (
      VALUES
        ('basic', 'niutrans'),
        ('advanced', 'niutrans'),
        ('advanced', 'google'),
        ('pro', 'niutrans'),
        ('pro', 'google'), ('pro', 'deepl'), ('pro', 'aws')
    ) AS mapping(package_code, engine_id)
    JOIN packages p ON p.code = mapping.package_code;

    INSERT INTO app_settings (key, value, description)
    VALUES
      ('site.name', '"Hello Pix"'::jsonb, '站点名称'),
      ('site.announcement', '""'::jsonb, '站点公告'),
      ('downloads.client_url', '""'::jsonb, '客户端 HTTPS 下载地址'),
      ('links.official_url', '""'::jsonb, '官网 HTTPS 地址'),
      ('links.guide_url', '""'::jsonb, '使用指南 HTTPS 地址'),
        ('translation.active_engine', '""'::jsonb, '默认翻译引擎（留空则用套餐内第一个已接通的通道）'),
      ('registration.trial_chars', '0'::jsonb, '新注册账户试用字符，默认关闭'),
      ('billing.enterprise_min_packs', '2'::jsonb, '企业用户最低套餐组数'),
      ('billing.discounts', '{"1":0.9,"10":0.8,"50":0.75}'::jsonb, '套餐数量折扣'),
      ('support.telegram', '""'::jsonb, '客服 Telegram 账号'),
      ('support.telegram_url', '""'::jsonb, '客服 Telegram HTTPS 地址'),
      ('support.button_text', '"联系客服"'::jsonb, '客服按钮文案'),
      ('support.visible', 'true'::jsonb, '是否显示客服入口'),
      ('support.note', '""'::jsonb, '客服说明'),
      ('service.lines', '[]'::jsonb, '正式服务线路；不得预置 localhost');
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DELETE FROM app_settings
    WHERE key IN (
      'site.name', 'site.announcement', 'downloads.client_url', 'links.official_url',
      'links.guide_url', 'translation.active_engine', 'registration.trial_chars',
      'billing.enterprise_min_packs', 'billing.discounts', 'support.telegram',
      'support.telegram_url', 'support.button_text', 'support.visible', 'support.note',
      'service.lines'
    );
    DELETE FROM package_engines
    WHERE package_id IN (SELECT id FROM packages WHERE code IN ('basic', 'advanced', 'pro'));
    DELETE FROM packages WHERE code IN ('basic', 'advanced', 'pro');
    DELETE FROM engines
    WHERE id IN ('niutrans', 'google', 'deepl', 'aws', 'gpt', 'grok');
  `)
}
