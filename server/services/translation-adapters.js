/**
 * 翻译通道适配器（第二批）。
 *
 * 原来这 6 个都是 `notWired()` 占位 —— 界面上挂着、套餐里写着，
 * 但填了 key 也用不了。这里把它们真正实现。
 *
 * ## 一条重要说明：能否验证
 *
 * 这些实现是按各家官方文档写的，**但没有真实 key 就无法端到端验证**。
 * 所以：
 *   · `configured()` 只检查凭据是否填了，不代表能调通
 *   · 真正接通（wired）仍由后台按凭据齐备判定，不会凭空变绿
 *   · 每个适配器拿到 key 后应实际翻一句确认
 *
 * 这是有意的：**宁可显示"待验证"，也不要显示"已接通"却调不通。**
 *
 * ## 为什么 OpenAI 兼容的三家共用一个函数
 *
 * GPT（OpenAI）、Grok（xAI）、DeepSeek 都是 `/chat/completions` 同构接口，
 * 差别只在 baseURL、模型名与文案。写三份重复实现的话，
 * 将来改超时、改错误处理就要改三处，必然漏掉一处。
 */

const DEFAULT_TIMEOUT_MS = 8000

function envValue(name) {
  const v = process.env[name]
  return typeof v === 'string' ? v.trim() : ''
}

/** 统一取凭据：后台配置优先，其次环境变量（便于本地联调与容器部署） */
function pickKey(credentials, envName) {
  const fromAdmin = credentials || {}
  return String(fromAdmin.apiKey || '').trim() || envValue(envName)
}

