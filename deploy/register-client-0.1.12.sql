-- 登记 0.1.12 客户端版本（Windows x64 + macOS 双架构），并下架各平台旧记录。
--
-- 本版内容（相对 0.1.11）：
--
--   1) WhatsApp 群聊「群组翻译 = 自动」失效（P0，客户端）
--      现象：真机上手把「群组翻译」切成**自动**，群里新消息始终不出译文；
--            手动点「译」正常。服务端日志证明客户端**从未发出**任何
--            `POST /translate/run`（auto 与手动都没有）。
--      根因：`whatsappPeer()` 扫的是 `document.querySelectorAll('[data-id]')` ——
--            **整个文档**。WhatsApp 左侧会话列表的行也带 `data-id`（`@c.us`），
--            且 `#side` 排在 `#main` **之前**。于是群聊里身份取到的是
--            "左侧列表里的某个私聊"：`chatIdentity()` 返回 `wa:<手机号>@c.us`
--            而不是 `wa:<群>@g.us`。列表每来一条新消息就重排 → 身份每轮都变
--            → `historyGate.begin()` 每轮重置 → `ready` 恒为 false
--            → `isHistoric()` 对每条消息都返回 true
--            → `messageAction()` 一律给 `chip`（只画「译」小按钮）→ auto 永不触发。
--      修法：新增 `conversationScope()`，身份与群聊判定**严格限定在 `#main`**，
--            不再回落到全文档扫描；群聊 `@g.us` 不再被当作客户。
--      为什么之前 21 条群聊用例全绿：原 harness 自己重写了扫描循环，且
--            `gate.begin()` 的身份由调用方直接传入，真 DOM 里也没有左侧列表 ——
--            真实的 `chatIdentity()` / `whatsappPeer()` 从未被执行过。
--            本版补上 `test/group-conversation-identity.test.js`（真源码 + 真 DOM）。
--
--   2) 翻译失败静默，用户看到的是"翻译坏了"（客户端）
--      现象：子账号字符余额不足、套餐不含所选通道这类**用户必须知道**的失败，
--            界面上表现成"翻译就是不出来"。真机验收时这会被直接误判成
--            "自动翻译失效"，排查方向被带偏一整轮。
--      根因：`translateText()` 把 `resp.success === false` 当"没有译文"直接吞掉
--            （`.catch` 也返回空串），服务端的 `{success:false, code, msg}`
--            一路到达渲染层却没人读。
--      修法：新增失败提示 `notifyTranslateIssue()` —— 余额不足明确提示
--            「当前子账号字符余额不足，请联系主账号分配字符」，通道类问题给
--            「当前套餐未包含所选翻译通道」。30 秒节流（余额为 0 时每条新消息
--            都会失败，不节流会刷屏），提示挂 `document.body` 并带
--            `data-pix-ui` 标记，采集/解析一律跳过。
--
--   3) 界面显示的通道与实际调用不一致（客户端）
--      现象：下拉被锁死时显示 `GPT`，而服务端实际走 `DeepSeek`
--            （生产 `translate_logs.engine_id` 全为 deepseek，账号存的却是 gpt）。
--      根因：客户端用**自己存的** `activeEngine` 渲染，而服务端在不可切换时
--            已忽略存量选择、回落到权益内第一个已接通通道。
--      修法：新增 `authoritativeEngine`，不可切换时以服务端下发的
--            `resp.activeEngine` 为准。（本条是兜底：043 之后三档套餐都放开切换，
--            正常情况下不再出现"锁死"态。）
--
--   4) 服务端 migration 043：放开基础版通道切换
--      015 把 `basic` 的 `allow_engine_switch` 置为 false，导致商户买了
--      含 GPT + DeepSeek 两个通道的套餐却一个都选不了，界面还只能显示存量值。
--      043 把 basic 放开：**所有套餐都可自选通道**。
--      成本控制交给"套餐包含哪些通道"，不靠锁死其中某一个。
--      注意：这不改变"主账号 / 子账号"的判定 —— `canSwitchEngine()` 看的是
--      **商户套餐**（`session.parent`），两者能力逐项相同；
--      `test/production-api.contract.test.js` 新增用例把"不得按 kind 分层"钉死。
--
--   5) 手把「群组翻译」切成自动，实例级却把它静默压回手动（客户端）
--      现象：真机上把「群组翻译 = 自动」设好，群消息依旧不出译文；
--            设置面板里显示的就是「自动」，**看不出任何异常**。
--      根因：群组翻译有两个开关 —— 账号级 `trans_group`（服务端）与实例级
--            `tab.settings.groupMode`。老实现只有两态且实例级**无条件覆盖**账号级：
--              transGroup: hasTab ? s.groupMode === 'auto' : g.transGroup
--            而新建实例的 `groupMode` 被硬编码成 `'manual'`。账号里开着自动，
--            实例一建出来就把它压成手动；`hasTab` 对任何配置过的实例都为真，
--            所以账号级那个开关**永远走不到**。
--      修法：引入第三态 `'inherit'`（跟随账号级），新建实例默认取它。存量实例
--            （字段缺失）一律仍按 `'manual'` —— 账号级 `trans_group` 的库默认是
--            true（migration 003），把"没有显式选择"解释成"跟随账号"等于给所有
--            存量实例**打开自动扣费**，拿别人的钱做默认值不可接受。
--            实例级 `manual` 是计费止损开关，任何情况下不得被账号级翻回自动。
--
--   6) 实例级设置"改了没保存"：并发写覆盖 + 闸门未复位（客户端）
--      现象：同一账号开多个副本时，A 副本改好的设置被 B 副本的一次保存盖回去；
--            翻译栏偶尔"怎么改都不生效"，且没有任何报错。
--      根因一：`saveOpenApps()` 整段覆盖 `all.byUser[user].tabs`（只用本副本内存），
--            而 `open-apps.json` 是按 Pix 账号存、`auth.json` 不按槽位隔离 ——
--            另一个副本的保存会用它内存里的旧 tabs 覆盖回来。
--      修法一：改为按 tab **合并**：内存里的写入/更新；本副本恢复过、现已关闭的
--            删除；磁盘上本副本从未见过的**原样保留**。`nextTab` / `usedCount`
--            取单调最大值（直接覆盖会让计数器倒退，进而生成重复的 tab id 与分区名）。
--            只在**确实建出 tab** 之后才登记 id：`restoreOneApp()` 可能因平台下线、
--            homeUrl 非法提前 return，把这种 id 当"自己管的"会在保存时删掉它 ——
--            那是数据丢失，比覆盖更糟。
--      根因二：`paintTransBar()` 的 `transBarSilent` 闸门是裸的 `= true … = false`，
--            中间任何一行抛异常（缺 DOM、值非法）就永远停在 true，之后用户在
--            翻译栏改的**每一项**设置都被 `saveTransBar()` 静默丢弃。
--      修法二：改为 try/finally。
--
--   测试：全量 851（0.1.12 新增 3 条通道权限用例 + 13 条群组翻译三态/持久化用例）
--         消息解析/群聊计费 54/54、代理实例隔离 19/19、会话身份 9/9、
--         通道显示 4/4、失败提示 9/9、群组翻译三态与持久化 13/13。
--         macOS 真机走查（本版验收重点）见 0.1.12-验收包/0.1.12-真机验收手册.md。
--
-- 为什么必须升版本号，而不是原地重打 0.1.11：
--   客户端更新判定是 cmpVer(remote, local) > 0 —— **严格大于**。
--   0.1.11 已上架（enabled=true），沿用 0.1.11 重打的话，已经装了 0.1.11 的
--   用户永远收不到本次修复，而 0.1.11 正是「群聊自动翻译完全失效」的版本。
--   electron-builder 构建不可复现，同版本重打还会造成"同版本不同内容"的排查困境。
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
  AND version <> '0.1.12'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  ('windows', 'Windows 安装版', 'Windows', 'x64', '', '0.1.12',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.12.exe', true,
   '修复 WhatsApp 群聊自动翻译完全失效（会话身份串到左侧列表导致历史门控每轮重置）、手动切的「群组翻译=自动」被实例级静默压回手动、多人开同一账号时设置互相覆盖、翻译失败静默不提示、通道显示与实际调用不一致；所有套餐均可自选 GPT/DeepSeek 通道'),
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.12',
   'https://pixfanyi.com/downloads/HelloPix-0.1.12-arm64.dmg', true,
   '修复 WhatsApp 群聊自动翻译完全失效、手动切的自动被压回手动、多开时设置互相覆盖；通道下拉不再锁死，可自选 GPT/DeepSeek。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.12',
   'https://pixfanyi.com/downloads/HelloPix-0.1.12-x64.dmg', true,
   '修复 WhatsApp 群聊自动翻译完全失效、手动切的自动被压回手动、多开时设置互相覆盖；通道下拉不再锁死，可自选 GPT/DeepSeek。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET url = EXCLUDED.url, title = EXCLUDED.title, enabled = true,
      note = EXCLUDED.note, updated_at = NOW();

COMMIT;

\echo '--- 登记结果 ---'
SELECT release_group, os, arch, version, enabled FROM client_releases
ORDER BY enabled DESC, id;
