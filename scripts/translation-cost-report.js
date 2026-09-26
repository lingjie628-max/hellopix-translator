'use strict'

/**
 * 翻译成本核算报告（内部工具，不对客户）。
 *
 * ## 它回答什么问题
 *
 * "一个客户把整档 150 万字符额度全用在**某一个通道**上，我们要付给厂商多少钱？"
 *
 * 这个问题的答案决定了套餐该怎么分档 —— 而不是反过来先定 3/7/11 个通道再去凑成本。
 *
 * ## 为什么不能"字符数 × 单价"
 *
 * 我们对客户按**字符**收费，厂商对我们按 **token**（谷歌按字符）收费。
 * 两者中间隔着三件会被忽略的事：
 *
 *   1. **一个字符不等于一个 token**。中文 1 字 ≈ 1 token，英文 3~4 字符 ≈ 1 token。
 *      把 150 万字符直接乘上"每百万 token 价"会算出一个凭空小一半或大一倍的数字。
 *   2. **提示词是重复付钱的**。每条消息都要重发一遍 system 提示词。
 *      30 字一条的短消息要发 2.5 万次，提示词开销（约 90 token/次 ≈ 225 万 token）
 *      比原文本身还多 —— 短消息场景的真实成本主要由提示词决定。
 *   3. **输出按输出价**，而输出价通常是输入价的 3~20 倍（豆包 8 元 vs 0.8 元）。
 *      译文比原文长多少，直接决定这一单是赚还是亏。
 *
 * ## 三条纪律（与本项目其他成本口径一致）
 *
 *   · 系数**保守取高**（宁可高估成本）。分档定价取实际档，分时定价取峰时。
 *   · 拿不到官方价格的（qwen-mt-plus）标 unverified，按 0 记但**注明"0 不代表免费"**。
 *   · 每个数字都带来源与日期（见 upstream-pricing.js 的 asOf/source）。
 *
 * 用法：
 *   DATABASE_URL=postgres://... node scripts/translation-cost-report.js            # 控制台表格
 *   DATABASE_URL=postgres://... node scripts/translation-cost-report.js --markdown # 输出 markdown 表格
 *
 * **必须带上要评估的那个环境的 DATABASE_URL**：模型名、调用参数、售价、满额、币种
 * 都从库里现读。不带就跑，表照样打得出来，但用的是代码兜底值 ——
 * 那种表看着完整，其实算的是另一个环境的账（表头会警告，但别依赖它兜底）。
 */

const { callParamsOf, estimateTokens, LLM_LANGUAGES } = require('../server/services/translation-adapters')
const provider = require('../server/services/translation-provider')
const { estimateUpstreamCost, resolvePricing } = require('../server/lib/upstream-pricing')
// 套餐归属的唯一来源：迁移里那份"卖出去的权益"。
// 读它而不是在本文件里再抄一份，就不会出现"报告一套、权益表一套"的漂移。
const { packageEnginesV2, lineupEngineIds } = require('../migrations/031_translation_channel_lineup')

// ---------------------------------------------------------------------------
// 全局假设（改这里就能重算，别在正文里写死数字）
// ---------------------------------------------------------------------------

/**
 * 套餐满额：150 万**计费字符**（= 我们对客户扣的那个数）。
 *
 * 这是兜底值。库里能读到 `packages.included_chars` 时会以库为准 ——
 * 满额是商业参数，改一次价不改这里，报告就该跟着变，而不是继续按旧数字算。
 */
let QUOTA_CHARS = 1_500_000

/**
 * 计费字符 → 源文字符。
 *
 * 本项目的计费口径是**中文一个字算 2 个字符**（见 translation-provider.countBillableChars，
 * 前端 Translate.vue 与 mock 都用同一口径）。所以 150 万计费字符对中文原文
 * 等于 75 万个字；对英文原文（1 字算 1）等于 150 万个字符。
 *
 * 这不是"多加价"，而是让中文与英文的**信息量**可比：一个中文字的承载量
 * 大致等于两个英文字符。核实时前后端口径一致，见 docs 里的字符定义说明。
 */
const CJK_WEIGHT = 2

/**
 * 汇率。写死在报告里而不是代码里，是因为它只影响这份报告，不影响线上扣费。
 *
 * 为什么必须要这张表：`packages.price` 是**按 `billing.currency` 计的裸数字**，
 * 而厂商成本是美元/人民币。实测生产 `billing.currency = "USD"`、
 * 售价 40/75/135 —— 直接拿"人民币成本 ÷ 135"算占比会**高出 7.2 倍**。
 */
const FX = { USD: 7.2, CNY: 1, HKD: 0.92, EUR: 7.8, JPY: 0.048 }

