/**
 * 子账号删除（2026-10-21）。
 *
 * ## 为什么不能物理删
 *
 * `sub_accounts` 被三四张**账本表**以 `ON DELETE RESTRICT` 指着：
 *
 *   · `translate_logs.sub_account_id`（复合外键 `(user_id, sub_account_id)`）
 *   · `translation_usage.sub_account_id`
 *   · `translation_reservations.sub_account_id`
 *
 * 线上实测：19 个子账号里有 18 个带余额（合计 109 万字符），
 * 子账号翻译账本近 3 万行。物理删 = 把这些行一起抹掉 —— 月度对账直接断链，
 * 而且"这 10 万字符去哪了"永远查不出来。
 *
 * 所以走**软删除**：行留着，账本留着，只在业务侧当作不存在。
 *
 * ## 三个必须同时解决的约束
 *
 * 1. **名额**：`saveSub` 用 `count(*) FROM sub_accounts WHERE parent_id=$1`
 *    判名额。软删除后行还在，每个已删子账号会永久占用一个名额 ——
 *    商户删得越多越开不出新的。业务层所有活跃计数都加了 `deleted_at IS NULL`。
 *
 * 2. **用户名/邮箱唯一**：`sub_accounts_username_lower_uidx` 是**全局唯一**
 *    （不限商户）。软删除后名字仍被占着，商户想把 "张三" 的账号删了重开同名
 *    会直接撞唯一键。唯一索引必须改成 `WHERE deleted_at IS NULL` 的部分索引。
 *
 * 3. **余额回归**：子账号余额本来就是从主账号划过来的，删掉它必须把这部分
 *    字符退回主账号，并写一条 `character_transfers`（负向），否则主账号凭空
 *    少一笔字符、无处可查。退回动作在业务层 `deleteSub` 里做，本迁移只建列。
 *
 * ## 写法说明
 *
 * 用 `pgm.db.query` 而不是 `pgm.sql`：索引名要拼成变量，且 `DROP INDEX IF EXISTS`
 * 需要逐条执行。迁移整体跑在 singleTransaction 里，失败会整体回滚。
 */

exports.up = async pgm => {
  await pgm.db.query(
    `ALTER TABLE sub_accounts
       ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
       ADD COLUMN IF NOT EXISTS deleted_by text`
  )

  // 唯一索引改成"只约束存活行"。
  // 注意 `lower(username)` 在部分索引里可用，行为与原索引一致，只是放开了已删除行。
  await pgm.db.query('DROP INDEX IF EXISTS sub_accounts_username_lower_uidx')
  await pgm.db.query(
    `CREATE UNIQUE INDEX sub_accounts_username_lower_alive_uidx
       ON sub_accounts (lower(username))
       WHERE deleted_at IS NULL`
  )

  await pgm.db.query('DROP INDEX IF EXISTS sub_accounts_email_lower_uidx')
  await pgm.db.query(
    `CREATE UNIQUE INDEX sub_accounts_email_lower_alive_uidx
       ON sub_accounts (lower(email))
       WHERE deleted_at IS NULL AND email IS NOT NULL`
  )

  // 列表/计数都按 `parent_id + deleted_at IS NULL` 走，补一个匹配的索引。
  await pgm.db.query(
    `CREATE INDEX sub_accounts_parent_alive_idx
       ON sub_accounts (parent_id)
       WHERE deleted_at IS NULL`
  )

  // 登录/状态切换按 `parent_id, status` 查，同样带存活谓词。
  await pgm.db.query(
    `CREATE INDEX sub_accounts_parent_status_alive_idx
       ON sub_accounts (parent_id, status)
       WHERE deleted_at IS NULL`
  )
}

/**
 * 回滚：删列 + 恢复原索引。
 *
 * 注意：若已经存在"同名重建"的子账号（旧行软删、新行复用同名），
 * 恢复全局唯一索引会失败 —— 这是**数据事实**，不该被迁移悄悄绕过去。
 * 回滚前应先处理这批重复行。
 */
exports.down = async pgm => {
  await pgm.db.query('DROP INDEX IF EXISTS sub_accounts_parent_alive_idx')
  await pgm.db.query('DROP INDEX IF EXISTS sub_accounts_parent_status_alive_idx')
  await pgm.db.query('DROP INDEX IF EXISTS sub_accounts_email_lower_alive_uidx')
  await pgm.db.query('DROP INDEX IF EXISTS sub_accounts_username_lower_alive_uidx')

  await pgm.db.query(
    'CREATE UNIQUE INDEX sub_accounts_username_lower_uidx ON sub_accounts (lower(username))'
  )
  await pgm.db.query(
    'CREATE UNIQUE INDEX sub_accounts_email_lower_uidx ON sub_accounts (lower(email)) WHERE email IS NOT NULL'
  )

  await pgm.db.query('ALTER TABLE sub_accounts DROP COLUMN IF EXISTS deleted_by')
  await pgm.db.query('ALTER TABLE sub_accounts DROP COLUMN IF EXISTS deleted_at')
}
