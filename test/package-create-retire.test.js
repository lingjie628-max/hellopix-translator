'use strict'

/**
 * 套餐新增 / 下架的测试。
 *
 * ## 背景
 *
 * 后端一直支持创建（`save()` 里 `data.id ? 更新 : 插入`），但管理端只做了
 * 「编辑」。结果套餐实际被写死成初始那三档：想加一档企业版、想加一档试用装，
 * 都只能改库。
 *
 * 这里守的是**创建这条路径本身**，以及新加的下架护栏：
 *
 *   1. 不带 id = 插入，不被误判成更新（最危险的一种：覆盖已有套餐）
 *   2. 下架是软删，不动 active=true 之外的东西
 *   3. 不能下架最后一档 —— 否则充值页空白，等于关店
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const { PackageService } = require('../server/services/package-service')

const ACTOR = { id: 1, username: 'pix', role: 'superadmin' }

/**
 * 假 repo：记录每条 SQL，并按内容分派结果。
 *
 * `activeCount` 是"除了当前这档之外还剩几档在售"，用来测最后一档护栏。
 */
function fakeRepo ({ activeCount = 2, pkg = { id: 5, title: '专业版', active: true } } = {}) {
  const calls = []
  return {
    calls,
    query: async (sql, params, _client) => {
      calls.push({ sql, params })
      if (/FROM packages WHERE id=\$1 FOR UPDATE/.test(sql)) {
        return { rows: pkg ? [pkg] : [] }
      }
      if (/count\(\*\)::int AS n FROM packages WHERE active=true AND id<>/.test(sql)) {
        return { rows: [{ n: activeCount }] }
      }
      if (/UPDATE packages SET active=false/.test(sql)) return { rows: [] }
      if (/INSERT INTO packages/.test(sql)) return { rows: [{ id: 99 }] }
      if (/UPDATE packages SET title=/.test(sql)) return { rows: [{ id: params[0] }] }
      if (/DELETE FROM package_engines/.test(sql)) return { rows: [] }
      if (/INSERT INTO package_engines/.test(sql)) return { rows: [] }
      if (/SELECT id FROM engines WHERE id = ANY/.test(sql)) {
        return { rows: (params[0] || []).map(id => ({ id })) }
      }
      return { rows: [] }
    },
    transaction: async fn => fn({ __tx: true }),
    audit: async (_c, _a, action) => { calls.push({ sql: 'AUDIT:' + action }) }
  }
}

const sqlOf = repo => repo.calls.map(c => c.sql).join('\n')

// ── 创建 ──────────────────────────────────────────────────

test('不带 id → 走 INSERT，不是 UPDATE', async () => {
  const repo = fakeRepo()
  const svc = new PackageService(repo)

  const id = await svc.save({ code: 'enterprise', title: '企业版', price: 399, chars: 20000000 }, ACTOR, '')
  assert.equal(id, 99)

  const sql = sqlOf(repo)
  assert.match(sql, /INSERT INTO packages/)
  assert.doesNotMatch(sql, /UPDATE packages SET title=/, '新建不该碰到任何已有套餐')
  assert.match(sql, /AUDIT:新建套餐/)
})

test('带 id → 走 UPDATE，且提示是"编辑"', async () => {
  const repo = fakeRepo()
  const svc = new PackageService(repo)

  await svc.save({ id: 5, code: 'pro', title: '专业版', price: 199 }, ACTOR, '')

  const sql = sqlOf(repo)
  assert.match(sql, /UPDATE packages SET title=/)
  assert.doesNotMatch(sql, /INSERT INTO packages/)
  assert.match(sql, /AUDIT:编辑套餐/)
})

test('id 为字符串数字也要认得出是更新（前端可能传 "5"）', async () => {
  const repo = fakeRepo()
  const svc = new PackageService(repo)
  await svc.save({ id: '5', code: 'pro', title: '专业版' }, ACTOR, '')
  assert.match(sqlOf(repo), /UPDATE packages SET title=/)
})

test('id 为 0 / 空串视作新建，不是"更新 id=0"', async () => {
  for (const id of [0, '', null, undefined]) {
    const repo = fakeRepo()
    const svc = new PackageService(repo)
    await svc.save({ id, code: 'basic2', title: '基础版2' }, ACTOR, '')
    assert.match(sqlOf(repo), /INSERT INTO packages/, `id=${JSON.stringify(id)} 应走插入`)
  }
})

test('新建时通道关联表照样重建', async () => {
  const repo = fakeRepo()
  const svc = new PackageService(repo)
  await svc.save({ code: 'vip', title: 'VIP', engines: ['gpt'] }, ACTOR, '')

  const sql = sqlOf(repo)
  assert.match(sql, /DELETE FROM package_engines/)
  assert.match(sql, /INSERT INTO package_engines/)
})

// ── 下架 ──────────────────────────────────────────────────

test('下架是软删：置 active=false，不 DELETE 行', async () => {
  const repo = fakeRepo({ activeCount: 2 })
  const svc = new PackageService(repo)

  const title = await svc.retire({ id: 5 }, ACTOR, '')
  assert.equal(title, '专业版')

  const sql = sqlOf(repo)
  assert.match(sql, /UPDATE packages SET active=false/)
  assert.doesNotMatch(sql, /DELETE FROM packages/, '不能物理删：历史订单还引用着它')
  assert.match(sql, /AUDIT:下架套餐/)
})

test('下架最后一档 → 409，不允许把店关空', async () => {
  const repo = fakeRepo({ activeCount: 0 })
  const svc = new PackageService(repo)

  await assert.rejects(
    () => svc.retire({ id: 5 }, ACTOR, ''),
    err => err.code === 'LAST_PACKAGE'
  )
  assert.doesNotMatch(sqlOf(repo), /UPDATE packages SET active=false/,
    '被拒绝时不该留下写操作')
})

test('已经下架过的再点一次 → 幂等返回，不报错', async () => {
  const repo = fakeRepo({ pkg: { id: 5, title: '旧套餐', active: false } })
  const svc = new PackageService(repo)

  const title = await svc.retire({ id: 5 }, ACTOR, '')
  assert.equal(title, '旧套餐')
  assert.doesNotMatch(sqlOf(repo), /UPDATE packages SET active=false/)
})

test('套餐不存在 → 404', async () => {
  const repo = fakeRepo({ pkg: null })
  const svc = new PackageService(repo)
  await assert.rejects(
    () => svc.retire({ id: 999 }, ACTOR, ''),
    err => err.code === 'PACKAGE_NOT_FOUND'
  )
})

test('缺少 / 非法 id → 400，且不碰数据库', async () => {
  for (const bad of [{}, { id: 'abc' }, { id: -1 }, { id: 1.5 }]) {
    const repo = fakeRepo()
    const svc = new PackageService(repo)
    await assert.rejects(
      () => svc.retire(bad, ACTOR, ''),
      err => err.code === 'PACKAGE_ID_REQUIRED',
      `应拒绝 ${JSON.stringify(bad)}`
    )
    assert.equal(repo.calls.length, 0, '非法入参不该产生任何 SQL')
  }
})
