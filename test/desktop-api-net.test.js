'use strict'

/**
 * API 传输层：连接超时控制 / 错误分类 / 可安全重试判定。
 *
 * ## 为什么单开这个文件
 *
 * 0.1.20 macOS 真机复现过一次 `TRANSLATE_FAILED`：请求**根本没到服务端**，
 * 客户端白等约 10.4s，根因是 undici 的**默认连接超时 10s**（`UND_ERR_CONNECT_TIMEOUT`）。
 *
 * 两种"看起来能修"的做法都被否决过：
 *   · 给整个翻译请求设 4s 超时 → 会把正常的慢翻译（上游最坏 8s）一起砍掉；
 *   · 先建一条 TCP 探连通性 → 那是**另一条连接**，控不住 undici 的连接超时，
 *     还每次请求白加一次握手。
 *
 * 采用的方案：**用自带 undici 的 `Agent({ connect: { timeout } })`**。
 * 连接阶段与响应阶段天然分开：连接超时只管建连，响应由 headersTimeout / bodyTimeout
 * 兜底 —— 零额外连接、真控制超时、不误伤慢响应。
 *
 * 这里跑的是 main.js 里的**真源码**（按花括号配对切出来），不是复制一份实现。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')

/** 按花括号配对，把 main.js 里某个函数的真身整段切出来。 */
function sliceBlock(src, header) {
  const start = src.indexOf(header)
  assert.ok(start >= 0, '找不到源码片段：' + header)
  const lineEnd = src.indexOf('\n', start)
  const line = src.slice(start, lineEnd)
  const open = line.indexOf('{')
  if (open < 0) return line
  let depth = 0
  for (let i = start + open; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error('花括号不配对：' + header)
}

/** 从 startMarker 切到 endMarker（含），用于切常量/let 声明块。 */
function sliceFromTo(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker)
  assert.ok(start >= 0, '找不到起点：' + startMarker)
  const end = src.indexOf(endMarker, start)
  assert.ok(end > start, '找不到终点：' + endMarker)
  return src.slice(start, end + endMarker.length)
}

/**
 * 在隔离上下文里跑传输层真身。
 * `fakeUndici` 传 null 表示"装不上 undici"，用来验退回全局 fetch 的分支。
 */
function loadNetApi(fakeUndici, extra) {
  const src = [
    sliceFromTo(mainSrc, 'const API_CONNECT_TIMEOUT_MS', 'let apiLibTried = false'),
    sliceBlock(mainSrc, 'function apiTransport()'),
    sliceBlock(mainSrc, 'function apiDispatcher()'),
    sliceBlock(mainSrc, 'function closeApiAgents()'),
    sliceBlock(mainSrc, 'function apiRaw(url, init)'),
    sliceBlock(mainSrc, 'function isRetryableNetworkError(err)'),
    sliceBlock(mainSrc, 'function apiFailure(code, message, info)'),
    sliceBlock(mainSrc, 'function classifyTransportError(err, baseInfo)')
  ].join('\n\n')

  const fetchCalls = []
  const ctx = vm.createContext(Object.assign({
    URL: URL,
    AbortSignal: AbortSignal,
    clientLog: null,
    require: () => { if (fakeUndici) return fakeUndici; const e = new Error('MODULE_NOT_FOUND'); e.code = 'MODULE_NOT_FOUND'; throw e },
    fetch: (url, init) => { fetchCalls.push({ url: url, init: init }); return Promise.resolve({ via: 'global-fetch' }) }
  }, extra || {}))

  vm.runInContext(src
    + '\nglobalThis.__net = {'
    + ' apiTransport, apiDispatcher, closeApiAgents, apiRaw, isRetryableNetworkError, classifyTransportError,'
    + ' setWarm: v => { apiNetWarm = v }, getAgents: () => apiAgents }',
  ctx)
  const api = ctx.__net
  api.fetchCalls = fetchCalls
  return api
}

