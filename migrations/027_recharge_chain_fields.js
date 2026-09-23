/**
 * 订单上的链上字段。
 *
 * ## 为什么必须快照进订单
 *
 * 之前订单只记 `payment_type = 'USDT-TRC20'`，**不记具体地址和合约**。
 * 管理员之后在后台改了收款地址，历史订单就再也回答不了
 * 「这单当时该转到哪个地址」—— 而这恰恰是自动审核的第一条校验
 * （"收款地址正确"）。地址是可变的配置，订单是历史事实，事实必须自带快照。
 *
 * ## 为什么代币合约也要存
 *
 * 链上叫 "USDT" 的仿盘合约有很多，转进来同样数量但一文不值。
 * 只比对金额和收款地址、不比对合约，等于给假币开了后门。
 *
 * ## 全部可空是有意的
 *
 *   - 旧代码 INSERT 不提供这些列（迁移先于代码上线）
 *   - 后台手工赠送（kind='manual'）本就没有链上来源
 *   - 未来的线下转账同样没有
 *
 * 所以不能用 NOT NULL；「新下的单必须有快照」由应用层保证 + 测试守着。
 */

exports.up = pgm => {
  pgm.sql(`
    ALTER TABLE recharges ADD COLUMN IF NOT EXISTS pay_address varchar(64);
    ALTER TABLE recharges ADD COLUMN IF NOT EXISTS pay_token_contract varchar(64);

    -- 链上交易信息。provider_transaction_id 已经存在（结算成功时写入），
    -- 这里补的是"看到但还没结算"的那部分事实。
    ALTER TABLE recharges ADD COLUMN IF NOT EXISTS chain_tx_id varchar(160);
    ALTER TABLE recharges ADD COLUMN IF NOT EXISTS chain_seen_at timestamptz;
    ALTER TABLE recharges ADD COLUMN IF NOT EXISTS chain_confirmations integer;
    ALTER TABLE recharges ADD COLUMN IF NOT EXISTS chain_block_number bigint;
    ALTER TABLE recharges ADD COLUMN IF NOT EXISTS chain_from_address varchar(64);
  `)

  // 链监听按 (收款地址, 合约, 金额) 找候选订单 —— 这正是金额预约表的三元组。
  // 这里给 recharges 侧也建一个同形的索引，便于直接按订单维度核对。
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS recharges_pay_lookup_idx
      ON recharges (pay_address, pay_token_contract, paid_amount)
      WHERE pay_address IS NOT NULL
  `)

  // 待支付且有快照的单，是链监听真正要扫的集合
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS recharges_pending_chain_idx
      ON recharges (pay_address, expires_at)
      WHERE status = 0 AND pay_address IS NOT NULL
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DROP INDEX IF EXISTS recharges_pending_chain_idx;
    DROP INDEX IF EXISTS recharges_pay_lookup_idx;
    ALTER TABLE recharges DROP COLUMN IF EXISTS chain_from_address;
    ALTER TABLE recharges DROP COLUMN IF EXISTS chain_block_number;
    ALTER TABLE recharges DROP COLUMN IF EXISTS chain_confirmations;
    ALTER TABLE recharges DROP COLUMN IF EXISTS chain_seen_at;
    ALTER TABLE recharges DROP COLUMN IF EXISTS chain_tx_id;
    ALTER TABLE recharges DROP COLUMN IF EXISTS pay_token_contract;
    ALTER TABLE recharges DROP COLUMN IF EXISTS pay_address;
  `)
}