/** 裸域名自动补路径，方便后台填自建网关/代理 */
function endpointOf(raw, fallbackPath, defaultHost) {
  const v = String(raw || '').trim()
  if (!v) return defaultHost + fallbackPath
  const trimmed = v.replace(/\/+$/, '')
  if (/\/v\d+\//.test(trimmed) || /\/(chat\/completions|translate|translation)$/.test(trimmed)) return trimmed
  return trimmed + fallbackPath
}

/** 从各家五花八门的错误体里尽力捞出可读原因（欠费、key 无效、配额用尽） */
async function readErrorDetail(response) {
  try {
    const body = await response.json()
    return String(
      (body && body.error && (body.error.message || body.error.detail)) ||
      (body && body.message) ||
      (body && body.msg) ||
      (body && body.detail) || ''
    ).trim()
  } catch (e) {
    return ''
  }
}

function timeoutReason(error) {
  return (error && error.name === 'TimeoutError') ? '请求超时' : ((error && error.message) || String(error))
}

// ===========================================================================
// 调用限额与用量归一（所有适配器共用）
// ===========================================================================

/**
 * 通道调用的硬边界。**默认值写在这里，具体值由通道的 call_params 决定**。
 *
 * 为什么要有上限而不是"用厂商默认"：
 *   · 超时：不设的话一个卡住的厂商连接会把翻译请求吊到平台级超时，
 *     商户侧表现为"一直在转圈"，比明确报错差得多。
 *   · 重试：翻译是**按次计费**的，重试一次就多花一次钱。自动重试必须封顶，
 *     否则遇到厂商持续 5xx 会连打多次，成本与延迟一起爆。
 *   · 输出长度：不设上限时模型可能把"翻译"写成一篇解释文，
 *     既不是用户要的，也按输出 token 全额计费。
 */
const CALL_LIMITS = Object.freeze({
  timeoutMs: { min: 1000, max: 30000, fallback: 8000 },
  maxRetries: { min: 0, max: 2, fallback: 2 },
  maxOutputTokens: { min: 0, max: 65536, fallback: 0 },
  maxInputTokens: { min: 0, max: 1000000, fallback: 0 }
})

function clampLimit(name, value) {
  const spec = CALL_LIMITS[name]
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return spec.fallback
  return Math.min(spec.max, Math.max(spec.min, Math.trunc(parsed)))
}

/**
 * 合并"代码默认参数"与"通道表里配的参数"。
 *
 * 通道表（`engines.call_params`）优先 —— 那条要求「每个渠道必须配置明确的
 * 供应商、实际模型 ID 和调用参数」要落在**可查、可改**的地方，
 * 而不是散在代码常量里。超管在后台改完立刻生效，不用发版。
 *
 * `temperature: null` 是**有意的空值语义**：表示"这个模型不能收 temperature"。
 * Kimi K3 就是这种情况（官方把采样参数固定在服务端，明确建议不要传）。
 * 用 null 而不是 0，是因为 0 是"要它别发挥"这个真实意图，两者不能混。
 */
function callParamsOf(engine, defaults) {
  const base = defaults || {}
  const fromEngine = (engine && engine.callParams) || {}
  const merged = Object.assign({}, base, fromEngine)
  const out = {
    temperature: merged.temperature === undefined ? 0 : merged.temperature,
    maxOutputTokens: clampLimit('maxOutputTokens', merged.maxOutputTokens),
    maxInputTokens: clampLimit('maxInputTokens', merged.maxInputTokens),
    timeoutMs: clampLimit('timeoutMs', merged.timeoutMs === undefined ? base.timeoutMs : merged.timeoutMs),
    maxRetries: clampLimit('maxRetries', merged.maxRetries === undefined ? base.maxRetries : merged.maxRetries)
  }
  if (merged.extraBody && typeof merged.extraBody === 'object') out.extraBody = merged.extraBody
  out.stream = false
  return out
}

/**
 * 粗估输入 token 数。
 *
 * **刻意不用 tiktoken 之类的精确分词**：我们要的不是精确值，而是"该不该拒"。
 * 一个保守的上界就够，而且没有额外依赖、不受模型换代影响。
 *
 * 口径（保守 = 高估 token 数，宁可拒掉也不发出超限请求）：
 *   · CJK（中日韩）一字 ≈ 1 token —— 这already 是很保守的上界
 *     （实际多数分词器 CJK 约 0.6~1.0 token/字）
 *   · 其余字符按 3 字符 ≈ 1 token（英文实际约 4）
 * 也就是说真实 token 通常**少于**这个估值，不会误伤正常文本。
 */
function estimateTokens(text) {
  const value = String(text || '')
  let cjk = 0
  let other = 0
  for (const char of value) {
    if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(char)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 3)
}

/**
 * 把各家五花八门的用量字段归一。
 *
 * OpenAI 兼容系是 prompt_tokens / completion_tokens，
 * Anthropic 是 input_tokens / output_tokens。两者都要能进同一张
 * `translation_usage` 表，否则成本对账得按厂商写四套查询。
 */
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const pick = (...values) => {
    for (const value of values) {
      const parsed = Number(value)
      if (Number.isFinite(parsed) && parsed > 0) return parsed
    }
    return 0
  }
  const promptTokens = pick(raw.prompt_tokens, raw.input_tokens)
  const completionTokens = pick(raw.completion_tokens, raw.output_tokens)
  const reasoningTokens = pick(
    raw.completion_tokens_details && raw.completion_tokens_details.reasoning_tokens,
    raw.output_tokens_details && raw.output_tokens_details.reasoning_tokens,
    raw.reasoning_tokens
  )
  const totalTokens = pick(raw.total_tokens) || (promptTokens + completionTokens)
  if (!promptTokens && !completionTokens && !totalTokens) return null
  return { promptTokens, completionTokens, reasoningTokens, totalTokens }
}

/**
 * 输入超限时**直接失败**，绝不静默截断。
 *
 * 截断的译文是"看起来成功、其实是残缺的"—— 商户拿它去谈生意会出错，
 * 而我们照样扣了字符。这种失败比报错严重得多。
 * 报错则很明确：让用户自己决定分段，费用可预期。
 */
