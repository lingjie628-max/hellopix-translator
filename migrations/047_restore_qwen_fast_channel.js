/**
 * 接入通义千问 MT（qwen-mt-flash）作为**快速翻译通道**（2026-10-21）。
 *
 * ## 一、为什么加回来
 *
 * 039 为了先跑通计费链路，把通道收窄成 {gpt, deepseek}，qwen 被软下架。
 * 现在遇到的是**性能**问题，不是成本问题：
 *
 *   2026-10-21 真机实测（生产账号，全新文本，避开缓存）：
 *     gpt        P50 = 4179ms  P95 = 5577ms   ← gpt-5.6-luna 是推理模型
 *     deepseek   P50 = 1381ms  P95 = 1779ms
 *
 * 两条都是对话式 LLM，要「prompt → 推理 → 逐 token 生成」，
 * 再压也只能到 1.1s 左右。而 qwen-mt-flash 是**专用翻译模型**（seq2seq），
 * 不经推理、不生成解释，常见方向通常 200~400ms —— 差一个数量级。
 *
 * ## 二、为什么只给 advanced / pro，不给 basic
 *
 * 用户要求的是「混合路由」：短句走快路、长句走 LLM。这需要**同一账号同时拥有**
 * 快慢两条通道，路由才有意义。
 *
 * 但 basic 是三档里单位成本最高的一档（见 044 的阶梯分析），
 * 往里加一条新通道等于直接吃掉它的毛利。而 advanced 是本账号（ahao）所在档位，
 * 也是本次实测用的档位 —— 先在这一档验证速度收益，比"三档全开再看数据"稳。
 *
 * 这不是为了少给：qwen 的成本（0.7 元输入 / 1.95 元输出 每百万 tokens）
 * 与 LLM 通道同级甚至更低，**快且不更贵**。等 basic 的实测数据出来再放开即可，
 * 那时只需再写一条迁移把 ['basic','qwen'] 加进集合。
 *
 * ## 三、qwen 这一行本来就在，只恢复不新建
 *
 * 039 用的是软下架（`retired_at` 非空 + `enabled=false, wired=false`），
 * 行与 note 都还在。所以：
 *   · 不 INSERT 新行 —— 主键冲突，且会丢掉 031 里那份踩坑备注；
 *   · 只把 retired_at 清空。
 *
 * **但 enabled / wired 故意不在这里置 true。**
 *
 * 这是本迁移最重要的一条取舍：
 *   · `wired=true` 含义是「已接通、有可用凭据」。凭据在**管理后台加密落库**
 *     （见 core-service.engineCredentials），迁移没有、也不该有那个密钥。
 *     在这里硬写 true，等于宣称一条没有凭据的通道是通的，
 *     用户一选就撞 502 —— 正是 039 里批评过的「自相矛盾状态」。
 *   · 所以：`enabled=true`（允许出现在下拉里），`wired` 保持 false。
 *     后台填完 API Key 并保存后，由适配器的 configured() 反馈把 wired 置真。
 *
 * 在凭据填好之前，本账号的实际行为**与迁移前完全一致**（qwen 会被跳过），
 * 混合路由也拿不到快速通道，会自动退回原通道 —— 不会把人卡在错误上。
 *
 * ## 四、权益推到 v4
 *
 * 沿用 031/039 的版本快照机制，不改那套机制本身：
 *   1. 先改活表 package_engines；
 *   2. 再固化 v4 快照；
 *   3. 把钉在旧版本的商户释放回 v4（判据同 039：钉住的版本里**任一**通道已下架）。
 *
 * v4 与 v3 的唯一差别：advanced / pro 各多一条 qwen。
 */

// v4 的完整目标集合（up 先删不在集合里的、再补齐）。
//
// 刻意写成**集合**而不是增量：增量写法会让 live 表残留意外通道，
// 与 039 的取舍保持一致。
const PACKAGE_ENGINES_V4 = [
  ['basic', 'gpt'], ['basic', 'deepseek'],
  ['advanced', 'qwen'], ['advanced', 'gpt'], ['advanced', 'deepseek'],
  ['pro', 'qwen'], ['pro', 'gpt'], ['pro', 'deepseek']
]

