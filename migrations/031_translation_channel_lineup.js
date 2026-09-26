/**
 * 翻译渠道换线 + 套餐权益版本化（2026-09-25）。
 *
 * ## 一、渠道统一为 11 个
 *
 *   OpenAI 兼容（8）：gpt / grok / deepseek / doubao / kimi / glm / mistral / minimax
 *   专用翻译模型（1）：qwen（Qwen-MT）
 *   Anthropic Messages（1）：claude
 *   官方翻译 API（1）：google
 *
 * 其中 gpt / grok / deepseek / google 已经在生产上跑着（有密文密钥），
 * 本迁移**不 UPDATE 这四行**，只新增 7 个。
 *
 * ## 二、旧渠道不删，只"停用"
 *
 * 凡不在上面 11 个名单里的通道一律下架（**不删除**）。
 * 在迁移 030 之后的典型活表上，这批是：gemini / aws / deepl / niutrans / papago。
 * 清单由活表自己算出来，不手抄 —— 各环境的历史迁移进度不同，engines 里
 * 究竟有哪几个旧通道并不一致，手抄一份就是赌自己抄对了。
 *
 * 为什么不 DELETE：
 *   · `translate_logs.engine_id` 与 `users.active_engine_id` 都是外键
 *     （ON DELETE RESTRICT / SET NULL）。直接删 engines 行会让历史翻译日志
 *     失去归属，或者把商户的选择悄悄清空 —— 那是篡改历史账目。
 *   · `package_engines` 里也留着记录：那是"这一档当初包含哪些通道"的凭据，
 *     是已售权益的原始证据。删了就再也证明不了卖出去的是什么。
 *
 * 新加 `engines.retired_at`：非空 = 已下架。
 *   · **商户侧**：`retired_at IS NOT NULL` 的通道一律不下发（列表里看不到），
 *     已存的选择也会被解析到可用通道上去。
 *   · **管理侧**：仍然可见可编辑（可以重新上架：`retired_at=NULL` 即可）。
 *   · 这才是"下架"该有的样子 —— 对客户不可见，对账目可追溯。
 *
 * ## 三、套餐权益版本化（避免后续调整影响历史购买用户）
 *
 * 原来的权益是 `package_engines` 这张**活表**：改一次表，
 * **所有历史买家的权益跟着一起变**。这次要加 7 个通道，如果直接往活表里塞，
 * 就等于单方面给老客户加东西（听着是好事），但下一次要删通道时，
 * 同一个机制就会单方面**拿走**老客户已经付过钱的东西 —— 那是违约。
 *
 * 所以引入版本：
 *   · `packages.catalog_version`：当前版本号，改通道组合时 +1
 *   · `package_engine_versions(package_id, version, engine_id)`：每个版本的**快照**
 *   · `users.package_catalog_version`：该商户**购买时**的版本（NULL = 跟随活表）
 *   · `recharges.package_catalog_version`：下单时快照，作为"卖出去的是哪一版"的凭据
 *
 * 本次的做法：
 *   · v1 = **改动前的活表逐行副本**（含即将下架的那批）→ 存量商户钉在 v1，
 *     他们买到的就是他们买到的，一个通道不多、一个不少。"改动前"以活表为准，
 *     不靠人工抄写。
 *   · v2 = 本迁移之后的组合（成本核算的结论）
 *   · 存量 users 一律钉到 v1（`package_catalog_version = 1`）
 *   · **例外**：v1 里有任一通道被本次下架 → 版本清成 NULL，跟随在售 v2。
 *     判据为什么是"任一"而不是"全部"，见 up 里那一段的实测说明
 *     （生产基础版 v1 = {google, niutrans}，谷歌存活，按"全部"判就漏了）
 *   · 新下单走 v2
 *   · 超管想给某个老客户升级，把 `users.package_catalog_version` 改成 2 即可 ——
 *     这是**显式**动作，有审计，不会因为是"顺带改了个表"而发生。
 *
 * 权益解析规则（`production-repository.packageEngines`）：
 *   指定了版本 → 读该版本快照；没指定 → 读活表（向后兼容）。
 *
 * ## 四、内部记录上游真实消耗
 *
 * `translate_logs` 记的是**卖给客户的字符数**与按成本表折算的估算成本；
 * 而厂商实际按 token 计费。两者不是一回事，混在一起就永远算不清真实毛利。
 * 新增 `translation_usage` 专门记厂商侧的真实口径：模型、输入/输出/推理 token、
 * 重试次数、按官方单价算出的上游成本。**不参与任何对客户的扣费**。
 */

