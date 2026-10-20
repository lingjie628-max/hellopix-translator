'use strict'

/**
 * 翻译通道适配层。
 *
 * 契约（core-service 调用）：
 *   translate(engine, payload, options) -> { ok, text, model?, retries?, usage?, skipped?, msg? }
 *   - engine: package_engines 查出来的通道行（含 id / name / enabled / wired）
 *   - payload: { text, from, to, detected }
 *   - options: { fetch, timeoutMs }（allowPublicNetwork 已随公共端点实现一并移除，
 *     该标志在生产环境本就被 config.js 列为禁止项，进程会拒绝启动）
 *
 * ⚠️ `model` / `retries` / `usage` 是**记账字段，不是可选项**。
 * `core-service.recordUpstreamUsage()` 靠它们写内部成本台账：拿不到 usage
 * 就只能按字符估、且成本标记为"未核实"。2026-10-11 的 DeepSeek 成本记 0
 * 事故就是这么来的 —— 适配器返回了 `{ ok: true, text }`，把厂商给的用量丢了。
 * **新增/修改适配器时，成功分支必须带上这三个字段**（有对应实现可参考
 * `translation-adapters.js` 的 `openAiCompatible`）。
 *
 * 三条硬规则：
 *   1. 凭据未配置一律 ok:false，绝不返回演示译文、绝不产生计费（fail-closed）。
 *   2. 只有 engine.wired=true 的通道才会被 core-service 送到这里；除此之外
 *      本层仍然自带 stub 兜底，双保险。
 *   3. 任何异常（超时、HTTP 错误、厂商报错码、返回体解析失败）都转成 ok:false，
 *      由 core-service 以 502 返回并退还预扣字符。
 */

const crypto = require('node:crypto')

const {
  gptAdapter, grokAdapter, deeplAdapter, papagoAdapter, niutransAdapter,
  // DeepSeek 是独立实现（见下方 providers 里的说明），但用量字段的归一
  // 必须与通用实现同一个口径，否则两本账对不上。
  normalizeUsage
} = require('./translation-adapters')
const {
  claudeAdapter, qwenMtAdapter,
  doubaoAdapter, kimiAdapter, glmAdapter, mistralAdapter, minimaxAdapter
} = require('./translation-adapters-llm')
const { awsAdapter } = require('./translation-adapters-aws')

const DEFAULT_TIMEOUT_MS = 8000

function detectLang(text) {
  const value = String(text || '')
  if (/[\u4e00-\u9fff]/.test(value)) return 'zh'
  if (/[\u3040-\u30ff]/.test(value)) return 'ja'
  if (/[\uac00-\ud7af]/.test(value)) return 'ko'
  return 'en'
}

function countBillableChars(text) {
  let count = 0
  for (const char of String(text || '')) {
    count += /[\u4e00-\u9fff]/.test(char) ? 2 : 1
  }
  return count
}

function envValue(name) {
  return String(process.env[name] || '').trim()
}

function notWired(name) {
  return function stub() {
    return { ok: false, msg: `${name}尚未接入` }
  }
}


// --- 谷歌翻译（Cloud Translation 官方 API）-----------------------------------
// 走官方付费端点，不再使用 translate.googleapis.com 公共接口。
// 官方端点有 SLA、按量计费；这也是最初拆出的"谷歌稳定"本该有的样子
// （拆分期间那条通道一直是个空壳，从未接线，所以这里等于把它补实）。
//
// 两个易踩的点（依据官方文档 2026-09）：
//   1. v2 支持 API Key（?key=），v3 需要 OAuth 服务账号。这里用 v2 + key，
//      与后台"API Key"字段对得上，管理员不必去弄服务账号 JSON。
//   2. 请求体的 format **默认是 html** —— 不显式传 'text' 的话，
//      译文里的引号、& 会被转义成 &quot; / &amp; 直接显示给商户。

const GOOGLE_TRANSLATE_URL = 'https://translation.googleapis.com/language/translate/v2'

