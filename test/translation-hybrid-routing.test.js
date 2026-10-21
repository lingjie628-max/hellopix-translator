'use strict'

/**
 * 混合路由的**端到端契约**：服务端真的把短句分派到快速通道了吗？
 * 分派之后，返回给客户端的字段是不是如实反映了"实际用了谁"？
 *
 * 为什么不能只测 translation-router 那个纯函数就完事：
 *   · 纯函数测得再漂亮，只要 core-service 忘了把 usedEngine 传下去，
 *     实际还在打 LLM —— 用户感觉不到任何提速，测试却全绿；
 *   · 反过来，如果响应里 engine 仍报用户选的通道，就成了静默切换。
 *
 * 所以这里直接驱动 CoreService.translate()，用一个**记录调用**的假翻译器，
 * 断言"到底哪条通道被打到了"以及"响应怎么说的"。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const { CoreService, requestDigest } = require('../server/services/core-service')

// ---------------------------------------------------------------------------
// 最小可用的假环境：只要能跑通 translate() 的主干路径
// ---------------------------------------------------------------------------

/** 记录每一次真实上游调用，用来断言"到底打了谁"。 */
function makeTranslator () {
  const calls = []
  return {
    calls,
    countBillableChars: text => [...String(text)].length,
    detectLang: text => (/[\u4e00-\u9fff]/.test(text) ? 'zh' : 'en'),
    async translate (engine, payload) {
      calls.push({ engine: engine && engine.id, text: payload.text })
      // 故意让快速通道返回带标记的译文，方便断言走的是哪条
      return {
        ok: true,
        text: `[${engine && engine.id}] ${payload.text}`,
        model: engine && engine.model,
        usage: { input: 1, output: 1 },
        retries: 0
      }
    }
  }
}

function makeEngine (id, extra) {
  return Object.assign({
    id,
    name: id.toUpperCase(),
    enabled: true,
    wired: true,
    retired: false,
    provider: id,
    model: id + '-model',
    costPerMillion: 1000,
    callParams: {}
  }, extra || {})
}

/**
 * 组装一个能跑 translate() 的 CoreService。
 * 仓储/Redis 全部用内存假实现 —— 这里验证的是路由与响应契约，
 * 不是账务事务（那部分已有一整套真库测试）。
 */
function makeService (opts) {
  const o = opts || {}
  const engines = o.engines || [makeEngine('gpt'), makeEngine('qwen')]
  const translator = o.translator || makeTranslator()
  const logs = []

  // 预留状态用内存模拟：第一次查不到（走 INSERT 锁存），
  // 之后按 id 能查到（终于结算时读取）。
  // 注意 repo.query 在 core-service 里是**直接调用**的（不经过 client），
  // 所以两个入口都要 mock 同一份状态。
  let reservationRow = null
  const answer = sql => {
    if (/SELECT \* FROM translation_reservations WHERE user_id/.test(sql)) {
      return { rows: [] }
    }
    if (/INSERT INTO translation_reservations/.test(sql)) {
      reservationRow = {
        id: 1,
        status: 'reserved',
        reservedChars: 10,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        responseJson: null
      }
      return { rows: [reservationRow] }
    }
    if (/SELECT \* FROM translation_reservations WHERE id=/.test(sql)) {
      return { rows: reservationRow ? [reservationRow] : [] }
    }
    return { rows: [] }
  }

  const service = new CoreService(
    {
      async packageEngines () { return engines },
      async transaction (fn) { return fn({ async query (sql) { return answer(sql) } }) },
      async query (sql) { return answer(sql) },
      async lockAccount () { return { charBalance: 100000 } },
      async adjustChars () {},
      async moduleSetting () { return null }
    },
    // redis 只需满足 get/set/eval —— 构造函数校验前两个，
    // 分布式锁（防同一请求号并发重入）用 Lua 脚本，走的是 eval。
    {
      async get () { return null },
      async set () { return 'OK' },
      async del () { return 1 },
      async eval () { return 1 },
      async exists () { return 0 },
      async pexpire () { return 1 }
    },
    null,
    { translator }
  )

  // 缓存一律 miss：让每次测试都真的走到上游，才能断言"打了谁"
  service.translationCache = {
    async get () { return null },
    async set () {}
  }
  service.engineCredentials = async () => ({})
  service.logTranslateRow = async (_client, row) => { logs.push(row); return 1 }
  service.recordUpstreamUsage = async () => {}

  return { service, translator, logs, engines }
}

