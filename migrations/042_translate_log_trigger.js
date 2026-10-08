/**
 * 翻译日志记录调用来源（`translate_logs.trigger`）。
 *
 * ## 起因：非预期扣费无法归因
 *
 * 群聊「翻译通道 = 手动」时，客户端本该一条都不自动翻，实际却把打开会话时
 * 满屏的历史消息统统翻了一遍 —— 用户一个键都没点，`char_balance` 却在掉。
 * 真机上能看到的只有「余额少了」，**看不出是谁触发的**：
 *
 *   - 用户点了「译」？        → 该扣
 *   - 扫描时自动翻的？        → 不该扣
 *   - 客户端某个分支漏了闸？   → 不该扣
 *
 * `translate_logs` 原本只有 user / sub_account / engine / chars / 时间，
 * 没有任何一列能回答"这次是手动触发还是自动触发"。事后审计只能猜。
 *
 * 所以加一列 `trigger`，由客户端在**发起翻译时**声明来源：
 *
 *   manual_click  —— 用户点了「译」按钮 / 触发了发送翻译
 *   auto_receive  —— 扫描到消息后自动翻（群聊手动模式下必须为 0 条）
 *   ''            —— 旧版客户端、服务端内部调用，未声明
 *
 * ## 为什么不是布尔列
 *
 * 以后大概还会出现"重新翻译"「历史消息补翻」这类来源，枚举比布尔扩展得起。
 * 值域用 CHECK 收口，避免客户端把任意字符串写进来（那是客户端可控输入）。
 *
 * ## 为什么默认空串而不是 NOT NULL 报错
 *
 * 存量行没有来源，回填不了也不该伪造。默认 `''` 表示"未声明"，语义准确。
 */

exports.up = async pgm => {
  await pgm.db.query(
    "ALTER TABLE translate_logs ADD COLUMN IF NOT EXISTS trigger varchar(40) NOT NULL DEFAULT ''"
  )
  // 值域收口：trigger 来自客户端，属于不可信输入；不约束就能被写进任意字符串。
  await pgm.db.query(`
    ALTER TABLE translate_logs
      ADD CONSTRAINT translate_logs_trigger_check
      CHECK (trigger IN ('', 'manual_click', 'auto_receive', 'manual_send', 'retranslate'))
  `)
  // 审计入口是"这个商户/这段时间里自动触发扣了多少字符"，按 (user_id, trigger, created_at) 查最快。
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS translate_logs_trigger_created_idx
      ON translate_logs (trigger, created_at DESC)
      WHERE trigger <> ''
  `)
  console.log('  042：translate_logs.trigger 已就位（计费归因）')
}

exports.down = async pgm => {
  await pgm.db.query('DROP INDEX IF EXISTS translate_logs_trigger_created_idx')
  await pgm.db.query('ALTER TABLE translate_logs DROP CONSTRAINT IF EXISTS translate_logs_trigger_check')
  await pgm.db.query('ALTER TABLE translate_logs DROP COLUMN IF EXISTS trigger')
}
