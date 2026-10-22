'use strict'

/**
 * AI 大模型翻译通道适配器（第三批 · 2026-09-25 换线）。
 *
 * ## 为什么这一批换掉了原来的翻译通道
 *
 * 原来的 aws / deepl / niutrans / papago / gemini 都是**专用翻译 API**：
 * 每家一套鉴权、一套语言码、一套报文，接入成本高，而且要么需要企业账号、
 * 要么拿不到密钥（Gemini 就是因为拿不到密钥而下架的）。五家下来真正能用的
 * 一个都没有 —— 界面上挂着、套餐里写着，客户选中就 503。
 *
 * 这一批的共性正好相反：**除 Claude 外全部是 OpenAI 兼容的
 * `/chat/completions`**。也就是说 OpenAI / DeepSeek / Grok / Qwen / 豆包 /
 * Kimi / GLM / Mistral / MiniMax 这 9 家**共用同一份实现**，
 * 差别只有 baseURL、模型名、报文字段三个常量。
 *
 * 这不是巧合：`/v1/chat/completions` 已经是事实标准（国内几家也都对齐了它），
 * 所以"接入难"这个问题的解法不是逐个啃专用 API，而是
 * **把所有 OpenAI 兼容的厂商收进一张表**。
 *
 * ## 三种协议，不是一种
 *
 *   一、OpenAI 兼容（9 家）：`openAiCompatible()`，见 translation-adapters.js
 *   二、Anthropic Messages（Claude 一家）：x-api-key 头 + max_tokens 必填，
 *       没有 system 角色，system 是顶层字段，返回体是 content[] 数组
 *   三、专用翻译模型（Qwen-MT）：**不是**通用大模型 ——
 *       必须传 translation_options，且**只允许一条 user 消息**（传 system 会 400），
 *       语种要给英文全称（"Chinese"/"English"），不是 ISO 码
 *
 * 后两种各自单独实现，是因为协议真的不同。硬塞进 OpenAI 兼容那条路
 * 只会写出一堆 if，而且第一个踩坑的人（传了 system、传了 ISO 码、忘传 max_tokens）
 * 拿到的是一个厂商的 400 原文，看不出自己错在哪。
 *
 * ## 一条硬规则（沿用本层约定）
 *
 * 凭据未配置一律 ok:false，绝不返回演示译文、绝不产生计费。
 */

const {
  openAiCompatible, LLM_LANGUAGES,
  pickKey, endpointOf, readErrorDetail, timeoutReason,
  callParamsOf, estimateTokens, normalizeUsage, inputLimitError
} = require('./translation-adapters')

// ===========================================================================
// 一、OpenAI 兼容系（豆包 / Kimi / GLM / Mistral / MiniMax）
// ===========================================================================
//
// 这五家与 GPT / Grok 走的是同一个 `openAiCompatible`，这里只填差异。
//
// `extraBody` 只放**关掉思考模式**这一类开关：思考会让翻译变慢数倍、token
// 翻倍，而且思考模式下 temperature 往往不生效（翻译要的稳定性就没了）。
// 但各家的参数名与支持范围并不统一，所以：
//   · 只填我确认过参数名的；
//   · 不填也不会坏，只是慢一点；
//   · 万一厂商拒绝（400 点名了这个参数），openAiCompatible 会去掉它重试一次。

const doubaoAdapter = openAiCompatible({
  name: '豆包翻译',
  envKey: 'PIX_ARK_API_KEY',
  defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  // 方舟的 model 既可以是接入点 ID（ep- 开头），也可以是模型名。
  // 默认给模型名，接入点用户请在后台「模型」栏覆盖成自己的 ep- 值。
  defaultModel: 'doubao-seed-1-6',
  languages: LLM_LANGUAGES,
  extraBody: { thinking: { type: 'disabled' } }
})

const kimiAdapter = openAiCompatible({
  name: 'Kimi 翻译',
  envKey: 'PIX_MOONSHOT_API_KEY',
  defaultUrl: 'https://api.moonshot.cn/v1',
  defaultModel: 'kimi-k3',
  languages: LLM_LANGUAGES,
  // Kimi K3 把采样参数固定在服务端（temperature=1、top_p=0.95），
  // 官方文档明确建议**不要传**这些字段。所以这里给 null（=不发送），
  // 而不是 0 —— 0 是"要它稳定"这个真实意图，语义不能混。
  callParams: { temperature: null }
})

