-- 登记 0.1.27 客户端版本（macOS 双架构），并停用各平台旧记录。
--
-- ## 本版内容
--   · 修复「译文无法选中、无法复制粘贴」——这是一个**两层**缺陷：
--       第 1 层（guest-inject.js）：宿主在气泡容器上打 user-select: none，
--         Chromium 在 user-select:none 的子树里拒绝建立选区；译文框 .pix-trans
--         缺 !important 压不过宿主 → 选都选不中。改为两种前缀 + !important 抢回选中权，
--         并加 selectstart/copy 捕获阶段守卫（只对译文生效）。
--       第 2 层（main.js）：聊天应用在 WebContentsView 里，Electron 不把
--         Cmd/Ctrl+C/V/A 自动作用到嵌入 webContents；应用隐藏菜单栏且从未注册
--         编辑角色，WebContentsView 又默认不弹右键菜单 → 三条通道全缺。
--         补齐：每个 view 的 before-input-event + 右键菜单 + macOS 应用菜单编辑角色。
--     两层缺一不可：只做一层都复制不出来。
--
-- ## 验收（发版前实测）
--   · 全量测试 1122 项 / 1108 通过 / 0 失败（14 跳过）
--   · 客户端源码装载校验 19 / 19
--   · 真 Electron 机制验收 npm run verify:copy：8 / 8
--     （真实 Chromium 复刻宿主禁选 → 译文可选中、Cmd+C 进剪辑板、全选/粘贴/右键复制均生效，
--       且非译文区域不受影响）
--   · 两份 app.asar（mac-arm64 / mac-x64）逐字节相同（sha256 be0e9aec…）；两个 DMG 挂载复核一致
--
-- ## 与上一版的关系
--   0.1.26 记录停用不删除，留作回滚。
--   本版**未构建 Windows 包**（windows 组保持 0.1.26 不变）—— 若需 Windows 更新，
--   先在 Windows 环境 npm run pack:win 再补一条 windows 记录。
--
-- 唯一约束是 (release_group, os, arch, app, version)，重复执行不会出错。

BEGIN;

-- 只停用 macos 组的旧版本；windows 组保持原样（本版没有 Windows 包）。
UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE release_group = 'macos'
  AND version <> '0.1.27'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.27',
   'https://pixfanyi.com/downloads/HelloPix-0.1.27-arm64.dmg', true,
   '修复译文无法选中和复制粘贴的问题：现在可以选中译文并复制。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.27',
   'https://pixfanyi.com/downloads/HelloPix-0.1.27-x64.dmg', true,
   '修复译文无法选中和复制粘贴的问题：现在可以选中译文并复制。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）')
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

\echo '--- 登记结果（macos 下 enabled=true 应恰为 2 条，windows 仍为该平台上一版）---'
SELECT release_group, os, arch, version, enabled FROM client_releases
WHERE release_group IN ('windows', 'macos')
ORDER BY release_group, enabled DESC, version DESC, os, arch;