function inputLimitError(name, estimate, limit) {
  return {
    ok: false,
    msg: `${name} 单条文本过长（约 ${estimate} tokens，该通道上限 ${limit} tokens）。` +
      '请分段翻译，本站不会静默截断原文。'
  }
}

// ===========================================================================
// 一、OpenAI 兼容系（GPT / Grok）
// ===========================================================================

/**
 * 造一个 OpenAI 兼容的翻译适配器。
 *
 * @param {object} cfg
 * @param {string} cfg.name       展示名（同时用于错误文案）
 * @param {string} cfg.envKey     环境变量名
 * @param {string} cfg.defaultUrl 默认端点
 * @param {string} cfg.defaultModel 默认模型
 * @param {object} cfg.languages  语种映射（值为自然语言名，交给模型理解）
 * @param {object} [cfg.extraBody] 厂商专属参数（如关掉思考模式）。**不确定就不传** ——
 *   少传只是慢一点，乱传会直接 400。被厂商明确拒绝时下面的重试会把它去掉。
 */
function openAiCompatible(cfg) {
  return {
    name: cfg.name,
    translate: async (engine, payload, options) => {
      const apiKey = pickKey(options.credentials, cfg.envKey)
      if (!apiKey) {
        return { ok: false, msg: `${cfg.name} 凭据未配置（管理后台填 API Key，或设置 ${cfg.envKey}）` }
      }
      const text = String(payload.text || '')
      if (!text) return { ok: false, msg: '请输入要翻译的文本' }

      const target = cfg.languages[String(payload.to || 'zh').toLowerCase()]
      if (!target) return { ok: false, msg: `${cfg.name} 不支持目标语种：${payload.to}` }

      const endpoint = endpointOf((engine && engine.endpoint) || '', '/chat/completions', cfg.defaultUrl)
      const model = String(
        (options.credentials && options.credentials.model) || (engine && engine.model) || ''
      ).trim() || cfg.defaultModel

      // 调用参数：通道表优先，代码默认兜底（含超时/重试/输出上限）
      const params = callParamsOf(engine, cfg.callParams)

      // 输入超限直接拒，不截断（见 inputLimitError 的说明）
      if (params.maxInputTokens) {
        const estimate = estimateTokens(text)
        if (estimate > params.maxInputTokens) {
          return inputLimitError(cfg.name, estimate, params.maxInputTokens)
        }
      }

      // 用自然语言描述语种，而不是 ISO 码 —— 这几家都是大模型，
      // 说"把下面的内容翻译成简体中文"比给一个 "zh" 码更稳，
      // 尤其对小语种和语种变体（繁体/巴西葡语）差别很明显。
      const system = payload.to && payload.to !== 'auto'
        ? `你是专业翻译。把用户提供的文本翻译成${target}。` +
          `只输出译文本身，不要解释、不要加引号、不要重复原文。` +
          `保持原有的语气、专业术语与格式（换行、编号、表情）。`
        : `你是专业翻译。判断用户文本的语种并翻译成${target}。只输出译文本身。`

      const extraBody = Object.assign(
        {},
        typeof cfg.extraBody === 'function'
          ? (cfg.extraBody(engine, options.credentials) || {})
          : (cfg.extraBody || {}),
        params.extraBody || {}
      )
      const extraKeys = Object.keys(extraBody)
      // null = 这个模型不能收 temperature（如 Kimi K3 把采样参数固定在服务端）
      const withTemperatureAllowed = params.temperature !== null && params.temperature !== undefined

      // temperature 与厂商专属参数都只在需要时带上（见下方重试说明）
      const buildBody = (withTemperature, withExtra, withMaxTokens) => {
        const body = {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: text }
          ],
          stream: false
        }
        if (withTemperature && withTemperatureAllowed) body.temperature = Number(params.temperature)
        if (withExtra && extraKeys.length) Object.assign(body, extraBody)
        // 输出上限：不设的话模型可能把翻译写成一篇解释文，按输出 token 全额计费
        if (withMaxTokens && params.maxOutputTokens) body.max_tokens = params.maxOutputTokens
        return body
      }

      /**
       * 自愈式参数降级：**不维护"哪些模型不支持哪些参数"的清单**去预判。
       *
       * 四个真实案例：
       *   1. 推理类模型（GPT-5 系列、o 系列…）只接受默认 temperature(=1)，
       *      传 0 被直接拒：
       *        400 "Unsupported value: 'temperature' does not support 0 with this model."
       *   2. 厂商专属参数（关思考）不是每家都有，模型名换代后可能就没了：
       *        400 "unknown parameter: thinking"
       *   3. 新模型把 max_tokens 改名成 max_completion_tokens：
       *        400 "Unsupported parameter: 'max_tokens' is not supported with this model."
       *   4. 反过来，有的网关不认 max_completion_tokens 只认 max_tokens ——
       *      所以这里只**去掉**被点名的那个参数，不主动换成另一个。
       *
       * 清单式预判迟早过期（模型名会换代、新模型层出不穷），而且误判会把本来
       * 正常的厂商也改坏。改成"先按常规全部带上，被厂商**明确点名**拒绝时
       * 去掉那一个重试" —— 对其他厂商零影响、成功路径不产生额外请求、对新模型自愈。
       *
       * 只对 400/422 降级：其它状态码（401 密钥、402 欠费、404 模型不存在、429 限流）
       * 都是真问题，多打一次请求只会掩盖原因。
       *
       * 重试次数受 maxRetries 约束：每次重试都是**真的要花钱**的上游调用。
       */
      let withTemperature = true
      let withExtra = extraKeys.length > 0
      let withMaxTokens = Boolean(params.maxOutputTokens)
      let attempts = 0
      let retries = 0
      let response = null
      let detail = ''

      for (let attempt = 0; attempt < 1 + params.maxRetries; attempt += 1) {
        attempts += 1
        if (attempt > 0) retries += 1
        try {
          response = await options.fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(buildBody(withTemperature, withExtra, withMaxTokens)),
            signal: AbortSignal.timeout(params.timeoutMs)
          })
        } catch (error) {
          return {
            ok: false,
            msg: `${cfg.name} 请求失败：${timeoutReason(error)}`,
            attempts, retries, model
          }
        }
        if (response.ok) break

        detail = await readErrorDetail(response)
        const rejected = response.status === 400 || response.status === 422
        if (rejected && withTemperature && /temperature/i.test(detail)) {
          withTemperature = false
          continue
        }
        if (rejected && withMaxTokens && /max_tokens|max_completion_tokens/i.test(detail)) {
          withMaxTokens = false
          continue
        }
        if (rejected && withExtra && extraKeys.some(key => new RegExp(key, 'i').test(detail))) {
          withExtra = false
          continue
        }
        return {
          ok: false,
          msg: `${cfg.name} 返回 HTTP ${response.status}${detail ? '：' + detail : ''}`,
          attempts, retries, model
        }
      }

      if (!response || !response.ok) {
        return {
          ok: false,
          msg: `${cfg.name} 返回 HTTP ${response && response.status}${detail ? '：' + detail : ''}`,
          attempts, retries, model
        }
      }

      let data
      try {
        data = await response.json()
      } catch (e) {
        return { ok: false, msg: `${cfg.name} 返回体无法解析为 JSON`, attempts, retries, model }
      }

      const choice = Array.isArray(data && data.choices) ? data.choices[0] : null
      const translated = String((choice && choice.message && choice.message.content) || '').trim()
      if (!translated) return { ok: false, msg: `${cfg.name} 未返回译文`, attempts, retries, model }

      return {
        ok: true,
        text: translated,
        detected: payload.from || 'auto',
        engine: cfg.name,
        // 真实调用的模型（含后台覆盖过的）与厂商给的用量：core-service 据此
        // 写内部台账。展示给用户的 model 就是这里这个值 —— 同一个来源。
        model,
        retries,
        usage: normalizeUsage(data && data.usage)
      }
    },
    // 只判"凭据是否填了"，不代表能调通 —— 真实可用性要靠实际调用验证
    configured: credentials => Boolean(pickKey(credentials, cfg.envKey))
  }
}

