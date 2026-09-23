/**
 * 链扫描游标 —— 定时补扫的锚点。
 *
 * ## 解决什么
 *
 * 链 API 会抖：限流、超时、5xx、返回截断。服务也会重启。
 * 只要扫描状态只存在内存里，任何一次抖动都会**永久漏掉一段区块**，
 * 而链上少扫的那几笔钱不会有第二次机会被看见。
 *
 * 所以每次扫描的进度必须落库：
 *
 *   last_scanned_block  已经完整扫过的最新区块
 *   last_scanned_at     最后一次成功扫描的时间
 *
 * ## 补扫为什么是安全的
 *
 * 补扫会把同一段区块重扫很多遍，看到同一批交易很多次。
 * 这不构成重复入账风险 —— 幂等锚点是 `chain_transactions.tx_id`
 * 的唯一约束，重复看到只会撞冲突然后被短路。
 *
 * 正因为补扫安全，游标**宁可回退也不可跳跃**：
 * 每次扫描从 `last_scanned_block - REWIND_BLOCKS` 开始，
 * 重复覆盖一小段，用少量重复换取不漏单。
 *
 * ## 为什么按 (地址, 合约) 分开记
 *
 * 将来若支持多条链或多个代币，各自的进度互不相干，
 * 一条链卡住不该让另一条链停止推进。
 */

exports.up = async pgm => {
  await pgm.db.query(`
    CREATE TABLE chain_scan_cursor (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

      address varchar(64) NOT NULL,
      token_contract varchar(64) NOT NULL,

      -- 已完整扫过的最新区块。0 表示从未扫描
      last_scanned_block bigint NOT NULL DEFAULT 0 CHECK (last_scanned_block >= 0),
      last_scanned_at timestamptz,
      -- 连续失败次数：用于告警与退避，避免链 API 挂了还在死循环打
      consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
      last_error varchar(300) NOT NULL DEFAULT '',

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT chain_scan_cursor_target_uq UNIQUE (address, token_contract)
    )
  `)
}

exports.down = async pgm => {
  await pgm.db.query('DROP TABLE IF EXISTS chain_scan_cursor')
}