/** 一个假的 undici：记下 Agent 的构造参数与 fetch 的 dispatcher，便于断言。 */
function fakeUndiciLib() {
  const agents = []
  const lib = {
    Agent: function (opts) { this.opts = opts; this.closed = false; this.close = () => { this.closed = true }; agents.push(this) },
    fetch: (url, init) => Promise.resolve({ via: 'undici', url: url, dispatcher: init && init.dispatcher }),
    agents: agents
  }
  return lib
}

// ---------------------------------------------------------------------------
// 1. 连接超时由我们自己的 undici Agent 控制
// ---------------------------------------------------------------------------

test('apiDispatcher：冷启动用 8s、热路径用 4s，连接超时与响应超时分开设', () => {
  const lib = fakeUndiciLib()
  const api = loadNetApi(lib)

  const cold = api.apiDispatcher()
  assert.equal(cold.opts.connect.timeout, 8000, '冷启动首次要更宽（DNS + TLS 握手）')
  assert.equal(cold.opts.headersTimeout, 30000, '响应阶段单独兜底，必须是另一个数')
  assert.equal(cold.opts.bodyTimeout, 30000)

  api.setWarm(true)
  const warm = api.apiDispatcher()
  assert.equal(warm.opts.connect.timeout, 4000, '热路径连接超时压到 4s')
  assert.notEqual(cold, warm, '冷/热必须是两个 Agent，不能共用一个定死的超时')
})

test('apiDispatcher：Agent 只构造一次（连接池要复用，不能每请求新建）', () => {
  const lib = fakeUndiciLib()
  const api = loadNetApi(lib)
  api.apiDispatcher(); api.apiDispatcher(); api.apiDispatcher()
  api.setWarm(true)
  api.apiDispatcher(); api.apiDispatcher()
  assert.equal(lib.agents.length, 2, '只应有冷/热两个 Agent')
})

test('apiDispatcher：装不上 undici 时返回 undefined（不崩，交给调用方退回）', () => {
  const api = loadNetApi(null)
  assert.equal(api.apiDispatcher(), undefined)
})

test('apiRaw：优先用自带 undici 且带上 dispatcher；装不上才退回全局 fetch', async () => {
  const lib = fakeUndiciLib()
  const api = loadNetApi(lib)
  const r1 = await api.apiRaw('https://example.test/apis/x', { method: 'GET' })
  assert.equal(r1.via, 'undici', '必须走自带 undici（连接超时可控）')
  assert.ok(r1.dispatcher, '必须把 Agent 作为 dispatcher 传下去')
  assert.equal(api.fetchCalls.length, 0, '不该用全局 fetch')

  const api2 = loadNetApi(null)
  const r2 = await api2.apiRaw('https://example.test/apis/x', { method: 'GET' })
  assert.equal(r2.via, 'global-fetch', '装不上 undici 时退回全局 fetch，绝不抛死')
})

test('closeApiAgents：退出时把冷/热两个连接池都收掉', () => {
  const lib = fakeUndiciLib()
  const api = loadNetApi(lib)
  api.apiDispatcher()
  const agents = api.getAgents()
  api.closeApiAgents()
  assert.equal(agents.cold.closed, true)
  assert.equal(agents.warm.closed, true)
  assert.equal(api.getAgents(), null, '引用要清掉，避免退出后又被复用')
})

// ---------------------------------------------------------------------------
// 2. 错误分类
// ---------------------------------------------------------------------------

function netErr(code, name, message) {
  const e = new Error('fetch failed')
  e.name = name || 'TypeError'
  e.cause = { code: code, message: message || ('底层：' + code) }
  return e
}

test('DNS / 连接建立类错误 → NETWORK_UNREACHABLE，取证字段齐全', () => {
  const api = loadNetApi(fakeUndiciLib())
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH']) {
    const out = api.classifyTransportError(netErr(code), {
      path: '/translate/run', method: 'POST', requestId: 'desktop:dev:abc:0', elapsedMs: 4200
    })
    assert.equal(out.code, 'NETWORK_UNREACHABLE', code + ' 必须归成"连不上"')
    assert.equal(out.pix.gotResponse, false, code + ' 必须记录"没拿到 HTTP 响应"')
    assert.equal(out.pix.phase, 'connect', code + ' 必须记录阶段=连接建立')
    assert.equal(out.pix.causeCode, code, code + ' 必须保留底层 err.cause.code')
    assert.equal(out.pix.causeMessage, '底层：' + code, code + ' 必须保留底层 err.cause.message')
    assert.equal(out.pix.errName, 'TypeError', code + ' 必须保留 err.name')
    assert.equal(out.pix.requestId, 'desktop:dev:abc:0', code + ' 必须记录 requestId')
    assert.equal(out.pix.elapsedMs, 4200, code + ' 必须记录请求耗时')
  }
})

