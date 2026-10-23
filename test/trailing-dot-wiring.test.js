/**
 * 句末句点清理**确实接进了主链路**，而不是只写了个没人调用的纯函数。
 *
 * 纯函数测试（trailing-dot.test.js）只能证明逻辑对；
 * 这条测的是 callUpstream 里的调用位置：
 *   1. 写缓存之前就必须清理 —— 否则缓存里存的还是带点的版本，
 *      之后每次命中都把点再发出去，清一次等于没清；
 *   2. 清理必须在退款判定之前 —— 否则 "OK." vs 原文 "OK"
 *      会被当成"翻译有变化"而照常扣费。
 *
 * 不连数据库、不连 redis：把 translator / cache 都换成桩。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const { CoreService } = require('../server/services/core-service')

/**
 * 造一个只够跑 callUpstream 的服务实例。
 * 上游固定返回 `upstreamText`，缓存是内存 Map —— 好观察"存进去的是什么"。
 */
function makeService (upstreamText) {
  const store = new Map()
  const writes = []
  const service = Object.create(CoreService.prototype)
  service.translator = {
    translate: async () => ({ ok: true, text: upstreamText }),
    detectLang: () => 'en'
  }
  service.translationCache = {
    get: async () => null,
    set: async (tenant, request, text) => {
      writes.push(text)
      store.set(JSON.stringify(request), text)
    }
  }
  service.allowPublicNetwork = false
  service.engineCredentials = async () => ({})
  // logTranslateRow / settleTranslate 不在本测试范围
  return { service, writes, store }
}

const parsed = (text) => ({ text, from: 'zh', to: 'en', detected: 'zh' })
const session = { kind: 'main', account: { id: 1 }, parent: { id: 1 } }
const engine = { id: 'gpt', name: 'GPT', enabled: true, provider: 'openai' }

test('上游补的句点：进缓存前就被清掉', async () => {
  const { service, writes } = makeService('Are you there.')
  const out = await service.callUpstream({
    session, parsed: parsed('在吗'), engine, engineId: 'gpt'
  })

  assert.equal(out.translated, 'Are you there', '返回给用户的必须没有句点')
  assert.deepEqual(writes, ['Are you there'], '缓存里存的也必须没有句点')
})

test('原文自带句点：缓存里保留，不误删', async () => {
  const { service, writes } = makeService('Are you there.')
  const out = await service.callUpstream({
    session, parsed: parsed('你在吗.'), engine, engineId: 'gpt'
  })

  assert.equal(out.translated, 'Are you there.')
  assert.deepEqual(writes, ['Are you there.'])
})

test('清理发生在退款判定之前：原文 OK、译文 OK. 不该扣费', async () => {
  // 原文 "OK" 没有句点，模型返回 "OK." 加上源文本本身就相同，
  // 清理后 translated === 原文（大小写不敏感）→ 必须判为可退款。
  const { service } = makeService('OK.')
  const out = await service.callUpstream({
    session, parsed: parsed('OK'), engine, engineId: 'gpt'
  })

  assert.equal(out.translated, 'OK')
  assert.equal(out.refundable, true, '清理后与原文一致 → 不该扣字符')
})

test('中文标点与多行不受影响（这条守着"别删多"）', async () => {
  for (const [src, out] of [['原文', '好的。'], ['原文', 'Line one.\nLine two.']]) {
    const { service } = makeService(out)
    const r = await service.callUpstream({
      session, parsed: parsed(src), engine, engineId: 'gpt'
    })
    assert.equal(r.translated, out, `${out} 不该被改动`)
  }
})

test('缓存命中路径也带清理（老缓存里的带点版本会被修正）', async () => {
  // 模拟"清理逻辑上线前就写进缓存"的旧数据
  const { service } = makeService('unused')
  service.translationCache.get = async () => 'Hello there.'

  const out = await service.callUpstream({
    session, parsed: parsed('你好'), engine, engineId: 'gpt'
  })
  assert.equal(out.translated, 'Hello there', '历史缓存里的句点也要清掉')
})
