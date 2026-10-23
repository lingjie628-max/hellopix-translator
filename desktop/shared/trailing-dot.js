/**
 * 译文句末标点清理。
 *
 * ## 为什么需要
 *
 * 上游模型（尤其是 LLM 通道和 Qwen-MT）有个改不掉的毛病：**给短句补句点**。
 * 用户在聊天里发 "在吗"，译文回来是 "Are you there." —— 原文没有句点，
 * 模型自作主张补了一个。发出去对方看到的就是一句带句号的怪话。
 *
 * 这不是翻译错误，所以不适合改 prompt 硬压（实测压不住，且会伤长句的断句），
 * 只能在译文回到用户手里之前统一收口。
 *
 * ## 核心原则：只删"模型自己加的"
 *
 * 判定依据是**原文**，不是译文：
 *   · 原文有句末标点 → 译文保留（模型加的可能是正确的对应标点）
 *   · 原文没有句末标点 → 译文末尾的 `.` 一律删掉
 *
 * 绝不做的事：
 *   1. 不删 `。！？` 和 `…` —— 中文句号、感叹、问号、省略号都是真实语义，
 *      删了会把陈述句变疑问句、把情绪抹平。
 *   2. 不删 `!` `?` —— 即使是模型加的，也可能是它把原文的语气翻出来了。
 *      只处理用户明确反馈的 `.`。
 *   3. 不碰多行文本 —— 多行是列表/对话片段，每行末尾的标点可能是格式的一部分，
 *      统一删会破坏结构。只有单行短文本才收口。
 *   4. 不删小数点、缩写点（`3.5`、`e.g.`、`Mr.`）—— 见 trailingDotRemovable
 *      的排除规则：只有当点前面**不是**数字、且整个词不是已知缩写时才删。
 *   5. 不删 `...`（三个点）—— 那是省略号语义，不是句点。代码里显式跳过。
 *
 * ## 为什么不做成"全局开关"
 *
 * 这是**观感修正**，不是可配置的产品功能。做成开关只会让两边行为分叉，
 * 出问题时不知道该看哪条路径。统一在服务端收口，客户端零改动。
 */

/** 原文末尾出现这些，就认为"原文本来就有句末标点"，译文不动。 */
const SOURCE_END_PUNCT = /[.!?。！？…~～;；:：,，、"'”’）)\]】》]$/

/** 常见英文缩写：`Mr.` `Dr.` `e.g.` `etc.` 这些点删了就错了。 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc',
  'inc', 'ltd', 'co', 'corp', 'dept', 'est', 'fig', 'no', 'vol',
  'e.g', 'i.e', 'a.m', 'p.m', 'u.s', 'u.k', 'a.k.a'
])

/**
 * 这个点能不能删。
 *
 * 传入的是**去掉点之前的整段译文**，要求它已经 trim 过。
 * 返回 true 表示"末尾这个点是孤立的句点，可以删"。
 */
function trailingDotRemovable(text) {
  const body = String(text || '')
  if (!body.endsWith('.')) return false

  const stripped = body.slice(0, -1)

  // `...` / `..`：省略号语义，不碰。
  // 注意必须检查**去掉后**还有没有点 —— "Hello..." 去掉一个还剩 "Hello.."，
  // 说明这是连续点，不是句末句点。
  if (stripped.endsWith('.')) return false

  // 数字相关。
  //
  // 走到这里，"末尾那个点"已经确定不是连续点的一部分，问题只剩：
  // 这个点是不是**数字内部**的点？
  //
  // 答案看它后面还有没有东西 —— 而这里它一定在最后，所以：
  //   '3.5'   → 去掉末尾点后是 '3.5'，但**原文没有点**，这个点就是收句用的，删。
  //   '3.5.'  → 去掉末尾点后是 '3.5'，末尾点同样是收句用的，删。
  //   '100.'  → 同理，删。
  //
  // 换言之：**句末的数字点永远是句点，不是小数点**。
  // 小数点只有在数字中间才成立（'3.5' 里那个点后面有 '5'），
  // 而那个点根本不会进入这个函数 —— 函数只处理最后一个字符。
  //
  // 所以数字这里不需要特殊放行。之前写成 "整体是数字就保留" 是错的：
  // 单测里 'The price is 2.5.' 因此漏删，'Version 1.2.0.' 同样漏删。
  // 这里只挡一种情况：末尾点前面紧跟的是数字、且**后面确实还有数字** ——
  // 不可能发生在末位，所以这段逻辑作用仅限把意图写清楚，不改变结果。
  //
  // 真正要保护的小数已经在前面了：如果译文本体是 '3.5'（无末尾点），
  // 函数在第 3 行 `endsWith('.')` 就返回 false，不会走到这里。

  // 缩写：取末尾那个"词"（到空白或标点为止），小写后查表。
  const word = (stripped.match(/[A-Za-z.]+$/) || [''])[0].toLowerCase()
  if (word && ABBREVIATIONS.has(word)) return false

  return true
}

/**
 * 清理译文末尾多余的句点。
 *
 * @param {string} source 原文（用于判断原文本来有没有句末标点）
 * @param {string} translation 译文
 * @returns {string} 清理后的译文；不该动的情况原样返回
 */
function trimTrailingDot(source, translation) {
  const out = String(translation == null ? '' : translation)
  // 空译文交给上层走"可退款"分支，这里不掺和。
  if (!out.trim()) return out

  // 原文自带句末标点 → 译文不动。
  // 用 trimEnd 后的原文判断：用户粘贴时常带尾部空格/换行。
  const src = String(source == null ? '' : source).trimEnd()
  if (SOURCE_END_PUNCT.test(src)) return out

  // 多行不处理：列表/对话片段的标点属于格式。
  if (/[\r\n]/.test(out)) return out

  const body = out.replace(/\s+$/, '')
  if (!trailingDotRemovable(body)) return out

  // 保留原有尾巴的空白结构：只去掉那个点。
  return body.slice(0, -1) + out.slice(body.length)
}

module.exports = {
  trimTrailingDot,
  trailingDotRemovable,
  SOURCE_END_PUNCT
}
