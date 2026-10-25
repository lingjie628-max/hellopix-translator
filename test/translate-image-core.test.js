'use strict'

/**
 * core.translateImage：入参护栏 + 通道解析必须与文本翻译一致。
 *
 * ## 这个文件真正在防什么
 *
 * 图片翻译最危险的不是"翻得不准"，而是**绕过权益**：
 * 如果它自己解析通道、不走 resolveTranslateEngine，那么
 * 套餐没买 GPT 的商户也能用图片翻译 —— 那是直接漏钱和漏权限。
 *
 * 所以这里的断言都是"必须调用同一个 resolveTranslateEngine"，
 * 而不是"能翻出结果就行"。
 */

const test = require('node:test')
const assert = require('node:assert')

const { CoreService } = require('../server/services/core-service')

/** 造一个只关心 translateImage 的最小服务实例（继承真身，只覆盖外部依赖）。 */
function makeCore (overrides) {
  const o = overrides || {}
  const calls = { resolve: [], translateImage: [] }
  // 用真身的原型链：translateImage 里的 this.xxx 才能按真实现取值。
  const core = Object.create(CoreService.prototype)
  core.allowPublicNetwork = false
  core.resolveTranslateEngine = async (session, data, input) => {
    calls.resolve.push({ session, data, input })
    if (o.resolveThrows) throw o.resolveThrows
    return o.resolved || { engine: { id: 'gpt', name: 'GPT 翻译', enabled: true }, engineId: 'gpt', allowed: [] }
  }
  core.engineCredentials = async id => {
    calls.credsFor = id
    return { apiKey: 'k' }
  }
  core.translator = {
    translateImage: async (engine, payload, options) => {
      calls.translateImage.push({ engine, payload, options })
      if (o.translateThrows) throw o.translateThrows
      return o.result || { ok: true, blocks: [{ source: 'a', target: '甲' }], text: '甲', model: 'gpt-4o-mini' }
    }
  }
  return { core, calls }
}

test('没有图片时 400，且不碰通道解析（不产生任何上游调用）', async () => {
  const { core, calls } = makeCore()
  await assert.rejects(
    () => core.translateImage({ kind: 'main', account: {} }, { image: '' }),
    err => err.status === 400 && err.code === 'IMAGE_REQUIRED'
  )
  assert.equal(calls.resolve.length, 0)
  assert.equal(calls.translateImage.length, 0)
})

test('超过 12MB 直接 413，不碰通道解析', async () => {
  const { core, calls } = makeCore()
  await assert.rejects(
    () => core.translateImage({ kind: 'main', account: {} }, { image: 'A'.repeat(17 * 1024 * 1024) }),
    err => err.status === 413 && err.code === 'IMAGE_TOO_LARGE'
  )
  assert.equal(calls.resolve.length, 0)
})

test('语言参数非法时 400', async () => {
  const { core } = makeCore()
  await assert.rejects(
    () => core.translateImage({ kind: 'main', account: {} }, { image: 'AAAA', to: '../../etc' }),
    err => err.status === 400 && err.code === 'BAD_LANGUAGE'
  )
})

test('★ 通道解析必须复用 resolveTranslateEngine（否则能绕开套餐权益）', async () => {
  const { core, calls } = makeCore()
  await core.translateImage({ kind: 'main', account: { id: 7 } }, { image: 'AAAA', to: 'zh', engine: 'deepl' })
  assert.equal(calls.resolve.length, 1, '必须走统一的通道解析')
  // 用户选的通道要原样传下去 —— 绝不能偷偷换成 gpt
  assert.equal(calls.resolve[0].data.engine, 'deepl')
})

test('套餐拒绝（403/503）原样抛出，不吞成「图片翻译失败」', async () => {
  const err = Object.assign(new Error('当前套餐未包含此通道'), { status: 403, code: 'ENGINE_NOT_ALLOWED' })
  const { core, calls } = makeCore({ resolveThrows: err })
  await assert.rejects(
    () => core.translateImage({ kind: 'main', account: {} }, { image: 'AAAA' }),
    e => e.status === 403 && e.code === 'ENGINE_NOT_ALLOWED'
  )
  assert.equal(calls.translateImage.length, 0, '权益没过就不该打上游')
})

test('NO_VISION 映射为 400（是「换通道」而不是「稍后重试」）', async () => {
  const { core } = makeCore({
    result: { ok: false, code: 'NO_VISION', msg: '当前通道不支持图片翻译' }
  })
  await assert.rejects(
    () => core.translateImage({ kind: 'main', account: {} }, { image: 'AAAA' }),
    e => e.status === 400 && e.code === 'NO_VISION'
  )
})

test('其他上游失败映射为 502', async () => {
  const { core } = makeCore({
    result: { ok: false, msg: '上游 500' }
  })
  await assert.rejects(
    () => core.translateImage({ kind: 'main', account: {} }, { image: 'AAAA' }),
    e => e.status === 502
  )
})

test('成功时带回 blocks / text / model，并把图片与 mime 交给适配层', async () => {
  const { core, calls } = makeCore()
  const out = await core.translateImage(
    { kind: 'main', account: {} },
    { image: 'AAAA', mime: 'image/webp', to: 'en' }
  )
  assert.equal(out.ok, true)
  assert.deepEqual(out.blocks, [{ source: 'a', target: '甲' }])
  assert.equal(out.model, 'gpt-4o-mini')
  assert.equal(calls.translateImage[0].payload.image, 'AAAA')
  assert.equal(calls.translateImage[0].payload.mime, 'image/webp')
  assert.equal(calls.translateImage[0].payload.to, 'en')
  // 凭据按解析出来的通道去取，不是写死 gpt
  assert.equal(calls.credsFor, 'gpt')
})
