/**
 * 工单系统（商户 ←→ 客服）。
 *
 * ## 为什么现在加
 *
 * 此前商户遇到问题只能点「联系客服」跳到 Telegram：对话落在个人号里，
 * 换客服就断线，同一问题被重复问，处理结果没有任何记录。客服反馈里
 * 最多的一条需求就是「能不能在后台提工单」。这张表就是那条通道。
 *
 * ## 为什么是两张表，而不是一张表 + parent_id 自引用
 *
 * `tickets` 是**会话状态机**（谁来处理、什么状态、什么时候关的），
 * `ticket_messages` 是**消息流**（只追加，永不修改）。
 *
 * 混成一张表的自引用树有两个实际问题：
 *   1. 列表页要按状态/负责人筛选**会话**，每次都得「取根节点再回查全部回复」，
 *      筛条件一多就无法走索引；
 *   2. 消息是审计证据，会话是可变状态。同一行既要被 UPDATE（改状态）又要
 *      保证内容不可篡改，权限和心智负担都乱。
 *
 * 拆开后，`ticket_messages` 可以只给 INSERT，没有任何 UPDATE/DELETE 路径 ——
 * 这条规则比任何注释都可靠。
 *
 * ## 外键：为什么 user_id 不挂 ON DELETE CASCADE
 *
 * 商户账号被删后，工单是**我们处理过什么**的记录（和 deleted_merchants 同理），
 * 不该跟着消失。所以 user_id 允许为空、不挂外键，删除商户时由业务层把
 * user_id 置空并保留 username 快照 —— 与 client_crash_logs 的处理一致。
 *
 * ## 状态与时间戳的不变量
 *
 * `status` 用 CHECK 约束限死 5 个值；`resolved_at` / `closed_at` 由业务层
 * 在状态流转时写，**不依赖前端传**。不变量（例如「已解决必须有 resolved_at」）
 * 只能靠业务层保证 —— CHECK 表达不了跨列的业务语义，这里不装作能表达。
 */

exports.up = pgm => {
  pgm.sql(`
    CREATE TABLE tickets (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

      -- 商户侧：user_id 可空（账号已删除时保留工单），username 是提交时快照
      user_id bigint,
      username varchar(64) NOT NULL DEFAULT '',
      -- 提单人是主账号还是子账号（子账号没有独立余额，客服需要知道找谁核对）
      submitter_kind varchar(8) NOT NULL DEFAULT 'main',
      submitter_name varchar(64) NOT NULL DEFAULT '',

      subject varchar(200) NOT NULL,
      category varchar(16) NOT NULL DEFAULT 'other',
      priority varchar(8) NOT NULL DEFAULT 'medium',
      status varchar(16) NOT NULL DEFAULT 'new',

      -- 处理人：接单后就固定下来，避免多个客服同时回复
      assignee varchar(64) NOT NULL DEFAULT '',

      -- 提单时的上下文快照（客户端版本、套餐），客服不必再问一遍
      version varchar(32) NOT NULL DEFAULT '',
      package_code varchar(64) NOT NULL DEFAULT '',

      -- 未读标记：商户有新回复 → admin_unread；客服回复 → user_unread
      admin_unread boolean NOT NULL DEFAULT true,
      user_unread boolean NOT NULL DEFAULT false,

      last_reply_at timestamptz,
      resolved_at timestamptz,
      closed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT tickets_status_check CHECK (status IN ('new','in_progress','waiting_user','resolved','closed')),
      CONSTRAINT tickets_priority_check CHECK (priority IN ('low','medium','high','urgent')),
      CONSTRAINT tickets_category_check CHECK (category IN ('recharge','translation','login','bug','feature','other')),
      CONSTRAINT tickets_submitter_check CHECK (submitter_kind IN ('main','sub'))
    )
  `)

  pgm.sql(`
    CREATE TABLE ticket_messages (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      ticket_id bigint NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,

      -- author_type 决定谁能读、谁写的：客服 / 商户 / 系统事件
      author_type varchar(8) NOT NULL,
      author_name varchar(64) NOT NULL DEFAULT '',
      body text NOT NULL,

      -- 内部备注：商户端永远看不到（查询层按 author_type 过滤）
      internal boolean NOT NULL DEFAULT false,

      created_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT ticket_messages_author_check CHECK (author_type IN ('admin','user','system')),
      -- 内部备注只能是客服写的，系统事件也不该是内部的
      CONSTRAINT ticket_messages_internal_check CHECK (internal = false OR author_type = 'admin')
    )
  `)

  // 后台列表默认按状态 + 时间排序；部分索引让「未处理的」只扫一小段
  pgm.sql('CREATE INDEX tickets_status_idx ON tickets (status, last_reply_at DESC NULLS LAST, id DESC)')
  pgm.sql('CREATE INDEX tickets_user_idx ON tickets (user_id, id DESC)')
  pgm.sql('CREATE INDEX tickets_assignee_idx ON tickets (assignee) WHERE status IN (\'new\',\'in_progress\',\'waiting_user\')')
  // 消息流按票取，永远 asc
  pgm.sql('CREATE INDEX ticket_messages_ticket_idx ON ticket_messages (ticket_id, id)')
}

exports.down = pgm => {
  pgm.sql('DROP TABLE IF EXISTS ticket_messages')
  pgm.sql('DROP TABLE IF EXISTS tickets')
}
