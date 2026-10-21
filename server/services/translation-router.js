'use strict'

/**
 * 混合翻译路由：短文本走"专用翻译 API"，长文本走"LLM 通道"。
 *
 * ## 为什么需要这一层
 *
 * 2026-10-21 真机实测（66 条真实消息）：
 *
 *   translate 阶段用时   中位 1926ms · P90 3253ms · 最大 9709ms
 *   文本长度             中位 51 字符 · 48% 在 50 字符以内
 *
 * 而这些时间**几乎全在上游**：LLM 是"prompt → 推理 → 逐 token 生成"，
 * 即使把 reasoning_effort 压到 low，物理下限也在 1.2s 左右。
 * 对比之下专用翻译 API（Qwen-MT / Google）是纯 seq2seq，通常 150~400ms。
 *
 * 但专用翻译 API 也有它不行的地方：长段落要保语气、术语、格式时，
 * LLM 的一致性明显更好。所以不是"换掉"，而是**按文本特征分派**。
 *
 * ## 绝对不能违反的产品约束
 *
 * core-service.resolveEngineId 有一条硬性说明：
 *   「前台展示的模型与真实调用保持一致，不得静默换成低价模型」
 *
 * 所以本模块**只回答"这条文本适合走哪条路"，不回答"偷偷换成哪条"**：
 *   · 返回的 fastEngineId 一定来自调用方给的候选集（= 套餐内已接通通道）；
 *   · 决策结果必须回传给客户端（response.routed），界面据此显示实际通道；
 *   · 任何不确定的情况一律返回 null，即"不路由"，行为与改动前完全一致。
 *
 * 宁可慢，也不能让用户看到 A、实际用了 B。
 */

/**
 * 短文本判定：字符数不超过这个值才考虑走快速通道。
 *
 * 取 120 的理由：
 *   · 实测中位数 51、48% 在 50 以内 —— 覆盖大多数日常聊天一句/两三句；
 *   · 超过 120 字符通常是多句连发或整段复制，此时 LLM 的语气与格式保真
 *     收益开始明显大于那 1.5 秒的等待；
 *   · 专用翻译 API 对超长文本的效果衰减比 LLM 更快，不该贪。
 */
const FAST_MAX_CHARS = 120

/**
 * 这些情况**不**走快速通道，无论多短。
 *
 * 每条都对应一类"专用翻译 API 会翻车、LLM 才稳"的输入：
 */
