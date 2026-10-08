-- 登记 0.1.14 客户端版本（Windows x64 + macOS 双架构），并下架各平台旧记录。
--
-- ## 为什么会有 0.1.14（而不是把 0.1.13 重打一遍）
--
-- 0.1.13 修掉了 0.1.12 的致命装载缺陷（D1/D2/D3，见下）。但在做**执行级**
-- 验收时又暴露出一族同源问题，必须在同一个修复窗口里一起发出去：
--
--   D4) 拦截流程中途抛错 → 原文照样出网（静默，无提示）
--
--       根因：`runIntercept` 写成 `async`，而 `async` 函数里抛出的异常**不会**
--             同步抛给调用者，而是变成 rejected promise —— `.catch()` 要到
--             **微任务**里才跑。而 WhatsApp 的原生发送挂在冒泡阶段，早就执行完了。
--             于是"我们以为在拦"，实际原文已经发出去。
--       修法：把决策拆成**同步**函数 `decideIntercept`（决定拦不拦 + preventDefault），
--             外面套 `safeIntercept`：抛错 = 拦下 + 提示，绝不静默放行。
--             三个入口（Enter / beforeinput / 点发送按钮）全部走这条路。
--
--   D5) 桥装载失败依然"静默"（0.1.12 之所以能把客户坑到底的原因）
--
--       即使 D1 修好了，"preload 装载失败"这件事本身仍然没有任何观测面：
--       界面照常可用、日志一片空白。所以补上：
--         · `preload-error` + guest 控制台报错 → 写进客户端日志；
--         · 看门狗：guest 若真是活的，会主动来问 prefs。到点没来 = 桥没起来，
--           写 error 并在**用户正在打字的那个位置**画常驻红条（隔离世界注入，
--           不违反"远程页面不注入 page world"的安全约束，见 bridge-warning.js）；
--         · 侧边栏给该窗口打 ⚠ 标记，不许它长得和正常窗口一样。
--
-- ## 为什么必须升版本号，不能重打 0.1.13
--
--   ① 客户端更新判定是 cmpVer(remote, local) > 0 —— **严格大于**。0.1.13 已经
--      上架并可被下载，沿用同一个版本号的话，已经装到 0.1.13 的用户永远收不到
--      这次的兜底修复。
--   ② electron-builder 构建不可复现，同版本重打会出现"同版本不同内容"——
--      而这次恰恰最需要"同一个文件 = 验收过的文件"。
--
-- ## 0.1.14 完整包含 0.1.13 的内容
--
--   1) 群聊身份串到左侧列表（0.1.12 原定的第 1 条）
--   2) 群组翻译静默压回手动 → 新增 inherit，新建实例默认跟随账号
--   3) 实例设置互相覆盖（saveOpenApps 整体覆盖）
--   4) 翻译失败静默降级成"发原文"
--   5) 通道显示与实际调用不一致
--   6) 放开基础版通道切换
--   以上见 deploy/register-client-0.1.13.sql 的详细说明。在此之上新增：
--
--   A) 装载即崩 —— 整个翻译链路从未启动（P0，阻断级；0.1.12 的致命伤）
--        根因：guest-inject.js:63 在 MessageParser（var，第 248 行）定义之前
--              调用 MessageParser.createHistoryGate()，`var` 提升后是 undefined，
--              装载即 TypeError，整份 preload 停摆 —— keydown/click/scan 监听器
--              全都没挂上，发送翻译形同关闭，中文原文直通 WhatsApp。
--        修法：historyGate 初始化挪到解析器定义之后。
--   B) 翻译失败时静默降级成"发原文"（P0）
--        修法：deliverSend()，「翻译成功才发送」。失败 → 一个字节都不发，
--              原文退回输入框 + 可操作提示（重试翻译 / 发送原文，后者必须用户点击）。
--   C) 发送路径不声明调用来源（P1）
--        修法：TRIGGER_SEND = 'manual_send'。
--   D) D4 / D5（本版新增，见上）。
--
-- ## 验收
--
--   · 全量测试 915 条 / 901 通过 / 0 失败（14 跳过）
--   · 产物**执行级**校验 `npm run verify:client`：每份 asar 20/20 通过（含模块齐全性与版本号一致性），
--     含"拦截流程抛错时 Enter 仍被拦截""抛错时对方什么都收不到"。
--   · 分层对账见 0.1.14-验收包/ 下的真机验收手册。
--
-- 唯一约束是 (release_group, os, arch, app, version)，重复执行不会出错。
-- 旧记录**停用而不是删除**，留作回滚。

BEGIN;

-- 只停用 windows / macos 的旧记录；其他 release_group 不动
UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE release_group IN ('windows', 'macos')
  AND version <> '0.1.14'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  ('windows', 'Windows 安装版', 'Windows', 'x64', '', '0.1.14',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.14.exe', true,
   '紧急修复 0.1.12 的致命问题：翻译功能整体失效、开启发送翻译会把中文原文直接发出（预加载脚本装载即崩，拦截器从未启动）。本版另修：翻译流程中途异常会导致原文照样发出、翻译失败静默降级发原文、翻译组件加载失败时界面毫无提示'),
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.14',
   'https://pixfanyi.com/downloads/HelloPix-0.1.14-arm64.dmg', true,
   '紧急修复 0.1.12 翻译完全失效、发送翻译会直发原文的问题；翻译失败或翻译组件异常时不再发出原文，而是给出「重试翻译 / 发送原文」选择，并在组件未启动时给出常驻警告。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.14',
   'https://pixfanyi.com/downloads/HelloPix-0.1.14-x64.dmg', true,
   '紧急修复 0.1.12 翻译完全失效、发送翻译会直发原文的问题；翻译失败或翻译组件异常时不再发出原文，而是给出「重试翻译 / 发送原文」选择，并在组件未启动时给出常驻警告。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET url = EXCLUDED.url, title = EXCLUDED.title, enabled = true,
      note = EXCLUDED.note, updated_at = NOW();

COMMIT;

\echo '--- 登记结果 ---'
SELECT release_group, os, arch, version, enabled FROM client_releases
ORDER BY enabled DESC, id;
