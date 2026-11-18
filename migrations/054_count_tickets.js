/**
 * 原生计数工单。
 *
 * 这里不复用旧的 orders / order_details / order_fans：
 * 那三张表属于已经下线的外部计数器模型，生产数据为空，字段语义也无法
 * 表达“同一客户在本工单的另一条会话再次出现”这种事件。
 *
 * 数据关系：
 *   count_tickets
 *     └─ count_ticket_accounts  （一个工单绑定多个平台账号）
 *     └─ count_ticket_fans      （粉丝进粉事件账本，一条会话只记一次）
 *
 * 所有内容层表都冗余 user_id，并在数据库层用 (id, user_id) 复合外键锁死
 * 归属关系；路由仍然会显式校验 user_id，两层都不能省。
 */

exports.up = pgm => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS count_tickets (
      id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title        varchar(120) NOT NULL,
      status       text NOT NULL DEFAULT 'active',
      day_target   integer NOT NULL DEFAULT 0,
      total_target bigint NOT NULL DEFAULT 0,
      timezone     text NOT NULL DEFAULT 'Asia/Shanghai',
      zero_time    time NOT NULL DEFAULT '00:00:00',
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      closed_at    timestamptz,
      CONSTRAINT count_tickets_title_check CHECK (length(btrim(title)) BETWEEN 1 AND 120),
      CONSTRAINT count_tickets_status_check CHECK (status IN ('active', 'closed')),
      CONSTRAINT count_tickets_day_target_check CHECK (day_target >= 0),
      CONSTRAINT count_tickets_total_target_check CHECK (total_target >= 0),
      CONSTRAINT count_tickets_timezone_check CHECK (length(btrim(timezone)) > 0),
      UNIQUE (id, user_id)
    );
    CREATE INDEX IF NOT EXISTS count_tickets_user_created_idx
      ON count_tickets(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS count_tickets_active_idx
      ON count_tickets(user_id, updated_at DESC) WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS count_ticket_accounts (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      ticket_id   bigint NOT NULL,
      user_id     bigint NOT NULL,
      platform    text NOT NULL,
      account_key text NOT NULL,
      active      boolean NOT NULL DEFAULT true,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT count_ticket_accounts_ticket_fk
        FOREIGN KEY (ticket_id, user_id)
        REFERENCES count_tickets(id, user_id) ON DELETE CASCADE,
      CONSTRAINT count_ticket_accounts_platform_check
        CHECK (length(btrim(platform)) > 0),
      CONSTRAINT count_ticket_accounts_key_check
        CHECK (length(btrim(account_key)) > 0),
      UNIQUE (ticket_id, platform, account_key)
    );
    CREATE INDEX IF NOT EXISTS count_ticket_accounts_ticket_idx
      ON count_ticket_accounts(ticket_id, active, platform, account_key);
    -- 同一商户的同一个平台账号，同时只能挂在一个启用中的计数工单上。
    CREATE UNIQUE INDEX IF NOT EXISTS count_ticket_accounts_one_active_uidx
      ON count_ticket_accounts(user_id, platform, account_key)
      WHERE active = true;

    CREATE TABLE IF NOT EXISTS count_ticket_fans (
      id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      ticket_id       bigint NOT NULL,
      user_id         bigint NOT NULL,
      conversation_id bigint REFERENCES conversations(id) ON DELETE SET NULL,
      customer_id     bigint REFERENCES customers(id) ON DELETE SET NULL,
      platform        text NOT NULL,
      account_key     text NOT NULL,
      peer_key        text NOT NULL,
      display_name    text NOT NULL DEFAULT '',
      fan_type        text NOT NULL,
      repeat_of_id    bigint REFERENCES count_ticket_fans(id) ON DELETE SET NULL,
      event_at        timestamptz NOT NULL,
      day_key         date NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT count_ticket_fans_ticket_fk
        FOREIGN KEY (ticket_id, user_id)
        REFERENCES count_tickets(id, user_id) ON DELETE CASCADE,
      CONSTRAINT count_ticket_fans_type_check
        CHECK (fan_type IN ('new', 'repeat')),
      CONSTRAINT count_ticket_fans_platform_check
        CHECK (length(btrim(platform)) > 0),
      CONSTRAINT count_ticket_fans_account_check
        CHECK (length(btrim(account_key)) > 0),
      CONSTRAINT count_ticket_fans_peer_check
        CHECK (length(btrim(peer_key)) > 0)
    );
    -- 一条会话只能贡献一个粉丝事件；同一会话刷多少消息都不会重复计数。
    CREATE UNIQUE INDEX IF NOT EXISTS count_ticket_fans_conversation_uidx
      ON count_ticket_fans(ticket_id, conversation_id)
      WHERE conversation_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS count_ticket_fans_ticket_event_idx
      ON count_ticket_fans(ticket_id, event_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS count_ticket_fans_ticket_day_idx
      ON count_ticket_fans(ticket_id, day_key, fan_type);
    CREATE INDEX IF NOT EXISTS count_ticket_fans_customer_idx
      ON count_ticket_fans(customer_id, event_at, id)
      WHERE customer_id IS NOT NULL;
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DROP TABLE IF EXISTS count_ticket_fans;
    DROP TABLE IF EXISTS count_ticket_accounts;
    DROP TABLE IF EXISTS count_tickets;
  `)
}