/**
 * 新增渠道。
 *
 * 每个渠道都要写清：供应商、**实际模型 ID**、调用参数、真实端点与接入坑。
 * 这是本条需求"每个渠道必须配置明确的供应商、实际模型 ID 和调用参数"的落点 ——
 * 前台展示的模型就是这里的 model 值，调用时用的也是它（适配层不再另外兜底
 * 一个"更便宜的模型"）。
 *
 * callParams 只放**适配层会真正发给厂商**的开关与**限额**；它同时也是"我们打算
 * 怎么调"的书面记录，便于事后对账。字段含义：
 *   temperature       采样温度；null = 该模型不能收这个字段（Kimi K3）
 *   maxInputTokens    单条输入上限（token）。超限本地直接拒，**绝不静默截断**
 *   maxOutputTokens   输出上限，防止模型把翻译写成解释文（按输出 token 全额计费）
 *   timeoutMs         超时（适配层会再夹到 [1s, 30s]）
 *   maxRetries        自动重试上限（每次重试都要真花钱，必须封顶）
 *   extraBody         厂商专属参数（如关思考）
 *
 * `cost` 是 `engines.cost_per_million`，单位是**人民币元 / 百万原文字符**，
 * 属于**对内规划用的粗估**（汇率 7.2、保守按"输入 1 token/字 + 输出 0.5 token/字"）。
 * 它只用于 `translate_logs.cost_amount` 这类粗粒度统计，
 * **权威成本以 `translation_usage` 表为准** —— 那里记的是厂商真实 token × 官方单价。
 * 拿粗估当财务口径会把误差放大到看不见的地方。
 */
const NEW_ENGINES = [
  {
    id: 'qwen',
    name: '通义千问翻译',
    provider: '阿里云百炼',
    tier: 'basic',
    cost: 1.7,
    model: 'qwen-mt-flash',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    callParams: {
      temperature: 0,
      // 官方硬限制：qwen-mt 单条输入 8192 tokens。本地先拦，给用户看得懂的提示。
      maxInputTokens: 8192,
      maxOutputTokens: 4096,
      timeoutMs: 10000,
      maxRetries: 2
    },
    note: 'Qwen-MT 专用翻译模型（不是通用大模型按提示词翻译），因而更便宜更快，中译英等常见方向质量更稳。' +
      '走 DashScope 的 OpenAI 兼容入口。模型可选 qwen-mt-flash（通用首选）/ qwen-mt-plus（质量最高，价格待核实）/ qwen-mt-lite（最低延迟，仅 31 种语言）。' +
      '两个已处理的坑：① 该模型只接受一条 user 消息，传 system 会 400；② 语种走 translation_options，且必须是英文全称（Chinese / English），不是 ISO 码。' +
      '官方价（2026-08-26，华北2）：输入 0.7 元、输出 1.95 元 / 百万 tokens。'
  },
  {
    id: 'claude',
    name: 'Claude 翻译',
    provider: 'Anthropic',
    tier: 'pro',
    cost: 25.0,
    model: 'claude-haiku-4-5',
    endpoint: 'https://api.anthropic.com/v1',
    callParams: {
      temperature: 0,
      maxOutputTokens: 8192,
      timeoutMs: 12000,
      maxRetries: 2
    },
    note: 'Claude 走 Messages API，与 OpenAI 兼容协议不同（x-api-key 与 anthropic-version 头、max_tokens 必填、system 是顶层字段、返回 content 数组），适配层单独实现。' +
      '端点必须写到 https://api.anthropic.com/v1 —— 只填 https://api.anthropic.com 会 404。' +
      '默认 claude-haiku-4-5（最快最省，翻译够用）；要质量可换 claude-sonnet-5（$2/$10，贵约 2 倍）。' +
      '官方价（2026-09）：$1 / 百万输入 token、$5 / 百万输出 token。'
  },
  {
    id: 'doubao',
    name: '豆包翻译',
    provider: '火山引擎方舟',
    tier: 'basic',
    cost: 4.8,
    model: 'doubao-seed-1-6',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
    callParams: {
      temperature: 0,
      maxInputTokens: 32000,
      maxOutputTokens: 4096,
      timeoutMs: 10000,
      maxRetries: 2,
      extraBody: { thinking: { type: 'disabled' } }
    },
    note: '火山方舟，OpenAI 兼容，国内直连、延迟低。' +
      '方舟的「模型」栏有两套填法：新账号可直接填模型名（doubao-seed-1-6），老账号必须先创建推理接入点、把 ep- 开头的接入点 ID 填进来；填错会报 Model not found。' +
      '官方价**按单次输入长度分档**（2026-08-02）：输入 ≤32K 时输入 0.8 元、输出 8 元 / 百万 tokens（输出 ≤200 tokens 有过 2 元的特惠档，长句够不到）；32K~128K 为 1.2/16；128K~256K 为 2.4/24。'
  },
  {
    id: 'kimi',
    name: 'Kimi 翻译',
    provider: '月之暗面',
    tier: 'advanced',
    cost: 75.0,
    model: 'kimi-k3',
    endpoint: 'https://api.moonshot.cn/v1',
    callParams: {
      // K3 把采样参数固定在服务端（temperature=1、top_p=0.95），官方明确建议不要传。
      // null = 不发送该字段（0 是"要它稳定"的真实意图，语义不能混）。
      temperature: null,
      maxInputTokens: 128000,
      maxOutputTokens: 4096,
      timeoutMs: 12000,
      maxRetries: 1
    },
    note: '月之暗面，OpenAI 兼容。中文长文本与口语化内容表现好，适合聊天场景。' +
      '端点 https://api.moonshot.cn/v1（国际站 api.moonshot.ai/v1，后台可覆盖）。' +
      'K3 是月之暗面最贵的旗舰，1,048,576 tokens 上下文；**不要传 temperature/top_p**，官方把采样参数固定在服务端。' +
      '官方价（2026-09）：$3 / 百万输入 token、$15 / 百万输出 token（缓存命中输入 $0.30）。'
  },
  {
    id: 'glm',
    name: 'GLM 翻译',
    provider: '智谱开放平台',
    tier: 'advanced',
    cost: 10.0,
    model: 'glm-4.7',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    callParams: {
      temperature: 0,
      maxInputTokens: 32000,
      maxOutputTokens: 4096,
      timeoutMs: 12000,
      maxRetries: 2,
      extraBody: { thinking: { type: 'disabled' } }
    },
    note: '智谱 GLM，OpenAI 兼容。端点必须写到 /api/paas/v4 —— 只填域名会拼出错误路径。' +
      '默认 glm-4.7 而非 glm-4.6：GLM-4.6 在官方价格页上已归入「算力单元/私有实例」（¥175/GPU Unit/天），不适合按字符零售；glm-4.7 才是现行按量计费的文本旗舰。也可换 glm-4.7-flashx（¥0.5/¥3）。' +
      '官方价（2026-08）：输入 <32K 且输出 <200 tokens 时 2 元/8 元；输出 ≥200 tokens 时 3 元/14 元；输入 32K~200K 时 4 元/16 元（每百万 tokens）。'
  },
  {
    id: 'mistral',
    name: 'Mistral 翻译',
    provider: 'Mistral AI',
    tier: 'advanced',
    cost: 9.0,
    model: 'mistral-large-latest',
    endpoint: 'https://api.mistral.ai/v1',
    callParams: {
      temperature: 0,
      maxInputTokens: 128000,
      maxOutputTokens: 4096,
      timeoutMs: 12000,
      maxRetries: 2
    },
    note: 'Mistral，OpenAI 兼容。欧洲语系（法/德/西/意）质量突出，适合小语种方向。' +
      'mistral-large-latest 当前指向 Mistral Large 3（API ID mistral-large-2512，256K 上下文）。也可换 mistral-small（约 $0.12/$0.5）。' +
      '官方价（2026-07-24）：$0.5 / 百万输入 token、$1.5 / 百万输出 token；缓存输入约 $0.05。'
  },
  {
    id: 'minimax',
    name: 'MiniMax 翻译',
    provider: 'MiniMax',
    tier: 'advanced',
    cost: 13.0,
    model: 'MiniMax-M3',
    endpoint: 'https://api.minimaxi.com/v1',
    callParams: {
      temperature: 0,
      maxInputTokens: 256000,
      maxOutputTokens: 4096,
      timeoutMs: 12000,
      maxRetries: 2,
      extraBody: { thinking: { type: 'disabled' } }
    },
    note: 'MiniMax，OpenAI 兼容。端点 https://api.minimaxi.com/v1（国际站 api.minimax.io/v1，后台可覆盖）—— ' +
      '**首次接通必须实测**：官方文档示例仍是老路径 /v1/text/chatcompletion_v2，标准 /v1/chat/completions 需确认可用。' +
      '官方价（2026-07-22）：≤512K 输入档 原价 $0.6 / 百万输入 token、$2.4 / 百万输出 token（现促销五折 $0.30/$1.20，促销随时可能结束，核算按原价）。'
  }
]

