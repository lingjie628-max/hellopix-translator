'use strict'

/**
 * 计数工单软删除。
 *
 * 工单是重粉判定的审计依据，物理删除会连带清掉进粉账本、账号绑定和分享记录。
 * 这里只打 deleted_at：
 *   - 商户列表、详情、自动计粉、关联工单和公开分享立即看不到该工单；
 *   - 历史 count_ticket_fans 原样保留，便于事后核对；
 *   - 删除后不再参与后续重粉判定；
 *   - 数据库管理员仍可按 deleted_at 找回并人工恢复。
 */

exports.up = pgm => {
  pgm.sql(`
    ALTER TABLE count_tickets
      ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

    CREATE INDEX IF NOT EXISTS count_tickets_live_user_idx
      ON count_tickets(user_id, updated_at DESC, id DESC)
      WHERE deleted_at IS NULL;

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
       AND candidate.event_at >= COALESCE(t.cycle_started_at, '-infinity'::timestamptz)
      JOIN count_tickets candidate_ticket
        ON candidate_ticket.id = candidate.ticket_id
       AND candidate_ticket.user_id = candidate.user_id
       AND candidate.cycle_no = candidate_ticket.cycle_no
       AND candidate_ticket.deleted_at IS NULL
      WHERE t.id = p_ticket_id
        AND t.user_id = p_user_id
        AND t.deleted_at IS NULL
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
                AND grouped.deleted_at IS NULL
            )
          )
          OR (
            t.dedup_scope = 'linked'
            AND (
              candidate.ticket_id = t.id
              OR EXISTS (
                SELECT 1
                FROM count_ticket_dedup_links l
                JOIN count_tickets linked
                  ON linked.id = l.linked_ticket_id
                 AND linked.user_id = l.user_id
                 AND linked.deleted_at IS NULL
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
       AND candidate.event_at >= COALESCE(t.cycle_started_at, '-infinity'::timestamptz)
      JOIN count_tickets candidate_ticket
        ON candidate_ticket.id = candidate.ticket_id
       AND candidate_ticket.user_id = candidate.user_id
       AND candidate.cycle_no = candidate_ticket.cycle_no
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

    DROP INDEX IF EXISTS count_tickets_live_user_idx;
    ALTER TABLE count_tickets DROP COLUMN IF EXISTS deleted_at;
  `)
}
