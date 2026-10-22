'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { checkMigrationVersion, createRuntime } = require('../server')
const { stub, pagination } = require('../server/lib/http')
const { CoreService, requestDigest } = require('../server/services/core-service')

const root = path.join(__dirname, '..')
const { readRoute, readAllRoutes, routeBlock } = require('./helpers/route-source')

test('production API targets only the canonical catalog schema', () => {
  const files = [
    'server/repositories/production-repository.js',
    'server/services/core-service.js',
    'server/routes/production.js'
  ]
  const source = files.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n')
  assert.doesNotMatch(source, /\bversions\b|\bsite_settings\b|\btranslate_engines\b/)
  assert.match(source, /\bpackages\b/)
  assert.match(source, /\bpackage_engines\b/)
  assert.match(source, /\bapp_settings\b/)
  assert.doesNotMatch(source, /(?:\.\.\/)+mock\//)
})

test('support migration is additive and supplies core API structures', () => {
  const source = fs.readFileSync(path.join(root, 'migrations/003_support_core_api.js'), 'utf8')
  for (const table of ['order_details', 'order_fans', 'character_transfers', 'client_releases', 'client_lines']) {
    assert.match(source, new RegExp(`CREATE TABLE ${table}\\b`))
  }
  for (const column of ['request_hash', 'response_json', 'source_language', 'target_language']) {
    assert.match(source, new RegExp(`ADD COLUMN ${column}\\b`))
  }
  assert.doesNotMatch(source, /CREATE TABLE (versions|site_settings|translate_engines)\b/)
})

test('migration gate accepts all required migrations and rejects missing versions', async () => {
  const complete = async () => ({
    rows: [
      { name: '001_initial_schema.js' },
      { name: '002_seed_catalog' },
      { name: '003_support_core_api' },
      { name: '004_client_releases_draft_url' }
    ]
  })
  const checked = await checkMigrationVersion(complete)
  assert.equal(checked.required.length, 4)
  await assert.rejects(
    checkMigrationVersion(async () => ({ rows: [{ name: '001_initial_schema' }] })),
    /数据库迁移未完成/
  )
})

test('persistent runtime checks dependencies without listening on require/create', async () => {
  let closed = 0
  const db = {
    pool: { query() {}, connect() {} },
    async checkDependencies() { return { postgres: true, redis: true } },
    async query() {
      return { rows: ['001_initial_schema', '002_seed_catalog', '003_support_core_api', '004_client_releases_draft_url'].map(name => ({ name })) }
    },
    getRedis() { return {} },
    async closeDependencies() { closed += 1 }
  }
  const middleware = (_req, _res, next) => next()
  const security = {
    createSession() {}, resolveSession() {}, destroySession() {}, revokeSubject() {},
    csrf: middleware, headers: middleware, originGuard: middleware
  }
  let stopped = 0
  const runtime = await createRuntime({
    persistent: true,
    db,
    security,
    registerProductionApi() { return { stop() { stopped += 1 } } }
  })
  assert.equal(runtime.server, null)
  await runtime.stop()
  assert.equal(stopped, 1)
  assert.equal(closed, 1)
})

test('runtime can explicitly start and stop an ephemeral HTTP listener', async () => {
  const middleware = (_req, _res, next) => next()
  const security = {
    createSession() {}, resolveSession() {}, destroySession() {}, revokeSubject() {},
    csrf: middleware, headers: middleware, originGuard: middleware
  }
  const runtime = await createRuntime({
    persistent: false,
    port: 0,
    security,
    registerMockApi() {}
  })
  await runtime.start()
  assert.ok(runtime.server.address().port > 0)
  await runtime.stop()
  assert.equal(runtime.server, null)
})

test('persistent runtime closes dependencies when migration gate fails', async () => {
  let closed = 0
  const db = {
    async checkDependencies() { return { postgres: true, redis: true } },
    async query() { return { rows: [] } },
    async closeDependencies() { closed += 1 }
  }
  await assert.rejects(createRuntime({ persistent: true, db }), /数据库迁移未完成/)
  assert.equal(closed, 1)
})

test('client catalog migration is required and admin clients are no longer stubbed', () => {
  const index = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8')
  // 路由已按域拆分：整目录读，桩清单只在 production.js 里
  const routes = readAllRoutes()
  const base = readRoute('production.js')
  const migration = fs.readFileSync(path.join(root, 'migrations/004_client_releases_draft_url.js'), 'utf8')
  const unmigrated = base.slice(base.indexOf('const unmigrated'))
  assert.match(index, /004_client_releases_draft_url/)
  assert.match(routes, /listClientReleases/)
  assert.match(routes, /saveClientRelease/)
  assert.doesNotMatch(unmigrated, /\/admin\/clients/)
  assert.match(migration, /client_releases_enabled_url_check/)
})

test('pagination caps page size and unmigrated modules return 503 contract', () => {
  assert.equal(pagination({ query: { rows: '500' }, body: {} }).size, 100)
  let status
  let body
  stub('payments')({}, {
    status(value) { status = value; return this },
    json(value) { body = value }
  })
  assert.equal(status, 503)
  assert.equal(body.code, 'NOT_MIGRATED')
  assert.equal(body.retryable, false)
})

test('reservation reconciliation atomically refunds main and sub accounts', async () => {
  const rows = [
    { id: 10, user_id: 1, sub_account_id: null, reserved_chars: 7 },
    { id: 11, user_id: 2, sub_account_id: 22, reserved_chars: 9 }
  ]
  const adjustments = []
  const updates = []
  const repository = {
    async transaction(work) { return work({ transaction: true }) },
    async query(sql, values) {
      if (/SELECT \* FROM translation_reservations/.test(sql)) return { rows }
      if (/UPDATE translation_reservations/.test(sql)) {
        updates.push(values[0])
        return { rows: [] }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
    async adjustChars(_client, kind, id, delta) {
      adjustments.push({ kind, id, delta })
    }
  }
  const redis = { get() {}, set() {} }
  const core = new CoreService(repository, redis, {})
  assert.equal(await core.reconcileExpiredReservations(100), 2)
  assert.deepEqual(adjustments, [
    { kind: 'main', id: 1, delta: 7 },
    { kind: 'sub', id: 22, delta: 9 }
  ])
  assert.deepEqual(updates, [10, 11])
})

test('translation request digest is deterministic and payload-sensitive', () => {
  const first = requestDigest({ engine: 'deepseek', text: 'hello' })
  assert.equal(first, requestDigest({ engine: 'deepseek', text: 'hello' }))
  assert.notEqual(first, requestDigest({ engine: 'baidu', text: 'hello' }))
})

test('unwired translation providers fail before reserving balance', async () => {
  let transactions = 0
  const repository = {
    async packageEngines() {
      return [{ id: 'deepseek', enabled: true, wired: false }]
    },
    async transaction() {
      transactions += 1
      throw new Error('must not reserve')
    }
  }
  const redis = { get() {}, set() {} }
  const core = new CoreService(repository, redis, {})
  const session = {
    kind: 'main',
    account: { id: 1, charBalance: 100, activeEngineId: 'deepseek' },
    parent: { id: 1, packageId: 1, activeEngineId: 'deepseek' }
  }
  await assert.rejects(
    core.translate(session, {
      text: 'hello', from: 'en', to: 'zh', engine: 'deepseek'
    }, 'unwired-provider'),
    error => error.code === 'ENGINE_NOT_CONFIGURED'
  )
  assert.equal(transactions, 0)
})

// --- 厂商密钥不得泄漏到客户端 -------------------------------------------------
// 背景：/translate/engines 是客户端接口，而 packageEngines 曾用 SELECT e.*，
// 把 api_key_ciphertext / secret_ciphertext(bytea) 一路序列化进了响应体。

test('client-facing engine query never selects credential columns', () => {
  const source = fs.readFileSync(path.join(root, 'server/repositories/production-repository.js'), 'utf8')
  const body = source.slice(
    source.indexOf('async packageEngines('),
    source.indexOf('async enginesForAdmin(')
  )
  assert.ok(body.length > 0, '找不到 packageEngines 实现')
  assert.doesNotMatch(body, /e\.\*/, 'packageEngines 不得再用 SELECT e.*（会带出密钥密文）')
  assert.doesNotMatch(body, /ciphertext/, 'packageEngines 不得触碰密钥列')
  assert.match(body, /e\.id/, '应显式列出安全列')

  // 管理端列表只回"是否已填"，同样不回密文
  const admin = source.slice(
    source.indexOf('async enginesForAdmin('),
    source.indexOf('async engineById(')
  )
  assert.doesNotMatch(admin, /api_key_ciphertext\s*,/, '管理端列表不得直接回传密文列')
  assert.match(admin, /AS has_key/, '管理端应只回 has_key 标记')
})

test('engine admin routes are registered before the unmigrated stub list', () => {
  const base = readRoute('production.js')
  const source = readAllRoutes()
  const listIndex = base.indexOf('const unmigrated = [')
  assert.ok(listIndex > 0)
  for (const route of ['/admin/engines', '/admin/engines/save', '/admin/engines/active']) {
    // 实现必须存在（可能已搬进 admin.js）
    assert.ok(source.includes(`'${route}'`), `${route} 找不到实现`)
    // 且不能还在 stub 清单里
    assert.ok(!base.slice(listIndex).includes(`'${route}'`), `${route} 不应再留在 unmigrated 列表里`)
  }
  // 真正要守的顺序：admin 路由挂在 stub 兜底**之前**。
  // admin.js 已按业务域拆成 admin/*.js，所以逐个检查 6 个挂载点都在兜底之前。
  const ADMIN_MOUNTS = [
    'registerAdminContent',
    'registerAdminDashboard',
    'registerAdminUsers',
    'registerAdminClients',
    'registerAdminOps',
    'registerAdminSettings'
  ]
  for (const mount of ADMIN_MOUNTS) {
    const at = base.indexOf(`${mount}(router, ctx)`)
    assert.ok(at > 0, `找不到挂载点 ${mount}(router, ctx)`)
    assert.ok(at < listIndex, `${mount} 必须挂在 unmigrated 兜底之前`)
  }
  // 保存路径必须强制校验密钥已配置，不得明文落库
  assert.match(source, /CREDENTIAL_KEY_MISSING/)
  assert.match(source, /encryptSecret\(/)
})

test('wired is derived from adapter readiness, not typed in by hand', () => {
  const body = routeBlock('post', '/admin/engines/save')
  assert.ok(body, '找不到 /admin/engines/save')
  assert.match(body, /const wired = enabled && ready/, 'wired 必须由 enabled + 适配器就绪推导')
  assert.doesNotMatch(body, /wired\s*=\s*(?:Boolean\()?Number\(data\.wired/, '不允许前端直接指定 wired')
})

// --- 套餐级"是否允许切换翻译通道" ----------------------------------------------
// 基础版刻意关闭切换（客户不必做他们判断不了的选择，成本也锁死在便宜通道上）。
// 关键点：**必须是服务端强制**。只把前端下拉藏起来的话，
// 直接调 POST /translate/run 带上 engine 就能绕过 —— 所以这里测的是服务端行为。

function coreWithEngines(engines) {
  const repository = {
    async packageEngines() { return engines },
    async settings() { return {} }
  }
  return new CoreService(repository, { get() {}, set() {} }, {})
}

const ENGINE_ROWS = [
  { id: 'baidu', name: '百度翻译', enabled: true, wired: true },
  { id: 'niutrans', name: '小牛翻译', enabled: true, wired: true }
]

test('套餐不允许切换时，忽略客户端传来的 engine', async () => {
  const core = coreWithEngines(ENGINE_ROWS)
  const session = {
    account: { activeEngineId: null },
    parent: { packageId: 1, packageAllowEngineSwitch: false }
  }
  // 显式传一个"套餐里没有"的通道，也必须被忽略而非采纳
  assert.equal(await core.resolveEngineId(session, 'deepl'), 'baidu',
    '不允许切换时必须回落到套餐内第一个已接通的通道')
})

test('套餐不允许切换时，账号里存的旧选择也不能生效', async () => {
  const core = coreWithEngines(ENGINE_ROWS)
  const session = {
    // 模拟"用户升级前选过 google，之后降级到不含 google 的套餐"
    account: { activeEngineId: 'google' },
    parent: { packageId: 1, packageAllowEngineSwitch: false }
  }
  assert.equal(await core.resolveEngineId(session, ''), 'baidu',
    '存量账号的旧选择不能绕过套餐限制')
})

test('套餐允许切换时，显式指定的通道正常生效', async () => {
  const core = coreWithEngines(ENGINE_ROWS)
  const session = {
    account: { activeEngineId: null },
    parent: { packageId: 2, packageAllowEngineSwitch: true }
  }
  assert.equal(await core.resolveEngineId(session, 'niutrans'), 'niutrans')
  // 没显式指定时用账号设置
  const withAccount = {
    account: { activeEngineId: 'niutrans' },
    parent: { packageId: 2, packageAllowEngineSwitch: true }
  }
  assert.equal(await core.resolveEngineId(withAccount, ''), 'niutrans')
})

test('界面显示的当前通道必须与实际使用的一致', async () => {
  const core = coreWithEngines(ENGINE_ROWS)
  // 不允许切换：即使账号里存着 google，界面也不能把 google 显示成"当前使用"
  const locked = await core.engines({
    account: { activeEngineId: 'google', charBalance: 0 },
    parent: { packageId: 1, packageAllowEngineSwitch: false, packageTitle: '基础版' }
  })
  assert.equal(locked.canSwitch, false)
  assert.equal(locked.activeEngine, 'baidu', '显示的通道必须与 resolveEngineId 的结果一致')

  // 允许切换：账号设置照常生效
  const free = await core.engines({
    account: { activeEngineId: 'niutrans', charBalance: 0 },
    parent: { packageId: 2, packageAllowEngineSwitch: true, packageTitle: '高级版' }
  })
  assert.equal(free.canSwitch, true)
  assert.equal(free.activeEngine, 'niutrans')
})

test('字段缺失时按"允许切换"处理，不误伤存量数据', async () => {
  const core = coreWithEngines(ENGINE_ROWS)
  const session = { account: { activeEngineId: 'niutrans' }, parent: { packageId: 1 } }
  assert.equal(await core.resolveEngineId(session, ''), 'niutrans')
})

// --- 「即将上线」通道不得被选中 -------------------------------------------------
// 9 个通道里只有 4 个真接了凭据。其余 5 个在界面上曾经和可用通道长得一模一样，
// 选中后一翻译就 503 —— 而 503 在客户端只表现为"没有译文"，用户只会来报
// "翻译坏了"。修法是把未接通的通道以 allowed=false 下发（已下发的客户端都按
// allowed !== false 过滤，无需升级即可生效），并在服务端兜住存量选择。

const MIXED_ENGINE_ROWS = [
  { id: 'baidu', name: '百度翻译', enabled: true, wired: false },
  { id: 'deepseek', name: 'DeepSeek 翻译', enabled: true, wired: true }
]

test('未接通的通道以 allowed=false 下发，且不会被显示成「当前」', async () => {
  const core = coreWithEngines(MIXED_ENGINE_ROWS)
  const view = await core.engines({
    // 存量账号：升级前在界面上选过 baidu，而 baidu 一直没接通
    account: { activeEngineId: 'baidu', charBalance: 0 },
    parent: { packageId: 2, packageAllowEngineSwitch: true, packageTitle: '高级版' }
  })
  const baidu = view.rows.find(row => row.id === 'baidu')
  assert.equal(baidu.allowed, false, '未接通的通道不得可选用')
  assert.equal(baidu.comingSoon, true, '需要能标记成「即将上线」')
  assert.equal(baidu.active, false, '未接通的通道不能被标成当前通道')
  assert.equal(view.activeEngine, 'deepseek', '显示值必须与实际使用的通道一致')
})

test('账号里存的未接通通道被跳过，但客户端显式点名时绝不替换', async () => {
  const core = coreWithEngines(MIXED_ENGINE_ROWS)
  const session = {
    account: { activeEngineId: 'baidu' },
    parent: { packageId: 2, packageAllowEngineSwitch: true }
  }
  // 不显式指定：用账号里存的那个（= baidu，未接通）。
  // 这是**历史遗留的陈旧状态**（旧版界面允许选中未接通通道），不是一次"选择"，
  // 沿用会让这个商户每次翻译都撞 503 —— 所以跳过它，回落到权益内第一个可用通道。
  assert.equal(await core.resolveEngineId(session, ''), 'deepseek',
    '存量的未接通选择必须被跳过，否则这个商户每次翻译都撞 503')

  // 显式传 baidu：**原样返回**，由 translate() 给出"尚未上线"的明确报错。
  //
  // 这条断言与上一版契约相反（旧实现会静默换成 deepseek），是刻意的：
  // 「用户手动选择的渠道失败时，不要静默切换供应商」。
  // 旧行为下用户选了 A、界面也显示 A，实际调用与账单走的却是 B，用户永远发现不了 ——
  // 这不是"容错"，是欺骗。已下发的客户端（含 0.1.5/0.1.6）都按 allowed !== false
  // 过滤下拉，绝不会把未接通的通道传上来，所以改进不会误伤存量客户端。
  assert.equal(await core.resolveEngineId(session, 'baidu'), 'baidu',
    '显式选择必须原样返回，替换它就是静默切换供应商')
})

test('套餐里一个可用通道都没有时报「没有可用通道」，不是「套餐未包含」', async () => {
  const repository = {
    async packageEngines() { return [{ id: 'baidu', enabled: true, wired: false }] },
    async transaction() { throw new Error('must not reserve') }
  }
  const core = new CoreService(repository, { get() {}, set() {} }, {})
  const session = {
    kind: 'main',
    account: { id: 1, charBalance: 100, activeEngineId: null },
    parent: { id: 1, packageId: 1 }
  }
  await assert.rejects(
    core.translate(session, { text: 'hello', from: 'en', to: 'zh' }, 'no-usable-channel'),
    error => {
      // 报 ENGINE_NOT_ALLOWED（套餐未包含）会把人引向"升级套餐"，而升级也解决不了
      assert.equal(error.code, 'ENGINE_NOT_CONFIGURED')
      assert.match(error.message, /没有可用/)
      return true
    }
  )
})

test('套餐外的通道不会被静默降级成套餐内通道', async () => {
  const core = coreWithEngines(ENGINE_ROWS)
  const session = {
    account: { activeEngineId: null },
    parent: { packageId: 2, packageAllowEngineSwitch: true }
  }
  // deepl 不在套餐里：必须原样返回，由 translate() 回 403「当前套餐未包含此通道」。
  // 静默换成 niutrans 会把越权请求也"修好"，那是权限问题，不能糊过去。
  assert.equal(await core.resolveEngineId(session, 'deepl'), 'deepl')
})

test('切换到未接通的通道时报「尚未上线」，不是「套餐未包含」', () => {
  const source = fs.readFileSync(path.join(root, 'server/routes/production.js'), 'utf8')
  const body = source.slice(
    source.indexOf("router.post('/translate/engines/active'"),
    source.indexOf('const translate = asyncRoute')
  )
  assert.match(body, /ENGINE_NOT_CONFIGURED/, '未接通的通道必须回「尚未上线」')
  assert.match(body, /ENGINE_NOT_ALLOWED/, '套餐外的通道仍回「套餐未包含」')
})

test('生产库里未接通的通道确实被标成不可选用', async () => {
  // 这条守住的是文案之外的实质：界面上不该再有"能点但点了必然失败"的通道。
  const core = coreWithEngines([
    { id: 'aws', name: 'AWS', enabled: true, wired: false },
    { id: 'deepl', name: 'DeepL', enabled: true, wired: false },
    { id: 'gemini', name: 'Gemini', enabled: true, wired: false },
    { id: 'niutrans', name: '小牛翻译', enabled: true, wired: false },
    { id: 'papago', name: 'Papago', enabled: true, wired: false },
    { id: 'google', name: 'Google 翻译', enabled: true, wired: true }
  ])
  const view = await core.engines({
    account: { activeEngineId: null, charBalance: 0 },
    parent: { packageId: 3, packageAllowEngineSwitch: true, packageTitle: '专业版' }
  })
  assert.deepEqual(view.rows.filter(row => row.allowed).map(row => row.id), ['google'])
  assert.equal(view.rows.filter(row => row.comingSoon).length, 5)
})

// ---------------------------------------------------------------------------
// 「主账号能选两个、子账号只能固定一个」是**明确禁止**的产品行为
//
// 真机验收时子账号的通道下拉锁死，很容易被读成"新子账号被降级对待"。
// 实际判定看的是**商户套餐**（`session.parent.packageAllowEngineSwitch`），
// `session.kind` 根本不参与 —— 所以主账号与子账号的能力必须**逐项相同**。
// 下面几条把"不得按 kind 分层"钉死，防止以后有人"顺手"给子账号单独加限制。
// ---------------------------------------------------------------------------

test('切换能力只由套餐决定：主账号与子账号必须完全一致', async () => {
  const core = coreWithEngines(ENGINE_ROWS)
  const parent = { packageId: 2, packageAllowEngineSwitch: true, packageTitle: '高级版' }
  const account = { activeEngineId: 'niutrans', charBalance: 0 }
  const main = await core.engines({ kind: 'main', account, parent })
  const sub = await core.engines({ kind: 'sub', account, parent })

  assert.equal(sub.canSwitch, main.canSwitch, '子账号不得比主账号多一层限制')
  assert.equal(sub.canSwitch, true)
  assert.equal(sub.activeEngine, main.activeEngine, '同一套餐下两者当前通道必须相同')
  assert.deepEqual(sub.rows.map(row => row.id), main.rows.map(row => row.id),
    '子账号可选通道集合必须与主账号一致，不得少给')
})

test('子账号显式切换通道时服务端采纳（kind 不参与判定）', async () => {
  const core = coreWithEngines(ENGINE_ROWS)
  const session = {
    kind: 'sub',
    account: { activeEngineId: 'baidu' },
    parent: { packageId: 2, packageAllowEngineSwitch: true }
  }
  assert.equal(await core.resolveEngineId(session, 'niutrans'), 'niutrans',
    '子账号选了就必须走它 —— 这是「选 GPT / 切 DeepSeek」验收成立的前提')
})

test('迁移 043：被 015 锁死的 basic 档必须放开通道切换', () => {
  const dir = path.join(root, 'migrations')
  const file = fs.readdirSync(dir).find(name => name.startsWith('043_'))
  assert.ok(file, '找不到迁移 043（放开通道切换）')
  const source = fs.readFileSync(path.join(dir, file), 'utf8')
  // 015 把 basic 锁死；043 不显式放开的话，商户买了含两个通道的套餐
  // 仍然一个都选不了，界面还会显示与实际调用不一致的通道。
  assert.match(source, /allow_engine_switch = true/, '043 必须真的把开关打开')
  assert.match(source, /code = 'basic'/, '043 要针对被 015 锁死的 basic 档')
})
