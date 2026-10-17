-- 登记 0.1.33 客户端版本（macOS 双架构 + Windows 安装版），并停用同组旧记录。
--
-- ## 本版内容：节点检测的判定方式与提示措辞
--
--   起因：用户反馈「仍然显示节点连不上」。排查结论是**节点确实是坏的**
--   （认证通过、CONNECT 被拒；Chromium 直接加载也是 0.3 秒
--   ERR_SOCKS_CONNECTION_FAILED），但**判定方式太脆弱、提示也不准确**。
--
--   ① 多目标并发预检（socks-relay.js）
--      原先只 CONNECT 一个固定目标 api.ipify.org:443，一次失败就判"节点连不上"。
--      真机抓到的节点对不同目标回**不同的**应答码：
--          1.1.1.1:443   → 0x01（通用故障）
--          8.8.8.8:53    → 0x08
--          api.ipify.org → 0x08
--      单目标判定等于把结论交给一次偶然。现在并发试 4 个目标，
--      含 web.whatsapp.com（用户真正要开的站），**任一成功即判可用**。
--
--   ② 快速收敛（同一处）
--      全部失败时，若已失败的目标里**最快的一个**在 1 秒内返回（说明节点是秒拒的），
--      立即定论，不再陪可能假死的目标耗满 8 秒。
--      真机实测：148ms 出结论（改之前是 8 秒超时或误判）。
--
--   ③ 0x08 文案改准确
--      旧：「节点不支持该地址类型（可能只支持 IPv4），请更换节点」
--      新：「节点拒绝了连接（可能是流量用尽、套餐到期或 IP 白名单未加），
--            请联系代理服务商」
--      理由：真机上同一节点对**纯 IPv4 字面量** 1.1.1.1 同样拒绝 ——
--      "只支持 IPv4"这个解释被自己的数据反证了。0x01 一并改为"联系服务商"。
--
--   ④ 同节点复用中继（main.js）
--      原先一窗口一中继：开 60 个窗口 = 向节点开 60 条独立 SOCKS5 连接，
--      可能触发代理商的单账号并发上限。现在按 host/port/账密池化 + **引用计数**，
--      最后一个窗口关掉才真正 close。
--      引用计数是必须的：relay.close() 会销毁该中继上**所有** socket，
--      不计数的话关 A 窗口会顺手掐掉 B 窗口的连接。
--      key 仍是 host+port+账密四项，不同账号不会串。
--
-- ## 参照与局限（写清楚，避免后人误读）
--   分析过同类产品（比特浏览器 7.1.5）：
--     · 它用 puppeteer-core + **私有编译的 Chromium 内核**（--fingerprint-config
--       是第三方内核才认的参数），Electron 只做外壳。我们只做单一站点，
--       不需要指纹对抗，继续用 Electron 自带 Chromium。
--     · 它经代理用 socks-proxy-agent 去请求多个真实网页，**能取到内容**才算通。
--       我们的预检只验证到 CONNECT 成功，不验证能否真的取到内容 ——
--       这是**已知差距**，本轮未改（改了等于推翻纯 Node、零依赖的预检实现）。
--       若后续仍有"判可用但实际打不开"的客诉，这就是下一步方向。
--
-- ## 验收（发版前实测）
--   · 全量：node --test test/*.test.js
--       1220 项 / 1206 通过 / **0 失败** / 14 跳过
--   · 新增 test/socks-multi-target.test.js（11 条），覆盖：
--       只有 web.whatsapp.com 通 → 必须判可用（单目标时代的误杀）
--       全部被拒 → 判失败且给出节点侧原因
--       任一目标假死不拖死整体
--       成功后掐掉仍在飞行的探测，不留悬挂连接
--       PRECHECK_TARGETS 必须含 WhatsApp Web
--       0x08 文案不得再出现 IPv4
--       pickWorstOutcome 优先级（账密错 > 网络问题）
--       relayPool 引用计数与退出清理（源码级护栏）
--   · 真机（本次事故的节点）：186.240.232.207 / 186.240.232.206
--       均 148ms 返回 CONNECT_REFUSED，结论文案正确。
--
-- ## 与上一版的关系
--   0.1.32 记录停用不删除，留作回滚。
--   沿用既有约定：Windows **只登记安装版（Setup）**；portable（免安装版）
--   同样上传到 downloads 供直接下载，但不登记进更新通道。
--
-- 唯一约束是 (release_group, os, arch, app, version)，重复执行不会出错。

BEGIN;

-- 停用旧版本。注意：Windows 的 url 指向 Setup.exe，app 字段区分两种形态。
UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE release_group IN ('macos', 'windows')
  AND version <> '0.1.33'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  -- ---------------- macOS ----------------
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.33',
   'https://pixfanyi.com/downloads/HelloPix-0.1.33-arm64.dmg', true,
   '改进节点检测：改为同时试探多个地址（含 WhatsApp 网页版），任一能通即判可用，减少好节点被误判；节点确实不可用时通常 1 秒内给出结论，不再长时间停在"正在检测"。修正了"可能只支持 IPv4"这一误导性提示，改为提示节点拒绝了连接并建议联系代理服务商。同一节点的多个窗口现在共用一条连接，开很多窗口时更稳定。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.33',
   'https://pixfanyi.com/downloads/HelloPix-0.1.33-x64.dmg', true,
   '改进节点检测：改为同时试探多个地址（含 WhatsApp 网页版），任一能通即判可用，减少好节点被误判；节点确实不可用时通常 1 秒内给出结论，不再长时间停在"正在检测"。修正了"可能只支持 IPv4"这一误导性提示，改为提示节点拒绝了连接并建议联系代理服务商。同一节点的多个窗口现在共用一条连接，开很多窗口时更稳定。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),

  -- ---------------- Windows（只登记安装版）----------------
  ('windows', 'Windows（64 位）', 'Windows', 'x64', '', '0.1.33',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.33.exe', true,
   '改进节点检测：改为同时试探多个地址（含 WhatsApp 网页版），任一能通即判可用，减少好节点被误判；节点确实不可用时通常 1 秒内给出结论，不再长时间停在"正在检测"。修正了"可能只支持 IPv4"这一误导性提示，改为提示节点拒绝了连接并建议联系代理服务商。同一节点的多个窗口现在共用一条连接，开很多窗口时更稳定，不易触发代理商的并发连接上限。')
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

\echo '--- 登记结果（macos 应恰为 2 条 0.1.33；windows 应恰为 1 条 0.1.33）---'
SELECT release_group, os, arch, app, version, enabled FROM client_releases
WHERE release_group IN ('windows', 'macos')
ORDER BY release_group, enabled DESC, version DESC, os, arch, app;
