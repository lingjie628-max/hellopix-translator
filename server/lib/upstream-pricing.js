'use strict'

/**
 * 上游厂商官方价格表（**内部核算专用，不参与对客户扣费**）。
 *
 * ## 这张表是干什么的
 *
 * 商户的账是**按字符**算的：翻译 100 个字符扣 100 个字符额度，与选哪个通道无关。
 * 厂商的账是**按 token**（或按字符）算的 —— 两者不是一个口径。
 * 没有这张表，我们只知道"收了多少字符"，不知道"这些字符花掉了多少真金白银"，
 * 于是"这单是不是亏的"永远答不上来。
 *
 * ## 用在哪
 *
 * `core-service.recordUpstreamUsage()` 在每次真调上游之后，
 * 按这里的单价把 token 折算成成本，写进 `translation_usage`（内部台账）。
 * 那条记录**与客户字符账本完全分离**：退款给客户时它照样记账，
 * 因为厂商那边是真的产生了费用。
 *
 * ## 三条纪律
 *
 * 1. **价格必须有出处与日期**。`asOf` / `source` 不是装饰：
 *    厂商调价很频繁（DeepSeek 一年调了两次、豆包按输入长度分档），
 *    没有日期就没人知道这张表什么时候该复核。
 * 2. **拿不到官方价格的一律标 `unverified`，不许估一个数填进去**。
 *    估出来的数字会在成本报告里伪装成事实，比留空有害得多。
 * 3. **保守取价**。分时定价（DeepSeek 峰谷）取**峰时**，分档定价（豆包、GLM）
 *    在核算时按实际档位取 —— 宁可高估成本，不要低报。
 *
 * ## 币种
 *
 * 各家计价币种不同（人民币/美元）。这里**不做汇率换算**，
 * 原样保留 `currency`，由报表层统一折算 ——
 * 汇率写死在代码里，半年后就是错的，而且没人会想起来改。
 */

/** @typedef {{ maxInputTokens: number, input: number, output: number }} PriceTier */

