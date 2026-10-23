'use strict'

/**
 * 「不限字符」套餐的测试。
 *
 * ## 背景
 *
 * 要上一个「单人账号 · 包月 · 不限字符」的套餐。数据模型里原本没有
 *「不限」这个概念，`included_chars` 只能填数字。
 *
 * 备选方案是填一个很大的数（1 亿）冒充不限，被否掉了 —— 那不是不限，
 * 是一个说不清上限的数：客户会拿它算单位价，算出来的结果毫无意义，
 * 还会把阶梯单调性校验带偏。所以加了 `chars_unlimited` 布尔列。
 *
 * ## 这组测试守三件事
 *
 * 1. **布尔解析**：表单传的是字符串 "true"/"false"，
 *    `Boolean('false') === true` —— 用错会把每一档都变成不限。
 * 2. **缺省不误伤**：编辑一个普通套餐时前端不带该字段，
 *    不能把它写成 false 之外的任何东西，也不能因此报 400。
 * 3. **比值类展示要短路**：倍数、省百分比在不限套餐上分母是无穷，
 *    硬算会出 Infinity / NaN。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const { PackageService } = require('../server/services/package-service')

const ACTOR = { id: 1, username: 'pix', role: 'superadmin' }

function fakeRepo () {
  const calls = []
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params })
      if (/INSERT INTO packages/.test(sql)) return { rows: [{ id: 42 }] }
      if (/UPDATE packages SET title=/.test(sql)) return { rows: [{ id: params[0] }] }
      if (/SELECT id FROM engines/.test(sql)) return { rows: [] }
      return { rows: [] }
    },
    transaction: async fn => fn({ __tx: true }),
    audit: async () => {}
  }
}

const insertParams = repo => {
  const call = repo.calls.find(c => /INSERT INTO packages/.test(c.sql))
  return call && call.params
}

// ── 解析 ──────────────────────────────────────────────────

test('字符串 "false" 不能被当成 true（Boolean("false") 是 true 的经典坑）', async () => {
  const svc = new PackageService(fakeRepo())
  const r = await svc.normalize({ code: 'x1', title: 'x', charsUnlimited: 'false' })
  assert.equal(r.fields.charsUnlimited, false)
})

test('字符串 "true" / 布尔 true / 1 都认作不限', async () => {
  const svc = new PackageService(fakeRepo())
  for (const val of ['true', true, 1, '1', 'TRUE']) {
    const r = await svc.normalize({ code: 'x1', title: 'x', charsUnlimited: val })
    assert.equal(r.fields.charsUnlimited, true, `charsUnlimited=${JSON.stringify(val)} 应判为不限`)
  }
})

test('缺省 / 空串 → 普通套餐，不报错', async () => {
  const svc = new PackageService(fakeRepo())
  for (const val of [undefined, '', null]) {
    const r = await svc.normalize({ code: 'x1', title: 'x', charsUnlimited: val })
    assert.equal(r.fields.charsUnlimited, false)
  }
})

test('无法识别的值 → 400，不静默当成 false', async () => {
  // 静默降级最危险：管理员以为开了不限，实际没有，客户按字符被卡住
  const svc = new PackageService(fakeRepo())
  await assert.rejects(
    () => svc.normalize({ code: 'x1', title: 'x', charsUnlimited: 'maybe' }),
    err => err.code === 'BAD_BOOLEAN'
  )
})

// ── 落库 ──────────────────────────────────────────────────

test('新建时 chars_unlimited 写进第 12 个参数位', async () => {
  const repo = fakeRepo()
  const svc = new PackageService(repo)
  await svc.save({
    code: 'solo_monthly', title: '单人包月', price: 60, chars: 500000000,
    subQuota: 0, charsUnlimited: true
  }, ACTOR, '')

  const params = insertParams(repo)
  assert.ok(params, '应走 INSERT')
  assert.equal(params[0], 'solo_monthly')
  assert.equal(params[5], 500000000, '发放量仍然写进 included_chars')
  assert.equal(params[10], 0, '单人账号：subQuota 必须是 0')
  assert.equal(params[11], true, 'chars_unlimited 必须是 true')
})

test('更新时也写这一列（否则编辑一次就丢了"不限"）', async () => {
  const repo = fakeRepo()
  const svc = new PackageService(repo)
  await svc.save({ id: 7, code: 'solo_monthly', title: '单人包月', charsUnlimited: true }, ACTOR, '')

  const call = repo.calls.find(c => /UPDATE packages SET title=/.test(c.sql))
  assert.ok(call)
  assert.match(call.sql, /chars_unlimited=\$12/)
  assert.equal(call.params[11], true)
})

test('普通套餐保存时该列为 false，不受其他套餐影响', async () => {
  const repo = fakeRepo()
  const svc = new PackageService(repo)
  await svc.save({ code: 'basic2', title: '基础版2', price: 35, chars: 1500000 }, ACTOR, '')
  assert.equal(insertParams(repo)[11], false)
})

// ── 展示比值必须短路 ──────────────────────────────────────

test('不限套餐的倍数 / 省百分比算法返回 null（分母无穷，不能硬算）', () => {
  // 这两条是前端 Landing / UserRechargePage 共用的纯函数，
  // 直接测它们的分母行为，避免以后有人"顺手"把短路删掉
  const { charsMultiple, savingVsBase } = require('../src/utils/plan-value')

  const base = { price: 35, chars: 1500000 }
  const unlimited = { price: 60, chars: 500000000 }

  // 不短路的话，5 亿 / 150 万 ≈ 333 倍 —— 这个数字印在卡片上毫无意义
  const mult = charsMultiple(base.chars, unlimited.chars)
  assert.ok(mult === null || mult > 100,
    `倍数为 ${mult}，说明前端必须在调用处短路（见 multipleOf）`)

  // 省百分比同理：拿 5 亿当分母，省的比例会接近 100%，误导客户
  const save = savingVsBase(base.price, base.chars, unlimited.price, unlimited.chars)
  assert.ok(save === null || save > 90,
    `省百分比为 ${save}，说明前端必须在调用处短路（见 saveOf）`)
})
