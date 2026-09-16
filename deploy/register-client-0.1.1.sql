-- 登记 0.1.1 客户端版本，并停用 0.1.0 旧记录。
--
-- 背景：官网按 created_at DESC 取每个平台最新一条（见 core-service.siteInfo），
-- 所以新增记录即可自动生效；旧记录**停用而不是删除**，留作回滚。
--
-- 唯一约束是 (release_group, os, arch, app, version)，所以同版本重复执行不会出错。
-- portable（免安装版）同样上传但不登记：它和安装版同属 windows/x64，
-- 登记会撞唯一约束，且页面上摆两个 Windows 入口反而让用户困惑。

BEGIN;

-- 1) 停用旧版本
UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE version <> '0.1.1' AND enabled = true;

-- 2) 登记新版本
INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  ('windows', 'Windows 安装版', 'Windows', 'x64', '', '0.1.1',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.1.exe', true, ''),
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.1',
   'https://pixfanyi.com/downloads/HelloPix-0.1.1-arm64.dmg', true, ''),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.1',
   'https://pixfanyi.com/downloads/HelloPix-0.1.1-x64.dmg', true, '')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET url = EXCLUDED.url, title = EXCLUDED.title, enabled = true, updated_at = NOW();

COMMIT;

\echo '--- 登记结果 ---'
SELECT release_group, title, os, arch, version, enabled, url
FROM client_releases ORDER BY enabled DESC, id;