const GOOGLE_LANGUAGES = {
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-tw': 'zh-TW',
  'zh-hk': 'zh-TW',
  en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', es: 'es', pt: 'pt',
  // 葡萄牙语分巴西/欧洲两种，谷歌原生支持这两种代码。
  'pt-br': 'pt-BR', 'pt-pt': 'pt-PT',
  ru: 'ru', ar: 'ar', th: 'th', vi: 'vi', id: 'id', hi: 'hi', it: 'it',
  tr: 'tr', ms: 'ms', nl: 'nl', pl: 'pl', sv: 'sv', da: 'da', fi: 'fi',
  no: 'no', cs: 'cs', el: 'el', he: 'iw', uk: 'uk', fa: 'fa', bn: 'bn',
  fil: 'tl', tl: 'tl'
}

/** 语言码 → 谷歌语言码；未收录的原样透传（谷歌接受 BCP-47）。 */
function googleLanguage(code, fallback) {
  const key = String(code || '').trim().toLowerCase()
  if (!key) return fallback ? googleLanguage(fallback, '') : ''
  return GOOGLE_LANGUAGES[key] || key
}

function googleCredentials(credentials) {
  const fromAdmin = credentials || {}
  const apiKey = String(fromAdmin.apiKey || '').trim() || envValue('PIX_GOOGLE_API_KEY')
  return { apiKey }
}

