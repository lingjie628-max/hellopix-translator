/**
 * 放开翻译通道切换：所有套餐都允许商户自选 GPT / DeepSeek。
 *
 * ## 起因：真机上「通道无法切换」被判定为缺陷
 *
 * macOS 0.1.11 真机验收时，新子账号的通道下拉**不可用**，并且显示的是 `GPT`
 * 而服务端实际走 `DeepSeek`。查下来是一套**按套餐**的权限设计在起作用：
 *
 *   migration 015：`UPDATE packages SET allow_engine_switch = false WHERE code = 'basic'`
 *   core-service.js：`canSwitchEngine(session) { return session.parent.packageAllowEngineSwitch !== false }`
 *
 * 也就是说被锁的是**整个商户**（主账号、子账号一视同仁），不是"子账号只能固定一个"。
 * 但结果是：商户买了包含两个通道的套餐，却一个都选不了；界面还把账号里存的旧值
 * （`gpt`）当"当前通道"显示，而真实调用是 `deepseek` —— **界面在骗人**。
 *
 * ## 为什么改成全开
 *
 * V1.0.x 生产只登记了 GPT + DeepSeek 两个通道（见 migration 039），
 * 而这两个通道**都在基础版权益内**。权益里有两个通道却锁死选择，
 * 换不来任何成本控制收益 —— 真正的成本控制应该由「套餐包含哪些通道」来完成，
 * 而不是"锁死其中一个"。锁死只会带来两类损失：
 *
 *   1. 用户困惑与工单（就是我方本轮真机验收踩到的那条）；
 *   2. 界面显示与真实调用不一致的风险 —— 展示的模型和真花钱的模型必须是同一个。
 *
 * 所以：**通道切换对当前所有套餐开放。**
 *
 * ## `allow_engine_switch` 列为什么不删
 *
 * 机制本身是对的、而且要留着：将来某一档套餐若真要锁死单一通道（例如极低价的
 * 引流档），这是唯一的开关。服务端强制忽略客户端传来的 engine 也**必须保留** ——
 * 只把前端下拉藏起来的话，直接调接口就能绕过。本迁移只翻转**数据**，
 * `canSwitchEngine()` / `resolveEngineId()` / 客户端的 `authoritativeEngine`
 * 一行都不改，它们继续作为"万一有套餐被锁"的正确兜底。
 *
 * ## 为什么按 code 而不是按"当前为 false"
 *
 * 按 `WHERE allow_engine_switch = false` 会把**超管后来手工锁过**的套餐一起打开，
 * 那是擅自改他人配置。015 锁的就是 `basic` 一个，这里只还原它。
 * 改完把**仍然处于锁死状态**的套餐打出来，方便一眼确认没有漏网的档位。
 */

exports.up = async pgm => {
  const flipped = await pgm.db.query(`
    UPDATE packages
       SET allow_engine_switch = true, updated_at = NOW()
     WHERE code = 'basic'
       AND allow_engine_switch = false
  `)

  // 把"仍然锁死"的档位打出来。不是报错 —— 那是合法的套餐配置，
  // 只是发布前需要人眼确认一遍"这几档确实是要锁的"。
  const stillLocked = await pgm.db.query(
    "SELECT code FROM packages WHERE allow_engine_switch = false ORDER BY code"
  )
  const codes = stillLocked.rows.map(row => row.code).join(', ')
  console.log(
    `  043：基础版通道切换已放开（改动 ${flipped.rowCount} 行）；`
    + `仍锁死通道的套餐：${codes || '无'}`
  )
}

exports.down = async pgm => {
  // 还原 015 的口径：基础版锁死，其余开放。
  await pgm.db.query(`
    UPDATE packages
       SET allow_engine_switch = false, updated_at = NOW()
     WHERE code = 'basic'
  `)
}
