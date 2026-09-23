/**
 * Shadow / Dry-run 模式所需字段。
 *
 * ## 为什么要有 shadow 模式
 *
 * 链监听一旦接上就能改余额，而"看得准"和"敢动钱"是两件事。
 * Shadow 模式下 ChainWatcher 会把真实链路完整走一遍：
 * 查链、标准化、落库、推进游标、匹配候选订单 —— **唯独不改余额、不改订单状态**，
 * 只记录"如果开启自动结算，本来会做什么"。
 *
 * 这样可以在真实链数据上验证匹配准确率，而不承担任何资金风险。
 * 先证明看得准，再允许动钱。
 *
 * ## 字段
 *
 * chain_transactions.mode          这笔交易是在哪种模式下被处理的
 * chain_transactions.match_kind    匹配结论：精确匹配 / 迟到款 / 无匹配 / 重复
 * chain_transactions.shadow_action shadow 模式下"本来会执行什么"的完整快照
 *
 * `match_kind` 单独存而不是塞进 raw：它是**业务结论**，
 * 需要能按它统计"昨天有多少笔没匹配上"，塞进 jsonb 就没法建索引查了。
 */

exports.up = pgm => {
  pgm.sql(`
    -- 1. 扫描游标改用时间戳（TronGrid 的 TRC20 接口只给 block_timestamp）
    ALTER TABLE chain_scan_cursor
      ADD COLUMN IF NOT EXISTS last_scanned_timestamp bigint NOT NULL DEFAULT 0;

    COMMENT ON COLUMN chain_scan_cursor.last_scanned_timestamp IS
      '已完整处理到的时间点（毫秒）。与 chain_transactions 的写入在同一事务里推进，避免丢单。';
    COMMENT ON COLUMN chain_scan_cursor.last_scanned_block IS
      '最近一次看到的最终确认块高度，仅用于留档与展示，不参与游标判断。';

    -- 2. 交易的处理模式
    ALTER TABLE chain_transactions
      ADD COLUMN IF NOT EXISTS mode varchar(8) NOT NULL DEFAULT 'shadow';
    ALTER TABLE chain_transactions
      ADD CONSTRAINT chain_transactions_mode_check CHECK (mode IN ('shadow', 'live'));

    -- 3. 匹配结论
    ALTER TABLE chain_transactions ADD COLUMN IF NOT EXISTS match_kind varchar(20);
    ALTER TABLE chain_transactions
      ADD CONSTRAINT chain_transactions_match_kind_check
        CHECK (match_kind IS NULL OR match_kind IN
          ('MATCHED', 'LATE_PAYMENT', 'NO_MATCH', 'DUPLICATE_TX', 'NOT_ELIGIBLE'));

    -- 4. shadow 模式下"本来会做什么"
    ALTER TABLE chain_transactions ADD COLUMN IF NOT EXISTS shadow_action jsonb;

    -- 5. 匹配结论的统计与排查入口
    CREATE INDEX IF NOT EXISTS chain_transactions_match_kind_idx
      ON chain_transactions (match_kind, block_timestamp DESC)
      WHERE match_kind IS NOT NULL;
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DROP INDEX IF EXISTS chain_transactions_match_kind_idx;
    ALTER TABLE chain_transactions DROP CONSTRAINT IF EXISTS chain_transactions_match_kind_check;
    ALTER TABLE chain_transactions DROP COLUMN IF EXISTS shadow_action;
    ALTER TABLE chain_transactions DROP COLUMN IF EXISTS match_kind;
    ALTER TABLE chain_transactions DROP CONSTRAINT IF EXISTS chain_transactions_mode_check;
    ALTER TABLE chain_transactions DROP COLUMN IF EXISTS mode;
    ALTER TABLE chain_scan_cursor DROP COLUMN IF EXISTS last_scanned_timestamp;
  `)
}
