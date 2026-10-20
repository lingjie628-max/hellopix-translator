-- 回滚 0.1.43 SQL 里那条错误的停用：Intel Mac 必须继续拿到 0.1.42。
--
-- 原因：core-service 的 download() 在某个 release_group 一条启用记录都没有时
-- 返回空串，下载按钮会直接消失。x64 没有 0.1.43 包，停用 0.1.42 等于把
-- Intel 用户的下载入口一起关掉。正确做法是保留 0.1.42 作为回退。
UPDATE client_releases
   SET enabled = true, updated_at = now()
 WHERE os = 'macOS' AND arch = 'x64' AND version = '0.1.42';

SELECT DISTINCT ON (os, arch, app) os, arch, version, enabled, url
FROM client_releases WHERE enabled
ORDER BY os, arch, app, created_at DESC;