const PRICING = Object.freeze({
  // ---- OpenAI -----------------------------------------------------------------
  //
  // 这里有两个 OpenAI 条目，不是冗余 —— 两个环境在跑不同的模型名，两个都得认识：
  //   · 生产库 gpt 的 model 是 `gpt-5.6-luna`（后台把默认值改过，而**后台配置优先**，
  //     所以线上真的在调它）；
  //   · 代码兜底值与开发库是 `gpt-4o-mini`（translation-adapters 的 defaultModel）。
  // 只登记其中一个，另一个环境就会把成本静默记成 0 —— 033 那次事故就是这么来的。
  'gpt-4o-mini': {
    provider: 'OpenAI',
    unit: 'token',
    currency: 'USD',
    input: 0.15,
    output: 0.6,
    asOf: '2026-09',
    source: 'https://developers.openai.com/api/docs/models/gpt-4o-mini',
    note: '缓存命中输入 $0.075/百万。Batch 五折。这里按未命中标准价计。'
  },
  'gpt-5.6-luna': {
    provider: 'OpenAI',
    unit: 'token',
    currency: 'USD',
    // 2026-07-30 降价 80% 后的价（本次核实于 2026-09-27）。
    // 长上下文档（prompt > 272K tokens）是 2x 输入 / 1.5x 输出、**整单**套用，
    // 但翻译单条上限 5000 字符（约 1700 token），加提示词也够不到 272K，
    // 所以只取短档价 —— 与上面 grok-4.3 处理 20 万阈值的口径一致。
    input: 0.2,
    output: 1.2,
    asOf: '2026-09-27',
    source: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
    note: '缓存命中输入 $0.02/百万。超过 272K 输入时整单按 $0.40/$1.80（翻译场景够不到）。Batch/Flex 五折。GPT-5.6 中最低价档，对应早前 GPT-5 家族的 nano 级。'
  },

  // ---- DeepSeek ---------------------------------------------------------------
  'deepseek-flash': {
    provider: 'DeepSeek',
    unit: 'token',
    currency: 'USD',
    // 峰时价。闲时是峰时的一半（$0.15 / $0.60），但成本核算不能赌闲时 ——
    // 用户什么时候用不归我们管，取峰时才是"用满额度"的保守估计。
    input: 0.3,
    output: 1.2,
    asOf: '2026-09-11',
    source: 'https://api-docs.deepseek.com/quick_start/pricing',
    note: '峰时价（UTC 周一至周五 01:00-04:00、06:00-10:00）；闲时 $0.15/$0.60。缓存命中输入 $0.006。模型版本 DeepSeek-V4.1-Flash。'
  },

  // ---- xAI --------------------------------------------------------------------
  'grok-4.3': {
    provider: 'xAI',
    unit: 'token',
    currency: 'USD',
    input: 1.25,
    output: 2.5,
    // Grok 4.3 有个 20 万 token 的"长上下文翻倍"阈值。翻译单条最多 5000 字符
    // （约 1700 token），加上提示词也远不到 20 万，所以只取短档价。
    asOf: '2026-09',
    source: 'https://docs.x.ai/developers/pricing',
    note: 'prompt ≥200k tokens 时整单翻倍至 $2.50/$5.00。翻译场景够不到该阈值。'
  },

  // ---- Anthropic --------------------------------------------------------------
  'claude-haiku-4-5': {
    provider: 'Anthropic',
    unit: 'token',
    currency: 'USD',
    input: 1.0,
    output: 5.0,
    asOf: '2026-09',
    source: 'https://platform.claude.com/docs/en/models/haiku-4-5/overview',
    note: 'Batch 五折；缓存读 $0.10/百万。模型 ID 别名 claude-haiku-4-5，完整 ID claude-haiku-4-5-20251001。'
  },

  // ---- 阿里云百炼（Qwen-MT 专用翻译模型）-------------------------------------
  'qwen-mt-flash': {
    provider: '阿里云百炼',
    unit: 'token',
    currency: 'CNY',
    input: 0.7,
    output: 1.95,
    asOf: '2026-08-26',
    source: 'https://help.aliyun.com/zh/model-studio/qwen-mt-flash',
    note: '华北2（北京）价。新加坡节点 ¥1.174/¥3.596。单条输入上限 8192 tokens（本地已拦）。'
  },
  'qwen-mt-plus': {
    provider: '阿里云百炼',
    unit: 'token',
    currency: 'CNY',
    // 官方 qwen-mt-plus 的具体单价未在本次检索中取得原文数字，
    // **不猜**：标记为待核实，核算时按 flash 价的 2 倍做上限敏感度测试。
    input: null,
    output: null,
    unverified: true,
    asOf: '2026-09',
    source: 'https://help.aliyun.com/zh/model-studio/models',
    note: '质量最高档（专业文献）。官方单页未取得价格原文，**待核实**，不得按 0 成本计入。'
  },

  // ---- 火山引擎（豆包）--------------------------------------------------------
  'doubao-seed-1-6': {
    provider: '火山引擎方舟',
    unit: 'token',
    currency: 'CNY',
    // 按单次请求的**输入长度**分档，整单套用同一档。
    tiers: [
      { maxInputTokens: 32000, input: 0.8, output: 8.0 },
      { maxInputTokens: 128000, input: 1.2, output: 16.0 },
      { maxInputTokens: 256000, input: 2.4, output: 24.0 }
    ],
    asOf: '2026-09',
    source: 'https://www.volcengine.com/docs/82379/1544106',
    note: '首档（≤32K 输入）另有"输出 ≤200 tokens 时输出价 ¥2"的特惠，翻译长句一般会超过 200 tokens，故按 ¥8 保守计。缓存命中 ¥0.16/百万。'
  },

  // ---- 月之暗面（Kimi）--------------------------------------------------------
  'kimi-k3': {
    provider: '月之暗面',
    unit: 'token',
    currency: 'USD',
    input: 3.0,
    output: 15.0,
    asOf: '2026-09',
    source: 'https://www.kimi.com/zh-hans/resources/kimi-k3-pricing',
    note: '缓存命中输入 $0.30/百万。上下文 1,048,576 tokens。K3 把采样参数固定在服务端，不要再传 temperature/top_p。'
  },

  // ---- 智谱（GLM）-------------------------------------------------------------
  'glm-4.7': {
    provider: '智谱开放平台',
    unit: 'token',
    currency: 'CNY',
    tiers: [
      // 输入 [0,32K) 且输出 <200 tokens
      { maxInputTokens: 32000, maxOutputTokens: 200, input: 2.0, output: 8.0 },
      // 输入 [0,32K) 且输出 ≥200 tokens —— 翻译句子的常态
      { maxInputTokens: 32000, input: 3.0, output: 14.0 },
      { maxInputTokens: 200000, input: 4.0, output: 16.0 }
    ],
    asOf: '2026-08',
    source: 'https://open.bigmodel.cn/pricing',
    note: '缓存命中 ¥0.4~0.8/百万。GLM-4.6 已转入"算力单元/私有实例"（¥175/GPU Unit/天），不再适合按字符零售，故默认模型改为 glm-4.7。'
  },

  // ---- Mistral ----------------------------------------------------------------
  'mistral-large-latest': {
    provider: 'Mistral AI',
    unit: 'token',
    currency: 'USD',
    input: 0.5,
    output: 1.5,
    asOf: '2026-07-24',
    source: 'https://mistral.ai/pricing/',
    note: '对应 Mistral Large 3（API ID mistral-large-2512），256K 上下文。缓存输入约 $0.05/百万。官方文档另有欧元区价 €0.44/€1.30。'
  },

  // ---- MiniMax ----------------------------------------------------------------
  'MiniMax-M3': {
    provider: 'MiniMax',
    unit: 'token',
    currency: 'USD',
    // "永久五折"是**限时性质的促销**，随时可能结束。核算按原价（打折前），
    // 否则促销一停，成本报告立刻失真。
    input: 0.6,
    output: 2.4,
    asOf: '2026-07-22',
    source: 'https://platform.minimaxi.com/docs/guides/pricing-paygo',
    note: '≤512K 输入 token 档；官网现价为此价五折（$0.30/$1.20），促销期不定，核算取原价。>512K 档 $1.20/$4.80。缓存读 $0.12/百万。'
  },

  // ---- Google Cloud Translation ----------------------------------------------
  'google-translate-v2': {
    provider: 'Google Cloud',
    unit: 'character',
    currency: 'USD',
    input: 20.0,
    output: 0,
    asOf: '2026-09-03',
    source: 'https://cloud.google.com/products/translate/pricing',
    note: 'NMT v2/v3 均 $20/百万字符，按**送翻字符数**计（含空白）。每月前 50 万字符免费（$10 额度，Basic/Advanced 共用）—— ' +
      '这是**按结算账号**的额度，绝不能按客户重复分配。超过 10 亿字符/月需联系销售。'
  }
})

