-- 登记 0.1.37 客户端版本（macOS 双架构 + Windows 安装版），并停用同组旧记录。
--
-- ## 本版内容：崩溃日志自动上报 + 启动不再被同步采样阻塞
--
-- 起因：0.1.36 上线后用户反馈「打开就闪退」，但要日志时发现 ——
-- **日志只留在用户本机，服务端没有任何接收通道**。等于加了取证能力
-- 却没有把证据收回来的路，出问题仍然只能靠猜。
--
-- 0.1.36 的取证代码本身经复核**未发现启动崩溃点**（无新增 require、
-- 打包白名单完整、开发版与打包版均能正常启动）。
-- 因此本版的重点是把"看得到"补成"收得回"。
--
-- ## 修改
--
--   · 新增 desktop/crash-report.js：
--       客户端下次启动时，把**上一次异常退出**留下的 crash/memory 行
--       自动送到服务端，用户无感。
--   · 新增 POST /apis/client/crash-report：
--       公开接口（启动即闪退时还没登录，必须允许匿名上报），
--       IP 限流 20 次/小时。
--   · 新增表 client_crash_logs（migration 046）。
--   · main.js：正常退出写 last-clean-exit 标记，据此区分"异常退出"。
--   · main.js：首次内存采样从**同步**改为异步 ——
--       tab-budget 在 macOS 上走 vm_stat 的 execSync，平时 5ms，
--       但系统繁忙时最长可卡 3 秒，而它在启动路径上。
--
-- ## 隐私边界（三道防线，都有测试护栏）
--
--   1. 客户端白名单：**只挑 crash / memory 两个域**，其余一律丢弃；
--      解析不了的行也丢弃（无法确认作用域就无法确认不含隐私）。
--   2. 服务端**再过滤一次**，不信任客户端（客户端可被篡改）。
--   3. 绝不整份上传。完整日志含 WhatsApp 群名、联系人、翻译正文。
--
--   实测：混入 4 行（其中 2 行为群聊+手机号、翻译正文），
--   落库仅 2 行诊断信息，隐私行一条未进。
--
-- ## 验证
--
--   · 本地：1234 项 / 1220 通过 / **0 失败** / 14 跳过
--     （新增 13 项 crash-report 隐私护栏测试）
--   · 服务端：migration 046 已执行，端到端上报返回 200/stored:true，
--     重复上报被唯一索引去重（stored:false），业务接口鉴权未受影响
--     （未登录 401、公开接口 200）
--   · 打包产物：asar 内确认版本 0.1.37、crash-report.js 存在、
--     main.js 已接线；**打包版实际启动 20 秒未闪退**
--   · 安装包 SHA256 本地与服务器一致（上传无损坏）
--
-- ## 与上一版的关系
--   0.1.36 记录停用不删除，留作回滚。
--   ⚠️ 重要：**本版的上报通道只在 0.1.37 及以后生效**。
--   仍在 0.1.36 的用户不会自动上报，需引导其升级到 0.1.37
--   后，下次闪退才能被我们收到。
--
--   沿用既有约定：Windows **只登记安装版（Setup）**；portable（免安装版）
--   同样上传到 downloads 供直接下载，但不登记进更新通道。
--
-- 唯一约束是 (release_group, os, arch, app, version)，重复执行不会出错。

BEGIN;

-- 停用旧版本。
UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE release_group IN ('macos', 'windows')
  AND version <> '0.1.37'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  -- ---------------- macOS ----------------
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.37',
   'https://pixfanyi.com/downloads/HelloPix-0.1.37-arm64.dmg', true,
   '遇到闪退时，现在会自动把崩溃原因回传给技术支持（只包含崩溃类型与内存占用，不含任何聊天内容），下次启动即可自动上传，帮助更快定位问题。同时修复了启动时可能出现的卡顿。若曾遇到闪退，请务必更新到本版。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.37',
   'https://pixfanyi.com/downloads/HelloPix-0.1.37-x64.dmg', true,
   '遇到闪退时，现在会自动把崩溃原因回传给技术支持（只包含崩溃类型与内存占用，不含任何聊天内容），下次启动即可自动上传，帮助更快定位问题。同时修复了启动时可能出现的卡顿。若曾遇到闪退，请务必更新到本版。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  -- ---------------- Windows（只登记安装版）----------------
  ('windows', 'Windows（64 位）', 'Windows', 'x64', '', '0.1.37',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.37.exe', true,
   '遇到闪退时，现在会自动把崩溃原因回传给技术支持（只包含崩溃类型与内存占用，不含任何聊天内容），下次启动即可自动上传，帮助更快定位问题。同时修复了启动时可能出现的卡顿。若曾遇到闪退，请务必更新到本版。')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET url = EXCLUDED.url, title = EXCLUDED.title, enabled = true,
      note = EXCLUDED.note, updated_at = NOW();

-- 每个 (release_group, os, arch) 只允许一条 enabled=true，否则更新下发随机。
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT release_group, os, arch FROM client_releases
    WHERE enabled = true AND release_group IN ('windows', 'macos')
    GROUP BY release_group, os, arch HAVING count(*) > 1
  ) dup;
  IF n > 0 THEN
    RAISE EXCEPTION '存在 % 组同平台多条的 enabled 记录，会导致更新下发随机', n;
  END IF;
END $$;

COMMIT;

\echo '--- 登记结果（macos 应恰为 2 条 0.1.37；windows 应恰为 1 条 0.1.37）---'
SELECT release_group, os, arch, app, version, enabled FROM client_releases
WHERE release_group IN ('windows', 'macos')
ORDER BY release_group, enabled DESC, version DESC, os, arch, app;
