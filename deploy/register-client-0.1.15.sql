-- 登记 0.1.15 客户端版本（Windows x64 + macOS 双架构），并下架各平台旧记录。
--
-- ## 为什么会有 0.1.15
--
-- 0.1.14 修掉了 0.1.12/0.1.13 的装载与"翻译失败发原文"一族问题，但真机验收又暴露
-- 出**两条互相独立的链**同时坏掉。用户明确要求两条链分开处理、都 PASS 才允许再发：
--
--     A. 接收消息手动翻译（manual_click）—— 点「译」按钮毫无反应
--     B. 发送翻译（manual_send）—— 会丢用户内容，以及「发送原文」发不出去
--
-- 本版把两条链的根因分别定位并修掉，且各自补上结构化 trace（事后可定性）与
-- 可见状态（失败不再静默）。
--
-- ---
-- ## 链 A · 点「译」按钮静默失效（P0）
--
-- 现象：新消息正常送达、消息下方已出现「译」按钮，点它**什么都不发生** ——
--       没有译文、没有提示、按钮也消失。
--
-- 根因（三条叠加）：
--   A1) `addClick()` 逐 chip 绑 `onclick`，并把 `host` / `root` 两个**裸 DOM 引用**
--       闭包捕获，跨越 `await` 再使用。WhatsApp 是 React 托管的列表，重绘会把
--       这些节点换掉；拿已 detach 的节点去解析 → 正文为空 → `translateParsed`
--       返回空串 → `paint(host, '')` 走 clearExtras() 顺手删掉按钮 →
--       **按钮消失、无译文、无提示**。真机表现就是"点了没反应"。
--   A2) chip 没有 `pointer-events: auto` / `z-index`。WhatsApp 消息层在若干状态下
--       会关掉 pointer-events，继承下来就是"看得见、点不动"。
--   A3) 整条链**一行 trace 都没有**，也没有任何失败反馈 —— 事后无法回答"断在哪一步"。
--
-- 修法：
--   · 事件委托挂到 `document` **捕获阶段**（重绘丢不掉；且不受消息区
--     冒泡阶段 stopPropagation 影响），不再给每个动态 chip 单独绑 listener；
--   · 点击时保存 `stableMessageKey`（消息行的 `data-id`），翻译完成后再按 key
--     **重新查询当前气泡**再渲染，绝不长期持有裸 DOM；
--   · chip 三态：`译` → `翻译中…` → 成功显示译文 / 失败显示 `翻译失败 · 点击重试`；
--     翻译中状态只活在 Hello Pix 自己的控件上，**绝不写入输入框或消息正文**；
--   · `translateTextDetailed()` 原样回报真实错误码（余额不足 / 通道不在套餐 /
--     断线 / 空结果），不再统一压成空串；
--   · 结构化 trace：MANUAL_TRANSLATE_CLICK → MANUAL_PARSED → MANUAL_REQUEST →
--     MANUAL_RESPONSE → MANUAL_RENDERED，全部带同一 sendActionId，
--     并记录 messageId / tabId / partition / engine / sourceTextLen；
--     失败分支：MANUAL_ROW_LOST / MESSAGE_TEXT_EXTRACTION_FAILED /
--     MANUAL_RENDER_MISSED / MANUAL_FAILED / MANUAL_CLIENT_EXCEPTION。
--
-- ---
-- ## 链 B · 发送翻译会丢用户内容（P0）
--
-- 现象一（草稿被吃）：用户按发送后开始打**下一条**，第一条译文回来时把草稿整段
--   覆盖并发出去，用户正在打的内容凭空消失（真机已复现）。
-- 现象二（连发丢消息）：连续快速发送 5 条，实际只发出 3 条，中间几条被静默丢弃。
--
-- 根因：
--   B1) `deliverSend()` 写回译文前**没有任何"用户已改动输入框"的检查**，是无条件覆盖。
--       翻译失败时的兜底 `writeComposer(box, raw)` 同样会盖掉草稿。
--   B2) `fireSend()` 用 `setTimeout(..., 400)` 开了一个 400ms 的 suppression 时间窗，
--       窗口内**任何**发送事件都被当成"我们自己发的"处理 —— 用户在这 400ms 里按的
--       回车被静默吃掉。
--   B3) 更隐蔽：上一条动作的 400ms `sendActionPhase` 复位定时器会清掉下一条**正在飞**
--       的 phase，下一条走到 fireSendVerified 时被 STALE_ACTION 拦下 —— 表现成
--       "连发几条，中间几条消失"。
--
-- 修法：
--   · 写回前先 `composerDraftChanged(box, raw)`；有草稿则先存下、发出译文后
--     `writeAndVerify()` 把草稿放回输入框；放不回去**明说**并给提示（绝不静默丢内容）；
--   · `suppression` 改为**同步窗口**（`finally` 里立即复位），只覆盖我们自己那一次
--     发送，用户的下一次输入必然落在更晚的 task 上，永不被误吞；
--   · phase 复位定时器校验 `sendActionId === myAction`，只归自己那一次动作管。
--
-- ---
-- ## 链 B 附带 · 「发送原文」卡死循环（P0）
--
-- 翻译失败后的提示里有「重试翻译 / 发送原文」两个按钮。用户点「发送原文」**永远发不出去**：
-- 它走的是 `fireSendVerified()`，而那要求 `sendActionPhase === 'replaced'`；
-- 失败态下 phase 是 `translating`，永远不满足 → STALE_ACTION 拦下 → 什么都不发 →
-- 又弹回同一个失败提示，用户被卡在一个循环里。
--
-- 修法：拆出 `fireSendUserAuthorized()` —— 用户明确授权的发送不要求走完翻译状态机，
-- 但**保留** `sendableBody()` 校验（正文不得含占位符、必须等于预期），一点不放松。
--
-- ## 为什么必须升版本号，不能重打 0.1.14
--
--   ① 客户端更新判定是 cmpVer(remote, local) > 0 —— **严格大于**。0.1.14 已经
--      上架并可被下载，沿用同一个版本号的话，已经装到 0.1.14 的用户永远收不到修复。
--   ② electron-builder 构建不可复现，同版本重打会出现"同版本不同内容"——
--      而这次恰恰最需要"同一个文件 = 验收过的文件"。
--   ③ 0.1.14 已确认是坏的（点译失效 + 发送翻译丢内容），必须在更新接口上**停用**，
--      否则新用户会继续装到这一版。
--
-- ## 验收（发版前实测）
--
--   · 全量测试 922 条 / 908 通过 / 0 失败（14 跳过）
--   · 链 A：scripts/verify-manual-chip.js —— 17 / 17 通过
--           （新收 / 历史 / 长文 / 中文 / emoji / 文字+URL / 群聊 / 私聊 /
--             连点 3 条分别显示 / 同条连点 3 次只 1 次请求 / 余额不足 / 断线 /
--             正文提不出 / 消息行重绘 / trace 字段齐全 / 慢接口显示「翻译中…」）
--   · 链 A 取证：scripts/forensics-chip-click.js —— 5 / 5（含"旧实现确实静默失效"的机制实证）
--   · 链 B：scripts/verify-send-state-machine.js —— 11 / 11
--   · 链 B：scripts/forensics-busy-leak.js —— 11 / 11，**占位符泄漏 0 处**
--           （含"翻译期间用户打新消息草稿完整保留""连发 5 条 5 条都发出"）
--   · 产物**执行级**校验 `npm run verify:client`：每份 asar 20/20 通过（含模块齐全性与
--     版本号一致性），含"拦截流程抛错时 Enter 仍被拦截""抛错时对方什么都收不到"。
--
-- ## 真机取证入口
--
--   客户端日志：~/Library/Application Support/Hello Pix/logs/hello-pix-<日期>.log
--   分诊脚本：node scripts/rc-trace-triage.js
--     会把 manual_click 与 manual_send **两条链分别**还原成时间线，并对每次动作
--     直接判定断在哪一步（点击没到 / 正文提不出 / 没发请求 / 服务端错误码 / 渲染丢了）。
--
-- 唯一约束是 (release_group, os, arch, app, version)，重复执行不会出错。
-- 旧记录**停用而不是删除**，留作回滚。

