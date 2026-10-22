/**
 * 连接失败的**重试覆盖度**：一次抖动不该变成"消息未发送"。
 *
 * ## 真机现场
 *
 * 2026-10-21 用户截图：翻译弹「网络异常，消息未发送 / 连不上服务器」，
 * 原文被退回输入框。同时间段服务端日志里 13 次 `/translate/run` **全部 200**，
 * 状态码分布 985×200 —— 后端完全正常。
 *
 * 根因不是"没写重试"（重试早就有了），而是**两份白名单不一致**：
 *
 *   · `api-net.classify()` 把走不到响应头的失败统统归成 `NETWORK_UNREACHABLE`
 *     （它的判据很宽：连接超时 + 一串 connect 类 code）；
 *   · `translation-cache.isRetryableNetworkError()` 只放行其中 6 个 code。
 *
 * 于是 `ECONNRESET` / `EPIPE` / `UND_ERR_SOCKET` 这些**千真万确属于连接层**的
 * 失败被归了类、却不重试 —— 用户一次抖动就吃"连不上服务器"。
 *
 * 这里把"两边必须一致"写成可执行的断言：以后谁改了一边忘了另一边，测试会红。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const tc = require('../desktop/src/translate/translation-cache')

/** 从 api-net.js 源码里抠出 classify() 的连接类 code 名单。 */
function classifyConnectCodes () {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'desktop/src/net/api-net.js'), 'utf8')
  const at = src.indexOf('const connectLike =')
  assert.ok(at >= 0, '找不到 connectLike')
  const block = src.slice(at, src.indexOf('>= 0', at))
  return (block.match(/'([A-Z_]+)'/g) || []).map(s => s.replace(/'/g, ''))
}

function retryable (causeCode, gotResponse) {
  return tc.isRetryableNetworkError({
    code: 'NETWORK_UNREACHABLE',
    pix: { gotResponse: !!gotResponse, causeCode }
  })
}

test('两份名单的对应关系：可重试名单必须是"连接类"的超集', () => {
  const codes = classifyConnectCodes()
  assert.ok(codes.length >= 6, '至少应该抠出 6 个 code，实际 ' + codes.length)
  // 连接类失败（请求确实没发出去）必须全部可重试 —— 少一个就是白挨一次失败。
  const missing = codes.filter(c => !retryable(c))
  assert.deepEqual(missing, [],
    '这些 code 属于连接类却不可重试（真机掉消息就是这么来的）：' + missing.join(', '))
})

test('phase 与可重试是两件事：连接后断开的可重试，但 phase 仍如实记 response', () => {
  const api = require('../desktop/src/net/api-net')
  // ECONNRESET 发生在连接建立之后 —— phase 必须如实反映这一点
  const err = new Error('x')
  err.cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  const out = api.classifyTransportError
    ? api.classifyTransportError(err, { path: '/translate/run' })
    : null
  if (out) {
    assert.equal(out.code, 'NETWORK_UNREACHABLE')
    assert.equal(out.pix.phase, 'response', '连接已建立，phase 不该谎报成 connect')
  }
  // 但在"没拿到响应"的前提下，它仍然可以安全重发
  assert.ok(retryable('ECONNRESET'), '连接后断开仍可重试：复用同一幂等号不会重复计费')
})

test('曾经漏掉、直接导致真机掉消息的那几个 code，现在必须可重试', () => {
  // 这几个是 classify 归了类、旧白名单却没放的 —— 真机现场最可能就是它们。
  for (const code of ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']) {
    assert.ok(retryable(code), code + ' 必须可重试（连接层失败，请求没发出去）')
  }
})

test('安全红线：已经拿到响应头的，一律不许重试（可能已扣费）', () => {
  for (const code of classifyConnectCodes()) {
    assert.equal(retryable(code, true), false,
      code + ' 在 gotResponse=true 时绝不能重试 —— 请求可能已经到达服务端')
  }
})

test('安全红线：非 NETWORK_UNREACHABLE 的错误码不许被判可重试', () => {
  for (const code of ['NETWORK_TIMEOUT', 'NETWORK_BACKOFF', 'SERVER_BAD_RESPONSE', '']) {
    assert.equal(tc.isRetryableNetworkError({
      code, pix: { gotResponse: false, causeCode: 'ECONNRESET' }
    }), false, code + ' 不该走连接层重试')
  }
})

test('未知 / 空 causeCode 保守处理：不重试', () => {
  assert.equal(retryable('SOMETHING_NEW'), false)
  assert.equal(retryable(''), false)
  assert.equal(tc.isRetryableNetworkError(null), false)
  assert.equal(tc.isRetryableNetworkError({}), false)
  assert.equal(tc.isRetryableNetworkError({ code: 'NETWORK_UNREACHABLE' }), false, '没有 pix 信息时不该猜')
})

test('重试前必须有间隔：recycle() 之后立刻重发是白给', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'desktop/src/translate/translation-cache.js'), 'utf8')
  assert.ok(/translateRetryDelayMs/.test(src), '必须有重试间隔的实现')
  // 重试分支里必须 await 一个等待，不能直接再 call()
  const retryBlock = src.slice(src.indexOf('if (!retryable(err)) throw err'))
  const head = retryBlock.slice(0, 900)
  assert.ok(/await new Promise/.test(head), '重发前必须真的等一会儿（否则撞上还没重建好的连接池）')
})

test('getTranslateRetryDelay：默认 120ms，可注入 0 给测试用', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'desktop/src/translate/translation-cache.js'), 'utf8')
  assert.ok(/return Number\.isFinite\(n\) && n >= 0 \? n : 120/.test(src), '默认值应为 120ms')
})

test('手动动作必须绕过退避（用户点了重试不该被"网络恢复中"挡住）', () => {
  assert.ok(tc.isManualTrigger('manual_send'))
  assert.ok(tc.isManualTrigger('retranslate'))
  assert.ok(tc.isManualTrigger('manual_click'))
  // 自动行为仍受退避约束，避免断网时刷爆日志
  assert.equal(tc.isManualTrigger('auto_receive'), false)
  assert.equal(tc.isManualTrigger(''), false)
})
