-- 登记 0.1.40 客户端发布记录（对应 /opt/hello-pix/downloads/ 下已核验 SHA256 的四个产物）。
-- 本版内容：窗口顺序支持拖拽自定义排序、顶部标签右键重命名、翻译速度优化。
-- 幂等：重复执行只更新 note/title/url，不会插入重复行。
BEGIN;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note) VALUES
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.40',
   'https://pixfanyi.com/downloads/HelloPix-0.1.40-arm64.dmg', true,
   '本次更新：① 上方的应用窗口现在可以按住拖动，自定义调整左右顺序，关掉重开也会记住；② 在顶部应用标签上点右键，可以直接重命名窗口，不用再进设置；③ 翻译速度进一步优化，响应更快。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.40',
   'https://pixfanyi.com/downloads/HelloPix-0.1.40-x64.dmg', true,
   '本次更新：① 上方的应用窗口现在可以按住拖动，自定义调整左右顺序，关掉重开也会记住；② 在顶部应用标签上点右键，可以直接重命名窗口，不用再进设置；③ 翻译速度进一步优化，响应更快。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('windows', 'Windows（64 位）', 'Windows', 'x64', '', '0.1.40',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.40.exe', true,
   '本次更新：① 上方的应用窗口现在可以按住拖动，自定义调整左右顺序，关掉重开也会记住；② 在顶部应用标签上点右键，可以直接重命名窗口，不用再进设置；③ 翻译速度进一步优化，响应更快。')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET title = EXCLUDED.title,
      url = EXCLUDED.url,
      enabled = EXCLUDED.enabled,
      note = EXCLUDED.note,
      updated_at = now();

COMMIT;

-- 核对
SELECT release_group, os, arch, version, enabled, url
FROM client_releases WHERE version = '0.1.40' ORDER BY os, arch;
