'use strict'

/**
 * 图片翻译的护栏。
 *
 * 这个功能有几处「错了会静默花钱」或「错了会静默失效」的地方，
 * 都必须有测试钉住：
 *
 *   1. **模型解析能不能看图** —— 判断错了，用户点一下就花一次 token 拿到 400；
 *   2. **JSON 解析要能吃三种脏格式** —— 吃不下就等于白白付费后不可用；
 *   3. **体积上限** —— 不挡就会把十几 MB 的图送给按量计费的上游；
 *   4. **非 GPT 通道必须明确拒绝** —— 而不是伪装成"翻译失败"让用户去查网络。
 */

const test = require('node:test')
const assert = require('node:assert')

const { parseBlocks, lacksVision, translateImage } = require('../server/services/translation-image')

test('parseBlocks：干净 JSON', () => {
  const out = parseBlocks('{"blocks":[{"source":"hello","target":"你好"}]}')
  assert.deepEqual(out, [{ source: 'hello', target: '你好' }])
})

test('parseBlocks：裹了 ```json 围栏（模型最常见的行为）', () => {
  const out = parseBlocks('好的，翻译如下：\n```json\n{"blocks":[{"source":"hi","target":"嗨"}]}\n```')
  assert.deepEqual(out, [{ source: 'hi', target: '嗨' }])
})

test('parseBlocks：前后带废话、没有围栏', () => {
  const out = parseBlocks('这是结果 {"blocks":[{"source":"a","target":"甲"},{"source":"b","target":"乙"}]} 完毕')
  assert.deepEqual(out, [{ source: 'a', target: '甲' }, { source: 'b', target: '乙' }])
})

test('parseBlocks：直接给数组（不套 blocks 字段）', () => {
  const out = parseBlocks('[{"text":"hi","translation":"嗨"}]')
  assert.deepEqual(out, [{ source: 'hi', target: '嗨' }])
})

test('parseBlocks：完全解析不出来时退回整段文本，不丢掉已付费的结果', () => {
  const out = parseBlocks('你好，这是纯文本回复')
  assert.deepEqual(out, [{ source: '', target: '你好，这是纯文本回复' }])
})

test('parseBlocks：空输入返回空数组', () => {
  assert.deepEqual(parseBlocks(''), [])
  assert.deepEqual(parseBlocks(null), [])
})

test('parseBlocks：过滤掉没有译文的条目', () => {
  const out = parseBlocks('{"blocks":[{"source":"x"},{"source":"y","target":"乙"}]}')
  assert.deepEqual(out, [{ source: 'y', target: '乙' }])
})

test('lacksVision：确定是纯文本的模型要被识别出来', () => {
  assert.equal(lacksVision('gpt-3.5-turbo'), true)
  assert.equal(lacksVision('gpt-4'), true)
  assert.equal(lacksVision('gpt-4-0314'), true)
  assert.equal(lacksVision('o1-mini'), true)
})

test('lacksVision：视觉模型不能被误判（误判 = 用户明明能用却说不能用）', () => {
  assert.equal(lacksVision('gpt-4o-mini'), false)
  assert.equal(lacksVision('gpt-4o'), false)
  assert.equal(lacksVision('gpt-5.6-luna'), false)
  assert.equal(lacksVision('gpt-4-turbo'), false)
  // 没登记过的新模型一律放行 —— 真不支持时由上游 400 兜底并给出准确提示
  assert.equal(lacksVision('some-future-model-xyz'), false)
  assert.equal(lacksVision(''), false)
})

// ---------------------------------------------------------------------------
// 请求体：输出长度字段名必须按模型区分
//
// 2026-10-25 在**生产环境**实测（线上 gpt 通道的实际模型是 gpt-5.6-luna）：
//
//   传 max_tokens → 400 "Unsupported parameter: 'max_tokens' is not supported
//                        with this model. Use 'max_completion_tokens' instead."
//
// 也就是说写死 `max_tokens` 会让图片翻译在线上**整条失败**。
// 文本翻译早就用 maxTokensFieldFor() 规避了这个坑（那次事故是 24 小时内
// 1311 次调用全部先白打一趟），图片路径不能漏。
// ---------------------------------------------------------------------------

/** 最小的 1x1 PNG。 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 装一个假的 fetch，把请求体捞出来，并回一个合法的 blocks JSON。 */
function captureBody () {
  const seen = []
  const fetchStub = async (url, init) => {
    seen.push(JSON.parse(init.body))
    return {
      ok: true,
      status: 200,
      async json () {
        return {
          choices: [{ message: { content: '{"blocks":[{"source":"hi","target":"嗨"}]}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        }
      },
      async text () { return '' }
    }
  }
  return { seen, fetchStub }
}

const VALID_OPTS = (fetchStub) => ({
  credentials: { apiKey: 'test-key' },
  fetch: fetchStub,
  timeoutMs: 5000
})

test('translateImage：gpt-5 系必须用 max_completion_tokens（写 max_tokens 线上直接 400）', async () => {
  const { seen, fetchStub } = captureBody()
  const res = await translateImage(
    { id: 'gpt', model: 'gpt-5.6-luna', endpoint: 'https://api.openai.com/v1' },
    { image: PNG, mime: 'image/png', to: 'zh' },
    VALID_OPTS(fetchStub)
  )
  assert.equal(res.ok, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].max_completion_tokens, 2000)
  assert.equal(seen[0].max_tokens, undefined, 'gpt-5 系不能带 max_tokens')
})

test('translateImage：老模型仍然用 max_tokens（新字段它们不认）', async () => {
  const { seen, fetchStub } = captureBody()
  const res = await translateImage(
    { id: 'gpt', model: 'gpt-4o-mini', endpoint: 'https://api.openai.com/v1' },
    { image: PNG, mime: 'image/png', to: 'zh' },
    VALID_OPTS(fetchStub)
  )
  assert.equal(res.ok, true)
  assert.equal(seen[0].max_tokens, 2000)
  assert.equal(seen[0].max_completion_tokens, undefined)
})

test('translateImage：请求体走的是视觉协议（content 是分段数组）', async () => {
  const { seen, fetchStub } = captureBody()
  await translateImage(
    { id: 'gpt', model: 'gpt-5.6-luna', endpoint: 'https://api.openai.com/v1' },
    { image: PNG, mime: 'image/png', to: 'zh' },
    VALID_OPTS(fetchStub)
  )
  const user = seen[0].messages.find(m => m.role === 'user')
  assert.ok(Array.isArray(user.content), 'user.content 必须是数组，否则上游会当成纯文本')
  const img = user.content.find(p => p.type === 'image_url')
  assert.ok(img, '必须有一个 image_url 分段')
  assert.ok(img.image_url.url.startsWith('data:image/png;base64,'))
  // temperature 不传 —— 推理类模型传了就 400，没必要每次白打一趟
  assert.equal(seen[0].temperature, undefined)
})