/** 模型名可能带日期后缀（claude-haiku-4-5-20251001）或接入点前缀（ep-xxx），
 *  所以按"最长前缀匹配"找价，而不是要求完全相等。 */
function resolvePricing(model) {
  const key = String(model || '').trim()
  if (!key) return null
  if (PRICING[key]) return Object.assign({ model: key }, PRICING[key])
  const candidates = Object.keys(PRICING)
    .filter(name => key.toLowerCase().startsWith(name.toLowerCase()))
    .sort((a, b) => b.length - a.length)
  if (candidates.length) return Object.assign({ model: key }, PRICING[candidates[0]])
  // 认不出模型时**不猜价格**，返回 null 让调用方把成本记 0 并标 unverified。
  return null
}

/** 按输入长度（以及输出长度，GLM 用）选档。 */
function pickTier(pricing, promptTokens, completionTokens) {
  if (!pricing || !Array.isArray(pricing.tiers) || !pricing.tiers.length) return pricing
  const input = Number(promptTokens) || 0
  const output = Number(completionTokens) || 0
  const eligible = pricing.tiers.filter(tier => (
    input <= tier.maxInputTokens &&
    (tier.maxOutputTokens === undefined || output < tier.maxOutputTokens)
  ))
  // 符合条件的档里取**最便宜**的那一档（官方规则是"满足条件即套用"，
  // 分档是互斥的条件区间，通常只会命中一个）
  const tier = eligible.length
    ? eligible.reduce((cheap, current) => (current.input < cheap.input ? current : cheap))
    : pricing.tiers[pricing.tiers.length - 1]
  return Object.assign({}, pricing, { input: tier.input, output: tier.output })
}

/**
 * 折算一次上游调用的成本。
 *
 * @returns {{ cost: number, currency: string, unit: string, model: string,
 *             provider: string, verified: boolean, note: string, source: string, asOf: string } | null}
 */
function estimateUpstreamCost({ model, promptTokens, completionTokens, characters }) {
  const pricing = resolvePricing(model)
  if (!pricing) {
    return {
      cost: 0, currency: '', unit: '', model: String(model || ''),
      provider: '', verified: false, asOf: '', source: '',
      note: '价目表中查不到该模型，成本按 0 记但**标记为未核实** —— 0 不代表免费。'
    }
  }
  const unit = pricing.unit || 'token'
  if (pricing.unverified) {
    return {
      cost: 0, currency: pricing.currency || '', unit, model: pricing.model,
      provider: pricing.provider || '', verified: false,
      note: pricing.note || '官方价格未取得，标记待核实；成本按 0 记，不得当作免费。',
      source: pricing.source || '', asOf: pricing.asOf || ''
    }
  }
  // 分档定价（豆包/GLM）只在 tiers 里给价、顶层没有 input ——
  // 不能把它当成"没有价格"：那样这两家会被记成 0 成本，
  // 而它们恰恰是套餐里的主力通道，成本表会因此整体少一大块。
  const priced = pickTier(pricing, promptTokens, completionTokens)
  if (priced.input === null || priced.input === undefined) {
    return {
      cost: 0, currency: pricing.currency || '', unit, model: pricing.model,
      provider: pricing.provider || '', verified: false,
      note: pricing.note || '官方价格未取得，标记待核实；成本按 0 记，不得当作免费。',
      source: pricing.source || '', asOf: pricing.asOf || ''
    }
  }
  let cost = 0
  if (unit === 'character') {
    cost = (Number(characters) || 0) / 1e6 * Number(priced.input)
  } else {
    cost = (Number(promptTokens) || 0) / 1e6 * Number(priced.input) +
      (Number(completionTokens) || 0) / 1e6 * Number(priced.output || 0)
  }
  return {
    cost: Number(cost.toFixed(8)),
    currency: pricing.currency || '',
    unit,
    model: pricing.model,
    provider: pricing.provider || '',
    verified: true,
    note: pricing.note || '',
    source: pricing.source || '',
    asOf: pricing.asOf || ''
  }
}

module.exports = { PRICING, resolvePricing, pickTier, estimateUpstreamCost }
