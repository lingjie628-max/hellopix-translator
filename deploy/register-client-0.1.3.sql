-- 登记 0.1.3 客户端版本，并停用旧记录。
--
-- 本版内容：
--   · 客户身份采集（Telegram peer id + WhatsApp chatId/手机号）
--   · 撞单提醒横幅（warn 模式，只提示不阻止操作）
--
-- 唯一约束是 (release_group, os, arch, app, version)，重复执行不会出错。
-- 旧记录**停用而不是删除**，留作回滚。
-- portable（免安装版）同样上传但不登记：与安装版同属 windows/x64，
-- 登记会撞唯一约束，且页面上摆两个 Windows 入口反而让用户困惑。

BEGIN;

UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE version <> '0.1.3' AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  ('windows', 'Windows 安装版', 'Windows', 'x64', '', '0.1.3',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.3.exe', true, ''),
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.3',
   'https://pixfanyi.com/downloads/HelloPix-0.1.3-arm64.dmg', true, ''),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.3',
   'https://pixfanyi.com/downloads/HelloPix-0.1.3-x64.dmg', true, '')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET url = EXCLUDED.url, title = EXCLUDED.title, enabled = true, updated_at = NOW();

COMMIT;

\echo '--- 登记结果 ---'
SELECT release_group, os, arch, version, enabled FROM client_releases ORDER BY enabled DESC, id;