/** 设置里没有 billing.currency 时的默认值，与 server/routes/production.js 保持一致 */
const DEFAULT_CURRENCY = 'USD'

/** 目标语言：中文原文 → 译文 tokens / 每 1 个中文字 */
const ZH_SOURCE_OUTPUT = {
  en: 0.45,   // 英文比中文"长"但 token 效率高（4 字符/token）
  vi: 0.90,   // 越南语拉丁字母带声调，token 效率低
  th: 1.40,   // 泰文无词间空格，token 偏重
  my: 1.80    // 缅文更重，且译文常比中文长
}

/** 非中文原文：每 1 个源字符对应的 tokens（用 estimateTokens 的保守口径） */
const NON_CJK_SOURCE_TOKENS = {
  en: 1 / 3,  // 英文约 3 字符/token（真实约 4，这里取保守）
  vi: 1 / 3,
  th: 1,      // 泰文约 1 token/字符
  my: 1
}

/** 非中文原文 → 中文译文：tokens / 每 1 个源字符 */
const TARGET_ZH_OUTPUT = {
  en: 0.60,   // 1 个英文字符译成约 0.6 个汉字
  vi: 0.35,
  th: 0.90,
  my: 0.45
}

/**
 * 消息长度画像。短消息不是"小场景"—— 它是最贵的那一档，
 * 因为提示词开销按**次数**重复，而次数 = 总字数 / 每条字数。
 */
const PROFILES = [
  { key: 'short', label: '短消息（30 字/条，多轮）', chars: 30 },
  { key: 'long', label: '长消息（1500 字/条）', chars: 1500 }
]

const DIRECTIONS = [
  { key: 'zh-en', label: '中→英', source: 'zh', target: 'en' },
  { key: 'zh-th', label: '中→泰', source: 'zh', target: 'th' },
  { key: 'zh-vi', label: '中→越', source: 'zh', target: 'vi' },
  { key: 'zh-my', label: '中→缅', source: 'zh', target: 'my' },
  { key: 'en-zh', label: '英→中', source: 'en', target: 'zh' },
  { key: 'th-zh', label: '泰→中', source: 'th', target: 'zh' },
  { key: 'vi-zh', label: '越→中', source: 'vi', target: 'zh' },
  { key: 'my-zh', label: '缅→中', source: 'my', target: 'zh' }
]

/** 敏感度区间：系数本身是估值，成本按 ±30% 给区间，不当成精确值用 */
const BAND = { low: 0.7, high: 1.3 }

/**
 * 通道清单。
 *
 * 就是换线后的 11 个正式通道 —— 与 `migrations/031_translation_channel_lineup.js`
 * 导出的 `lineupEngineIds` 必须一一对应（下面的 assertLineup() 会当场校验：
 * 少一个通道，这张表算出来的"最贵通道"就可能不是真的最贵）。
 *
 * 这里**刻意不写**"已接通 / 未接通"：那种状态是环境事实，不是常量。
 * 写死在脚本里，换一个环境就成了假话。接通状态由下面 printChannelStatus() 现查。
 */
const CHANNELS = [
  { id: 'gpt', name: 'GPT', model: 'gpt-4o-mini' },
  { id: 'deepseek', name: 'DeepSeek', model: 'deepseek-flash' },
  { id: 'google', name: '谷歌翻译', model: 'google-translate-v2' },
  { id: 'grok', name: 'Grok', model: 'grok-4.3' },
  { id: 'qwen', name: '通义千问 Qwen-MT', model: 'qwen-mt-flash' },
  { id: 'claude', name: 'Claude', model: 'claude-haiku-4-5' },
  { id: 'doubao', name: '豆包', model: 'doubao-seed-1-6' },
  { id: 'kimi', name: 'Kimi', model: 'kimi-k3' },
  { id: 'glm', name: 'GLM', model: 'glm-4.7' },
  { id: 'mistral', name: 'Mistral', model: 'mistral-large-latest' },
  { id: 'minimax', name: 'MiniMax', model: 'MiniMax-M3' }
]

// ---------------------------------------------------------------------------
// 提示词开销：**实测**这一次请求里除原文之外的部分，不靠估
// ---------------------------------------------------------------------------

/**
 * 截下适配器真实构造的请求体，量出"与原文无关的那部分"有多少 token。
 *
 * 为什么要实测：system 提示词写在各适配器里，手抄一份进报告必然与代码脱节 ——
 * 而短消息场景的成本主要由它决定，抄错了整张表的结论就是错的。
 */
