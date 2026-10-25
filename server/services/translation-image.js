'use strict'

/**
 * 图片翻译（视觉模型）。
 *
 * ## 为什么单独成模块，而不是塞进 translate()
 *
 * 现有的 `translate(engine, payload, options)` 契约是**纯文本**：
 *
 *   · `payload.text` 是字符串；
 *   · `messages[1].content` 直接就是这个字符串；
 *   · 输入上限靠 `estimateTokens(text)` 估字符；
 *   · 缓存键是 `hash(text)`。
 *
 * 图片走的是完全不同的形状：`content` 要变成
 * `[{type:'text'}, {type:'image_url'}]` 数组，输入上限按**图片体积**估，
 * 缓存键是图片内容哈希。硬塞进 translate() 会让上面四条全部变成
 * "文本时一套、图片时另一套"的分支 —— 那正是以后出错的地方。
 *
 * 所以这里只做一件事：**给定 base64 图片，返回图中文字的译文和原文**。
 *
 * ## 为什么让模型同时吐原文和译文
 *
 * 只给译文的话，用户无法核对"这段译文对应图里哪句话"。多开翻译的使用场景
 * 里，误译一个客户询价的型号就是真实损失，所以译文必须可追溯。
 *
 * 返回格式强制 JSON：模型偶尔会裹一层 ```json 代码块，解析时会剥掉
 * （见 parseBlocks）。
 */

const {
  pickKey, endpointOf, readErrorDetail, timeoutReason, DEFAULT_TIMEOUT_MS, normalizeUsage,
  maxTokensFieldFor
} = require('./translation-adapters')

/** 没有视觉能力时给用户的准确说法（不是"节点坏了"，也不是"翻译失败"）。 */
const NOT_VISION_MSG = '当前翻译通道不支持图片翻译，请在翻译设置里选择 GPT'

/**
 * 判断一个模型名是否**明确**不具备视觉能力。
 *
 * ## 为什么是"明确不具备"而不是"明确具备"
 *
 * 模型名换代太快（gpt-4o-mini → gpt-4.1 → gpt-5.6-luna …），任何白名单
 * 都会在下一次上线时过期，而**过期白名单的后果是用户明明能用却被告知不能用**。
 * 反过来的风险小得多：模型真不支持视觉时会返回 400（见调用处的错误处理），
 * 那时才提示用户，且提示是准确的。
 *
 * 所以这里只排除几个**确定是纯文本**的型号：推理系列早期版本、以及老式 3.5。
 */
function lacksVision (model) {
  const m = String(model || '').toLowerCase()
  if (!m) return false
  // o1-mini / o1-preview / o3-mini 早期不支持图片输入
  if (/^o[13]-(mini|preview)/.test(m)) return true
  // gpt-3.5 全家、gpt-4（非 4o / 4-turbo）的早期快照
  if (/^gpt-3\.5/.test(m)) return true
  if (/^gpt-4(-0314|-0613)?$/.test(m)) return true
  return false
}

/**
 * 从模型回复里抽出 `[{source, target}]`。
 *
 * 模型可能：
 *   · 直接给 JSON；
 *   · 裹一层 ```json ... ```；
 *   · 前后带一句"好的，翻译如下："。
 * 三种都要能认，否则一次**已经付过 token** 的翻译会因为解析失败而白扔。
 *
 * 都解析不出来时退回整段文本当一个 block —— 宁可给一段没分段的译文。
 */
function parseBlocks (content) {
  const raw = String(content || '').trim()
  if (!raw) return []

  const tryParse = (text) => {
    try {
      const data = JSON.parse(text)
      const arr = Array.isArray(data) ? data : (data && Array.isArray(data.blocks) ? data.blocks : null)
      if (!arr) return null
      return arr
        .map(item => ({
          source: String((item && (item.source || item.text || item.original)) || '').trim(),
          target: String((item && (item.target || item.translation || item.translated)) || '').trim()
        }))
        .filter(item => item.target)
    } catch (e) {
      return null
    }
  }

  // 1) 整段就是 JSON
  const direct = tryParse(raw)
  if (direct && direct.length) return direct

  // 2) 剥掉 ```json 围栏
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    const inner = tryParse(fence[1].trim())
    if (inner && inner.length) return inner
  }

  // 3) 截取第一个 [ ... ] 或 { ... }
  const brace = raw.match(/[[{][\s\S]*[\]}]/)
  if (brace) {
    const inner = tryParse(brace[0])
    if (inner && inner.length) return inner
  }

  // 4) 兜底：整段当一条译文
  return [{ source: '', target: raw }]
}

/**
 * 图片翻译。
 *
 * @param {object} engine   通道记录（含 endpoint / model）
 * @param {object} payload  { image: base64, mime: 'image/png', to: 'zh' }
 * @param {object} options  { credentials, fetch, timeoutMs }
 * @returns {Promise<object>} { ok, blocks, text, model, usage } 或 { ok:false, msg }
 */
