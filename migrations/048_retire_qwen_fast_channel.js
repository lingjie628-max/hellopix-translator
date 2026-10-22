/**
 * 关闭 qwen 快通道，目录回到 v5 = {gpt, deepseek}（2026-10-21）。
 *
 * ## 为什么又要关掉
 *
 * 047 加 qwen 是为了解决**翻译慢**，前提是"短句走专用 MT 模型"这条混合路由
 * 能把延迟压到 200~400ms。实际推进时用户决定**不引入新的翻译接口**，
 * 要求"在现有 gpt / deepseek 上把事情做快"。
 *
 * 于是 qwen 变成了纯隐患：
 *
 *   · 它挂在 advanced / pro 的套餐里，`wired=false` —— 客户端会把它显示成一个
 *     可选通道，用户点下去却用不了；
 *   · 一旦有人在后台填了 DashScope Key 并保存，`wired` 会自动变 true，
 *     混合路由会立刻开始把短句导向它 —— 而这条链路**从未经过真机验收**；
 *   · 047 还把 `package_catalog_version` 推到了 4，v4 快照里钉着 qwen。
 *     只删活表不够，存量商户钉住的快照仍会把 qwen 算进去。
 *
 * 所以这里的动作是「**撤回 047 的全部可见影响**」，而不是只改一个 enabled：
 *
 *   1. `engines` 行保留（历史日志可能引用，删了就对不上账），只把
 *      `enabled` / `wired` 置 false 且**不设 retired_at** —— 它没有"卖过"，
 *      谈不上下架，只是没上线；
 *   2. 从 `package_engines` 移出 —— 客户端不再把它列进套餐；
 *   3. 建 **v5 快照**（不含 qwen）并推进 `catalog_version=5`。
 *      v4 保留不动：已经钉在 v4 的商户看到的仍是他们当初买到的东西，
 *      不会被这次撤回落级；
 *   4. 把钉住的用户释放回在售版本，让客户端下次拉目录时拿到 v5。
 *
 * ## 为什么不直接删 047
 *
 * 迁移一旦在线上跑过就有记录（`pgmigrations`）。删文件会让"文件列表"与
 * "执行记录"对不上。正确做法是**追加一条反向迁移**，让历史保持可追溯 ——
 * 这也是这个仓库一贯的规矩（见 039 / 044）。
 */

exports.up = async pgm => {
  // 1) 停用渠道。不设 retired_at：它从未上线，不是"下架"。
  await pgm.db.query(
    `UPDATE engines SET enabled = false, wired = false
     WHERE id = 'qwen'`
  )

  // 2) 移出套餐活表。历史日志引用的是 engines.id，删 package_engines 不影响对账。
  await pgm.db.query(
    `DELETE FROM package_engines WHERE engine_id = 'qwen'`
  )

  // 3) 建 v5 快照 = 撤掉 qwen 之后的活表。
  await pgm.db.query(
    `INSERT INTO package_engine_versions (package_id, version, engine_id)
     SELECT pe.package_id, 5, pe.engine_id
     FROM package_engines pe
     WHERE pe.package_id IN (SELECT id FROM packages WHERE code IN ('basic', 'advanced', 'pro'))
     ON CONFLICT (package_id, version, engine_id) DO NOTHING`
  )

  await pgm.db.query(
    `UPDATE packages SET catalog_version = 5, updated_at = NOW()
     WHERE code IN ('basic', 'advanced', 'pro')`
  )

  // 4) 释放存量商户 —— 让他们下次拉目录时看到 v5。
  //
  // 与 047 第 3 步同一判据：钉住的快照里只要有通道**已不可用**就释放。
  // 这里 qwen 虽然没设 retired_at，但 enabled=false 同样意味着"用不了"，
  // 所以判据要看 enabled。
  await pgm.db.query(
    `UPDATE users u SET package_catalog_version = NULL, updated_at = NOW()
     WHERE u.package_catalog_version IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM package_engine_versions v
         JOIN engines e ON e.id = v.engine_id
         WHERE v.package_id = u.package_id
           AND v.version = u.package_catalog_version
           AND (e.retired_at IS NOT NULL OR e.enabled = false)
       )`
  )
}

/**
 * 回滚：把 qwen 放回 advanced / pro，目录退回 v4。
 *
 * 仅用于"又想启用快通道"的场景。注意 v4 快照仍然存在（047 建的），
 * 所以回滚不需要重建 v4，只要把活表恢复回去。
 */
exports.down = async pgm => {
  await pgm.db.query(
    `UPDATE engines SET enabled = true, wired = false WHERE id = 'qwen'`
  )
  await pgm.db.query(
    `INSERT INTO package_engines (package_id, engine_id)
     SELECT p.id, 'qwen' FROM packages p WHERE p.code IN ('advanced', 'pro')
     ON CONFLICT DO NOTHING`
  )
  await pgm.db.query(
    `UPDATE packages SET catalog_version = 4, updated_at = NOW()
     WHERE code IN ('basic', 'advanced', 'pro')`
  )
}