const glmAdapter = openAiCompatible({
  name: 'GLM 翻译',
  envKey: 'PIX_ZHIPU_API_KEY',
  defaultUrl: 'https://open.bigmodel.cn/api/paas/v4',
  // 默认 glm-4.7 而不是 glm-4.6：智谱现行按量计费的文本旗舰是 4.7，
  // GLM-4.6 在官方价格页上已归入"算力单元/私有实例"（¥175/GPU Unit/天），
  // 那条路不适合按字符零售的翻译场景。
  defaultModel: 'glm-4.7',
  languages: LLM_LANGUAGES,
  extraBody: { thinking: { type: 'disabled' } }
})

const mistralAdapter = openAiCompatible({
  name: 'Mistral 翻译',
  envKey: 'PIX_MISTRAL_API_KEY',
  defaultUrl: 'https://api.mistral.ai/v1',
  defaultModel: 'mistral-large-latest',
  languages: LLM_LANGUAGES
})

const minimaxAdapter = openAiCompatible({
  name: 'MiniMax 翻译',
  envKey: 'PIX_MINIMAX_API_KEY',
  // 国内站 api.minimaxi.com，国际站 api.minimax.io —— 后台可覆盖。
  // 注意**不要**用早已废弃的 /v1/text/chatcompletion_v2，那是老接口，
  // 新的统一在标准 /v1/chat/completions 上。
  defaultUrl: 'https://api.minimaxi.com/v1',
  defaultModel: 'MiniMax-M3',
  languages: LLM_LANGUAGES,
  extraBody: { thinking: { type: 'disabled' } }
})

// ===========================================================================
// 二、Claude（Anthropic Messages API）
// ===========================================================================
//
// 与 OpenAI 兼容系的三处硬差别（依据官方文档 2026-09）：
//   1. 鉴权是 `x-api-key` 头，**不是** `Authorization: Bearer`；
//      并且必须带 `anthropic-version: 2023-06-01`，漏了直接 400；
//   2. `max_tokens` 是**必填**字段，漏了 400（OpenAI 那边它是可选的）；
//   3. system 不是 messages 里的一条，而是**顶层 `system` 字段**；
//      返回体也不是 choices[].message.content，而是 content[] 数组（可能多段）。
//
// 语种用自然语言描述（Claude 是通用大模型），因此复用 LLM_LANGUAGES。

/**
 * Claude 的 max_tokens 必填。
 *
 * 优先用通道表配的 maxOutputTokens（超管可调）；没配时按原文长度推算：
 * 中文一字约 1 token、英文约 0.3 token，译文通常与原文同量级，
 * 取 2 倍原文长度并夹到 [1024, 8192]。8192 是各代 Claude 都支持的安全值，
 * 给太多反而更容易触发"输出超长"计费。
 */
function claudeMaxTokens(text, configured) {
  const explicit = Number(configured)
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(8192, Math.max(256, Math.trunc(explicit)))
  return Math.min(8192, Math.max(1024, Math.ceil(String(text || '').length * 2)))
}

