-- 修正翻译通道的接口地址与备注。
--
-- 起因：真机探针（scripts/probe-translate-engines.js）实测发现，
-- wired=true 的 4 个通道里有 2 个**根本翻不了**，而原因不是凭据：
--
--   deepseek  端点填的是 https://platform.deepseek.com/usage  ← 用量控制台页面
--   gpt       端点填的是 https://platform.openai.com/         ← 控制台首页
--
-- 适配器把 endpoint 当**基址**再补路径（endpointOf / deepseekEndpoint），
-- 于是实际打到的是：
--   https://platform.deepseek.com/usage/chat/completions   → HTTP 405
--   https://platform.openai.com/chat/completions            → HTTP 403
-- 两个"已接通"的通道因此对商户表现为 502「翻译服务暂不可用」。
--
-- 换成厂商官方 API 端点后实测：
--   deepseek + https://api.deepseek.com        → ✅ 通
--   gpt      + https://api.openai.com/v1       → 403 变 400，暴露出第二个问题：
--              gpt-5.6-luna 只接受默认 temperature(=1)，传 0 被拒。
--              适配层已改为"被明确拒绝时去掉 temperature 重试一次"
--              （server/services/translation-adapters.js），**需要部署才生效**。
--
-- 备注同步改写：把"凭据未配置，默认不接通厂商"这类过时/占位文案
-- 换成该通道真实的接入要点，尤其是"端点必须填什么"——
-- 这次踩的坑正是端点填成了控制台地址，值得留在备注里防止复发。
-- （grok 的备注原本是 "11"，无意义。）

BEGIN;

UPDATE engines SET
  endpoint = 'https://api.deepseek.com',
  note = '对话式翻译（OpenAI 兼容 /chat/completions），已关闭思考模式。'
      || '端点必须填 https://api.deepseek.com —— 填控制台页面地址会 405（曾踩过）。'
      || '按 token 计费（flash 空闲时段 输入1元/输出4元 每百万 tokens），'
      || '此处成本为折算近似值，请按真实账单校准。',
  updated_at = NOW()
WHERE id = 'deepseek';

UPDATE engines SET
  endpoint = 'https://api.openai.com/v1',
  note = '对话式翻译（OpenAI 兼容 /chat/completions）。'
      || '端点必须填 https://api.openai.com/v1 —— 填 platform.openai.com 会 403（曾踩过）。'
      || '注意推理类模型（gpt-5 系列等）只接受默认 temperature，'
      || '适配层会在被拒时自动去掉该参数重试一次。',
  updated_at = NOW()
WHERE id = 'gpt';

-- 这个通道本来就是对的，只把过于简短的备注补全，记下正确端点
UPDATE engines SET
  note = 'Cloud Translation 官方 API (v2)。'
      || '端点 https://translation.googleapis.com/language/translate/v2，按字符计费。',
  updated_at = NOW()
WHERE id = 'google';

UPDATE engines SET
  note = '对话式翻译（OpenAI 兼容 /chat/completions）。端点 https://api.x.ai/v1。'
      || '（原备注为占位内容 "11"，已改写为接入要点。）',
  updated_at = NOW()
WHERE id = 'grok';

-- 未接通的通道：备注保留"凭据未配置"，但补一句该填什么，方便下次接入
UPDATE engines SET note = '凭据未配置，默认不接通厂商。接入需填 API Key。'
WHERE id = 'deepl' AND note = '凭据未配置，默认不接通厂商';

UPDATE engines SET note = '凭据未配置，默认不接通厂商。接入需填 API Key，模型可覆盖（如 gemini-2.5-pro）。'
WHERE id = 'gemini';

UPDATE engines SET note = '凭据未配置，默认不接通厂商。接入需同时填 Client ID 与 Client Secret 两个值。'
WHERE id = 'papago';

UPDATE engines SET note = '凭据未配置，默认不接通厂商。接入需同时填 Access Key ID 与 Secret Access Key 两个值。'
WHERE id = 'aws';

UPDATE engines SET note = '凭据未配置，默认不接通厂商。接入需填 API Key。'
WHERE id = 'niutrans' AND note = '凭据未配置，默认不接通厂商';

COMMIT;

\echo '--- 修正后：接口地址与接通状态 ---'
SELECT id, wired AS 接通, endpoint AS 接口地址, updated_at::date AS 改动日
FROM engines ORDER BY wired DESC, id;
