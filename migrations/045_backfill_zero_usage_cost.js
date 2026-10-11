/**
 * 补算 DeepSeek 历史台账的成本 —— 那 48 行「$0 却标着已核实」。
 *
 * ## 背景
 *
 * `deepseekTranslate()` 的成功分支曾经返回 `{ ok: true, text }`，把厂商给的
 * `usage` 整个丢掉了（DeepSeek 走 OpenAI 兼容的 `/chat/completions`，响应里
 * 本来就有 `prompt_tokens` / `completion_tokens`）。核心代码已在本轮修好，
 * 新记录会带上真实 token；但**已经落库的历史记录不会自己变好**。
 *
 * 迁移前的实测状态（生产 2026-10-11）：
 *
 *   engine     rows   零token行   总成本        cost_verified=true
 *   deepseek     48          48   0.000000                   48   ← 全是假的"已核实"
 *   gpt         417           0   0.035147                  417   ← 一直是好的
 *
 * 「$0 且 cost_verified=true」是这张表最危险的一种状态：成本 0 与"真的没花钱"
 * 在库里完全一样，而 `cost_verified=true` 会让人**以为已经核实过**。
 * 月度对账时这一块会被当成免费，整条通道的成本凭空消失。
 *
 * ## 为什么可以补算
 *
 * 这 48 行**全部**能在 `translation_reservations` 上关联到 `reserved_chars`
 * （实测 48/48 可关联，合计 8056 字符），且通道单价（`engines.cost_per_million`
 * = $0.8333/百万字符）是已知的。于是能给出一个**有出处、可复核**的估算值。
 *
 * ## 估算口径：与运行时兜底**完全一致**
 *
 *   cost = reserved_chars × engines.cost_per_million ÷ 1e6
 *
 * 这正是 `core-service.estimateCostFromChars()` 的公式。两处用同一个公式，
 * 是为了让 `translation_logs.cost_amount`（客户侧成本估算）与这里的内部台账
 * **可以直接对照** —— 否则补算出来的数会自成一套口径，对账时反而更乱。
 *
 * ## 三条刻意的取舍
 *
 * 1. **只估算，不冒充精确**。数据来源是字符数而不是真实 token，所以
 *    `cost_verified` 一律置 `false`，`cost_source` 记 `backfill:estimate`。
 *    宁可标成"估的"，也不要一个看起来干净的 0 或假的"已核实"。
 * 2. **`billed_units` / `billed_unit` 不动**。厂商按 token 计费，而我们**并不知道**
 *    那次到底用了多少 token —— 把它改写成字符数等于假造计量单位。
 *    保持 `0 / 'token'` 的含义是"按 token 计费、但这次的数量我们没拿到"，
 *    字符依据写在 `cost_note` 里。
 * 3. **守卫是 `cost_verified = true`**，不是"凡是 0 成本就改"。只有
 *    "自己不占理、却声称核实过"的行才需要纠正；这样重复执行也天然幂等
 *    （改完 `cost_verified=false` 就不再命中）。
 *
 * ## 影响面
 *
 * 48 行、合计约 **$0.0067**。金额很小，但意义在于：成本表上不再有
 * "看起来已核实的 0"。客户侧字符余额**不受任何影响** —— 本迁移只碰
 * `translation_usage`（内部台账），它与对客户的扣费完全分离。
 */

/** 补算时写进 `cost_note` 的说明（让后来人不必翻代码就知道这个数是怎么来的）。 */
const NOTE_PREFIX = '厂商未返回 usage（token 数丢失），成本按通道成本表的字符单价估算：'

/** 这 48 行原本的 `cost_note`（DeepSeek 价目表说明），`down` 用它还原。实测 48/48 同值。 */
const ORIGINAL_NOTE =
  '峰时价（UTC 周一至周五 01:00-04:00、06:00-10:00）；闲时 $0.15/$0.60。'
  + '缓存命中输入 $0.006。模型版本 DeepSeek-V4.1-Flash。'

/** 这 48 行原本的 `cost_as_of`。 */
const ORIGINAL_AS_OF = '2026-09-11'

/** 补算当天。写进 `cost_as_of`，标明这个估算是什么时候作出的。 */
const BACKFILL_AS_OF = '2026-10-11'

/** `cost_source` 的标记值 —— `down` 靠它精确定位"本迁移改过的行"。 */
const SOURCE_TAG = 'backfill:estimate'

exports.up = pgm => {
  pgm.sql(`
    UPDATE translation_usage u
       SET upstream_cost = ROUND(
             (r.reserved_chars::numeric * e.cost_per_million::numeric) / 1000000, 8),
           cost_verified = false,
           cost_source   = '${SOURCE_TAG}',
           cost_as_of    = '${BACKFILL_AS_OF}',
           cost_note     = '${NOTE_PREFIX}'
                           || r.reserved_chars || ' 字符 × $' || e.cost_per_million
                           || '/百万字符。与 translate_logs.cost_amount 同口径，'
                           || '属上界估算，需人工复核。原记录为 0 成本却标 cost_verified=true，'
                           || '那个"已核实"是假的（根因见迁移 045 注释）。'
      FROM translation_reservations r, engines e
     WHERE u.reservation_id = r.id
       AND u.engine_id = e.id
       AND u.total_tokens = 0          -- 没拿到 token，这正是要补的那批
       AND u.upstream_cost = 0         -- 且成本记成了 0
       AND u.cost_verified = true      -- 关键守卫：只纠正"错误声称已核实"的行
       AND e.cost_per_million > 0;     -- 没有单价就无从估算，留给人工
  `)
}

exports.down = pgm => {
  // 只还原本迁移改过的行（靠 SOURCE_TAG 定位）。
  // 原值：成本 0、verified=true、note/as_of 是 DeepSeek 价目表那份。
  // 这 48 行实测全部是 deepseek，所以能精确还原；其他通道万一命中，
  // note/as_of 置 NULL 而不是猜一个值（猜错比留空更难排查）。
  pgm.sql(`
    UPDATE translation_usage
       SET upstream_cost = 0,
           cost_verified = true,
           cost_source   = NULL,
           cost_as_of    = CASE WHEN engine_id = 'deepseek' THEN '${ORIGINAL_AS_OF}' ELSE NULL END,
           cost_note     = CASE WHEN engine_id = 'deepseek' THEN '${ORIGINAL_NOTE}' ELSE NULL END
     WHERE cost_source = '${SOURCE_TAG}';
  `)
}

// 导出给测试用：目标文案只有一个来源，测试直接读它，避免两处各写一份。
exports.SOURCE_TAG = SOURCE_TAG
exports.NOTE_PREFIX = NOTE_PREFIX
exports.ORIGINAL_NOTE = ORIGINAL_NOTE
