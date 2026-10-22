'use strict'

/**
 * 翻译请求的幂等键与「换号重试」守卫。
 *
 * ## 被修的缺陷
 *
 * 客户端的 `requestId` 原来是**内容的纯函数**：`desktop:<设备>:sha256(通道|语向|正文)`。
 * 于是只要失败过一次，这条文本就永久废掉：
 *
 *   厂商 5xx → 服务端退款，预留状态变成 refunded
 *   → 客户端重试，还是同一个 key
 *   → 服务端「该请求已结束，不能重试」409 REQUEST_FINALIZED
 *   → **同一条文本以后永远只能拿到 409**
 *
 * 0.1.11 把失败静默吞掉了，所以这个洞一直没暴露；0.1.12 加了失败提示之后，
 * 它会变成"提示了，但重试也没用"，比静默更糟。
 *
 * ## 另一个更隐蔽的洞：指纹里没有账号
 *
 * 服务端的 `requestHash` 含 `subAccountId`。同一台机器上先用主账号、再切子账号
 * 翻同一句话，会拿同一个 key 打过去，服务端判定 `requestHash` 变了
 * → 409 `IDEMPOTENCY_KEY_REUSED` → 同样永久翻不出来。
 *
 * ## 修法的两个约束（缺一不可）
 *
 *   1. **必须能换号**：服务端说"这个号用死了"时，客户端换新一代重发。
 *   2. **不能无条件换号**：最危险的情况是"服务端已经翻完并扣费、但客户端没读到响应"
 *      （网络抖动）。这时若换新号重发，用户**被扣两次费**。
 *      所以只在服务端明确回"号已终结"时才换代 —— 那种情况服务端**没有**成功译文，
 *      换号不会重复扣费。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const serviceSrc = fs.readFileSync(path.join(root, 'server', 'services', 'core-service.js'), 'utf8')

/**
 * 在隔离上下文里跑幂等相关的**真身**。
 *
 * ## 为什么不再切片 main.js 源码
 *
 * 这段逻辑已经搬进 `desktop/src/translate/translation-cache.js`（纯 Node，
 * 不依赖 electron）。原先它靠 `sliceBlock(mainSrc, ...)` + 手拼依赖来测，
 * 前提是"函数必须留在 main.js 且源码形态不变" —— 那是隐式契约，一动就误报。
 *
 * 现在直接 require 真身，断言一个字没改。测试强度不降反升：它测的是产品
 * 实际调用的那份实现，不再是一份复制出来的源码。
 */
function makeSandbox (responder) {
  const calls = []
  const box = { account: 'ahao' }
  const mod = require('../desktop/src/translate/translation-cache')
  const cache = mod.createTranslationCache({
    currentUser: () => box.account,
    deviceId: () => 'desktop-abc123'
  })
  const requestTranslate = mod.createRequestTranslate({
    api: async (pathname, opts) => {
      calls.push(opts.form)
      return responder(opts.form, calls.length)
    },
    cache,
    // 连接失败后的重试间隔在测试里设 0：真机默认 120ms 是为了等连接池重建，
    // 而这里的假 api 不需要重建，等只会让整套测试凭空慢几百毫秒。
    retryDelayMs: 0,
    getLog: () => null
  })
  return {
    api: {
      transFingerprint: cache.fingerprint,
      transRequestId: cache.requestId,
      bumpTransAttempt: cache.bumpAttempt,
      isDeadRequest: mod.isDeadRequest,
      requestTranslate,
      DEAD_REQUEST_CODES: mod.DEAD_REQUEST_CODES
    },
    calls,
    box,
    cache
  }
}

const OK = { success: true, translation: '你好', chars: 2 }
const dead = code => ({ success: false, code: code, msg: '该请求已结束，不能重试' })
/** 造一个传输层已分类的连接失败错误（与 main.js api() 抛出的形态一致）。 */
const netErr = causeCode => {
  const e = new Error('连不上服务器（' + causeCode + '）')
  e.code = 'NETWORK_UNREACHABLE'
  e.pix = { phase: 'connect', gotResponse: false, causeCode: causeCode, requestId: 'r-1' }
  return e
}