async function googleTranslate(engine, payload, options) {
  const { apiKey } = googleCredentials(options.credentials)
  if (!apiKey) {
    return { ok: false, msg: '谷歌翻译凭据未配置（管理后台填写 API Key，或设置 PIX_GOOGLE_API_KEY）' }
  }
  const text = String(payload.text || '')
  if (!text) return { ok: false, msg: '请输入要翻译的文本' }

  const target = googleLanguage(payload.to, 'zh')
  if (!target) return { ok: false, msg: '谷歌翻译缺少目标语言' }
  const source = googleLanguage(payload.from, '')
  const body = { q: [text], target, format: 'text' }
  // 'auto' 是本站的内部约定，谷歌靠"不传 source"来表达自动识别
  if (source && source !== 'auto') body.source = source

  let response
  try {
    response = await options.fetch(`${GOOGLE_TRANSLATE_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs)
    })
  } catch (error) {
    const reason = (error && error.name === 'TimeoutError')
      ? '请求超时'
      : ((error && error.message) || error)
    return { ok: false, msg: `谷歌翻译请求失败：${reason}` }
  }

  if (!response.ok) {
    // 厂商错误体里有可读原因（key 无效、未开通计费、配额用尽），尽力透出
    let detail = ''
    try {
      const body = await response.json()
      detail = String((body && body.error && body.error.message) || '').trim()
    } catch (error) {}
    return { ok: false, msg: `谷歌翻译返回 HTTP ${response.status}${detail ? '：' + detail : ''}` }
  }

  let data
  try {
    data = await response.json()
  } catch (error) {
    return { ok: false, msg: '谷歌翻译返回体无法解析为 JSON' }
  }

  const list = data && data.data && Array.isArray(data.data.translations) ? data.data.translations : []
  const translated = String((list[0] && list[0].translatedText) || '').trim()
  if (!translated) return { ok: false, msg: '谷歌翻译未返回译文' }
  return { ok: true, text: translated }
}

// --- Gemini 翻译（Google 的对话模型）------------------------------------------
// 与 DeepSeek 同属"用 LLM 按指令翻译"，但结构与约定差别很大（依据官方文档 2026-09）：
//   1. 消息结构是 contents[].parts[].text，角色是 user / model，
//      不是 messages[].content、也没有 assistant；
//   2. system 指令是**顶层 systemInstruction 字段**，不占 contents 数组；
//   3. 鉴权用 ?key= 查询参数，不是 Authorization 头；
//   4. **2.5 系列默认开启思考**，翻译场景必须用 thinkingBudget: 0 关掉：
//      开着延迟显著变长、token 翻倍，而且官方明确思考模式下 temperature 不生效 ——
//      翻译要的稳定性（temperature=0）就没了；
//   5. 一旦有思考，返回的 parts 里会混入 thought:true 的推理片段，
//      提取译文必须过滤掉，否则会把模型的推理过程当译文发给商户。

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models'
const GEMINI_MODEL = 'gemini-2.5-flash'

const GEMINI_LANGUAGES = {
  auto: '',
  zh: '简体中文',
  'zh-cn': '简体中文',
  'zh-tw': '繁体中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  es: '西班牙语',
  pt: '葡萄牙语',
  // 葡萄牙语分巴西/欧洲两种；LLM 走提示词，直接把目标语写清楚最稳。
  'pt-br': '巴西葡萄牙语', 'pt-pt': '欧洲葡萄牙语',
  ru: '俄语',
  ar: '阿拉伯语',
  th: '泰语',
  vi: '越南语',
  id: '印尼语',
  hi: '印地语',
  it: '意大利语',
  tr: '土耳其语',
  ms: '马来语',
  fil: '菲律宾语'
}

/**
 * 语言码 → 提示词里的语言名。查不到就原样回退（Gemini / DeepSeek 都是 LLM，
 * 认语言码，退回原文比丢掉更安全）。
 *
 * ⚠️ 这个函数**必须写成不递归的**。表里 `auto: ''` 是「自动识别」的内部约定，
 * 值就是空串；而原先"第一段为空就递归查第二段"的写法，在两段都为空时会
 * **无限自递归**：
 *
 *     languageName(table, '', '')        // 第一段空 → 查第二段
 *   → languageName(table, '', '')        // 第二段也空 → RangeError
 *
 * 这在真实链路上是能触发的：客户端选「自动识别语种」（`from='auto'`，
 * 而 `auto` 恰好映射到空串）且 `detectLang()` 没识别出语种（`detected=''`）时，
 * 两段都是空 —— 翻译直接 500，栈里只有本函数，看不出真正原因。
 * 2026-10-11 由 `test/adapter-usage-contract.test.js` 暴露。
 */
function languageName(table, code, fallback) {
  // 顺序尝试：主语言码 → 回退语言码。只两层，且**不递归**，总有终点。
  for (const candidate of [code, fallback]) {
    const key = String(candidate || '').trim().toLowerCase()
    if (!key) continue
    if (key in table) return table[key]
    return String(candidate)
  }
  return ''
}

/** 语言码 → 提示词里的语言名；未收录的原样回退（Gemini 是 LLM，认语言码）。 */
function geminiLanguage(code, fallback) {
  return languageName(GEMINI_LANGUAGES, code, fallback)
}

/**
 * 组装端点。后台那个"接口地址"字段很容易只填到域名，
 * 而实际要打的是 /v1beta/models/{model}:generateContent ——
 * 与 DeepSeek 那边同样的坑，这里一并处理。
 */
function geminiEndpoint(raw, model) {
  const suffix = `${encodeURIComponent(model)}:generateContent`
  const value = String(raw || '').trim()
  if (!value) return `${GEMINI_URL}/${suffix}`
  if (/:generateContent\/?$/.test(value)) return value
  try {
    const url = new URL(value)
    if (url.pathname === '/' || url.pathname === '') {
      url.pathname = `/v1beta/models/${suffix}`
      return url.toString()
    }
  } catch (error) {
    return value
  }
  return `${value.replace(/\/+$/, '')}/${suffix}`
}

function geminiCredentials(engine, credentials) {
  const fromAdmin = credentials || {}
  const apiKey = String(fromAdmin.apiKey || '').trim() || envValue('PIX_GEMINI_API_KEY')
  // 模型：后台配置优先，其次迁移种下的默认值，最后兜底常量
  const model = String(fromAdmin.model || (engine && engine.model) || '').trim() || GEMINI_MODEL
  const endpoint = geminiEndpoint((engine && engine.endpoint) || '', model)
  return { apiKey, model, endpoint }
}

async function geminiTranslate(engine, payload, options) {
  const { apiKey, model, endpoint } = geminiCredentials(engine, options.credentials)
  if (!apiKey) {
    return { ok: false, msg: 'Gemini 凭据未配置（管理后台填写 API Key，或设置 PIX_GEMINI_API_KEY）' }
  }
  const text = String(payload.text || '')
  if (!text) return { ok: false, msg: '请输入要翻译的文本' }

  const to = geminiLanguage(payload.to, 'zh')
  const from = geminiLanguage(payload.from, 'auto')
  if (!to) return { ok: false, msg: 'Gemini 翻译缺少目标语言' }
  const instruction = from && from !== 'auto'
    ? `你是专业翻译引擎。把用户给出的文本从${from}翻译成${to}。只输出译文本身，不要解释、不要加引号、不要保留原文。`
    : `你是专业翻译引擎。把用户给出的文本翻译成${to}。只输出译文本身，不要解释、不要加引号、不要保留原文。`

  let response
  try {
    response = await options.fetch(`${endpoint}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instruction }] },
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: {
          temperature: 0,                        // 翻译要稳定，不要发挥
          thinkingConfig: { thinkingBudget: 0 }  // 关思考：否则变慢、翻倍，且 temperature 失效
        }
      }),
      signal: AbortSignal.timeout(options.timeoutMs)
    })
  } catch (error) {
    const reason = (error && error.name === 'TimeoutError')
      ? '请求超时'
      : ((error && error.message) || error)
    return { ok: false, msg: `Gemini 请求失败：${reason}` }
  }

  if (!response.ok) {
    // 厂商错误体里有可读原因（key 无效、配额用尽、模型不存在），尽力透出。
    // 这里的空 catch 是**有意**的：错误体不保证是 JSON，解析失败就只报状态码，
    // 不影响"失败即 ok:false"的契约，绝不能因此抛出或返回译文。
    let detail = ''
    try {
      const body = await response.json()
      detail = String((body && body.error && body.error.message) || '').trim()
    } catch (error) {}
    return { ok: false, msg: `Gemini 返回 HTTP ${response.status}${detail ? '：' + detail : ''}` }
  }

  let data
  try {
    data = await response.json()
  } catch (error) {
    return { ok: false, msg: 'Gemini 返回体无法解析为 JSON' }
  }

  // 内容被安全策略拦下时没有 candidates，只有 promptFeedback，要给可读原因
  const blocked = data && data.promptFeedback && data.promptFeedback.blockReason
  if (blocked) return { ok: false, msg: `Gemini 拒绝了该内容（${blocked}）` }

  const candidate = data && Array.isArray(data.candidates) ? data.candidates[0] : null
  const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
    ? candidate.content.parts
    : []
  const translated = parts
    .filter(part => part && !part.thought)   // 丢掉推理片段，只取正文
    .map(part => String(part.text || ''))
    .join('')
    .trim()
  if (!translated) return { ok: false, msg: 'Gemini 未返回译文' }
  // 与 DeepSeek 同一个契约：model / retries / usage 都要回传，否则成本台账记 0。
  // 本通道已下架（engines.enabled=false），但实现是保留的、可重新上架 ——
  // 不留 usage 的话，重新上架当天就会复发"成本全 0"。
  return {
    ok: true,
    text: translated,
    model,
    retries: 0,
    usage: normalizeUsage(data && data.usageMetadata)
  }
}


