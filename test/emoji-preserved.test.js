'use strict'

/**
 * emoji 必须在翻译往返中**一个都不能丢**。
 *
 * ## 这个缺陷是怎么来的
 *
 * 用户真机反馈："翻译非常不错，但是它在翻译之后，会吃掉我的 emoji 表情。"
 *
 * 根因：发送链路在送接口**之前**就 `stripEmoji(trimmed)` 了。
 * 表情没进接口，自然也不在译文里，最终发出去的整句话就少了表情。
 *
 * 修法不是"让模型保留表情"（模型会改写、会挪位置、会直接省掉），
 * 而是和 URL 一样：抽出来 → 占位符 → 原样回填。
 *
 * 这些用例全部从 `desktop/guest-inject.js` 的真实实现里取函数，
 * 不另写一份 —— 两份实现分叉了，测试就是假的。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

/**
 * 从 guest-inject.js 里把 MessageParser 的那段实现抽出来执行。
 *
 * 为什么用这种方式：guest-inject.js 是一个整体注入进客页的脚本，
 * 没有 CommonJS 导出，且顶层直接依赖 window/document。但它内部的
 * `MessageParser` 闭包（maskUrls / restoreUrls / maskEmoji …）
 * 是纯函数，可以在无 DOM 环境里跑。
 */
function loadParser () {
  const src = fs.readFileSync(path.join(__dirname, '../desktop/guest-inject.js'), 'utf8')

  const startMarker = '    var URL_RE ='
  const endMarker = '    // -------------------------------------------------------------------\n    // 计费决策'
  const start = src.indexOf(startMarker)
  const end = src.indexOf(endMarker)
  assert.ok(start > 0, '找不到 URL_RE 起点 —— 文件结构变了，测试要跟着更新')
  assert.ok(end > start, '找不到计费决策分界 —— 文件结构变了，测试要跟着更新')

  const body = src.slice(start, end)
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    body + '\nreturn { maskUrls, restoreUrls, maskEmoji, restoreEmoji, hasEmojiOnly, maskEmojiSlotsOnly: EMOJI_SEQ_RE };'
  )
  return factory()
}

const P = loadParser()

/** 走一遍完整链路：mask emoji → mask urls → （模型翻译）→ restore。 */
function roundTrip (text, fakeTranslate) {
  const em = P.maskEmoji(text)
  const urls = P.maskUrls(em.masked)
  const analyzed = {
    masked: urls.masked,
    urls: urls.urls,
    emojis: em.emojis
  }
  const translated = fakeTranslate(analyzed.masked)
  return {
    analyzed,
    out: P.restoreEmoji(P.restoreUrls(translated, analyzed.urls), analyzed.emojis)
  }
}

test('用户真机那句话：结尾的 😂 不能丢', () => {
  const src = "Lol, maybe the 2 on my keyboard went to visit the 3's house, which made me press the wrong key😂"
  const { analyzed, out } = roundTrip(src, t => {
    // 模拟模型：把占位符原样保留、翻译正文
    return t.replace(/^.*wrong key/, '哈哈，可能我键盘上的 2 去 3 家里串门了，导致我按错了')
  })
  assert.ok(analyzed.masked.includes('{{e1}}'), '送进接口的文本里必须带着表情占位符')
  assert.equal(analyzed.emojis.length, 1)
  assert.ok(out.endsWith('😂'), '译文必须把 😂 带回来，实际是：' + JSON.stringify(out))
  assert.ok(!out.includes('{{e'), '占位符不能漏进最终消息')
})

test('emoji 绝不能出现在送进接口的文本里（否则模型会改写它）', () => {
  const src = '好的👍🏽收到'
  const { analyzed } = roundTrip(src, t => t)
  assert.equal(analyzed.masked, '好的{{e1}}收到')
  assert.ok(!/\p{Extended_Pictographic}/u.test(analyzed.masked))
})

test('肤色修饰符是 emoji 的一部分，不能被拆散', () => {
  const { analyzed } = roundTrip('好的👍🏽收到', t => t)
  assert.deepEqual(analyzed.emojis, ['👍🏽'], '👍🏽 必须整体保管，拆开回填会贴出零散修饰符')
  assert.equal(P.restoreEmoji('好的{{e1}}收到', analyzed.emojis), '好的👍🏽收到')
})

