/**
 * 链上事实的唯一标识改成**事件级**。
 *
 * ## 原设计的问题
 *
 * `chain_transactions` 建表时是 `tx_id UNIQUE`。这在"一笔交易只对应一个转账"
 * 的假设下没问题，但 TRC20 **允许一笔交易里出现多个 Transfer 事件**
 * （合约中转、批量转账、DEX 交互都会）。
 *
 * 用 `tx_id` 唯一会怎样：第二个事件插入时撞唯一约束 → 被 `ON CONFLICT DO NOTHING`
 * 静默丢掉。**钱到了，系统却什么都没记**，而且不报错。
 *
 * ## 改成什么
 *
 * ```
 *   UNIQUE (network, token_contract, tx_id, event_index)
 * ```
 *
 * 四个字段合起来才是"链上发生过的一次转账"的完整身份：
 *   - `network`          哪条链（将来接别的链不会撞）
 *   - `token_contract`   哪个代币合约
 *   - `tx_id`            哪笔交易
 *   - `event_index`      交易内的第几个事件（回执 `log[]` 的真实下标）
 *
 * ## event_index 为什么可空
 *
 * TronGrid 的账户接口不返回事件序号，得从交易回执的 `log[]` 里取下标。
 * 回执查不到时（限流、超时）**宁可为 NULL 也不能编一个**——
 * 编造序号会让两个不同的真实事件撞成同一个身份，比"暂时不知道"危险得多。
 *
 * 应用层遇到 `event_index IS NULL` 时跳过该条且不推进游标，下一轮重来。
 * 部分唯一索引 `WHERE event_index IS NOT NULL` 让这些待定行不参与去重，
 * 等补上真实序号后再落定。
 */

exports.up = pgm => {
  pgm.sql(`
    -- 1. 链标识。将来接 BSC / ETH 时不会与 TRON 的 tx_id 相撞
    ALTER TABLE chain_transactions
      ADD COLUMN IF NOT EXISTS network varchar(16) NOT NULL DEFAULT 'tron';

    -- 2. 事件位置。可空 —— 拿不到真实位置时留 NULL，不编序号
    ALTER TABLE chain_transactions
      ADD COLUMN IF NOT EXISTS event_index integer;
    ALTER TABLE chain_transactions
      ADD CONSTRAINT chain_transactions_event_index_check
        CHECK (event_index IS NULL OR event_index >= 0);

    -- 3. 把旧的 log_index 数据迁过来（原字段语义就是事件位置，
    --    只是之前写死为 0）。有真实数据的行保留，其余留 NULL 等重扫补。
    UPDATE chain_transactions
       SET event_index = log_index
     WHERE event_index IS NULL AND log_index IS NOT NULL AND log_index >= 0;

    ALTER TABLE chain_transactions DROP COLUMN IF EXISTS log_index;

    -- 4. 去掉 tx_id 单列唯一 —— 它正是"同一交易第二个事件被静默丢弃"的原因
    ALTER TABLE chain_transactions DROP CONSTRAINT IF EXISTS chain_transactions_tx_id_key;
    DROP INDEX IF EXISTS chain_transactions_tx_id_key;

    -- 5. 事件级唯一。部分索引：event_index 为 NULL 的行（位置待定）
    --    不参与去重，否则两笔都查不到回执的交易会互相挡住
    CREATE UNIQUE INDEX IF NOT EXISTS chain_transactions_event_uq
      ON chain_transactions (network, token_contract, tx_id, event_index)
      WHERE event_index IS NOT NULL;

    -- 6. 按 tx_id 反查仍然要快：结算层要判断"同一 TXID 是否已结算过别的订单"
    CREATE INDEX IF NOT EXISTS chain_transactions_tx_idx
      ON chain_transactions (network, tx_id);

    COMMENT ON COLUMN chain_transactions.event_index IS
      '交易回执 log[] 里的真实下标。NULL = 位置待定（回执未取到），应用层应跳过且不推进游标，绝不编造。';

    -- 7. 异常池同样改用事件级字段。
    --    一笔交易的两个 Transfer 事件若各自触发异常，需要能区分开；
    --    而 (tx_id, kind) 的去重仍然保留 —— 同一事件的同类异常只记一条。
    ALTER TABLE recharge_exceptions ADD COLUMN IF NOT EXISTS event_index integer;
    UPDATE recharge_exceptions SET event_index = log_index
     WHERE event_index IS NULL AND log_index IS NOT NULL AND log_index >= 0;
    ALTER TABLE recharge_exceptions DROP COLUMN IF EXISTS log_index;
    ALTER TABLE recharge_exceptions
      ADD CONSTRAINT recharge_exceptions_event_index_check
        CHECK (event_index IS NULL OR event_index >= 0);
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DROP INDEX IF EXISTS chain_transactions_tx_idx;
    DROP INDEX IF EXISTS chain_transactions_event_uq;
    ALTER TABLE chain_transactions ADD COLUMN IF NOT EXISTS log_index integer NOT NULL DEFAULT 0;
    UPDATE chain_transactions SET log_index = COALESCE(event_index, 0);
    ALTER TABLE chain_transactions DROP CONSTRAINT IF EXISTS chain_transactions_event_index_check;
    ALTER TABLE chain_transactions DROP COLUMN IF EXISTS event_index;
    ALTER TABLE chain_transactions DROP COLUMN IF EXISTS network;

    -- 回退会重新引入"同交易多事件被丢弃"的问题，所以先把重复的 tx_id 清掉，
    -- 否则加不上唯一约束
    DELETE FROM chain_transactions a USING chain_transactions b
     WHERE a.id > b.id AND a.tx_id = b.tx_id;
    ALTER TABLE chain_transactions ADD CONSTRAINT chain_transactions_tx_id_key UNIQUE (tx_id);
  `)
}
