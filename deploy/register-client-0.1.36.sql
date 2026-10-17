-- 登记 0.1.36 客户端版本（macOS 双架构 + Windows 安装版），并停用同组旧记录。
--
-- ## 本版内容：闪退取证（**不改任何功能行为**）
--
-- 起因：用户反馈「开着很多窗口时闪退」。查代码时发现，
-- 即使拿到日志也查不出原因 —— 三处取证缺口：
--
--   ① 只有**主窗口**记了 render-process-gone，每个实例自己的渲染进程
--      崩了日志里一个字都没有。而开几十个窗口时，最先被内存压垮的正是实例进程。
--   ② `child-process-gone` 完全没挂：GPU / utility 进程崩溃无声无息 ——
--      那正是"界面突然白屏、软件整个消失、连错误提示都没有"的常见成因。
--   ③ 崩溃只留一句 reason，**不知道崩的时候整机还有多少内存、开着几个窗口**。
--      而这才是决定"改阈值还是改策略"的关键数字。
--
-- ## 修改（全部是新增日志，不触碰任何判定/加载/代理逻辑）
--
--   · 实例视图挂 render-process-gone → 记「应用#序号 reason exitCode」，
--     reason=oom 时明确标「★内存不足」。
--   · app.on('child-process-gone') → 记 type/name/reason/exitCode。
--   · startMemorySampling()：每 15 秒采样，**只在跨过水位档位时写**日志
--     （<70% 每 10 点、≥70% 每 5 点、≥90% 每 2 点），平时安静；
--     一旦吃紧，日志里就是一串爬升曲线。同时记实例数与主进程 RSS，
--     用于区分"整机吃紧"还是"我们在漏"。定时器 unref，不阻止退出。
--
-- ## 真机验证（真 Electron 跑出来的，不是读代码）
--   · 内存采样：`[memory] 整机已用 85%（6996/8192MB，口径 vm_stat）实例 0 个 RSS 76MB`
--   · 实例崩溃：forcefullyCrashRenderer 后 `[crash] ... reason=killed`
--   · GPU 崩溃：杀 GPU 辅助进程后 child-process-gone 真实触发
--     `type=GPU reason=killed exitCode=9`，日志同步落盘
--   · ⚠️ 同时确认：**child-process-gone 对渲染进程不触发**（实测 0 次），
--     所以实例级监听必须单独保留，两者互补，不能合并。
--   · 全量：1221 项 / 1207 通过 / **0 失败** / 14 跳过
--
-- ## 与上一版的关系
--   0.1.35 记录停用不删除，留作回滚。
--   沿用既有约定：Windows **只登记安装版（Setup）**；portable（免安装版）
--   同样上传到 downloads 供直接下载，但不登记进更新通道。
--
-- 唯一约束是 (release_group, os, arch, app, version)，重复执行不会出错。

BEGIN;

-- 停用旧版本。注意：Windows 的 url 指向 Setup.exe，app 字段区分两种形态。
UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE release_group IN ('macos', 'windows')
  AND version <> '0.1.36'
  AND enabled = true;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  -- ---------------- macOS ----------------
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.36',
   'https://pixfanyi.com/downloads/HelloPix-0.1.36-arm64.dmg', true,
   '新增闪退诊断能力，遇到闪退可以更快定位原因：现在会记录崩溃的具体原因（内存不足 / 进程异常退出）、记录每个窗口各自的崩溃情况，并定时记录系统内存占用。此版本不改变任何功能行为，建议开窗口较多、或曾遇到闪退的用户更新。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.36',
   'https://pixfanyi.com/downloads/HelloPix-0.1.36-x64.dmg', true,
   '新增闪退诊断能力，遇到闪退可以更快定位原因：现在会记录崩溃的具体原因（内存不足 / 进程异常退出）、记录每个窗口各自的崩溃情况，并定时记录系统内存占用。此版本不改变任何功能行为，建议开窗口较多、或曾遇到闪退的用户更新。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  -- ---------------- Windows（只登记安装版）----------------
  ('windows', 'Windows（64 位）', 'Windows', 'x64', '', '0.1.36',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.36.exe', true,
   '新增闪退诊断能力，遇到闪退可以更快定位原因：现在会记录崩溃的具体原因（内存不足 / 进程异常退出）、记录每个窗口各自的崩溃情况，并定时记录系统内存占用。此版本不改变任何功能行为，建议开窗口较多、或曾遇到闪退的用户更新。')
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

\echo '--- 登记结果（macos 应恰为 2 条 0.1.36；windows 应恰为 1 条 0.1.36）---'
SELECT release_group, os, arch, app, version, enabled FROM client_releases
WHERE release_group IN ('windows', 'macos')
ORDER BY release_group, enabled DESC, version DESC, os, arch, app;