test('ZWJ 组合序列（家庭/彩虹旗）整体保管', () => {
  const src = 'family 👨‍👩‍👧 and 🏳️‍🌈 pride'
  const { analyzed, out } = roundTrip(src, t => t.replace('family', '家庭'))
  assert.deepEqual(analyzed.emojis, ['👨‍👩‍👧', '🏳️‍🌈'])
  assert.equal(out, '家庭 👨‍👩‍👧 and 🏳️‍🌈 pride')
})

test('国旗由一个区域指示符对组成，不能被拆成两个字母', () => {
  const { analyzed } = roundTrip('巴西 🇧🇷 加油', t => t)
  assert.deepEqual(analyzed.emojis, ['🇧🇷'])
  assert.equal(P.restoreEmoji('巴西 {{e1}} 加油', analyzed.emojis), '巴西 🇧🇷 加油')
})

test('键帽序列 1️⃣ 整体保管', () => {
  const { analyzed } = roundTrip('第1️⃣点', t => t)
  assert.deepEqual(analyzed.emojis, ['1️⃣'])
})

test('多个 emoji 按顺序各自占位', () => {
  const { analyzed, out } = roundTrip('开心😀难过😢', t => {
    // 模型老老实实保留了占位符
    return t.replace('开心', 'happy').replace('难过', 'sad')
  })
  assert.equal(analyzed.masked, '开心{{e1}}难过{{e2}}')
  assert.deepEqual(analyzed.emojis, ['😀', '😢'])
  assert.equal(out, 'happy😀sad😢')
})

test('模型把占位符顺序弄反了：表情仍按编号各归其位，不串位', () => {
  // 模型把 {{e2}} 挪到了 {{e1}} 前面
  const out = P.restoreEmoji('sad{{e2}}happy{{e1}}', ['😀', '😢'])
  assert.equal(out, 'sad😢happy😀')
})

test('模型把占位符整个吃了：兜底按原顺序补在末尾，一个都不能少', () => {
  const out = P.restoreEmoji('我按错键了', ['😂'])
  assert.equal(out, '我按错键了 😂', '装饰性追加到末尾，而不是彻底丢掉')
})

test('模型写了 {{ e1 }}（带空格）也要认', () => {
  assert.equal(P.restoreEmoji('好的{{ e1 }}收到', ['👍']), '好的👍收到')
})

test('emoji 与 URL 同时存在：两套占位符互不干扰', () => {
  const src = '看这个 https://example.com/a?b=1 😀 很好'
  const { analyzed, out } = roundTrip(src, t => {
    // 模型保留两个占位符，翻译正文
    return t.replace('看这个', 'look at this').replace('很好', 'very good')
  })
  assert.ok(analyzed.masked.includes('{{e1}}'))
  assert.ok(analyzed.masked.includes('[[1]]'))
  assert.equal(out, 'look at this https://example.com/a?b=1 😀 very good')
})

test('纯表情消息：不该触发翻译（白花额度）', () => {
  assert.equal(P.hasEmojiOnly('😂👍❤️'), true)
  assert.equal(P.hasEmojiOnly('😂 ok'), false)
  assert.equal(P.hasEmojiOnly(''), false)
})

test('没有 emoji 的消息行为不变（别为了修 emoji 把普通翻译弄坏）', () => {
  const { analyzed, out } = roundTrip('hello world', t => t.replace('hello', '你好'))
  assert.equal(analyzed.masked, 'hello world')
  assert.deepEqual(analyzed.emojis, [])
  assert.equal(out, '你好 world')
})

test('工程符号不是 emoji，不能被当成表情抽走', () => {
  // © ™ → 这类是 Extended_Pictographic 但用户写正文时也可能用到，
  // 抽走再回填不会改变语义，这里只断言不会被拆碎
  const { out } = roundTrip('© 2026 Hello Pix', t => t)
  assert.equal(out, '© 2026 Hello Pix')
})
