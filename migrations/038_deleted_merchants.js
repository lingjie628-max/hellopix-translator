/**
 * 已删除商户的**存档**。
 *
 * ## 为什么需要这张表
 *
 * 后台此前**没有删除商户的能力** —— `AdminUsers.vue` 只有 编辑 / 升企业 /
 * 踢下线 / 停用。要清掉测试账号只能直接改库，什么痕迹都不留。
 * 把「删除」做成正式功能时，立刻撞上两个由现有设计决定的硬约束：
 *
 *   1. `char_ledger.user_id` 是 `ON DELETE RESTRICT`，而总账是**追加写、
 *      不可改**的。所以"给某商户写一条反向流水、再删这个商户"是自相矛盾的 ——
 *      流水会跟着商户一起被删掉。**删除的审计痕迹不能放进 `char_ledger`。**
 *   2. `users.id` 被 7 张表以 RESTRICT 引用（orders / recharges /
 *      translate_logs / translation_reservations / character_transfers /
 *      char_ledger / translation_usage）。想删商户，就必然要把这些业务记录
 *      一起删掉 —— 不可逆。
 *
 * 结论：删除必须留一份**不挂外键**的存档。这张表故意**不引用 `users`**
 * （`user_id` 只是记下原 id 的普通 bigint）；一旦挂上外键，删商户就会顺手
 * 把存档也删掉，又回到同一个死循环。
 *
 * ## 存什么、不存什么
 *
 *   · 身份字段 username / nickname / email —— 便于事后按账号回溯
 *   · `removed`  各表删除条数（jsonb）—— "这次删掉了多少东西"的摘要
 *   · `snapshot` 完整快照（jsonb）：商户行 + 账目类小表
 *                （recharges / char_ledger / character_transfers / orders）的全部行
 *   · actor / ip / reason / created_at —— 谁、什么时候、因为什么删的
 *
 * **高流量表**（translate_logs / translation_reservations / translation_usage）
 * 只记条数、不存全量：它们是**用量记录**不是账，整表塞进 jsonb 会让存档
 * 无界增长，而审计价值很低。
 *
 * **`password_hash` 有意不入档**：存档里不该有口令材料。要恢复账号，
 * 必须由管理员重设密码，而不是把旧哈希捞回来。
 *
 * ## 与「回收字符」的分工
 *
 * 「删除商户」= 连人带账一起清掉，靠这张表留痕。
 * 「回收字符」= 人留着、只把余额归零，靠 `char_ledger` 的一条 `correction`
 * 流水留痕（见 `server/lib/merchant-purge.js`）。两者是**不同的动作**，
 * 因为"删账号"和"清余额"对账务的影响完全不同。
 */

exports.up = pgm => {
  pgm.sql(`
    CREATE TABLE deleted_merchants (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

      -- 故意**不设** REFERENCES users(id)。
      -- 这张表要在商户被删之后继续存在；挂外键会让"删商户"把存档一起删掉。
      user_id bigint NOT NULL,

      username varchar(64) NOT NULL,
      nickname varchar(120),
      email varchar(320),

      char_balance bigint NOT NULL DEFAULT 0,
      char_used bigint NOT NULL DEFAULT 0,

      -- 各表删除条数，如 {"recharges":5,"translate_logs":34}
      removed jsonb NOT NULL DEFAULT '{}'::jsonb,
      -- 完整快照（商户行已剔除 password_hash）
      snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,

      reason varchar(200) NOT NULL DEFAULT '',
      actor varchar(64) NOT NULL,
      ip inet,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  pgm.sql('CREATE INDEX deleted_merchants_username_idx ON deleted_merchants (username)')
  pgm.sql('CREATE INDEX deleted_merchants_created_idx ON deleted_merchants (created_at DESC)')
}

exports.down = pgm => {
  pgm.sql('DROP TABLE IF EXISTS deleted_merchants')
}