// ---------------------------------------------------------------------------
// 1. 键的构成
// ---------------------------------------------------------------------------

test('同一账号 + 同一内容 → 同一个键（内容去重必须保留）', () => {
  const box = makeSandbox(() => OK)
  const a = box.api.transRequestId('hello', 'auto', 'zh', 'deepseek')
  const b = box.api.transRequestId('hello', 'auto', 'zh', 'deepseek')
  assert.equal(a, b,
    '同一条消息被扫描多次时必须命中同一个键，否则服务端失去按内容去重的能力')
})

test('换账号 → 换键（否则跨账号翻同一句话会永久 409）', () => {
  const box = makeSandbox(() => OK)
  const main = box.api.transRequestId('hello', 'auto', 'zh', 'deepseek')
  box.box.account = 'someOtherUser'
  const sub = box.api.transRequestId('hello', 'auto', 'zh', 'deepseek')
  assert.notEqual(main, sub,
    '服务端的 requestHash 含 subAccountId；指纹里不带账号的话，'
    + '主账号翻过之后子账号再翻同一句话会拿同一个键，被判 IDEMPOTENCY_KEY_REUSED')
})

test('换通道 / 换语向 / 换正文 → 换键', () => {
  const box = makeSandbox(() => OK)
  const base = box.api.transRequestId('hello', 'auto', 'zh', 'deepseek')
  assert.notEqual(base, box.api.transRequestId('hello', 'auto', 'zh', 'gpt'))
  assert.notEqual(base, box.api.transRequestId('hello', 'auto', 'en', 'deepseek'))
  assert.notEqual(base, box.api.transRequestId('hello!', 'auto', 'zh', 'deepseek'))
})

test('键里带代数，换代后一定不同，且长度不超服务端上限 160', () => {
  const box = makeSandbox(() => OK)
  const before = box.api.transRequestId('hello', 'auto', 'zh', 'deepseek')
  box.api.bumpTransAttempt('hello', 'auto', 'zh', 'deepseek')
  const after = box.api.transRequestId('hello', 'auto', 'zh', 'deepseek')
  assert.notEqual(before, after, '换代必须产出不同的键')
  assert.ok(after.length <= 160, '服务端要求 Idempotency-Key 不超过 160 字符')
  assert.match(before, /:0$/, '第 0 代要显式写出来，便于日志里区分')
  assert.match(after, /:1$/)
})

// ---------------------------------------------------------------------------
// 2. 换号重试的行为
// ---------------------------------------------------------------------------

test('服务端说"号已终结"时，原地换号重发一次并返回成功的译文', async () => {
  const box = makeSandbox((form, n) => (n === 1 ? dead('REQUEST_FINALIZED') : OK))
  const out = await box.api.requestTranslate('hello', 'auto', 'zh', 'deepseek', 'auto_receive')

  assert.equal(out.success, true)
  assert.equal(out.translation, '你好')
  assert.equal(box.calls.length, 2, '必须重发一次')
  assert.notEqual(box.calls[0].requestId, box.calls[1].requestId, '重发必须换新键')
  assert.match(box.calls[1].requestId, /:1$/, '重发用的是第 1 代')
})

test('默认失败绝不重发：否则"服务端已扣费但响应读丢"会被扣两次', async () => {
  const box = makeSandbox(() => ({ success: false, code: 'INSUFFICIENT_CHARS', msg: '字符余额不足' }))
  const out = await box.api.requestTranslate('hello', 'auto', 'zh', 'deepseek', 'auto_receive')

  assert.equal(out.code, 'INSUFFICIENT_CHARS')
  assert.equal(box.calls.length, 1,
    '余额不足这类失败的服务端状态没变，换号只会把同一个错误再撞一次')
  // 键也不能被推进：下一轮重试仍应用原号
  assert.match(box.api.transRequestId('hello', 'auto', 'zh', 'deepseek'), /:0$/)
})

