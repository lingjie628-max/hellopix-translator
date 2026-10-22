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

/**
 * 计费字符数。
 *
 * ★ 必须和服务端 `translation-provider.js` 的实现逐字一致 ★
 *
 * 这里的计算结果决定 mock 环境下的扣费。原来的写法按 **UTF-16 code unit**
 * 迭代（`s[i]`），而生产是按 **code point** 迭代（`for...of`）：
 *
 *   输入 😀（代理对）
 *     mock 老实现: s.length === 2 → 计 2
 *     生产实现:    一次迭代      → 计 1
 *
 * 于是带 emoji 的文本在测试里扣的钱和线上不一样 —— 测试全绿，
 * 线上账单是另一个数。这类偏差只在特定字符上出现，最难在评审时看出来。
 *
 * 规则本身（CJK 基本区算 2、其余算 1）照抄生产，不做"改进"：
 * mock 的职责是复现生产行为，不是提出更好的口径。
 */
function countBillableChars(text) {
  let count = 0
  for (const char of String(text || '')) {
    count += /[\u4e00-\u9fff]/.test(char) ? 2 : 1
  }
  return count
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

  let lastIssue = '真实翻译通道尚未配置'
  if (!options || options.allowPublicNetwork !== true) {
    return { ok: false, msg: lastIssue }
  }

  try {
    const out = await gtxTranslate(text, detected, to)
    if (out && out.toLowerCase() !== text.toLowerCase()) return { ok: true, text: out, demo: true }
  } catch (e) {
    lastIssue = 'gtx 通道失败：' + ((e && e.message) || e)
  }

  try {
    const out = await memoryTranslate(text, detected, to)
    if (out && out.toLowerCase() !== text.toLowerCase()) return { ok: true, text: out, demo: true }
  } catch (e) {
    lastIssue = 'memory 通道失败：' + ((e && e.message) || e)
  }

  // ★ 不能把原文当译文返回 ★
  //
  // 原来这里是 `return { ok: true, text: text, demo: true }`。所有通道都挂了，
  // 结果却是 success:true 且文本与原文一模一样 —— 前端拿到"译文"直接回填输入框，
  // 用户看到的是"翻了个寂寞"，而 mock 侧因为 `translatedText === text` 走
  // skipped 分支，一个字符都不计费。开发调试时会误判成"翻译是通的，
  // 只是模型不干活"，把真正的通道故障埋在下面。
  // 真实失败要能被看见，mock 也不该例外。
  return { ok: false, msg: '翻译通道无结果：' + lastIssue }
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