function session () {
  return {
    kind: 'main',
    parent: { id: 1, packageId: 1, packageCatalogVersion: 1 },
    account: { id: 1, charBalance: 100000, activeEngineId: 'gpt' }
  }
}

// ---------------------------------------------------------------------------
// 1. 总开关
// ---------------------------------------------------------------------------

test('★ 总开关关闭（默认）：短句仍然走用户选的通道，行为与改动前一致', async () => {
  const { service, translator } = makeService()
  service.hybridRouting = false   // 显式关掉，不依赖环境变量
  const res = await service.translate(session(), { text: 'Hi there', from: 'auto', to: 'zh', engine: 'gpt', requestId: 'k1' }, 'k1')
  assert.equal(translator.calls.length, 1)
  assert.equal(translator.calls[0].engine, 'gpt', '关闭时必须老老实实走 LLM 通道')
  assert.equal(res.engine, 'gpt')
  assert.equal(res.routed, undefined, '没路由就不该带 routed 字段')
})

// ---------------------------------------------------------------------------
// 2. 路由真的发生了
// ---------------------------------------------------------------------------

test('★ 打开后：短句实际打到快速通道', async () => {
  const { service, translator } = makeService()
  service.hybridRouting = true
  service.fastEngines = ['qwen']
  await service.translate(session(), { text: 'Hello, how are you?', from: 'auto', to: 'zh', engine: 'gpt', requestId: 'k2' }, 'k2')
  assert.equal(translator.calls.length, 1)
  assert.equal(translator.calls[0].engine, 'qwen', '短句必须真的打到快速通道，不能只是响应里写一句')
})

test('★ 打开后：长句仍然打到 LLM 通道（质量优先）', async () => {
  const { service, translator } = makeService()
  service.hybridRouting = true
  service.fastEngines = ['qwen']
  await service.translate(session(), { text: 'x'.repeat(400), from: 'auto', to: 'zh', engine: 'gpt', requestId: 'k3' }, 'k3')
  assert.equal(translator.calls[0].engine, 'gpt', '长文本不该为了快降级')
})

// ---------------------------------------------------------------------------
// 3. 响应必须如实反映实际通道（不可静默切换）
// ---------------------------------------------------------------------------

test('★★ 路由发生时响应必须带 routed，且 engine/engineName 报实际通道', async () => {
  const { service } = makeService()
  service.hybridRouting = true
  service.fastEngines = ['qwen']
  const res = await service.translate(session(), { text: 'Good morning', from: 'auto', to: 'zh', engine: 'gpt', requestId: 'k4' }, 'k4')

  assert.equal(res.engine, 'qwen', '★ engine 必须是实际执行的那条，不能还报 gpt')
  assert.equal(res.engineName, 'QWEN')
  assert.ok(res.routed, '★ 路由发生了就必须带 routed —— 界面要据此告诉用户')
  assert.equal(res.routed.from, 'gpt')
  assert.equal(res.routed.to, 'qwen')
  assert.ok(res.routed.reason, 'reason 要能说清"为什么走快路"，便于事后排查')
})

test('★ 路由没发生时，响应里不能凭空多出 routed', async () => {
  const { service } = makeService()
  service.hybridRouting = true
  service.fastEngines = ['qwen']
  const res = await service.translate(session(), { text: 'x'.repeat(400), from: 'auto', to: 'zh', engine: 'gpt', requestId: 'k5' }, 'k5')
  assert.equal(res.engine, 'gpt')
  assert.equal(res.routed, undefined, '没切换就不能声称切换了')
})

