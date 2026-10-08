# WhatsApp Translation Bridge 稳定化验收报告

- 专项：《WhatsApp Translation Bridge 稳定化收口》
- 范围：**只做稳定化**。不加群发 / 自动回复 / AI 助手 / 新 UI / 新翻译通道。
- 代码基线：**0.1.16**（`desktop/package.json` 已升版；四个候选包已构建并交付，
  **未上架、未打 tag**）
- 报告状态：**代码收口 + 自动化取证 + 候选包已就绪；真机矩阵与生产对账未完成 → 结论 NO RELEASE**

---

## 0. 一句话结论

发送链、接收链、状态机、DOM 渲染、实例设置五处耦合已拆开并各自上闸；
本地自动化证据全绿（927 tests / 913 pass / 0 fail + 5 条取证脚本全过）。
但**本轮明令的"Mac / Windows 真机矩阵"尚未执行**（需要你那边真机 + 安装包），
`translate_logs` / `char_balance` 对账也因**本会话拿不到生产库**而阻塞。
因此按你自己定的"七、最终通过标准"，**当前结论是 NO RELEASE**，不是"测试通过"。

---

## 1. Root Cause 汇总

### 1.1 发送链（B / C 层）

| # | 现象 | 根因 | 状态 |
|---|---|---|---|
| 1 | 对方收到 `原文[正在翻译中...]` | 状态占位符曾被写进真实 contenteditable，且 native send 未被可靠拦下 | 已修（前序轮） |
| 2 | 中文原文直接发出 | 翻译失败时**静默降级发原文** | 已修（前序轮，fail-closed） |
| 3 | Fail-closed 弹窗「重试翻译」无反应 | 重试点击后无任何可见反馈；成功后状态条不清 | **本轮修复** |
| — | 发送链缺少"最终正文校验"可取证事件 | 校验逻辑内嵌在 `writeAndVerify`，事后无法单独判定 | **本轮修复** |

### 1.2 接收链（A / B / D 层）

| # | 现象 | 根因 | 状态 |
|---|---|---|---|
| 4 | 译文渲染到聊天底部 / 气泡外 | `hostOf()` 层层兜底到 `node` 本身，调用方拿到非空节点就 append；且 `paint` **先无条件删掉 chip** 再判断画不画 | **本轮修复** |
| 5 | 「翻译中…」永久卡住 | `runManualTranslate` 是 async，调用处的 `try/catch` **接不到 await 之后的异常** → chip 永远停在 busy，且无 trace | **本轮修复** |
| 6 | 同一条重复点击 / 重复扣费 | 无 busy/done 状态闸，只靠文本级 `pending` 去重 | **本轮修复** |
| 7 | 时间 / 已读 / View group / 链接预览进译文 | 曾直接取 `innerText/textContent` | 已修（前序轮，严格 parser） |
| 10 | WhatsApp 群被判成私聊 | 旧逻辑只认 Telegram/header 文案 | 已修（前序轮，`@g.us` + 仅扫 `#main`） |

### 1.3 设置与并发（实例层）

| # | 现象 | 根因 | 状态 |
|---|---|---|---|
| 8 | 群组「手动」仍自动翻译扣费 | 手动只是 UI 差异，未从 API 调用源头阻断 | 已修（前序轮） |
| 9 | 群组「自动」把历史消息也翻了 | 缺历史基线闸 | 已修（前序轮，`historyGate`） |
| 11 | 新子账号无法切 GPT / DeepSeek | 基础版套餐被锁死通道 | 已修（前序轮，migration 043） |
| 12 | 账号级 / 实例级设置边界混乱 | 实例 groupMode 静默覆盖账号级 | 已修（前序轮，三态 inherit） |
| 13 | `saveOpenApps` 并发覆盖丢设置 | 整文件"后写覆盖前写" | 已修（前序轮，按 tab 合并） |
| 14 | `paintTransBar` 锁不释放 | 无 `try/finally` | 已修（前序轮，`app.js:1576/1595`） |

> 复现脚本本身的一处**不确定性**也一并处理：`verify-manual-chip.js` 场景 14 用固定
> `sleep(400)` 等待，机器负载高时会偶发 16/17。本轮改为**轮询等待**（`until()`），
> 消除"同一份代码有时过、有时不过"的取证噪声。

