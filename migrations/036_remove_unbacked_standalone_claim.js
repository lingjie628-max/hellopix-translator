/**
 * 摘掉「独立应用版」这个 V1.0 交付不了的权益承诺。
 *
 * ## 起因
 *
 * 三个套餐的 `highlights` 都写着「独立应用版」，`packages.clients.standalone`
 * 也都是 true（后台「上架」页那个「独立应用版」勾选框），客户端页脚还有
 * 一个「独立应用版」下载入口。但后面**没有任何东西** —— 四条独立线索交叉验证：
 *
 *   1. 生产库 `client_releases`：只有 windows(5) / macos(10)，
 *      `release_group='standalone'` **一行都没有**；
 *   2. `/apis/site/info`：`standaloneApps: []`，`standalone: ""`；
 *   3. 客户端点「独立应用版」→ `openStandaloneDownload()` → 弹
 *      「独立应用尚未上架」（因为 `standaloneApps()` 过滤后为空）；
 *   4. 仓库里现存的 standalone 产物是 2026-09-14 的，而 Telegram 修复与 CI
 *      同步一直持续到 09-15 —— 即使要发布也必须**重建并复验**。
 *
 * 「独立应用版」指的是**每平台单应用壳**（见 `server/lib/client-catalog.js` 的
 * `STANDALONE_APPS`，来源于 `desktop/platforms.js` 的每个平台 id），
 * **不是**主桌面客户端 —— 主客户端走的是 windows / macos 分组。
 *
 * 这与迁移 035 摘「手机版」是同一个病：写在**套餐权益列表**里，客户读到的是
 * "我买了这个套餐就得到独立应用版"，而后面没有任何东西。属于退款/拒付风险，
 * 不是措辞问题。
 *
 * ## 改了什么
 *
 *   · 三个套餐的 `highlights` 去掉「独立应用版」；
 *   · `clients.standalone` 置为 false（`||` 合并，保留 mobile / counter）。
 *
 * ## 为什么不按确切值整段重写（与 034/035 的写法略有不同）
 *
 * 034/035 用「钉住那份已知的错文案 + 整段替换」。本迁移改用**手术式删除**
 * (`highlights - '独立应用版'`)：jsonb 的 `- text` 只移除相等的那个元素，
 * 其余元素（含管理员后来加的宣传语）一律不动。既保证了"这条承诺一定消失"，
 * 又不会把别人的编辑一起刷掉 —— 比整段替换更安全，且天然幂等。
 *
 * ## 没改什么（有意保留，便于后续恢复）
 *
 *   · `standalone/` 源码、tdesktop 补丁、Telegram 独立版一律不动；
 *   · 不删除任何 standalone 产物；
 *   · 后台「独立应用版」勾选框、`client-catalog` 的 `RELEASE_GROUPS` /
 *     `STANDALONE_APPS` 全部保留。
 *
 * 恢复路径（重新构建 + 验收通过之后）：登记 `release_group='standalone'` 的
 * 在架发布记录，把本迁移 `down` 回去（或在后台重新勾选 + 补宣传语）即可。
 * 客户端页脚入口已改为**按数据显隐**，登记发布记录后会自动重新出现，
 * 不必再发一次客户端。
 */

exports.up = pgm => {
  // 只动这三个在售套餐；`id` 之外还要求"确实还带着这条承诺或这个权益"，
  // 已经是目标状态的库不重复写（幂等，也不会无谓地刷 updated_at）。
  const targets = [1, 2, 3]
  for (const id of targets) {
    pgm.sql(`
      UPDATE packages
      SET highlights = highlights - '独立应用版',
          clients = COALESCE(clients, '{}'::jsonb) || '{"standalone": false}'::jsonb,
          updated_at = NOW()
      WHERE id = ${id}
        AND (highlights::text LIKE '%独立应用版%' OR clients->>'standalone' = 'true');
    `)
  }
}

exports.down = pgm => {
  // 只在"本条承诺当前确实不在"时才恢复，避免覆盖管理员后来改成的版本。
  // `highlights || '["独立应用版"]'` 追加到末尾 —— 原位置就在末尾（见 034/035）。
  const targets = [1, 2, 3]
  for (const id of targets) {
    pgm.sql(`
      UPDATE packages
      SET highlights = highlights || '["独立应用版"]'::jsonb,
          clients = COALESCE(clients, '{}'::jsonb) || '{"standalone": true}'::jsonb,
          updated_at = NOW()
      WHERE id = ${id}
        AND NOT (highlights @> '["独立应用版"]'::jsonb)
        AND clients->>'standalone' = 'false';
    `)
  }
}