test('★ 连接超时**必须**归成"连不上"（可安全重试），不能被 Timeout 字样带偏', () => {
  const api = loadNetApi(fakeUndiciLib())
  // 真机取证：undici 的连接超时错误名并不保证叫 TimeoutError
  for (const name of ['TimeoutError', 'ConnectTimeoutError', 'TypeError']) {
    const out = api.classifyTransportError(netErr('UND_ERR_CONNECT_TIMEOUT', name), { path: '/translate/run' })
    assert.equal(out.code, 'NETWORK_UNREACHABLE', name + '：连接超时必须判为不可达')
    assert.equal(out.pix.phase, 'connect')
    assert.equal(api.isRetryableNetworkError(out), true, name + '：连接超时应允许安全重试')
  }
})

test('响应阶段超时（headers/body）→ NETWORK_TIMEOUT，且不自动重试', () => {
  const api = loadNetApi(fakeUndiciLib())
  for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
    const out = api.classifyTransportError(netErr(code, 'HeadersTimeoutError'), { path: '/translate/run' })
    assert.equal(out.code, 'NETWORK_TIMEOUT', code + ' 应归为响应超时')
    assert.equal(api.isRetryableNetworkError(out), false, code + ' 不该自动重发')
  }
  const aborted = new Error('The operation was aborted due to timeout')
  aborted.name = 'TimeoutError'
  const out2 = api.classifyTransportError(aborted, { path: '/translate/run' })
  assert.equal(out2.code, 'NETWORK_TIMEOUT', 'AbortSignal 整体超时应归为响应超时')
})

test('连接建立之后再断（ECONNRESET）→ 阶段是"等响应"，不可重试', () => {
  const api = loadNetApi(fakeUndiciLib())
  const out = api.classifyTransportError(netErr('ECONNRESET', 'TypeError', 'socket hang up'), { path: '/translate/run' })
  assert.equal(out.code, 'NETWORK_UNREACHABLE')
  assert.equal(out.pix.phase, 'response', '连接已建立过，不该记成连接阶段失败')
  assert.equal(api.isRetryableNetworkError(out), false, '是否送达不确定，不能自动重发')
})

test('失败会被记一条日志，字段齐全且不含任何凭据', () => {
  const logs = []
  const api = loadNetApi(fakeUndiciLib(), { clientLog: { warn: (scope, msg) => logs.push(scope + ' ' + msg) } })
  api.classifyTransportError(netErr('ENOTFOUND', 'TypeError', 'getaddrinfo ENOTFOUND pixfanyi.com'), {
    path: '/translate/run', method: 'POST', requestId: 'desktop:dev:abc:0', elapsedMs: 2000
  })
  assert.equal(logs.length, 1, '必须落一条可检索的日志')
  assert.ok(logs[0].indexOf('api') === 0, '作用域应为 api')
  assert.match(logs[0], /NETWORK_UNREACHABLE/)
  assert.match(logs[0], /ENOTFOUND/)
  assert.match(logs[0], /requestId/)
  assert.ok(!/cookie|token|password|authorization/i.test(logs[0]), '日志不得出现敏感字段')
})

// ---------------------------------------------------------------------------
// 3. 可安全重试的判定
// ---------------------------------------------------------------------------

