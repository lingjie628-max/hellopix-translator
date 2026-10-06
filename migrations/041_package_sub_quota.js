/**
 * 套餐携带子账号额度（`packages.sub_quota`）。
 *
 * ## 起因：三个缺陷串成「子账号开不了」
 *
 * 生产上商户 `jiufa`（id=37）充了 35 USDT 的基础版后仍然开不了子账号，
 * 点「新建子账号」直接 409「子账号名额已满」。查下来是三个独立缺陷叠加：
 *
 *   1. **套餐根本没有子账号额度这个概念。** `packages` 只有 `port_limit`
 *      （设备/端口数），没有任何与子账号相关的列。所以"买套餐"永远不可能
 *      带来子账号名额 —— 这是本轮要修的根本问题。
 *   2. `users.sub_quota` 默认 0（见 `001_initial_schema.js:72`），而唯一能写它的
 *      是「新建商户」表单；编辑表单里连这个输入项都没有。于是**每一个自助注册
 *      的商户 sub_quota 都是 0**，`saveSub` 的 `count(0) >= 0` 必然成立。
 *   3. 企业账号没有任何「无限」旁路，但后台界面上写着
 *      「企业可无限开子账号」—— **文案与代码不符**（代码侧在本次一并修）。
 *
 * ## 为什么放在 packages 而不是 app_settings
 *
 * 额度是**套餐的卖点**，必须与 `included_chars` / `port_limit` 同源同时读出，
 * 否则结算发放时会出现"字符按新套餐、额度按旧配置"的错配。
 * 放成套餐列后，`repo.package()` 一条 SQL 就带回全部权益，无需二次查询。
 *
 * ## 三档怎么定
 *
 * 按套餐档位递增，且与字符量同向（1.5M / 2.5M / 6M 字符）：
 *
 *   基础版 basic     3 个
 *   高级版 advanced 10 个
 *   专业版 pro      30 个
 *
 * 数值刻意保守：子账号会真实占用机器名额与聊天号绑定，给多了没有回收机制。
 * 后台「套餐管理」已可编辑该列，需要调整不必再写迁移。
 *
 * 企业账号不受此额度限制（代码侧旁路），所以这一列对企业账号只是"降级回
 * 个人账号时的默认值"。
 *
 * ## 回填 users.sub_quota
 *
 * 只回填 `sub_quota = 0` 且有套餐的商户 —— 那正是被缺陷 2 冻住的存量人群。
 * 非 0 的一律不动：那是有人明确设过的值，覆盖掉等于擅自改他人配置。
 *
 * `down` 只把「恰好等于该套餐额度」的行还原成 0（与 037 同一套还原口径），
 * 有人后来手改成别的值就留给人家的版本。
 */

const QUOTA_BY_CODE = {
  basic: 3,
  advanced: 10,
  pro: 30
}

exports.up = async pgm => {
  await pgm.db.query(`
    ALTER TABLE packages
      ADD COLUMN IF NOT EXISTS sub_quota integer NOT NULL DEFAULT 0
  `)

  // 与 020 同一写法：约束**不加** duplicate 守卫。
  // 迁移只跑一次（node-pg-migrate 记账，且有 singleTransaction），
  // 原先写的 DO $$ ... EXCEPTION WHEN duplicate_object $$ 反而在
  // node-pg-migrate 8 下解析不了（把 $$ 块当成未闭合的函数体）。
  await pgm.db.query(`
    ALTER TABLE packages
      ADD CONSTRAINT packages_sub_quota_check CHECK (sub_quota >= 0)
  `)

  for (const [code, quota] of Object.entries(QUOTA_BY_CODE)) {
    await pgm.db.query(
      'UPDATE packages SET sub_quota = $2, updated_at = NOW() WHERE code = $1',
      [code, quota]
    )
  }

  // 存量商户：把被冻住的 0 补成套餐额度
  const backfilled = await pgm.db.query(`
    UPDATE users u
       SET sub_quota = p.sub_quota, updated_at = NOW()
      FROM packages p
     WHERE p.id = u.package_id
       AND u.sub_quota = 0
       AND p.sub_quota > 0
  `)
  console.log(`  041：套餐子账号额度已就位，回填商户 ${backfilled.rowCount} 个`)
}

exports.down = async pgm => {
  // 只把「恰好等于该套餐额度」的行还原成 0 —— 有人后来手改成别的值就留给人家的版本
  await pgm.db.query(`
    UPDATE users u
       SET sub_quota = 0, updated_at = NOW()
      FROM packages p
     WHERE p.id = u.package_id
       AND u.sub_quota = p.sub_quota
  `)
  await pgm.db.query('ALTER TABLE packages DROP CONSTRAINT IF EXISTS packages_sub_quota_check')
  await pgm.db.query('ALTER TABLE packages DROP COLUMN IF EXISTS sub_quota')
}