const claudeAdapter = {
  name: 'Claude 翻译',
  translate: async (engine, payload, options) => {
    const fromAdmin = options.credentials || {}
    const apiKey = pickKey(fromAdmin, 'PIX_ANTHROPIC_API_KEY')
    if (!apiKey) {
      return { ok: false, msg: 'Claude 凭据未配置（管理后台填 API Key，或设置 PIX_ANTHROPIC_API_KEY）' }
    }
    const text = String(payload.text || '')
    if (!text) return { ok: false, msg: '请输入要翻译的文本' }

    const target = LLM_LANGUAGES[String(payload.to || 'zh').toLowerCase()]
    if (!target) return { ok: false, msg: `Claude 不支持目标语种：${payload.to}` }

    const endpoint = endpointOf(
      (engine && engine.endpoint) || '',
      '/messages',
      'https://api.anthropic.com/v1'
    )
    const model = String(fromAdmin.model || (engine && engine.model) || '').trim() || 'claude-haiku-4-5'
    const params = callParamsOf(engine, { temperature: 0, maxOutputTokens: 8192, timeoutMs: 12000, maxRetries: 2 })

    if (params.maxInputTokens) {
      const estimate = estimateTokens(text)
      if (estimate > params.maxInputTokens) {
        return Object.assign(inputLimitError('Claude', estimate, params.maxInputTokens), { model, retries: 0 })
      }
    }

    const system = payload.to && payload.to !== 'auto'
      ? `你是专业翻译。把用户提供的文本翻译成${target}。` +
        `只输出译文本身，不要解释、不要加引号、不要重复原文。` +
        `保持原有的语气、专业术语与格式（换行、编号、表情）。`
      : `你是专业翻译。判断用户文本的语种并翻译成${target}。只输出译文本身。`

    // temperature 与 OpenAI 系同样的坑：新一代推理型模型可能只接受默认温度。
    // 用同一套"被明确点名就去掉重试一次"的策略，而不是维护模型清单。
    const withTemperatureAllowed = params.temperature !== null && params.temperature !== undefined
    const buildBody = withTemperature => {
      const body = {
        model,
        max_tokens: claudeMaxTokens(text, params.maxOutputTokens),   // 必填，漏了 400
        system,
        messages: [{ role: 'user', content: text }],
        stream: false
      }
      if (withTemperature && withTemperatureAllowed) body.temperature = Number(params.temperature)
      return body
    }

    let withTemperature = true
    let response = null
    let detail = ''
    let retries = 0

    for (let attempt = 0; attempt < 1 + params.maxRetries; attempt += 1) {
      if (attempt > 0) retries += 1
      try {
        response = await options.fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify(buildBody(withTemperature)),
          signal: AbortSignal.timeout(params.timeoutMs)
        })
      } catch (error) {
        return { ok: false, msg: `Claude 请求失败：${timeoutReason(error)}`, model, retries }
      }
      if (response.ok) break

      // Anthropic 的错误体是 { type:'error', error:{ type, message } }，
      // 与 OpenAI 的 { error:{ message } } 不同 —— readErrorDetail 两种都认。
      detail = await readErrorDetail(response)
      if ((response.status === 400 || response.status === 422) &&
          withTemperature && withTemperatureAllowed && /temperature/i.test(detail)) {
        withTemperature = false
        continue
      }
      return { ok: false, msg: `Claude 返回 HTTP ${response.status}${detail ? '：' + detail : ''}`, model, retries }
    }

    if (!response || !response.ok) {
      return {
        ok: false,
        msg: `Claude 返回 HTTP ${response && response.status}${detail ? '：' + detail : ''}`,
        model, retries
      }
    }

    let data
    try {
      data = await response.json()
    } catch (error) {
      return { ok: false, msg: 'Claude 返回体无法解析为 JSON', model, retries }
    }

    // 返回 content 是数组，可能含多种块；只取正文块拼起来
    const blocks = Array.isArray(data && data.content) ? data.content : []
    const translated = blocks
      .filter(block => block && (block.type === undefined || block.type === 'text'))
      .map(block => String(block.text || ''))
      .join('')
      .trim()
    if (!translated) return { ok: false, msg: 'Claude 未返回译文', model, retries }

    return {
      ok: true,
      text: translated,
      detected: payload.from || 'auto',
      engine: 'Claude 翻译',
      model,
      retries,
      usage: normalizeUsage(data && data.usage)
    }
  },
  configured: credentials => Boolean(pickKey(credentials, 'PIX_ANTHROPIC_API_KEY'))
}