const SLOW_MARKERS = [
  // 含换行：多条消息/列表/对话片段。专用 API 经常把多行合成一行，
  // 或把列表编号揉进正文 —— 这是用户一眼就能看出的破坏。
  //
  // 注意：单个行尾换行（'Hi\n'）不算多行，用户在输入框末尾多敲一个回车很常见，
  // 不能因此就把它踢出快速通道。
  /\n\s*\S/,
  // 代码/占位符/模板：`{name}`、`%s`、`{{x}}`、`$1`、反引号包裹。
  // 专用 API 会把这些当普通词翻译掉，直接破坏业务模板。
  /`[^`]*`|\{\{[^}]*\}\}|\{[a-zA-Z_][\w.]*\}|%\d?\$?[sd]|\$\{\d?\}/,
  // URL / 邮箱：翻译它们等于把链接搞坏。
  // 也要覆盖不带协议的裸域名（www.example.com / example.com/path）——
  // 用户粘贴链接时经常省略 https://。
  /https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.]{2,}|\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|cn|net|org|io|co|me|app|dev|jp|kr|ru|de|fr|uk)\b/i,
  // 表格（两个以上分隔符连用）：专用 API 会把竖线位置打乱。
  /\|\s*\S+\s*\|\s*\S+\s*\|/,
  // 纯数字/符号/表情：没有可翻译内容，交给上游只会白花一次调用。
  /^[\s\d\p{P}\p{S}\p{Extended_Pictographic}]*$/u
]

/** 文本里是否含多字节（非 ASCII）字符 —— 用于判断"短"的程度。 */
function isMostlyAscii (text) {
  let ascii = 0
  for (const ch of text) if (ch.codePointAt(0) < 128) ascii++
  return ascii / Math.max(1, [...text].length) > 0.9
}

/**
 * 这条文本是否可以用专用翻译 API 处理。
 *
 * 纯函数，不碰网络、不碰数据库 —— 所有判断都能单测。
 *
 * @param {string} text 已清洗过的原文（调用方负责 trim / 去表情）
 * @returns {{fast:boolean, reason:string}}
 */
function shouldUseFastPath (text) {
  const value = String(text == null ? '' : text)
  if (!value.trim()) return { fast: false, reason: 'empty' }

  const chars = [...value].length
  if (chars > FAST_MAX_CHARS) return { fast: false, reason: 'too-long' }

  for (const re of SLOW_MARKERS) {
    if (re.test(value)) return { fast: false, reason: 'marker:' + String(re).slice(0, 24) }
  }

  // 单行、无占位符、长度可控 —— 可以走快速通道。
  return { fast: true, reason: isMostlyAscii(value) ? 'short-ascii' : 'short-cjk' }
}

/**
 * 挑一条快速通道。
 *
 * @param {Array<{id:string,name:string,enabled:boolean,wired:boolean,retired:boolean,provider?:string,model?:string}>} candidates
 *        套餐内通道（调用方传入，本模块不从任何地方自己取）
 * @param {string[]} preferredIds 按优先级排好的通道 id（来自配置，不是硬编码猜测）
 * @returns {object|null} 命中的通道行；没有可用的就返回 null（= 不路由）
 */
function pickFastEngine (candidates, preferredIds) {
  const rows = Array.isArray(candidates) ? candidates : []
  const order = Array.isArray(preferredIds) ? preferredIds : []
  for (const id of order) {
    const row = rows.find(r => r && r.id === id)
    if (row && row.enabled && row.wired && !row.retired) return row
  }
  return null
}

/**
 * 结合"文本"与"可用通道"，给出本次请求的实际通道。
 *
 * ## 为什么必须显式返回 routed
 *
 * 路由发生了，就必须在响应里说清楚。客户端会把它显示在翻译芯片上，
 * 用户随时能看到"这句用了哪个通道"。没有这个字段，就成了静默切换 ——
 * 正是 resolveEngineId 头部注释里点名禁止的行为。
 *
 * @param {object} input
 * @param {object} input.selected     用户/账号当前选择的通道行（原样保留，绝不被替换）
 * @param {string} input.text         原文
 * @param {Array}  input.candidates   套餐内全部通道
 * @param {string[]} input.fastEngineIds 允许被用作快速通道的 id 列表
 * @param {boolean} input.enabled     总开关（false = 完全沿用原行为）
 * @returns {{engine:object, routed:boolean, from:string, to:string, reason:string}}
 */
function routeTranslate (input) {
  const selected = input && input.selected
  // 总开关关掉、或压根没选通道：原样返回，行为与改动前完全一致。
  if (!selected) return { engine: selected, routed: false, from: '', to: '', reason: 'no-engine' }
  if (!(input && input.enabled)) return { engine: selected, routed: false, from: '', to: '', reason: 'disabled' }

  const decision = shouldUseFastPath(input.text)
  if (!decision.fast) {
    return { engine: selected, routed: false, from: selected.id, to: selected.id, reason: decision.reason }
  }

  const fast = pickFastEngine(input.candidates, input.fastEngineIds)
  // 没有可用快速通道（套餐没配 / 没接通）：不路由。绝不因为"快"就跳过权益校验。
  if (!fast) {
    return { engine: selected, routed: false, from: selected.id, to: selected.id, reason: 'no-fast-engine' }
  }
  // 用户本来就选的是它：不算路由，只是没变。
  if (fast.id === selected.id) {
    return { engine: selected, routed: false, from: selected.id, to: selected.id, reason: 'already-fast' }
  }

  return { engine: fast, routed: true, from: selected.id, to: fast.id, reason: decision.reason }
}

module.exports = {
  FAST_MAX_CHARS,
  SLOW_MARKERS,
  shouldUseFastPath,
  pickFastEngine,
  routeTranslate
}