// 下架集合**不在这里写死**，由 up 用"活表里所有不在 11 个新渠道里的行"算出来。
// 写死会有一个很隐蔽的错法：不同环境的历史迁移不完全一致（本机 dev 库停在
// 008、生产库可能已到 030），engines 里到底有哪几个旧通道并不相同。
// 写死一份清单，等于赌每个环境的活表都长成清单的样子 —— 赌错的结果是
// "某个还在被套餐引用的通道没被下架"，商户点了就报"通道不存在"。
//
// 但**判定用的名单必须是完整的 11 个**，不能只拿新增的那 7 个去比对 ——
// 那样会把正在生产上跑的 gpt / grok / deepseek / google 一起下架，
// 等于一键掐掉全部线上通道。所以显式写出已经在跑的那 4 个。
//
// 最近一次核对（迁移 030 之后的活表）被下架的确实就是这 5 个：
//   gemini / aws / deepl / niutrans / papago
// 它们**只停用、不删除**，理由见本文件头部第二节。
//
// 顺序也重要：先 retired_at + enabled=false，再把商户选择从它们身上挪开。
// 外键仍指向这些行，所以 `users.active_engine_id` 一定指得到一个存在的通道。
const RUNNING_ENGINE_IDS = ['gpt', 'grok', 'deepseek', 'google']
const LINEUP_ENGINE_IDS = RUNNING_ENGINE_IDS.concat(NEW_ENGINES.map(e => e.id))

