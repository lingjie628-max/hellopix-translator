-- 发送翻译 P0 · 服务端对账（**只读**，不改任何数据）
--
-- 配套：0.1.14-验收包/0.1.14-真机验收手册.md §3.13 / §3.14
--      与客户端取证文件 rc014-evidence-*.txt 配合使用。
--
-- 用法（在本机跑；服务端已就绪，我会执行）：
--
--   psql -d hello_pix \
--     -v username='ahao' \
--     -v since="'2026-10-07 18:00:00-04'" \
--     -f deploy/reconcile-send-translate.sql
--
-- username 是 Pix 账号名；since 是验收开始的本地时间（务必带时区）。
-- 不带参数时默认「最近 2 小时、全部账号」。
--
-- ## 为什么必须服务端对账（不能只看客户端）
--
-- 这次 P0 的本质是「界面一切正常，原文已经发出去了」。客户端日志能证明
-- **请求发出去过**，但只有服务端能回答三个客户不会关心、却决定要不要开放的问题：
--   ① 每条消息**恰好**一条 manual_send（不重不漏 → 不重复扣费、不重复发送）
--   ② 字符扣减 = 该条**原文**长度（不是译文的、也不是两倍）
--   ③ 群聊自动翻译（auto_receive）没有被本版改坏

\set ON_ERROR_STOP on

\if :{?username}
\else
  \set username ''
\endif

\if :{?since}
\else
  \set since 'now() - interval ''2 hours'''
\endif

\echo ''
\echo '=============================================================='
\echo ' 发送翻译 P0 对账 · 只读'
\echo ' 账号     :' :username
\echo ' 起始时间 :' :since
\echo '=============================================================='

-- ---------------------------------------------------------------------------
-- 1) 明细：这段时间里到底翻了什么、算在谁头上、来源是什么
-- ---------------------------------------------------------------------------
\echo ''
\echo '---- 1. 明细（最近 200 条）----'
\echo '     判读重点：'
\echo '       · trigger 必须是 manual_send（发送翻译）或 auto_receive / manual_click'
\echo '       · 空串 '' = 未声明来源 → 说明客户端没带上 trigger（0.1.12/0.1.13 的行为）'
\echo '       · cached=t 的条目不扣费，但**仍然应该只对应一次用户动作**'
\echo '       · l.from → l.to 必须与验收设置一致（如 auto → en）'
SELECT
  to_char(l.created_at, 'MM-DD HH24:MI:SS') AS 时间,
  COALESCE(u.username, '?')                 AS 账号,
  COALESCE(sa.username, '-')                AS 子账号,
  l.engine_id                               AS 通道,
  l.trigger                                 AS 来源,
  l.source_language || '→' || l.target_language AS 方向,
  l.chars                                   AS 字符,
  l.cached                                  AS 命中缓存,
  left(l.snippet, 40)                       AS 原文片段
FROM translate_logs l
LEFT JOIN users u            ON u.id = l.user_id
LEFT JOIN sub_accounts sa    ON sa.id = l.sub_account_id AND sa.parent_id = l.user_id
WHERE l.created_at >= :since
  AND (:'username' = '' OR u.username = :'username')
ORDER BY l.created_at DESC
LIMIT 200;

-- ---------------------------------------------------------------------------
-- 2) 按来源汇总：本版最关键的判据
-- ---------------------------------------------------------------------------
\echo ''
\echo '---- 2. 按 trigger 汇总 ----'
\echo '     ✅ 期望：manual_send 条数 == 你手动发送的消息条数'
\echo '     ❌ 若 manual_send 缺失、或 trigger 全是空串 → 客户端没上 0.1.14 / 打点没生效'
\echo '     ❌ 若 auto_receive 在"群组翻译=手动"时不为 0 → 群聊闸门坏了'
SELECT
  CASE l.trigger
    WHEN ''             THEN '（未声明）'
    WHEN 'manual_send'  THEN '发送翻译'
    WHEN 'manual_click' THEN '手动点译'
    WHEN 'auto_receive' THEN '群聊自动'
    WHEN 'retranslate'  THEN '重新翻译'
    ELSE l.trigger
  END                                       AS 来源,
  count(*)                                  AS 条数,
  sum(l.chars)                              AS 总字符,
  count(*) FILTER (WHERE l.cached)          AS 其中命中缓存,
  min(l.created_at)                         AS 最早,
  max(l.created_at)                         AS 最晚
FROM translate_logs l
LEFT JOIN users u ON u.id = l.user_id
WHERE l.created_at >= :since
  AND (:'username' = '' OR u.username = :'username')
GROUP BY 1
ORDER BY 条数 DESC;