// --- DeepSeek 翻译（OpenAI 兼容的对话接口）-----------------------------------
// DeepSeek 没有翻译专用端点，走 /chat/completions 让模型按指令翻译。
// 与有道/谷歌那类"专用翻译 API"的区别：
//   - 返回体是对话补全结构，译文在 choices[0].message.content；
//   - 需要同时给 model（默认 deepseek-flash）与 API Key；
//   - 语言控制靠 system 提示词，而不是厂商的语言码参数。
// 仍未配置凭据时一律 ok:false，不返回任何演示译文（沿用本文件第 12 行的硬规则）。
//
// 两个容易踩的坑（依据官方文档 2026-09）：
//   1. 模型名已换代：有效名是 `deepseek-flash` / `deepseek-v4-pro`。
//      旧的 deepseek-chat 不再是有效名，配错会直接报"模型不存在"。
//   2. 思考模式**默认开启**且 effort=high。翻译场景必须显式关闭，否则延迟显著
//      变长、token 翻倍；而且官方明确思考模式下 temperature 不生效 ——
//      翻译要的稳定性（temperature=0）就没了。

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const DEEPSEEK_MODEL = 'deepseek-flash'

const DEEPSEEK_LANGUAGES = {
  auto: '',
  zh: '简体中文',
  'zh-cn': '简体中文',
  'zh-tw': '繁体中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  es: '西班牙语',
  pt: '葡萄牙语',
  // 葡萄牙语分巴西/欧洲两种；LLM 走提示词，直接把目标语写清楚最稳。
  'pt-br': '巴西葡萄牙语', 'pt-pt': '欧洲葡萄牙语',
  ru: '俄语',
  ar: '阿拉伯语',
  th: '泰语',
  vi: '越南语',
  id: '印尼语',
  hi: '印地语',
  it: '意大利语',
  tr: '土耳其语',
  ms: '马来语',
  fil: '菲律宾语'
}