// 语种映射用自然语言名。这套表刻意做得宽一些：
// 大模型能理解"巴西葡萄牙语"这类说法，比 ISO 码更不容易出错。
//
// 覆盖范围按**客户端语种下拉里实际能选到的**来定（见 desktop/renderer/app.js 的
// LANGS）。表里没有的语种会在本地被拒（"不支持目标语种"），而不是发出去等厂商报错 ——
// 本地拒的好处是不产生任何厂商请求与延迟。所以漏一个语种 = 用户选不了这个语种，
// 加语种时请同步这张表。
const LLM_LANGUAGES = {
  auto: '',
  zh: '简体中文', 'zh-cn': '简体中文', 'zh-hans': '简体中文',
  'zh-tw': '繁体中文', 'zh-hant': '繁体中文',
  en: '英语', 'en-us': '英语', 'en-gb': '英语',
  ja: '日语', ko: '韩语',
  fr: '法语', de: '德语', es: '西班牙语',
  pt: '葡萄牙语', 'pt-br': '巴西葡萄牙语', 'pt-pt': '葡萄牙语',
  ru: '俄语', it: '意大利语', ar: '阿拉伯语', th: '泰语', vi: '越南语',
  id: '印尼语', ms: '马来语', hi: '印地语', tr: '土耳其语', nl: '荷兰语',
  pl: '波兰语', uk: '乌克兰语', he: '希伯来语', fa: '波斯语', bn: '孟加拉语',
  fil: '菲律宾语', tl: '菲律宾语',
  sv: '瑞典语', da: '丹麦语', fi: '芬兰语', no: '挪威语', nb: '挪威语', nn: '挪威语',
  cs: '捷克语', sk: '斯洛伐克语', sl: '斯洛文尼亚语', el: '希腊语',
  ro: '罗马尼亚语', hu: '匈牙利语', bg: '保加利亚语', hr: '克罗地亚语',
  sr: '塞尔维亚语', bs: '波斯尼亚语', mk: '马其顿语', sq: '阿尔巴尼亚语',
  lt: '立陶宛语', lv: '拉脱维亚语', et: '爱沙尼亚语', is: '冰岛语',
  ca: '加泰罗尼亚语', gl: '加利西亚语', eu: '巴斯克语', cy: '威尔士语',
  af: '南非荷兰语', sw: '斯瓦希里语', am: '阿姆哈拉语', yo: '约鲁巴语',
  ha: '豪萨语', zu: '祖鲁语', so: '索马里语', mg: '马尔加什语',
  ta: '泰米尔语', te: '泰卢固语', ml: '马拉雅拉姆语', kn: '卡纳达语',
  mr: '马拉地语', gu: '古吉拉特语', pa: '旁遮普语', ur: '乌尔都语',
  ne: '尼泊尔语', si: '僧伽罗语', km: '高棉语', lo: '老挝语', my: '缅甸语',
  mn: '蒙古语', kk: '哈萨克语', ky: '吉尔吉斯语', uz: '乌兹别克语',
  tg: '塔吉克语', tk: '土库曼语', az: '阿塞拜疆语', hy: '亚美尼亚语',
  ka: '格鲁吉亚语', ug: '维吾尔语', bo: '藏语',
  yi: '意第绪语', mt: '马耳他语', lb: '卢森堡语', ga: '爱尔兰语',
  jv: '爪哇语', su: '巽他语', ceb: '宿务语', haw: '夏威夷语'
}

