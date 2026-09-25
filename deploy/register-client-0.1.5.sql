-- 登记 0.1.5 客户端版本（Windows x64），并下架 Windows 旧记录。
--
-- 本版内容（相对 0.1.3）：
--   · 多开分区隔离（每进程独占槽位，槽位 2+ 分区名带 s2- 前缀）
--   · 消息归档（真实正文与时间落 messages 表）
--   · 窗口最小尺寸降到 900 × 560（原 1160 × 680）
--   · 关闭窗口后台运行（收进托盘 + 托盘可唤回 + 界面可关掉该行为）
--
-- 唯一约束是 (release_group, os, arch, app, version)，重复执行不会出错。
-- 旧记录**停用而不是删除**，留作回滚。
--
-- macOS 保持在 0.1.3：本次只构建了 Windows 目标（pack:win），
-- 给 macOS 登记一个不存在的包会让用户点到 404。等 pack:mac 之后另行登记。
--
-- portable（免安装版）同样上传但不登记：与安装版同属 windows/x64，
-- 登记会撞唯一约束，且页面上摆两个 Windows 入口反而让用户困惑。

BEGIN;

-- 只停用 Windows 的旧记录：macOS 的 0.1.3 是当前有效的，不能顺手关掉
UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE release_group = 'windows' AND version <> '0.1.5' AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  ('windows', 'Windows 安装版', 'Windows', 'x64', '', '0.1.5',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.5.exe', true,
   '含后台运行 / 多开分区隔离 / 消息归档 / 窗口最小 900x560')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET url = EXCLUDED.url, title = EXCLUDED.title, enabled = true,
      note = EXCLUDED.note, updated_at = NOW();

COMMIT;

\echo '--- 登记结果 ---'
SELECT release_group, os, arch, version, enabled FROM client_releases ORDER BY enabled DESC, id;
