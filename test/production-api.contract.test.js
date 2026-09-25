'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { checkMigrationVersion, createRuntime } = require('../server')
const { stub, pagination } = require('../server/lib/http')
const { CoreService, requestDigest } = require('../server/services/core-service')

const root = path.join(__dirname, '..')

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
  const routes = fs.readFileSync(path.join(root, 'server/routes/production.js'), 'utf8')
  const migration = fs.readFileSync(path.join(root, 'migrations/004_client_releases_draft_url.js'), 'utf8')
  const unmigrated = routes.slice(routes.indexOf('const unmigrated'))
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
  const source = fs.readFileSync(path.join(root, 'server/routes/production.js'), 'utf8')
  const listIndex = source.indexOf('const unmigrated = [')
  assert.ok(listIndex > 0)
  for (const route of ['/admin/engines', '/admin/engines/save', '/admin/engines/active']) {
    const routeIndex = source.indexOf(`'${route}'`, source.indexOf('router.get(\'/admin/engines\''))
    assert.ok(routeIndex > 0 && routeIndex < listIndex, `${route} 必须在 stub 列表之前注册`)
    assert.ok(!source.slice(listIndex).includes(`'${route}'`), `${route} 不应再留在 unmigrated 列表里`)
  }
  // 保存路径必须强制校验密钥已配置，不得明文落库
  assert.match(source, /CREDENTIAL_KEY_MISSING/)
  assert.match(source, /encryptSecret\(/)
})

test('wired is derived from adapter readiness, not typed in by hand', () => {
  const source = fs.readFileSync(path.join(root, 'server/routes/production.js'), 'utf8')
  const body = source.slice(source.indexOf("router.post('/admin/engines/save'"), source.indexOf("router.post('/admin/engines/active'"))
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
