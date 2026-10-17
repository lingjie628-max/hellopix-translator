-- 登记 0.1.31 客户端版本（macOS 双架构 + Windows 安装版），并停用同组旧记录。
--
-- ## 本版内容：把"固定 20 个窗口"改成"按系统内存水位动态判断"
--
--   背景：0.1.30 因为"一个账号开到 18 个就闪退"设了固定上限 20 个，
--   当时的归因是**句柄耗尽**（每实例约 24 个句柄）。用户反馈"能不能拉到 60-80"，
--   于是重新压测，**推翻了旧归因**：
--
-- ```
--             句柄      主进程RSS    整机内存
--   48 个  →  1178      122MB       6443MB
--   80 个  →  1886      150MB       8163MB
-- ```
--
--   ① Electron 启动时会把软限制**抬到硬限制**（macOS 实测 ulimit -n = 1048575），
--      80 个实例才用掉 1886 个句柄 —— **句柄根本不是瓶颈**。
--      原先看到的 "launchd maxfiles=256" 是个**假象**。
--   ② **内存才是真瓶颈**，且与机器大小强相关：80 个约 8GB ——
--      在 8GB 机器上是灾难，在 32GB 机器上毫无压力。
--
--   所以固定"最多 N 个"是错的：同一个数字在 8GB 上太冒险、在 32GB 上太保守。
--
--   修复（desktop/tab-budget.js）：
--    · 主判据改为**系统内存水位**：已用 >= 90%，或"开完这一个就会越过 90%"
--      → 拒绝并提示"运行内存不足"，让用户去关窗口或关其他程序。
--    · 预判而非只看快照：水位是当前值，若现在 89% 直接放行，新实例一起来就
--      立刻越线 —— 那等于没保护。所以按每个实例约 120MB 预留来推算。
--    · 固定窗口数上限默认**取消**（MAX_TABS_PER_WINDOW = 0，
--      需要时仍可设 >0 强行限死）。
--    · 句柄判断降级为**最后一道网**（handleLimit 由 1024 放宽到 65536）。
--
--   ★ 内存口径的坑（也踩过并修掉）：
--     macOS 的 os.freemem() **只算 Pages free**，把可回收的 inactive
--     全当"已用"。实测本机：
--       os.freemem()  → 0.12GB → "已用 98.6%"   ← 会疯狂误拒
--       vm_stat 口径  → 6.41GB → "已用 80%"     ← 可用
--     若直接用 os.freemem()，这台 8GB 机器在**空闲时**也会被告知"内存不足"，
--     比不判断还糟。现改为：
--       · macOS：vm_stat 的 free + inactive + speculative + purgeable
--       · Linux：/proc/meminfo 的 MemAvailable
--       · 其他：os.freemem()（接受其保守性）
--
--   提示文案按原因自适应：内存不足 → 标题「运行内存不足」；
--   窗口数达顶 → 标题「无法再开新窗口」。
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
--       1170 项 / 1156 通过 / 0 失败 / 14 跳过
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
  AND version <> '0.1.31'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  -- ---------------- macOS ----------------
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.31',
   'https://pixfanyi.com/downloads/HelloPix-0.1.31-arm64.dmg', true,
   '修复节点检测卡死与新实例翻译组件未启动的问题：坏节点现在会在 8 秒内返回明确原因，且检测异常不会再影响后续新开窗口。同时修复带账号密码的 SOCKS5 节点被误判为不可用的问题。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.31',
   'https://pixfanyi.com/downloads/HelloPix-0.1.31-x64.dmg', true,
   '修复节点检测卡死与新实例翻译组件未启动的问题：坏节点现在会在 8 秒内返回明确原因，且检测异常不会再影响后续新开窗口。同时修复带账号密码的 SOCKS5 节点被误判为不可用的问题。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),

  -- ---------------- Windows（本版重点 · 只登记安装版）----------------
  ('windows', 'Windows（64 位）', 'Windows', 'x64', '', '0.1.31',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.31.exe', true,
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

\echo '--- 登记结果（macos 应恰为 2 条 0.1.31；windows 应恰为 1 条 0.1.31）---'
SELECT release_group, os, arch, app, version, enabled FROM client_releases
WHERE release_group IN ('windows', 'macos')
ORDER BY release_group, enabled DESC, version DESC, os, arch, app;