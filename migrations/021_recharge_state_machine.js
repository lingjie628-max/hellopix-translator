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
 * 已过期的订单也不会被「复活」—— 过期后收到的钱走异常池。
 *
 * ## 迁移期间不能把旧代码打死
 *
 * 这次迁移先于应用代码上线。那段时间里跑的还是旧版代码，它：
 *   - INSERT 时**不提供** `expires_at`  → 靠 DEFAULT 兜住
 *   - UPDATE 状态时**不写** `terminal_at` → 靠触发器兜住
 *
 * 少任何一个，都会出现「migration 成功但下单/确认收款全线报错」的
 * 半迁移状态 —— 这正是要避免的。
 */

exports.up = pgm => {
  pgm.sql(`
    -- 1. 打开状态空间：加入 exception(4)
    ALTER TABLE recharges DROP CONSTRAINT IF EXISTS recharges_status_check;
    ALTER TABLE recharges
      ADD CONSTRAINT recharges_status_check
        CHECK (status = ANY (ARRAY[0, 1, 2, 3, 4]));

    -- 2. 有效期。先可空、回填、再收紧为 NOT NULL。
    --    DEFAULT 是给旧代码用的：它 INSERT 时不带这一列。
    ALTER TABLE recharges ADD COLUMN IF NOT EXISTS expires_at timestamptz;
    UPDATE recharges SET expires_at = created_at + interval '30 minutes'
     WHERE expires_at IS NULL;
    ALTER TABLE recharges
      ALTER COLUMN expires_at SET DEFAULT (now() + interval '30 minutes');
    ALTER TABLE recharges ALTER COLUMN expires_at SET NOT NULL;

    -- 3. 终态时间与原因
    ALTER TABLE recharges ADD COLUMN IF NOT EXISTS terminal_at timestamptz;
    ALTER TABLE recharges ADD COLUMN IF NOT EXISTS terminal_reason varchar(32);

    -- 4. 状态与终态时间必须一致
    ALTER TABLE recharges
      ADD CONSTRAINT recharges_terminal_consistency_check
        CHECK ((status = 0 AND terminal_at IS NULL) OR (status <> 0 AND terminal_at IS NOT NULL));
    ALTER TABLE recharges
      ADD CONSTRAINT recharges_expires_after_created_check
        CHECK (expires_at > created_at);

    -- 5. 过期扫描用
    CREATE INDEX IF NOT EXISTS recharges_pending_expiry_idx
      ON recharges (expires_at) WHERE status = 0;
  `)

  // 6. 让「终态时间」由数据库自己保证，而不是指望每个调用方都记得写。
  //
  //    约束要求「非 pending 一定有 terminal_at」，而旧版
  //    `/admin/recharges/status` 只写 `status=1, paid_at=NOW()`，会被直接拒绝。
  //    加了触发器后：任何调用方（旧代码、新代码、以后的入口、手工 SQL）
  //    改状态时都会自动补上终态时间，「忘了写终态字段」这整类 bug 从根上消失。
  //    约束保留作第二道防线。
  pgm.sql(`
    CREATE OR REPLACE FUNCTION recharges_stamp_terminal() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.status <> 0 THEN
        IF NEW.terminal_at IS NULL THEN
          NEW.terminal_at := now();
        END IF;
        IF NEW.terminal_reason IS NULL THEN
          NEW.terminal_reason := 'auto';
        END IF;
      ELSE
        NEW.terminal_at := NULL;
        NEW.terminal_reason := NULL;
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql;
  `)
  pgm.sql('DROP TRIGGER IF EXISTS recharges_stamp_terminal_trg ON recharges;')
  pgm.sql(`
    CREATE TRIGGER recharges_stamp_terminal_trg
      BEFORE INSERT OR UPDATE ON recharges
      FOR EACH ROW EXECUTE FUNCTION recharges_stamp_terminal();
  `)

  // 7. 存量行补上终态字段（触发器只作用于此后写入的行）
  pgm.sql(`
    UPDATE recharges
       SET terminal_at = COALESCE(paid_at, updated_at, created_at),
           terminal_reason = COALESCE(terminal_reason, 'legacy_backfill')
     WHERE status <> 0 AND terminal_at IS NULL;
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DO $guard$
    BEGIN
      IF EXISTS (SELECT 1 FROM recharges WHERE status = 4) THEN
        RAISE EXCEPTION '有异常订单(status=4)，回退前请先人工处理（落到 paid 或 cancelled）';
      END IF;
    END
    $guard$;

    DROP TRIGGER IF EXISTS recharges_stamp_terminal_trg ON recharges;
    DROP FUNCTION IF EXISTS recharges_stamp_terminal();
    DROP INDEX IF EXISTS recharges_pending_expiry_idx;
    ALTER TABLE recharges DROP CONSTRAINT IF EXISTS recharges_expires_after_created_check;
    ALTER TABLE recharges DROP CONSTRAINT IF EXISTS recharges_terminal_consistency_check;
    ALTER TABLE recharges DROP COLUMN IF EXISTS terminal_reason;
    ALTER TABLE recharges DROP COLUMN IF EXISTS terminal_at;
    ALTER TABLE recharges DROP COLUMN IF EXISTS expires_at;
    ALTER TABLE recharges DROP CONSTRAINT IF EXISTS recharges_status_check;
    ALTER TABLE recharges
      ADD CONSTRAINT recharges_status_check CHECK (status = ANY (ARRAY[0, 1, 2, 3]));
  `)
}
