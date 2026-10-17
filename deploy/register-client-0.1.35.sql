-- 登记 0.1.35 客户端版本（macOS 双架构 + Windows 安装版），并停用同组旧记录。
--
-- ## 本版唯一内容：修掉 0.1.29 引入的「节点检测」回归
--
--   用户原话：「以前节点是可以检测的，后面因为长时间无响应让你查，一查一修，
--            直接就是完全检测失败了。」
--
--   ### 根因（已用 RFC 原文 + 源码 diff 定位，不是推测）
--
--   0.1.28 及之前的判定：Chromium 经代理**真的打开** api.ipify.org，拿到 IP 才算过。
--   0.1.29 在它前面加了一道纯 Node 的 precheckSocks5() 作为**强制门**：
--   只要 CONNECT 拿不到 0x00 就直接 return 失败，连窗口都不建。
--   于是同一个节点，旧版能过、新版必死 —— 因果链完整闭合。
--
--   ### 附带的错误解释（让排查方向跑偏）
--
--   0.1.32 把 0x08 的文案改成「流量用尽、套餐到期或 IP 白名单未加」。
--   RFC1928 原文是：
--       X'08' Address type not supported
--   意思是**节点处理不了这次 CONNECT 的地址**，不是账号被停。
--   把「节点连不上目标网站」说成「你的节点已失效」，用户只会去换节点，
--   真正的问题永远查不出来。
--
--   ### 修复
--   1. main.js：预检**不再拥有否决权**，只保留「提前拦截」这一种能力 ——
--      且只拦 TIMEOUT（节点完全没回话）。
--      那种节点放进 Chromium 会卡在握手并弄坏渲染进程基础设施，
--      这才是 0.1.29 真正要修的 P0，必须留着。
--      其余一切预检结论都只作为**线索**附在报错后面，最终结论一律交给
--      「能不能真的经这个节点打开网页」。
--   2. socks-relay.js：0x08 文案回到 RFC 原意。
--   3. socks-relay.js：pickWorstOutcome 里 CONNECT 应答码**降级**。
--      它只说明"那一个地址没被放行"，换目标可能就通，不能当整个节点的死因。
--
-- ## 验收（发版前实测）
--   · 全量 node --test test/*.test.js
--       1221 项 / 1207 通过 / **0 失败** / 14 跳过
--   · test/socks-precheck.test.js + test/socks-multi-target.test.js：27 / 27
--       新增护栏：预检不得再以 !pre.ok 直接判死（防回归）
--       新增护栏：0x08 文案不得出现「流量用尽 / 套餐到期」
--   · 真 Electron scripts/verify-detect-proxy-electron.js：6 / 6
--       关键：场景 3/4 里预检已判失败，但仍**继续执行了真实网页加载**
--       （返回 ERR_SOCKS_CONNECTION_FAILED 而非预检结论）→ 否决权确已移除
--   · 真机对照 scripts/probe-real-node.js（同一节点）：
--       ① 纯 Node 预检      → CONNECT_REFUSED
--       ② Chromium 实载网页 → ERR_SOCKS_CONNECTION_FAILED（= 0.1.28 的判定）
--       ③ 当前版本          → 与 ② 同结论，仅附加预检线索
--       即：**新版行为已与 0.1.28 对齐**。
--
-- ## 与上一版的关系
--   0.1.34 记录停用不删除，留作回滚（0.1.34 仅加了检测日志，未改判定）。
--   **已构建 Windows 包**（原本计划跳过，后补上）。Windows 与 macOS 同因回归，
--   一并修复。沿用既有约定：Windows 只登记安装版（Setup），
--   portable（免安装版）同样上传到 downloads 供直接下载，但不登记进更新通道。
--
-- ## 与上一版的关系
--   0.1.34 记录停用不删除，留作回滚。
--   沿用既有约定：Windows **只登记安装版（Setup）**；portable（免安装版）
--   同样上传到 downloads 供直接下载，但不登记进更新通道。
--
-- 唯一约束是 (release_group, os, arch, app, version)，重复执行不会出错。

BEGIN;

-- 停用旧版本。注意：Windows 的 url 指向 Setup.exe，app 字段区分两种形态。
UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE release_group IN ('macos', 'windows')
  AND version <> '0.1.35'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  -- ---------------- macOS ----------------
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.35',
   'https://pixfanyi.com/downloads/HelloPix-0.1.35-arm64.dmg', true,
   '修复节点检测的回归问题：之前版本会给节点检测额外加一道前置检查，这道检查不通过就直接判定失败，导致原本能用的节点也检测不过。现在这道检查只在节点完全没有响应时才提前拦截，其余情况一律以「能否真的经该节点打开网页」为准，与更早的版本保持一致。同时修正了节点返回错误时容易误导的提示文案。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.35',
   'https://pixfanyi.com/downloads/HelloPix-0.1.35-x64.dmg', true,
   '修复节点检测的回归问题：之前版本会给节点检测额外加一道前置检查，这道检查不通过就直接判定失败，导致原本能用的节点也检测不过。现在这道检查只在节点完全没有响应时才提前拦截，其余情况一律以「能否真的经该节点打开网页」为准，与更早的版本保持一致。同时修正了节点返回错误时容易误导的提示文案。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  -- ---------------- Windows（只登记安装版）----------------
  ('windows', 'Windows（64 位）', 'Windows', 'x64', '', '0.1.35',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.35.exe', true,
   '修复节点检测的回归问题：之前版本会给节点检测额外加一道前置检查，这道检查不通过就直接判定失败，导致原本能用的节点也检测不过。现在这道检查只在节点完全没有响应时才提前拦截，其余情况一律以「能否真的经该节点打开网页」为准，与更早的版本保持一致。同时修正了节点返回错误时容易误导的提示文案。')
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

\echo '--- 登记结果（macos 应恰为 2 条 0.1.35；windows 应恰为 1 条 0.1.35）---'
SELECT release_group, os, arch, app, version, enabled FROM client_releases
WHERE release_group IN ('windows', 'macos')
ORDER BY release_group, enabled DESC, version DESC, os, arch, app;
