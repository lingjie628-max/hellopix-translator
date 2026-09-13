'use strict'

/**
 * 翻译通道适配层。
 *
 * 契约（core-service 调用）：translate(engine, payload, options) -> { ok, text, skipped?, msg? }
 *   - engine: package_engines 查出来的通道行（含 id / name / enabled / wired）
 *   - payload: { text, from, to, detected }
 *   - options: { allowPublicNetwork, fetch, timeoutMs }
 *
 * 三条硬规则：
 *   1. 凭据未配置一律 ok:false，绝不返回演示译文、绝不产生计费（fail-closed）。
 *   2. 只有 engine.wired=true 的通道才会被 core-service 送到这里；除此之外
 *      本层仍然自带 stub 兜底，双保险。
 *   3. 任何异常（超时、HTTP 错误、厂商报错码、返回体解析失败）都转成 ok:false，
 *      由 core-service 以 502 返回并退还预扣字符。
 */

const crypto = require('node:crypto')

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

// --- 有道翻译（v3 签名）-----------------------------------------------------
// sign = sha256(appKey + truncate(q) + salt + curtime + appSecret)
// truncate(q): 长度 <= 20 取原文，否则 前10 + 长度 + 后10

const YOUDAO_URL = 'https://openapi.youdao.com/api'

const YOUDAO_LANGUAGES = {
  zh: 'zh-CHS',
  'zh-cn': 'zh-CHS',
  'zh-tw': 'zh-CHT',
  auto: 'auto'
}

// 只列会真实影响排查的报错码，其余按 code 原样回显
const YOUDAO_ERRORS = {
  101: '有道翻译：缺少必填参数',
  102: '有道翻译：不支持的语言类型',
  103: '有道翻译：翻译文本过长',
  108: '有道翻译：应用 ID 无效（检查 PIX_YOUDAO_APP_KEY）',
  110: '有道翻译：实例无效或未绑定服务',
  111: '有道翻译：开发者账号无效',
  112: '有道翻译：请求服务无效',
  113: '有道翻译：翻译文本为空',
  202: '有道翻译：签名校验失败（检查 PIX_YOUDAO_APP_SECRET）',
  203: '有道翻译：访问 IP 不在白名单',
  401: '有道翻译：账户余额不足',
  411: '有道翻译：访问频率受限',
  413: '有道翻译：文本大小超过限制'
}

function youdaoSign(appKey, appSecret, text, salt, curtime) {
  const input = text.length <= 20
    ? text
    : `${text.slice(0, 10)}${text.length}${text.slice(-10)}`
  return crypto
    .createHash('sha256')
    .update(appKey + input + salt + curtime + appSecret)
    .digest('hex')
}

function youdaoLanguage(code, fallback) {
  const value = String(code || '').toLowerCase()
  if (!value) return fallback
  return YOUDAO_LANGUAGES[value] || value
}

/**
 * 取厂商凭据：数据库里配置的（管理后台填写，落盘加密）优先，
 * 环境变量兜底。两者都没有 -> 空凭据 -> 上层 fail-closed。
 */
function youdaoCredentials(credentials) {
  const fromAdmin = credentials || {}
  const apiKey = String(fromAdmin.apiKey || '').trim() || envValue('PIX_YOUDAO_APP_KEY')
  const appSecret = String(fromAdmin.secret || '').trim() || envValue('PIX_YOUDAO_APP_SECRET')
  return { appKey: apiKey, appSecret }
}

