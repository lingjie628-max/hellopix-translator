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

function youdaoCredentials() {
  return {
    appKey: envValue('PIX_YOUDAO_APP_KEY'),
    appSecret: envValue('PIX_YOUDAO_APP_SECRET')
  }
}

async function youdaoTranslate(engine, payload, options) {
  const { appKey, appSecret } = youdaoCredentials()
  if (!appKey || !appSecret) {
    return { ok: false, msg: '有道翻译凭据未配置（PIX_YOUDAO_APP_KEY / PIX_YOUDAO_APP_SECRET）' }
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

// --- 通道注册表 --------------------------------------------------------------
// 未接入的通道保留 stub：即使有人把 wired 误置为 true，也不会拿到任何"演示译文"。

const providers = {
  youdao: {
    name: '有道翻译',
    translate: youdaoTranslate,
    configured: () => {
      const { appKey, appSecret } = youdaoCredentials()
      return Boolean(appKey && appSecret)
    }
  },
  papago: { name: 'Papago 翻译', translate: notWired('Papago 翻译'), configured: () => false },
  baidu: { name: '百度翻译', translate: notWired('百度翻译'), configured: () => false },
  niutrans: { name: '小牛翻译', translate: notWired('小牛翻译'), configured: () => false },
  google: { name: '谷歌翻译', translate: notWired('谷歌翻译'), configured: () => false },
  tencent: { name: '腾讯翻译', translate: notWired('腾讯翻译'), configured: () => false },
  deepl: { name: 'DeepL 翻译', translate: notWired('DeepL 翻译'), configured: () => false },
  aws: { name: '亚马逊 AWS 翻译', translate: notWired('亚马逊 AWS 翻译'), configured: () => false },
  gpt: { name: 'GPT 翻译', translate: notWired('GPT 翻译'), configured: () => false },
  grok: { name: 'Grok 翻译', translate: notWired('Grok 翻译'), configured: () => false }
}

/** 供后台/运维查看哪些通道已具备凭据（不代表计费侧已放开）。 */
function channelStatus() {
  return Object.keys(providers).map(id => ({
    id,
    name: providers[id].name,
    credentialReady: providers[id].configured()
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
