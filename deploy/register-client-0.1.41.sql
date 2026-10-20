-- 登记 0.1.41 客户端发布记录。产物已上传并逐一比对 SHA256。
--
-- 本版内容：
--   1. 隐藏窗口（后台运行）：右键应用标签 → 隐藏该窗口。
--      进程原地保留（不掉号），但不再抢 CPU/GPU、不提醒新消息。
--   2. 垃圾桶改成只关勾选的窗口（之前没勾选会全关，误点即灾难）。
--   3. 全局修复后台窗口空转：backgroundThrottling 由 false 改为 true，
--      隐藏/后台窗口的定时器活动实测降低约 90%，缓解开多窗口后的卡顿。
--
-- 幂等：重复执行只更新字段，不会插入重复行。
BEGIN;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note) VALUES
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.41',
   'https://pixfanyi.com/downloads/HelloPix-0.1.41-arm64.dmg', true,
   '本次更新重点解决开多窗口后电脑变卡的问题。① 新增「隐藏窗口」：在顶部应用标签上点右键可以把它放到后台运行，界面不再占资源、也不会提醒新消息，但登录状态完整保留，点右侧的「后台运行」入口随时能叫回来，不用重新扫码。② 已启用的应用列表右侧的垃圾桶，现在只关闭你勾选的窗口；什么都没勾时会提示你先选，不会再一次性把账号全关掉。③ 整体降低了后台窗口的资源占用，开多个账号时更流畅。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.41',
   'https://pixfanyi.com/downloads/HelloPix-0.1.41-x64.dmg', true,
   '本次更新重点解决开多窗口后电脑变卡的问题。① 新增「隐藏窗口」：在顶部应用标签上点右键可以把它放到后台运行，界面不再占资源、也不会提醒新消息，但登录状态完整保留，点右侧的「后台运行」入口随时能叫回来，不用重新扫码。② 已启用的应用列表右侧的垃圾桶，现在只关闭你勾选的窗口；什么都没勾时会提示你先选，不会再一次性把账号全关掉。③ 整体降低了后台窗口的资源占用，开多个账号时更流畅。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('windows', 'Windows（64 位）', 'Windows', 'x64', '', '0.1.41',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.41.exe', true,
   '本次更新重点解决开多窗口后电脑变卡的问题。① 新增「隐藏窗口」：在顶部应用标签上点右键可以把它放到后台运行，界面不再占资源、也不会提醒新消息，但登录状态完整保留，点右侧的「后台运行」入口随时能叫回来，不用重新扫码。② 已启用的应用列表右侧的垃圾桶，现在只关闭你勾选的窗口；什么都没勾时会提示你先选，不会再一次性把账号全关掉。③ 整体降低了后台窗口的资源占用，开多个账号时更流畅。')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET title = EXCLUDED.title,
      url = EXCLUDED.url,
      enabled = EXCLUDED.enabled,
      note = EXCLUDED.note,
      updated_at = now();

COMMIT;

-- 核对：三个平台当前启用的应全是 0.1.41
SELECT DISTINCT ON (os, arch, app) os, arch, version, enabled, url
FROM client_releases WHERE enabled
ORDER BY os, arch, app, created_at DESC;