---

## 2. 新状态机

### 2.1 发送翻译状态机（C 层）

```
idle → captured → translating → translated → sending → sent
                     │
                     ├─→ failed → retrying → translated → sending → sent
                     │                └─→ failed（重试再次失败，仍不发任何内容）
                     └─→ （任何异常/超时/余额不足/DOM 异常）→ failed，一个字节都不发
```

- 每个**用户发送动作**生成一个 `sendActionId`；同一次动作的网络重试**复用**该身份（幂等）。
- 用户再次主动发送相同文本 → **新** `sendActionId`（不使用文本内容本身当 requestId）。
- 本轮的可见状态：`正在重试…` → 成功收起 / 失败显示 `重试失败`。

### 2.2 手动点译状态机（A / B / D 层）

```
idle → translating(busy) → translated(done)   按钮移除，译文已绑定原消息
              │
              ├─→ failed（保留「译」按钮 = 可重试）
              └─→ busy/done 期间再次点击 → 直接忽略（MANUAL_CLICK_IGNORED）
```

**收口保证**：`runManualTranslate` 全程包 `try/catch/finally`；`finally` 里有
`MANUAL_CHAIN_FORCED_RESOLVE` 兜底 —— 无论成功 / 失败 / 抛错 / DOM 丢失，
都**不允许**永久停在 `translating`。

### 2.3 渲染位置硬约束

```
translation response
   → 用稳定 key（data-id）重新查询当前 DOM            ← 绝不长期持有裸 HTMLElement
   → isMessageHost(host)?  ── 否 ─→ TRANSLATION_RENDER_TARGET_MISSING，不绘制
   → 是 → 绘制；只有**真的画出译文**才移除「译」按钮
```

`isMessageHost` 要求：节点不在 `#main/#msg-list/#app/pane-side` 内、必须在 `#main` 内、
且**必须挂在带 `data-id` 的消息行内**。宁可不显示，也绝不 append 到聊天根节点 / 底部。

---

## 3. 修改文件（本轮）

| 文件 | 改动 |
|---|---|
| `desktop/guest-inject.js` | 手动链 `try/catch/finally` + 收口兜底；`chipStateOf` + busy/done 重复点击闸；`setChipState` 新增 `done`；`isMessageHost` 硬守卫 + `clearTransBox`；`paint` 返回布尔且"先画成再删按钮"；`runManualTranslate` 拆出 `manualTranslateInner`；trace 改名对齐规范（`SOURCE_EXTRACTED`/`TARGET_RELOCATED`/`TRANSLATION_RENDERED`/`TRANSLATION_RENDER_TARGET_MISSING`）并补 `chain` 判别字段；发送链补 `FINAL_TEXT_VALIDATED`；失败提示补「正在重试…」「重试失败」+ `actions:false`/`sticky` |
| `scripts/verify-manual-chip.js` | 固定 `sleep` → 轮询 `until()`；新增场景 17/18/19/20；trace 名对齐 |
| `scripts/forensics-chip-click.js` | 期望事件名对齐新规范 |
| `scripts/rc-trace-triage.js` | 新增 `EVENT_ALIAS` 归一化（新旧日志都能判）；`SEND_ORDER` 补 `FINAL_TEXT_VALIDATED`；`chainOf` 优先用 `chain` 字段；`judgeManual` 重写覆盖新状态（重复点击忽略 / 收口兜底 / 渲染目标缺失 / drew=false） |
| `test/desktop-manual-chip-state.test.js` | **新增**：5 条源码级硬规则守卫（finally / busy-done 闸 / isMessageHost / trace 规范名 / 重试可见状态） |
| `test/group-billing-guard.test.js` | 更新源码守卫断言以匹配更强的 `isMessageHost` 守卫 |
| `desktop/package.json` | 版本号 0.1.15 → **0.1.16**（顺延，供候选包构建） |
| `deploy/suspend-client-0.1.15.sql` | **新增**：暂停 0.1.15 候选（回到 NO RELEASE，不回滚 0.1.14，含防御性断言） |
| `docs/WhatsApp-Translation-Bridge-稳定化验收报告.md` | **新增**：本报告 |
| `0.1.16-验收包/` | **新增**：四个候选安装包 + `SHA256SUMS.txt` + 真机验收手册 + `rc016-collect.sh`/`rc016-collect.ps1`（二进制已被 `.gitignore` 挡住，不进 Git） |

