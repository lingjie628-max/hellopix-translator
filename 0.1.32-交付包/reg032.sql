-- 登记 0.1.32 客户端版本（macOS 双架构 + Windows 安装版），并停用同组旧记录。
--
-- ## 本版内容：两个"真机反馈驱动"的修复
--
--   ── ① 翻译桥「未启动」误报（真机日志取证）──
--
--   用户装了 0.1.26、同时开着 **54 个**实例。日志里 43 个实例报过
--   「翻译桥未启动」，但其中 **42 个后来都就绪了**：
--
-- ```
--     实例            报「未启动」      实际就绪        延迟
--     green-39        20:02:54        20:26:47       1433s
--     green-48        20:22:28        20:25:26        178s
--     green-25        19:30:00        19:32:01        120s
--     ... 中位延迟 28 秒，超 8 秒的 35 个
-- ```
--
--   即 **桥没坏，只是慢**。54 个渲染进程同时装载把 CPU/磁盘瓜分掉，
--   preload 跑完 exec + 首次 IPC 远超原来的 8 秒死线。
--   而误报的代价很大：告警说「按回车就会把原文直接发出去」，用户就不敢用了。
--
--   修复（desktop/main.js）：单一死线拆成两段
--     · 软线 8 秒：只记 debug，**不判死、不告警**
--     · 硬线 90 秒：仍无消息才判「真未启动」
--   装载期就抛错（__pixPreloadError）仍是**立即判死** —— 那是确凿证据。
--
--   ── ② 加载失败「黑屏」（真机日志取证）──
--
--   同一份日志里有**持续性**网络故障：
--
-- ```
--     19:27:48  /client/session  连不上服务器（UND_ERR_CONNECT_TIMEOUT）
--               attempted addresses: 104.21.6.157:443, timeout: 4000ms
--     20:26:13  同样超时（这次是 172.67.134.254:443）
-- ```
--
--   两个 IP 都属于 Cloudflare —— **这台机器连我们自己的后端都连不上**。
--   用户表现：「有的窗口直接就是黑的，有的可以打开扫码」：同一个软件、
--   同一版本、同一时刻，差别只在"那一刻这个实例连没连上"。
--
--   而 startTabLoad() 里原本只有一句 loadURL(tab.url)，**没有 catch、
--   也没有 did-fail-load** —— 失败后 Chromium 什么都不画，用户看到的
--   就是 createWebView 设的背景色 #081628，一块看起来像"软件坏了"的深色空白。
--
--   修复：新增 desktop/load-error-page.js +
--   main.js 的 paintLoadError()（两条到达通道都接住、带去重与防递归），
--   失败时显示一个**能自己重试**的错误页：
--     · data: URL —— 离线可渲染（网络正好是坏的）
--     · 重试走 location.href，**不走 IPC** —— 主进程卡住时按钮仍可用
--     · 覆盖常见错误码，每条都回答"是什么问题 + 该做什么"；
--       SOCKS5 失败会直接指向「代理设置」
--
--   ── 顺带 ──
--   · load-error-page.js 已加入打包白名单，并新增一条**通用护栏测试**
--     （自动核对 main.js 所有 require('./x') 都在 build.files 里，
--      防止以后再出现"漏白名单 → 安装包启动即崩"）
--   · 一个旧测试用 slice(0,400) 死板取样导致脆断，已改成按函数体取样
--
--   继承 0.1.31：窗口上限按**内存水位**动态判断（超 90% 才提示）。
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
--       1209 项 / 1195 通过 / 0 失败 / 14 跳过
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
  AND version <> '0.1.32'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  -- ---------------- macOS ----------------
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.32',
   'https://pixfanyi.com/downloads/HelloPix-0.1.32-arm64.dmg', true,
   '修复节点检测卡死与新实例翻译组件未启动的问题：坏节点现在会在 8 秒内返回明确原因，且检测异常不会再影响后续新开窗口。同时修复带账号密码的 SOCKS5 节点被误判为不可用的问题。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.32',
   'https://pixfanyi.com/downloads/HelloPix-0.1.32-x64.dmg', true,
   '修复节点检测卡死与新实例翻译组件未启动的问题：坏节点现在会在 8 秒内返回明确原因，且检测异常不会再影响后续新开窗口。同时修复带账号密码的 SOCKS5 节点被误判为不可用的问题。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),

  -- ---------------- Windows（本版重点 · 只登记安装版）----------------
  ('windows', 'Windows（64 位）', 'Windows', 'x64', '', '0.1.32',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.32.exe', true,
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

\echo '--- 登记结果（macos 应恰为 2 条 0.1.32；windows 应恰为 1 条 0.1.32）---'
SELECT release_group, os, arch, app, version, enabled FROM client_releases
WHERE release_group IN ('windows', 'macos')
ORDER BY release_group, enabled DESC, version DESC, os, arch, app;