// ===========================================================================
// 三、Qwen-MT（通义千问的**专用翻译模型**）
// ===========================================================================
//
// Qwen-MT 与上面所有通道都不是一类东西：它是为翻译专门训练的模型，
// 不是"让通用大模型按提示词翻译"。这带来三个后果（依据官方文档 2026-09）：
//
//   1. 语种不在提示词里，而在 `translation_options.source_lang / target_lang`；
//      取值是**英文全称**（"Chinese"、"English"），不是 ISO 码。
//      源语种给 "auto" 表示自动识别。
//   2. **messages 只允许一条 user 消息** —— 传 system 会直接报错。
//      所以这里刻意**不拼提示词**（也没必要，翻译指令已经内建在模型里）。
//   3. 走的是 DashScope 的 OpenAI 兼容入口，所以端点是
//      https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions，
//      返回体结构与 OpenAI 相同。
//
// 为什么值得单独接：**专用翻译模型比通用大模型更便宜、更快，而且在中译英这类
// 常见方向上质量更稳**（不会自作主张改写、加解释、加引号）。
// 对"按字符卖给商户"的生意来说，这条是成本最低的高质量通道。

// 官方支持语言表（qwen-mt-plus / flash / turbo 共 92 种）。
// 只覆盖客户端下拉里能选到的语种 —— 表里没有的会在本地直接拒绝，
// 不发请求（省一次往返，也不会产生厂商错误码）。
const QWEN_MT_LANGUAGES = {
  auto: 'auto',
  zh: 'Chinese', 'zh-cn': 'Chinese', 'zh-hans': 'Chinese',
  'zh-tw': 'Traditional Chinese', 'zh-hant': 'Traditional Chinese',
  yue: 'Cantonese',
  en: 'English', 'en-us': 'English', 'en-gb': 'English',
  ru: 'Russian', ja: 'Japanese', ko: 'Korean',
  es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', 'pt-br': 'Portuguese', 'pt-pt': 'Portuguese',
  th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay',
  ar: 'Arabic', hi: 'Hindi', he: 'Hebrew', my: 'Burmese',
  ta: 'Tamil', ur: 'Urdu', bn: 'Bengali', pl: 'Polish',
  nl: 'Dutch', ro: 'Romanian', tr: 'Turkish', km: 'Khmer',
  lo: 'Lao', cs: 'Czech', el: 'Greek', sv: 'Swedish',
  hu: 'Hungarian', da: 'Danish', fi: 'Finnish', uk: 'Ukrainian',
  bg: 'Bulgarian', sr: 'Serbian', te: 'Telugu', af: 'Afrikaans',
  hy: 'Armenian', as: 'Assamese', ast: 'Asturian', eu: 'Basque',
  be: 'Belarusian', bs: 'Bosnian', ca: 'Catalan', ceb: 'Cebuano',
  hr: 'Croatian', arz: 'Egyptian Arabic', et: 'Estonian', gl: 'Galician',
  ka: 'Georgian', gu: 'Gujarati', is: 'Icelandic', jv: 'Javanese',
  kn: 'Kannada', kk: 'Kazakh', lv: 'Latvian', lt: 'Lithuanian',
  lb: 'Luxembourgish', mk: 'Macedonian', mai: 'Maithili', mt: 'Maltese',
  mr: 'Marathi', acm: 'Mesopotamian Arabic', ary: 'Moroccan Arabic',
  ars: 'Najdi Arabic', ne: 'Nepali', az: 'North Azerbaijani',
  apc: 'North Levantine Arabic', uz: 'Northern Uzbek',
  nb: 'Norwegian Bokmål', nn: 'Norwegian Nynorsk',
  oc: 'Occitan', or: 'Odia', pag: 'Pangasinan', scn: 'Sicilian',
  sd: 'Sindhi', si: 'Sinhala', sk: 'Slovak', sl: 'Slovenian',
  ajp: 'South Levantine Arabic', sw: 'Swahili',
  tl: 'Tagalog', fil: 'Tagalog',
  acq: 'Ta’izzi-Adeni Arabic', sq: 'Tosk Albanian',
  aeb: 'Tunisian Arabic', vec: 'Venetian', war: 'Waray',
  cy: 'Welsh', fa: 'Western Persian'
}

