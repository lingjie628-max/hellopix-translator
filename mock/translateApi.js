/**
 * 翻译接口板块。
 * 厂商通道尚未接线时，走本地演示翻译，保证聊天里能看到译文。
 * 后续接入：在 providers.<id>.translate 里真正请求即可。
 */

const https = require('https')
const http = require('http')

function notWired(name) {
  return function () {
    return { ok: false, msg: name + ' 尚未接入' }
  }
}

const providers = {
  deepseek: { name: 'DeepSeek 翻译', translate: notWired('DeepSeek') },
  baidu: { name: '百度翻译', translate: notWired('百度翻译') },
  niutrans: { name: '小牛翻译', translate: notWired('小牛翻译') },
  google: { name: '谷歌翻译', translate: notWired('谷歌翻译') },
  deepl: { name: 'DeepL 翻译', translate: notWired('DeepL') },
  aws: { name: '亚马逊 AWS 翻译', translate: notWired('AWS Translate') },
  gpt: { name: 'GPT 翻译', translate: notWired('GPT') },
  grok: { name: 'Grok 翻译', translate: notWired('Grok') }
}

const GTX = {
  zh: 'zh-CN',
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

const PHRASES = {
  hi: { zh: '你好', en: 'Hi' },
  hello: { zh: '你好', en: 'Hello' },
  hey: { zh: '嘿', en: 'Hey' },
  thanks: { zh: '谢谢', en: 'Thanks' },
  'thank you': { zh: '谢谢', en: 'Thank you' },
  ok: { zh: '好的', en: 'OK' },
  yes: { zh: '是的', en: 'Yes' },
  no: { zh: '不', en: 'No' },
  bye: { zh: '再见', en: 'Bye' },
  'good morning': { zh: '早上好', en: 'Good morning' },
  'good night': { zh: '晚安', en: 'Good night' },
  please: { zh: '请', en: 'Please' },
  sorry: { zh: '抱歉', en: 'Sorry' },
  'how are you': { zh: '你好吗', en: 'How are you' },
  你好: { zh: '你好', en: 'Hello' },
  您好: { zh: '您好', en: 'Hello' },
  谢谢: { zh: '谢谢', en: 'Thank you' },
  好的: { zh: '好的', en: 'OK' },
  再见: { zh: '再见', en: 'Bye' }
}

function detectLang(text) {
  const s = String(text || '')
  if (/[\u4e00-\u9fff]/.test(s)) return 'zh'
  if (/[\u3040-\u30ff]/.test(s)) return 'ja'
  if (/[\uac00-\ud7af]/.test(s)) return 'ko'
  return 'en'
}

function countBillableChars(text) {
  const s = String(text || '')
  let n = 0
  for (let i = 0; i < s.length; i++) {
    n += /[\u4e00-\u9fff]/.test(s[i]) ? 2 : 1
  }
  return n
}

function fetchText(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(url, { timeout: timeoutMs || 3500, headers: { 'User-Agent': 'HelloPix/0.1' } }, res => {
      let buf = ''
      res.on('data', chunk => { buf += chunk })
      res.on('end', () => resolve(buf))
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('timeout'))
    })
  })
}

function phraseLookup(text, to) {
  const key = String(text || '').trim().toLowerCase()
  const row = PHRASES[key]
  if (!row) return ''
  return row[to] || row.zh || ''
}

async function gtxTranslate(text, from, to) {
  const sl = from === 'auto' ? 'auto' : (GTX[from] || from || 'auto')
  const tl = GTX[to] || to || 'zh-CN'
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' +
    encodeURIComponent(sl) + '&tl=' + encodeURIComponent(tl) + '&dt=t&q=' + encodeURIComponent(text.slice(0, 4500))
  const raw = await fetchText(url, 4000)
  const data = JSON.parse(raw)
  if (!Array.isArray(data) || !Array.isArray(data[0])) return ''
  return data[0].map(part => part && part[0] ? part[0] : '').join('').trim()
}

async function memoryTranslate(text, from, to) {
  const langpair = (from === 'auto' ? 'autodetect' : from) + '|' + (to || 'zh')
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text.slice(0, 450)) +
    '&langpair=' + encodeURIComponent(langpair)
  const raw = await fetchText(url, 4000)
  const data = JSON.parse(raw)
  const out = data && data.responseData && data.responseData.translatedText
  return String(out || '').trim()
}

async function demoTranslate(payload, options) {
  const text = String((payload && payload.text) || '').trim()
  if (!text) return { ok: false, msg: '请输入要翻译的文本' }
  const to = String((payload && payload.to) || 'zh')
  const from = String((payload && payload.from) || 'auto')
  const detected = from === 'auto' ? detectLang(text) : from
  if (detected === to) return { ok: true, text: text, demo: true, skipped: 'same-language' }

  const hit = phraseLookup(text, to)
  if (hit) return { ok: true, text: hit, demo: true }

  if (!options || options.allowPublicNetwork !== true) {
    return { ok: false, msg: '真实翻译通道尚未配置' }
  }

  try {
    const out = await gtxTranslate(text, detected, to)
    if (out && out.toLowerCase() !== text.toLowerCase()) return { ok: true, text: out, demo: true }
  } catch (e) {}

  try {
    const out = await memoryTranslate(text, detected, to)
    if (out && out.toLowerCase() !== text.toLowerCase()) return { ok: true, text: out, demo: true }
  } catch (e) {}

  return { ok: true, text: text, demo: true }
}

async function translate(engine, payload, options) {
  const id = engine && engine.id
  const provider = providers[id]
  if (!provider) return { ok: false, msg: '通道不存在' }
  if (!engine.enabled) return { ok: false, msg: engine.name + ' 已关闭' }
  let result = provider.translate(engine, payload || {})
  if (result && typeof result.then === 'function') result = await result
  if (result && result.ok) return result
  return demoTranslate(payload || {}, options)
}

module.exports = {
  providers,
  detectLang,
  countBillableChars,
  demoTranslate,
  translate
}
