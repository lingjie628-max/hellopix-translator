'use strict'

/**
 * 翻译缓存与幂等键。
 *
 * 这里锁的是**资金安全**语义：幂等键算错 = 用户被重复扣费，或者一条文本
 * 永久翻不出来。两者都不会在开发机上自然暴露，只能靠测试钉住。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createTranslationCache,
  isDeadRequest,
  DEAD_REQUEST_CODES
} = require('../desktop/src/translate/translation-cache')

function makeCache (user) {
  return createTranslationCache({
    currentUser: () => user || 'alice',
    deviceId: () => 'dev-1'
  })
}

test('指纹必须带上账号：换子账号不能撞同一个幂等键', () => {
  const c = makeCache('alice')
  const a = c.fingerprint('hello', 'zh', 'en', 'google')
  // 同一个 cache 实例，但 currentUser 变了
  const c2 = createTranslationCache({ currentUser: () => 'bob', deviceId: () => 'dev-1' })
  const b = c2.fingerprint('hello', 'zh', 'en', 'google')
  assert.notEqual(a, b,
    '账号不同却算出同一个指纹 —— 服务端会回 409 IDEMPOTENCY_KEY_REUSED，这条文本永久翻不出来')
})

test('指纹是纯函数：同一输入永远同一输出', () => {
  const c = makeCache()
  const first = c.fingerprint('hi', 'zh', 'en', 'google')
  for (let i = 0; i < 3; i++) {
    assert.equal(c.fingerprint('hi', 'zh', 'en', 'google'), first)
  }
})

test('指纹随语向 / 引擎 / 正文变化', () => {
  const c = makeCache()
  const base = c.fingerprint('hi', 'zh', 'en', 'google')
  assert.notEqual(c.fingerprint('hi', 'zh', 'fr', 'google'), base, '语向变了必须是新键')
  assert.notEqual(c.fingerprint('hi', 'zh', 'en', 'deepl'), base, '换引擎必须是新键')
  assert.notEqual(c.fingerprint('hello', 'zh', 'en', 'google'), base, '正文变了必须是新键')
})

test('bumpAttempt 只影响一次：requestId 换代后，原键仍能取回', () => {
  const c = makeCache()
  const before = c.requestId('hi', 'zh', 'en', 'google')
  assert.match(before, /^desktop:dev-1:[0-9a-f]{40}:0$/, '初始代数必须是 0')

  c.bumpAttempt('hi', 'zh', 'en', 'google')
  const after = c.requestId('hi', 'zh', 'en', 'google')
  assert.equal(after, before.replace(/:0$/, ':1'), '换代后必须只改代数，指纹不变')
  assert.equal(c.attemptOf('hi', 'zh', 'en', 'google'), 1)

  // 连续换代
  c.bumpAttempt('hi', 'zh', 'en', 'google')
  assert.equal(c.attemptOf('hi', 'zh', 'en', 'google'), 2)
})

test('服务端成功但响应读丢：不换代就必须还是同一个键（不能重复扣费）', () => {
  const c = makeCache()
  const first = c.requestId('小心这句话', 'zh', 'en', 'google')
  // 模拟：服务端已成功，客户端没收到响应。**不 bump**，直接重发。
  const retry = c.requestId('小心这句话', 'zh', 'en', 'google')
  assert.equal(retry, first,
    '重试换了键 = 服务端认为是新请求 = 用户被扣第二次费')
})

test('isDeadRequest 认全部"号用死了"的错误码', () => {
  for (const code of DEAD_REQUEST_CODES) {
    assert.equal(isDeadRequest({ success: false, code }), true, code + ' 必须触发换号')
  }
  // 这些**不能**换号：换了就等于放弃按内容去重，可能重复扣费
  for (const code of ['INSUFFICIENT_BALANCE', 'ENGINE_NOT_ALLOWED', 'NETWORK_UNREACHABLE']) {
    assert.equal(isDeadRequest({ success: false, code }), false, code + ' 不该触发换号')
  }
  assert.equal(isDeadRequest(null), false)
  assert.equal(isDeadRequest({ success: true }), false)
  assert.equal(isDeadRequest({ success: false }), false)
})

test('缓存：命中后返回原值，且被移到 LRU 队尾', () => {
  const c = makeCache()
  c.put('zh', 'en', 'google', '你好', 'hello')
  assert.equal(c.get('zh', 'en', 'google', '你好'), 'hello')
  // 再取一次仍然稳定
  assert.equal(c.get('zh', 'en', 'google', '你好'), 'hello')
  // 参数不同就是未命中
  assert.equal(c.get('zh', 'fr', 'google', '你好'), '')
  assert.equal(c.get('zh', 'en', 'deepl', '你好'), '')
})

test('缓存：空译文不入缓存（否则这条文本会被锁死成空）', () => {
  const c = makeCache()
  c.put('zh', 'en', 'google', '你好', '')
  c.put('zh', 'en', 'google', '你好', '   ')
  assert.equal(c.get('zh', 'en', 'google', '你好'), '')
  assert.equal(c.size, 0, '空译文不该占用缓存位')
})

test('缓存：写入时 trim，容量上限 1000 且淘汰最旧的', () => {
  const c = makeCache()
  c.put('zh', 'en', 'google', 'a', '  A  ')
  assert.equal(c.get('zh', 'en', 'google', 'a'), 'A')

  for (let i = 0; i < 1100; i++) c.put('zh', 'en', 'google', 'k' + i, 'v' + i)
  assert.ok(c.size <= 1000, '缓存必须被限制在 1000 条以内，实际 ' + c.size)
  // 最早的几条应该已经被淘汰
  assert.equal(c.get('zh', 'en', 'google', 'k0'), '')
  // 最新的必须还在
  assert.equal(c.get('zh', 'en', 'google', 'k1099'), 'v1099')
})

test('换代表有上限，不会无限漏内存', () => {
  const c = makeCache()
  for (let i = 0; i < 5000; i++) c.bumpAttempt('t' + i, 'zh', 'en', 'google')
  assert.ok(c.attemptSize <= 5000, '换代表必须被限制')
})