const qwenMtAdapter = {
  name: '通义千问翻译',
  translate: async (engine, payload, options) => {
    const fromAdmin = options.credentials || {}
    const apiKey = pickKey(fromAdmin, 'PIX_DASHSCOPE_API_KEY')
    if (!apiKey) {
      return { ok: false, msg: '通义千问凭据未配置（管理后台填 API Key，或设置 PIX_DASHSCOPE_API_KEY）' }
    }
    const text = String(payload.text || '')
    if (!text) return { ok: false, msg: '请输入要翻译的文本' }

    const key = String(payload.to || 'zh').toLowerCase()
    const target = QWEN_MT_LANGUAGES[key]
    if (!target || target === 'auto') {
      return { ok: false, msg: `通义千问不支持目标语种：${payload.to}` }
    }
    const source = String(payload.from || payload.detected || 'auto').toLowerCase()
    const from = QWEN_MT_LANGUAGES[source] || 'auto'

    const endpoint = endpointOf(
      (engine && engine.endpoint) || '',
      '/chat/completions',
      'https://dashscope.aliyuncs.com/compatible-mode/v1'
    )
    const model = String(fromAdmin.model || (engine && engine.model) || '').trim() || 'qwen-mt-flash'
    // Qwen-MT **单条输入硬上限 8192 tokens**（官方文档明确写的），
    // 超了厂商会直接报错。这里在本地先拦下来，给一条用户看得懂的提示 ——
    // 而不是把厂商的 token 超限错误码原样丢给商户。
    const params = callParamsOf(engine, { temperature: 0, maxInputTokens: 8192, timeoutMs: 10000, maxRetries: 2 })
    if (params.maxInputTokens) {
      const estimate = estimateTokens(text)
      if (estimate > params.maxInputTokens) {
        return Object.assign(inputLimitError('通义千问', estimate, params.maxInputTokens), { model, retries: 0 })
      }
    }

    const buildBody = (withTemperature, withMaxTokens) => {
      const body = {
        model,
        // 只允许一条 user 消息：这里**不能**加 system（加了会 400），
        // 也不需要加 —— 翻译指令是模型内建的
        messages: [{ role: 'user', content: text }],
        translation_options: { source_lang: from, target_lang: target },
        stream: false
      }
      // 与 OpenAI 系同一套自愈策略：被厂商点名拒绝就去掉重试
      if (withTemperature && params.temperature !== null && params.temperature !== undefined) {
        body.temperature = Number(params.temperature)
      }
      if (params.maxOutputTokens) body.max_tokens = params.maxOutputTokens
      return body
    }

    let withTemperature = true
    let withMaxTokens = Boolean(params.maxOutputTokens)
    let response = null
    let detail = ''
    let retries = 0

    for (let attempt = 0; attempt < 1 + params.maxRetries; attempt += 1) {
      if (attempt > 0) retries += 1
      try {
        response = await options.fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(buildBody(withTemperature, withMaxTokens)),
          signal: AbortSignal.timeout(params.timeoutMs)
        })
      } catch (error) {
        return { ok: false, msg: `通义千问请求失败：${timeoutReason(error)}`, model, retries }
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
      return { ok: false, msg: `通义千问返回 HTTP ${response.status}${detail ? '：' + detail : ''}`, model, retries }
    }

    if (!response || !response.ok) {
      return {
        ok: false,
        msg: `通义千问返回 HTTP ${response && response.status}${detail ? '：' + detail : ''}`,
        model, retries
      }
    }

    let data
    try {
      data = await response.json()
    } catch (error) {
      return { ok: false, msg: '通义千问返回体无法解析为 JSON', model, retries }
    }

    const choice = Array.isArray(data && data.choices) ? data.choices[0] : null
    const translated = String((choice && choice.message && choice.message.content) || '').trim()
    if (!translated) return { ok: false, msg: '通义千问未返回译文', model, retries }

    return {
      ok: true,
      text: translated,
      detected: source,
      engine: '通义千问翻译',
      model,
      retries,
      usage: normalizeUsage(data && data.usage)
    }
  },
  configured: credentials => Boolean(pickKey(credentials, 'PIX_DASHSCOPE_API_KEY'))
}

module.exports = {
  claudeAdapter,
  qwenMtAdapter,
  doubaoAdapter,
  kimiAdapter,
  glmAdapter,
  mistralAdapter,
  minimaxAdapter,
  QWEN_MT_LANGUAGES,
  claudeMaxTokens
}
