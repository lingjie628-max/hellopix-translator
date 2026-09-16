/**
 * 邮件服务配置。
 *
 * 注册与找回密码都依赖它 —— 之前这两条是 stub，根因就是没有邮件服务。
 *
 * 为什么用 SMTP 而不是各家厂商的 HTTP API：
 * 阿里云邮件推送、腾讯云 SES、SendGrid、Mailgun 全都提供 SMTP 入口，
 * 一套实现能对接全部。换成 HTTP API 就得为每家写适配器，
 * 而它们的差异其实只在认证方式上，SMTP 已经把这层抹平了。
 *
 * 密码存 `is_secret = true`：`/admin/settings` 读取时会把 secret 值
 * 替换成固定掩码，避免管理员在页面上直接看到 SMTP 授权码。
 */

exports.up = pgm => {
  pgm.sql(`
    INSERT INTO app_settings (key, value, is_secret, description) VALUES
      ('mail.smtp', '{"host":"","port":465,"secure":true,"user":"","pass":"","from":"","fromName":"Hello Pix"}'::jsonb,
       false, 'SMTP 服务器配置。pass 为授权码，读取时会打码'),
      ('mail.enabled', 'false'::jsonb, false, '邮件服务总开关')
    ON CONFLICT (key) DO NOTHING;

    -- 注册赠送字符数：默认 0，给多少是运营决定，不写死在代码里
    INSERT INTO app_settings (key, value, description)
    VALUES ('registration.trial_chars', '0'::jsonb, '新注册商户赠送字符数，0 表示不送')
    ON CONFLICT (key) DO NOTHING;
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DELETE FROM app_settings WHERE key IN ('mail.smtp', 'mail.enabled');
  `)
}
