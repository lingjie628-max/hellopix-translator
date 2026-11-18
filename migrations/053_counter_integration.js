/**
 * 进粉计数（嵌入 Hello Pix）。
 *
 * 与旧《WhatsApp进粉计数》最大的区别：
 *   · 不再有 CENTRAL_TOKEN / 邀请码，身份来自现有 user/sub_account 会话；
 *   · 不再用本机 SQLite 当权威，全局判重和工单都在 PostgreSQL；
 *   · 一个 WhatsApp 多开实例对应 counter_accounts 的一行；
 *   · counter_fan_events 是每一笔进粉事实，counter_tickets 与之一对一。
 *
 * “全局”默认限定在同一个 Hello Pix 主账号：同一主账号下不同设备、不同子账号
 * 共享判重；不同独立商户之间不共享进粉线索。
 */

exports.up = pgm => {
  pgm.sql(`
    CREATE TABLE counter_accounts (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      operator_id bigint REFERENCES sub_accounts(id) ON DELETE SET NULL,
      device_id varchar(255) NOT NULL,
      local_tab_id varchar(255) NOT NULL,
      platform varchar(64) NOT NULL,
      label varchar(120) NOT NULL DEFAULT '',
      enabled boolean NOT NULL DEFAULT true,
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      archived_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT counter_accounts_device_check CHECK (length(btrim(device_id)) > 0),
      CONSTRAINT counter_accounts_tab_check CHECK (length(btrim(local_tab_id)) > 0),
      UNIQUE (user_id, device_id, local_tab_id)
    )
  `)
  pgm.sql('CREATE INDEX counter_accounts_user_idx ON counter_accounts (user_id, archived_at, last_seen_at DESC)')

  pgm.sql(`
    CREATE TABLE counter_fan_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      counter_account_id bigint NOT NULL REFERENCES counter_accounts(id) ON DELETE RESTRICT,
      customer_id bigint NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      kind varchar(8) NOT NULL,
      source_message_id varchar(300) NOT NULL,
      peer_key varchar(300) NOT NULL DEFAULT '',
      phone_tail varchar(4),
      push_name varchar(120) NOT NULL DEFAULT '',
      message_type varchar(64) NOT NULL DEFAULT '',
      first_msg_at timestamptz NOT NULL,
      day date NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT counter_fan_events_kind_check CHECK (kind IN ('new', 'repeat')),
      UNIQUE (counter_account_id, customer_id),
      UNIQUE (counter_account_id, source_message_id)
    )
  `)
  pgm.sql('CREATE INDEX counter_fan_events_user_day_idx ON counter_fan_events (user_id, day DESC, id DESC)')
  pgm.sql('CREATE INDEX counter_fan_events_customer_idx ON counter_fan_events (customer_id, first_msg_at DESC)')
  pgm.sql('CREATE INDEX counter_fan_events_account_idx ON counter_fan_events (counter_account_id, first_msg_at DESC)')

  pgm.sql(`
    CREATE TABLE counter_tickets (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      code varchar(32) NOT NULL UNIQUE,
      user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      counter_account_id bigint NOT NULL REFERENCES counter_accounts(id) ON DELETE RESTRICT,
      customer_id bigint NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      fan_event_id bigint NOT NULL UNIQUE REFERENCES counter_fan_events(id) ON DELETE RESTRICT,
      title varchar(200) NOT NULL,
      status varchar(16) NOT NULL DEFAULT 'open',
      priority varchar(8) NOT NULL DEFAULT 'normal',
      assignee_id bigint REFERENCES sub_accounts(id) ON DELETE SET NULL,
      note text NOT NULL DEFAULT '',
      due_at timestamptz,
      resolve_due_at timestamptz,
      first_response_at timestamptz,
      resolved_at timestamptz,
      closed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT counter_tickets_status_check
        CHECK (status IN ('open', 'in_progress', 'pending', 'resolved', 'closed')),
      CONSTRAINT counter_tickets_priority_check
        CHECK (priority IN ('low', 'normal', 'high', 'urgent'))
    )
  `)
  pgm.sql('CREATE INDEX counter_tickets_user_status_idx ON counter_tickets (user_id, status, priority, created_at DESC)')
  pgm.sql('CREATE INDEX counter_tickets_assignee_idx ON counter_tickets (assignee_id, status)')

  pgm.sql(`
    CREATE TABLE counter_ticket_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      counter_ticket_id bigint NOT NULL REFERENCES counter_tickets(id) ON DELETE CASCADE,
      kind varchar(32) NOT NULL,
      author_kind varchar(16) NOT NULL DEFAULT 'system',
      author_id bigint,
      body text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT counter_ticket_events_author_check
        CHECK (author_kind IN ('system', 'main', 'sub', 'admin'))
    )
  `)
  pgm.sql('CREATE INDEX counter_ticket_events_ticket_idx ON counter_ticket_events (counter_ticket_id, id)')
}

exports.down = pgm => {
  pgm.sql('DROP TABLE IF EXISTS counter_ticket_events')
  pgm.sql('DROP TABLE IF EXISTS counter_tickets')
  pgm.sql('DROP TABLE IF EXISTS counter_fan_events')
  pgm.sql('DROP TABLE IF EXISTS counter_accounts')
}