/**
 * v2：本次换线后，**新买家**看到的通道组合（成本核算的结论，不是拍脑袋分的）：
 *
 *   basic（3）   Qwen-MT、GPT、DeepSeek
 *   advanced（7） + GLM、Mistral、豆包、MiniMax
 *   pro（11）     + Claude、Grok、谷歌翻译、Kimi
 *
 * 分档依据是 `scripts/translation-cost-report.js` 算出的
 * **"用户用满 150 万字符额度、且全部选套餐内最贵通道"** 的上界成本，
 * 阈值取各档售价的 20% 作为 API 成本内部参考线（参考线，不是硬指标）：
 *
 *   基础版 ¥200：最贵通道 DeepSeek 上界 ¥36（18%）
 *   高级版 ¥350：最贵通道 MiniMax  上界 ¥58（17%）
 *   专业版 ¥850：最贵通道 Kimi     上界 ¥329（39%）
 *
 * 三条不能省的解释：
 *
 * 1. **为什么不是 3／7／11 的机械切分**：如果按"第一档 3 个、第二档 7 个"去凑，
 *    Claude（上界 ¥111）会被放进 ¥350 的高级版 —— 一个客户用满额度就吃掉 32%，
 *    再叠加别的客户就是净亏。分档只按成本算，不按数量凑。
 * 2. **为什么基础版里没有谷歌**：谷歌按字符计价（$20/百万字符）、没有 token
 *    优化空间，上界 ¥281 已经超过基础版整档售价 ¥200。它放在专业版里只占 33%。
 * 3. **为什么专业版仍包含 Kimi**：上界占 39%，高于 20% 参考线，但仍在可承受范围，
 *    且"11 个通道随便选"本身是产品承诺。若要把占比压到参考线内，
 *    把 Kimi 移出平档改为按量加购即可（届时 pro 上界降到 ¥281 / 33%）。
 *
 * ⚠️ 这版**只影响此后的新买家**：存量用户被钉在 v1（见本文件头部第三节），
 * 买到的通道一个不多、一个不少。要调整归属请开 v3 并同步更新本数组与成本报告，
 * **不要改动 v1/v2 快照** —— 快照是对账凭据。
 *
 * 这是该版本的**完整目标集合**（含"从活表里移除"的通道），不是增量列表 ——
 * up 里的写法是"先把不在目标集里的删掉，再补齐"，所以回滚也必须按集合恢复。
 */
const PACKAGE_ENGINES_V2 = [
  ['basic', 'qwen'], ['basic', 'gpt'], ['basic', 'deepseek'],
  ['advanced', 'qwen'], ['advanced', 'gpt'], ['advanced', 'deepseek'],
  ['advanced', 'glm'], ['advanced', 'mistral'], ['advanced', 'doubao'], ['advanced', 'minimax'],
  ['pro', 'qwen'], ['pro', 'gpt'], ['pro', 'deepseek'], ['pro', 'glm'], ['pro', 'mistral'],
  ['pro', 'doubao'], ['pro', 'minimax'], ['pro', 'claude'], ['pro', 'grok'],
  ['pro', 'google'], ['pro', 'kimi']
]

// ---------------------------------------------------------------------------

