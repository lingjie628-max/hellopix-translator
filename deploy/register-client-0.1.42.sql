-- 登记 0.1.42 客户端发布记录。产物已上传并逐一比对 SHA256。
--
-- 本版内容：关闭窗口加二次确认。
--   标签上的 ×、右键「关闭应用」、垃圾桶批量关闭，三条路径全部要确认；
--   确认框默认焦点在「取消」，ESC 一律视为取消；
--   底层 contextAction 的 close 也已封堵，不能再绕过确认直接关。
--
-- 幂等：重复执行只更新字段，不会插入重复行。
BEGIN;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note) VALUES
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.42',
   'https://pixfanyi.com/downloads/HelloPix-0.1.42-arm64.dmg', true,
   '本次更新：关闭窗口现在会先弹一次确认，点「关闭窗口」才会真的关，避免手滑误点把账号关了又要重新扫码。取消、按 ESC、点空白处都算不关，确认框默认停在「取消」上。如果只是想让某个窗口歇一歇，建议用右键菜单里的「隐藏该窗口」，登录状态会保留，随时能叫回来。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.42',
   'https://pixfanyi.com/downloads/HelloPix-0.1.42-x64.dmg', true,
   '本次更新：关闭窗口现在会先弹一次确认，点「关闭窗口」才会真的关，避免手滑误点把账号关了又要重新扫码。取消、按 ESC、点空白处都算不关，确认框默认停在「取消」上。如果只是想让某个窗口歇一歇，建议用右键菜单里的「隐藏该窗口」，登录状态会保留，随时能叫回来。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('windows', 'Windows（64 位）', 'Windows', 'x64', '', '0.1.42',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.42.exe', true,
   '本次更新：关闭窗口现在会先弹一次确认，点「关闭窗口」才会真的关，避免手滑误点把账号关了又要重新扫码。取消、按 ESC、点空白处都算不关，确认框默认停在「取消」上。如果只是想让某个窗口歇一歇，建议用右键菜单里的「隐藏该窗口」，登录状态会保留，随时能叫回来。')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET title = EXCLUDED.title,
      url = EXCLUDED.url,
      enabled = EXCLUDED.enabled,
      note = EXCLUDED.note,
      updated_at = now();

COMMIT;

-- 核对：三个平台当前启用的应全是 0.1.42
SELECT DISTINCT ON (os, arch, app) os, arch, version, enabled, url
FROM client_releases WHERE enabled
ORDER BY os, arch, app, created_at DESC;
