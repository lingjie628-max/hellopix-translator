'use strict'

/**
 * 探测线上通道**到底支持不支持看图**。
 *
 * ## 为什么要真的打一次
 *
 * 模型名不可靠（`gpt-5.6-luna` 这种自定义/中转名尤其不可靠），
 * 文档也不可靠（中转网关的文档经常落后于实际）。
 * 唯一能下定论的是：**用线上真实的模型名 + 真实 Key，发一个带图的请求，
 * 看它回什么。**
 *
 * ## 判据
 *
 *   · 200 且 choices[0].message.content 有内容 → 支持视觉
 *   · 400 且报错提到 image / content / vision  → 不支持视觉
 *   · 401/402/429 → 凭据/欠费/限流问题，**与视觉能力无关**，不能据此下结论
 *   · 404 → 模型名不存在，也不能据此判断视觉
 *
 * 最后两种必须如实报告为"未得出结论"，绝不能把"没测出来"说成"不支持"。
 *
 * ## 怎么跑
 *
 * 在服务器上（能读 DATABASE_URL 与加密密钥）：
 *
 *   node server/scripts/probe-image-vision.js
 *   node server/scripts/probe-image-vision.js gpt      # 只测 gpt
 *
 * 图片用的是程序内生成的一张「白底黑字 HELLO」PNG —— 不依赖外部文件，
 * 也不含任何用户数据。
 */

const { Pool } = require('pg')
const creds = require('../lib/credentials')

/** 一张 1x1 的真 PNG；用来验证"能不能收图"，内容不需要有意义。 */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * 读一张本地图片并识别它的文字 —— 验证"能收图"之外的**识别质量**。
 *
 * ## 为什么需要这一步
 *
 * 200 只证明模型接受 `image_url` 这个参数形态。但图片翻译真正要的是
 * **读出图里的小字**：如果模型能收图却读不出字，功能照样不可用，
 * 而且失败得更隐蔽（不报错，只是翻译出来是空的）。
 *
 * 用 --image 指定的真实截图跑一次，直接看它回什么。
 */
async function probeRead (engine, imagePath, question) {
  const fs = require('fs')
  let b64 = ''
  let mime = 'image/png'
  try {
    b64 = fs.readFileSync(imagePath, { encoding: 'base64' })
    if (/\.jpe?g$/i.test(imagePath)) mime = 'image/jpeg'
    else if (/\.webp$/i.test(imagePath)) mime = 'image/webp'
  } catch (e) {
    return { verdict: 'UNKNOWN', reason: '读不到图片：' + e.message }
  }

  const endpoint = String(engine.endpoint || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions'
  const body = {
    model: engine.model,
    messages: [
      { role: 'system', content: '你是图片文字识别助手。只输出识别到的文字，不要解释。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: question || '把这张图里的所有文字原样输出。' },
          { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64 } }
        ]
      }
    ],
    max_completion_tokens: 500
  }

  const started = Date.now()
  let res
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + engine.key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000)
    })
  } catch (e) {
    return { verdict: 'UNKNOWN', reason: '网络/超时：' + ((e && e.message) || e), ms: Date.now() - started }
  }
  const ms = Date.now() - started
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    return { verdict: 'UNKNOWN', reason: 'HTTP ' + res.status + '：' + text.slice(0, 300), ms }
  }
  let content = ''
  try {
    const j = JSON.parse(text)
    content = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '')
  } catch (e) {
    return { verdict: 'UNKNOWN', reason: '返回不是 JSON：' + text.slice(0, 200), ms }
  }
  return { verdict: 'READ', reply: content.trim(), ms }
}

/**
 * 验证"JSON 契约"：模型能否按正式代码要求的格式输出 `{blocks:[{source,target}]}`。
 *
 * ## 为什么单独验这一条
 *
 * 图片翻译靠 `parseBlocks` 解析模型回复。模型如果**不按格式回**（比如回一段
 * 纯散文），parseBlocks 会退回"整段当一条译文"——功能不报错，但用户看到的是
 * 一堆没结构的东西，也看不到原文对照。
 *
 * 所以这里用**与 translation-image.js 完全相同的 system prompt** 打一次，
 * 直接看模型是不是真的按 JSON 回。
 */