test('isRetryableNetworkError：只放行"请求还没发出去"的连接类错误', () => {
  const api = loadNetApi(fakeUndiciLib())
  const mk = (code, pix) => { const e = new Error('x'); e.code = code; e.pix = pix; return e }

  for (const c of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']) {
    assert.equal(api.isRetryableNetworkError(mk('NETWORK_UNREACHABLE', { gotResponse: false, causeCode: c })), true, c)
  }
  assert.equal(api.isRetryableNetworkError(mk('NETWORK_UNREACHABLE', { gotResponse: false, causeCode: 'ECONNRESET' })), false,
    '连接建立之后才断，是否送达不确定')
  assert.equal(api.isRetryableNetworkError(mk('NETWORK_UNREACHABLE', { gotResponse: true, causeCode: 'ECONNREFUSED' })), false,
    '已拿到 HTTP 响应，不再是"没发出去"')
  assert.equal(api.isRetryableNetworkError(mk('NETWORK_TIMEOUT', { gotResponse: false, causeCode: 'UND_ERR_HEADERS_TIMEOUT' })), false,
    '响应超时说明服务端可能已在处理，不盲目重发')
  assert.equal(api.isRetryableNetworkError(mk('TRANSLATE_FAILED', { gotResponse: true, causeCode: '502' })), false,
    '502 是服务端的答复，不是网络问题')
  assert.equal(api.isRetryableNetworkError(new Error('socket hang up')), false,
    '没有分类的旧式错误保持保守，不重试')
})

// ---------------------------------------------------------------------------
// 4. 接线守卫（行为测试跑不到的地方，用源码断言兜住）
// ---------------------------------------------------------------------------

test('接线守卫：已彻底移除 TCP 预检（在正常路径上不额外建连接）', () => {
  assert.ok(mainSrc.indexOf('probeTcp') < 0, 'TCP 预检必须删干净，不能留在正常路径上')
  assert.ok(mainSrc.indexOf('apiHostPort') < 0, '预检用的 host 解析也要删掉')
  assert.ok(mainSrc.indexOf("require('net')") < 0, 'main.js 不该再为预检引入 net')
})

test('接线守卫：api() 直接发请求，并用自带 undici 的连接超时', () => {
  assert.match(mainSrc, /res = await apiRaw\(base \+ '\/apis' \+ pathname, init\)/, 'api() 必须直接走 apiRaw')
  assert.match(mainSrc, /lib\.fetch\(url, Object\.assign\(\{ dispatcher: dispatcher \}, init\)\)/,
    '必须用自带 undici 且带上 dispatcher（连接超时归我们管）')
  assert.match(mainSrc, /new lib\.Agent\(\{[\s\S]{0,200}?connect: \{ timeout: API_CONNECT_TIMEOUT_MS \}/,
    'Agent 必须显式设置连接超时')
  assert.match(mainSrc, /const API_CONNECT_TIMEOUT_MS = 4000/)
  assert.match(mainSrc, /const API_CONNECT_TIMEOUT_FIRST = 8000/)
  assert.match(mainSrc, /const API_TOTAL_TIMEOUT_MS = 30000/)
  assert.ok(!/totalTimeoutMs:\s*4000/.test(mainSrc),
    '禁止把"整个翻译请求"设成 4 秒超时 —— 那会把正常翻译也砍掉')
})

test('接线守卫：连接超时与响应超时是两个独立参数（不是一个数两头用）', () => {
  const connect = mainSrc.match(/connect: \{ timeout: API_CONNECT_TIMEOUT_MS \}/)
  const headers = mainSrc.match(/headersTimeout: API_TOTAL_TIMEOUT_MS/)
  const body = mainSrc.match(/bodyTimeout: API_TOTAL_TIMEOUT_MS/)
  assert.ok(connect && headers && body, '连接超时 / 响应头超时 / 响应体超时都要分别设置')
  assert.ok(Number(mainSrc.match(/const API_TOTAL_TIMEOUT_MS = (\d+)/)[1])
    > Number(mainSrc.match(/const API_CONNECT_TIMEOUT_MS = (\d+)/)[1]) * 5,
  '响应兜底必须远大于连接预算，否则慢翻译会被误杀')
})

test('依赖守卫：undici 必须是运行时依赖，否则连接超时控制会静默失效', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'))
  assert.ok(pkg.dependencies && pkg.dependencies.undici, 'package.json 必须声明 undici 依赖')
})
