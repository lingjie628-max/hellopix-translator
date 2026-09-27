/**
 * 2026-09-25 换线的三条硬要求对应的机制测试：
 *
 *   1. **调用限额**：超时 / 重试 / 输入输出上限必须有边界，且能在后台按通道配置。
 *      翻译是**按次付费**的：重试一次就多花一次钱，模型"多写两句解释"
 *      也按输出 token 全额计费。没有上限的默认值等于没有成本控制。
 *
 *   2. **绝不静默截断**：原文超过通道上限时直接失败并说清楚，不能截一半翻译。
 *      截断的译文是"看起来成功、其实是残缺的"—— 商户拿它去谈生意会出错，
 *      而我们照样扣了字符。这种失败比报错严重得多。
 *
 *   3. **上游用量归一 + 客户字符账本分离**：厂商按 token 计费、我们按字符收费，
 *      两套口径必须都记下来，否则永远算不出真实毛利。
 *
 * 这里刻意分成两层测：
 *   · 纯函数层（callParamsOf / estimateTokens / normalizeUsage）—— 边界值好断言
 *   · 适配器层（真过一遍报文构造）—— 防的是"参数算了但没发出去"
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const adapter = require('../server/services/translation-adapters')
const { callParamsOf, estimateTokens, normalizeUsage, inputLimitError, CALL_LIMITS } = adapter
const provider = require('../server/services/translation-provider')
const { CoreService } = require('../server/services/core-service')

// ---------------------------------------------------------------------------
// 一、callParamsOf：后台配置优先，且一律夹进硬边界
// ---------------------------------------------------------------------------

test('callParamsOf：后台配的参数覆盖代码默认值', () => {
  const params = callParamsOf({ callParams: { temperature: 0.7, timeoutMs: 5000, maxRetries: 1 } },
    { temperature: 0, timeoutMs: 12000, maxRetries: 2 })
  assert.equal(params.temperature, 0.7)
  assert.equal(params.timeoutMs, 5000)
  assert.equal(params.maxRetries, 1)
})

test('callParamsOf：超时/重试/输出长度全部夹进硬边界，配超了不会生效', () => {
  // 后台把重试配成 99、超时配成 10 分钟、输出配成 100 万 token：
  // 这三个都能把成本/延迟放大到不可控，必须在代码里夹住，
  // 不能只靠"管理员不会这么填"。
  const params = callParamsOf(
    { callParams: { timeoutMs: 600_000, maxRetries: 99, maxOutputTokens: 1_000_000, maxInputTokens: 999_999_999 } },
    {}
  )
  assert.equal(params.timeoutMs, CALL_LIMITS.timeoutMs.max, '超时上限 30s')
  assert.equal(params.maxRetries, CALL_LIMITS.maxRetries.max, '重试上限 2 次')
  assert.equal(params.maxOutputTokens, CALL_LIMITS.maxOutputTokens.max)
  assert.equal(params.maxInputTokens, CALL_LIMITS.maxInputTokens.max)
})

test('callParamsOf：配了 0 / 负数 / 垃圾值时按边界收敛，不产生负数重试', () => {
  const params = callParamsOf({ callParams: { timeoutMs: -1, maxRetries: -5, maxOutputTokens: 'abc' } }, {})
  assert.equal(params.timeoutMs, CALL_LIMITS.timeoutMs.min)
  assert.equal(params.maxRetries, 0, '负数重试必须收敛成 0，否则循环条件就废了')
  assert.equal(params.maxOutputTokens, CALL_LIMITS.maxOutputTokens.fallback)
})

test('callParamsOf：temperature=null 是有意的空值语义，不能被 undefined 默认成 0', () => {
  // Kimi K3 把采样参数固定在服务端，官方明确建议不要传。
  // 这里必须保住 null（= 不发送），否则适配层会当它"没配"而回落到 0 发出去。
  assert.equal(callParamsOf({ callParams: { temperature: null } }, { temperature: 0 }).temperature, null)
  // 真的没配时才用默认值
  assert.equal(callParamsOf({ callParams: {} }, { temperature: 0 }).temperature, 0)
  assert.equal(callParamsOf(null, {}).temperature, 0)
})

test('callParamsOf：extraBody 会合并到调用参数里，供厂商专属开关使用', () => {
  const params = callParamsOf({ callParams: { extraBody: { thinking: { type: 'disabled' } } } }, {})
  assert.deepEqual(params.extraBody, { thinking: { type: 'disabled' } })
})

// ---------------------------------------------------------------------------
// 二、estimateTokens：保守上界，宁可拒也不发超限请求
// ---------------------------------------------------------------------------

test('estimateTokens：CJK 一字算 1 token，西文 3 字符算 1 token', () => {
  assert.equal(estimateTokens('你好世界'), 4)
  assert.equal(estimateTokens('abcdef'), 2)
  assert.equal(estimateTokens(''), 0)
  // 混排：4 个汉字 + 6 个西文字符
  assert.equal(estimateTokens('你好世界abcdef'), 4 + 2)
})

test('estimateTokens：只用于"该不该拒"，必须是高估而不是低估', () => {
  // 真实分词器对中文约 0.6~1.0 token/字、英文约 0.25 token/字符。
  // 估值必须 >= 真实值，否则会放过真正超限的请求，让厂商的 400 冒到用户面前。
  const text = '这是一段中文测试文本'
  assert.ok(estimateTokens(text) >= text.length, '中文估值不应低于字数')
  const latin = 'a'.repeat(300)
  assert.ok(estimateTokens(latin) >= latin.length / 4, '英文估值不应低于真实 token 数（约 4 字符/token）')
})

// ---------------------------------------------------------------------------
// 三、normalizeUsage：把两套协议塞进同一张表
// ---------------------------------------------------------------------------

test('normalizeUsage：OpenAI 系的 prompt/completion_tokens', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 12, completion_tokens: 34 }), {
    promptTokens: 12, completionTokens: 34, reasoningTokens: 0, totalTokens: 46
  })
})

test('normalizeUsage：Anthropic 的 input/output_tokens 同样能认', () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 12, output_tokens: 34 }), {
    promptTokens: 12, completionTokens: 34, reasoningTokens: 0, totalTokens: 46
  })
})

test('normalizeUsage：推理 token 单独记，才能回答"钱花在正文还是思考上"', () => {
  const usage = normalizeUsage({
    prompt_tokens: 10,
    completion_tokens: 200,
    completion_tokens_details: { reasoning_tokens: 150 }
  })
  assert.equal(usage.reasoningTokens, 150)
  assert.equal(usage.completionTokens, 200, '推理 token 已含在 completion 里，不能重复加总')
})

test('normalizeUsage：没有用量字段时返回 null，而不是记一条全 0 的假账', () => {
  assert.equal(normalizeUsage(null), null)
  assert.equal(normalizeUsage({}), null)
  assert.equal(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 }), null)
})

// ---------------------------------------------------------------------------
// 四、不静默截断：超限在**本地**就失败，一个请求都不发
// ---------------------------------------------------------------------------

test('inputLimitError：文案要点明"本站不会静默截断"，并给出可执行的下一步', () => {
  const error = inputLimitError('通义千问', 9000, 8192)
  assert.equal(error.ok, false)
  assert.match(error.msg, /9000/)
  assert.match(error.msg, /8192/)
  assert.match(error.msg, /分段/)
  assert.match(error.msg, /不会静默截断/)
})

test('Qwen-MT：超 8192 token 的原文本地拒绝，一个厂商请求都不发', async () => {
  const calls = []
  const result = await provider.translate(
    { id: 'qwen', enabled: true },
    { text: '好'.repeat(9000), from: 'zh', to: 'en' },
    { fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({}) } },
      timeoutMs: 3000, credentials: { apiKey: 'sk-x' } }
  )
  assert.equal(result.ok, false)
  assert.match(result.msg, /过长/)
  assert.match(result.msg, /分段/)
  assert.equal(calls.length, 0, '超限的请求绝不能发出去 —— 发了就是白花一次钱换一个 400')
})

test('Claude：配了 maxInputTokens 时同样先拦后发，且带上是哪个模型', async () => {
  const calls = []
  const result = await provider.translate(
    { id: 'claude', enabled: true, model: 'claude-haiku-4-5', callParams: { maxInputTokens: 100, temperature: 0 } },
    { text: '好'.repeat(500), from: 'zh', to: 'en' },
    { fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({}) } },
      timeoutMs: 3000, credentials: { apiKey: 'sk-x' } }
  )
  assert.equal(result.ok, false)
  assert.match(result.msg, /过长/)
  assert.equal(result.model, 'claude-haiku-4-5', '失败也要报出"本该用哪个模型"，便于排障')
  assert.equal(calls.length, 0)
})

// ---------------------------------------------------------------------------
// 五、后台配的参数必须真的进报文（"算了但没发出去"是常见漏法）
// ---------------------------------------------------------------------------

const okBody = { choices: [{ message: { content: 'Hello' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }
const capture = () => {
  const calls = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      return { ok: true, status: 200, json: async () => okBody }
    }
  }
}

test('OpenAI 兼容系：后台配的 maxOutputTokens 会作为 max_tokens 发出去', async () => {
  const cap = capture()
  await provider.translate(
    { id: 'glm', enabled: true, model: 'glm-4.7', callParams: { temperature: 0.2, maxOutputTokens: 512 } },
    { text: '你好', from: 'zh', to: 'en' },
    { fetch: cap.fetch, timeoutMs: 3000, credentials: { apiKey: 'k' } }
  )
  const body = JSON.parse(cap.calls[0].init.body)
  assert.equal(body.max_tokens, 512, '不设输出上限时模型可能把翻译写成解释文，按输出 token 全额计费')
  assert.equal(body.temperature, 0.2)
})

test('OpenAI 兼容系：maxRetries=0 时被厂商拒绝也不重试（每次重试都真花钱）', async () => {
  let calls = 0
  const result = await provider.translate(
    { id: 'glm', enabled: true, callParams: { temperature: 0, maxRetries: 0 } },
    { text: '你好', from: 'zh', to: 'en' },
    {
      fetch: async () => {
        calls += 1
        return { ok: false, status: 400, json: async () => ({ error: { message: "Unsupported value: 'temperature'" } }) }
      },
      timeoutMs: 3000, credentials: { apiKey: 'k' }
    }
  )
  assert.equal(result.ok, false)
  assert.equal(calls, 1, 'maxRetries=0 表示一次都不重试')
})

test('适配层回报的用量进 result.usage，供内部台账落库（与客户字符账本无关）', async () => {
  const cap = capture()
  const result = await provider.translate(
    { id: 'glm', enabled: true },
    { text: '你好', from: 'zh', to: 'en' },
    { fetch: cap.fetch, timeoutMs: 3000, credentials: { apiKey: 'k' } }
  )
  assert.equal(result.ok, true)
  assert.equal(result.model, 'glm-4.7', '返回值必须带真实调用的模型，前台展示的就是它')
  assert.deepEqual(result.usage, {
    promptTokens: 3, completionTokens: 2, reasoningTokens: 0, totalTokens: 5
  })
})

// ---------------------------------------------------------------------------
// 六、下架通道：对商户不可见、不可解析，但库里与历史日志里都还在
// ---------------------------------------------------------------------------

const RETIRED_ROW = {
  id: 'gemini', name: 'Gemini 翻译', provider: 'Google', enabled: false, wired: false,
  retired: true, model: 'gemini-2.5-flash', tier: 'pro'
}
const LIVE_ROW = {
  id: 'deepseek', name: 'DeepSeek 翻译', provider: 'DeepSeek', enabled: true, wired: true,
  retired: false, model: 'deepseek-flash', tier: 'advanced'
}

function coreWith(rows) {
  const repository = {
    async packageEngines(_packageId, version) {
      // 记录版本参数，供"按购买时版本解析"的断言用
      repository.lastVersion = version
      return rows
    },
    async settings() { return {} }
  }
  return { core: new CoreService(repository, { get() {}, set() {} }, {}), repository }
}

test('已下架的通道不下发给商户（列表里看不到，也不会被标成当前）', async () => {
  const { core } = coreWith([RETIRED_ROW, LIVE_ROW])
  const view = await core.engines({
    account: { activeEngineId: 'gemini', charBalance: 0 },
    parent: { packageId: 2, packageAllowEngineSwitch: true, packageTitle: '高级版' }
  })
  assert.equal(view.rows.some(row => row.id === 'gemini'), false,
    '下架通道对商户完全不可见 —— 摆一个用不了的通道只会增加困惑')
  assert.equal(view.activeEngine, 'deepseek')
  assert.equal(view.activeModel, 'deepseek-flash', '前台展示的模型必须是真实调用那个')
})

test('账号里存的通道已下架时会被跳过（否则该商户每次翻译都撞 503）', async () => {
  const { core } = coreWith([RETIRED_ROW, LIVE_ROW])
  const session = {
    account: { activeEngineId: 'gemini' },
    parent: { packageId: 2, packageAllowEngineSwitch: true }
  }
  assert.equal(await core.resolveEngineId(session, ''), 'deepseek')
})

test('显式点名一个已下架的通道不会被替换 —— 交给 translate 报「已下架」', async () => {
  const { core } = coreWith([RETIRED_ROW, LIVE_ROW])
  const session = {
    account: { activeEngineId: null },
    parent: { packageId: 2, packageAllowEngineSwitch: true }
  }
  assert.equal(await core.resolveEngineId(session, 'gemini'), 'gemini')
})

test('套餐权益按「购买时的版本」解析，不读此刻的活表', async () => {
  const { core, repository } = coreWith([LIVE_ROW])
  await core.engines({
    account: { charBalance: 0 },
    parent: { packageId: 2, packageAllowEngineSwitch: true, packageCatalogVersion: 1 }
  })
  assert.equal(repository.lastVersion, 1,
    '版本必须透传到仓储层 —— 少传一次就会读活表，等于让一次配置变更回溯改写历史买家的权益')
  await core.engines({
    account: { charBalance: 0 },
    parent: { packageId: 2, packageAllowEngineSwitch: true }
  })
  assert.equal(repository.lastVersion, undefined, '存量数据没有版本时回落活表，行为与改前一致')
})

test('通道是否"可用"要求启用 + 已接通 + 未下架，三个条件缺一不可', async () => {
  const rows = [
    { id: 'a', enabled: true, wired: true, retired: false },      // 可用
    { id: 'b', enabled: false, wired: true, retired: false },     // 停用
    { id: 'c', enabled: true, wired: false, retired: false },     // 未接通
    { id: 'd', enabled: true, wired: true, retired: true },       // 只改了 retired、忘改 enabled 的情况
    { id: 'e', enabled: true, wired: true }                       // 老数据没有 retired 字段
  ]
  const { core } = coreWith(rows)
  const session = { account: { activeEngineId: null }, parent: { packageId: 1 } }
  assert.equal(await core.resolveEngineId(session, ''), 'a')
})

test('translate 对已下架的通道给出专门错误码，不混进「套餐未包含」', async () => {
  const repository = {
    async packageEngines() { return [RETIRED_ROW, LIVE_ROW] },
    async transaction() { throw new Error('不该走到预留环节') }
  }
  const core = new CoreService(repository, { get() {}, set() {} }, {})
  const session = {
    kind: 'main',
    account: { id: 1, charBalance: 100, activeEngineId: null },
    parent: { id: 1, packageId: 2, packageAllowEngineSwitch: true }
  }
  await assert.rejects(
    core.translate(session, { text: 'hello', from: 'en', to: 'zh', engine: 'gemini' }, 'retired-key'),
    error => {
      // 报「套餐未包含」会把人引向"升级套餐"，而升级换不来一个已经下架的通道
      assert.equal(error.code, 'ENGINE_RETIRED')
      assert.match(error.message, /已下架/)
      assert.match(error.message, /换一个/)
      return true
    }
  )
})

// ---------------------------------------------------------------------------
// 迁移 031 的通道名单不变量
//
// 这一条是被真实数据打出来才补上的：下架逻辑写成"凡不在名单里的一律下架"，
// 而名单一开始只放了**新增的 7 个**。结果是重跑迁移会把正在生产上跑的
// gpt / grok / deepseek / google 一起下架 —— 套餐里还有它们的名字，
// 点下去却报"通道不存在"，等于一键掐掉线上全部通道。
//
// 单看代码很难发现（它就是一句 NOT IN），跑在真实活表上才现形。
// 所以这里把不变量钉死：名单必须是完整的 11 个，且必须包含 4 个在跑的。
// ---------------------------------------------------------------------------

test('换线的通道名单是完整 11 个，且包含 4 个已在生产上跑的通道', () => {
  const migration = require('../migrations/031_translation_channel_lineup')
  const ids = migration.lineupEngineIds

  assert.equal(ids.length, 11, `正式渠道必须是 11 个，实际 ${ids.length} 个`)
  assert.equal(new Set(ids).size, 11, '名单里不能有重复 id')
  for (const id of ['gpt', 'deepseek', 'google', 'grok']) {
    assert.ok(ids.includes(id),
      `${id} 已经在生产上跑着，必须留在名单里 —— 漏掉它就会被下架逻辑误伤`)
  }
  for (const row of migration.engines) {
    assert.ok(ids.includes(row.id), `${row.id} 是新增通道，必须计入名单`)
  }
})

// ---------------------------------------------------------------------------
// 成本报告：不许拿兜底值冒充"本环境的账"
//
// 这一节也是被真实数据打出来的：报告里把 `model` 与套餐售价**抄成了常量**
// （还标着"读自 packages 表"，其实一次都没读过）。而两个环境的值并不一样：
//   · 模型：开发库 gpt = gpt-4o-mini，生产 = gpt-5.6-luna（价目表里查不到）
//   · 售价：开发库 200/350/850，生产 40/75/135（都是 USD）
// 结果就是"报告算的是 A 环境，读的人以为在说 B 环境"，而表本身完全自洽。
//
// 所以钉两条不变量：
//   1. 读不到库时必须**当场说明**用的是兜底值，不能悄悄算完；
//   2. 查不到官方价的模型必须标 verified=false 且**注明 0 不代表免费**，
//      否则"不知道"会被当成"免费"参与定价决策。
// ---------------------------------------------------------------------------

const { resolvePricing, estimateUpstreamCost } = require('../server/lib/upstream-pricing')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const REPORT = path.join(__dirname, '..', 'scripts', 'translation-cost-report.js')

function runReport(env) {
  return spawnSync(process.execPath, [REPORT], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, env),
    encoding: 'utf8',
    timeout: 120000
  })
}

test('成本报告：查不到官方价的模型标 unverified，并写明"0 不代表免费"', () => {
  // 生产 gpt 的真实模型就叫这个名字，价目表里没有它
  assert.equal(resolvePricing('gpt-5.6-luna'), null, '这个模型本就不该在价目表里')
  const estimate = estimateUpstreamCost({
    model: 'gpt-5.6-luna', promptTokens: 1000, completionTokens: 500
  })
  assert.equal(estimate.verified, false)
  assert.equal(estimate.cost, 0)
  assert.match(estimate.note, /不代表免费|未核实/,
    '成本记 0 时必须写明它不是免费，否则会被当成零成本参与定价')
})

test('成本报告：没有 DATABASE_URL 时明说用的是兜底值，不静默出表', () => {
  const env = Object.assign({}, process.env)
  delete env.DATABASE_URL
  const result = runReport(Object.assign(env, { DATABASE_URL: '' }))
  assert.equal(result.status, 0, `报告应能跑完：${result.stderr}`)
  assert.match(result.stdout, /配置来源：代码兜底值/,
    '读不到库就必须在表头说明；否则表里的模型名与售价会被当成本环境的真实值')
  assert.match(result.stdout, /不是本环境的真实售价/)
})

test('成本报告：连不上库时同样自曝，且不影响退出码（便于 CI 里跑）', () => {
  const result = runReport({
    DATABASE_URL: 'postgres://nobody@127.0.0.1:1/nonexistent'
  })
  assert.equal(result.status, 0, `报告应能跑完：${result.stderr}`)
  assert.match(result.stdout, /配置来源：代码兜底值/)
  assert.match(result.stdout, /连库或取数失败|取数失败/)
})

test('成本报告：表格里绝不给"查不到价"的通道印 0 成本', () => {
  const result = runReport({ DATABASE_URL: 'postgres://nobody@127.0.0.1:1/nonexistent' })
  assert.equal(result.status, 0)
  // 兜底路径下每个通道都能查到价，所以这里出现 0.0 就说明算法把
  // "没有价"和"零成本"混在一起了
  const table = result.stdout.split('\n').filter(line => line.includes('\t'))
  const zeroCells = table.filter(line => /(^|\t)0\.0(\t|$)/.test(line))
  assert.deepEqual(zeroCells, [], `成本表里出现了 0.0 —— "未知"被当成"免费"了：\n${zeroCells.join('\n')}`)
})

// ---------------------------------------------------------------------------
// 七、成本台账必须把「未核实」写进去
//
// 这一节是被真实数据打出来的。用测试账号走了一次真实端到端翻译，
// 台账确实写了一行（链路是通的），但那行长这样：
//
//   engine_id=google  provider=Google  model=  upstream_cost=0  currency=''
//
// 根因是价目表按 `engines.model` 反查，而 google 的 model 是空串、
// gpt 是价目表里没有的 `gpt-5.6-luna` —— 4 条在跑通道里有 2 条被静默记成 0。
//
// 比"记成 0"更糟的是：`estimateUpstreamCost` 明明返回了 `verified:false`
// 与原因说明，入库时却被丢掉了，只写了 cost 和 currency。于是
// **"价格没查到"的 0 与"真的没花钱"的 0 在库里一模一样**，对账时看不出
// 少算了整整两条通道。所以这里锁死三件事：
//
//   1. verified / note / source / asOf 必须落库
//   2. 查不到价时成本是 0（不得编数），但必须标未核实
//   3. 查不到价必须留下日志 —— 库里的标记要人去查才看得到，日志是主动的
// ---------------------------------------------------------------------------

function ledgerRecorder() {
  const inserts = []
  const repository = {
    async query(sql, params) {
      inserts.push({ sql, params })
      return { rows: [] }
    }
  }
  return { core: new CoreService(repository, { get() {}, set() {} }, {}), inserts }
}

const LEDGER_SESSION = { kind: 'main', account: { id: 1 }, parent: { id: 1 } }

async function recordOne(core, { engineId, provider, model, reservedChars = 1000, retries = 0 }) {
  await core.recordUpstreamUsage(null, {
    reservation: { id: 7, reservedChars },
    engine: { id: engineId, provider, model },
    result: { model, retries, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } },
    session: LEDGER_SESSION,
    translateLogId: 9,
    from: 'en',
    to: 'zh',
    durationMs: 120
  })
}

// INSERT 的占位顺序（$1..$24）→ 数组下标
const COL = {
  billedUnits: 11, billedUnit: 12, cost: 13, currency: 14,
  verified: 20, note: 21, source: 22, asOf: 23
}

async function withCapturedWarnings(run) {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    await run()
  } finally {
    console.warn = original
  }
  return warnings
}

test('台账：能查到价的模型，成本与「已核实」标记都要落库', async () => {
  const { core, inserts } = ledgerRecorder()
  await recordOne(core, { engineId: 'deepseek', provider: 'DeepSeek', model: 'deepseek-flash' })
  const p = inserts[0].params
  assert.equal(inserts.length, 1, '必须写了且只写了一条台账')
  assert.equal(p[COL.verified], true, 'cost_verified 必须是 true')
  assert.ok(Number(p[COL.cost]) > 0, '已知价的模型成本必须大于 0')
  assert.equal(p[COL.currency], 'USD', '币种必须是 USD')
  assert.match(String(p[COL.source]), /^https?:\/\//, 'cost_source 要能回答"这个价从哪来" —— 否则这个数是不可审计的')
  assert.ok(String(p[COL.asOf]).length > 0, 'cost_as_of 要能回答"这个价截至什么时候"')
})

test('台账：查不到价的模型必须标未核实，0 不得伪装成「已核实」', async () => {
  const { core, inserts } = ledgerRecorder()
  await recordOne(core, { engineId: 'gpt', provider: 'OpenAI', model: 'gpt-5.6-luna' })
  const p = inserts[0].params
  assert.equal(Number(p[COL.cost]), 0, '查不到价时成本记 0（这是事实，不许编一个数出来）')
  assert.equal(p[COL.verified], false, '但必须标记未核实 —— 这才是"0 不代表免费"的落点')
  assert.match(String(p[COL.note]), /查不到|未核实/, 'cost_note 要说明为什么是 0，否则事后无从判断')
})

test('台账：按字符计价的通道用送翻字符数记账，且谷歌的官方价必须生效', async () => {
  const { core, inserts } = ledgerRecorder()
  await recordOne(core, {
    engineId: 'google', provider: 'Google', model: 'google-translate-v2', reservedChars: 1_000_000
  })
  const p = inserts[0].params
  assert.equal(p[COL.billedUnit], 'character', 'billed_unit 必须是 character，不能拿 token 数充数')
  assert.equal(Number(p[COL.billedUnits]), 1_000_000, 'billed_units 是实际送翻的字符数')
  assert.equal(Number(p[COL.cost]), 20, '谷歌 $20/百万字符 —— 这条通道的价是已知的，绝不该记 0')
  assert.equal(p[COL.verified], true, '已知官方价，必须标已核实')
})

test('台账：查不到价要主动记日志，且同一渠道同一模型只报一次', async () => {
  const { core } = ledgerRecorder()
  const warnings = await withCapturedWarnings(async () => {
    for (let i = 0; i < 3; i++) {
      await recordOne(core, { engineId: 'gpt', provider: 'OpenAI', model: 'gpt-5.6-luna' })
    }
    // 换一个渠道（同样是空 model）应当再报一次
    await recordOne(core, { engineId: 'google', provider: 'Google', model: '' })
  })
  assert.equal(warnings.length, 2, '同一「渠道:模型」报一次就够 —— 被日志淹掉的告警等于没有告警')
  assert.match(warnings[0], /gpt-5\.6-luna/)
  assert.match(warnings[1], /google/)
})

test('台账：价格已核实时不产生告警（否则告警会被日常噪声淹没）', async () => {
  const { core } = ledgerRecorder()
  const warnings = await withCapturedWarnings(async () => {
    await recordOne(core, { engineId: 'deepseek', provider: 'DeepSeek', model: 'deepseek-flash' })
  })
  assert.deepEqual(warnings, [])
})


