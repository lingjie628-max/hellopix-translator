'use strict'

/**
 * Signal Desktop 翻译完成事件。
 *
 * 这里只保存生命周期与审计元数据：不保存聊天原文、译文、联系人信息或
 * 任何服务令牌。event_id 来自 Signal 侧 UUID，作为 Webhook 幂等键。
 */

exports.up = pgm => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS signal_translation_events (
      id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id               bigint REFERENCES users(id) ON DELETE SET NULL,
      username              varchar(64) NOT NULL DEFAULT '',
      schema_version        integer NOT NULL,
      kind                  varchar(40) NOT NULL,
      event_id              varchar(200) NOT NULL,
      occurred_at           timestamptz NOT NULL,
      message_id            varchar(200),
      provider              varchar(80) NOT NULL,
      model                 varchar(200) NOT NULL,
      target_language       varchar(35) NOT NULL,
      status                varchar(16) NOT NULL,
      reason                varchar(200),
      cache_hit             boolean NOT NULL DEFAULT false,
      duration_ms           integer NOT NULL DEFAULT 0,
      source_length         integer NOT NULL DEFAULT 0,
      translated_length     integer,
      source_text_hmac      char(64),
      translated_text_hmac  char(64),
      ticket_id             bigint REFERENCES tickets(id) ON DELETE SET NULL,
      payload               jsonb NOT NULL,
      created_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT signal_translation_events_kind_check
        CHECK (kind = 'translation.completed'),
      CONSTRAINT signal_translation_events_schema_check
        CHECK (schema_version = 1),
      CONSTRAINT signal_translation_events_status_check
        CHECK (status IN ('success','skipped','error','disabled')),
      CONSTRAINT signal_translation_events_duration_check
        CHECK (duration_ms >= 0),
      CONSTRAINT signal_translation_events_length_check
        CHECK (
          source_length >= 0
          AND (translated_length IS NULL OR translated_length >= 0)
        ),
      UNIQUE (event_id)
    );

    CREATE INDEX IF NOT EXISTS signal_translation_events_user_idx
      ON signal_translation_events(user_id, occurred_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS signal_translation_events_status_idx
      ON signal_translation_events(status, occurred_at DESC)
      WHERE status IN ('error','disabled');
    CREATE INDEX IF NOT EXISTS signal_translation_events_ticket_idx
      ON signal_translation_events(ticket_id)
      WHERE ticket_id IS NOT NULL;
  `)
}

exports.down = pgm => {
  pgm.sql('DROP TABLE IF EXISTS signal_translation_events')
}
