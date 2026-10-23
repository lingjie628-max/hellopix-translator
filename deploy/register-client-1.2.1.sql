-- 登记 1.2.1 客户端发布记录。产物已上传并逐一比对 SHA256。
--
-- 本版内容（相对 1.2.0）：
--   去掉模型给短句补的句末句点 —— "在吗" 译文不再变成 "Are you there."。
--   规则：只删模型自己加的（原文有句末标点就保留），不碰 。！？… 与小数。
--   客户端本地缓存里带点的旧译文也会在命中时一并修正并写回。
--
-- 产物指纹（本地构建与服务器逐字节一致，sha256sum 实测）：
--   HelloPix-1.2.1-arm64.dmg      a67cab725607f400a119e3325d0b750a4c1b7655779a8856101942c52f729896
--   HelloPix-1.2.1-x64.dmg        e6d5981ada5ad6b1682fc848bb198b5041ffda8e4c6087ba2dbc89974bd0716f
--   HelloPix-Setup-1.2.1.exe      a2ee400303779b858b8f053d9e56ffae6592aed6fb735c9d16715036234651d8
--   HelloPix-1.2.1-portable.exe   9c551adb614ee11ec8bee63d08b32d5f08751c5e875dd0d7c216f7b1103eab5e
--
-- 三份 asar 同源：mac-arm64 / mac-x64 / win-unpacked 的 app.asar
--   sha256 = 7089c4a5fb13baab8d1788a32e7339ab88f40b471319bbe63533ba436b081d20（三份完全相同）
--
-- 幂等：重复执行只更新字段，不会插入重复行。
BEGIN;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note) VALUES
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '1.2.1',
   'https://pixfanyi.com/downloads/HelloPix-1.2.1-arm64.dmg', true,
   '本次更新：去掉译文末尾多余的英文句点 —— 短句不会再变成 "Are you there." 这种带点的样子。你已经缓存过的旧译文也会自动修正。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '1.2.1',
   'https://pixfanyi.com/downloads/HelloPix-1.2.1-x64.dmg', true,
   '本次更新：去掉译文末尾多余的英文句点 —— 短句不会再变成 "Are you there." 这种带点的样子。你已经缓存过的旧译文也会自动修正。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('windows', 'Windows（64 位）', 'Windows', 'x64', '', '1.2.1',
   'https://pixfanyi.com/downloads/HelloPix-Setup-1.2.1.exe', true,
   '本次更新：去掉译文末尾多余的英文句点 —— 短句不会再变成 "Are you there." 这种带点的样子。你已经缓存过的旧译文也会自动修正。')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET title = EXCLUDED.title,
      url = EXCLUDED.url,
      enabled = EXCLUDED.enabled,
      note = EXCLUDED.note,
      updated_at = now();

-- 停用旧版：每个 (os, arch) 只留 1.2.1 一条 enabled。
UPDATE client_releases
   SET enabled = false, updated_at = now()
 WHERE version <> '1.2.1' AND enabled;

-- 断言：每个 (os, arch, app) 必须恰好一条 enabled，否则回滚整个事务。
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM (
    SELECT 1 FROM client_releases WHERE enabled
     GROUP BY os, arch, app HAVING count(*) <> 1
  ) t;
  IF bad > 0 THEN
    RAISE EXCEPTION '同一 (os,arch,app) 存在多条 enabled 记录，拒绝提交';
  END IF;
END $$;

COMMIT;

SELECT os, arch, version, enabled, url
FROM client_releases WHERE enabled
ORDER BY os, arch;