async function probeFormat (engine, imagePath) {
  const fs = require('fs')
  let b64 = ''
  let mime = 'image/png'
  try {
    b64 = fs.readFileSync(imagePath, { encoding: 'base64' })
    if (/\.jpe?g$/i.test(imagePath)) mime = 'image/jpeg'
  } catch (e) {
    return { verdict: 'UNKNOWN', reason: '读不到图片：' + e.message }
  }

  // ★ 与 server/services/translation-image.js 的 system 拼法保持一致 ★
  const targetName = '简体中文'
  const system = [
    '你是专业的图片文字翻译。',
    '1. 找出图片里所有需要翻译的文字（聊天气泡、界面标签、按钮都算）。',
    '2. 把每一段翻译成' + targetName + '。',
    '3. 只输出 JSON，不要任何解释、不要代码块标记。',
    '4. 格式：{"blocks":[{"source":"原文","target":"译文"}]}',
    '5. 按阅读顺序排列；同一段话不要拆开；表情等无法翻译的部分跳过。',
    '6. 如果图里没有可翻译的文字，返回 {"blocks":[]}。'
  ].join('\n')

  const endpoint = String(engine.endpoint || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions'
  const body = {
    model: engine.model,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: '翻译这张图片里的文字。' },
          { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64 } }
        ]
      }
    ],
    max_completion_tokens: 2000
  }

  const started = Date.now()
  let res
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + engine.key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000)
    })
  } catch (e) {
    return { verdict: 'UNKNOWN', reason: '网络/超时：' + ((e && e.message) || e), ms: Date.now() - started }
  }
  const ms = Date.now() - started
  const text = await res.text().catch(() => '')
  if (!res.ok) return { verdict: 'UNKNOWN', reason: 'HTTP ' + res.status + '：' + text.slice(0, 300), ms }

  let content = ''
  let usage = null
  try {
    const j = JSON.parse(text)
    content = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '')
    usage = j.usage || null
  } catch (e) {
    return { verdict: 'UNKNOWN', reason: '返回不是 JSON：' + text.slice(0, 200), ms }
  }

  // 用**项目里真正的解析器**判断，而不是这里另写一份
  const raw = String(content || '').trim()
  let parsed = null
  try { parsed = JSON.parse(raw) } catch (e) {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fence) { try { parsed = JSON.parse(fence[1].trim()) } catch (e2) {} }
  }
  const blocks = parsed && Array.isArray(parsed.blocks) ? parsed.blocks : null
  return {
    verdict: blocks ? 'JSON_OK' : 'JSON_BAD',
    raw: raw.slice(0, 600),
    blockCount: blocks ? blocks.length : 0,
    blocks: blocks || [],
    usage,
    ms
  }
}

async function probe (engine) {
  const endpoint = String(engine.endpoint || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions'
  const body = {
    model: engine.model,
    messages: [
      { role: 'system', content: '你是一个图片识别助手。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '这张图里有什么？用一句话回答。' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + TINY_PNG } }
        ]
      }
    ],
    /**
     * ★ 用 max_completion_tokens，不是 max_tokens ★
     *
     * 实测（2026-10-25，线上 gpt-5.6-luna）：
     *   传 max_tokens → 400 "Unsupported parameter: 'max_tokens' is not supported
     *                        with this model. Use 'max_completion_tokens' instead."
     *
     * 这条错误**与视觉能力无关**，但它会先于视觉判定发生 —— 探测脚本如果
     * 用错了字段名，会把"参数不对"误读成"不支持看图"。
     * 这也正是正式代码里 maxTokensFieldFor() 要按模型选字段名的原因。
     */
    max_completion_tokens: 100
  }

  const started = Date.now()
  let res
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + engine.key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    })
  } catch (e) {
    return { verdict: 'UNKNOWN', reason: '网络/超时：' + ((e && e.message) || e), ms: Date.now() - started }
  }

  const ms = Date.now() - started
  let text = ''
  try { text = await res.text() } catch (e) { text = '' }

  if (res.ok) {
    let content = ''
    try {
      const j = JSON.parse(text)
      content = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '')
    } catch (e) {
      return { verdict: 'UNKNOWN', reason: '200 但返回不是 JSON：' + text.slice(0, 200), ms }
    }
    return { verdict: 'SUPPORTED', model: engine.model, reply: content.trim().slice(0, 120), ms }
  }

  const detail = text.slice(0, 400)

  // 关键区分：哪些错误说明"不支持视觉"，哪些只是别的问题
  if (res.status === 400 || res.status === 422) {
    if (/image|vision|multimodal|content.*type|unsupported.*content/i.test(detail)) {
      return { verdict: 'NOT_SUPPORTED', model: engine.model, status: res.status, detail, ms }
    }
    return { verdict: 'UNKNOWN', reason: '400 但原因与图片无关：' + detail, ms }
  }
  if (res.status === 401 || res.status === 403) {
    return { verdict: 'UNKNOWN', reason: '凭据被拒（401/403），与视觉能力无关', ms }
  }
  if (res.status === 404) {
    return { verdict: 'UNKNOWN', reason: '模型或端点不存在（404），与视觉能力无关：' + detail, ms }
  }
  if (res.status === 429) {
    return { verdict: 'UNKNOWN', reason: '限流（429），与视觉能力无关', ms }
  }
  return { verdict: 'UNKNOWN', reason: 'HTTP ' + res.status + '：' + detail, ms }
}

