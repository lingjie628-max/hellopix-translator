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

const root = path.join(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')

/**
 * 构造一份传输层真身。
 *
 * 原先靠 `sliceBlock(mainSrc, ...)` 从 main.js 抠源码、再塞进 VM 手拼依赖。
 * 这段逻辑已经搬进 `desktop/src/net/api-net.js`（纯 Node，不依赖 electron），
 * 现在直接调工厂 —— 测的是产品实际调用的那份实现，不是复制出来的源码。
 *
 * @param {object|null} fakeUndici  传 null 表示"装不上 undici"
 * @param {object} [extra]          额外覆盖项（目前用于注入 clientLog）
 */
function loadNetApi (fakeUndici, extra) {
  const mod = require('../desktop/src/net/api-net')
  const fetchCalls = []
  const ctx = Object.assign({
    clientLog: null,
    fetch: (url, init) => {
      fetchCalls.push({ url: url, init: init })
      return Promise.resolve({ via: 'global-fetch' })
    }
  }, extra || {})

  const net = mod.createApiNet({
    // 必须与产品默认一致；产品侧从 main.js 的同名常量传入
    timeouts: {
      connectFirstMs: 8000,
      connectMs: 4000,
      totalMs: 30000
    },
    getLog: () => ctx.clientLog || null,
    // 注入：假 undici / 假全局 fetch。生产不传，走真实实现。
    requireUndici: () => {
      if (fakeUndici) return fakeUndici
      const e = new Error('MODULE_NOT_FOUND')
      e.code = 'MODULE_NOT_FOUND'
      throw e
    },
    fetch: ctx.fetch
  })
  net.fetchCalls = fetchCalls
  // 兼容测试里的命名（产品模块用的是短名）
  net.setWarm = net.markWarm
  net.getAgents = net.__agents
  net.apiTransport = net.transport
  net.apiDispatcher = net.dispatcher
  net.closeApiAgents = net.close
  net.apiRaw = net.raw
  net.apiFailure = net.failure
  net.classifyTransportError = net.classify
  // isRetryableNetworkError 属于幂等/重试模块，但测试在这里一起验，转出去
  net.isRetryableNetworkError = require('../desktop/src/translate/translation-cache').isRetryableNetworkError
  return net
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
  // 实现已搬进 src/net/api-net.js；这里同时检查 main.js 的接线与实现的约束。
  const netSrc = fs.readFileSync(path.join(root, 'desktop', 'src', 'net', 'api-net.js'), 'utf8')
  assert.match(mainSrc, /res = await apiRaw\(base \+ '\/apis' \+ pathname, init\)/, 'api() 必须直接走 apiRaw')
  assert.match(netSrc, /l\.fetch\(url, Object\.assign\(\{ dispatcher: disp \}, init\)\)/,
    '必须用自带 undici 且带上 dispatcher（连接超时归我们管）')
  // 热路径连接预算：2026-10-20 真机取证后从 4000 提到 8000（链路间歇丢 SYN）
  assert.match(mainSrc, /const API_CONNECT_TIMEOUT_MS = 8000/)
  assert.match(mainSrc, /const API_CONNECT_TIMEOUT_FIRST = 8000/)
  assert.match(mainSrc, /const API_TOTAL_TIMEOUT_MS = 30000/)
  assert.ok(!/totalTimeoutMs:\s*4000/.test(mainSrc),
    '禁止把"整个翻译请求"设成 4 秒超时 —— 那会把正常翻译也砍掉')
  // 数字必须真从 main.js 流进工厂，不能各写一份
  assert.match(mainSrc, /connectFirstMs:\s*API_CONNECT_TIMEOUT_FIRST/)
  assert.match(mainSrc, /connectMs:\s*API_CONNECT_TIMEOUT_MS/)
  assert.match(mainSrc, /totalMs:\s*API_TOTAL_TIMEOUT_MS/)
  assert.match(mainSrc, /backoffMs:\s*API_CONNECT_BACKOFF_MS/,
    '退避阶梯必须从 main.js 流进工厂')
})