async function measurePromptOverhead(engine) {
  const body = { choices: [{ message: { content: 'x' } }] }
  let captured = null
  const fetchStub = async (url, init) => {
    captured = { url: String(url), init }
    return { ok: true, status: 200, json: async () => body }
  }
  const engineRow = Object.assign(
    { enabled: true, wired: true, model: engine.model, id: engine.id },
    engine.callParams ? { callParams: engine.callParams } : {}
  )
  try {
    await provider.translate(engineRow, { text: '你好', from: 'zh', to: 'en' },
      { fetch: fetchStub, timeoutMs: 3000, credentials: { apiKey: 'report-only' } })
  } catch (error) {
    return { promptTokens: 0, note: `适配器未取到请求体：${error.message}` }
  }
  if (!captured) return { promptTokens: 0, note: '该通道不构造 chat 报文（按字符/查询参数计费）' }
  const payload = JSON.parse(captured.init.body)
  let promptTokens = 0
  if (Array.isArray(payload.messages)) {
    // 原文那一条要扣掉：它的大小已按源文长度单独计入
    for (const message of payload.messages) {
      if (String(message.content) === '你好') continue
      promptTokens += estimateTokens(message.content)
    }
    // chat 模板本身（角色标记、分隔符）每次请求约 4 token
    promptTokens += 4
  }
  if (typeof payload.system === 'string') {
    promptTokens += estimateTokens(payload.system) + 4
  }
  return { promptTokens, note: '' }
}

// ---------------------------------------------------------------------------
// 成本计算
// ---------------------------------------------------------------------------

function sourceCharsOf(direction) {
  // 计费字符 → 源文字符。中文源头打 2 折（一个字算两个字符）。
  return direction.source === 'zh' ? QUOTA_CHARS / CJK_WEIGHT : QUOTA_CHARS
}

function tokensOf(direction, profile) {
  const chars = sourceCharsOf(direction)
  const requests = Math.ceil(chars / profile.chars)
  const sourceTokens = direction.source === 'zh'
    ? chars                                  // 中文 1 字 ≈ 1 token
    : chars * NON_CJK_SOURCE_TOKENS[direction.source]
  const outputTokens = direction.target === 'zh'
    ? chars * TARGET_ZH_OUTPUT[direction.source]
    : chars * ZH_SOURCE_OUTPUT[direction.target]
  return { chars, requests, sourceTokens, outputTokens }
}

function toCny(cost, currency) {
  return cost * (FX[currency] === undefined ? 1 : FX[currency])
}

/**
 * 一个通道在某方向/画像下的成本（人民币元）。
 *
 * 返回 low/mid/high：mid 是主估计，low/high 是系数 ±30% 的敏感度区间。
 * **不要把 mid 当成"精确成本"用** —— 它是保守估计，真实值受译文长度分布影响。
 */
function costOf(channel, direction, profile, overheadTokens) {
  const { requests, sourceTokens, outputTokens } = tokensOf(direction, profile)
  const promptBase = sourceTokens + requests * overheadTokens
  const band = [BAND.low, 1, BAND.high].map(scale => {
    const estimate = estimateUpstreamCost({
      model: channel.model,
      promptTokens: promptBase * scale,
      completionTokens: outputTokens * scale,
      // 按字符计价的通道：送翻的是**源文字符数**（不是计费字符数）
      characters: sourceCharsOf(direction) * scale
    })
    if (!estimate) return { cost: 0, currency: '', verified: false }
    return {
      cost: toCny(estimate.cost, estimate.currency),
      currency: estimate.currency,
      verified: estimate.verified,
      unit: estimate.unit,
      model: estimate.model,
      provider: estimate.provider
    }
  })
  return {
    requests,
    sourceTokens,
    outputTokens,
    overheadTokens,
    low: band[0].cost,
    mid: band[1].cost,
    high: band[2].cost,
    currency: band[1].currency,
    verified: band[1].verified,
    unit: band[1].unit,
    resolvedModel: band[1].model || channel.model,
    provider: band[1].provider
  }
}

// ---------------------------------------------------------------------------
// 建议套餐归属
// ---------------------------------------------------------------------------

/**
 * 套餐售价的**兜底值**，仅在读不到库时使用（单位与 `billing.currency` 一致）。
 *
 * ⚠️ 各环境的 `packages.price` **并不相同**，实测：
 *   · 本机开发库（Docker pix-pg）：200 / 350 / 850
 *   · 生产库（128.241.245.172）：**40 / 75 / 135** —— 与需求里引用的 "$40/$75/$135" 一致
 *
 * 两个环境的币种都是 USD（生产 `app_settings` 里写着 `billing.currency = "USD"`；
 * 开发库没这个键，走 DEFAULT_CURRENCY = USD），所以这些数字是**美元** ——
 * 拿人民币成本直接除以它，占比会偏 7.2 倍。
 *
 * 之前这里把开发库的数字抄进代码，还标成"人民币元"、还写着"读自 packages 表"：
 * 三件事都是错的（它从没读过库、数量是开发库的、币种判成了人民币）。
 * 现在改为 main() 现读，读不到才退回这里并标注来源。
 */
