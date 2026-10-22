'use strict'

/**
 * PackageService 的校验与写库行为。
 *
 * ## 为什么单独测
 *
 * 这些规则原本埋在 `/admin/packages/save` 这条 178 行的路由里，
 * 靠"读源码看有没有这行"的静态断言守着。抽成 service 后，
 * 静态断言就失效了 —— 它只能确认"代码里有 `CODE_PATTERN`"，
 * 确认不了"`Pro` 会不会被拒"。
 *
 * 而这些规则直接决定**商户付多少钱、买完能用多少字符**，
 * 写错不是显示问题，是资金与权益错误。所以必须真跑。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const { PackageService, CODE_PATTERN } = require('../server/services/package-service')

/** 造一个只记录调用的假 repo */
function fakeRepo({ knownEngines = ['gpt', 'claude'], existingPackage = true } = {}) {
  const calls = []
  return {
    calls,
    query: async (sql, params, client) => {
      calls.push({ sql, params, client })
      if (/SELECT id FROM engines WHERE id = ANY/.test(sql)) {
        return { rows: params[0].filter(id => knownEngines.includes(id)).map(id => ({ id })) }
      }
      if (/UPDATE packages/.test(sql)) {
        return { rows: existingPackage ? [{ id: params[0] }] : [] }
      }
      if (/INSERT INTO packages/.test(sql)) return { rows: [{ id: 77 }] }
      return { rows: [] }
    },
    transaction: async fn => fn({ __tx: true }),
    audit: async () => { calls.push({ sql: 'AUDIT' }) }
  }
}

test('套餐标识：大写会被归一化，非法字符被拒', async () => {
  const svc = new PackageService(fakeRepo())

  // 大小写混用会变成两个指向同一件事的套餐，所以要转小写
  const ok = await svc.normalize({ code: 'PRO-Yearly', title: '专业版' })
  assert.equal(ok.code, 'pro-yearly')

  for (const bad of ['1abc', 'a', '中文', 'a b', '']) {
    await assert.rejects(
      () => svc.normalize({ code: bad, title: 'x' }),
      err => err.code === 'BAD_PACKAGE_CODE',
      `应拒绝 code=${JSON.stringify(bad)}`
    )
  }
})

test('名称不能为空（空白也算空）', async () => {
  const svc = new PackageService(fakeRepo())
  await assert.rejects(
    () => svc.normalize({ code: 'pro', title: '   ' }),
    err => err.code === 'PACKAGE_TITLE_REQUIRED'
  )
})

test('未知通道必须拦下，否则商户买了却翻译不了', async () => {
  const svc = new PackageService(fakeRepo({ knownEngines: ['gpt'] }))
  await assert.rejects(
    () => svc.normalize({ code: 'pro', title: 'x', engines: ['gpt', 'claude'] }),
    err => err.code === 'ENGINE_NOT_FOUND' && /claude/.test(err.message)
  )
})

test('金额与额度：负数、非法字符串一律夹到 0，不允许脏值入库', async () => {
  const svc = new PackageService(fakeRepo())

  const neg = await svc.normalize({ code: 'pro', title: 'x', price: -50, chars: -1, subQuota: -3, portLimit: -2 })
  assert.equal(neg.fields.price, 0)
  assert.equal(neg.fields.chars, 0)
  assert.equal(neg.fields.subQuota, 0)
  assert.equal(neg.fields.portLimit, 0)

  const junk = await svc.normalize({ code: 'pro', title: 'x', price: 'abc', chars: 'abc' })
  assert.equal(junk.fields.price, 0)
  assert.equal(junk.fields.chars, 0)

  // 小数要取整（字符数没有半个）
  const frac = await svc.normalize({ code: 'pro', title: 'x', chars: 1234.9 })
  assert.equal(frac.fields.chars, 1234)
})

test('price 保留小数，chars 取整', async () => {
  const svc = new PackageService(fakeRepo())
  const r = await svc.normalize({ code: 'pro', title: 'x', price: '19.99', chars: '50000' })
  assert.equal(r.fields.price, 19.99)
  assert.equal(r.fields.chars, 50000)
})

