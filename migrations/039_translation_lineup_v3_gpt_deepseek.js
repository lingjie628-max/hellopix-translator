/**
 * V1.0.x 前期只开放 DeepSeek + GPT（2026-10-06）。
 *
 * ## 一、为什么只留两个通道
 *
 * V1.0.x 前期要先把「翻译计费」这条链路跑通，再谈多供应商。
 * 通道越多，成本结构、质量口径、排障面就越多；这个阶段的正确做法是**收窄**：
 * 只留 GPT 与 DeepSeek 两条已接通、已实跑的通道，其余一律下架。
 *
 * ## 二、下架 = 软删除，与迁移 031 同一套机制
 *
 * `retired_at` 非空 = 已下架：对商户不可见、不可选，但**行还在、历史日志还在**。
 * 绝不 DELETE：
 *   · `translate_logs.engine_id` 与 `users.active_engine_id` 是外键
 *     （RESTRICT / SET NULL），删行会篡改历史账目；
 *   · `package_engines` / `package_engine_versions` 是「当初卖过什么」的凭据。
 *
 * 下架同时写 `enabled=false, wired=false`：库级约束
 * `engines_wired_requires_enabled` 不允许「停用但接通」这种自相矛盾的状态，
 * 也让任何忘记按 retired_at 过滤的代码路径都拿不到这两条通道。
 *
 * ## 三、套餐权益推到 v3
 *
 * v2（迁移 031）的三档组合里都夹着将被下架的通道：
 *   basic    {qwen, gpt, deepseek}
 *   advanced {qwen, gpt, deepseek, glm, mistral, doubao, minimax}
 *   pro      全部 11 个
 * 本次下架 qwen / glm / mistral / doubao / minimax / claude / grok / google / kimi
 * 之后，三档剩下 {gpt, deepseek} —— 同为两个通道。
 *
 * 这里**刻意不去按档位再编组合**：规则只有一条「只开放这两个」，
 * 任何「基础版给 1 个、专业版给 2 个」的分档都是规则里没有的假设。
 * 真要重新分档，等 V1.1 有了成本结论再开 v4，而不是趁下架顺手猜一版。
 *
 * 版本机制本身（`package_engine_versions` 快照 + 商户钉版）完全沿用 031：
 * 活表怎么改都不会回溯动到已售权益。所以本迁移也**必须**：
 *   1. 先把新组合写进活表；
 *   2. 再固化 v3 快照；
 *   3. 再把「钉住的版本里有通道被下架」的商户释放回在售组合（见第四节）。
 *
 * ## 四、存量商户：钉版里只要有通道被下架 → 释放回 v3
 *
 * 与 031 判据一致（见 031 里那一段「为什么是任一而不是全部」）：
 * 只要钉住的版本（v1 或 v2）里**有任何一个**通道在这次下架里没了，
 * 就把 `package_catalog_version` 清成 NULL（= 跟随在售 v3）。
 *
 * 本次下架 9 个通道，而 v1/v2 三档快照里几乎必然含其中至少一个
 * （basic v1 只有 niutrans，走的是 031 已释放的路径；advanced/pro 的 v1、v2
 * 都含 google 或 qwen 等），所以存量商户会落到 v3 = {gpt, deepseek}，
 * 老客户与新买家口径一致、成本可核算。
 *
 * ## 五、对客户账单的影响：无
 *
 * 本迁移**不碰** `char_balance` / `char_used` / `translate_logs`：
 * 扣费仍是「翻译多少计费字符就扣多少」，与通道无关（DeepSeek = GPT = 1.0x）。
 * 下架通道只是「不再可选」，不是「改已发生的账」。
 */

// 规则 1：唯一开放的通道。顺序即「默认优先」参考顺序，gpt 在前。
const TARGET_ENGINE_IDS = ['gpt', 'deepseek']

// 039 之前的正式阵容由 031 定为 11 个，且 032–038 未增删任何通道
// （032 只换成本币种、033 只补 model、034 只改宣传文案）。因此
// 「凡不在 {gpt, deepseek} 里的一律下架」恰好等于下架这 9 个。
//
// 下架集合**从 031 的名单算出来**，不手抄 —— 手抄一份清单就等于
// 赌自己抄对了那 11 个，抄漏一个那一条就不会被下架（规则 1 形同虚设）。
const PREVIOUS_LINEUP_IDS = require('./031_translation_channel_lineup').lineupEngineIds
const RETIRED_ENGINE_IDS = PREVIOUS_LINEUP_IDS.filter(id => !TARGET_ENGINE_IDS.includes(id))

