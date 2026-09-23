/**
 * 链上交易留档。
 *
 * ## 为什么要在 recharges 之外单独存
 *
 * `recharges.provider_transaction_id` 只在**结算成功**时才写入。
 * 但链上看到的绝大多数东西是**没有归属**的：别人转错了、金额对不上、
 * 代币不对、或者是一笔我们根本不认识的转账。
 * 这些如果只存在日志里，出问题时无法复查 —— 而资金问题恰恰必须能复查。
 *
 * 所以：**链上看到什么就记什么**，归属是后续才补上的字段。
 *
 * ## tx_id 唯一
 *
 * 一笔链上交易就是一条不可变事实。补扫会反复看到同一笔，
 * 靠 `tx_id UNIQUE` 去重 —— 插入冲突即代表"这笔已经见过"，
 * 这正是**重复扫描不重复入账**的底座。
 *
 * 注意不用 `(tx_id, log_index)`：一笔交易里若出现两条都指向我们地址的
 * TRC20 Transfer 事件，那属于需要人看一眼的异常，不该悄悄当两笔处理。
 * 用 tx_id 唯一会让第二条撞冲突、进而进异常池，这是更安全的默认。
 *
 * ## 与 recharges 的关系
 *
 * `chain_transactions.recharge_id` 在结算成功后回填。
 * 一张订单只可能对应一笔链上交易（`recharges_provider_tx_uidx` 保证），
 * 一笔链上交易也只可能结算一张订单。
 */

exports.up = async pgm => {
  await pgm.db.query(`
    CREATE TABLE chain_transactions (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

      tx_id varchar(160) NOT NULL UNIQUE,
      log_index integer NOT NULL DEFAULT 0,

      token_contract varchar(64) NOT NULL,
      from_address varchar(64) NOT NULL,
      to_address varchar(64) NOT NULL,
      amount_milli bigint NOT NULL CHECK (amount_milli > 0),

      block_number bigint NOT NULL,
      block_timestamp timestamptz NOT NULL,
      confirmations integer NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
      -- TRON 的最终性标记：solidified 之后才算不可回滚
      solidified boolean NOT NULL DEFAULT false,

      status varchar(16) NOT NULL DEFAULT 'seen'
        CHECK (status IN ('seen', 'settled', 'exception', 'ignored')),

      recharge_id bigint REFERENCES recharges(id) ON DELETE SET NULL,

      -- 原始应答整段留档：解码逻辑出错时这是唯一的真相来源
      raw jsonb NOT NULL DEFAULT '{}'::jsonb,

      seen_at timestamptz NOT NULL DEFAULT now(),
      settled_at timestamptz,

      CONSTRAINT chain_transactions_settled_check
        CHECK ((status = 'settled' AND settled_at IS NOT NULL AND recharge_id IS NOT NULL)
            OR (status <> 'settled'))
    )
  `)

  // 按收款地址 + 区块回看（补扫、对账）
  await pgm.db.query(`
    CREATE INDEX chain_transactions_to_block_idx
      ON chain_transactions (to_address, block_number DESC)
  `)

  await pgm.db.query(`
    CREATE INDEX chain_transactions_status_idx
      ON chain_transactions (status, seen_at DESC)
  `)
}

exports.down = async pgm => {
  await pgm.db.query('DROP TABLE IF EXISTS chain_transactions')
}