// 本迁移恢复上架的通道。qwen 在 031 里已定义好（模型/端点/callParams/备注齐全），
// 这里只需让它的 retired_at 归 NULL。
const RESTORED_ENGINE_IDS = ['qwen']

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
    -- 1) 恢复 qwen：只清 retired_at，enabled 置真，wired 保持 false
    -- =====================================================================
    --
    -- wired 必须等后台填完凭据：迁移拿不到加密落库的 API Key，
    -- 在这里写 true 就是谎报「这条通道能用了」。
    -- 库级约束 engines_wired_requires_enabled 要求 wired=true 时 enabled 必须为真，
    -- 所以这里 enabled=true 是安全的（wired 仍为 false，约束不触发）。
    UPDATE engines
    SET retired_at = NULL, enabled = true, updated_at = NOW()
    WHERE id IN (${idList(RESTORED_ENGINE_IDS)});

    -- =====================================================================
    -- 2) 套餐权益推到 v4：advanced / pro 多一条 qwen
    -- =====================================================================

    DELETE FROM package_engines pe
    USING packages p
    WHERE pe.package_id = p.id
      AND p.code IN ('basic', 'advanced', 'pro')
      AND NOT EXISTS (
        SELECT 1 FROM (
          VALUES
${packageValues(PACKAGE_ENGINES_V4)}
        ) AS m(package_code, engine_id)
        WHERE m.package_code = p.code AND m.engine_id = pe.engine_id
      );

    INSERT INTO package_engines (package_id, engine_id)
    SELECT p.id, m.engine_id
    FROM (
      VALUES
${packageValues(PACKAGE_ENGINES_V4)}
    ) AS m(package_code, engine_id)
    JOIN packages p ON p.code = m.package_code
    ON CONFLICT (package_id, engine_id) DO NOTHING;

    -- v4 快照 = 推进后的活表。从此 package_engines 再怎么变，v4 都不变。
    INSERT INTO package_engine_versions (package_id, version, engine_id)
    SELECT pe.package_id, 4, pe.engine_id
    FROM package_engines pe
    WHERE pe.package_id IN (SELECT id FROM packages WHERE code IN ('basic', 'advanced', 'pro'))
    ON CONFLICT (package_id, version, engine_id) DO NOTHING;

    UPDATE packages SET catalog_version = 4, updated_at = NOW()
    WHERE code IN ('basic', 'advanced', 'pro');

    -- =====================================================================
    -- 3) 存量商户：钉住的版本里只要有通道已下架 → 释放回在售 v4
    -- =====================================================================
    --
    -- 与 039 同一判据（理由见 031 那一段「为什么是任一而不是全部」）。
    -- 当前库里的商户基本都在 v3（039 刚推进过），v3 无下架通道，
    -- 所以他们**不会**被释放、继续钉在 v3 = {gpt, deepseek}。
    -- 这是有意的：已售权益不因新通道上线而被悄悄扩展，也不被悄悄削掉。
    -- 想要 qwen 的存量商户，在后台改一次套餐/续费即可迁到 v4。
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
    -- 4) 不动 active_engine_id
    -- =====================================================================
    --
    -- 039 清空它是因为一批通道被下架、存着会一直撞「套餐未包含」。
    -- 本次是**加**通道，用户原来的选择仍然合法，清空只会无端打乱他的设置。
  `)
}

exports.down = pgm => {
  pgm.sql(`
    -- 权益退到 v3
    UPDATE packages SET catalog_version = 3, updated_at = NOW()
    WHERE code IN ('basic', 'advanced', 'pro');

    DELETE FROM package_engine_versions WHERE version = 4;

    -- 活表按 v3 快照整体恢复（理由同 039 的 down：up 是集合赋值，回滚也必须是）
    DELETE FROM package_engines
    WHERE package_id IN (SELECT id FROM packages WHERE code IN ('basic', 'advanced', 'pro'));

    INSERT INTO package_engines (package_id, engine_id)
    SELECT v.package_id, v.engine_id
    FROM package_engine_versions v
    WHERE v.version = 3
      AND v.package_id IN (SELECT id FROM packages WHERE code IN ('basic', 'advanced', 'pro'));

    -- 把 qwen 重新下架（回到 039 结束时的状态）
    UPDATE engines
    SET retired_at = NOW(), enabled = false, wired = false, updated_at = NOW()
    WHERE id IN (${idList(RESTORED_ENGINE_IDS)})
      AND retired_at IS NULL;
  `)
}

// 导出给测试读（与 031/039 同样的做法：数据只有一个来源）
exports.packageEnginesV4 = PACKAGE_ENGINES_V4
exports.restoredEngineIds = RESTORED_ENGINE_IDS