test('接线守卫：连接超时与响应超时是两个独立参数（不是一个数两头用）', () => {
  const netSrc = fs.readFileSync(path.join(root, 'desktop', 'src', 'net', 'api-net.js'), 'utf8')
  const connect = netSrc.match(/connect: \{ timeout: timeout\.connectMs \}/)
  const headers = netSrc.match(/headersTimeout: timeout\.totalMs/)
  const body = netSrc.match(/bodyTimeout: timeout\.totalMs/)
  assert.ok(connect && headers && body, '连接超时 / 响应头超时 / 响应体超时都要分别设置')
  // 冷启动那一路用的是更宽的 connectFirstMs，不能被合并成同一个数
  assert.match(netSrc, /connect: \{ timeout: timeout\.connectFirstMs \}/,
    '冷启动必须用独立的连接预算')
  // 响应兜底必须明显大于连接预算（至少 3 倍），否则慢翻译会被误杀。
  //
  // 不能要求"5 倍以上"：连接预算从 4s 提到 8s（链路间歇丢 SYN）之后，
  // 5 倍就是 40s，而 30s 的整体兜底本来就是为了给上游留足余量 —— 两者不矛盾。
  const connectMs = Number(mainSrc.match(/const API_CONNECT_TIMEOUT_MS = (\d+)/)[1])
  const totalMs = Number(mainSrc.match(/const API_TOTAL_TIMEOUT_MS = (\d+)/)[1])
  assert.ok(totalMs >= connectMs * 3,
    '响应兜底必须明显大于连接预算（≥3 倍），否则慢翻译会被误杀；当前 ' + totalMs + ' vs ' + connectMs)
})

test('依赖守卫：undici 必须是运行时依赖，否则连接超时控制会静默失效', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'))
  assert.ok(pkg.dependencies && pkg.dependencies.undici, 'package.json 必须声明 undici 依赖')
})

// ---------------------------------------------------------------------------
// 5. 连接失败后的退避与连接池重建
// ---------------------------------------------------------------------------
// 真机取证（2026-10-20）：`UND_ERR_CONNECT_TIMEOUT` 每 8 秒刷一条，连续 25 分钟。
// 两个问题：
//   ① 轮询不带退避，撞在同一个丢包窗口上一遍遍重试，日志一天 190 条；
//   ② 连接失败后不重建连接池，池里留着半死的 socket，可能"自己好不了"。

test('退避：首次失败不惩罚，连续失败按阶梯递增', () => {
  const api = loadNetApi(fakeUndiciLib())
  assert.equal(api.backoffRemaining(), 0, '初始不该有任何等待')

  api.noteResult('NETWORK_UNREACHABLE')
  assert.equal(api.failures(), 1)
  assert.equal(api.backoffRemaining(), 0, '第一次失败仍立即重试（可能是瞬时抖动）')

  api.noteResult('NETWORK_UNREACHABLE')
  assert.ok(api.backoffRemaining() > 0, '连续第二次失败后必须开始等')

  const waits = []
  for (let i = 0; i < 4; i++) {
    api.noteResult('NETWORK_UNREACHABLE')
    waits.push(Math.round(api.backoffRemaining() / 1000))
  }
  for (let i = 1; i < waits.length; i++) {
    assert.ok(waits[i] >= waits[i - 1], '退避必须是单调递增的，不能忽长忽短：' + waits.join(','))
  }
  assert.ok(waits[waits.length - 1] <= 30, '封顶 30 秒，别把正常请求永久卡死')
})

test('★ 退避：一次成功就立刻归零（链路通了不该继续压着）', () => {
  const api = loadNetApi(fakeUndiciLib())
  for (let i = 0; i < 4; i++) api.noteResult('NETWORK_UNREACHABLE')
  assert.ok(api.backoffRemaining() > 0, '前置：应该已经在退避')

  api.noteResult('') // 拿到响应
  assert.equal(api.failures(), 0, '连续失败计数必须清零')
  assert.equal(api.backoffRemaining(), 0, '退避窗口必须立刻打开')
})