const gptAdapter = openAiCompatible({
  name: 'GPT 翻译',
  envKey: 'PIX_OPENAI_API_KEY',
  defaultUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o-mini',
  languages: LLM_LANGUAGES
})

const grokAdapter = openAiCompatible({
  name: 'Grok 翻译',
  envKey: 'PIX_XAI_API_KEY',
  defaultUrl: 'https://api.x.ai/v1',
  defaultModel: 'grok-2-latest',
  languages: LLM_LANGUAGES
})

// ===========================================================================
// 二、DeepL
// ===========================================================================

/**
 * DeepL 的语种码是大写，且中文要区分简繁。
 * 用错会直接 400 —— 例如传 `zh` 会被拒，必须 `ZH-HANS`。
 */
const DEEPL_LANGUAGES = {
  zh: 'ZH-HANS', 'zh-cn': 'ZH-HANS', 'zh-hans': 'ZH-HANS',
  'zh-tw': 'ZH-HANT', 'zh-hant': 'ZH-HANT',
  en: 'EN-US', 'en-us': 'EN-US', 'en-gb': 'EN-GB',
  ja: 'JA', ko: 'KO', fr: 'FR', de: 'DE', es: 'ES', pt: 'PT-BR',
  'pt-br': 'PT-BR', 'pt-pt': 'PT-PT', ru: 'RU', it: 'IT',
  nl: 'NL', pl: 'PL', tr: 'TR', uk: 'UK', ar: 'AR', th: 'TH', vi: 'VI', id: 'ID'
}

