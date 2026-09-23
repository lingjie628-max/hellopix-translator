/**
 * 区块高度改为可空。
 *
 * ## 为什么
 *
 * 025 建表时把 `block_number` 写成了 `NOT NULL`，但 **TronGrid 的
 * TRC20 转账列表接口根本不返回区块高度** —— 它只给 `block_timestamp`。
 * 要拿区块高度就得为每一条记录额外打一次 `gettransactioninfobyid`。
 *
 * 结果就是：一旦切换到 TronGrid Provider，每一条链上交易都会因为
 * `block_number` 为空而插入失败。这不是理论问题，是接上就会炸。
 *
 * ## 为什么不让 Provider 去补齐
 *
 * 区块高度**只用于留档与人工排查**，不参与任何判断：
 *   - 扫描游标走的是时间戳（见 scan-cursor.js）
 *   - solidified 判定走的是「交易时间 <= 最终确认块时间」
 *   - 订单匹配走的是 (地址, 合约, 金额)
 *
 * 为一个纯展示字段付出「每条交易多一次 API 调用」的代价不划算，
 * 在限流额度紧张时更是如此。所以改成可空，Provider 拿得到就填、拿不到就留空。
 */

exports.up = pgm => {
  pgm.sql(`
    ALTER TABLE chain_transactions ALTER COLUMN block_number DROP NOT NULL;
    COMMENT ON COLUMN chain_transactions.block_number IS
      '区块高度。TronGrid 的 TRC20 列表接口不提供，拿不到时为 NULL —— 仅用于留档，不参与任何判断。';
  `)
}

exports.down = pgm => {
  pgm.sql(`
    -- 回退前先把 NULL 填上，否则加不回 NOT NULL
    UPDATE chain_transactions SET block_number = 0 WHERE block_number IS NULL;
    ALTER TABLE chain_transactions ALTER COLUMN block_number SET NOT NULL;
  `)
}
