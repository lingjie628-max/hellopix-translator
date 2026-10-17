-- 登记 0.1.28 客户端版本（macOS 双架构），并停用 macos 组旧记录。
--
-- ## 本版内容
--   · 修复「图文一起发送的时候，不翻译」—— 附加图片后输入的中文被**原样发出**，
--     消息还发送成功；客户端日志里**一条发送拦截记录都没有**（不是翻译失败，是根本没拦）。
--     这是一个**两层**缺陷，缺一不可：
--       第 1 层（输入框定位）：composerEl() 只按选择器顺序取「第一个可见输入框」。
--         附件预览面板里 footer 出现**多个** contenteditable（媒体标题框、caption 框…），
--         取到的不是用户正在打字的那一个 → 读到的正文为空。
--         修法：优先 document.activeElement；判可输入性改用 isEditableEl()
--         （以 contenteditable 属性为准，isContentEditable 在部分环境会假阴性）。
--       第 2 层（发送拦截入口）：eventInComposer(event, composerEl()) 要求
--         "事件发生在焦点框里"。用户多半是**先打字、再附加图片**，焦点不会跟着切到
--         caption 框 → 焦点框 ≠ 事件框 → 判定失败 → **静默放行**，
--         这正是"日志里什么都没有"的原因。
--         修法：新增 boxFromEvent() / sendTargetBox()，**事件优先、焦点兜底** ——
--         事件发生在哪个可编辑框里就拦哪个框，与焦点无关。
--         keydown / beforeinput / click 三处入口全部改用 sendTargetBox()。
--   · 新增取证日志 SEND_NOT_INTERCEPTED / COMPOSER_FOCUS_MISMATCH：
--     凡是"本该拦下却没拦"的分支都留一行（原因/事件类型/命中的框/事件目标/候选框），
--     下次同类问题不必再靠复述推断。日志不含消息正文（只记长度与 hash）。
--   · 接收方向：图片气泡的说明文字在缺少 span.selectable-text 时会被漏掉，
--     新增 whatsappCaptionCandidates() 兜底（仅在 selectable-text 一个都没找到时启用，
--     不影响"文件附件"等既有行为），并过滤时间戳、已读回执等 UI 节点。
--   · 继承 0.1.27：译文可选中、可复制粘贴（应用菜单编辑角色 + 每 view 的
--     before-input-event + 右键菜单）。
--
-- ## 验收（发版前实测）
--   · 全量测试 1132 项 / 1118 通过 / 0 失败（14 跳过）
--   · 真 Electron / 真 Chromium 机制验收 npm run verify:send-intercept：15 / 15
--       关键证据（场景 2，真机现场）：焦点不在 caption 时
--         oldPathWouldIntercept: false（旧路径漏判 → 静默放行）
--         newPathIntercepts:     true （新路径命中 caption）
--       并证明 isContentEditable 在真 Chromium 里是 true、在 jsdom 里是 undefined
--       —— 这类问题只有真浏览器能给出可信结论。
--   · 两份 app.asar（mac-arm64 / mac-x64）逐字节相同（sha256 85ba295c…）
--   · 两个 DMG 均已挂载复核：Info.plist 版本 0.1.28，包内含上述全部修复
--
-- ## 与上一版的关系
--   0.1.27 记录停用不删除，留作回滚。
--   本版**未构建 Windows 包**（windows 组保持 0.1.26 不变）—— 若需 Windows 更新，
--   先在 Windows 环境 npm run pack:win 再补一条 windows 记录。
--
-- 唯一约束是 (release_group, os, arch, app, version)，重复执行不会出错。

BEGIN;

-- 只停用 macos 组的旧版本；windows 组保持原样（本版没有 Windows 包）。
UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE release_group = 'macos'
  AND version <> '0.1.28'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.28',
   'https://pixfanyi.com/downloads/HelloPix-0.1.28-arm64.dmg', true,
   '修复发送带图片的消息时不翻译的问题：附加图片后输入的文字现在会正常翻译。同时包含译文可选中、可复制的修复。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.28',
   'https://pixfanyi.com/downloads/HelloPix-0.1.28-x64.dmg', true,
   '修复发送带图片的消息时不翻译的问题：附加图片后输入的文字现在会正常翻译。同时包含译文可选中、可复制的修复。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）')
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

\echo '--- 登记结果（macos 下 enabled=true 应恰为 2 条，windows 仍为 0.1.26）---'
SELECT release_group, os, arch, version, enabled FROM client_releases
WHERE release_group IN ('windows', 'macos')
ORDER BY release_group, enabled DESC, version DESC, os, arch;
