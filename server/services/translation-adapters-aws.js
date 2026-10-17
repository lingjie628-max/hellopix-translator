/**
 * 亚马逊 AWS Translate 适配器。
 *
 * 单独成文件的原因：AWS 用 **SigV4** 签名，比其余几家（Bearer / 自定义头）
 * 复杂得多，混在一起会让主文件难读。而且它有一个**可以离线验证**的性质 ——
 * AWS 官方公布了签名密钥推导的测试向量，所以这个适配器的核心逻辑
 * 不需要真实 key 就能验证正确性（见 test/aws-sigv4.test.js）。
 *
 * 这一点很重要：其余适配器在拿到 key 之前无法验证，
 * 而签名算错的话现象是 403 SignatureDoesNotMatch，极难排查。
 * 能提前验证的部分必须先验证掉。
 */

const crypto = require('crypto')

function envValue(name) {
  const v = process.env[name]
  return typeof v === 'string' ? v.trim() : ''
}

function pick(credentials, key, envName) {
  const c = credentials || {}
  return String(c[key] || '').trim() || envValue(envName)
}

/** SHA256 十六进制小写 */
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex')
}

/** HMAC-SHA256，返回 Buffer（签名链要拿它当 key，不能转成 hex） */
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest()
}

/**
 * 推导 SigV4 签名密钥。
 *
 * 四轮 HMAC 链：日期 → 区域 → 服务 → 固定串 `aws4_request`。
 * AWS 官方测试向量（IAM, us-east-1, 2015-08-30）：
 *   secret = wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY
 *   → c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9
 */
function signingKey(secretKey, dateStamp, region, service) {
  const kDate = hmac('AWS4' + secretKey, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  return hmac(kService, 'aws4_request')
}

/** 20260916T120000Z 与 20260916 */
function amzDates(now) {
  const d = now || new Date()
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate: iso, dateStamp: iso.slice(0, 8) }
}

/**
 * 构造 SigV4 请求头。
 *
 * 拆成独立函数是为了能单独测 —— 日期固定时，同样的输入必须得到同样的签名。
 */
function signRequest({ method, host, path, payload, region, service, accessKey, secretKey, sessionToken, now }) {
  const { amzDate, dateStamp } = amzDates(now)
  const payloadHash = sha256Hex(payload)
  const contentType = 'application/x-amz-json-1.1'
  const target = 'AWSShakespeareService.TranslateText'

  // 1) 规范请求。头的顺序**必须按字典序**，且值要去掉首尾空格 ——
  //    这两条是 SigV4 最常见的踩坑点
  const headers = {
    'content-type': contentType,
    host,
    'x-amz-date': amzDate,
    'x-amz-target': target
  }
  if (sessionToken) headers['x-amz-security-token'] = sessionToken

  const sortedKeys = Object.keys(headers).sort()
  const canonicalHeaders = sortedKeys.map(k => `${k}:${String(headers[k]).trim()}\n`).join('')
  const signedHeaders = sortedKeys.join(';')
  const canonicalRequest = [
    method, path, '',              // 空查询串（AWS Translate 全走 body）
    canonicalHeaders, signedHeaders, payloadHash
  ].join('\n')

  // 2) 待签字符串
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)
  ].join('\n')

  // 3) 签名
  const key = signingKey(secretKey, dateStamp, region, service)
  const signature = crypto.createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex')

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  const out = {
    'Content-Type': contentType,
    'X-Amz-Date': amzDate,
    'X-Amz-Target': target,
    Authorization: authorization
  }
  if (sessionToken) out['X-Amz-Security-Token'] = sessionToken
  return out
}

// ---------------------------------------------------------------------------

const AWS_LANGUAGES = {
  zh: 'zh', 'zh-cn': 'zh', 'zh-tw': 'zh-TW', en: 'en', ja: 'ja', ko: 'ko',
  fr: 'fr', de: 'de', es: 'es', pt: 'pt', ru: 'ru', it: 'it', ar: 'ar',
  // AWS 原生支持葡语变体。
  'pt-br': 'pt-BR', 'pt-pt': 'pt-PT',
  hi: 'hi', th: 'th', vi: 'vi', id: 'id', ms: 'ms', tr: 'tr', nl: 'nl', pl: 'pl',
  he: 'he', fa: 'fa', bn: 'bn', uk: 'uk', cs: 'cs', da: 'da', fi: 'fi', no: 'no', sv: 'sv'
}

