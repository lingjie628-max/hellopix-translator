-- 登记 1.2.0 客户端发布记录。产物已上传并逐一比对 SHA256。
--
-- 本版内容（相对 1.1.2，纯客户端 + 服务端配套修复）：
--   1. 账号到期后立即失效：以前只登录时检查到期，已登录的客户端还能一直翻；
--      现在每个请求都校验，到期当场拒绝。
--   2. 分配字符不会重复扣：双击/网络重试不再扣两次。
--   3. 关闭窗口二次确认按钮不再被 WhatsApp 浮层盖住。
--   4. 桌面端重启后不会卡在"翻译已被结算"的 409。
--   5. 管理后台改翻译通道描述不再误关引擎。
--
-- 产物指纹（本地构建与服务器逐字节一致，sha256sum 实测）：
--   HelloPix-1.2.0-arm64.dmg      4706a690078213f27064b5e5a1128e5cafca41b1e71cc295e98de7c0c419c99b
--   HelloPix-1.2.0-x64.dmg        66b137ec54cedca40b900d1610e1be0c1b06c727513833c9aec45049cb7a6e9d
--   HelloPix-Setup-1.2.0.exe      c0349912b48c1c771bb2d7be98230595f5fe572378f7d422e786bd1fff3e0c70
--   HelloPix-1.2.0-portable.exe   5eb67798be93bf7cd66c96bf18492d05f8bfe99fe862056871e341ea68819281
--
-- 三份 asar 同源：mac-arm64 / mac-x64 / win-unpacked 的 app.asar
--   sha256 = 400b14688d1cfb66f3e05e323254d62e8cc1a80e2ae97c36c8cd3f7dc1a49a1c（三份完全相同）
--
-- 幂等：重复执行只更新字段，不会插入重复行。
BEGIN;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note) VALUES
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '1.2.0',
   'https://pixfanyi.com/downloads/HelloPix-1.2.0-arm64.dmg', true,
   '本次更新：账号到期后会立即生效（以前到期了还能继续用一段时间）；分配字符不会因为双击或网络重试被扣两次；修复关闭窗口时确认按钮被遮挡点不到的问题；修复重启后个别人卡在"翻译失败"的情况。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '1.2.0',
   'https://pixfanyi.com/downloads/HelloPix-1.2.0-x64.dmg', true,
   '本次更新：账号到期后会立即生效（以前到期了还能继续用一段时间）；分配字符不会因为双击或网络重试被扣两次；修复关闭窗口时确认按钮被遮挡点不到的问题；修复重启后个别人卡在"翻译失败"的情况。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('windows', 'Windows（64 位）', 'Windows', 'x64', '', '1.2.0',
   'https://pixfanyi.com/downloads/HelloPix-Setup-1.2.0.exe', true,
   '本次更新：账号到期后会立即生效（以前到期了还能继续用一段时间）；分配字符不会因为双击或网络重试被扣两次；修复关闭窗口时确认按钮被遮挡点不到的问题；修复重启后个别人卡在"翻译失败"的情况。')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET title = EXCLUDED.title,
      url = EXCLUDED.url,
      enabled = EXCLUDED.enabled,
      note = EXCLUDED.note,
      updated_at = now();

-- 停用旧版：每个 (os, arch) 只留 1.2.0 一条 enabled，
-- 否则同 arch 两条 enabled 时选中哪条取决于排序，会出现"有的用户收到新版、有的收不到"。
UPDATE client_releases
   SET enabled = false, updated_at = now()
 WHERE version <> '1.2.0' AND enabled;

-- 断言：每个 (os, arch, app) 必须恰好一条 enabled，否则直接回滚整个事务。
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

-- 核对：三个平台应全部为 1.2.0 且 enabled
SELECT os, arch, version, enabled, url
FROM client_releases WHERE enabled
ORDER BY os, arch;
