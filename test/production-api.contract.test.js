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

test('share password issues and validates Redis grants', async () => {
  const issued = []
  const shareGrants = {
    async issue(serial) {
      issued.push(serial)
      return 'grant-token'
    },
    async validate(token, serial) {
      return token === 'grant-token' && serial === 'HP1'
    }
  }
  const repository = {
    async query() {
      return {
        rows: [{
          serial_number: 'HP1',
          share_password_hash: 'hash',
          share_password_expires_at: new Date(Date.now() + 60_000).toISOString(),
          zero_time: '00:00:00'
        }]
      }
    }
  }
  const core = new CoreService(repository, { get() {}, set() {} }, {
    async verify() { return true }
  }, { shareGrants })
  const result = await core.sharePassword({ serialNumber: 'HP1', sharePassword: 'Share-9!' })
  assert.equal(result.code, 200)
  assert.equal(result.token, 'grant-token')
  assert.deepEqual(issued, ['HP1'])
  await core.assertShare('grant-token', 'HP1')
  await assert.rejects(core.assertShare('bad', 'HP1'), error => error.code === 'INVALID_SHARE_GRANT')
})

test('translation request digest is deterministic and payload-sensitive', () => {
  const first = requestDigest({ engine: 'youdao', text: 'hello' })
  assert.equal(first, requestDigest({ engine: 'youdao', text: 'hello' }))
  assert.notEqual(first, requestDigest({ engine: 'baidu', text: 'hello' }))
})

test('unwired translation providers fail before reserving balance', async () => {
  let transactions = 0
  const repository = {
    async packageEngines() {
      return [{ id: 'youdao', enabled: true, wired: false }]
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
    account: { id: 1, charBalance: 100, activeEngineId: 'youdao' },
    parent: { id: 1, packageId: 1, activeEngineId: 'youdao' }
  }
  await assert.rejects(
    core.translate(session, {
      text: 'hello', from: 'en', to: 'zh', engine: 'youdao'
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
