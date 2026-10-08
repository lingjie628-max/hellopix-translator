-- 登记 0.1.13 客户端版本（Windows x64 + macOS 双架构），并下架各平台旧记录。
--
-- 0.1.13 是 **0.1.12 的紧急热修复**：0.1.12 的翻译功能整体失效，且开启
-- 「发送翻译」时会把中文原文直接发给对话方。0.1.12 已撤下（见
-- `deploy/rollback-client-0.1.12.sql`），本版把它修好重新上架。
--
-- 本版**完整包含** 0.1.12 原定的全部内容（见 register-client-0.1.12.sql 的
-- 第 1–6 条：群聊身份串到左侧列表、群组翻译静默压回手动、实例设置互相覆盖、
-- 翻译失败静默、通道显示与实际调用不一致、放开基础版通道切换）。
-- 在它们之上新增三个**独立**缺陷的修复：
--
--   A) 装载即崩 —— 整个翻译链路从未启动（P0，阻断级；0.1.12 的致命伤）
--
--      现象：真机 0.1.12 上，开启「发送翻译」后输入中文按回车，
--            **中文原文被直接发送**；群聊「群组翻译 = 自动」也一条都不翻。
--            界面上没有任何报错。
--      根因：
--          desktop/guest-inject.js:63   const historyGate = MessageParser.createHistoryGate()
--          desktop/guest-inject.js:248  var MessageParser = (function () { ... })()
--        `var` 会提升但值是 undefined，第 63 行执行即抛
--        `TypeError: Cannot read properties of undefined (reading 'createHistoryGate')`。
--        guest-inject.js 是 preload 脚本，一抛错**整份停摆** —— 之后所有
--        `document.addEventListener` 都不执行：
--          · keydown / click 监听器不存在 → Enter 与发送按钮都不被拦
--            → 「发送翻译」形同关闭，中文原文直通 WhatsApp
--          · scan 不存在 → 群聊自动翻译（auto_receive）一条都不触发
--      修法：`historyGate` 的初始化挪到解析器模块（BEGIN/END）定义之后。
--
--      为什么上一轮的「asar 内含全部修复」没拦住：那次是**在 asar 字节里搜关键字**，
--      关键字全在，于是判定通过 —— 字符串搜索永远发现不了装载期错误。
--      本版新增 `scripts/verify-preload-load.js`（`npm run verify:client`）：
--      从 asar 里取出 preload **真的跑一遍**，验证拦截器挂上了、失败时真的不发。
--      对已上架的 0.1.12 它会报 11 项阻断问题并 exit 1。
--
--   B) 翻译失败时静默降级成"发原文"（P0）
--
--      现象：超时 / 断网 / 余额不足 / 通道不在套餐里 → 把中文原文发了出去。
--            用户以为在用"发送翻译"，对方收到一段看不懂的中文，
--            而且这一下是**用户没同意**的发送动作。
--      根因：`const finalText = out ? 译文 : raw; fireSend(box)` ——
--            翻译拿不到译文（`out` 为空串）就用原文兜底，然后照常发送。
--      修法：改为 `deliverSend()`，「翻译成功才发送」：
--            翻译没成功 → **一个字节都不发**，原文退回输入框，
--            弹可操作提示「翻译失败，消息尚未发送」+ 两个**必须自己点**的出口：
--              · 重试翻译 —— 再翻一次，成功才发
--              · 发送原文 —— 用户明确点击才发未翻译的原文
--            不做静默降级，也不做无提示。
--
--   C) 发送路径不声明调用来源（P1）
--      根因：`translateText(masked.masked, false)` 只传两个参数，trigger 恒为空串
--            → `translate_logs.trigger` 里**永远不会出现 manual_send**，事后审计无法归因。
--      修法：新增 `TRIGGER_SEND = 'manual_send'` 并在发送路径传入。
--
-- 测试：全量 895（0.1.13 新增 32 条发送翻译用例，见
--       `test/desktop-send-translate.test.js`，含"失败一个字节都不发"、
--       "API 慢 5 秒不漏出原文"、"Enter 与发送按钮一致"、"群聊与私聊一致"、
--       "trigger=manual_send"、"并发按 Enter 只算一次"）。
--       产物执行级校验 `npm run verify:client`：14/14 通过。
--
-- 为什么必须升到 0.1.13，而不是原地重打 0.1.12：
--   ① 客户端更新判定是 cmpVer(remote, local) > 0 —— **严格大于**。0.1.12 已经
--      被用户下载安装（且它是坏包），沿用 0.1.12 重打的话这些用户永远收不到修复。
--   ② electron-builder 构建不可复现，同版本重打会造成"同版本不同内容"的排查困境 ——
--      而这次恰恰是最需要"同一个文件 = 验收过的文件"的一次。
--
-- portable（免安装版）同样上传但不登记：与安装版同属 windows/x64，
-- 登记会撞唯一约束，且页面上摆两个 Windows 入口反而让用户困惑。
--
-- 唯一约束是 (release_group, os, arch, app, version)，重复执行不会出错。
-- 旧记录**停用而不是删除**，留作回滚。

BEGIN;

-- 只停用 windows / macos 的旧记录；其他 release_group 不动
UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE release_group IN ('windows', 'macos')
  AND version <> '0.1.13'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  ('windows', 'Windows 安装版', 'Windows', 'x64', '', '0.1.13',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.13.exe', true,
   '紧急修复 0.1.12 的致命问题：翻译功能整体失效、开启发送翻译会把中文原文直接发出（预加载脚本装载即崩，拦截器从未启动）。同时修好翻译失败静默降级发原文、发送翻译不记录计费来源；并完整包含群聊自动翻译、多开设置互相覆盖、通道自选等修复'),
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.13',
   'https://pixfanyi.com/downloads/HelloPix-0.1.13-arm64.dmg', true,
   '紧急修复 0.1.12 翻译完全失效、发送翻译会直发原文的问题；翻译失败不再发出原文而是给出「重试翻译 / 发送原文」选择。含群聊自动翻译与多开设置修复。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.13',
   'https://pixfanyi.com/downloads/HelloPix-0.1.13-x64.dmg', true,
   '紧急修复 0.1.12 翻译完全失效、发送翻译会直发原文的问题；翻译失败不再发出原文而是给出「重试翻译 / 发送原文」选择。含群聊自动翻译与多开设置修复。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET url = EXCLUDED.url, title = EXCLUDED.title, enabled = true,
      note = EXCLUDED.note, updated_at = NOW();

COMMIT;

\echo '--- 登记结果 ---'
SELECT release_group, os, arch, version, enabled FROM client_releases
ORDER BY enabled DESC, id;