async function youdaoTranslate(engine, payload, options) {
  const { appKey, appSecret } = youdaoCredentials(options.credentials)
  if (!appKey || !appSecret) {
    return { ok: false, msg: '有道翻译凭据未配置（管理后台填写，或设置 PIX_YOUDAO_APP_KEY / PIX_YOUDAO_APP_SECRET）' }
  }
  const text = String(payload.text || '')
  if (!text) return { ok: false, msg: '请输入要翻译的文本' }

  const salt = crypto.randomUUID()
  const curtime = String(Math.floor(Date.now() / 1000))
  const form = new URLSearchParams({
    q: text,
    from: youdaoLanguage(payload.from, 'auto'),
    to: youdaoLanguage(payload.to, 'zh-CHS'),
    appKey,
    salt,
    sign: youdaoSign(appKey, appSecret, text, salt, curtime),
    signType: 'v3',
    curtime
  })

  let response
  try {
    response = await options.fetch(YOUDAO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(options.timeoutMs)
    })
  } catch (error) {
    const reason = (error && error.name === 'TimeoutError')
      ? '请求超时'
      : ((error && error.message) || error)
    return { ok: false, msg: `有道翻译请求失败：${reason}` }
  }
  if (!response.ok) {
    return { ok: false, msg: `有道翻译返回 HTTP ${response.status}` }
  }

  let data
  try {
    data = await response.json()
  } catch (error) {
    return { ok: false, msg: '有道翻译返回体无法解析为 JSON' }
  }

  const code = String((data && data.errorCode) || '')
  if (code && code !== '0') {
    return { ok: false, msg: YOUDAO_ERRORS[code] || `有道翻译错误码 ${code}` }
  }
  const translated = Array.isArray(data && data.translation)
    ? data.translation.join('').trim()
    : ''
  if (!translated) return { ok: false, msg: '有道翻译未返回译文' }
  return { ok: true, text: translated }
}

// --- 谷歌极速（公共端点，默认关闭）-------------------------------------------
// translate.googleapis.com/translate_a/single?client=gtx 是公开的免费端点：
// 无需凭据、延迟低，但没有 SLA、可能被限流或按来源封禁，且属于非官方接口。
// 因此它必须由运行时的 PIX_ALLOW_PUBLIC_TRANSLATION 显式开启（默认关），
// 未开启时一律 ok:false —— 与"公共翻译网络回退默认关闭"的既有安全约定一致。

const GTX_URL = 'https://translate.googleapis.com/translate_a/single'

const GTX_LANGUAGES = {
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-tw': 'zh-TW',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  es: 'es',
  fr: 'fr',
  pt: 'pt',
  id: 'id',
  vi: 'vi',
  th: 'th'
}

function publicNetworkAllowed() {
  return /^(1|true|yes)$/i.test(envValue('PIX_ALLOW_PUBLIC_TRANSLATION'))
}

function gtxLanguage(code, fallback) {
  const value = String(code || '').toLowerCase()
  if (!value) return fallback
  if (value === 'auto') return 'auto'
  return GTX_LANGUAGES[value] || value
}

