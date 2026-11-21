'use strict'

/**
 * 计数工单可配置查重范围。
 *
 * 默认 merchant 保持 1.3.14 的既有口径：同一商户、同一应用内识别重粉。
 * 新工单可改为仅当前工单，或人工选择若干同商户同应用工单一起查重。
 *
 * 查重范围只在工单还没有进粉记录时允许修改。否则今天把范围从“当前工单”
 * 扩到“全部工单”，历史事件不会自动重算，明天的报表就会出现两套口径。
 */

exports.up = pgm => {
  pgm.sql(`
    ALTER TABLE count_tickets
      ADD COLUMN IF NOT EXISTS dedup_scope text NOT NULL DEFAULT 'merchant';

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname='count_tickets_dedup_scope_check'
      ) THEN
        ALTER TABLE count_tickets
          ADD CONSTRAINT count_tickets_dedup_scope_check
          CHECK (dedup_scope IN ('ticket', 'merchant', 'linked'));
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS count_ticket_dedup_links (
      ticket_id        bigint NOT NULL,
      user_id          bigint NOT NULL,
      linked_ticket_id bigint NOT NULL,
      created_at       timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (ticket_id, linked_ticket_id),
      CONSTRAINT count_ticket_dedup_links_source_fk
        FOREIGN KEY (ticket_id, user_id)
        REFERENCES count_tickets(id, user_id) ON DELETE CASCADE,
      CONSTRAINT count_ticket_dedup_links_target_fk
        FOREIGN KEY (linked_ticket_id, user_id)
        REFERENCES count_tickets(id, user_id) ON DELETE CASCADE,
      CONSTRAINT count_ticket_dedup_links_distinct_check
        CHECK (ticket_id <> linked_ticket_id)
    );

    CREATE INDEX IF NOT EXISTS count_ticket_dedup_links_target_idx
      ON count_ticket_dedup_links(user_id, linked_ticket_id, ticket_id);

    CREATE INDEX IF NOT EXISTS count_ticket_fans_dedup_customer_idx
      ON count_ticket_fans(user_id, platform, customer_id, event_at, id)
      WHERE customer_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS count_ticket_fans_dedup_peer_idx
      ON count_ticket_fans(user_id, platform, peer_key, event_at, id)
      WHERE customer_id IS NULL;

    -- 从某张工单的视角，找出该身份在配置范围内最早的一条进粉事实。
    -- 范围是单向的：A 指定 B 参与比较，不要求 B 也反向指定 A。
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
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DROP FUNCTION IF EXISTS count_ticket_first_fan_id(bigint, bigint, text, bigint, text);
    DROP INDEX IF EXISTS count_ticket_fans_dedup_peer_idx;
    DROP INDEX IF EXISTS count_ticket_fans_dedup_customer_idx;
    DROP TABLE IF EXISTS count_ticket_dedup_links;
    ALTER TABLE count_tickets
      DROP CONSTRAINT IF EXISTS count_tickets_dedup_scope_check,
      DROP COLUMN IF EXISTS dedup_scope;
  `)
}
