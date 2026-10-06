-- 登记 0.1.10 客户端版本（Windows x64 + macOS 双架构），并下架各平台旧记录。
--
-- 本版内容（相对 0.1.9）：
--   · 代理 P0 修复：代理账号密码不再拼进 proxyRules（Chromium 会拒绝并报
--     net::ERR_NO_SUPPORTED_PROXIES），改为按「线路 / partition」分发凭据 ——
--       - HTTP/HTTPS：规则只写 host:port，Basic 凭据由 app.on('login') 回填，
--         且只响应 authInfo.isProxy === true（网站自身 Basic Auth 一律放行，
--         避免把代理账密错误用于站点登录）
--       - SOCKS5：Chromium 不为 socks5 触发 login，改为每线路独立的本地回环中继
--         （socks-relay.js，127.0.0.1 随机端口、不复用），认证发生在「中继 → 上游」
--   · 修改已存在线路的代理立即生效、删除代理恢复直连（不再静默退回旧代理）
--   · 节点探测同样支持带认证代理
--
-- 计费规则本轮未改（V1.0.x：仅开放 DeepSeek 与 GPT，共用同一 char_balance，倍率 1.0x），
-- 由 migration 039/040 在服务端生效，与客户端版本无关。
--
-- 为什么必须升版本号，而不是原地重打 0.1.9：
--   客户端更新判定是 cmpVer(remote, local) > 0 —— **严格大于**。
--   沿用 0.1.9 重打的话，已经装了 0.1.9 的用户永远收不到更新提示，
--   而 0.1.9 正是那个「带账号密码的代理必报 ERR_NO_SUPPORTED_PROXIES」的版本。
--   electron-builder 构建不可复现，同版本重打还会造成「同版本不同内容」的排查困境。
--
-- portable（免安装版）同样上传但不登记：与安装版同属 windows/x64，
-- 登记会撞唯一约束，且页面上摆两个 Windows 入口反而让用户困惑。
--
-- 唯一约束是 (release_group, os, arch, app, version)，重复执行不会出错。
-- 旧记录**停用而不是删除**，留作回滚。

BEGIN;

-- 只停用 windows / macos 的旧记录；其他 release_group 不动
UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE release_group IN ('windows', 'macos')
  AND version <> '0.1.10'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  ('windows', 'Windows 安装版', 'Windows', 'x64', '', '0.1.10',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.10.exe', true,
   '修复带账号密码的代理：账密不再进 proxyRules（HTTP 走 login、SOCKS5 走本地中继），改/删代理即时生效'),
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.10',
   'https://pixfanyi.com/downloads/HelloPix-0.1.10-arm64.dmg', true,
   '含本条代理修复；macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.10',
   'https://pixfanyi.com/downloads/HelloPix-0.1.10-x64.dmg', true,
   '含本条代理修复；macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET url = EXCLUDED.url, title = EXCLUDED.title, enabled = true,
      note = EXCLUDED.note, updated_at = NOW();

COMMIT;

\echo '--- 登记结果 ---'
SELECT release_group, os, arch, version, enabled FROM client_releases
ORDER BY enabled DESC, id;
