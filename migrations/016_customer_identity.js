/**
 * 统一客户身份系统 —— MVP 建表。
 *
 * 设计见 docs/统一客户身份系统-设计.md。这里只强调三条不能违反的原则：
 *
 * 1. **身份层与内容层物理分离**
 *    platform_identities / customers / customer_identities 是**平台级**的，
 *    不含任何聊天内容；conversations / messages 是**商户级**的，每张都带 user_id。
 *    这样"跨商户识别客户身份"与"商户之间不共享聊天内容"可以同时成立。
 *
 * 2. **内容表的 user_id 是隔离键，必须冗余**
 *    messages 明明能通过 conversation_id 推出 user_id，仍然单独存一列 ——
 *    目的是让"这条查询有没有做商户隔离"变成**可被静态检查**的事。
 *    配套测试会扫描所有内容查询，发现缺 user_id 条件就让测试失败。
 *
 * 3. **溯源字段永不改写**
 *    source_platform / source_account / source_conv_id / source_msg_id
 *    四列记录数据从哪来。合并客户只影响 customer_id，这四列在任何情况下都不动 ——
 *    否则合并之后就再也说不清一条消息的原始出处了。
 *
 * 另：identity_match_events 记录"系统为什么认为 A 和 B 是同一个人"。
 * 没有它，误合并无法追责，客户也没人能解释"我为什么被合并了"。
 */