test('网络异常时不换代 —— 这是防止重复扣费的关键一条', async () => {
  const box = makeSandbox(() => { throw new Error('socket hang up') })
  await assert.rejects(() => box.api.requestTranslate('hello', 'auto', 'zh', 'deepseek', 'auto_receive'))
  assert.match(box.api.transRequestId('hello', 'auto', 'zh', 'deepseek'), /:0$/,
    '服务端很可能已经翻完并扣了费，只是响应没读到；换号重发会让用户被扣两次')
})

// ---------------------------------------------------------------------------
// 2b. 网络传输层：连接建立失败的安全重试（0.1.20 真机 TRANSLATE_FAILED 的修复）
// ---------------------------------------------------------------------------

test('连接建立失败后恢复：复用同一幂等号自动重试一次，第二次成功', async () => {
  const box = makeSandbox((form, n) => (n === 1 ? (() => { throw netErr('ECONNREFUSED') })() : OK))
  const out = await box.api.requestTranslate('hello', 'auto', 'zh', 'deepseek', 'auto_receive')

  assert.equal(out.success, true, '第二次连上就该成功，不能把偶发网络抖动当成翻译失败')
  assert.equal(box.calls.length, 2, '连接失败必须自动重发一次')
  assert.equal(box.calls[0].requestId, box.calls[1].requestId,
    '重发必须**复用同一个 requestId**（= 同一幂等键）；换号就等于新开一次计费动作')
  assert.match(box.api.transRequestId('hello', 'auto', 'zh', 'deepseek'), /:0$/,
    '网络重试不许换代')
})

test('持续连接失败：最多重发一次就如实上报，仍然不换号、不伪装成功', async () => {
  const box = makeSandbox(() => { throw netErr('ECONNREFUSED') })
  await assert.rejects(
    () => box.api.requestTranslate('hello', 'auto', 'zh', 'deepseek', 'auto_receive'),
    e => e.code === 'NETWORK_UNREACHABLE'
  )
  assert.equal(box.calls.length, 2, '最多两次：首发 + 一次安全重试')
  assert.equal(box.calls[0].requestId, box.calls[1].requestId, '两次都用同一个幂等号')
  assert.match(box.api.transRequestId('hello', 'auto', 'zh', 'deepseek'), /:0$/, '失败也不换代')
})

test('连接中途断开（ECONNRESET）也允许重试一次 —— 幂等号保证不会重复扣费', async () => {
  // 这条测试原本断言"ECONNRESET 不许重试"，理由是"请求可能已经到服务端"。
  // 那个顾虑本身没错，但结论错了：**同一 requestId 重发不会产生第二次计费**。
  //
  // 服务端 core-service.js 的预留流程是：
  //   SELECT ... FROM translation_reservations WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE
  //   命中且 requestHash 相同 → 直接返回已存结果，不再调厂商、不再扣字符。
  // 所以"请求已到达"这一最坏情况，第二次收到的是**已存结果**，账不重复。
  //
  // 反过来，把 ECONNRESET 判死不重试的代价是**真机已验证的掉消息**：
  // 一次 socket 抖动 → 用户看到"网络异常，消息未发送"，原文被退回输入框。
  // 现在它属于连接层失败，重试会更划算。
  const box = makeSandbox(() => { throw netErr('ECONNRESET') })
  await assert.rejects(() => box.api.requestTranslate('hello', 'auto', 'zh', 'deepseek', 'auto_receive'))
  assert.equal(box.calls.length, 2, '首发 + 一次重试')
  assert.equal(box.calls[0].requestId, box.calls[1].requestId,
    '必须复用同一个幂等号 —— 换了号才可能重复扣费')
})

test('已拿到服务端响应（含 502 上游超时）绝不重发，避免重复计费', async () => {
  const box = makeSandbox(() => ({ success: false, code: 'TRANSLATE_FAILED', msg: '上游超时' }))
  const out = await box.api.requestTranslate('hello', 'auto', 'zh', 'deepseek', 'auto_receive')

  assert.equal(out.code, 'TRANSLATE_FAILED')
  assert.equal(box.calls.length, 1, '服务端已经回了话，这不是网络问题，重发只会重复撞同一个错误')
})