/** 单一引号转义：备注里会出现英文撇号与 `$`，直接拼进 SQL 会截断语句。 */
function q(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function nullable(value) {
  return value === null || value === undefined ? 'NULL' : q(value)
}

/** jsonb 字面量：转义后强制 ::jsonb，避免 pg 把它当普通字符串。 */
function jsonb(value) {
  return q(JSON.stringify(value)) + '::jsonb'
}

const ENGINE_COLUMNS =
  '(id, name, provider, tier, enabled, wired, cost_per_million, model, endpoint, call_params, note)'

/**
 * 生成 engines 的 VALUES 行（列见 ENGINE_COLUMNS，共 11 列）。
 *
 * enabled/wired 默认 **true / false**：先登记、不接通。等超管填了凭据并实测能翻，
 * 保存时由适配器把 wired 置 true（与 scripts/set-engine-wired.js 同一把尺子）。
 * 在此之前商户看到的是「即将上线」、选不了 —— 不会再出现"点了就 503"。
 *
 * 每行套一层括号，让 test/translation-provider.test.js 的"迁移种过的通道必须有
 * 适配器"正则（形如 ('qwen', '通义千问翻译', '阿里云百炼', 'basic'）能扫到。
 */
function engineValues(rows) {
  return rows.map(e => '(' + [
    q(e.id), q(e.name), q(e.provider), q(e.tier),
    e.enabled === false ? 'false' : 'true',
    e.wired === true ? 'true' : 'false',
    e.cost, nullable(e.model), nullable(e.endpoint),
    jsonb(e.callParams || {}), q(e.note || '凭据未配置，默认不接通厂商。')
  ].join(', ') + ')').join(',\n      ')
}

function packageValues(rows) {
  return rows.map(([code, id]) => `        (${q(code)}, ${q(id)})`).join(',\n')
}

function idList(ids) {
  return ids.map(q).join(', ')
}

exports.up = pgm => {
  pgm.sql(`
    -- =====================================================================
    -- 1) engines 扩字段：下架标记 + 调用参数
    -- =====================================================================

    -- retired_at 非空 = 已下架。对商户不可见，对账目可追溯（不删行）。
    ALTER TABLE engines ADD COLUMN IF NOT EXISTS retired_at timestamptz;

    -- 调用参数（温度、输出上限、是否关思考…）。落库而不是写死在代码里：
    -- "每个渠道必须配置明确的调用参数"这条要求，得让人能看见、能改、能对账。
    ALTER TABLE engines ADD COLUMN IF NOT EXISTS call_params jsonb NOT NULL DEFAULT '{}'::jsonb;
    DO $$ BEGIN
      ALTER TABLE engines ADD CONSTRAINT engines_call_params_object_check
        CHECK (jsonb_typeof(call_params) = 'object');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    -- 商户侧一律按 retired_at IS NULL 过滤，给它一个索引
    CREATE INDEX IF NOT EXISTS engines_active_idx ON engines (id) WHERE retired_at IS NULL;

    -- =====================================================================
    -- 2) 登记 7 个新渠道（enabled=true / wired=false：先登记，凭据齐了再接通）
    -- =====================================================================

    INSERT INTO engines
      ${ENGINE_COLUMNS}
    VALUES
      ${engineValues(NEW_ENGINES)}
    ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name,
          provider = EXCLUDED.provider,
          tier = EXCLUDED.tier,
          cost_per_million = EXCLUDED.cost_per_million,
          endpoint = EXCLUDED.endpoint,
          call_params = EXCLUDED.call_params,
          note = EXCLUDED.note,
          updated_at = NOW();
    -- ON CONFLICT 里**没有** enabled / wired / model：
    -- 重跑本迁移不能把已接通的通道打回未接通，也不能覆盖管理员改过的模型名。

    -- ---------------------------------------------------------------------
    -- 2b) 修正 DeepSeek 的模型名（定向，只改这一个已知失效的写法）
    -- ---------------------------------------------------------------------
    --
    -- 生产库里的值是 deepseek-chat，但迁移 008 种下的是 deepseek-flash，
    -- provider 的注释也写明"旧的 deepseek-chat 已不是有效模型名，配错会直接报模型不存在"。
    -- 关键在于模型的取值顺序是**后台配置优先**（deepseekCredentials），
    -- 所以库里这个值会被真的发出去 —— 是它在决定线上调用哪个模型，
    -- 不是那个兜底常量。留着它等于默认一个已失效的名字。
    --
    -- 为什么是"定向改"而不是"统一刷成 canonical"：
    -- gpt / grok / google 三行的值与代码一致（google 本来就没有模型参数，
    -- 它就是按字符计价的 v2 接口），没坏就别动 —— 换模型会改变成本与译文质量，
    -- 属于"静默换模型"，只有已知失效的值才值得动。
    -- 也不加 "AND model IS NULL" 之类的兜底：只改这一个已经被证实失效的确切值，
    -- 不顺手扩成一串"大概也是旧的"名字 —— 那又是靠猜在改生产配置。
    UPDATE engines
    SET model = 'deepseek-flash', updated_at = NOW()
    WHERE id = 'deepseek'
      AND model = 'deepseek-chat';

    -- =====================================================================
    -- 3) 旧渠道下架：只停用、不删除
    -- =====================================================================

    -- 判定标准是"不在 11 个正式渠道名单里"，不是一份手抄的旧通道清单：
    -- 只有活表知道此刻到底存在哪些通道，让它自己算，才不会漏下架。
    -- 注意名单是 LINEUP_ENGINE_IDS（4 个在跑的 + 7 个新增），
    -- 只写新增的 7 个会把生产上正在跑的 4 个一起下架。
    UPDATE engines
    SET retired_at = NOW(), enabled = false, wired = false, updated_at = NOW()
    WHERE id NOT IN (${idList(LINEUP_ENGINE_IDS)})
      AND retired_at IS NULL;
    -- wired=false 与 enabled=false 必须一起写：库级约束
    -- engines_wired_requires_enabled 不允许"停用但接通"这种自相矛盾的状态。

    -- =====================================================================
    -- 4) 套餐权益版本化
    -- =====================================================================

    ALTER TABLE packages ADD COLUMN IF NOT EXISTS catalog_version integer NOT NULL DEFAULT 1;
    DO $$ BEGIN
      ALTER TABLE packages ADD CONSTRAINT packages_catalog_version_check
        CHECK (catalog_version >= 1);
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    CREATE TABLE IF NOT EXISTS package_engine_versions (
      package_id bigint NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      version integer NOT NULL CHECK (version >= 1),
      engine_id varchar(64) NOT NULL REFERENCES engines(id) ON DELETE RESTRICT,
      PRIMARY KEY (package_id, version, engine_id)
    );

    CREATE INDEX IF NOT EXISTS package_engine_versions_engine_idx
      ON package_engine_versions (engine_id);

    -- 商户钉在哪个版本。NULL = 跟随活表（向后兼容：老代码路径不受影响）
    ALTER TABLE users ADD COLUMN IF NOT EXISTS package_catalog_version integer;
    DO $$ BEGIN
      ALTER TABLE users ADD CONSTRAINT users_package_catalog_version_check
        CHECK (package_catalog_version IS NULL OR package_catalog_version >= 1);
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    -- 下单时快照："卖出去的是哪一版"的凭据
    ALTER TABLE recharges ADD COLUMN IF NOT EXISTS package_catalog_version integer;
    DO $$ BEGIN
      ALTER TABLE recharges ADD CONSTRAINT recharges_package_catalog_version_check
        CHECK (package_catalog_version IS NULL OR package_catalog_version >= 1);
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    -- v1 = 迁移运行这一刻**活表的逐行副本** —— 已售权益的原始证据。
    --
    -- 为什么不写死一份清单：写死就等于把"当初卖了什么"改成"我以为当初卖了什么"。
    -- 活表是唯一的事实来源，拷一份不可能拷错；手抄一份清单，任何一处历史差异
    -- 都会变成伪造的已售权益（还可能插到不存在的 engine_id 上、直接撞外键）。
    -- 从这一刻起 package_engines 再怎么变，v1 都不变，历史买家查到的就是当初买到的。
    INSERT INTO package_engine_versions (package_id, version, engine_id)
    SELECT pe.package_id, 1, pe.engine_id
    FROM package_engines pe
    WHERE pe.package_id IN (SELECT id FROM packages WHERE code IN ('basic', 'advanced', 'pro'))
    ON CONFLICT (package_id, version, engine_id) DO NOTHING;

    -- 存量商户钉在 v1：他们买到的就是他们买到的，不因为这次换线
    -- 被单方面加东西、也不被单方面拿走东西。要升级请走后台显式操作。
    UPDATE users SET package_catalog_version = 1, updated_at = NOW()
    WHERE package_catalog_version IS NULL;

    -- 兜底：钉在 v1 的商户，只要 v1 里有**任何一个**通道在这次下架里没了，
    -- 就把他的版本清成 NULL（= 跟随活表 = 当前在售的 v2）。
    --
    -- ## 为什么判据是"任一"而不是"全部"
    --
    -- 一开始写的是"全军覆没才释放"，理由是"只加不减、不碰还能用的权益"。
    -- 这个判据在开发库上看着没问题，一放到生产真实数据上就翻了：
    --
    --   · 开发库 basic 的 v1 = {niutrans}          → 全废 → 触发释放 → 继承 v2
    --   · 生产   basic 的 v1 = {google, niutrans}  → 谷歌还活着 → 不触发
    --
    -- 于是同一份迁移，生产上的基础版买家只剩"谷歌翻译"一个通道（niutrans 已死），
    -- 而新买家花同样的 $40 拿到 deepseek/gpt/qwen —— 老客户还得来问为什么。
    -- 套餐**按当初卖的样子**已经变了（卖给你的一条通道没了），继续冻着就不是
    -- "保住他买到的东西"，而是"把他锁在一个残缺的包里"。
    --
    -- ## 代价要说清楚，免得以后有人"顺手修好"
    --
    -- 释放版本 = 完全跟随在售的 v2，这**可能拿掉一个还活着的通道**：
    -- 生产 basic 的 v1 有谷歌，而 v2 的基础版刻意不含谷歌（整档才卖 $40，
    -- 谷歌满额成本上界 ¥281，放进去就是用满即亏）。所以基础版老客户
    -- 会失去谷歌、换到 deepseek/gpt/qwen 三个通道 —— 净额是升级，
    -- 但确实是一处"减"，不是纯粹的"只加"。
    --
    -- ## 另一条备选（本轮未采用）
    --
    -- "并集"：保留 v1 里还活着的通道，再加入 v2 的通道。谁都不丢东西，
    -- 但老客户的权益会比新买家多，且成本结构再也说不清（每人的可用集合都不同）。
    -- 选了"任一即释放"，就是要老客户与新买家口径一致、成本可核算。
    UPDATE users u SET package_catalog_version = NULL, updated_at = NOW()
    WHERE u.package_catalog_version = 1
      AND EXISTS (
        SELECT 1
        FROM package_engine_versions v
        JOIN engines e ON e.id = v.engine_id
        WHERE v.package_id = u.package_id
          AND v.version = 1
          AND e.retired_at IS NOT NULL
      );

    -- 活表推到 v2。
    --
    -- 这一步**要删也要加**：只加不删的话，基础版会同时留着谷歌（上界 ¥281）与
    -- 新加的通道，而基础版整档才卖 ¥200 —— 新买家选中谷歌用满额度就是净亏。
    -- 删除 package_engines 的行**不会**动到任何已售权益：v1 存在
    -- package_engine_versions 里（上一步已固化），存量 users 也钉在 v1。
    -- （本段刻意不用反引号：整段 SQL 在 JS 模板字符串里，反引号会截断它。）
    DELETE FROM package_engines pe
    USING packages p
    WHERE pe.package_id = p.id
      AND p.code IN ('basic', 'advanced', 'pro')
      AND NOT EXISTS (
        SELECT 1 FROM (
          VALUES
${packageValues(PACKAGE_ENGINES_V2)}
        ) AS m(package_code, engine_id)
        WHERE m.package_code = p.code AND m.engine_id = pe.engine_id
      );

    INSERT INTO package_engines (package_id, engine_id)
    SELECT p.id, m.engine_id
    FROM (
      VALUES
${packageValues(PACKAGE_ENGINES_V2)}
    ) AS m(package_code, engine_id)
    JOIN packages p ON p.code = m.package_code
    ON CONFLICT (package_id, engine_id) DO NOTHING;

    -- v2 快照 = 推进后的活表
    INSERT INTO package_engine_versions (package_id, version, engine_id)
    SELECT pe.package_id, 2, pe.engine_id
    FROM package_engines pe
    WHERE pe.package_id IN (SELECT id FROM packages WHERE code IN ('basic', 'advanced', 'pro'))
    ON CONFLICT (package_id, version, engine_id) DO NOTHING;

    UPDATE packages SET catalog_version = 2, updated_at = NOW()
    WHERE code IN ('basic', 'advanced', 'pro');

    -- 商户的选择若指向已下架的通道，清空，交给程序按
    -- "权益内第一个已启用且已接通"重新解析；否则会一直撞「当前套餐未包含此通道」。
    UPDATE users SET active_engine_id = NULL, updated_at = NOW()
    WHERE active_engine_id IN (
      SELECT id FROM engines WHERE retired_at IS NOT NULL
    );

    UPDATE sub_accounts SET active_engine_id = NULL, updated_at = NOW()
    WHERE active_engine_id IN (
      SELECT id FROM engines WHERE retired_at IS NOT NULL
    );

    UPDATE app_settings
    SET value = '""'::jsonb, updated_at = NOW()
    WHERE key = 'translation.active_engine'
      AND value IN (
        SELECT to_jsonb(id) FROM engines WHERE retired_at IS NOT NULL
      );

    -- =====================================================================
    -- 5) 上游真实消耗台账（内部口径，与客户字符账本彻底分开）
    -- =====================================================================

    -- 为什么要有它：translate_logs.chars 是**卖给客户的字符数**，
    -- cost_amount 是按成本表折算的估算值。而厂商按 token 计费，
    -- 折算系数（一字符≈多少 token）随语种、语言对、输出长度剧烈变化。
    -- 只靠估算值永远算不出真实毛利，所以必须把厂商给的真实数字存下来。
    CREATE TABLE IF NOT EXISTS translation_usage (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      reservation_id bigint,
      translate_log_id bigint,
      user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      sub_account_id bigint,
      engine_id varchar(64) NOT NULL REFERENCES engines(id) ON DELETE RESTRICT,
      provider varchar(120) NOT NULL DEFAULT '',
      model varchar(160) NOT NULL DEFAULT '',
      prompt_tokens bigint NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
      completion_tokens bigint NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
      -- 可计费的推理 token：部分模型默认开思考，这部分同样计费，
      -- 单独记是为了回答"钱花在正文还是花在思考上"
      reasoning_tokens bigint NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
      total_tokens bigint NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
      -- 厂商计费单位不是 token 时留空，改用 billed_units 记其口径
      billed_units bigint NOT NULL DEFAULT 0 CHECK (billed_units >= 0),
      billed_unit varchar(40) NOT NULL DEFAULT '',
      upstream_cost numeric(16, 8) NOT NULL DEFAULT 0 CHECK (upstream_cost >= 0),
      currency varchar(8) NOT NULL DEFAULT 'CNY',
      retries smallint NOT NULL DEFAULT 0 CHECK (retries >= 0),
      cached boolean NOT NULL DEFAULT false,
      from_language varchar(32) NOT NULL DEFAULT 'auto',
      to_language varchar(32) NOT NULL DEFAULT '',
      duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT translation_usage_sub_account_fk
        FOREIGN KEY (user_id, sub_account_id)
        REFERENCES sub_accounts(parent_id, id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS translation_usage_user_created_idx
      ON translation_usage (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS translation_usage_engine_created_idx
      ON translation_usage (engine_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS translation_usage_model_idx
      ON translation_usage (provider, model);
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DROP TABLE IF EXISTS translation_usage;

    -- 回滚权益版本化
    UPDATE packages SET catalog_version = 1, updated_at = NOW()
    WHERE code IN ('basic', 'advanced', 'pro');

    DELETE FROM package_engine_versions WHERE version = 2;

    -- 活表恢复成改动前的组合 —— 直接读 v1 快照，不另外抄一份清单。
    --
    -- up 里 v2 是**集合赋值**（含"从活表里删掉谷歌"这类移除），
    -- 所以回滚也必须按集合恢复，不能只 DELETE 新加的通道 ——
    -- 那样谷歌不会回到基础版/高级版，活表与改动前不一致。
    -- v1 快照正是"改动前的活表"，读它就是读事实，也不会与 up 抄错两遍。
    DELETE FROM package_engines
    WHERE package_id IN (SELECT id FROM packages WHERE code IN ('basic', 'advanced', 'pro'));

    INSERT INTO package_engines (package_id, engine_id)
    SELECT v.package_id, v.engine_id
    FROM package_engine_versions v
    WHERE v.version = 1
      AND v.package_id IN (SELECT id FROM packages WHERE code IN ('basic', 'advanced', 'pro'));

    DELETE FROM package_engine_versions
    WHERE engine_id IN (${idList(NEW_ENGINES.map(e => e.id))});

    UPDATE users SET active_engine_id = NULL, updated_at = NOW()
    WHERE active_engine_id IN (${idList(NEW_ENGINES.map(e => e.id))});

    UPDATE sub_accounts SET active_engine_id = NULL, updated_at = NOW()
    WHERE active_engine_id IN (${idList(NEW_ENGINES.map(e => e.id))});

    DELETE FROM engines
    WHERE id IN (${idList(NEW_ENGINES.map(e => e.id))})
      AND retired_at IS NULL;

    -- 重新上架旧通道。
    --
    -- up 是"活表里凡不在新名单里的一律下架"，回滚就必须是"凡被本迁移下架的一律上架"：
    -- retired_at 这个列是本次迁移新建的，所以此刻 non-null 的就是 up 下架的那批。
    -- 再一次说明为什么不写死清单 —— 回滚集合必须等于 up 上的集合，写死就又给了
    -- 两份清单不一致的机会。
    UPDATE engines SET retired_at = NULL, updated_at = NOW()
    WHERE retired_at IS NOT NULL;

    -- 注意：上面**故意不**把 deepseek.model 改回 deepseek-chat。
    --
    -- 因为那个值是已知失效的模型名（见 up 的 2b 段与 provider 的注释），
    -- 而 deepseek 恰好是"唯一接通、真在跑"的通道 —— 回滚时把它改回失效名，
    -- 等于在回滚的一瞬间把线上唯一能用的通道弄坏。回滚是为了恢复服务，
    -- 不是为了恢复一个 bug。真要那个字符串，后台改一行即可，不需要靠回滚。
    -- enabled/wired 刻意不碰：下架时被置成 false，但当时的凭据早已被删除，
    -- 把 wired 改回 true 等于宣称"这个通道能用"，而它并不能 —— 那是假状态。
    -- 需要重新接通，请填凭据后走后台保存或 scripts/set-engine-wired.js。

    ALTER TABLE recharges DROP COLUMN IF EXISTS package_catalog_version;
    ALTER TABLE users DROP COLUMN IF EXISTS package_catalog_version;
    DROP TABLE IF EXISTS package_engine_versions;
    ALTER TABLE packages DROP COLUMN IF EXISTS catalog_version;

    DROP INDEX IF EXISTS engines_active_idx;
    ALTER TABLE engines DROP CONSTRAINT IF EXISTS engines_call_params_object_check;
    ALTER TABLE engines DROP COLUMN IF EXISTS call_params;
    ALTER TABLE engines DROP COLUMN IF EXISTS retired_at;
  `)
}

// 供 test/translation-provider.test.js 精确校验"库里有、适配层必须有"。
//
// 本迁移的通道行是**运行时拼**出来的（备注很长、还带 SQL 转义与 jsonb），
// 写字面量既容易写错又难维护，所以原来那条"正则扫源码"的护栏扫不到它们。
// 与其为了迁就正则把同一份数据写两遍，不如把数据本身导出去让测试直接读 ——
// 数据只有一个来源，就不会出现"改了一处漏了另一处"。
exports.engines = NEW_ENGINES
// 11 个正式渠道的 id 全集（4 个在跑的 + 7 个新增）。
// 导出来给测试钉住"换线不能把在跑的通道一起下架"这条不变量 ——
// 这个 bug 在数据上看只表现为"少了一个通道"，很容易一路滑到线上才发现。
exports.lineupEngineIds = LINEUP_ENGINE_IDS
// v1 不再导出：它现在是"迁移运行那一刻活表的副本"，不是一份可以提前写出来的常量。
// 谁能提前写出 v1，谁就是在猜历史；活表才是历史。
// 名字里的 V2 指"套餐权益版本 2"，不是"增量"：这是该版本的**完整目标集合**，
// 含从活表里移除的通道。成本核算结论见 scripts/translation-cost-report.js。
exports.packageEnginesV2 = PACKAGE_ENGINES_V2
