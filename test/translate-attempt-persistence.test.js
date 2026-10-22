'use strict'

/**
 * 幂等键的「尝试代数」必须能跨进程存活。
 *
 * ## 事故形态
 *
 * 桌面端的键 = 账号 + 内容指纹 + 代数。服务端为某个键建过预留之后，
 * 这个键就**用死了**（重放分支会回上次的响应，或直接 409）。
 * 于是设计是：命中"号用死了"就 `bumpAttempt` 换一代。
 *
 * 问题在于代数只存在**内存**的 Map 里：
 *
 *   · 用户翻译一句话 → 上游超时 → 服务端预留超时退款 → 键进终态；
 *   · 桌面端重试换号 → 又超时（真的是网络烂，不是号的问题）；
 *   · 用户受不了，**重启 App**；
 *   · 代数归零 → 又回到第 0 代 → 那个键在服务端已是终态 →
 *     从此这句话**永远 409 REQUEST_FINALIZED**，直到用户手动改一个字。
 *
 * 这类"重启也治不好"的故障最难查，因为用户的第一反应就是重启，
 * 而重启恰好抹掉了唯一的修复手段。
 */

const test = require('node:test')
const assert = require('node:assert')

const { createTranslationCache, isDeadRequest, createRequestTranslate } =
  require('../desktop/src/translate/translation-cache')

/** 造一个「写进对象、下次能读回」的持久化接口，模拟跨进程重启 */
function makeStore() {
  const disk = {}
  return {
    disk,
    load: () => Object.assign({}, disk),
    save: (value) => { for (const k of Object.keys(disk)) delete disk[k]; Object.assign(disk, value) }
  }
}

function makeCache(store, opts) {
  const o = opts || {}
  return createTranslationCache({
    currentUser: () => 'account-a',
    deviceId: () => 'dev-1',
    crypto: require('crypto'),
    loadAttempts: store ? store.load : undefined,
    saveAttempts: store ? store.save : undefined,
    ...o
  })
}

test('★ 代数必须在"重启"后保留 —— 否则同一句话永久 409', () => {
  const store = makeStore()
  const first = makeCache(store)
  const key0 = first.requestId('hello', 'auto', 'zh', 'deepseek')
  first.bumpAttempt('hello', 'auto', 'zh', 'deepseek')
  // 落盘是 1 秒节流的（防止用户在失败路径上连点刷爆磁盘），
  // 真实退出流程在 before-quit 里会强制 flush —— 这里等价地模拟一次"正常退出"。
  first.flushAttempts()

  // 模拟进程重启：换一个全新的 cache 实例，只带着磁盘上的数据
  const second = makeCache(store)
  const key1 = second.requestId('hello', 'auto', 'zh', 'deepseek')

  assert.notEqual(key1, key0,
    '重启后代数归零，又发回那个已经用死的键 —— 这句话会永远 REQUEST_FINALIZED')
  assert.equal(second.attemptOf('hello', 'auto', 'zh', 'deepseek'), 1, '代数应该从磁盘读回 1')
})

test('代数依然随 bumpAttempt 单调递增，且跨实例连续', () => {
  const store = makeStore()
  for (let i = 0; i < 3; i++) {
    const c = makeCache(store)
    c.bumpAttempt('x', 'auto', 'zh', 'e')
    c.flushAttempts()   // 模拟每次正常退出
  }
  const cache = makeCache(store)
  assert.equal(cache.attemptOf('x', 'auto', 'zh', 'e'), 3)
  assert.match(cache.requestId('x', 'auto', 'zh', 'e'), /:3$/)
})

test('没传持久化接口时退化为内存 Map（不能因此崩掉）', () => {
  const cache = makeCache(null)
  assert.match(cache.requestId('a', 'auto', 'zh', 'e'), /:0$/)
  cache.bumpAttempt('a', 'auto', 'zh', 'e')
  assert.match(cache.requestId('a', 'auto', 'zh', 'e'), /:1$/)
})

test('不同账号 / 不同文本的代数互不干扰', () => {
  const store = makeStore()
  const cache = makeCache(store)
  cache.bumpAttempt('a', 'auto', 'zh', 'e')
  assert.equal(cache.attemptOf('a', 'auto', 'zh', 'e'), 1)
  assert.equal(cache.attemptOf('b', 'auto', 'zh', 'e'), 0)
  assert.equal(cache.attemptOf('a', 'auto', 'ja', 'e'), 0)
})

test('持久化的键不能无限膨胀（用户翻过的文本会一直累积）', () => {
  const store = makeStore()
  const cache = makeCache(store)
  for (let i = 0; i < 5000; i++) cache.bumpAttempt(`text-${i}`, 'auto', 'zh', 'e')
  cache.flushAttempts()
  const saved = store.load()
  assert.ok(Object.keys(saved).length <= 4096,
    `持久化条目 ${Object.keys(saved).length} 条，没有上限会越写越大`)
})

test('★ 退出流程必须强制刷盘（1 秒节流不能吃掉刚产生的代数）', () => {
  const src = require('fs').readFileSync(
    require('path').resolve(__dirname, '../desktop/main.js'), 'utf8')
  assert.match(src, /transCacheApi\.flushAttempts\(\)/,
    'before-quit 里没有 flushAttempts —— "点完重试立刻关掉 App"会丢掉这次换号，重开后又是死键')
  assert.match(src, /loadAttempts:/, 'main.js 没把磁盘上的代数读回 cache')
  assert.match(src, /saveAttempts:/, 'main.js 没把代数写回磁盘')
})

test('replayed/dead 判断仍然按服务端错误码走', () => {
  assert.equal(isDeadRequest({ success: false, code: 'REQUEST_FINALIZED' }), true)
  assert.equal(isDeadRequest({ success: false, code: 'INSUFFICIENT_CHARS' }), false)
  assert.equal(isDeadRequest({ success: 'success' }), false)
})

test('★ 换号重试期间，磁盘上的代数必须同步推进（不然重启又回到死键）', async () => {
  const store = makeStore()
  const cache = makeCache(store)
  let calls = 0
  const requestTranslate = createRequestTranslate({
    api: async () => {
      calls++
      // 第一次直接回"号用死了"，第二次成功
      if (calls === 1) return { success: false, code: 'REQUEST_FINALIZED' }
      return { success: 'success', translation: 'ok' }
    },
    cache,
    retryDelayMs: 0
  })

  const data = await requestTranslate('hi', 'auto', 'zh', 'e', 'manual_click')
  assert.equal(data.translation, 'ok')
  cache.flushAttempts()   // 退出刷盘
  assert.equal(makeCache(store).attemptOf('hi', 'auto', 'zh', 'e'), 1,
    '重试换了号，但新代数没落盘 —— 重启后又会用回那个死键')
})