async function translateImage (engine, payload, options) {
  const opts = options || {}
  const image = String((payload && payload.image) || '')
  if (!image) return { ok: false, msg: '没有收到图片' }

  // 只认常见格式：别的 mime 直接拒，避免把任意二进制塞给上游
  const mime = String((payload && payload.mime) || 'image/jpeg')
  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(mime)) {
    return { ok: false, msg: '不支持这种图片格式（仅支持 PNG / JPEG / WebP / GIF）' }
  }

  // 体积上限：视觉模型按图计价，太大的图既慢又贵。
  // 12MB 是 OpenAI 图片接口的硬上限，这里取同一量级。
  const approxBytes = Math.floor(image.length * 3 / 4)
  if (approxBytes > 12 * 1024 * 1024) {
    return { ok: false, msg: '图片太大，请换一张小一点的' }
  }

  const apiKey = pickKey(opts.credentials, 'PIX_OPENAI_API_KEY')
  if (!apiKey) {
    return { ok: false, msg: 'GPT 凭据未配置（管理后台填 API Key，或设置 PIX_OPENAI_API_KEY）' }
  }

  const endpoint = endpointOf((engine && engine.endpoint) || '', '/chat/completions',
    'https://api.openai.com/v1')
  const model = String(
    (opts.credentials && opts.credentials.model) || (engine && engine.model) || ''
  ).trim() || 'gpt-4o-mini'

  if (lacksVision(model)) {
    return { ok: false, msg: '当前模型（' + model + '）不支持看图，请换 GPT 视觉模型', code: 'NO_VISION' }
  }

  const to = String((payload && payload.to) || 'zh')
  const targetName = {
    zh: '简体中文', en: 'English', ja: '日本語', ko: '한국어',
    es: 'Español', pt: 'Português', fr: 'Français', de: 'Deutsch',
    ru: 'Русский', ar: 'العربية', th: 'ไทย', vi: 'Tiếng Việt', id: 'Bahasa Indonesia'
  }[to] || '简体中文'

  const system = [
    '你是专业的图片文字翻译。',
    '1. 找出图片里所有需要翻译的文字（聊天气泡、界面标签、按钮都算）。',
    '2. 把每一段翻译成' + targetName + '。',
    '3. 只输出 JSON，不要任何解释、不要代码块标记。',
    '4. 格式：{"blocks":[{"source":"原文","target":"译文"}]}',
    '5. 按阅读顺序排列；同一段话不要拆开；表情等无法翻译的部分跳过。',
    '6. 如果图里没有可翻译的文字，返回 {"blocks":[]}。'
  ].join('\n')

  const body = {
    model: model,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: '翻译这张图片里的文字。' },
          { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + image } }
        ]
      }
    ],
    stream: false,
  }
  // 图片翻译的产物比纯文本长（要带原文），给足输出空间。
  //
  // ★ 字段名必须按模型区分 ★
  // gpt-5 系（含线上的 gpt-5.6-luna）只认 `max_completion_tokens`，传
  // `max_tokens` 会直接 400："Unsupported parameter: 'max_tokens' is not
  // supported with this model."
  //
  // 这条 2026-10-25 在生产上实测过 —— 写死 `max_tokens` 会让图片翻译**整条
  // 失败**，而不是降级。文本翻译早就在用 maxTokensFieldFor() 规避这个坑，
  // 这里复用同一份判定，不给图片路径留第二份会分叉的实现。
  body[maxTokensFieldFor(model)] = 2000
  // 推理类模型不接受 temperature —— 这里干脆不传，免得为 400 白打一趟。
  const extra = (engine && engine.callParams && engine.callParams.extraBody) || {}
  if (extra && typeof extra === 'object') Object.assign(body, extra)

  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS
  let response
  try {
    response = await opts.fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    return { ok: false, msg: '图片翻译请求失败：' + timeoutReason(error), model }
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response)
    // 400 且提到 image/vision/content：模型不支持看图，给出能照做的提示。
    if (response.status === 400 && /image|vision|multimodal|content/i.test(detail)) {
      return { ok: false, msg: '当前模型不支持看图，请换成 GPT 视觉模型', code: 'NO_VISION', detail, model }
    }
    return { ok: false, msg: '图片翻译返回 HTTP ' + response.status + (detail ? '：' + detail : ''), model }
  }

  let data
  try {
    data = await response.json()
  } catch (e) {
    return { ok: false, msg: '图片翻译返回格式异常', model }
  }

  const content = data && data.choices && data.choices[0] &&
    data.choices[0].message && data.choices[0].message.content
  const blocks = parseBlocks(content)
  return {
    ok: true,
    blocks: blocks,
    text: blocks.map(b => b.target).join('\n'),
    model: model,
    // ★ 必须归一化 ★
    // 上游返回的是 `prompt_tokens` / `completion_tokens`，而 core-service 的
    // recordUpstreamUsage 读的是 `usage.promptTokens` / `usage.completionTokens`。
    // 直接透传原始对象 → token 数读成 0 → 成本记 0 且 cost_verified=true。
    // 2026-10-11 的 DeepSeek 事故就是这么来的，不能在图片这条路上重演。
    usage: normalizeUsage(data && data.usage)
  }
}

module.exports = { translateImage, parseBlocks, lacksVision, NOT_VISION_MSG }
