-- 从服务端崩溃上报里读出「到底在崩什么」。
--
-- 表结构（实测，client_crash_logs）：
--   lines jsonb  —— **对象数组** [{at, text, scope}]，不是字符串数组。
--   所以必须 jsonb_array_elements() 再取 ->>'text'，不能 unnest(lines)。
--   scope 取值：crash / memory。
--
-- 全部只读。

\echo '=== 1) 近 7 天按版本看崩溃设备数 ==='
SELECT
  version,
  COUNT(DISTINCT device_id) AS crash_devices,
  COUNT(*)                  AS crash_rows,
  MAX(crashed_at)           AS last_at
FROM client_crash_logs
WHERE crashed_at >= NOW() - INTERVAL '7 days'
GROUP BY version
ORDER BY last_at DESC;

\echo ''
\echo '=== 2) 崩溃原文 Top 20（同一个原因反复发生） ==='
-- 只看 scope=crash 的行：memory 行是水位采样，量大且不说明崩溃原因。
SELECT
  LEFT(l->>'text', 120)       AS line,
  COUNT(*)                    AS times,
  COUNT(DISTINCT c.device_id) AS devices
FROM client_crash_logs c
CROSS JOIN LATERAL jsonb_array_elements(c.lines) AS l
WHERE c.crashed_at >= NOW() - INTERVAL '7 days'
  AND l->>'scope' = 'crash'
GROUP BY LEFT(l->>'text', 120)
ORDER BY times DESC
LIMIT 20;

\echo ''
\echo '=== 3) 按 reason 统计（oom / crashed / killed 是三条不同排查路径） ==='
SELECT
  COALESCE(reason, '(无记录)') AS reason,
  COUNT(*)                     AS reports,
  COUNT(DISTINCT device_id)    AS devices
FROM client_crash_logs c
LEFT JOIN LATERAL unnest(c.reasons) AS reason ON TRUE
WHERE crashed_at >= NOW() - INTERVAL '7 days'
GROUP BY 1
ORDER BY reports DESC;

\echo ''
\echo '=== 4) 内存水位分布 —— 判断到底是不是内存压爆 ==='
SELECT
  CASE
    WHEN memory_peak_pct IS NULL THEN '无数据'
    WHEN memory_peak_pct >= 95 THEN '95%+  系统濒死'
    WHEN memory_peak_pct >= 90 THEN '90-95% 严重'
    WHEN memory_peak_pct >= 80 THEN '80-90% 高压'
    WHEN memory_peak_pct >= 60 THEN '60-80% 正常偏高'
    ELSE '<60% 内存充足'
  END                AS bucket,
  COUNT(*)           AS reports,
  COUNT(DISTINCT device_id) AS devices,
  ROUND(AVG(memory_peak_pct), 1) AS avg_pct
FROM client_crash_logs
WHERE crashed_at >= NOW() - INTERVAL '7 days'
GROUP BY 1
ORDER BY avg_pct DESC NULLS LAST;

\echo ''
\echo '=== 5) 反复崩的设备（同一台机多次上报 = 结构性撑不住） ==='
SELECT
  device_id,
  COUNT(*)            AS reports,
  MAX(crash_count)    AS max_crash_in_report,
  MAX(memory_peak_pct) AS peak_pct
FROM client_crash_logs
WHERE crashed_at >= NOW() - INTERVAL '7 days'
GROUP BY device_id
ORDER BY reports DESC, max_crash_in_report DESC
LIMIT 10;
