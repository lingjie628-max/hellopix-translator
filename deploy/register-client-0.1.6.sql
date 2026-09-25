-- 登记 0.1.6 客户端版本（Windows x64 + macOS 双架构），并下架各平台旧记录。
--
-- 本版内容（相对 0.1.5）：
--   · 客户端首次落盘日志文件 —— 主进程未捕获异常、未处理拒绝、渲染进程崩溃、
--     渲染层报错、启动信息，全部写入 userData/logs（按天切分、只留 7 天、自动脱敏）
--   · 「系统操作」菜单与托盘菜单新增「打开日志目录」，用户报障时能把日志发回来
--   · 关于面板的版本号改为读 app.getVersion()，此前写死 '0.1.0'，从 0.1.1 起就没对过
--
-- 为什么必须升版本号，而不是原地重打 0.1.5：
--   客户端更新判定是 cmpVer(remote, local) > 0 —— **严格大于**。
--   沿用 0.1.5 重打的话，已经装了 0.1.5 的用户永远收不到更新提示，
--   日志这条修复就到不了他们手上。三端同版本号也必须是同一份内容，
--   否则会重演"同版本不同内容"的排查困境。
--
-- macOS 上一次发布是 0.1.3（9/16），本版一并补齐双架构。
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
  AND version <> '0.1.6'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  ('windows', 'Windows 安装版', 'Windows', 'x64', '', '0.1.6',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.6.exe', true,
   '新增客户端日志落盘与「打开日志目录」；关于面板版本号不再写死'),
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.6',
   'https://pixfanyi.com/downloads/HelloPix-0.1.6-arm64.dmg', true,
   'macOS 从 0.1.3 直达 0.1.6：含多开分区隔离 / 消息归档 / 后台运行 / 日志落盘'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.6',
   'https://pixfanyi.com/downloads/HelloPix-0.1.6-x64.dmg', true,
   'macOS 从 0.1.3 直达 0.1.6：含多开分区隔离 / 消息归档 / 后台运行 / 日志落盘')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET url = EXCLUDED.url, title = EXCLUDED.title, enabled = true,
      note = EXCLUDED.note, updated_at = NOW();

COMMIT;

\echo '--- 登记结果 ---'
SELECT release_group, os, arch, version, enabled FROM client_releases
ORDER BY enabled DESC, id;