/** 语言码 → 提示词里的语言名；未收录的原样回退（DeepSeek 是 LLM，认语言码）。 */
function deepseekLanguage(code, fallback) {
  return languageName(DEEPSEEK_LANGUAGES, code, fallback)
}

/**
 * 补全对话端点：后台那个"接口地址"字段很容易只填到域名
 * （例如 https://api.deepseek.com），而实际要打的是 /chat/completions ——
 * 实测只填域名会返回 404，且错误体不是 JSON、看不出原因。
 * 这里对"裸域名或根路径"自动补上路径；已经写了完整路径或自定义网关的原样保留。
 */
function deepseekEndpoint(raw) {
  const value = String(raw || '').trim() || DEEPSEEK_URL
  if (/\/chat\/completions\/?$/.test(value)) return value
  try {
    const url = new URL(value)
    if (url.pathname === '/' || url.pathname === '') {
      url.pathname = '/chat/completions'
      return url.toString()
    }
  } catch (error) {
    return value
  }
  return value
}

function deepseekCredentials(engine, credentials) {
  const fromAdmin = credentials || {}
  const apiKey = String(fromAdmin.apiKey || '').trim() || envValue('PIX_DEEPSEEK_API_KEY')
  // 模型：后台配置优先，其次迁移种下的默认值，最后兜底常量
  const model = String(fromAdmin.model || (engine && engine.model) || '').trim() || DEEPSEEK_MODEL
  // 后台可覆盖接口地址（便于自建网关/代理），默认官方端点；裸域名自动补路径
  const endpoint = deepseekEndpoint((engine && engine.endpoint) || '')
  return { apiKey, model, endpoint }
}

function deepseekMessages(payload) {
  const to = deepseekLanguage(payload.to, 'zh')
  if (!to) return { ok: false, msg: 'DeepSeek 翻译缺少目标语言' }
  const from = deepseekLanguage(payload.from, 'auto') || deepseekLanguage(payload.detected, '')
  const source = from ? `源语言是${from}。` : '源语言未指定，请自行判断。'

  const system = [
    '你是专业翻译引擎。',
    `把用户给出的文本翻译成${to}。${source}`,
    '要求：',
    '1. 只输出译文本身，不要解释、不要加引号、不要重复原文；',
    '2. 保留原文的换行、标点风格与占位符（如 {name}、%s、\\n）；',
    '3. 专有名词、代码、链接、@用户名 原样保留；',
    '4. 文本已是目标语言时原样返回。'
  ].join('\n')

  return {
    ok: true,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: String(payload.text || '') }
    ]
  }
}