-- ---------------------------------------------------------------------------
-- 3) 逐条对账：一次发送 = 一次计费
-- ---------------------------------------------------------------------------
\echo ''
\echo '---- 3. 重复计费排查（同一份原文在 60 秒内被多次计费）----'
\echo '     ✅ 期望：0 行（一条消息只扣一次字符）'
\echo '     如果出现，说明"连续发 5 条"里有多扣 —— 严重，必须回传'
SELECT
  l.source_hash                                   AS 原文指纹,
  count(*)                                        AS 计费次数,
  sum(l.chars)                                    AS 合计字符,
  min(l.chars)                                    AS 单次字符,
  to_char(min(l.created_at), 'MM-DD HH24:MI:SS')  AS 首次,
  to_char(max(l.created_at), 'MM-DD HH24:MI:SS')  AS 末次,
  string_agg(DISTINCT l.trigger, ',')             AS 来源,
  left(min(l.snippet), 40)                        AS 原文片段
FROM translate_logs l
LEFT JOIN users u ON u.id = l.user_id
WHERE l.created_at >= :since
  AND (:'username' = '' OR u.username = :'username')
  AND l.cached = false
GROUP BY l.source_hash
HAVING count(*) > 1
   AND max(l.created_at) - min(l.created_at) < interval '60 seconds'
ORDER BY 末次 DESC;

-- ---------------------------------------------------------------------------
-- 4) 字符扣减是否等于原文长度
-- ---------------------------------------------------------------------------
\echo ''
\echo '---- 4. 字符扣减抽样（chars vs 原文长度）----'
\echo '     判读重点：chars 应当就是用户输入正文的长度。'
\echo '       · 明显偏大（≈2 倍）→ 一次发送被计了两次'
\echo '       · 含 UI 文案 / 时间戳 → source_text 被污染（0.1.10 的老问题）'
SELECT
  to_char(l.created_at, 'MM-DD HH24:MI:SS')      AS 时间,
  l.trigger                                      AS 来源,
  l.chars                                        AS 扣减字符,
  char_length(l.snippet)                         AS 原文片段长度,
  l.chars - char_length(l.snippet)               AS 差值,
  CASE
    WHEN l.chars > char_length(l.snippet) * 2      THEN '❌ 疑似重复计费'
    WHEN l.chars > char_length(l.snippet)          THEN '⚠️ 扣得比片段长'
    WHEN l.chars < char_length(l.snippet)          THEN '⚠️ 扣得比片段短'
    ELSE '✅ 相符'
  END                                            AS 判定,
  left(l.snippet, 60)                            AS 原文片段
FROM translate_logs l
LEFT JOIN users u ON u.id = l.user_id
WHERE l.created_at >= :since
  AND (:'username' = '' OR u.username = :'username')
  AND l.trigger IN ('manual_send', 'manual_click', 'auto_receive', '')
ORDER BY l.created_at DESC
LIMIT 40;

-- ---------------------------------------------------------------------------
-- 4b) 旧 client 多扣的钱：snippet 里粘着时间戳 / UI 文案
--
-- 背景：0.1.14 之前，sourceText 取自气泡 innerText，会把时间戳、已读图标、
-- 预览标题一起喂给翻译接口并**按整串长度计费**。生产账单里出现过
-- "Sweet dreams18:53" —— 用户只输了 12 个字符，却被扣了 17 个。
--
-- 0.1.14 的解析器已按 DOM 结构剥离这些噪音（见 test/message-parser.test.js
-- 用例 11/12，含 24 小时制）。本节用来把「历史多扣」逐条算清楚，便于补偿。
-- ---------------------------------------------------------------------------
\echo ''
\echo '---- 4b. 历史多扣排查（正文尾部粘着时钟 / UI 文案）----'
\echo '     判读重点：每行右侧的 应退字符 就是该条被多扣的字符数'
\echo '       · 时钟污染的 应退字符 可直接用于退费'
\echo '       · 含 UI 文案的无法在服务端还原纯正文 → 标为 NULL，需人工核定'
\echo '         （NULL 而不是 0：报 0 会把"确实多扣了"伪装成"没多扣"）'
\echo '       · 版本判定依据 trigger：0.1.14 起才会写 trigger，'
\echo '         空串 = 旧版本（解析器还没剥离噪音）→ 出现属预期；'
\echo '         非空却仍污染 = 本版回归 → ❌ 必须回传'
\echo '       ⚠️ 已知误报：正文本身就以时间结尾的正常消息（如'
\echo '          "let us meet at 18:53"）会被算成时钟污染。每行只有几字符，'
\echo '          若样例里大量出现这种句尾时间，请先人工核对再退款。'
SELECT
  to_char(l.created_at, 'MM-DD HH24:MI:SS')        AS 时间,
  COALESCE(u.username, '?')                        AS 账号,
  l.trigger                                        AS 来源,
  l.chars                                          AS 实际扣减,
  l.snippet                                        AS 原文片段,
  -- 尾部时钟形如 18:53 / 3:25 PM
  (regexp_match(l.snippet, '([0-9]{1,2}:[0-9]{2}(:[0-9]{2})?\s*(AM|PM)?)$'))[1]
                                                   AS 尾部时钟,
  CASE
    WHEN l.snippet ~ 'wds-ic-read|View group|查看群组|Group chat invite|chat\.whatsapp\.com'
      THEN NULL
    ELSE char_length(l.snippet)
           - char_length(regexp_replace(l.snippet, '([0-9]{1,2}:[0-9]{2}(:[0-9]{2})?\s*(AM|PM)?)$', ''))
  END                                              AS 应退字符,
  CASE
    WHEN l.snippet ~ 'wds-ic-read|View group|查看群组|Group chat invite|chat\.whatsapp\.com'
      THEN '含 UI 文案（需人工核定）'
    ELSE '时钟污染（可自动核定）'
  END                                              AS 污染类型,
  CASE
    WHEN l.trigger = ''  THEN '旧版（预期）'
    ELSE '❌ 本版回归'
  END                                              AS 版本判定
