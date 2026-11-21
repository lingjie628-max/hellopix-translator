'use strict'

/**
 * 计数工单命名分组与底库。
 *
 * - 分组按商户+应用隔离，一个工单最多属于一个组。
 * - group 查重只比较同组、同商户、同应用的工单。
 * - 底库按商户+应用隔离，导入键与客户端上报的 peerKey 精确匹配。
 * - 底库命中在进粉账本里单列为 repeat_type='base'，客户合并或乱序重排
 *   不能把它错误改成新粉。
 */

exports.up = pgm => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS count_ticket_groups (
      id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       varchar(80) NOT NULL,
      platform   text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT count_ticket_groups_name_check
        CHECK (length(btrim(name)) BETWEEN 1 AND 80),
      CONSTRAINT count_ticket_groups_platform_check
        CHECK (length(btrim(platform)) > 0),
      UNIQUE (id, user_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS count_ticket_groups_name_uidx
      ON count_ticket_groups(user_id, platform, lower(btrim(name)));
    CREATE INDEX IF NOT EXISTS count_ticket_groups_user_idx
      ON count_ticket_groups(user_id, platform, updated_at DESC);

    ALTER TABLE count_tickets
      ADD COLUMN IF NOT EXISTS group_id bigint,
      ADD COLUMN IF NOT EXISTS dedup_base_enabled boolean NOT NULL DEFAULT false;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname='count_tickets_group_fk'
      ) THEN
        ALTER TABLE count_tickets
          ADD CONSTRAINT count_tickets_group_fk
          FOREIGN KEY (group_id, user_id)
          REFERENCES count_ticket_groups(id, user_id)
          ON DELETE RESTRICT;
      END IF;
    END $$;

    ALTER TABLE count_tickets
      DROP CONSTRAINT IF EXISTS count_tickets_dedup_scope_check;
    ALTER TABLE count_tickets
      ADD CONSTRAINT count_tickets_dedup_scope_check
      CHECK (dedup_scope IN ('ticket', 'merchant', 'group', 'linked'));

    CREATE INDEX IF NOT EXISTS count_tickets_group_idx
      ON count_tickets(user_id, group_id, platform, status)
      WHERE group_id IS NOT NULL;

    ALTER TABLE count_ticket_fans
      ADD COLUMN IF NOT EXISTS repeat_type text NOT NULL DEFAULT 'fan',
      ADD COLUMN IF NOT EXISTS base_matched boolean NOT NULL DEFAULT false;
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname='count_ticket_fans_repeat_type_check'
      ) THEN
        ALTER TABLE count_ticket_fans
          ADD CONSTRAINT count_ticket_fans_repeat_type_check
          CHECK (repeat_type IN ('fan', 'base'));
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS count_ticket_base_batches (
      id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id        bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform       text NOT NULL,
      filename       varchar(200) NOT NULL DEFAULT '',
      total_lines    integer NOT NULL DEFAULT 0,
      inserted_count integer NOT NULL DEFAULT 0,
      updated_count  integer NOT NULL DEFAULT 0,
      created_at     timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT count_ticket_base_batches_platform_check
        CHECK (length(btrim(platform)) > 0),
      CONSTRAINT count_ticket_base_batches_counts_check
        CHECK (total_lines >= 0 AND inserted_count >= 0 AND updated_count >= 0),
      UNIQUE (id, user_id)
    );
    CREATE INDEX IF NOT EXISTS count_ticket_base_batches_user_idx
      ON count_ticket_base_batches(user_id, platform, created_at DESC);

    CREATE TABLE IF NOT EXISTS count_ticket_base_entries (
      id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id      bigint NOT NULL,
      platform     text NOT NULL,
      peer_key     text NOT NULL,
      display_name varchar(200) NOT NULL DEFAULT '',
      source       varchar(120) NOT NULL DEFAULT '',
      batch_id     bigint,
      imported_at  timestamptz NOT NULL DEFAULT now(),
      created_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT count_ticket_base_entries_user_fk
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT count_ticket_base_entries_batch_fk
        FOREIGN KEY (batch_id)
        REFERENCES count_ticket_base_batches(id) ON DELETE SET NULL,
      CONSTRAINT count_ticket_base_entries_platform_check
        CHECK (length(btrim(platform)) > 0),
      CONSTRAINT count_ticket_base_entries_peer_check
        CHECK (length(btrim(peer_key)) BETWEEN 1 AND 200),
      UNIQUE (user_id, platform, peer_key)
    );
    CREATE INDEX IF NOT EXISTS count_ticket_base_entries_user_idx
      ON count_ticket_base_entries(user_id, platform, imported_at DESC, id DESC);

    CREATE OR REPLACE FUNCTION count_ticket_first_fan_id(
      p_user_id bigint,
      p_ticket_id bigint,
      p_platform text,
      p_customer_id bigint,
      p_peer_key text
    )
    RETURNS bigint
    LANGUAGE sql
    STABLE
    AS $$
      SELECT candidate.id
      FROM count_tickets t
      JOIN count_ticket_fans candidate
        ON candidate.user_id = t.user_id
       AND candidate.platform = t.platform
      WHERE t.id = p_ticket_id
        AND t.user_id = p_user_id
        AND candidate.platform = p_platform
        AND (
          (p_customer_id IS NOT NULL AND candidate.customer_id = p_customer_id)
          OR (
            p_customer_id IS NULL
            AND candidate.customer_id IS NULL
            AND candidate.peer_key = p_peer_key
          )
        )
        AND (
          t.dedup_scope = 'merchant'
          OR (t.dedup_scope = 'ticket' AND candidate.ticket_id = t.id)
          OR (
            t.dedup_scope = 'group'
            AND t.group_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM count_tickets grouped
              WHERE grouped.id = candidate.ticket_id
                AND grouped.user_id = t.user_id
                AND grouped.platform = t.platform
                AND grouped.group_id = t.group_id
            )
          )
          OR (
            t.dedup_scope = 'linked'
            AND (
              candidate.ticket_id = t.id
              OR EXISTS (
                SELECT 1
                FROM count_ticket_dedup_links l
                WHERE l.ticket_id = t.id
                  AND l.user_id = t.user_id
                  AND l.linked_ticket_id = candidate.ticket_id
              )
            )
          )
        )
      ORDER BY candidate.event_at ASC, candidate.id ASC
      LIMIT 1
    $$;
  `)
}

exports.down = pgm => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION count_ticket_first_fan_id(
      p_user_id bigint,
      p_ticket_id bigint,
      p_platform text,
      p_customer_id bigint,
      p_peer_key text
    )
    RETURNS bigint
    LANGUAGE sql
    STABLE
    AS $$
      SELECT candidate.id
      FROM count_tickets t
      JOIN count_ticket_fans candidate
        ON candidate.user_id = t.user_id
       AND candidate.platform = t.platform
      WHERE t.id = p_ticket_id
        AND t.user_id = p_user_id
        AND candidate.platform = p_platform
        AND (
          (p_customer_id IS NOT NULL AND candidate.customer_id = p_customer_id)
          OR (
            p_customer_id IS NULL
            AND candidate.customer_id IS NULL
            AND candidate.peer_key = p_peer_key
          )
        )
        AND (
          t.dedup_scope = 'merchant'
          OR (t.dedup_scope = 'ticket' AND candidate.ticket_id = t.id)
          OR (
            t.dedup_scope = 'linked'
            AND (
              candidate.ticket_id = t.id
              OR EXISTS (
                SELECT 1
                FROM count_ticket_dedup_links l
                WHERE l.ticket_id = t.id
                  AND l.user_id = t.user_id
                  AND l.linked_ticket_id = candidate.ticket_id
              )
            )
          )
        )
      ORDER BY candidate.event_at ASC, candidate.id ASC
      LIMIT 1
    $$;

    DROP TABLE IF EXISTS count_ticket_base_entries;
    DROP TABLE IF EXISTS count_ticket_base_batches;
    ALTER TABLE count_ticket_fans
      DROP CONSTRAINT IF EXISTS count_ticket_fans_repeat_type_check,
      DROP COLUMN IF EXISTS repeat_type,
      DROP COLUMN IF EXISTS base_matched;

    ALTER TABLE count_tickets
      DROP CONSTRAINT IF EXISTS count_tickets_group_fk,
      DROP COLUMN IF EXISTS dedup_base_enabled,
      DROP COLUMN IF EXISTS group_id;
    ALTER TABLE count_tickets
      DROP CONSTRAINT IF EXISTS count_tickets_dedup_scope_check;
    ALTER TABLE count_tickets
      ADD CONSTRAINT count_tickets_dedup_scope_check
      CHECK (dedup_scope IN ('ticket', 'merchant', 'linked'));

    DROP TABLE IF EXISTS count_ticket_groups;
  `)
}