test('chars 与 includedChars 双名兼容（前后端叫法不一致）', async () => {
  const svc = new PackageService(fakeRepo())
  const r = await svc.normalize({ code: 'pro', title: 'x', includedChars: '8000' })
  assert.equal(r.fields.chars, 8000)
})

test('portUnlimited 缺省为 true（存量套餐都是不限端口）', async () => {
  const svc = new PackageService(fakeRepo())
  assert.equal((await svc.normalize({ code: 'pro', title: 'x' })).fields.portUnlimited, true)
  assert.equal((await svc.normalize({ code: 'pro', title: 'x', portUnlimited: '0' })).fields.portUnlimited, false)
  assert.equal((await svc.normalize({ code: 'pro', title: 'x', portUnlimited: 1 })).fields.portUnlimited, true)
})

test('JSON 列：对象/数组/字符串三种形态都认，类型不符报对应错误码', async () => {
  const svc = new PackageService(fakeRepo())

  // 对象
  let r = await svc.normalize({ code: 'pro', title: 'x', features: { a: 1 }, clients: { b: 2 } })
  assert.deepEqual(r.fields.features, { a: 1 })
  assert.deepEqual(r.fields.clients, { b: 2 })

  // JSON 字符串（表单序列化后就是字符串）
  r = await svc.normalize({ code: 'pro', title: 'x', features: '{"a":1}', engines: '["gpt"]' })
  assert.deepEqual(r.fields.features, { a: 1 })
  assert.deepEqual(r.engineIds, ['gpt'])

  // 类型不符
  await assert.rejects(
    () => svc.normalize({ code: 'pro', title: 'x', features: [1, 2] }),
    err => err.code === 'BAD_PACKAGE_FEATURES'
  )
  await assert.rejects(
    () => svc.normalize({ code: 'pro', title: 'x', engines: { a: 1 } }),
    err => err.code === 'BAD_PACKAGE_ENGINES'
  )

  // 坏 JSON 沿用路由层原有的错误码，否则前端会显示成未知错误
  await assert.rejects(
    () => svc.normalize({ code: 'pro', title: 'x', features: '{坏的' }),
    err => err.code === 'BAD_JSON'
  )
})

test('保存：更新与新建走不同 SQL，且关联表整体重建', async () => {
  // 更新
  let repo = fakeRepo()
  let svc = new PackageService(repo)
  await svc.save({ id: 5, code: 'pro', title: '专业版', engines: ['gpt', 'claude'] }, { id: 1 }, '1.2.3.4')

  assert.ok(repo.calls.some(c => /UPDATE packages/.test(c.sql)), '应走 UPDATE')
  assert.ok(!repo.calls.some(c => /INSERT INTO packages/.test(c.sql)), '更新不应 INSERT')
  assert.ok(repo.calls.some(c => /DELETE FROM package_engines/.test(c.sql)), '应删旧关联')
  assert.ok(repo.calls.some(c => /INSERT INTO package_engines/.test(c.sql)), '应插新关联')
  assert.ok(repo.calls.some(c => c.sql === 'AUDIT'), '应写审计')

  // 新建
  repo = fakeRepo()
  svc = new PackageService(repo)
  const id = await svc.save({ code: 'pro', title: '专业版' }, { id: 1 }, '')
  assert.equal(id, 77)
  assert.ok(repo.calls.some(c => /INSERT INTO packages/.test(c.sql)), '新建应 INSERT')
})

test('保存：包不存在时报 404，不能静默成功', async () => {
  const repo = fakeRepo({ existingPackage: false })
  const svc = new PackageService(repo)
  await assert.rejects(
    () => svc.save({ id: 999, code: 'pro', title: 'x' }, { id: 1 }, ''),
    err => err.code === 'PACKAGE_NOT_FOUND'
  )
})

test('CODE_PATTERN 与库里的约束口径一致', () => {
  assert.ok(CODE_PATTERN.test('pro'))
  assert.ok(CODE_PATTERN.test('pro-yearly'))
  assert.ok(CODE_PATTERN.test('pro_yearly_v2'))
  assert.ok(!CODE_PATTERN.test('a'))          // 太短
  assert.ok(!CODE_PATTERN.test('1pro'))       // 数字开头
  assert.ok(!CODE_PATTERN.test('pro yearly')) // 空格
})
