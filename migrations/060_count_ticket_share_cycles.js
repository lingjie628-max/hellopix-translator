'use strict'

/**
 * 计数工单结算闭环：周期归档 + 只读分享。
 *
 * 竞品的“重置”会清空新粉并归到底粉。这里不删除历史事件，而是给工单增加
 * cycle_no / cycle_started_at：
 *   - 重置时把当前工单出现过的客户写入商户底库；
 *   - 工单进入下一周期，统计和新粉判定只看当前周期；
 *   - 历史进粉永久保留，恢复旧代码即可重新看到，避免人工误点后数据蒸发。
 *
 * 分享只保存 token 的 SHA-256 和可选 scrypt 密码哈希。明文 token/密码只在
 * 创建或轮换时返回一次，不落日志、不进数据库。
 */

exports.up = pgm => {
  pgm.sql(`
    ALTER TABLE count_tickets
      ADD COLUMN IF NOT EXISTS cycle_no integer NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS cycle_started_at timestamptz,
      ADD COLUMN IF NOT EXISTS last_cycle_reset_at timestamptz;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'count_tickets_cycle_no_check'
      ) THEN
        ALTER TABLE count_tickets
          ADD CONSTRAINT count_tickets_cycle_no_check CHECK (cycle_no >= 1);
      END IF;
    END $$;

    ALTER TABLE count_ticket_fans
      ADD COLUMN IF NOT EXISTS cycle_no integer NOT NULL DEFAULT 1;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'count_ticket_fans_cycle_no_check'
      ) THEN
        ALTER TABLE count_ticket_fans
          ADD CONSTRAINT count_ticket_fans_cycle_no_check CHECK (cycle_no >= 1);
      END IF;
    END $$;

    -- 老数据的周期与工单当前周期一致。
    UPDATE count_ticket_fans f
    SET cycle_no = t.cycle_no
    FROM count_tickets t
    WHERE t.id = f.ticket_id
      AND f.cycle_no <> t.cycle_no;

    DROP INDEX IF EXISTS count_ticket_fans_conversation_uidx;
    CREATE UNIQUE INDEX IF NOT EXISTS count_ticket_fans_conversation_cycle_uidx
      ON count_ticket_fans(ticket_id, cycle_no, conversation_id)
      WHERE conversation_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS count_ticket_fans_ticket_cycle_event_idx
      ON count_ticket_fans(ticket_id, cycle_no, event_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS count_ticket_shares (
      id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      ticket_id           bigint NOT NULL,
      user_id             bigint NOT NULL,
      token_hash          char(64) NOT NULL,
      token_prefix        varchar(12) NOT NULL,
      password_hash       text,
      enabled             boolean NOT NULL DEFAULT true,
      expires_at          timestamptz,
      view_count          bigint NOT NULL DEFAULT 0,
      last_viewed_at      timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT count_ticket_shares_ticket_fk
        FOREIGN KEY (ticket_id, user_id)
        REFERENCES count_tickets(id, user_id) ON DELETE CASCADE,
      CONSTRAINT count_ticket_shares_token_hash_check
        CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT count_ticket_shares_password_hash_check
        CHECK (password_hash IS NULL OR password_hash ~ '^scrypt\\$[^$]+\\$[^$]+$'),
      CONSTRAINT count_ticket_shares_view_count_check CHECK (view_count >= 0),
      UNIQUE (ticket_id, user_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS count_ticket_shares_token_uidx
      ON count_ticket_shares(token_hash);
    CREATE INDEX IF NOT EXISTS count_ticket_shares_ticket_idx
      ON count_ticket_shares(ticket_id, user_id, enabled);

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
  `)
}

exports.down = pgm => {
  pgm.sql(`
    -- 周期重置没有删除历史事件；这里只撤新语义和分享表。
    --
    -- ★ count_ticket_fans.cycle_no 有意保留 ★
    -- 若已经产生第二周期事件，旧版 (ticket_id, conversation_id) 唯一索引
    -- 会与“同一会话跨周期重新计粉”直接冲突。删掉第二周期数据不可接受；
    -- 因此 down 保留该列与部分唯一索引，旧版应用新增行走默认 cycle_no=1，
    -- 幂等保护仍在。代价是回滚后数据库多一列不影响旧代码，但旧版统计会把
    -- 历史周期一起算进去；需要精确恢复旧口径时，必须使用升级前数据库快照。
    DROP TABLE IF EXISTS count_ticket_shares;

    DROP INDEX IF EXISTS count_ticket_fans_ticket_cycle_event_idx;
    DROP INDEX IF EXISTS count_ticket_fans_conversation_cycle_uidx;
    CREATE UNIQUE INDEX IF NOT EXISTS count_ticket_fans_conversation_uidx
      ON count_ticket_fans(ticket_id, conversation_id)
      WHERE conversation_id IS NOT NULL AND cycle_no = 1;

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

    ALTER TABLE count_tickets
      DROP CONSTRAINT IF EXISTS count_tickets_cycle_no_check,
      DROP COLUMN IF EXISTS last_cycle_reset_at,
      DROP COLUMN IF EXISTS cycle_started_at,
      DROP COLUMN IF EXISTS cycle_no;
  `)
}