async function deepseekTranslate(engine, payload, options) {
  const { apiKey, model, endpoint } = deepseekCredentials(engine, options.credentials)
  if (!apiKey) {
    return { ok: false, msg: 'DeepSeek 凭据未配置（管理后台填写 API Key，或设置 PIX_DEEPSEEK_API_KEY）' }
  }
  const text = String(payload.text || '')
  if (!text) return { ok: false, msg: '请输入要翻译的文本' }

  const built = deepseekMessages(payload)
  if (!built.ok) return built

  let response
  try {
    response = await options.fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(Object.assign({
        model,
        messages: built.messages,
        // 关闭思考模式：翻译不需要思维链，开着会显著变慢并让 token 翻倍，
        // 且会让下面的 temperature 失效（官方：思考模式不支持该参数）
        thinking: { type: 'disabled' },
        temperature: 0,        // 翻译要稳定，不要发挥
        stream: false
      },
      // 通道表里的 extraBody 可以覆盖上面任何一条（比如想试 thinking:auto）。
      // 放在默认值之后合并 —— 后台改完立刻生效，不必发版。
      (engine.callParams && engine.callParams.extraBody) || {}
      )),
      signal: AbortSignal.timeout(options.timeoutMs)
    })
  } catch (error) {
    const reason = (error && error.name === 'TimeoutError')
      ? '请求超时'
      : ((error && error.message) || error)
    return { ok: false, msg: `DeepSeek 请求失败：${reason}` }
  }

  if (!response.ok) {
    // 厂商的错误体里通常有可读原因（欠费、key 无效、模型不存在），尽力透出
    let detail = ''
    try {
      const body = await response.json()
      detail = String((body && body.error && body.error.message) || '').trim()
    } catch (error) {}
    return { ok: false, msg: `DeepSeek 返回 HTTP ${response.status}${detail ? '：' + detail : ''}` }
  }

  let data
  try {
    data = await response.json()
  } catch (error) {
    return { ok: false, msg: 'DeepSeek 返回体无法解析为 JSON' }
  }

  const choice = Array.isArray(data && data.choices) ? data.choices[0] : null
  const translated = String(
    (choice && choice.message && choice.message.content) || ''
  ).trim()
  if (!translated) {
    return { ok: false, msg: `DeepSeek 未返回译文${data && data.error ? '：' + data.error.message : ''}` }
  }
  /**
   * `usage` / `model` / `retries` **必须回传**，它们不是给用户看的装饰。
   *
   * 这是 2026-10-11 在生产上定到的根因：这里曾经返回
   * `{ ok: true, text }`，把厂商的用量整个丢掉了。DeepSeek 走的是
   * OpenAI 兼容的 `/chat/completions`，**它在响应里本来就有 `usage`**
   * （`prompt_tokens` / `completion_tokens` / `total_tokens`）。
   * 不是厂商不给，是适配层扔了 —— 于是 `recordUpstreamUsage` 拿不到用量，
   * 48 次真实调用在成本台账上全记成 0，`cost_verified` 还显示 true。
   *
   * 契约见 `translation-adapters.js` 的 `openAiCompatible`：两条路径
   * （通用 / DeepSeek 专用）的返回体在**记账字段上必须一致**，
   * 否则成本报表会按"通道"分叉，而这种分叉没有任何人会发现。
   */
  return {
    ok: true,
    text: translated,
    model,
    retries: 0,
    usage: normalizeUsage(data && data.usage)
  }
}

// --- 通道注册表 --------------------------------------------------------------
// 表里的每个通道都必须是**真实现**：configured() 认凭据、translate() 真发请求。
// 「登记了但调不通」正是百度那类占位通道的问题，本项目不再接受这种通道。

