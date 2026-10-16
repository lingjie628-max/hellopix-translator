-- 登记 0.1.29 客户端版本（macOS 双架构 + Windows 安装版），并停用同组旧记录。
--
-- ## 本版内容：两个看起来不相关、实际**同根**的真机 P0
--
--   现象 A（Windows 多用户）：点「节点检测」→ **永远停在"正在检测节点…"**，连错误都不给。
--   现象 B（Windows）：打开新的 WhatsApp 实例 → 顶部红色横幅「**翻译组件未启动**」。
--
--   根因（真机 + 真 Electron 复现）：**一条故障链的两端**。
--    1. 上游 SOCKS5 节点 TCP 连得上，但握手阶段**不回任何数据**；
--    2. Chromium 卡在 SOCKS5 握手内部 —— did-finish-load / did-fail-load /
--       render-process-gone **一个都不触发**；
--    3. 15 秒超时后清理，直接 destroy() 掉还卡在握手的窗口；
--    4. ★ 这一步把 Electron 的渲染进程基础设施弄坏 ★
--       （日志：bootstrap_look_up … MachPortRendezvousServer: Permission denied /
--        No rendezvous client, terminating process）；
--    5. 此后**任何**检测都创建不出可用窗口 → 现象 A；
--       此后**任何**新实例的 preload 都跑不起来 → 8 秒内等不到 guest 第一次通信
--       → 渲染层与本页都判定「翻译组件未启动」→ 现象 B。
--
--   修复：
--    · 新增 `precheckSocks5()`：在创建**任何 Chromium 窗口之前**，用纯 Node 走完整
--      SOCKS5 协议（TCP → 问候 → RFC1929 账密 → **真的 CONNECT 一次**并等 reply）。
--      不可用 → 直接返回明确错误码与中文原因，**根本不碰 Chromium**。
--    · 新增 `HANDSHAKE_TIMEOUT_MS`（8 秒）：任何握手步骤都不许"永远 pending"。
--    · `probeTextWithProxy` 窗口清理改温柔：先 wc.stop() + 摘监听器，再延迟 destroy。
--
--   ★ 一并修掉一个**隐藏更深的 bug**：带认证的好节点被误判成坏节点。
--     预检第一版用 socket.once('data') 处理认证应答，外层再挂常驻 socket.on('data')。
--     Node 会把同一份数据分发给**所有**监听器 → 认证应答（首字节 0x01）被外层当成
--     "首个数据包"解析，buf[0] !== 0x05 → 误判 NOT_SOCKS5。
--     结果：**所有 socks5_auth（要账密）的节点，无论好坏一律报"这个端口不是 SOCKS5 代理"**
--     —— 与用户报的「socks5 带认证 · 检测不出来」完全对得上。
--     已改为**单一 data 处理器 + 显式阶段状态机**（greeting → auth → connect → done）。
--
--   ★ 还修掉一个"只有错误路径才炸"的 TDZ：finish() 里 clearTimeout(timer)，
--     但 timer 声明在"地址非法"提前 return 之后 → 抛 ReferenceError。
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
--       1147 项 / 1133 通过 / 0 失败 / 14 跳过
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
  AND version <> '0.1.29'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  -- ---------------- macOS ----------------
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.29',
   'https://pixfanyi.com/downloads/HelloPix-0.1.29-arm64.dmg', true,
   '修复节点检测卡死与新实例翻译组件未启动的问题：坏节点现在会在 8 秒内返回明确原因，且检测异常不会再影响后续新开窗口。同时修复带账号密码的 SOCKS5 节点被误判为不可用的问题。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.29',
   'https://pixfanyi.com/downloads/HelloPix-0.1.29-x64.dmg', true,
   '修复节点检测卡死与新实例翻译组件未启动的问题：坏节点现在会在 8 秒内返回明确原因，且检测异常不会再影响后续新开窗口。同时修复带账号密码的 SOCKS5 节点被误判为不可用的问题。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),

  -- ---------------- Windows（本版重点 · 只登记安装版）----------------
  ('windows', 'Windows（64 位）', 'Windows', 'x64', '', '0.1.29',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.29.exe', true,
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

\echo '--- 登记结果（macos 应恰为 2 条 0.1.29；windows 应恰为 1 条 0.1.29）---'
SELECT release_group, os, arch, app, version, enabled FROM client_releases
WHERE release_group IN ('windows', 'macos')
ORDER BY release_group, enabled DESC, version DESC, os, arch, app;