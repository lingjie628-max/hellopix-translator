-- 登记 0.1.11 客户端版本（Windows x64 + macOS 双架构），并下架各平台旧记录。
--
-- 本版内容（相对 0.1.10）：三个计费/内容 P0，全部在客户端。
--
--   1) 群聊「翻译通道 = 手动」失效导致非预期扣费（P0）
--      现象：顶部已设为「群组翻译 = 手动」，进入群聊后消息仍自动出现译文。
--      根因一：`isGroupChat()` 只认 Telegram 的 header 文案
--              （/members|subscribers|位成员|位订阅|群组/），WhatsApp 群聊
--              因此被当成一对一会话，手动模式判定失效。
--      根因二：历史消息与自动模式没有分流，打开会话即把满屏历史翻一遍。
--      修法：① 用**结构性证据**判定群聊 —— WhatsApp 把会话类型编进消息
--              `data-id`（`true_<...>@g.us_<id>` 为群、`@c.us` 为个人），
--              且只在 `#main`（会话区）里扫，不扫左侧会话列表（列表里混着
--              别的群，扫它会把每个一对一会话都误判成群）。
--            ② 引入 `createHistoryGate()` 基线：打开会话时登记既有消息为
--              「历史」，只有基线**之后**新到达的消息才允许自动翻；
--              时间维度用 `data-pre-plain-text` 的真实时间戳兜底。
--            ③ 所有翻译决策收敛到 `MessageParser.messageAction()` 一个出口，
--              群聊手动模式 / 历史消息一律只给「译」按钮，0 次 API 调用。
--
--   2) 消息提取把 UI 文案当成正文送进翻译（P0）
--      现象：时间（`3:25 PM`）、已读图标（`wds-ic-read`）、`View group`、
--            「链接预览卡片」的标题与元数据、发信人名、`Download` 按钮
--            都被当成待翻正文 —— 既污染译文，又按这些字符**多扣费**。
--      根因：把消息容器的 `innerText` / `textContent` 整块当作翻译输入。
--      修法：结构化解析 `MessageParser.parseForTranslation()` ——
--            正文只取 `span.selectable-text`（且排除预览卡片与引用块），
--            找不到正文就返回空串，**绝不回退到 innerText/textContent**。
--            纯 URL 消息不调 API；「文字 + URL」只翻文字，URL 用 `[[n]]`
--            占位符掩码保护后原样拼回（模型弄丢 URL 也能还原）。
--
--   3) 译中占位符 `[正在翻译中...]` 被真实发送（P0）
--      现象：真实发出去过「哈喽你好[正在翻译中...]」。
--      修法：发送路径硬闸 `guardBusySend()`（capture 阶段拦 keydown /
--            beforeinput / click），写回输入框后再复核一次；主进程
--            `stripBusyMarks()` 独立再拦一次（不信任渲染进程），
--            且必须在进缓存、发上游**之前**执行。
--
--   · 计费归因：新增 `translate_logs.trigger`（migration 042），客户端在
--     发起翻译时声明 `manual_click` / `auto_receive` / `manual_send` /
--     `retranslate`。这样「余额少了」能直接查出是谁触发的，
--     群聊手动模式下 `auto_receive` 必须为 0 —— 审计不再是猜。
--
--   · 代理实例级隔离（另一条 P0 线）：
--     - 新建应用不再继承上一次的代理。根因是**代理被当成了「新建默认模板」
--       的内容**存进 `app-presets.json`，点「新增应用」时被并进表单默认值。
--       修法：新增 `desktop/proxy-isolation.js`，模板的写/读/改名三个口子
--       全部先 `stripProxyFields()`；改名字的兜底值以前是 `tab.settings`，
--       等于「改个名字就把在用的代理写进模板」，一并修掉。
--     - `open-apps.json`（各实例自己的设置）**保留**代理，所以重启后
--       A 恢复 X、B 恢复 Y、C 仍直连；只有新建实例一律从直连开始。
--     - 实例隔离本就成立（`socksRelays` 按 `tab.id`、`proxyAuthByWebContents`
--       按 `webContents.id`，无任何全局共享代理状态），本轮补回归测试锁死。
--
--   测试：消息解析/群聊计费 54/54、代理实例隔离 19/19、全量 866/868
--         （唯一失败 `tdesktop` 项为既有偶发，与本版无关，单独跑通过）。
--         代理真机机制验收（真 Electron）26/26 PASS。
--
-- 为什么必须升版本号，而不是原地重打 0.1.10：
--   客户端更新判定是 cmpVer(remote, local) > 0 —— **严格大于**。
--   0.1.10 已上架（client_releases id=30/31/32, enabled=true），
--   沿用 0.1.10 重打的话，已经装了 0.1.10 的用户永远收不到这三个 P0 修复，
--   而 0.1.10 正是「群聊手动模式会扣费 + UI 文案进翻译 + 占位符会被发出」的版本。
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
  AND version <> '0.1.11'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  ('windows', 'Windows 安装版', 'Windows', 'x64', '', '0.1.11',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.11.exe', true,
   '修复群聊手动模式仍自动翻译/扣费、消息提取混入时间与UI文案、译中占位符被真实发送三个P0；新建应用默认直连、各实例代理完全独立'),
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.11',
   'https://pixfanyi.com/downloads/HelloPix-0.1.11-arm64.dmg', true,
   '含群聊计费与消息提取 P0 修复；macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.11',
   'https://pixfanyi.com/downloads/HelloPix-0.1.11-x64.dmg', true,
   '含群聊计费与消息提取 P0 修复；macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET url = EXCLUDED.url, title = EXCLUDED.title, enabled = true,
      note = EXCLUDED.note, updated_at = NOW();

COMMIT;

\echo '--- 登记结果 ---'
SELECT release_group, os, arch, version, enabled FROM client_releases
ORDER BY enabled DESC, id;