const deeplAdapter = {
  name: 'DeepL 翻译',
  translate: async (engine, payload, options) => {
    const apiKey = pickKey(options.credentials, 'PIX_DEEPL_API_KEY')
    if (!apiKey) {
      return { ok: false, msg: 'DeepL 凭据未配置（管理后台填 API Key，或设置 PIX_DEEPL_API_KEY）' }
    }
    const text = String(payload.text || '')
    if (!text) return { ok: false, msg: '请输入要翻译的文本' }

    const key = String(payload.to || 'zh').toLowerCase()
    const target = DEEPL_LANGUAGES[key]
    if (!target) return { ok: false, msg: `DeepL 不支持目标语种：${payload.to}` }

    // 免费版与专业版是**不同的域名**，填错了会 403。
    // 按 key 后缀自动判断：官方给免费版 key 加了 `:fx` 后缀。
    const isFree = /:fx$/.test(apiKey)
    const endpoint = endpointOf(
      (engine && engine.endpoint) || '',
      '/v2/translate',
      isFree ? 'https://api-free.deepl.com' : 'https://api.deepl.com'
    )

    const form = new URLSearchParams()
    form.set('text', text)
    form.set('target_lang', target)
    const source = String(payload.from || payload.detected || '').toLowerCase()
    // auto 时不能传 source_lang，传了 DeepL 会按那个语种硬解，反而更差
    if (source && source !== 'auto' && DEEPL_LANGUAGES[source]) {
      form.set('source_lang', DEEPL_LANGUAGES[source].split('-')[0])
    }

    let response
    try {
      response = await options.fetch(endpoint, {
        method: 'POST',
        headers: {
          // 2025-03 起 DeepL 废弃了 `auth_key` 查询参数，改为这个请求头
          Authorization: `DeepL-Auth-Key ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form.toString(),
        signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS)
      })
    } catch (error) {
      return { ok: false, msg: `DeepL 请求失败：${timeoutReason(error)}` }
    }

    if (!response.ok) {
      const detail = await readErrorDetail(response)
      // 403 最常见的原因是免费版 key 打到了专业版域名（或反过来），
      // 这个错误提示里直接点出来，省得去翻文档
      const hint = response.status === 403 ? '（常见原因：免费版 key 用在了专业版域名，或反之）' : ''
      return { ok: false, msg: `DeepL 返回 HTTP ${response.status}${hint}${detail ? '：' + detail : ''}` }
    }

    let data
    try {
      data = await response.json()
    } catch (e) {
      return { ok: false, msg: 'DeepL 返回体无法解析为 JSON' }
    }
    const item = Array.isArray(data && data.translations) ? data.translations[0] : null
    const translated = String((item && item.text) || '').trim()
    if (!translated) return { ok: false, msg: 'DeepL 未返回译文' }

    return {
      ok: true,
      text: translated,
      detected: (item && item.detected_source_language) || payload.from || 'auto',
      engine: 'DeepL 翻译'
    }
  },
  configured: credentials => Boolean(pickKey(credentials, 'PIX_DEEPL_API_KEY'))
}

// ===========================================================================
// 三、Papago（Naver）
// ===========================================================================

const PAPAGO_LANGUAGES = {
  zh: 'zh-CN', 'zh-cn': 'zh-CN', 'zh-hans': 'zh-CN',
  'zh-tw': 'zh-TW', 'zh-hant': 'zh-TW',
  en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', ru: 'ru', vi: 'vi',
  th: 'th', id: 'id', it: 'it', pt: 'pt', hi: 'hi', ar: 'ar'
}

const papagoAdapter = {
  name: 'Papago 翻译',
  translate: async (engine, payload, options) => {
    // Papago 要**两个**头：Client ID 与 Client Secret。
    // 后台表单只有一个"密钥"框，所以约定 apiKey 存 ID、secret 存 Secret。
    const fromAdmin = options.credentials || {}
    const clientId = String(fromAdmin.apiKey || '').trim() || envValue('PIX_PAPAGO_CLIENT_ID')
    const clientSecret = String(fromAdmin.secret || '').trim() || envValue('PIX_PAPAGO_CLIENT_SECRET')
    if (!clientId || !clientSecret) {
      return { ok: false, msg: 'Papago 需要 Client ID 与 Client Secret 两个值，请检查是否都填了' }
    }
    const text = String(payload.text || '')
    if (!text) return { ok: false, msg: '请输入要翻译的文本' }

    const key = String(payload.to || 'zh').toLowerCase()
    const target = PAPAGO_LANGUAGES[key]
    if (!target) return { ok: false, msg: `Papago 不支持目标语种：${payload.to}` }

    const source = String(payload.from || payload.detected || '').toLowerCase()
    const from = (source && source !== 'auto' && PAPAGO_LANGUAGES[source]) || 'auto'

    const endpoint = endpointOf(
      (engine && engine.endpoint) || '',
      '/nmt/v1/translation',
      'https://naveropenapi.apigw.ntruss.com'
    )

    let response
    try {
      response = await options.fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-NCP-APIGW-API-KEY-ID': clientId,
          'X-NCP-APIGW-API-KEY': clientSecret
        },
        body: JSON.stringify({ source: from, target, text }),
        signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS)
      })
    } catch (error) {
      return { ok: false, msg: `Papago 请求失败：${timeoutReason(error)}` }
    }

    if (!response.ok) {
      const detail = await readErrorDetail(response)
      return { ok: false, msg: `Papago 返回 HTTP ${response.status}${detail ? '：' + detail : ''}` }
    }

    let data
    try {
      data = await response.json()
    } catch (e) {
      return { ok: false, msg: 'Papago 返回体无法解析为 JSON' }
    }
    const translated = String(
      (data && data.message && data.message.result && data.message.result.translatedText) || ''
    ).trim()
    if (!translated) return { ok: false, msg: 'Papago 未返回译文' }

    return { ok: true, text: translated, detected: from, engine: 'Papago 翻译' }
  },
  configured: credentials => {
    const c = credentials || {}
    return Boolean(
      (String(c.apiKey || '').trim() || envValue('PIX_PAPAGO_CLIENT_ID')) &&
      (String(c.secret || '').trim() || envValue('PIX_PAPAGO_CLIENT_SECRET'))
    )
  }
}

// ===========================================================================
// 四、小牛翻译
// ===========================================================================

const NIUTRANS_LANGUAGES = {
  zh: 'zh', 'zh-cn': 'zh', 'zh-tw': 'cht', en: 'en', ja: 'ja', ko: 'ko',
  fr: 'fr', de: 'de', es: 'es', pt: 'pt', ru: 'ru', it: 'it', ar: 'ar',
  th: 'th', vi: 'vi', id: 'id', ms: 'ms', hi: 'hi', tr: 'tr', nl: 'nl', pl: 'pl'
}

const niutransAdapter = {
  name: '小牛翻译',
  translate: async (engine, payload, options) => {
    const apiKey = pickKey(options.credentials, 'PIX_NIUTRANS_API_KEY')
    if (!apiKey) {
      return { ok: false, msg: '小牛翻译 凭据未配置（管理后台填 API Key，或设置 PIX_NIUTRANS_API_KEY）' }
    }
    const text = String(payload.text || '')
    if (!text) return { ok: false, msg: '请输入要翻译的文本' }

    const key = String(payload.to || 'zh').toLowerCase()
    const target = NIUTRANS_LANGUAGES[key]
    if (!target) return { ok: false, msg: `小牛翻译 不支持目标语种：${payload.to}` }

    const source = String(payload.from || payload.detected || '').toLowerCase()
    const from = (source && source !== 'auto' && NIUTRANS_LANGUAGES[source]) || 'auto'

    const endpoint = endpointOf(
      (engine && engine.endpoint) || '',
      '/NiuTransServer/translation',
      'https://api.niutrans.com'
    )

    // 小牛的参数走 query string，且**必须 URL 编码** ——
    // 原文里带 & 或 ? 时不编码会把参数截断
    const qs = new URLSearchParams({
      from, to: target, apikey: apiKey, src_text: text
    })

    let response
    try {
      response = await options.fetch(`${endpoint}?${qs.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS)
      })
    } catch (error) {
      return { ok: false, msg: `小牛翻译 请求失败：${timeoutReason(error)}` }
    }

    if (!response.ok) {
      const detail = await readErrorDetail(response)
      return { ok: false, msg: `小牛翻译 返回 HTTP ${response.status}${detail ? '：' + detail : ''}` }
    }

    let data
    try {
      data = await response.json()
    } catch (e) {
      return { ok: false, msg: '小牛翻译 返回体无法解析为 JSON' }
    }
    // 小牛把错误也放在 200 的响应体里，必须显式检查 errorCode
    if (data && data.errorCode) {
      return { ok: false, msg: `小牛翻译 返回错误 ${data.errorCode}：${data.errorMessage || '未知原因'}` }
    }
    const translated = String((data && data.tgt_text) || '').trim()
    if (!translated) return { ok: false, msg: '小牛翻译 未返回译文' }

    return { ok: true, text: translated, detected: from, engine: '小牛翻译' }
  },
  configured: credentials => Boolean(pickKey(credentials, 'PIX_NIUTRANS_API_KEY'))
}

module.exports = {
  gptAdapter,
  grokAdapter,
  deeplAdapter,
  papagoAdapter,
  niutransAdapter,
  LLM_LANGUAGES,
  DEEPL_LANGUAGES,
  PAPAGO_LANGUAGES,
  NIUTRANS_LANGUAGES,
  // 以下是给同目录的 translation-adapters-llm.js 复用的构件。
  // 导出它们是为了**只有一份** OpenAI 兼容实现与语种表 ——
  // 两份实现分叉的代价是"改一处漏一处"，超时/错误处理尤其容易漏。
  openAiCompatible,
  pickKey,
  endpointOf,
  readErrorDetail,
  timeoutReason,
  envValue,
  DEFAULT_TIMEOUT_MS,
  // 调用限额 / 用量归一：Claude 与 Qwen-MT 这两条非 OpenAI 协议也要用，
  // 从同一处导出，保证"超时上限、重试上限、token 估算口径"全局只有一份。
  CALL_LIMITS,
  callParamsOf,
  estimateTokens,
  normalizeUsage,
  inputLimitError
}
