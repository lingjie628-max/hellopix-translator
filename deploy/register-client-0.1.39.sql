-- 登记 0.1.39 客户端版本（macOS 双架构 + Windows 安装版），并停用同组旧记录。
--
-- ## 本版内容
--
-- ### 1. 修复「打开就闪退」（0.1.37 真实上报定位）
--
-- 上报回来了 16 条崩溃记录，90 分钟内复发，内存只用了 45%~62% —— **与内存无关**。
-- 全部是两类未捕获异常：
--
--     Error: read ECONNRESET          at TCP.onStreamRead
--     Error: This socket has been ended by the other party
--         at Socket.writeAfterFIN    at socks-relay.js:361
--
-- 根因在两层：
--   · socks-relay 的 socket 缺少常驻 error 监听；写入未做「对端已关闭」保护。
--     代理场景里节点抖动、被墙、对端先关连接都是**常态**，不该升级成进程事件。
--   · log-file 的 uncaughtException **无条件 exit(1)** ——
--     于是「节点抖一下」=「用户整个软件消失」。
--
-- 修复：
--   · socks-relay：track() 补常驻 error 监听；所有写入改为 safeWrite
--     （检查 destroyed/writable 并 try/catch）。
--   · log-file：新增 isFatalError()，**白名单式**判定 ——
--     只有 ECONNRESET / EPIPE / ERR_STREAM_WRITE_AFTER_END 等明确的
--     网络/流错误才继续运行；未知异常仍然退出（避免产生"界面还在
--     但功能已坏"的僵尸进程，那比闪退更难排查）。
--
-- ### 2. 修复「开很多窗口后顶栏滚不动」
--
-- 用户反馈：上方应用开多了以后空间不够，没有滚动条，界面像被无限拉长。
-- 实测确认三个叠加原因：
--
--   · `.tabs::-webkit-scrollbar { height: 0 }` —— 滚动条被**彻底隐藏**。
--     容器本身 overflow-x:auto 是能滚的，但看不见的可滚区域等于不可滚。
--   · `.tab` 没有 flex-shrink:0，容器满了就等比压扁标签，文字挤成一团。
--   · **最隐蔽的一条**：包裹层是 flex 子项，默认 min-width:auto = 内容宽度。
--     25 个标签时 .tabs 被撑到 1912px（视口只有 1400px），
--     于是 overflow 永远不触发 —— 容器自己变宽了，何来溢出？
--     这才是"既不换行也不滚动、一路排到屏幕外"的直接原因。
--
-- 修复：
--   · 滚动条改为 8px 可见青色滑块 + 轨道底色，高度留独立空间（.tabs 72→80）。
--   · 标签加 flex:0 0 auto，固定 68px，不再被压扁。
--   · 新增 .tabs-wrap 包裹层并设 min-width:0 + width:100%，
--     .tabs 设 min-width:0 + flex:1 1 auto —— 让它受限于父宽而非内容宽。
--   · 两侧渐隐提示（has-more-left/right）：滚到边界即消失，
--     不让人误以为"还有"却滚不动。
--   · 新建/切换窗口后自动把激活标签滚进视野
--     （只跟随激活项，不会打断用户手动浏览）。
--
-- ## 验证
--
--   · 全量 1257 项 / 1243 通过 / **0 失败** / 14 跳过
--   · 真机 Electron 渲染实测（复用真实 styles.css，25 个标签）：
--       clientWidth 1400 / scrollWidth 1912 / canScroll true
--       scrollLeft 赋值 400 真实生效 / tabWidth 68 未被压缩
--       最左→仅右提示；中间→两侧提示；最右→仅左提示
--   · 闪退修复：用 0.1.37 原版代码跑新测试，4 项失败；修复后全部通过
--     （证明测试真的能抓到 bug，不是摆设）
--   · 打包产物开箱核对：版本 0.1.39、滚动条 8px、tabs-wrap min-width:0、
--     tab flex:0 0 auto、渐隐提示、TABS_HEIGHT=80 全部在包内
--   · 打包版实际启动 20 秒未闪退
--   · 安装包 SHA256 本地与服务器完全一致
--
-- ## 与上一版的关系
--
--   ⚠️ 0.1.38 从未发布（构建完成后即被本版取代，未登记、已从服务器清除）。
--   0.1.37 记录停用不删除，留作回滚。
--
--   ⚠️ 0.1.36 的用户**不会**自动上报崩溃日志（上报通道 0.1.37 才有），
--   需要引导升级到本版后，下次闪退才能被收到。
--
--   沿用既有约定：Windows 只登记安装版（Setup）；
--   portable 同样上传供直接下载，但不登记进更新通道。
--
-- 唯一约束是 (release_group, os, arch, app, version)，重复执行不会出错。

BEGIN;

UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE release_group IN ('macos', 'windows')
  AND version <> '0.1.39'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  -- ---------------- macOS ----------------
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.39',
   'https://pixfanyi.com/downloads/HelloPix-0.1.39-arm64.dmg', true,
   '本次更新修复了两个影响使用的问题：① 部分用户打开软件就闪退（原因是网络波动被误判为致命错误，导致程序直接退出），现在网络异常不会再让软件关闭；② 上方应用开多了以后无法左右滚动、界面像被拉长，现在可以正常滚动，并会显示滚动条和两侧提示。遇到闪退请务必更新到本版。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.39',
   'https://pixfanyi.com/downloads/HelloPix-0.1.39-x64.dmg', true,
   '本次更新修复了两个影响使用的问题：① 部分用户打开软件就闪退（原因是网络波动被误判为致命错误，导致程序直接退出），现在网络异常不会再让软件关闭；② 上方应用开多了以后无法左右滚动、界面像被拉长，现在可以正常滚动，并会显示滚动条和两侧提示。遇到闪退请务必更新到本版。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  -- ---------------- Windows（只登记安装版）----------------
  ('windows', 'Windows（64 位）', 'Windows', 'x64', '', '0.1.39',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.39.exe', true,
   '本次更新修复了两个影响使用的问题：① 部分用户打开软件就闪退（原因是网络波动被误判为致命错误，导致程序直接退出），现在网络异常不会再让软件关闭；② 上方应用开多了以后无法左右滚动、界面像被拉长，现在可以正常滚动，并会显示滚动条和两侧提示。遇到闪退请务必更新到本版。')
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

\echo '--- 登记结果（macos 应恰为 2 条 0.1.39；windows 应恰为 1 条 0.1.39）---'
SELECT release_group, os, arch, app, version, enabled FROM client_releases
WHERE release_group IN ('windows', 'macos')
ORDER BY release_group, enabled DESC, version DESC, os, arch, app;