async function googleFastTranslate(engine, payload, options) {
  if (!options.allowPublicNetwork) {
    return { ok: false, msg: '谷歌极速未启用（需显式开启 PIX_ALLOW_PUBLIC_TRANSLATION）' }
  }
  const text = String(payload.text || '')
  if (!text) return { ok: false, msg: '请输入要翻译的文本' }

  const query = new URLSearchParams({
    client: 'gtx',
    sl: gtxLanguage(payload.from, 'auto'),
    tl: gtxLanguage(payload.to, 'zh-CN'),
    dt: 't',
    q: text.slice(0, 4500)
  })

  let response
  try {
    response = await options.fetch(`${GTX_URL}?${query.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs)
    })
  } catch (error) {
    const reason = (error && error.name === 'TimeoutError')
      ? '请求超时'
      : ((error && error.message) || error)
    return { ok: false, msg: `谷歌极速请求失败：${reason}` }
  }
  if (!response.ok) return { ok: false, msg: `谷歌极速返回 HTTP ${response.status}` }

  let data
  try {
    data = await response.json()
  } catch (error) {
    return { ok: false, msg: '谷歌极速返回体无法解析为 JSON' }
  }
  // 形如 [[["译文","原文",null,null,10]],null,"en",...]
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    return { ok: false, msg: '谷歌极速返回结构异常' }
  }
  const translated = data[0]
    .map(part => (Array.isArray(part) && part[0]) ? String(part[0]) : '')
    .join('')
    .trim()
  if (!translated) return { ok: false, msg: '谷歌极速未返回译文' }
  return { ok: true, text: translated }
}

// --- DeepSeek 翻译（OpenAI 兼容的对话接口）-----------------------------------
// DeepSeek 没有翻译专用端点，走 /chat/completions 让模型按指令翻译。
// 与有道/谷歌那类"专用翻译 API"的区别：
//   - 返回体是对话补全结构，译文在 choices[0].message.content；
//   - 需要同时给 model（默认 deepseek-chat）与 API Key；
//   - 语言控制靠 system 提示词，而不是厂商的语言码参数。
// 仍未配置凭据时一律 ok:false，不返回任何演示译文（沿用本文件第 12 行的硬规则）。

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const DEEPSEEK_MODEL = 'deepseek-chat'

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
  const key = String(code || '').trim().toLowerCase()
  if (!key) return deepseekLanguage(fallback, '')
  if (key in DEEPSEEK_LANGUAGES) return DEEPSEEK_LANGUAGES[key]
  return String(code)
}

function deepseekCredentials(engine, credentials) {
  const fromAdmin = credentials || {}
  const apiKey = String(fromAdmin.apiKey || '').trim() || envValue('PIX_DEEPSEEK_API_KEY')
  // 模型：后台配置优先，其次迁移种下的默认值，最后兜底常量
  const model = String(fromAdmin.model || (engine && engine.model) || '').trim() || DEEPSEEK_MODEL
  // 后台可覆盖接口地址（便于自建网关/代理），默认官方端点
  const endpoint = String((engine && engine.endpoint) || '').trim() || DEEPSEEK_URL
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
      body: JSON.stringify({
        model,
        messages: built.messages,
        temperature: 0,        // 翻译要稳定，不要发挥
        stream: false
      }),
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
  return { ok: true, text: translated }
}

// --- 通道注册表 --------------------------------------------------------------
// 未接入的通道保留 stub：即使有人把 wired 误置为 true，也不会拿到任何"演示译文"。

const providers = {
  youdao: {
    name: '有道翻译',
    translate: youdaoTranslate,
    configured: (credentials) => {
      const { appKey, appSecret } = youdaoCredentials(credentials)
      return Boolean(appKey && appSecret)
    }
  },
  papago: { name: 'Papago 翻译', translate: notWired('Papago 翻译'), configured: () => false },
  baidu: { name: '百度翻译', translate: notWired('百度翻译'), configured: () => false },
  niutrans: { name: '小牛翻译', translate: notWired('小牛翻译'), configured: () => false },
  google: { name: '谷歌稳定', translate: notWired('谷歌稳定'), configured: () => false },
  'google-fast': {
    name: '谷歌极速',
    translate: googleFastTranslate,
    // 无需凭据，"就绪"取决于是否显式允许公共翻译网络
    configured: () => publicNetworkAllowed()
  },
  tencent: { name: '腾讯翻译', translate: notWired('腾讯翻译'), configured: () => false },
  deepl: { name: 'DeepL 翻译', translate: notWired('DeepL 翻译'), configured: () => false },
  aws: { name: '亚马逊 AWS 翻译', translate: notWired('亚马逊 AWS 翻译'), configured: () => false },
  gpt: { name: 'GPT 翻译', translate: notWired('GPT 翻译'), configured: () => false },
  grok: { name: 'Grok 翻译', translate: notWired('Grok 翻译'), configured: () => false },
  deepseek: {
    name: 'DeepSeek 翻译',
    translate: deepseekTranslate,
    configured: (credentials) => Boolean(
      String(((credentials || {}).apiKey) || '').trim() || envValue('PIX_DEEPSEEK_API_KEY')
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

  const settings = Object.assign({
    allowPublicNetwork: false,
    fetch: globalThis.fetch,
    timeoutMs: DEFAULT_TIMEOUT_MS
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
  return { ok: false, msg: (result && result.msg) || `${provider.name}暂不可用` }
}

module.exports = {
  detectLang,
  countBillableChars,
  translate,
  providers,
  channelStatus
}