test('退避：业务失败不吃退避（余额不足/502 跟链路通不通无关）', () => {
  const api = loadNetApi(fakeUndiciLib())
  for (const code of ['TRANSLATE_FAILED', 'SERVER_BAD_RESPONSE', 'NETWORK_TIMEOUT', 'AUTH_REQUIRED']) {
    api.noteResult(code)
  }
  assert.equal(api.failures(), 0, '只有连接不可达才推进退避')
  assert.equal(api.backoffRemaining(), 0,
    '服务端答复了（哪怕是错误）说明链路是通的，不该惩罚后续请求')
})

test('★ 连接失败必须重建两个 Agent（池里的半死 socket 不能继续复用）', () => {
  const lib = fakeUndiciLib()
  const api = loadNetApi(lib)
  api.apiDispatcher()
  const before = api.getAgents()
  assert.ok(before, '前置：应该有连接池')

  api.recycle()
  assert.equal(before.cold.closed, true, '旧的冷 Agent 必须关掉')
  assert.equal(before.warm.closed, true, '旧的热 Agent 必须关掉')
  assert.equal(api.getAgents(), null, '引用要清空')

  // 重建之后是新池子，且回到冷启动预算
  const fresh = api.apiDispatcher()
  assert.ok(fresh && fresh !== before.cold, '必须真的新建，不能复用旧的')
  assert.equal(fresh.opts.connect.timeout, 8000, '重建后回到冷启动预算（DNS/TLS 要重新协商）')
})

test('接线守卫：api() 在连接失败时必须 recycle，成功时必须清零退避', () => {
  assert.match(mainSrc, /apiNet\.noteResult\(classified\.code\)/,
    '失败结局必须上报给退避（否则退避永远不生效）')
  assert.match(mainSrc, /apiNet\.recycle\(\)/,
    '连接不可达后必须重建连接池')
  assert.match(mainSrc, /apiNet\.noteResult\(''\)/,
    '拿到响应必须清零退避')
  assert.match(mainSrc, /apiNet\.backoffRemaining\(\)/,
    '发请求前必须检查退避窗口')
})

// ---------------------------------------------------------------------------
// 6. 手动重试不能被退避挡住
// ---------------------------------------------------------------------------
// 退避是为了压住自动轮询。用户看见"网络异常"后主动点重试，如果被回一句
// "网络恢复中，请稍后"，他会以为按钮坏了 —— 那是比网络问题更糟的体验。

test('isManualTrigger：只有用户主动的动作才算', () => {
  const { isManualTrigger } = require('../desktop/src/translate/translation-cache')
  for (const t of ['manual_click', 'manual_send', 'retranslate']) {
    assert.equal(isManualTrigger(t), true, t + ' 是用户主动点的')
  }
  for (const t of ['auto_receive', '', null, undefined, 'unknown']) {
    assert.equal(isManualTrigger(t), false, String(t) + ' 不是用户主动点')
  }
})

test('★ 手动触发必须带 skipBackoff，自动扫描不带', async () => {
  const { createRequestTranslate, createTranslationCache } = require('../desktop/src/translate/translation-cache')
  const cache = createTranslationCache()
  const calls = []
  const api = (pathname, opts) => {
    calls.push(opts)
    return Promise.resolve({ success: true, translation: 'ok' })
  }
  const run = createRequestTranslate({ api: api, cache: cache })

  await run('你好', 'zh', 'en', 'gpt', 'manual_send')
  assert.equal(calls[0].skipBackoff, true, '按发送是用户主动动作，不该被退避挡')

  calls.length = 0
  await run('Hello', 'en', 'zh', 'gpt', 'auto_receive')
  assert.equal(calls[0].skipBackoff, false, '自动接收仍受退避约束（断网时别刷爆日志）')
})
