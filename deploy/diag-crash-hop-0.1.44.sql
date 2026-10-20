-- 从服务端崩溃上报里读出「到底在崩什么」。
-- 表来自 migration 046：client_crash_logs（device_id, crashed_at, 去重键）。
-- 列名以实际迁移为准，若不同请替换下面 4 个字段名再跑。

-- 1) 最近 7 天，按版本看崩溃率
--    判据：某版本「崩溃设备数 / 活跃设备数」明显高于上一版 → 该版有回归。
SELECT
  version,
  COUNT(DISTINCT device_id)              AS crash_devices,
  COUNT(*)                               AS crash_rows,
  MIN(crashed_at)                        AS first_at,
  MAX(crashed_at)                        AS last_at
FROM client_crash_logs
WHERE crashed_at >= NOW() - INTERVAL '7 days'
GROUP BY version
ORDER BY last_at DESC;

-- 2) 崩溃原文 top 20（把「同一个原因反复发生」挑出来，而不是逐个设备看）
--    看 reason / exitCode：oom 与 crashed 是两条完全不同的排查路径。
SELECT
  LEFT(payload_line, 160) AS line,
  COUNT(*)                AS times,
  COUNT(DISTINCT device_id) AS devices
FROM client_crash_logs
CROSS JOIN LATERAL unnest(lines) AS payload_line
WHERE crashed_at >= NOW() - INTERVAL '7 days'
GROUP BY LEFT(payload_line, 160)
ORDER BY times DESC
LIMIT 20;

-- 3) 「启动后立刻崩」的比例（崩溃循环用户）。
--    这些用户最该走安全模式；判据：同一设备 24h 内 >=3 次崩溃。
SELECT device_id, COUNT(*) AS crashes_24h, MIN(crashed_at) AS first_at, MAX(crashed_at) AS last_at
FROM client_crash_logs
WHERE crashed_at >= NOW() - INTERVAL '24 hours'
GROUP BY device_id
HAVING COUNT(*) >= 3
ORDER BY crashes_24h DESC;

-- 4) 内存峰值 vs 崩溃（验证「是内存还是代码」）
--    若多数崩溃的 memory_peak < 80%，那内存不是主因，别再调阈值。
SELECT
  CASE
    WHEN raw::jsonb ->> 'memoryPeak' IS NULL THEN 'unknown'
    WHEN (raw::jsonb ->> 'memoryPeak')::int < 60 THEN '<60%'
    WHEN (raw::jsonb ->> 'memoryPeak')::int < 80 THEN '60-80%'
    ELSE '>=80%'
  END AS memory_band,
  COUNT(*) AS crashes
FROM client_crash_logs
WHERE crashed_at >= NOW() - INTERVAL '7 days'
GROUP BY 1
ORDER BY 2 DESC;
