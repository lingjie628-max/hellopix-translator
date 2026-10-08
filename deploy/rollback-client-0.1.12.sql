-- 紧急止血：撤下 0.1.12，恢复 0.1.11。
--
-- 为什么必须撤：0.1.12 的翻译功能**整体失效**，且开启「发送翻译」时会把
-- **中文原文直接发送**给对话方。
--
-- 根因（客户端，装载阶段）：
--
--     desktop/guest-inject.js:63   const historyGate = MessageParser.createHistoryGate()
--     desktop/guest-inject.js:248  var MessageParser = (function () { ... })()
--
--   `var` 提升后是 undefined，第 63 行执行即抛
--   `TypeError: Cannot read properties of undefined (reading 'createHistoryGate')`。
--   guest-inject.js 是 preload 脚本，一抛错**整份停摆** —— 后面所有
--   `addEventListener` 都不会执行。于是：
--     · keydown / click 监听器不存在 → Enter 与发送按钮都不被拦
--       → 「发送翻译」形同关闭，中文原文直通 WhatsApp
--     · scan 不存在 → 群聊自动翻译（auto_receive）一条都不触发
--     · 界面毫无提示（错误只进 webContents 控制台）
--
-- 为什么回滚到 0.1.11 而不是 0.1.10：
--   0.1.11 的 `guest-inject.js` 里根本没有 MessageParser/historyGate
--   （已核对：HEAD 版只有 777 行，无该符号），**装载正常**，发送翻译可用。
--   而 0.1.10 正是「群聊手动模式会扣费 + UI 文案进翻译 + 占位符会被发出」
--   三个 P0 的版本 —— 回滚到 0.1.10 会把那三条重新放回线上。
--
-- 回滚目标的文件已核对指纹（与 0.1.11 上架留档逐字节一致，文件仍在服务器上）：
--   HelloPix-Setup-0.1.11.exe     44bdba7a420e0f2910b0b46fd81e4d70a5b7e01ba7ff3cfd586ce6556f2000f1
--   HelloPix-0.1.11-portable.exe  170a8306e572028ab007627bcd48c28f18e870d04edf03c975e2f06709ab88e7
--   HelloPix-0.1.11-arm64.dmg     f596b5007813a3aa74511d34d3656a06f4113778395d54cf524d26f4083a43d1
--   HelloPix-0.1.11-x64.dmg       f009681e601d0b8b4de47e92bca5426e421d589a1641e48e1414b8bbaecd472b
--
-- 注意：回滚只让**更新提示与下载页**回到 0.1.11，**不会**把已经装成 0.1.12 的
-- 用户变回去。已装 0.1.12 的用户必须靠一个**版本号更大**的包（0.1.13）才能修好。
-- 所以这是止血，不是修复。
--
-- 记录一律**停用而不是删除**，留作回滚。

BEGIN;

-- 1) 撤下 0.1.12（坏包）
UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE release_group IN ('windows', 'macos')
  AND version = '0.1.12'
  AND enabled = true;

-- 2) 恢复 0.1.11（已知可用的最后一个版本）
UPDATE client_releases
SET enabled = true, updated_at = NOW()
WHERE release_group IN ('windows', 'macos')
  AND version = '0.1.11';

COMMIT;

\echo '--- 生效记录（每个 os/arch 应当只有一条 enabled = true）---'
SELECT release_group, os, arch, version, enabled
FROM client_releases
WHERE enabled = true
ORDER BY release_group, arch;

\echo '--- 全表末尾 ---'
SELECT id, release_group, os, arch, version, enabled FROM client_releases ORDER BY id DESC LIMIT 8;