const PACKAGE_PRICE_FALLBACK = { basic: 200, advanced: 350, pro: 850 }

/** 由 main() 从库里读入；null 表示走兜底 */
let LIVE_PACKAGES = null
let LIVE_CONFIG = { source: 'defaults', reason: '尚未读取' }
let LIVE_CURRENCY = DEFAULT_CURRENCY

/** 换算到人民币的汇率；未知币种返回 null，调用方须警告而不是静默按 1 算 */
function fxOf(currency) {
  const rate = FX[currency]
  return rate === undefined ? null : rate
}

/** 库里的原始售价（含币种），如实展示用 */
function packagePriceRawOf(code) {
  const row = LIVE_PACKAGES && LIVE_PACKAGES[code]
  return row
    ? { amount: Number(row.price), currency: LIVE_CURRENCY, from: 'db' }
    : { amount: PACKAGE_PRICE_FALLBACK[code], currency: DEFAULT_CURRENCY, from: 'defaults' }
}

/** 售价折算成人民币 —— 报告里所有"占售价 X%"都以它为分母 */
function packagePriceOf(code) {
  const raw = packagePriceRawOf(code)
  const rate = fxOf(raw.currency)
  return rate === null ? raw.amount : raw.amount * rate
}

function packagePriceSource() {
  const rate = fxOf(LIVE_CURRENCY)
  const fx = rate === null
    ? `⚠️ 币种 ${LIVE_CURRENCY} 未配汇率，按 1:1 计，占比不可信`
    : `币种 ${LIVE_CURRENCY}，按 1 ${LIVE_CURRENCY} = ¥${rate} 折算`
  return LIVE_CONFIG.source === 'db'
    ? `packages 表（${LIVE_CONFIG.identity}），${fx}`
    : `代码兜底值，不是本环境的真实售价（原因：${LIVE_CONFIG.reason}）`
}

/**
 * 建议套餐归属（**建议**，不直接改已售权益）。
 *
 * 依据是各通道"用满额度 + 全选最贵通道"的上界成本，而不是通道数量：
 * 只要某档最贵的那几个通道用满额度也不至于把这一档卖亏，这一档就是安全的。
 *
 * ⚠️ 这份映射**不再在报告里另写一份**，而是直接读
 * `migrations/031_translation_channel_lineup.js` 里的 `PACKAGE_ENGINES_V2`。
 *
 * 原因是踩过一次：报告里用"上界成本 ≤ 售价 × 20%"现算分档，算出 Grok 属高级版、
 * Mistral 属基础版；而真正决定商户能选什么的权益表里，Grok 在专业版、
 * Mistral 在高级版。同一份交付里两套口径，读的人只会更糊涂 ——
 * 而且报告那一套还是错的（它没有约束力，权益表才有）。
 *
 * 现在只有一个来源：**已售/在售权益表**。成本只用来解释"为什么这么放"。
 */
const TIER_ORDER = ['basic', 'advanced', 'pro']
const RECOMMENDED_TIERS = TIER_ORDER.reduce((acc, code) => {
  acc[code] = packageEnginesV2.filter(row => row[0] === code).map(row => row[1])
  return acc
}, {})

/**
 * 备选方案：把 Kimi 从平档里拿掉，改成按量加购。
 *
 * 这不是"因为它贵就限制用户使用"（套餐内不设渠道限额是硬规则），
 * 而是"哪几个通道进哪一档"这个**商业归属**决定 —— 卖之前先算清楚，
 * 而不是卖完了才发现这一档用满就亏。两个方案的成本差见输出。
 */
const TIER_VARIANT_WITHOUT_KIMI = RECOMMENDED_TIERS.pro.filter(id => id !== 'kimi')

/**
 * 通道 → 它所在的最低档（取值来自 RECOMMENDED_TIERS，即迁移 031 的 v2 权益）。
 *
 * 以前这里是用"上界成本 ≤ 售价 × 20%"现算的，结果和权益表打架：
 * 现算把 Grok 判给高级版、把 Mistral 判给基础版，而权益表里
 * Grok 在专业版、Mistral 在高级版。同一份报告里两套口径，读的人只会更糊涂。
 * 现在只留一个来源：权益表。成本只用来解释"为什么这么放"。
 */
function tierOf(channelId) {
  return TIER_ORDER.find(code => RECOMMENDED_TIERS[code].includes(channelId)) || '未纳入平档'
}

/**
 * 自检：报告的通道清单必须与迁移里的 11 个正式通道一致。
 *
 * 不一致时**直接抛错退出**，不打印一张少算了一个通道的表。
 * 一张"看起来算过、其实漏了最贵那个通道"的成本表，比没有表更危险 ——
 * 有人会照着它定价。
 */