const awsAdapter = {
  name: '亚马逊 AWS 翻译',
  translate: async (engine, payload, options) => {
    // AWS 需要三个值：Access Key ID、Secret Access Key，以及区域。
    // 区域不是凭据但同样必填 —— 端点由它决定，填错会 403 或 404。
    const accessKey = pick(options.credentials, 'apiKey', 'PIX_AWS_ACCESS_KEY_ID')
    const secretKey = pick(options.credentials, 'secret', 'PIX_AWS_SECRET_ACCESS_KEY')
    const region = String(
      (options.credentials && options.credentials.region) || (engine && engine.region) || ''
    ).trim() || envValue('PIX_AWS_REGION') || 'us-east-1'

    if (!accessKey || !secretKey) {
      return { ok: false, msg: 'AWS 需要 Access Key ID 与 Secret Access Key 两个值，请检查是否都填了' }
    }

    const text = String(payload.text || '')
    if (!text) return { ok: false, msg: '请输入要翻译的文本' }

    const key = String(payload.to || 'zh').toLowerCase()
    const target = AWS_LANGUAGES[key]
    if (!target) return { ok: false, msg: `AWS 不支持目标语种：${payload.to}` }

    const source = String(payload.from || payload.detected || '').toLowerCase()
    const body = {
      Text: text,
      SourceLanguageCode: (source && source !== 'auto' && AWS_LANGUAGES[source]) || 'auto',
      TargetLanguageCode: target
    }
    const bodyText = JSON.stringify(body)

    const host = `translate.${region}.amazonaws.com`
    const path = '/'
    let headers
    try {
      headers = signRequest({
        method: 'POST', host, path, payload: bodyText,
        region, service: 'translate', accessKey, secretKey,
        sessionToken: pick(options.credentials, 'sessionToken', 'PIX_AWS_SESSION_TOKEN')
      })
    } catch (error) {
      return { ok: false, msg: `AWS 签名失败：${(error && error.message) || error}` }
    }

    let response
    try {
      response = await options.fetch(`https://${host}${path}`, {
        method: 'POST',
        headers,
        body: bodyText,
        signal: AbortSignal.timeout(options.timeoutMs || 8000)
      })
    } catch (error) {
      const reason = (error && error.name === 'TimeoutError') ? '请求超时' : ((error && error.message) || error)
      return { ok: false, msg: `AWS 请求失败：${reason}` }
    }

    if (!response.ok) {
      let detail = ''
      try {
        const b = await response.json()
        detail = String((b && (b.message || b.Message)) || '').trim()
      } catch (e) {}
      // SignatureDoesNotMatch 基本只有两种原因：Secret 填错，或服务器时间偏移超过 15 分钟
      const hint = /SignatureDoesNotMatch/i.test(detail)
        ? '（常见原因：Secret Access Key 填错，或服务器时间不准确）'
        : ''
      return { ok: false, msg: `AWS 返回 HTTP ${response.status}${hint}${detail ? '：' + detail : ''}` }
    }

    let data
    try {
      data = await response.json()
    } catch (e) {
      return { ok: false, msg: 'AWS 返回体无法解析为 JSON' }
    }
    const translated = String((data && data.TranslatedText) || '').trim()
    if (!translated) return { ok: false, msg: 'AWS 未返回译文' }

    return {
      ok: true,
      text: translated,
      detected: (data && data.SourceLanguageCode) || source || 'auto',
      engine: '亚马逊 AWS 翻译'
    }
  },
  configured: credentials => Boolean(
    (pick(credentials, 'apiKey', 'PIX_AWS_ACCESS_KEY_ID')) &&
    (pick(credentials, 'secret', 'PIX_AWS_SECRET_ACCESS_KEY'))
  )
}

module.exports = { awsAdapter, signRequest, signingKey, sha256Hex, AWS_LANGUAGES }
