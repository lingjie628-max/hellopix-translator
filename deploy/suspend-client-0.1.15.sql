-- 暂停 0.1.15 客户端候选：把 0.1.15 在 windows / macos 下的记录停用，回到 NO RELEASE。
--
-- ## 为什么暂停
--
-- 0.1.15 是 0.1.14 的 P0 热修复，但真机复现证明 **WhatsApp 翻译链仍然不稳**：
--   · 发送翻译曾把 [正在翻译中...] 发给对方；
--   · 开启发送翻译后中文原文可能直接发出；
--   · fail-closed 弹窗的「重试翻译」无反应；
--   · 手动点「译」后译文渲染到聊天底部、原消息「翻译中…」残留；
--   · 「翻译中…」永久卡住、同一条消息重复点击/重复扣费风险。
--
-- 根因不是几个孤立 bug，而是发送链 / 接收链 / 状态机 / DOM 渲染 / 实例设置
-- 耦合过深。已立项《WhatsApp Translation Bridge 稳定化收口》统一重构，
-- 收口完成并**真机验收全 PASS** 之前，不对外提供任何下载候选。
--
-- ## 明确不做的事
--
--   ✗ **不**回滚并启用 0.1.14 —— 0.1.14 存在明确 P0（点译静默失效 + 发送翻译丢内容），
--     重新启用等于把用户推回一个已知坏版本。
--   ✗ **不**删除任何记录/文件 —— 旧安装包保留为历史产物，仅"停用"。
--
-- 执行后预期：windows / macos 两个 release_group 下**没有任何 enabled = true** 的记录，
-- 即官网下载与客户端更新判定都回到"无候选"（NO RELEASE）。
--
-- 唯一约束 (release_group, os, arch, app, version) 保证重复执行安全（幂等）。

BEGIN;

-- 1) 停用 0.1.15 候选
UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE release_group IN ('windows', 'macos')
  AND version = '0.1.15'
  AND enabled = true;

-- 2) 防御性断言：确保没有把任何旧版本"顺手"重新启用。
--    若这里返回非 0 行，说明系统处于"有候选"状态，需人工确认后再推进——
--    因此用 DO 块直接报错，避免"以为已暂停、其实还有旧版在发"。
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
  FROM client_releases
  WHERE release_group IN ('windows', 'macos') AND enabled = true;
  IF n > 0 THEN
    RAISE EXCEPTION '仍存在 % 条启用的候选记录，未回到 NO RELEASE：请检查是否误启用了旧版本', n;
  END IF;
END $$;

COMMIT;

\echo '--- 暂停结果（windows / macos 下 enabled=true 应为 0 行）---'
SELECT release_group, os, arch, version, enabled FROM client_releases
WHERE release_group IN ('windows', 'macos')
ORDER BY enabled DESC, version DESC, os, arch;