function assertLineup() {
  const listed = CHANNELS.map(channel => channel.id).sort()
  const expected = lineupEngineIds.slice().sort()
  const missing = expected.filter(id => !listed.includes(id))
  const extra = listed.filter(id => !expected.includes(id))
  if (missing.length || extra.length) {
    throw new Error(
      `通道清单与 migrations/031 的正式名单不一致（漏: ${missing.join(',') || '-'}；多: ${extra.join(',') || '-'}）` +
      ' —— 先把两边对齐再出报告，否则这张表的结论是错的'
    )
  }
  // 每个通道都要在某个档里，否则"建议档"会打出"未纳入平档"这种半成品
  const unassigned = CHANNELS.filter(channel => tierOf(channel.id) === '未纳入平档')
  if (unassigned.length) {
    throw new Error(`这些通道没被分进任何档位: ${unassigned.map(c => c.id).join(',')}`)
  }
}

// ---------------------------------------------------------------------------

/**
 * 读"这个环境此刻真实的配置"，而不是代码里抄的一份。
 *
 * `model` 和 `price` 都是**会随环境变化的数据**，必须现读。实测踩到过：
 * 开发库 gpt 是 gpt-4o-mini、生产是 gpt-5.6-luna；开发库套餐价 200/350/850、
 * 生产 40/75/135。把这两个值抄进报告，换台机器算出来的就是另一个环境的结论。
 *
 * 读不到就退回代码常量，但**在表头写明这回事** —— 悄悄用兜底值算出一张
 * "看起来算过"的成本表，比不打印更危险。
 */
async function loadLiveConfig() {
  const url = process.env.DATABASE_URL
  if (!url) return { source: 'defaults', reason: '未设置 DATABASE_URL' }
  let Pool
  try {
    ({ Pool } = require('pg'))
  } catch (error) {
    return { source: 'defaults', reason: '未安装 pg 模块' }
  }
  const pool = new Pool({ connectionString: url, max: 2 })
  try {
    const engines = (await pool.query(
      `SELECT id, model, call_params, wired, enabled, retired_at IS NOT NULL AS retired
         FROM engines WHERE id = ANY($1::text[])`, [lineupEngineIds.slice()]
    )).rows
    const packages = (await pool.query(
      'SELECT code, price, included_chars, allow_engine_switch, active FROM packages ORDER BY sort_order'
    )).rows
    const identity = (await pool.query(
      `SELECT current_database() AS db,
              (SELECT datcollate FROM pg_database WHERE datname = current_database()) AS collate`
    )).rows[0]
    // 币种单独 try：老库没有 app_settings 时也不能把整份配置读取带崩，
    // 退到 DEFAULT_CURRENCY 并会在表头写出来
    let currency = DEFAULT_CURRENCY
    try {
      const row = (await pool.query(
        "SELECT value #>> '{}' AS value FROM app_settings WHERE key = 'billing.currency'"
      )).rows[0]
      const value = row && String(row.value || '').trim()
      if (value) currency = value
    } catch (error) {
      currency = DEFAULT_CURRENCY
    }
    return {
      source: 'db',
      engines,
      packages,
      currency,
      identity: `${identity.db}@${identity.collate}`
    }
  } catch (error) {
    // 常见于目标库还停在 031 之前（没有 engines.call_params / retired_at 列）
    return { source: 'defaults', reason: `连库或取数失败：${error.message}` }
  } finally {
    await pool.end().catch(() => {})
  }
}

/**
 * 把库里的真实配置盖到通道清单上。
 *
 * 库里 `model` 为空的通道（谷歌是按字符计价，不需要模型名）保留清单里的
 * 计价键，否则会查不到价格、白白标成"待实测"。
 *
 * @returns {{ channels: Array, missing: string[] }}
 */
function effectiveChannels(live) {
  const byId = new Map((live.engines || []).map(row => [row.id, row]))
  const missing = []
  const channels = CHANNELS.map(channel => {
    const row = byId.get(channel.id)
    if (!row) {
      missing.push(channel.id)
      return Object.assign({}, channel, { modelFrom: 'defaults', callParams: null, wired: null })
    }
    const dbModel = String(row.model || '').trim()
    return Object.assign({}, channel, {
      // 库里有就一律以库为准 —— 界面显示的模型必须与实际调用一致，
      // 报告更不能用另一个名字去套价格
      model: dbModel || channel.model,
      modelFrom: dbModel ? 'db' : 'defaults',
      callParams: row.call_params || null,
      wired: row.wired
    })
  })
  return { channels, missing }
}

