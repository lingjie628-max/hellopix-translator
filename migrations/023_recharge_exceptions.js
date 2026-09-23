/**
 * 异常充值池。
 *
 * RC-02 的硬规则：**凡是无法 100% 确定归属的到账，一律不入账**，
 * 全部落到这张表等人工处理。宁可让钱躺在异常池里被人看见，
 * 也不能自动发字符出去 —— 发错了再收回，用户那边已经是既成事实。
 *
 * ## 收纳的八类
 *
 *   UNDERPAID          少付（链上金额 < 应付）
 *   OVERPAID           多付（链上金额 > 应付，且不构成另一张订单）
 *   WRONG_TOKEN        错误代币（转到收款地址但合约不是指定 USDT）
 *   WRONG_ADDRESS      错误地址（金额像我们的，但 to 不是我们的收款地址）
 *   EXPIRED_PAYMENT    过期到账 / 迟到款（保护期内匹配到已终态订单）
 *   NO_MATCH           无法唯一匹配（金额不落在任何一个预约上）
 *   DUPLICATE_PAYMENT  重复付款（同一订单收到第二笔）
 *   DUPLICATE_TXID     重复 TXID（同一笔链上交易试图结算两次）
 *
 * ## 为什么 tx_id 上要加部分唯一索引
 *
 * 链监听器会**补扫**（防链 API 故障漏单），同一笔交易必然被反复看到。
 * 如果每次看到都往异常池插一条，池子会被同一笔交易刷屏，
 * 真正需要处理的异常被淹没。按 (tx_id, kind) 去重后，
 * 同一笔交易的同一类异常只留一条。
 */

exports.up = async pgm => {
  await pgm.db.query(`
    CREATE TABLE recharge_exceptions (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

      kind varchar(32) NOT NULL CHECK (kind IN (
        'UNDERPAID', 'OVERPAID', 'WRONG_TOKEN', 'WRONG_ADDRESS',
        'EXPIRED_PAYMENT', 'NO_MATCH', 'DUPLICATE_PAYMENT', 'DUPLICATE_TXID'
      )),

      -- 链上事实（无法匹配时这些是唯一的线索，全部留档）
      tx_id varchar(160),
      log_index integer,
      to_address varchar(64),
      from_address varchar(64),
      token_contract varchar(64),
      amount_milli bigint CHECK (amount_milli IS NULL OR amount_milli > 0),
      block_number bigint,
      block_timestamp timestamptz,
      confirmations integer,

      -- 疑似归属（给人工判断用，不代表已确认）
      recharge_id bigint REFERENCES recharges(id) ON DELETE SET NULL,
      reservation_id bigint REFERENCES recharge_amount_reservations(id) ON DELETE SET NULL,

      -- 期望值 vs 实际值等上下文，便于一眼看懂差在哪
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      -- 给运营看的说明，由服务层生成（如「应付 35.427，实付 35.400，少 0.027」）
      summary varchar(300) NOT NULL DEFAULT '',

      status varchar(16) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'resolved', 'ignored')),
      resolved_by bigint REFERENCES admins(id) ON DELETE SET NULL,
      resolved_at timestamptz,
      resolution_note varchar(500) NOT NULL DEFAULT '',
      -- 人工处理的结果：手工入账到某张订单 / 退回
      resolved_action varchar(32) CHECK (resolved_action IS NULL OR resolved_action IN ('credit', 'reject')),

      created_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT recharge_exceptions_resolution_check
        CHECK ((status = 'open' AND resolved_at IS NULL AND resolved_by IS NULL)
            OR (status <> 'open' AND resolved_at IS NOT NULL))
    )
  `)

  // 补扫去重：同一笔交易的同一类异常只记一条
  await pgm.db.query(`
    CREATE UNIQUE INDEX recharge_exceptions_tx_kind_uq
      ON recharge_exceptions (tx_id, kind)
      WHERE tx_id IS NOT NULL
  `)

  // 运营主视图：待处理的排最前
  await pgm.db.query(`
    CREATE INDEX recharge_exceptions_open_idx
      ON recharge_exceptions (status, created_at DESC)
  `)

  await pgm.db.query(`
    CREATE INDEX recharge_exceptions_recharge_idx
      ON recharge_exceptions (recharge_id)
      WHERE recharge_id IS NOT NULL
  `)
}

exports.down = async pgm => {
  await pgm.db.query('DROP TABLE IF EXISTS recharge_exceptions')
}
