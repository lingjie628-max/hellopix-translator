-- 登记 0.1.26 客户端版本（Windows x64 + macOS 双架构），并停用各平台旧记录。
--
-- ## 本版内容
--   · Line 个人号可用：LINE 没有网页版，原 timeline.line.me 入口已失效（跳转开发者文档）。
--     改为内置 LINE 官方 Chrome 扩展（v3.7.2，打包时校验指纹与官方扩展 ID），
--     扫码或邮箱密码登录，每个 Line 账号独立分区、可多开。Line 暂不提供聊天翻译。
--   · 标签栏显示各应用未读消息数（0.1.25 同版本替换时已上线，本版正式随版本发布）。
--   · Telegram 接收翻译修复：此前会调用翻译但译文不显示、手动模式群聊没有「译」按钮。
--
-- ## 验收（发版前实测）
--   · 全量测试 1112 项 / 1098 通过 / 0 失败（14 跳过）
--   · 客户端源码装载校验 19 / 19
--   · npm run verify:line-ext（直接用安装包内的扩展）4 / 4：
--     扩展 ID 为官方 ID、登录页（邮箱密码 + 二维码）出现、未读数同步到标题、清零去前缀
--   · 三份 app.asar（mac-arm64 / mac-x64 / win-unpacked）逐字节相同（sha256 f05dc2a3…），
--     三份 line-ext 目录逐文件相同（118 个文件）；两个 DMG 挂载复核一致
--
-- ## 与上一版的关系
--   0.1.25 记录停用不删除，留作回滚。portable（免安装版）同样上传但不登记：
--   与安装版同属 windows/x64，登记两条会让更新下发随机。
--
-- 唯一约束是 (release_group, os, arch, app, version)，重复执行不会出错。

BEGIN;

UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE release_group IN ('windows', 'macos')
  AND version <> '0.1.26'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  ('windows', 'Windows 安装版', 'Windows', 'x64', '', '0.1.26',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.26.exe', true,
   '新增 Line 个人号：扫码或邮箱密码登录，支持多开。标签栏显示各应用未读消息数。修复 Telegram 收到消息后译文不显示的问题。'),
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.26',
   'https://pixfanyi.com/downloads/HelloPix-0.1.26-arm64.dmg', true,
   '新增 Line 个人号：扫码或邮箱密码登录，支持多开。标签栏显示各应用未读消息数。修复 Telegram 收到消息后译文不显示的问题。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.26',
   'https://pixfanyi.com/downloads/HelloPix-0.1.26-x64.dmg', true,
   '新增 Line 个人号：扫码或邮箱密码登录，支持多开。标签栏显示各应用未读消息数。修复 Telegram 收到消息后译文不显示的问题。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）')
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

\echo '--- 登记结果（windows / macos 下 enabled=true 应恰为 3 条）---'
SELECT release_group, os, arch, version, enabled FROM client_releases
WHERE release_group IN ('windows', 'macos')
ORDER BY enabled DESC, version DESC, os, arch;