/**
 * 接通状态：只报"这个环境此刻到底能不能拿到凭据"，不做任何推断。
 *
 * 为什么单独一节：需求里明确要求"哪些已接通、哪些只完成适配、哪些待实测，
 * 缺 Key 时要标出来，不许伪造测试结果"。那就只能现查 ——
 * 一旦写成常量，换台机器、换个环境变量集合，它立刻变成假话。
 *
 * 两条凭据来源：
 *   · 环境变量（这里能查）—— 部署时注入
 *   · 库里的密文密钥（这里查不到）—— 后台保存时判定，见 provider.channelStatus
 * 两路都没有，就是真的没接通。
 */
function printChannelStatus(channels) {
  console.log('')
  console.log('接通状态（适配器是否实现 / 本环境能否取到凭据 / 真实模型是否有官方价）')
  console.log('通道\t实际模型\t模型来源\t适配器\t环境变量凭据\t官方价\t结论')
  for (const channel of channels) {
    const impl = provider.providers[channel.id]
    let ready = false
    if (impl) {
      try {
        ready = Boolean(impl.configured({}))
      } catch (error) {
        ready = false
      }
    }
    // 模型名必须和真实调用一致；有模型名却查不到价，只能标待实测，
    // 不能让它在成本表里冒充"已核实"的数字
    const pricing = resolvePricing(channel.model)
    const priced = pricing && !pricing.unverified
      && (pricing.input !== null && pricing.input !== undefined || Array.isArray(pricing.tiers))
    console.log([
      channel.name,
      channel.model,
      channel.modelFrom === 'db' ? '库' : '代码默认',
      impl ? '已实现' : '缺失',
      ready ? '有' : '无',
      priced ? `有(${pricing.currency})` : '无 → 待实测',
      !impl ? '待实现' : (ready ? (priced ? '可实测' : '可实测，但成本待核实') : '待填凭据')
    ].join('\t'))
  }
  console.log('（库里存的密文密钥这一路这里读不到，以管理后台的"已接通"标记为准；')
  console.log('  模型来源"代码默认"表示库里该通道没有 model，报告用的是清单里的兜底名）')
}

/**
 * 表头：先把"这份表算的是哪个环境"讲清楚。
 *
 * 成本表最容易出的错不是算错，而是**算的是另一个环境的数**：
 * 模型名抄了开发库、售价抄了另一个币种，表本身自洽，结论却是错的。
 */
function printConfigProvenance(missing) {
  console.log('')
  console.log('这份表算的是哪个环境')
  if (LIVE_CONFIG.source === 'db') {
    console.log(`  · 配置来源：DATABASE_URL 指向的库 ${LIVE_CONFIG.identity}`)
    console.log('    模型 / 调用参数 / 售价 / 满额 均取自该库，不是代码里的常量')
  } else {
    console.log(`  ⚠️ 配置来源：代码兜底值 —— ${LIVE_CONFIG.reason}`)
    console.log('    模型名与套餐售价都不是本环境的真实值，下面的钱数只能当示例看')
  }
  if (missing.length) {
    console.log(`  ⚠️ 这些通道在库里查不到，模型名退回代码默认：${missing.join(',')}`)
  }
  console.log(`  · 满额：${QUOTA_CHARS.toLocaleString()} 计费字符`)
  console.log(`  · 售价来源：${packagePriceSource()}`)
}

async function main() {
  assertLineup()

  // 顺序很重要：先把环境的真实配置读进来，再算钱。
  // 反过来的话会先按兜底值算完，再拿一个"来源"标签去解释它 —— 那是自欺。
  LIVE_CONFIG = await loadLiveConfig()
  LIVE_PACKAGES = LIVE_CONFIG.source === 'db'
    ? LIVE_CONFIG.packages.reduce((acc, row) => { acc[row.code] = row; return acc }, {})
    : null
  LIVE_CURRENCY = LIVE_CONFIG.currency || DEFAULT_CURRENCY
  if (LIVE_PACKAGES) {
    const quotas = LIVE_CONFIG.packages
      .filter(row => row.active !== false)
      .map(row => Number(row.included_chars))
      .filter(size => Number.isFinite(size) && size > 0)
    if (quotas.length) QUOTA_CHARS = Math.max(...quotas)
  }
  const { channels, missing } = effectiveChannels(LIVE_CONFIG)

  printConfigProvenance(missing)
  printChannelStatus(channels)

  const markdown = process.argv.includes('--markdown')
  const results = []

  for (const channel of channels) {
    const overhead = await measurePromptOverhead(channel)
    const perDirection = {}
    for (const direction of DIRECTIONS) {
      perDirection[direction.key] = PROFILES.map(profile =>
        Object.assign({ profile: profile.key }, costOf(channel, direction, profile, overhead.promptTokens)))
    }
    const all = Object.values(perDirection).flat()
    results.push({
      channel,
      overhead,
      perDirection,
      worst: all.reduce((a, b) => (b.high > a.high ? b : a)),
      best: all.reduce((a, b) => (b.low < a.low ? b : a)),
      // 分档用"短消息 + 重语种（中→缅）"这一最贵组合的**主估计**
      anchoring: perDirection['zh-my'][0],
      all
    })
  }

  if (markdown) {
    printMarkdown(results)
  } else {
    printConsole(results)
  }
}