test('就算码是网络类，只要 gotResponse=true 也不重发', async () => {
  const box = makeSandbox(() => {
    const e = new Error('x')
    e.code = 'NETWORK_UNREACHABLE'
    e.pix = { phase: 'response', gotResponse: true, causeCode: 'ECONNREFUSED' }
    throw e
  })
  await assert.rejects(() => box.api.requestTranslate('hello', 'auto', 'zh', 'deepseek', 'auto_receive'))
  assert.equal(box.calls.length, 1, '拿到过 HTTP 响应，就不再当作"请求没发出去"')
})

test('连换两个号都还是"号已终结"时就停下，不无限重试', async () => {
  const box = makeSandbox(() => dead('REQUEST_FINALIZED'))
  const out = await box.api.requestTranslate('hello', 'auto', 'zh', 'deepseek', 'auto_receive')

  assert.equal(out.code, 'REQUEST_FINALIZED', '两次都失败就如实上报，不能伪装成成功')
  assert.equal(box.calls.length, 2, '最多重发一次')
  assert.match(box.api.transRequestId('hello', 'auto', 'zh', 'deepseek'), /:2$/,
    '连续失败要再推进一代，下一轮别用已经撞死过的号')
})

test('四个"号已终结"错误码都要触发重发', async () => {
  const { api } = makeSandbox(() => OK)
  for (const code of api.DEAD_REQUEST_CODES) {
    const box = makeSandbox((form, n) => (n === 1 ? dead(code) : OK))
    const out = await box.api.requestTranslate('hello', 'auto', 'zh', 'deepseek', 'auto_receive')
    assert.equal(out.success, true, code + ' 应该触发换号重发并成功')
    assert.equal(box.calls.length, 2, code + ' 应该重发一次')
  }
})

test('换通道重译：服务端明确要求换号时也必须重发（ENGINE_SWITCH_REQUIRES_NEW_REQUEST）', async () => {
  // 换通道会重新计费，服务端故意要客户端换号重发；客户端不换号的话
  // 用户换了通道却永远翻不出来 —— 正是验收里"切 DeepSeek 下一条不翻"的成因之一。
  const box = makeSandbox((form, n) => (n === 1
    ? dead('ENGINE_SWITCH_REQUIRES_NEW_REQUEST')
    : OK))
  const out = await box.api.requestTranslate('hello', 'auto', 'zh', 'gpt', 'auto_receive')
  assert.equal(out.success, true)
  assert.equal(box.calls.length, 2)
})

// ---------------------------------------------------------------------------
// 3. 与服务端错误码的防漂移
// ---------------------------------------------------------------------------

test('客户端认定的"号已终结"错误码必须真的存在于服务端（改名即失效）', () => {
  const { api } = makeSandbox(() => OK)
  assert.ok(api.DEAD_REQUEST_CODES.length >= 4, '至少要覆盖终结 / 过期 / 复用 / 换通道四种')
  for (const code of api.DEAD_REQUEST_CODES) {
    // 服务端把它写成 ApiError 的第三个参数；改名后客户端会静默失去重试能力
    assert.ok(serviceSrc.indexOf("'" + code + "'") >= 0,
      code + ' 在 core-service.js 里不存在了 —— 客户端会静默停止换号重试，'
      + '这条文本将永久翻不出来')
  }
})

test('服务端确实会在这些错误码上拒绝重试（不是客户端凭空假设）', () => {
  assert.match(serviceSrc, /REQUEST_FINALIZED/, '预留已终结必须回这个码')
  assert.match(serviceSrc, /RESERVATION_EXPIRED/, '预留超时必须回这个码')
  assert.match(serviceSrc, /IDEMPOTENCY_KEY_REUSED/, '键被别的请求体占用必须回这个码')
  assert.match(serviceSrc, /ENGINE_SWITCH_REQUIRES_NEW_REQUEST/, '换通道重译必须回这个码')
})