> 前序轮次已落地、仍在当前工作区的相关文件（本报告引用其行号作为证据）：
> `desktop/main.js`（`saveOpenApps` 按 tab 合并、三态 inherit）、
> `desktop/renderer/app.js`（`paintTransBar` try/finally）、
> migration `043`、`deploy/register-client-0.1.15.sql`。

---

## 4. 自动测试结果

### 4.1 全量测试

```
node --test test/*.test.js
ℹ tests 927   ℹ pass 913   ℹ fail 0   ℹ skipped 14
```

### 4.2 五条取证脚本

| 脚本 | 结果 | 覆盖 |
|---|---|---|
| `verify-manual-chip.js` | **21 / 21** | 点译全链路 + 本轮新增 17（目标行消失→离开 busy 且不画到根节点）/18（busy 连点 3 次=1 请求）/19（已有译文再点=0 请求）/20（非消息宿主不挂按钮不绘制） |
| `forensics-busy-leak.js` | **11 / 11**，占位符泄漏 **0** | 发送链 fail-closed：写回被拒 / 断线 / 连发 5 条 / 草稿保护 |
| `verify-send-state-machine.js` | **全部通过** | 发送状态机迁移与拦截 |
| `forensics-chip-click.js` | **全部通过（5/5）** | 旧实现静默失效机制复现 + 新实现正常 + trace 完整 + 失败码不静默 |
| `verify-preload-load.js` | **全部 20 项通过** | 产物执行级校验（能拦住"装得上但一加载就崩"的版本） |

### 4.3 分诊脚本回归

| 输入 | 结果 |
|---|---|
| 新格式（含 `chain` 字段、`FINAL_TEXT_VALIDATED`） | 链 A ✔ 成功、链 B ✔ 成功 |
| 旧格式（`MANUAL_PARSED`/`MANUAL_REQUEST`/… 无 `chain`） | 链 A ✔ 成功（兼容） |

---

## 5. Mac 真机矩阵

> **状态：未执行（NOT RUN）**
> 候选包 `0.1.16-验收包/` 已就绪，可用它逐项验收。以下为**必须逐项打勾**的矩阵，
> 请你装包后回传 `rc016-evidence-*.txt`（完整清单见 `0.1.16-验收包/0.1.16-真机验收手册.md` §3）。

| 维度 | 用例 | 结果 | 证据 |
|---|---|---|---|
| 接收 | manual_click 私聊 / 群聊 | ⬜ | |
| 接收 | auto_receive 新消息 / 历史消息 | ⬜ | |
| 接收 | 长文本 / URL / emoji / 群邀请链接 | ⬜ | |
| 接收 | 滚动期间点译 / 连续点多条 | ⬜ | |
| 接收 | 点译后译文绑定**原消息**（非底部） | ⬜ | |
| 接收 | 失败 → 按钮保留可重试（非消失） | ⬜ | |
| 接收 | 慢接口 → 「翻译中…」最终必然收口 | ⬜ | |
| 发送 | 中文→英文 / 英文→中文 | ⬜ | |
| 发送 | Enter / 点发送按钮 / 中文输入法 composition | ⬜ | |
| 发送 | 对方**永远**看不到 `[正在翻译中...]` | ⬜ | |
| 发送 | API 慢 5 秒 / API 失败 / 余额不足 → 不发原文 | ⬜ | |
| 发送 | 重试 → 正在重试… → 发出译文一次 | ⬜ | |
| 发送 | 发送原文（显式点击） | ⬜ | |
| 发送 | 连续快速发送 5 条 | ⬜ | |
| 通道 | GPT ↔ DeepSeek 切换（私聊/群聊） | ⬜ | |
| 隔离 | 多实例设置互不串 | ⬜ | |

## 6. Windows 真机矩阵

> **状态：未执行（NOT RUN）** —— 同 Mac，逐项同上表（Windows 侧另需覆盖便携版 / Setup 两个产物）。

---

## 7. translate_logs / char_balance 对账

> **状态：阻塞（BLOCKED）**
> 本会话 `.env.local` 的 `DATABASE_URL` 指向本地库 `hello_pix`（不存在），
> 无法连生产库。需要你提供生产 DSN（或允许我从你机器上的既有连接取用）。