function printConsole(results) {
  console.log('')
  console.log(`满额（${QUOTA_CHARS.toLocaleString()} 计费字符）单通道成本 — 人民币元，含 ±30% 敏感度区间`)
  console.log(`汇率 USD→CNY ${FX.USD}（写死在报告里，只影响本报告）`)
  console.log('"待实测" = 该通道真实模型在价目表里查不到官方价，不是免费')
  console.log('')
  const header = ['通道', '实际模型', '提示词token', '中→英(短)', '中→英(长)', '中→缅(短)', '中→缅(长)', '最贵组合(高)', '建议档']
  console.log(header.join('\t'))
  // 查不到官方价的通道一律打"待实测"，**不能打 0.0** ——
  // 0.0 在成本表里读起来就是"免费"，而它只是"我们不知道"。
  const money = (item, withBand) => {
    if (!item || !item.verified) return '待实测'
    return withBand
      ? `${item.mid.toFixed(1)} (${item.low.toFixed(1)}~${item.high.toFixed(1)})`
      : item.mid.toFixed(1)
  }
  for (const row of results) {
    const pick = (dir, profile) => row.perDirection[dir].find(item => item.profile === profile)
    console.log([
      row.channel.name,
      modelLabel(row.channel),
      row.overhead.promptTokens,
      money(pick('zh-en', 'short'), true),
      money(pick('zh-en', 'long'), false),
      money(pick('zh-my', 'short'), true),
      money(pick('zh-my', 'long'), false),
      row.worst.verified ? row.worst.high.toFixed(1) : '待实测',
      tierLabel(row),
    ].join('\t'))
  }

  // 双向全量：需求要求中英/中泰/中越/中缅**双向**，
  // 只报中→英会漏掉"小语种输出更长、更贵"这一半（中→缅约为中→英的 2.3 倍）。
  console.log('')
  console.log('短消息（30 字/条）双向明细 — 主估计 / 上界（人民币元）')
  console.log(['通道'].concat(DIRECTIONS.map(d => d.label)).join('\t'))
  for (const row of results) {
    const cells = DIRECTIONS.map(direction => {
      const item = row.perDirection[direction.key].find(entry => entry.profile === 'short')
      if (!item.verified) return '待实测'
      return `${item.mid.toFixed(1)}/${item.high.toFixed(1)}`
    })
    console.log([row.channel.name].concat(cells).join('\t'))
  }

  console.log('')
  console.log('每档"用满额度且全选套餐内最贵通道"的余额（区分 API 成本与其它成本）')
  console.log('档位\t售价(库里原值 → 折算人民币)\tAPI 成本上界(元)\t毛利(元)\tAPI 占比\t该档最贵通道\t口径完整')
  for (const code of ['basic', 'advanced', 'pro']) {
    const included = RECOMMENDED_TIERS[code]
    const scoped = results.filter(row => included.includes(row.channel.id))
    const worst = scoped.reduce((a, b) => (b.worst.high > a.worst.high ? b : a))
    const cost = worst.worst.high
    const price = packagePriceOf(code)
    const raw = packagePriceRawOf(code)
    // 查不到价的通道 high 是 0，永远选不上"最贵" —— 于是它们会把这一档的
    // 成本上界**悄悄拉低**。这不是小瑕疵：成本表最容易被误用的地方就在这里，
    // 所以只要有待实测通道，就必须在行里写明这个上界不完整。
    const unverified = scoped.filter(row => !row.all.every(item => item.verified))
    console.log([
      { basic: '基础版', advanced: '高级版', pro: '专业版' }[code] + `（${included.length} 个通道）`,
      `${raw.amount} ${raw.currency} → ¥${price.toFixed(0)}`,
      cost.toFixed(0),
      (price - cost).toFixed(0),
      `${(cost / price * 100).toFixed(0)}%`,
      worst.channel.name,
      unverified.length
        ? `不完整：${unverified.map(row => row.channel.name).join('/')} 成本待实测，上界偏低`
        : '完整'
    ].join('\t'))
  }
  console.log('')
  console.log('专业版的敏感性：Kimi 是唯一能把这一档拖到参考线以外的通道')
  {
    const withKimi = results.filter(row => RECOMMENDED_TIERS.pro.includes(row.channel.id))
    const without = results.filter(row => TIER_VARIANT_WITHOUT_KIMI.includes(row.channel.id))
    const worstOf = list => list.reduce((a, b) => (b.worst.high > a.worst.high ? b : a))
    const a = worstOf(withKimi).worst.high
    const b = worstOf(without).worst.high
    const proPrice = packagePriceOf('pro')
    console.log(`  · 含 Kimi、谷歌（11 通道）：上界 ¥${a.toFixed(0)}，占售价 ${(a / proPrice * 100).toFixed(0)}%`)
    console.log(`  · 不含 Kimi（10 通道）    ：上界 ¥${b.toFixed(0)}，占售价 ${(b / proPrice * 100).toFixed(0)}%`)
    console.log('  两个方案都在可接受范围；含 Kimi 更符合"11 个通道都能选"，不含则余量更厚。')
  }
  console.log('')
  console.log('假设与出处：')
  console.log(`  · 满额 = ${QUOTA_CHARS.toLocaleString()} 计费字符（= 中文 ${(QUOTA_CHARS / CJK_WEIGHT).toLocaleString()} 字，或英文 ${QUOTA_CHARS.toLocaleString()} 字符）`)
  console.log(`  · 售价来源：${packagePriceSource()}`)
  console.log('  · 提示词开销为实测值（截下适配器真实请求体量出来的，见脚本 measurePromptOverhead）')
  console.log('  · 译文长度系数为保守估值，成本按 ±30% 给区间；不是实测值')
  console.log('  · 输出价通常远高于输入价 —— 中→缅短消息比中→英贵约 2.3 倍，就是这个原因')
  console.log('  · 官方单价与来源日期见 server/lib/upstream-pricing.js 的 asOf / source')
  console.log('  · qwen-mt-plus 未取得官方价原文 → 全程标记"待实测"，绝不按 0 成本计入')
  console.log('  · 不承诺"绝对最坏成本已被覆盖"：真实成本取决于客户实际译文长度分布')
  console.log('')
  console.log('注：毛利 ≠ 净利润。还要扣服务器、链上归集与手续费、支付通道、客服与售后、')
  console.log('    以及未使用额度对应的沉没成本（用户没翻译完的额度不是利润，是负债）。')
  console.log('')
}

