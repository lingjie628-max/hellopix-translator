'use strict'

/**
 * AdminAccountService 的规则测试。
 *
 * 每一条都对应一次**线上事故**。原实现埋在 141 行的 handler 里，
 * 只能靠"读源码看有没有这行"的静态断言守着 —— 那种测试只证明代码写着，
 * 不证明它工作。这里全部真跑。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const { AdminAccountService } = require('../server/services/admin-account-service')

function fakeRepo(overrides = {}) {
  const calls = []
  const repo = {
    calls,
    query: async (sql, params, client) => {
      calls.push({ sql, params, client, kind: 'query' })
      if (/^SELECT package_id,package_catalog_version FROM users/.test(sql.trim())) {
        return { rows: overrides.before ? [overrides.before] : [] }
      }
      if (/^UPDATE users SET nickname/.test(sql.trim())) {
        return { rows: [{ username: 'merchant_a', status: params[2] === null ? 1 : params[2], packageCatalogVersion: params[11] }] }
      }
      if (/^INSERT INTO users\(username/.test(sql.trim())) {
        return { rows: [{ id: 99, username: params[0] }] }
      }
      return { rows: [] }
    },
    package: async () => overrides.pack || {
      id: 5, catalogVersion: 7, portLimit: 3, subQuota: 12
    },
    packageEngines: async () => overrides.engines || [],
    settings: async () => overrides.settings || {},
    transaction: async fn => fn({ __tx: true }),
    audit: async (...args) => calls.push({ kind: 'audit', args })
  }
  return repo
}

const fakeAuth = () => ({
  hash: async p => `hashed:${p}`,
  revoked: [],
  async revokeUser(kind, id) { this.revoked.push([kind, id]) }
})

const ACTOR = { id: 1, username: 'admin' }

// ---------------------------------------------------------------- 编辑

test('编辑时禁止直接改余额 —— 必须走字符调整接口', async () => {
  const repo = fakeRepo({ before: { package_id: 5, package_catalog_version: 1 } })
  const svc = new AdminAccountService(repo, fakeAuth())
  await assert.rejects(
    () => svc.update({ id: 1, charBalance: 500 }, ACTOR, ''),
    err => err.code === 'USE_CHARACTER_GRANT'
  )
  // 余额是空串等于没填，应该放行
  await svc.update({ id: 1, charBalance: '', versionId: 5 }, ACTOR, '')
})

test('只改备注不换套餐 → 不动已钉权益版本（防止擅自改变已售权益）', async () => {
  const repo = fakeRepo({
    before: { package_id: 5, package_catalog_version: 3 },
    pack: { id: 5, catalogVersion: 9 }
  })
  const svc = new AdminAccountService(repo, fakeAuth())
  await svc.update({ id: 1, versionId: 5, remarks: '改个备注' }, ACTOR, '')

  const upd = repo.calls.find(c => c.kind === 'query' && /^UPDATE users SET nickname/.test(c.sql.trim()))
  // $12 是 package_catalog_version —— 没换套餐必须传 null（COALESCE 保持原值）
  assert.equal(upd.params[11], null, '没换套餐时 catalogVersion 必须是 null')
})

test('换套餐 → 钉到新套餐的当前版本', async () => {
  const repo = fakeRepo({
    before: { package_id: 5, package_catalog_version: 3 },
    pack: { id: 8, catalogVersion: 11 }
  })
  const svc = new AdminAccountService(repo, fakeAuth())
  await svc.update({ id: 1, versionId: 8 }, ACTOR, '')

  const upd = repo.calls.find(c => c.kind === 'query' && /^UPDATE users SET nickname/.test(c.sql.trim()))
  assert.equal(upd.params[11], 11, '换套餐时必须钉到新版本')
})

test('显式指定 catalogVersion 优先于自动判断', async () => {
  const repo = fakeRepo({
    before: { package_id: 5, package_catalog_version: 3 },
    pack: { id: 5, catalogVersion: 9 }
  })
  const svc = new AdminAccountService(repo, fakeAuth())
  await svc.update({ id: 1, versionId: 5, catalogVersion: 2 }, ACTOR, '')

  const upd = repo.calls.find(c => c.kind === 'query' && /^UPDATE users SET nickname/.test(c.sql.trim()))
  assert.equal(upd.params[11], 2)
})

test('catalogVersion 小于 1 直接拒绝', async () => {
  const repo = fakeRepo({ before: { package_id: 5, package_catalog_version: 3 } })
  const svc = new AdminAccountService(repo, fakeAuth())
  await assert.rejects(
    () => svc.update({ id: 1, versionId: 5, catalogVersion: 0 }, ACTOR, ''),
    err => err.code === 'BAD_CATALOG_VERSION'
  )
})

test('布尔开关用 bool() 而不是 Number() —— 字符串 "true" 必须存成开', async () => {
  const repo = fakeRepo({ before: { package_id: 5, package_catalog_version: 1 } })
  const svc = new AdminAccountService(repo, fakeAuth())
  await svc.update({ id: 1, versionId: 5, enterprise: 'true', autoReply: 'true' }, ACTOR, '')

  const upd = repo.calls.find(c => c.kind === 'query' && /^UPDATE users SET nickname/.test(c.sql.trim()))
  // $10 = enterprise, $13 = autoReply
  assert.equal(upd.params[9], true, 'enterprise "true" 必须解析成 true')
  assert.equal(upd.params[12], true, 'autoReply "true" 必须解析成 true')
})

test('密码重置 → 立刻踢掉在线会话（不能只等下次登录失败）', async () => {
  const repo = fakeRepo({ before: { package_id: 5, package_catalog_version: 1 } })
  const auth = fakeAuth()
  const svc = new AdminAccountService(repo, auth)
  await svc.update({ id: 42, versionId: 5, password: 'newpw' }, ACTOR, '')

  assert.deepEqual(auth.revoked, [['main', 42]])
  const upd = repo.calls.find(c => c.kind === 'query' && /^UPDATE users SET nickname/.test(c.sql.trim()))
  assert.equal(upd.params[6], 'hashed:newpw')
})

test('只改备注不重置密码 → 不踢人', async () => {
  const repo = fakeRepo({ before: { package_id: 5, package_catalog_version: 1 } })
  const auth = fakeAuth()
  const svc = new AdminAccountService(repo, auth)
  await svc.update({ id: 42, versionId: 5, remarks: 'x' }, ACTOR, '')
  assert.deepEqual(auth.revoked, [])
})

test('用户不存在时报 404', async () => {
  const repo = fakeRepo({ before: null })
  const svc = new AdminAccountService(repo, fakeAuth())
  await assert.rejects(
    () => svc.update({ id: 999, versionId: 5 }, ACTOR, ''),
    err => err.code === 'USER_NOT_FOUND'
  )
})

// ---------------------------------------------------------------- 新建

test('新建：子额度未填时继承套餐，否则新商户一进来就开不了子账号', async () => {
  const repo = fakeRepo({ pack: { id: 5, catalogVersion: 1, portLimit: 3, subQuota: 12 } })
  const svc = new AdminAccountService(repo, fakeAuth())
  await svc.create({ username: 'newbie', password: 'p', versionId: 5, charBalance: '0' }, ACTOR, '')

  const ins = repo.calls.find(c => c.kind === 'query' && /^INSERT INTO users\(username/.test(c.sql.trim()))
  assert.equal(ins.params[13], 12, '子额度应继承套餐的 12')
})

test('新建：显式填了子额度就用填的', async () => {
  const repo = fakeRepo({ pack: { id: 5, catalogVersion: 1, portLimit: 3, subQuota: 12 } })
  const svc = new AdminAccountService(repo, fakeAuth())
  await svc.create({ username: 'n', password: 'p', versionId: 5, subQuota: '3', charBalance: '0' }, ACTOR, '')
  const ins = repo.calls.find(c => c.kind === 'query' && /^INSERT INTO users\(username/.test(c.sql.trim()))
  assert.equal(ins.params[13], 3)
})

test('新建：默认通道按「已接通且启用」挑，不能写死某个通道', async () => {
  const repo = fakeRepo({
    pack: { id: 5, catalogVersion: 1, portLimit: 3, subQuota: 0 },
    engines: [
      { id: 'youdao', enabled: 1, wired: 0 },     // 启用了但没接通
      { id: 'gpt', enabled: 1, wired: 1 },        // 这个才该被选中
      { id: 'claude', enabled: 0, wired: 1 }
    ]
  })
  const svc = new AdminAccountService(repo, fakeAuth())
  await svc.create({ username: 'n', password: 'p', versionId: 5, charBalance: '0' }, ACTOR, '')

  const ins = repo.calls.find(c => c.kind === 'query' && /^INSERT INTO users\(username/.test(c.sql.trim()))
  assert.equal(ins.params[10], 'gpt', '应选已接通且启用的第一个通道')
})

test('新建：后台设置了默认通道时优先用它', async () => {
  const repo = fakeRepo({
    pack: { id: 5, catalogVersion: 1, portLimit: 3, subQuota: 0 },
    settings: { 'translation.active_engine': 'claude' },
    engines: [{ id: 'gpt', enabled: 1, wired: 1 }]
  })
  const svc = new AdminAccountService(repo, fakeAuth())
  await svc.create({ username: 'n', password: 'p', versionId: 5, charBalance: '0' }, ACTOR, '')
  const ins = repo.calls.find(c => c.kind === 'query' && /^INSERT INTO users\(username/.test(c.sql.trim()))
  assert.equal(ins.params[10], 'claude')
})

test('新建：有赠送额度就落一张试用充值单，否则余额没有账目来源', async () => {
  const repo = fakeRepo({ pack: { id: 5, catalogVersion: 1, portLimit: 3, subQuota: 0 } })
  const svc = new AdminAccountService(repo, fakeAuth())
  const result = await svc.create({ username: 'n', password: 'p', versionId: 5, charBalance: '5000' }, ACTOR, '')

  assert.equal(result.gift, 5000)
  const recharge = repo.calls.find(c => c.kind === 'query' && /INSERT INTO recharges/.test(c.sql))
  assert.ok(recharge, '赠送必须落充值单')
  assert.equal(recharge.params[3], 5000, '充值单字符数应与赠送一致')
})

test('新建：赠送额度为 0 时不落充值单', async () => {
  const repo = fakeRepo({ pack: { id: 5, catalogVersion: 1, portLimit: 3, subQuota: 0 } })
  const svc = new AdminAccountService(repo, fakeAuth())
  await svc.create({ username: 'n', password: 'p', versionId: 5, charBalance: '0' }, ACTOR, '')
  assert.ok(!repo.calls.some(c => c.kind === 'query' && /INSERT INTO recharges/.test(c.sql)))
})

test('新建：没填账号直接拒绝', async () => {
  const svc = new AdminAccountService(fakeRepo(), fakeAuth())
  await assert.rejects(
    () => svc.create({ password: 'p', versionId: 5 }, ACTOR, ''),
    err => err.code === 'USERNAME_REQUIRED'
  )
})

test('新建：INSERT 的列数与占位符数一致（曾经 16 列 17 值导致整条路径 500）', async () => {
  const repo = fakeRepo({ pack: { id: 5, catalogVersion: 1, portLimit: 3, subQuota: 0 } })
  const svc = new AdminAccountService(repo, fakeAuth())
  await svc.create({ username: 'n', password: 'p', versionId: 5, charBalance: '0' }, ACTOR, '')

  const ins = repo.calls.find(c => c.kind === 'query' && /^INSERT INTO users\(username/.test(c.sql.trim()))
  // 取 INSERT 的列清单
  const columns = ins.sql.match(/INSERT INTO users\(([^)]+)\)/)[1].split(',')
  // 取 VALUES 里的占位符（$1..$16），$16 在 CASE WHEN 里
  const placeholders = new Set((ins.sql.match(/\$\d+/g) || []))
  assert.equal(columns.length, 16, `列数应为 16，实际 ${columns.length}`)
  assert.equal(placeholders.size, 16, `占位符应为 $1..$16，实际 ${[...placeholders].join(',')}`)
  assert.equal(ins.params.length, 16, `绑定参数应为 16 个，实际 ${ins.params.length}`)
})

test('新建：钉住建号那一刻的权益版本', async () => {
  const repo = fakeRepo({ pack: { id: 5, catalogVersion: 9, portLimit: 3, subQuota: 0 } })
  const svc = new AdminAccountService(repo, fakeAuth())
  await svc.create({ username: 'n', password: 'p', versionId: 5, charBalance: '0' }, ACTOR, '')
  const ins = repo.calls.find(c => c.kind === 'query' && /^INSERT INTO users\(username/.test(c.sql.trim()))
  assert.equal(ins.params[14], 9, '新商户应钉到套餐当前版本 9')
})