exports.up = pgm => {
  pgm.sql(`
    -- ============================================================
    -- 一、身份层（平台级，跨商户共享，不含聊天内容）
    -- ============================================================

    -- 平台级身份指纹。存 HMAC 而非 SHA256：
    -- SHA256 的话，任何知道某个手机号的人都能自己算出哈希来撞库；
    -- HMAC 用平台密钥，外部无法构造查询。
    CREATE TABLE IF NOT EXISTS platform_identities (
      fingerprint    bytea PRIMARY KEY,
      identity_type  text NOT NULL,
      first_seen_at  timestamptz NOT NULL DEFAULT now(),
      last_seen_at   timestamptz NOT NULL DEFAULT now(),
      merchant_count integer NOT NULL DEFAULT 1 CHECK (merchant_count >= 1),
      touch_count    integer NOT NULL DEFAULT 1 CHECK (touch_count >= 1),
      CONSTRAINT platform_identities_type_check
        CHECK (identity_type IN ('phone', 'platform_uid', 'email', 'username'))
    );

    -- Customer ID。public_id 是对外展示的 C_100001，不暴露自增主键。
    CREATE TABLE IF NOT EXISTS customers (
      id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      public_id           text NOT NULL UNIQUE,
      primary_fingerprint bytea REFERENCES platform_identities(fingerprint) ON DELETE SET NULL,
      created_at          timestamptz NOT NULL DEFAULT now(),
      -- 误合并是**不可逆的数据污染**，所以合并后保留指向，可追溯、可回滚
      merged_into         bigint REFERENCES customers(id) ON DELETE SET NULL,
      merged_at           timestamptz,
      CONSTRAINT customers_not_self_merged CHECK (merged_into IS NULL OR merged_into <> id)
    );
    CREATE INDEX IF NOT EXISTS customers_merged_idx ON customers(merged_into) WHERE merged_into IS NOT NULL;

    -- 客户拥有的多个身份。
    -- PRIMARY KEY 落在 fingerprint 上：一个指纹**只能属于一个客户** ——
    -- 这是"合并"能成立的前提，也让重复关联在数据库层直接失败而不是靠代码判断。
    CREATE TABLE IF NOT EXISTS customer_identities (
      fingerprint  bytea PRIMARY KEY REFERENCES platform_identities(fingerprint) ON DELETE CASCADE,
      customer_id  bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      confidence   text NOT NULL DEFAULT 'high',
      linked_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT customer_identities_confidence_check
        CHECK (confidence IN ('high', 'medium', 'low'))
    );
    CREATE INDEX IF NOT EXISTS customer_identities_customer_idx ON customer_identities(customer_id);

    -- 客户 ↔ 商户。**这张表就是隔离边界**：
    -- 商户只能看到与自己有 link 的客户，看不到该客户在其他商户的存在。
    CREATE TABLE IF NOT EXISTS customer_merchant_links (
      customer_id   bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (customer_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS customer_merchant_links_user_idx ON customer_merchant_links(user_id, last_seen_at DESC);

    -- ============================================================
    -- 二、身份匹配事件（回答"为什么系统认为 A 和 B 是同一个人"）
    -- ============================================================

    CREATE TABLE IF NOT EXISTS identity_match_events (
      id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      -- 本次匹配涉及的指纹与最终归属
      fingerprint    bytea NOT NULL,
      customer_id    bigint REFERENCES customers(id) ON DELETE SET NULL,
      -- 哪条线索促成了匹配：phone | platform_uid | email | username | manual
      matched_by     text NOT NULL,
      confidence     text NOT NULL,
      -- 三分支结果：auto_linked（自动关联）/ candidate（疑似待确认）/ created（新建客户）
      outcome        text NOT NULL,
      -- 证据快照。存**规范化后的值**与来源，不存原始敏感串的明文。
      evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,
      -- 触发来源：哪个商户、哪个平台、哪个账号带来的这条线索
      source_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
      source_platform text NOT NULL DEFAULT '',
      source_account text NOT NULL DEFAULT '',
      created_at     timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT identity_match_events_outcome_check
        CHECK (outcome IN ('auto_linked', 'candidate', 'created')),
      CONSTRAINT identity_match_events_confidence_check
        CHECK (confidence IN ('high', 'medium', 'low')),
      CONSTRAINT identity_match_events_evidence_check
        CHECK (jsonb_typeof(evidence) = 'object')
    );
    CREATE INDEX IF NOT EXISTS identity_match_events_customer_idx
      ON identity_match_events(customer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS identity_match_events_fp_idx
      ON identity_match_events(fingerprint, created_at DESC);

    -- 疑似重复：**不自动合并**，等人工确认
    CREATE TABLE IF NOT EXISTS customer_merge_candidates (
      id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      customer_a   bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      customer_b   bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      reason       text NOT NULL,
      confidence   numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
      status       text NOT NULL DEFAULT 'pending',
      reviewed_by  bigint REFERENCES admins(id) ON DELETE SET NULL,
      reviewed_at  timestamptz,
      created_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT customer_merge_candidates_status_check
        CHECK (status IN ('pending', 'merged', 'rejected')),
      CONSTRAINT customer_merge_candidates_order_check CHECK (customer_a < customer_b),
      UNIQUE (customer_a, customer_b)
    );
    CREATE INDEX IF NOT EXISTS customer_merge_candidates_pending_idx
      ON customer_merge_candidates(created_at DESC) WHERE status = 'pending';

    -- ============================================================
    -- 三、内容层（商户隔离，每张表都带 user_id）
    -- ============================================================

    CREATE TABLE IF NOT EXISTS conversations (
      id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id         bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      customer_id     bigint REFERENCES customers(id) ON DELETE SET NULL,
      platform        text NOT NULL,
      account_key     text NOT NULL,
      peer_key        text NOT NULL,
      display_name    text NOT NULL DEFAULT '',
      last_message_at timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT conversations_account_check CHECK (length(btrim(account_key)) > 0),
      CONSTRAINT conversations_peer_check CHECK (length(btrim(peer_key)) > 0),
      UNIQUE (user_id, platform, account_key, peer_key)
    );
    CREATE INDEX IF NOT EXISTS conversations_customer_idx ON conversations(user_id, customer_id);
    CREATE INDEX IF NOT EXISTS conversations_recent_idx ON conversations(user_id, last_message_at DESC NULLS LAST);

    -- 消息表按 sent_at 分区：留存到期时 DROP 整个分区，
    -- 比 DELETE 快几个数量级，也不会因为一个大事务把库拖住。
    CREATE TABLE IF NOT EXISTS messages (
      id              bigint GENERATED ALWAYS AS IDENTITY,
      user_id         bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id bigint NOT NULL,
      customer_id     bigint REFERENCES customers(id) ON DELETE SET NULL,
      direction       text NOT NULL,
      sender_key      text NOT NULL DEFAULT '',
      body            text NOT NULL,
      body_translated text,
      lang_detected   text,
      operator_id     bigint REFERENCES sub_accounts(id) ON DELETE SET NULL,
      source_platform text NOT NULL,
      source_account  text NOT NULL,
      source_conv_id  text NOT NULL DEFAULT '',
      source_msg_id   text NOT NULL DEFAULT '',
      sent_at         timestamptz NOT NULL,
      ingested_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id, sent_at),
      CONSTRAINT messages_direction_check CHECK (direction IN ('in', 'out')),
      CONSTRAINT messages_body_check CHECK (length(body) > 0)
    ) PARTITION BY RANGE (sent_at);
    CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(conversation_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS messages_customer_idx ON messages(user_id, customer_id, sent_at DESC);
    -- 平台原始消息 ID 多数为空（DOM 抓取拿不到稳定 ID），
    -- 所以去重退化成"同会话 + 同发送方 + 同时间 + 同内容"，用这个唯一索引兜底。
    CREATE UNIQUE INDEX IF NOT EXISTS messages_dedup_idx
      ON messages(conversation_id, source_msg_id, sent_at, md5(body))
      WHERE source_msg_id <> '';

    -- 首月分区。后续按月自动建 —— 实现与调度都在 scripts/maintenance.js 的
    -- ensurePartitions()，由 hello-pix-maintenance.timer 每小时执行，
    -- 范围是「上个月 ~ 未来 AHEAD_MONTHS 个月」。
    CREATE TABLE IF NOT EXISTS messages_2026_09 PARTITION OF messages
      FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
    CREATE TABLE IF NOT EXISTS messages_2026_10 PARTITION OF messages
      FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

    -- ============================================================
    -- 四、归属与撞单
    -- ============================================================

    CREATE TABLE IF NOT EXISTS customer_owners (
      id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id          bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      customer_id      bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      employee_id      bigint REFERENCES sub_accounts(id) ON DELETE SET NULL,
      account_key      text NOT NULL DEFAULT '',
      status           text NOT NULL DEFAULT 'FOLLOWING',
      assigned_at      timestamptz NOT NULL DEFAULT now(),
      last_activity_at timestamptz NOT NULL DEFAULT now(),
      released_at      timestamptz,
      CONSTRAINT customer_owners_status_check
        CHECK (status IN ('UNASSIGNED', 'FOLLOWING', 'PAUSED', 'COMPLETED', 'LOST'))
    );
    -- **只有 FOLLOWING 参与撞单检测**：
    -- 张三已 COMPLETED 之后李四再联系，是正常复用，不该告警。
    CREATE UNIQUE INDEX IF NOT EXISTS customer_owners_active_uniq
      ON customer_owners(user_id, customer_id) WHERE status = 'FOLLOWING';
    CREATE INDEX IF NOT EXISTS customer_owners_employee_idx ON customer_owners(user_id, employee_id, last_activity_at DESC);

    CREATE TABLE IF NOT EXISTS collision_events (
      id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      customer_id          bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      kind                 text NOT NULL,
      existing_owner_id    bigint REFERENCES customer_owners(id) ON DELETE SET NULL,
      existing_user_id     bigint NOT NULL,
      existing_employee_id bigint REFERENCES sub_accounts(id) ON DELETE SET NULL,
      existing_account_key text NOT NULL DEFAULT '',
      new_user_id          bigint NOT NULL,
      new_employee_id      bigint REFERENCES sub_accounts(id) ON DELETE SET NULL,
      new_account_key      text NOT NULL DEFAULT '',
      detected_at          timestamptz NOT NULL DEFAULT now(),
      resolution           text NOT NULL DEFAULT 'pending',
      resolved_by          bigint REFERENCES admins(id) ON DELETE SET NULL,
      resolved_at          timestamptz,
      CONSTRAINT collision_events_kind_check
        CHECK (kind IN ('same_merchant', 'cross_merchant')),
      CONSTRAINT collision_events_resolution_check
        CHECK (resolution IN ('pending', 'kept_existing', 'transferred', 'both_continue', 'ignored'))
    );
    CREATE INDEX IF NOT EXISTS collision_events_customer_idx ON collision_events(customer_id, detected_at DESC);
    CREATE INDEX IF NOT EXISTS collision_events_pending_idx
      ON collision_events(detected_at DESC) WHERE resolution = 'pending';

    -- 撞单检测的开关。**跨商户默认关闭**：
    -- 技术上架构已支持，但商户没有书面同意前不得开启 ——
    -- 否则等于拿 A 商户的客户资源去提示 B 商户。
    INSERT INTO app_settings (key, value) VALUES
      ('customer.collision', '{"sameMerchant":true,"crossMerchant":false,"notifyMode":"warn","ownerIdleReleaseDays":30}'::jsonb),
      ('customer.message_retention_days', '180'::jsonb),
      ('customer.merge_auto_threshold', '0.95'::jsonb)
    ON CONFLICT (key) DO NOTHING;
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DELETE FROM app_settings WHERE key IN
      ('customer.collision', 'customer.message_retention_days', 'customer.merge_auto_threshold');

    DROP TABLE IF EXISTS collision_events;
    DROP TABLE IF EXISTS customer_owners;
    DROP TABLE IF EXISTS messages CASCADE;
    DROP TABLE IF EXISTS conversations;
    DROP TABLE IF EXISTS customer_merge_candidates;
    DROP TABLE IF EXISTS identity_match_events;
    DROP TABLE IF EXISTS customer_merchant_links;
    DROP TABLE IF EXISTS customer_identities;
    DROP TABLE IF EXISTS customers;
    DROP TABLE IF EXISTS platform_identities;
  `)
}