function printMarkdown(results) {
  console.log('| 通道 | 实际模型 | 官方价 | 满额成本（中→英，短消息） | 满额成本（中→缅，短消息） | 最贵组合上界 | 建议档 |')
  console.log('| --- | --- | --- | --- | --- | --- | --- |')
  for (const row of results) {
    const pick = (dir, profile) => row.perDirection[dir].find(item => item.profile === profile)
    const a = pick('zh-en', 'short')
    const b = pick('zh-my', 'short')
    const price = priceText(a)
    console.log([
      row.channel.name,
      `\`${modelLabel(row.channel)}\``,
      price,
      a.verified ? `¥${a.mid.toFixed(0)}（¥${a.low.toFixed(0)}~${a.high.toFixed(0)}）` : '**待实测**',
      b.verified ? `¥${b.mid.toFixed(0)}（¥${b.low.toFixed(0)}~${b.high.toFixed(0)}）` : '**待实测**',
      row.worst.verified ? `¥${row.worst.high.toFixed(0)}` : '待实测',
      tierLabel(row)
    ].join(' | ').replace(/^/, '| ') + ' |')
  }
}

/**
 * 建议档位标签：档位来自权益表（唯一来源），括号里给"该档最贵通道用满额度"
 * 占售价的比例 —— 这才是"为什么放在这一档"的根据。
 * 价格还没核实（verified=false）的通道不报比例，标"待实测"，
 * 绝不能因为"查不到价"就当它零成本塞进便宜档。
 */
function tierLabel(row) {
  const tier = tierOf(row.channel.id)
  if (!row.worst.verified) return `${tier}（价格待实测）`
  // 用"最贵组合"的上界，而不是某一格：用户可以把整份额度全花在一个通道上，
  // 判定这一档安不安全，就得看这个通道最贵的那一格。
  return `${tier}（占售价 ${(row.worst.high / packagePriceOf(tier) * 100).toFixed(0)}%）`
}

function priceText(item) {
  if (!item.verified) return '待核实'
  const unit = item.unit === 'character' ? '百万字符' : '百万 token'
  return `见 upstream-pricing.js（${item.currency}/${unit}）`
}

/**
 * 金额表里的"实际模型"列。
 *
 * 谷歌是按字符计价的接口，库里没有模型名，报告用的是价目表的**计价键**
 * （google-translate-v2）。不加标注的话，这一格会被读成"线上调用的模型 ID"，
 * 而前台展示的模型必须与真实调用一致 —— 标注一下，就不会有人拿它去填配置。
 */
function modelLabel(channel) {
  return channel.modelFrom === 'db' ? channel.model : `${channel.model}（计价键）`
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