// ---------------------------------------------------------------------------
// 4. 计费与权益不能被路由绕过
// ---------------------------------------------------------------------------

test('★★ 路由不会把请求送进套餐外的通道', async () => {
  // 套餐里只有 gpt，没有 qwen
  const { service, translator } = makeService({ engines: [makeEngine('gpt')] })
  service.hybridRouting = true
  service.fastEngines = ['qwen']
  await service.translate(session(), { text: 'Hi', from: 'auto', to: 'zh', engine: 'gpt', requestId: 'k6' }, 'k6')
  assert.equal(translator.calls[0].engine, 'gpt', '套餐里没有的通道，再快也不许用')
})

test('★★ 成本日志记的是实际执行通道（否则月度对账会对不上）', async () => {
  const gpt = makeEngine('gpt', { costPerMillion: 10000 })
  const qwen = makeEngine('qwen', { costPerMillion: 100 })
  const { service, logs } = makeService({ engines: [gpt, qwen] })
  service.hybridRouting = true
  service.fastEngines = ['qwen']
  await service.translate(session(), { text: 'Hi', from: 'auto', to: 'zh', engine: 'gpt', requestId: 'k7' }, 'k7')
  assert.equal(logs.length, 1, '成功翻译应落一条台账')
  assert.equal(logs[0].engineId, 'qwen', '★ 台账必须记实际供应商，否则成本算错')
})

// ---------------------------------------------------------------------------
// 5. 缓存不能串通道
// ---------------------------------------------------------------------------

test('★ 缓存键必须区分通道（同一句走 LLM 与走快路的译文可能不同）', async () => {
  const { service } = makeService()
  service.hybridRouting = true
  service.fastEngines = ['qwen']
  const seen = []
  service.translationCache = {
    async get (tenant, req) { seen.push(req.engine); return null },
    async set () {}
  }
  await service.translate(session(), { text: 'Hi', from: 'auto', to: 'zh', engine: 'gpt', requestId: 'k8' }, 'k8')
  assert.equal(seen[0], 'qwen', '缓存要以实际执行的通道为键')
})

// ---------------------------------------------------------------------------
// 6. 开关的默认值
// ---------------------------------------------------------------------------

test('★ 环境变量缺省时总开关是关闭的（上线必须先开闸验证）', () => {
  const { service } = makeService()
  const saved = process.env.PIX_HYBRID_ROUTING
  try {
    delete process.env.PIX_HYBRID_ROUTING
    assert.equal(service.hybridRoutingEnabled(), false, '默认必须关闭')
    process.env.PIX_HYBRID_ROUTING = '1'
    assert.equal(service.hybridRoutingEnabled(), true)
    process.env.PIX_HYBRID_ROUTING = '0'
    assert.equal(service.hybridRoutingEnabled(), false, '只有字面量 1 才算开')
  } finally {
    if (saved === undefined) delete process.env.PIX_HYBRID_ROUTING
    else process.env.PIX_HYBRID_ROUTING = saved
  }
})

test('快速通道列表可由 PIX_FAST_ENGINES 配置，默认 qwen', () => {
  const { service } = makeService()
  const saved = process.env.PIX_FAST_ENGINES
  try {
    delete process.env.PIX_FAST_ENGINES
    assert.deepEqual(service.fastEngineIds(), ['qwen'])
    process.env.PIX_FAST_ENGINES = ' google , qwen '
    assert.deepEqual(service.fastEngineIds(), ['google', 'qwen'], '逗号分隔、去空格、保序')
  } finally {
    if (saved === undefined) delete process.env.PIX_FAST_ENGINES
    else process.env.PIX_FAST_ENGINES = saved
  }
})