FROM translate_logs l
LEFT JOIN users u ON u.id = l.user_id
WHERE l.created_at >= :since
  AND (:'username' = '' OR u.username = :'username')
  AND l.cached = false
  AND (
        l.snippet ~ '([0-9]{1,2}:[0-9]{2}(:[0-9]{2})?\s*(AM|PM)?)$'
     OR l.snippet ~ 'wds-ic-read|View group|查看群组|Group chat invite|chat\.whatsapp\.com'
      )
ORDER BY l.created_at DESC
LIMIT 100;

\echo ''
\echo '---- 4b-汇总：若需退费，金额按此汇总 ----'
\echo '     注：含 UI 文案的条目不计入 合计应退字符（服务端还原不出纯正文，'
\echo '         强行按 0 计会少退；需按人工核定的结果单独补）'
\echo '         版本判定=❌ 本版回归 的条目必须先查清，不要直接退款了事'
SELECT
  CASE
    WHEN l.snippet ~ 'wds-ic-read|View group|查看群组|Group chat invite|chat\.whatsapp\.com'
      THEN '含 UI 文案（需人工核定）'
    ELSE '时钟污染（可自动核定）'
  END                                              AS 污染类型,
  CASE WHEN l.trigger = '' THEN '旧版（预期）' ELSE '❌ 本版回归' END AS 版本判定,
  COALESCE(NULLIF(l.trigger, ''), '（未声明）')     AS 来源,
  count(*)                                         AS 污染条数,
  sum(
    CASE
      WHEN l.snippet ~ 'wds-ic-read|View group|查看群组|Group chat invite|chat\.whatsapp\.com'
        THEN NULL
      ELSE char_length(l.snippet)
             - char_length(regexp_replace(l.snippet, '([0-9]{1,2}:[0-9]{2}(:[0-9]{2})?\s*(AM|PM)?)$', ''))
    END
  )                                                AS 合计应退字符,
  min(l.created_at)                                AS 最早,
  max(l.created_at)                                AS 最晚
FROM translate_logs l
LEFT JOIN users u ON u.id = l.user_id
WHERE l.created_at >= :since
  AND (:'username' = '' OR u.username = :'username')
  AND l.cached = false
  AND (
        l.snippet ~ '([0-9]{1,2}:[0-9]{2}(:[0-9]{2})?\s*(AM|PM)?)$'
     OR l.snippet ~ 'wds-ic-read|View group|查看群组|Group chat invite|chat\.whatsapp\.com'
      )
GROUP BY 1, 2, 3
ORDER BY 版本判定 DESC, 污染类型, 污染条数 DESC;

-- ---------------------------------------------------------------------------
-- 5) 群聊回归：手动模式下不该有任何自动翻译
-- ---------------------------------------------------------------------------
\echo ''
\echo '---- 5. auto_receive 是否在"手动"实例上仍然出现 ----'
\echo '     ⚠️ 这项需要人工对照：如果这台电脑上的 WhatsApp 实例'
\echo '        「群组翻译」是手动，那么下面的条数必须是 0'
SELECT
  to_char(l.created_at, 'MM-DD HH24:MI:SS')      AS 时间,
  l.trigger                                      AS 来源,
  l.chars                                        AS 字符,
  left(l.snippet, 50)                            AS 原文片段
FROM translate_logs l
LEFT JOIN users u ON u.id = l.user_id
WHERE l.created_at >= :since
  AND (:'username' = '' OR u.username = :'username')
  AND l.trigger = 'auto_receive'
ORDER BY l.created_at DESC
LIMIT 50;

\echo ''
\echo '---- 6. 结论速览 ----'
\echo '     ✅ 通过条件：'
\echo '        · 第 2 节能看到 manual_send，条数 == 你实际发送的消息数'
\echo '        · 第 3 节 0 行（没有重复计费）'
\echo '        · 第 4 节 chars 与原文长度相符'
\echo '        · 第 4b 节出现的都是历史行（旧 client 造成的多扣），可用 应退字符 补偿'
\echo '        · 第 5 节在手动实例上为 0 条'
\echo '     ❌ 任何一项不符 → 把本输出 + rc014-evidence-*.txt 一起发我'
\echo ''