/**
 * v3：三档都只含 {gpt, deepseek}。
 *
 * 与 031 的 PACKAGE_ENGINES_V2 一样，这是**完整目标集合**（up 先删不在集合里的、
 * 再补齐；down 按集合从 v2 快照整体恢复）。刻意不写成「增量列表」——
 * 增量写法会让 live 表残留 qwen 之类已下架通道，基础版就等于变相留着它。
 */
const PACKAGE_ENGINES_V3 = [
  ['basic', 'gpt'], ['basic', 'deepseek'],
  ['advanced', 'gpt'], ['advanced', 'deepseek'],
  ['pro', 'gpt'], ['pro', 'deepseek']
]

// ---------------------------------------------------------------------------

function q(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function packageValues(rows) {
  return rows.map(([code, id]) => `        (${q(code)}, ${q(id)})`).join(',\n')
}

function idList(ids) {
  return ids.map(q).join(', ')
}

exports.up = pgm => {
  pgm.sql(`
    -- =====================================================================
    -- 1) 只留 DeepSeek + GPT：其余一律下架（软删除，不删行）
    -- =====================================================================
    --
    -- 判据是「不在 {gpt, deepseek} 名单里」，而不是一份手抄的下架清单：
    -- 只有活表知道此刻到底还有哪些通道没下架，让它自己算，才不会漏。
    -- enabled / wired 必须与 retired_at 一起写：库级约束不允许
    -- 「enabled=false 但 wired=true」这种自相矛盾的残留状态。
    UPDATE engines
    SET retired_at = NOW(), enabled = false, wired = false, updated_at = NOW()
    WHERE id NOT IN (${idList(TARGET_ENGINE_IDS)})
      AND retired_at IS NULL;

    -- =====================================================================
    -- 2) 套餐权益推到 v3：三档都只含 {gpt, deepseek}
    -- =====================================================================

    -- 先删活表里不在目标集合的组合（qwen / glm / google / kimi …）。
    -- 删 package_engines 的行**不会**动到已售权益：v1/v2 快照在
    -- package_engine_versions 里，存量商户也钉在自己的版本上（下一步释放）。
    -- 本段刻意不用反引号：整段 SQL 在 JS 模板字符串里，反引号会截断它。
    DELETE FROM package_engines pe
    USING packages p
    WHERE pe.package_id = p.id
      AND p.code IN ('basic', 'advanced', 'pro')
      AND NOT EXISTS (
        SELECT 1 FROM (
          VALUES
${packageValues(PACKAGE_ENGINES_V3)}
        ) AS m(package_code, engine_id)
        WHERE m.package_code = p.code AND m.engine_id = pe.engine_id
      );

    INSERT INTO package_engines (package_id, engine_id)
    SELECT p.id, m.engine_id
    FROM (
      VALUES
${packageValues(PACKAGE_ENGINES_V3)}
    ) AS m(package_code, engine_id)
    JOIN packages p ON p.code = m.package_code
    ON CONFLICT (package_id, engine_id) DO NOTHING;

    -- v3 快照 = 推进后的活表。从此 package_engines 再怎么变，v3 都不变。
    INSERT INTO package_engine_versions (package_id, version, engine_id)
    SELECT pe.package_id, 3, pe.engine_id
    FROM package_engines pe
    WHERE pe.package_id IN (SELECT id FROM packages WHERE code IN ('basic', 'advanced', 'pro'))
    ON CONFLICT (package_id, version, engine_id) DO NOTHING;

    UPDATE packages SET catalog_version = 3, updated_at = NOW()
    WHERE code IN ('basic', 'advanced', 'pro');

    -- =====================================================================
    -- 3) 存量商户：钉住的版本里只要有通道被下架 → 释放回在售 v3
    -- =====================================================================
    --
    -- 判据「任一」而非「全部」的理由见本文件头部第四节与 031 的对应段落。
    -- 这里只释放**确实受影响**的商户：快照与当前下架状态都读库算出来，
    -- 不假设谁是 v1、谁是 v2，也不写死哪一档含哪个通道。
    UPDATE users u SET package_catalog_version = NULL, updated_at = NOW()
    WHERE u.package_catalog_version IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM package_engine_versions v
        JOIN engines e ON e.id = v.engine_id
        WHERE v.package_id = u.package_id
          AND v.version = u.package_catalog_version
          AND e.retired_at IS NOT NULL
      );

    -- =====================================================================
    -- 4) 清掉指向已下架通道的选择，交给程序按「权益内第一个可用通道」重解析
    -- =====================================================================
    --
    -- 不清的话，商户会一直撞「当前套餐未包含此通道」，却不知道为什么。
    UPDATE users SET active_engine_id = NULL, updated_at = NOW()
    WHERE active_engine_id IN (
      SELECT id FROM engines WHERE retired_at IS NOT NULL
    );

    UPDATE sub_accounts SET active_engine_id = NULL, updated_at = NOW()
    WHERE active_engine_id IN (
      SELECT id FROM engines WHERE retired_at IS NOT NULL
    );

    UPDATE app_settings
    SET value = '""'::jsonb, updated_at = NOW()
    WHERE key = 'translation.active_engine'
      AND value IN (
        SELECT to_jsonb(id) FROM engines WHERE retired_at IS NOT NULL
      );
  `)
}

exports.down = pgm => {
  pgm.sql(`
    -- 权益版本回退到 v2
    UPDATE packages SET catalog_version = 2, updated_at = NOW()
    WHERE code IN ('basic', 'advanced', 'pro');

    DELETE FROM package_engine_versions WHERE version = 3;

    -- 活表按 v2 快照**整体恢复**，不另外抄一份组合清单。
    --
    -- up 里 v3 是集合赋值（含「从活表里删掉 qwen / google …」这类移除），
    -- 所以回滚也必须按集合恢复；只把新加的补回去、不管删掉的，
    -- 活表就与 039 之前不一致。v2 快照正是那一刻的活表，读它就是读事实。
    DELETE FROM package_engines
    WHERE package_id IN (SELECT id FROM packages WHERE code IN ('basic', 'advanced', 'pro'));

    INSERT INTO package_engines (package_id, engine_id)
    SELECT v.package_id, v.engine_id
    FROM package_engine_versions v
    WHERE v.version = 2
      AND v.package_id IN (SELECT id FROM packages WHERE code IN ('basic', 'advanced', 'pro'));

    -- 重新上架本迁移下架的 9 个通道。
    --
    -- up 用的是「凡不在 {gpt, deepseek} 里且未下架的一律下架」这个通用判据，
    -- 但 039 之前的阵容由 031 定为 11 个、032–038 未增删通道（已核对活表），
    -- 所以 up 实际下架的正是 RETIRED_ENGINE_IDS 这 9 个；恢复它们即可。
    -- 用 retired_at IS NOT NULL 限定，避免去动 031 早已下架的那 5 个旧通道。
    UPDATE engines SET retired_at = NULL, updated_at = NOW()
    WHERE id IN (${idList(RETIRED_ENGINE_IDS)})
      AND retired_at IS NOT NULL;

    -- enabled / wired 刻意不碰：up 下架时把它们置成了 false，这里不还原成 true。
    -- 与 031 的取舍一致 —— 回滚是为了恢复「可选项集合」，不是为了宣称
    -- 「这些通道此刻接通可用」。要重新接通，请在后台填凭据后保存
    -- （适配器会把 wired 置 true），或走 scripts/set-engine-wired.js。
    --
    -- 另：up 已把商户的 package_catalog_version / active_engine_id 清成 NULL，
    -- 回滚无法知道它们原来的值，保持 NULL（跟随活表 / 由程序重解析）——
    -- 猜一个旧值回去，就是凭空改写商户的权益与选择。
  `)
}

// ---------------------------------------------------------------------------
// 导出给测试用（与 031 同样的做法：数据只有一个来源，测试直接读它，
// 不去正则扫那堆运行时拼出来的 SQL）。
//
// 规则 1 的执行点：唯一开放的两个通道。
exports.targetEngineIds = TARGET_ENGINE_IDS
// 本次下架的通道（= 031 阵容去掉两个目标通道）。
exports.retiredEngineIds = RETIRED_ENGINE_IDS
// v3 的完整目标集合，供测试钉住「三档都只有这两个」。
exports.packageEnginesV3 = PACKAGE_ENGINES_V3