对账口径（待数据到位后逐条跑）：

```sql
-- 1) 手动模式未点击 → 必须 0 条
SELECT count(*) FROM translate_logs
WHERE created_at > :since AND trigger = 'manual_click' AND chat_kind = 'group'
  AND instance_group_mode = 'manual' AND clicked = false;
-- 期望 0

-- 2) 同一动作不重复扣费 → 同一 request_id 只应有 1 条
SELECT request_id, count(*) FROM translate_logs
WHERE created_at > :since GROUP BY request_id HAVING count(*) > 1;
-- 期望空

-- 3) 历史消息不自动翻 → auto_receive 不应命中历史窗口
SELECT trigger, count(*) FROM translate_logs
WHERE created_at > :since GROUP BY trigger;
-- 期望：auto_receive 条数 ≈ 真机实际"新消息"数，不随打开群聊暴涨

-- 4) 通道分布与实例设置一致（GPT / DeepSeek 都要出现）
SELECT engine, count(*) FROM translate_logs WHERE created_at > :since GROUP BY engine;

-- 5) 余额对账：translate_logs 计费字符 = char_balance 扣减
--    逐账号比对，差额必须为 0
```

---

## 8. 已知剩余问题

1. **真机矩阵完全未跑** —— 这是本轮唯一"没做"的核心交付，也是 NO RELEASE 的首要原因。
2. **生产对账阻塞** —— 无生产库访问。
3. **`translating` 的 `finally` 兜底路径**在本轮只能由"目标行消失"这一等价场景覆盖；
   真正的"await 之后抛任意异常"难以在不污染定期扫描的前提下注入，已用**源码级守卫测试**补位。
4. **历史版本客户端**导出的旧 trace 名依赖 `EVENT_ALIAS` 兼容；若旧版本更早，可能仍有未收录名。
5. **发送链重试的可见状态**目前是提示条文案切换，未做独立组件；功能达标但视觉可再打磨（属"新 UI"，本轮不做）。

---

## 9. 最终结论

### ❌ NO RELEASE

依据你自己的「七、最终通过标准」，第 14 条（**Mac / Windows 真机全部通过**）**未满足**，
第 12/13 条的生产侧对账也未取证。代码与自动化证据已就绪，但**没有真机证据就不算 PASS**。

**当前已完成（本轮）**：

1. ✅ 代码收口（发送链 / 接收链 / 状态机 / 渲染 / 重复扣费 / trace）。
2. ✅ 升版 **0.1.16**，构建四个候选包并做**执行级产物校验**（三平台 asar 各 20/20）。
3. ✅ 验收包 `0.1.16-验收包/`：四个安装包 + `SHA256SUMS.txt` + 真机验收手册 +
   `rc016-collect.sh`（macOS）/ `rc016-collect.ps1`（Windows）。
4. ✅ 暂停 0.1.15 候选的 SQL 已写好（`deploy/suspend-client-0.1.15.sql`，**待你执行**）。

**放行前置条件（缺一不可）**：

1. ⬜ 你执行 `deploy/suspend-client-0.1.15.sql`（回到 NO RELEASE；**不回滚 0.1.14**）。
2. ⬜ 你完成真机矩阵（§5 / §6），回传 `rc016-evidence-*.txt`。
3. ⬜ 生产库对账 §7 全绿（需要你提供生产 DSN）。
4. ⬜ 上述全绿后，本报告由 NO RELEASE 改为 RELEASE，并授权上架。

---

## 10. 生产操作待确认（需要你明确点头）

1. **执行 `deploy/suspend-client-0.1.15.sql`**：把 0.1.15 在 windows / macos 下的记录
   停用，回到"无下载候选"。脚本内含防御性断言（若仍有任何 enabled 记录会直接报错），
   且**不会**重新启用 0.1.14。本会话拿不到生产库，需要你执行。
2. **0.1.16 候选包**：已交付，**未上架**。等你真机全 PASS 后，我再写
   `deploy/register-client-0.1.16.sql` 并申请授权上架。
3. **是否提交本轮代码**：改动目前仍在工作区未提交（`desktop/guest-inject.js`、
   `desktop/package.json`、测试与脚本、文档、suspend SQL）。需要我提交请说一声。
