'use strict'

/**
 * Signal 对接的超管配置。
 *
 * 数据库只保存 Token 的 SHA-256 和短前缀；完整 Token 只在生成/轮换的响应里
 * 出现一次。网页刷新、审计和数据库备份都不会泄露明文凭据。
 */

exports.up = pgm => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS signal_integration_settings (
      id                smallint PRIMARY KEY DEFAULT 1,
      enabled           boolean NOT NULL DEFAULT false,
      account_user_id   bigint REFERENCES users(id) ON DELETE SET NULL,
      account_username  varchar(64) NOT NULL DEFAULT '',
      api_token_hash    char(64),
      api_token_prefix  varchar(16) NOT NULL DEFAULT '',
      event_token_hash  char(64),
      event_token_prefix varchar(16) NOT NULL DEFAULT '',
      engine_id         varchar(64) NOT NULL DEFAULT '',
      workorder_mode    varchar(16) NOT NULL DEFAULT 'failures',
      updated_by        bigint REFERENCES admins(id) ON DELETE SET NULL,
      updated_at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT signal_integration_settings_singleton_check CHECK (id = 1),
      CONSTRAINT signal_integration_settings_mode_check
        CHECK (workorder_mode IN ('failures','all','ledger')),
      CONSTRAINT signal_integration_settings_api_hash_check
        CHECK (api_token_hash IS NULL OR api_token_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT signal_integration_settings_event_hash_check
        CHECK (event_token_hash IS NULL OR event_token_hash ~ '^[a-f0-9]{64}$')
    );

    INSERT INTO signal_integration_settings(id)
    VALUES(1)
    ON CONFLICT (id) DO NOTHING;
  `)
}

exports.down = pgm => {
  pgm.sql('DROP TABLE IF EXISTS signal_integration_settings')
}