BEGIN;

-- 只停用 windows / macos 的旧记录；其他 release_group 不动
UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE release_group IN ('windows', 'macos')
  AND version <> '0.1.15'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  ('windows', 'Windows 安装版', 'Windows', 'x64', '', '0.1.15',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.15.exe', true,
   '修复两处会丢用户内容的严重问题：1）点消息下方的「译」按钮没有反应（消息被重绘后按钮失效，现在按消息标识重新定位，并给出「翻译中…/翻译失败·点击重试」状态）；2）开启发送翻译时，翻译期间用户正在打的下一条可能被覆盖丢失、连续快速发送会丢消息，失败后的「发送原文」按钮点不动。本版不再把任何占位符写进输入框。'),
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.15',
   'https://pixfanyi.com/downloads/HelloPix-0.1.15-arm64.dmg', true,
   '修复「译」按钮点击无反应、以及发送翻译会丢用户内容（正在打的下一条被覆盖、连发丢消息、「发送原文」点不动）的问题。翻译失败或未完成时仍按原设计不发任何内容，并给出可操作提示。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.15',
   'https://pixfanyi.com/downloads/HelloPix-0.1.15-x64.dmg', true,
   '修复「译」按钮点击无反应、以及发送翻译会丢用户内容（正在打的下一条被覆盖、连发丢消息、「发送原文」点不动）的问题。翻译失败或未完成时仍按原设计不发任何内容，并给出可操作提示。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET url = EXCLUDED.url, title = EXCLUDED.title, enabled = true,
      note = EXCLUDED.note, updated_at = NOW();

COMMIT;

\echo '--- 登记结果 ---'
SELECT release_group, os, arch, version, enabled FROM client_releases
ORDER BY enabled DESC, id;
