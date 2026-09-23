/**
 * 充值订单状态机。
 *
 * ## 现状的问题
 *
 * 原定义是 `CHECK (status IN (0, 1, 2, 3))`，但全库只有 0 和 1 被真正使用 ——
 * 2 和 3 是在 CHECK 里声明了却从未写入或读取的**死状态**，
 * 而「过期」「取消」这两个真实需要的状态反而不存在。
 *
 * 更关键的是**没有过期时间**。RC-02 要求「交易时间与订单有效期匹配」，
 * 但表里只有 created_at，没有任何一列能回答「这单什么时候该失效」。
 * 旧代码只能用一个写死的 `created_at > now() - interval '7 days'` 近似，
 * 那既不是有效期，也和尾数分配无关。
 *
 * ## 目标状态机
 *
 * ```
 *   pending(0) ──入账成功──→ paid(1)        终态
 *       │
 *       ├────30 分钟未付──→ expired(2)      终态
 *       ├────用户/超管取消─→ cancelled(3)    终态
 *       └────无法自动判定──→ exception(4) ──人工──→ paid(1)
 *                                        └──────→ cancelled(3)
 * ```
 *
 * 1 / 2 / 3 是**不可逆终态**：一笔已入账的订单不会被改回未支付，
 * 已过期的订单也不会被「复活」—— 过期后收到的钱走异常池，
 * 而不是把历史改写成没发生过。
 *
 * ## 为什么异常不是终态
 *
 * 异常是「需要人看一眼」的中间态，最终一定要落到 paid 或 cancelled，
 * 否则钱和字符的归属永远悬着。所以 4 有两个出口。
 *
 * ## 迟到款不改写历史
 *
 * 终态订单（paid/expired/cancelled）之后又收到匹配金额时，
 * **订单状态不变**，只往 recharge_exceptions 写一条记录。
 * 把一个 expired 订单改成 exception 会抹掉「它曾经过期」这个事实，
 * 对账时反而说不清。
 */

exports.up = async pgm => {
  // 1. 打开状态空间：加入 exception(4)
  await pgm.db.query('ALTER TABLE recharges DROP CONSTRAINT IF EXISTS recharges_status_check')
  await pgm.db.query(`
    ALTER TABLE recharges
      ADD CONSTRAINT recharges_status_check
        CHECK (status = ANY (ARRAY[0, 1, 2, 3, 4]))
  `)

  // 2. 有效期。先可空、回填、再收紧为 NOT NULL ——
  //    直接加 NOT NULL 会在有存量行时失败
  await pgm.db.query('ALTER TABLE recharges ADD COLUMN IF NOT EXISTS expires_at timestamptz')
  await pgm.db.query(`
    UPDATE recharges SET expires_at = created_at + interval '30 minutes'
     WHERE expires_at IS NULL
  `)
  await pgm.db.query('ALTER TABLE recharges ALTER COLUMN expires_at SET NOT NULL')

  // 3. 终态时间与原因：事后追查「这单什么时候因为什么结束的」
  await pgm.db.query('ALTER TABLE recharges ADD COLUMN IF NOT EXISTS terminal_at timestamptz')
  await pgm.db.query('ALTER TABLE recharges ADD COLUMN IF NOT EXISTS terminal_reason varchar(32)')
  await pgm.db.query(`
    UPDATE recharges
       SET terminal_at = COALESCE(paid_at, updated_at, created_at),
           terminal_reason = COALESCE(terminal_reason, 'legacy_backfill')
     WHERE status <> 0 AND terminal_at IS NULL
  `)

  // 4. 状态与终态时间必须一致：
  //    pending 一定没有终态时间；非 pending 一定有。
  //    这条约束能挡住「状态改了但忘了写终态时间」这类半截更新。
  await pgm.db.query(`
    ALTER TABLE recharges
      ADD CONSTRAINT recharges_terminal_consistency_check
        CHECK ((status = 0 AND terminal_at IS NULL) OR (status <> 0 AND terminal_at IS NOT NULL))
  `)
  await pgm.db.query(`
    ALTER TABLE recharges
      ADD CONSTRAINT recharges_expires_after_created_check
        CHECK (expires_at > created_at)
  `)

  // 5. 过期扫描用：只索引待支付订单，表大时也不会拖慢写入
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS recharges_pending_expiry_idx
      ON recharges (expires_at)
      WHERE status = 0
  `)
}

exports.down = async pgm => {
  // 有 exception(4) 的行时不能回退 —— 旧 CHECK 只认 0..3，
  // 这些行会让约束加不上去。先人工处理。
  const { rows } = await pgm.db.query('SELECT count(*)::int AS n FROM recharges WHERE status = 4')
  if (rows[0].n > 0) {
    throw new Error(`有 ${rows[0].n} 条异常订单，回退前请先人工处理（落到 paid 或 cancelled）`)
  }

  await pgm.db.query('DROP INDEX IF EXISTS recharges_pending_expiry_idx')
  await pgm.db.query('ALTER TABLE recharges DROP CONSTRAINT IF EXISTS recharges_expires_after_created_check')
  await pgm.db.query('ALTER TABLE recharges DROP CONSTRAINT IF EXISTS recharges_terminal_consistency_check')
  await pgm.db.query('ALTER TABLE recharges DROP COLUMN IF EXISTS terminal_reason')
  await pgm.db.query('ALTER TABLE recharges DROP COLUMN IF EXISTS terminal_at')
  await pgm.db.query('ALTER TABLE recharges DROP COLUMN IF EXISTS expires_at')
  await pgm.db.query('ALTER TABLE recharges DROP CONSTRAINT IF EXISTS recharges_status_check')
  await pgm.db.query(`
    ALTER TABLE recharges
      ADD CONSTRAINT recharges_status_check CHECK (status = ANY (ARRAY[0, 1, 2, 3]))
  `)
}