function label (v) {
  switch (v) {
    case 'SUPPORTED': return '✅ 支持看图'
    case 'NOT_SUPPORTED': return '❌ 不支持看图'
    default: return '❓ 未得出结论'
  }
}

async function main () {
  const args = process.argv.slice(2)
  const imgIdx = args.indexOf('--image')
  const imagePath = imgIdx >= 0 ? (args[imgIdx + 1] || '') : ''
  // 位置参数（通道 id）。必须排除 --image 的值，否则它会被当成通道 id。
  const only = args.filter((a, i) => !a.startsWith('--') && i !== imgIdx + 1)[0] || ''

  if (!process.env.DATABASE_URL) {
    console.log('缺少 DATABASE_URL —— 在服务器上设置后重跑。')
    process.exitCode = 1
    return
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const sql = only
    ? 'select id, model, endpoint, api_key_ciphertext from engines where id=$1'
    : "select id, model, endpoint, api_key_ciphertext from engines where enabled=true order by id"
  const rows = (await pool.query(sql, only ? [only] : [])).rows
  await pool.end()

  if (!rows.length) {
    console.log('没有找到通道' + (only ? '：' + only : ''))
    return
  }

  console.log('接口：POST <endpoint>/chat/completions（带 image_url 分段）')
  console.log('图片：1x1 PNG（只为验证"能不能收图"，内容无意义）')
  console.log('')

  for (const r of rows) {
    let key = ''
    try {
      key = creds.decryptSecret(r.api_key_ciphertext)
    } catch (e) {
      console.log(r.id + '（' + (r.model || '-') + '）：无法解密 Key —— ' + e.message)
      continue
    }
    if (!key) {
      console.log(r.id + '（' + (r.model || '-') + '）：未配置 Key，跳过')
      continue
    }
    const out = await probe({ model: r.model, endpoint: r.endpoint, key })
    console.log(r.id + '（' + (r.model || '-') + '）→ ' + label(out.verdict) + '  [' + out.ms + 'ms]')
    if (out.reply) console.log('    模型回复：' + out.reply)
    if (out.detail) console.log('    原始报错：' + out.detail.replace(/\s+/g, ' ').slice(0, 300))
    if (out.reason) console.log('    原因：' + out.reason.replace(/\s+/g, ' ').slice(0, 300))

    // 指定了 --image 就再跑一次"读字"，验证识别质量
    if (imagePath) {
      const read = await probeRead({ model: r.model, endpoint: r.endpoint, key }, imagePath)
      console.log('    读字测试（' + imagePath + '）：')
      if (read.verdict === 'READ') {
        const lines = read.reply.split('\n').slice(0, 12)
        lines.forEach(l => console.log('      | ' + l))
        console.log('      [' + read.ms + 'ms]')
      } else {
        console.log('      ' + (read.reason || '未读出内容'))
      }

      // 再验一条核心契约：能不能按正式代码的 JSON 格式回
      const fmt = await probeFormat({ model: r.model, endpoint: r.endpoint, key }, imagePath)
      console.log('    JSON 契约测试（用正式代码的 system prompt）：')
      if (fmt.verdict === 'JSON_OK') {
        console.log('      ✅ 按格式返回了 ' + fmt.blockCount + ' 段  [' + fmt.ms + 'ms]')
        for (const b of fmt.blocks.slice(0, 6)) {
          console.log('        source: ' + JSON.stringify(b.source))
          console.log('        target: ' + JSON.stringify(b.target))
        }
        if (fmt.usage) {
          console.log('        usage: prompt=' + (fmt.usage.prompt_tokens || 0) +
            ' completion=' + (fmt.usage.completion_tokens || 0))
        }
      } else if (fmt.verdict === 'JSON_BAD') {
        console.log('      ❌ 没有按 JSON 格式回（会被 parseBlocks 兜底成整段文本）')
        console.log('      | ' + String(fmt.raw || '').split('\n').slice(0, 8).join('\n      | '))
        console.log('      [' + fmt.ms + 'ms]')
      } else {
        console.log('      ' + (fmt.reason || '未得出结论'))
      }
    }
    console.log('')
  }
}

main().catch(e => {
  console.error('探测失败：' + ((e && e.message) || e))
  process.exitCode = 1
})
