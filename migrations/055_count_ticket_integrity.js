'use strict'

/**
 * 计数账本可审计性。
 *
 * - 每条进粉记录写明它是真实消息还是打开会话、入站还是出向。
 * - 客户合并前保存受影响账本快照；merged_into 只能表达归属链，
 *   无法还原被重写的 fan_type / repeat_of_id。
 */

exports.up = pgm => {
  pgm.sql(`
    ALTER TABLE count_ticket_fans
      ADD COLUMN IF NOT EXISTS event_type text NOT NULL DEFAULT 'message',
      ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'in';

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname='count_ticket_fans_event_type_check'
      ) THEN
        ALTER TABLE count_ticket_fans
          ADD CONSTRAINT count_ticket_fans_event_type_check
          CHECK (event_type = 'message');
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname='count_ticket_fans_direction_check'
      ) THEN
        ALTER TABLE count_ticket_fans
          ADD CONSTRAINT count_ticket_fans_direction_check
          CHECK (direction = 'in');
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS customer_merge_audits (
      id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      from_customer_id    bigint NOT NULL,
      into_customer_id    bigint NOT NULL,
      admin_id            bigint REFERENCES admins(id) ON DELETE SET NULL,
      moved_customer_ids  bigint[] NOT NULL DEFAULT '{}'::bigint[],
      count_ticket_fans   jsonb NOT NULL DEFAULT '[]'::jsonb,
      customer_owners     jsonb NOT NULL DEFAULT '[]'::jsonb,
      collision_events    jsonb NOT NULL DEFAULT '[]'::jsonb,
      identity_events     jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT customer_merge_audits_distinct_check
        CHECK (from_customer_id <> into_customer_id),
      CONSTRAINT customer_merge_audits_fans_check
        CHECK (jsonb_typeof(count_ticket_fans) = 'array'),
      CONSTRAINT customer_merge_audits_owners_check
        CHECK (jsonb_typeof(customer_owners) = 'array'),
      CONSTRAINT customer_merge_audits_collisions_check
        CHECK (jsonb_typeof(collision_events) = 'array'),
      CONSTRAINT customer_merge_audits_identity_check
        CHECK (jsonb_typeof(identity_events) = 'array')
    );
    CREATE INDEX IF NOT EXISTS customer_merge_audits_from_idx
      ON customer_merge_audits(from_customer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS customer_merge_audits_into_idx
      ON customer_merge_audits(into_customer_id, created_at DESC);
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DROP TABLE IF EXISTS customer_merge_audits;
    ALTER TABLE count_ticket_fans
      DROP COLUMN IF EXISTS direction,
      DROP COLUMN IF EXISTS event_type;
  `)
}