const providers = {
  // ---- 2026-09-25 换线后的正式通道 -------------------------------------------
  //
  // 全部 11 个通道按协议分三类（详见 translation-adapters-llm.js 的说明）：
  //   OpenAI 兼容：gpt / grok / deepseek / qwen(专用翻译模型，实现单列)
  //                + doubao / kimi / glm / mistral / minimax
  //   Anthropic Messages：claude
  //   官方翻译 API：google
  //
  // deepseek 单独保留在这份文件里（而不是并进 openAiCompatible）是**有意的**：
  // 它已经在生产上跑着、且需要 `thinking:{type:'disabled'}` 这类厂商专属处理，
  // 把它挪到通用实现属于"为了整齐去改一个正在工作的通道"。
  // 整齐可以晚点要，生产翻译不能断。
  google: {
    name: '谷歌翻译',
    translate: googleTranslate,
    configured: (credentials) => Boolean(
      String(((credentials || {}).apiKey) || '').trim() || envValue('PIX_GOOGLE_API_KEY')
    )
  },
  deepseek: {
    name: 'DeepSeek 翻译',
    translate: deepseekTranslate,
    configured: (credentials) => Boolean(
      String(((credentials || {}).apiKey) || '').trim() || envValue('PIX_DEEPSEEK_API_KEY')
    )
  },
  gpt: gptAdapter,
  grok: grokAdapter,
  qwen: qwenMtAdapter,
  claude: claudeAdapter,
  doubao: doubaoAdapter,
  kimi: kimiAdapter,
  glm: glmAdapter,
  mistral: mistralAdapter,
  minimax: minimaxAdapter,

  // ---- 已下架但保留实现 -------------------------------------------------------
  //
  // 下面这些通道在 2026-09-25 从**产品线**上撤掉了（migration 031 把他们软下架：
  // `engines.retired_at` 置非空 + `enabled=false`，行本身和历史引用都留着），
  // 原因见该迁移的文件头注释：都是专用翻译 API，
  // 要么拿不到密钥、要么需要企业账号，接入成本高而实际一个都没接通。
  //
  // 但**实现保留**，不是舍不得删：
  //   1. 它们全部是能用的代码（deepl/papago/niutrans 各有单测覆盖）；
  //   2. 重新上架只需要往 engines / package_engines 各 INSERT 一行，
  //      不必重写一遍适配器；
  //   3. 一旦删掉实现，"迁移 002/005/012 种过的通道在适配层没有对应实现"
  //      这条测试就只能一起放宽 —— 那是在拆自己的护栏。
  //
  // 它们在 engines 表里仍然有行（retired_at 非空），所以**对商户不可见、套餐里也选不到**
  // （商户侧一律按 retired_at IS NULL 过滤），但在管理后台仍能查到、也能重新上架：
  // 把 retired_at 置回 NULL 并填凭据即可，适配器不用重写。
  deepl: deeplAdapter,
  papago: papagoAdapter,
  niutrans: niutransAdapter,
  aws: awsAdapter,
  gemini: {
    name: 'Gemini 翻译',
    translate: geminiTranslate,
    configured: (credentials) => Boolean(
      String(((credentials || {}).apiKey) || '').trim() || envValue('PIX_GEMINI_API_KEY')
    )
  }
}

/** 供后台/运维查看哪些通道已具备凭据（不代表计费侧已放开）。
 *  credentialsByEngine: { [engineId]: { apiKey, secret } }，来自管理后台配置的密钥。 */
function channelStatus(credentialsByEngine) {
  const byEngine = credentialsByEngine || {}
  return Object.keys(providers).map(id => ({
    id,
    name: providers[id].name,
    credentialReady: providers[id].configured(byEngine[id])
  }))
}

async function translate(engine, payload, options) {
  const id = engine && engine.id
  const provider = providers[id]
  if (!provider) return { ok: false, msg: '通道不存在' }
  if (!engine.enabled) return { ok: false, msg: `${engine.name || id} 已关闭` }

  // 通道里配了超时就用它（适配器内部还会再夹到 [1s, 30s]）。
  // 放在这一层是为了让**没走统一限额**的老适配器（google/deepseek/aws/gemini）
  // 也受同一个超时约束 —— 它们各自读 options.timeoutMs。
  const configuredTimeout = Number((engine.callParams || {}).timeoutMs)
  const settings = Object.assign({
    allowPublicNetwork: false,
    fetch: globalThis.fetch,
    timeoutMs: Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : DEFAULT_TIMEOUT_MS
  }, options || {})
  if (typeof settings.fetch !== 'function') {
    return { ok: false, msg: '运行环境缺少 fetch 实现' }
  }

  let result
  try {
    result = await provider.translate(engine, payload || {}, settings)
  } catch (error) {
    return { ok: false, msg: `${provider.name}调用异常：${(error && error.message) || error}` }
  }
  if (result && result.ok) return result
  // 失败时**保留适配层报上来的附加信息**（model / retries / usage），不要只留一句 msg。
  //
  // 为什么：排除故障时第一个要问的就是"这次到底调的哪个模型、重试了几次"。
  // 只回一句 msg 的话，排障只能靠翻厂商后台；而且 core-service 的
  // 上游台账（translation_usage）也拿不到 model。
  // `ok` 显式置 false，保证调用方仍然按失败处理。
  return Object.assign({}, result, {
    ok: false,
    msg: (result && result.msg) || `${provider.name}暂不可用`
  })
}

module.exports = {
  detectLang,
  countBillableChars,
  translate,
  providers,
  channelStatus
}
