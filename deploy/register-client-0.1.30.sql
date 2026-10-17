-- 登记 0.1.30 客户端版本（macOS 双架构 + Windows 安装版），并停用同组旧记录。
--
-- ## 本版内容：一个账号开到 18 个左右实例后，再开就**整应用闪退**
--
--   真机现象：同一个窗口里实例开到 18 个左右，再开第 19 个 ——
--   **整个应用直接闪退**，没有任何提示、没有任何日志。
--
--   真根因（真 Electron 实测，不是推断）：
--     · 每个实例（WebContentsView + 独立 persist 分区）稳定占 **约 19～24 个
--       文件句柄**。实测 20 个实例：句柄 39 → 520，线性 +24/个。
--     · 句柄是**进程级硬上限**：macOS/Linux 受 ulimit，Windows 受 HANDLE 配额
--       与 Chromium 内部约束。打包后应用拿到的软限制往往比开发时更低。
--     · Chromium 在**渲染进程创建路径**上碰到 EMFILE **不是抛错，而是直接
--       终止进程** —— 这就是"闪退而不是报错"的全部原因。
--
--   为什么不能只靠"把上限调大"：上限终究存在，且各平台改法不同。
--   真正的修法是**在触顶之前拒绝，并明确告诉用户为什么**。
--
--   修复：
--    · 新增 desktop/tab-budget.js：
--        - 显式窗口上限 MAX_TABS_PER_WINDOW = 20（跨平台一致、用户能理解）；
--        - 实时句柄水位检查（每实例预算 26 + 安全余量 96）——
--          余量打光就会崩在"创建半途"，所以留够再放行；
--        - 测不出句柄时**一律放行**（宁可让用户试，也不要无故拦住）。
--    · openPlatform() 在创建**任何 Chromium 对象之前**先过预算；拒绝时
--      弹**原生对话框**（渲染层弹窗会被 WebContentsView 盖住，而这里恰恰是
--      "窗口已经很多"的场景）+ 写客户端日志。
--    · destroyTab() 收尾加固：接住 releaseSocksRelay 的 promise（原先漂浮在
--      事件循环上）、销毁前摘监听器、断开 tab.view 引用，让原生对象尽早回收。
--    · applyViewBounds() 容忍 tab.view 为 null（destroyTab 现在会置空它）。
--    · renderer/openApp() 不再丢弃返回值，失败可被上层感知。
--
--   ★ 顺带发现并修掉一个**会让安装包启动即崩**的坑：
--     新增的 tab-budget.js 必须登记进 package.json 的 build.files，
--     否则打包后 require 失败、窗口都建不出来。
--     已加白名单 + 回归测试锁死（与 instance-slot.js 同样的护栏）。
--
-- ## 验收（发版前实测）
--   · 单元（纯 Node）node --test test/socks-precheck.test.js：15 / 15 通过
--       覆盖 静默上游 / 问候后静默 / 端口不可达 / 认证被拒 / 账密错 / 非 SOCKS5 端口 /
--       CONNECT 被拒 / 好节点(无认证) / **好节点(要认证)** / 地址非法 / 反复预检不残留 /
--       relay 握手超时 / relay 地址非法 / 超时常量合理
--   · 真 Electron electron scripts/verify-detect-proxy-electron.js：10 / 10 通过
--       ★ 关键新场景 6：坏节点检测**之后**，新建带 preload 的 WebContentsView
--         仍能 did-finish-load、preload 不装载失败（即"翻译组件未启动"的回归护栏）。
--         实测记录：修复前该场景**什么事件都没有**（loadURL 都不返回）。
--   · 全量 node --test --test-concurrency=1 test/*.test.js
--       1165 项 / 1151 通过 / 0 失败 / 14 跳过
--
-- ## 与上一版的关系
--   0.1.28 记录停用不删除，留作回滚。
--   本版**构建了 Windows 包**（现象 A/B 都来自 Windows）。
--   沿用既有约定：Windows **只登记安装版（Setup）**；portable（免安装版）
--   同样上传到 downloads 供直接下载，但不登记进更新通道。
--
-- 唯一约束是 (release_group, os, arch, app, version)，重复执行不会出错。

BEGIN;

-- 停用旧版本。注意：Windows 的 url 指向 Setup.exe，app 字段区分两种形态。
UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE release_group IN ('macos', 'windows')
  AND version <> '0.1.30'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  -- ---------------- macOS ----------------
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.30',
   'https://pixfanyi.com/downloads/HelloPix-0.1.30-arm64.dmg', true,
   '修复节点检测卡死与新实例翻译组件未启动的问题：坏节点现在会在 8 秒内返回明确原因，且检测异常不会再影响后续新开窗口。同时修复带账号密码的 SOCKS5 节点被误判为不可用的问题。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.30',
   'https://pixfanyi.com/downloads/HelloPix-0.1.30-x64.dmg', true,
   '修复节点检测卡死与新实例翻译组件未启动的问题：坏节点现在会在 8 秒内返回明确原因，且检测异常不会再影响后续新开窗口。同时修复带账号密码的 SOCKS5 节点被误判为不可用的问题。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),

  -- ---------------- Windows（本版重点 · 只登记安装版）----------------
  ('windows', 'Windows（64 位）', 'Windows', 'x64', '', '0.1.30',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.30.exe', true,
   '修复两个 Windows 上的问题：①点「节点检测」一直停在正在检测、没有任何提示；②检测异常后新开的 WhatsApp 窗口显示「翻译组件未启动」。现在坏节点会在 8 秒内返回明确原因，且不会再影响后续新开的窗口。同时修复带账号密码的 SOCKS5 节点被误判为不可用的问题。')
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

\echo '--- 登记结果（macos 应恰为 2 条 0.1.30；windows 应恰为 1 条 0.1.30）---'
SELECT release_group, os, arch, app, version, enabled FROM client_releases
WHERE release_group IN ('windows', 'macos')
ORDER BY release_group, enabled DESC, version DESC, os, arch, app;