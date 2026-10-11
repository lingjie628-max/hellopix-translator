-- 登记 0.1.25 客户端版本（Windows x64 + macOS 双架构），并下架各平台旧记录。
--
-- ## 为什么会有 0.1.25
--
-- 用户 2026-10-11 报的**观感缺陷**（不是崩溃）：
--   「群组翻译，开启自动翻译后，不应该出现这个翻译按钮，而是自动完成聊天内容的翻译，
--     而且开启了群聊自动翻译后，一部分翻译，还有一部分没有翻译。」
--
-- 真机日志（0.1.24，`hello-pix-2026-10-11.log`）证据：
--   · CHAT_KIND {"group":true,"evidence":"header-marker"} —— 群聊**判对了**；
--   · MANUAL_CHIP_RENDERED 95 次（打开群聊时页面上那批全部被挂上「译」）；
--   · trigger=auto_receive 仅 26 次（只有会话进行中**新到**的才自动翻）。
--
-- 根因：MessageParser.messageAction 里有一条
--   `if (s.group && s.historic) return 'chip'`
-- —— 它把「群聊=自动」降级成**半自动**：只有新到的自动翻，打开会话时已经在
-- 页面上的那批只挂「译」按钮。用户看到的就是"一部分翻译、一部分没有"。
--
-- ---
-- ## 修法（四条）
--
--   A) 删除「群聊=自动 但历史只给按钮」那条闸门（连同 createHistoryGate /
--      isHistoric / 状态里的 historic 字段一并删干净）。用户裁定：
--      「群聊=自动」就该把会话里出现的**全部**消息自动翻，且**不再出现任何「译」**。
--   B) 自动翻译改**有界并发、新的先翻**（AUTO_POOL_SIZE=3，倒序入队）。
--      旧实现是扫描循环里一条条 await，串行翻几十条要等半分钟 —— 这正是
--      "翻一半"的观感来源；并发上限不能去掉（翻译与**发送**共用连接池）。
--   C) 切到自动时收掉手动留下的残留「译」（removeStaleChip，busy 态不动）。
--   D) paint 加「内容没变就不写 DOM」，掐断 MutationObserver 自激循环
--      （0.1.24 真机单条消息的渲染 trace 一秒 33 次）。
--
-- ---
-- ## 为什么"把历史也自动翻"不会重复扣费
--
-- 删掉历史闸门的前提是**同一条消息翻多少次都只计一次费**，三层保证：
--   ① 客户端 transRequestId 对同一段正文 + 同一通道是恒定的
--      （desktop:${deviceId}:${fingerprint}:${generation}，generation 默认复用）；
--   ② 服务端 core.translate 按 idempotency_key 查 translation_reservations，
--      命中已有预留直接返回、不再扣字符；
--   ③ 客户端 transCache + 服务端 translationCache 挡住重复网络/接口调用。
-- **成本上限 = "从没翻过的正文"，不是"翻了多少次"。** 已被单测锁死。
--
-- ---
-- ## 保留的计费护栏（唯一剩下的那条，绝不能动）
--
--   群聊 + 「群聊自动翻译」= 手动 → 一条都不自动翻，只给「译」按钮。
--   真机验收点：该模式下 trigger=auto_receive 必须为 0。
--
-- ---
-- ## 验收（发版前实测）
--
--   · 全量测试 988 项 / 974 通过 / 0 失败（14 跳过）
--   · 群聊计费守卫 test/group-billing-guard.test.js —— 38 / 38
--   · 会话身份 test/group-conversation-identity.test.js —— 11 / 11
--   · 沉降安全 13/13 · 原生输入 15/15 · 多窗口并发 4/4 · 发送状态机 11/11
--   · 「译」链路 scripts/verify-manual-chip.js —— 21 / 21
--   · 传输层真机验证 11/11 · 产物装载校验 scripts/verify-preload-load.js 20/20
--   · 三份 asar（mac-arm64 / mac-x64 / win-unpacked）**逐字节完全相同**
--     （sha256 a7e8ee2b…），证明同源；对产物字节跑「译」链路同样 21/21。
--
-- ## 真机取证入口
--   客户端日志：~/Library/Application Support/Hello Pix/logs/hello-pix-<日期>.log
--   本轮新增 AUTO_DISPATCH 埋点（candidates / dispatched / queued / running /
--   chipRemoved），配 0.1.25-交付包/rc025-collect.sh 采集。
--
-- ## 与上一版的关系
--   生产自 2026-10-08 `suspend-client-0.1.15.sql` 起处于 **NO RELEASE**
--   （windows/macos 下无任何 enabled=true）。本版是停售以来**第一次重新开闸**，
--   因此 UPDATE 会把当前所有 enabled=true 的记录先停用（当前为 0 行，属防御）。
--   旧记录/旧文件一律**停用不删除**，留作回滚。
--
-- 唯一约束是 (release_group, os, arch, app, version)，重复执行不会出错。

BEGIN;

-- 只停用 windows / macos 的旧记录；其他 release_group（如 telegram）不动
UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE release_group IN ('windows', 'macos')
  AND version <> '0.1.25'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  ('windows', 'Windows 安装版', 'Windows', 'x64', '', '0.1.25',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.25.exe', true,
   '修复群聊自动翻译：开启「群聊自动翻译」后，打开群聊会直接把会话里的消息全部自动翻译，不再只翻译新到的消息、也不再留下需要手点的「译」按钮。同时修复部分消息已翻译、部分未翻译的问题，并提升大量消息的翻译速度。'),
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.25',
   'https://pixfanyi.com/downloads/HelloPix-0.1.25-arm64.dmg', true,
   '修复群聊自动翻译：开启「群聊自动翻译」后，打开群聊会直接把会话里的消息全部自动翻译，不再只翻译新到的消息、也不再留下需要手点的「译」按钮。同时修复部分消息已翻译、部分未翻译的问题，并提升大量消息的翻译速度。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.25',
   'https://pixfanyi.com/downloads/HelloPix-0.1.25-x64.dmg', true,
   '修复群聊自动翻译：开启「群聊自动翻译」后，打开群聊会直接把会话里的消息全部自动翻译，不再只翻译新到的消息、也不再留下需要手点的「译」按钮。同时修复部分消息已翻译、部分未翻译的问题，并提升大量消息的翻译速度。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET url = EXCLUDED.url, title = EXCLUDED.title, enabled = true,
      note = EXCLUDED.note, updated_at = NOW();

-- 防御性断言：每个 (release_group, os, arch) 只允许一条 enabled=true。
-- 两条同 arch 时更新接口选中哪条取决于排序 —— 会出现
-- "有的用户收到新版、有的收不到"的随机现象。
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
