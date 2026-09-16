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

      // 用自然语言描述语种，而不是 ISO 码 —— 这几家都是大模型，
      // 说"把下面的内容翻译成简体中文"比给一个 "zh" 码更稳，
      // 尤其对小语种和语种变体（繁体/巴西葡语）差别很明显。
      const system = payload.to && payload.to !== 'auto'
        ? `你是专业翻译。把用户提供的文本翻译成${target}。` +
          `只输出译文本身，不要解释、不要加引号、不要重复原文。` +
          `保持原有的语气、专业术语与格式（换行、编号、表情）。`
        : `你是专业翻译。判断用户文本的语种并翻译成${target}。只输出译文本身。`

      let response
      try {
        response = await options.fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: text }
            ],
            temperature: 0,   // 翻译要稳定，不要发挥
            stream: false
          }),
          signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS)
        })
      } catch (error) {
        return { ok: false, msg: `${cfg.name} 请求失败：${timeoutReason(error)}` }
      }

      if (!response.ok) {
        const detail = await readErrorDetail(response)
        return { ok: false, msg: `${cfg.name} 返回 HTTP ${response.status}${detail ? '：' + detail : ''}` }
      }

      let data
      try {
        data = await response.json()
      } catch (e) {
        return { ok: false, msg: `${cfg.name} 返回体无法解析为 JSON` }
      }

      const choice = Array.isArray(data && data.choices) ? data.choices[0] : null
      const translated = String((choice && choice.message && choice.message.content) || '').trim()
      if (!translated) return { ok: false, msg: `${cfg.name} 未返回译文` }

      return {
        ok: true,
        text: translated,
        detected: payload.from || 'auto',
        engine: cfg.name,
        usage: (data && data.usage) || null
      }
    },
    // 只判"凭据是否填了"，不代表能调通 —— 真实可用性要靠实际调用验证
    configured: credentials => Boolean(pickKey(credentials, cfg.envKey))
  }
}

// 语种映射用自然语言名。这套表刻意做得宽一些：
// 大模型能理解"巴西葡萄牙语"这类说法，比 ISO 码更不容易出错。
const LLM_LANGUAGES = {
  auto: '',
  zh: '简体中文', 'zh-cn': '简体中文', 'zh-hans': '简体中文',
  'zh-tw': '繁体中文', 'zh-hant': '繁体中文',
  en: '英语', ja: '日语', ko: '韩语',
  fr: '法语', de: '德语', es: '西班牙语', pt: '葡萄牙语',
  ru: '俄语', it: '意大利语', ar: '阿拉伯语', th: '泰语', vi: '越南语',
  id: '印尼语', ms: '马来语', hi: '印地语', tr: '土耳其语', nl: '荷兰语',
  pl: '波兰语', uk: '乌克兰语', he: '希伯来语', fa: '波斯语', bn: '孟加拉语'
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
  NIUTRANS_LANGUAGES
}
