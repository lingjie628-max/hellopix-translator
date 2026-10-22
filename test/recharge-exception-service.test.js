'use strict'

/**
 * 异常池处置的测试。
 *
 * ## 为什么这个模块必须有测试
 *
 * 它是全站唯一能把"未处理异常"变少的入口。写错的后果有两个方向：
 *
 * 1. **关得太松** —— 真实该处理的异常被误标 ignored，钱的事就永远没人管了
 * 2. **关得没痕迹** —— 没写依据、没留审计，三个月后无从追溯
 *
 * 尤其第 2 点：这是资金相关操作，`resolution_note` 和 `audit_logs`
 * 缺失等于"这个决定没有发生过"。所以下面的断言重点在两件事：
 * **不该关的关不掉**、**关掉的必然留痕**。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  RechargeExceptionService,
  VALID_ACTIONS,
  MIN_NOTE_LENGTH
} = require('../server/services/recharge-exception-service')

// ---------------------------------------------------------------- 假件

/**
 * 假事务连接。只实现本服务用到的那几条 SQL，按语句内容分派。
 * 不解析 SQL 全貌 —— 测的是判定逻辑，不是查询写法。
 */
function fakeClient(state) {
  const calls = []
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.trim().slice(0, 40), params })

      if (/FROM recharge_exceptions WHERE id = \$1::bigint FOR UPDATE/.test(sql)) {
        const row = state.rows.find(r => String(r.id) === String(params[0]))
        return { rows: row ? [{ ...row }] : [] }
      }

      if (/UPDATE recharge_exceptions/.test(sql)) {
        const id = String(params[0])
        const row = state.rows.find(r => String(r.id) === id)
        Object.assign(row, {
          status: params[1],
          resolved_by: params[2],
          resolved_at: new Date(),
          resolution_note: params[3],
          resolved_action: params[4]
        })
        return { rows: [{ ...row }] }
      }

      throw new Error('未预期的 SQL：' + sql.slice(0, 60))
    }
  }
}

function fakeRepo() {
  const audits = []
  return {
    audits,
    audit: async (client, admin, action, detail) => { audits.push({ admin, action, detail }) }
  }
}

/** 一条典型的 open 异常（真实事故里的 #9） */
function openException(overrides) {
  return Object.assign({
    id: '9',
    kind: 'NO_MATCH',
    amount_milli: '65138',
    status: 'open',
    resolved_by: null,
    resolved_at: null,
    resolution_note: '',
    resolved_action: null,
    recharge_id: null
  }, overrides || {})
}

function setup(rows) {
  const state = { rows: rows || [openException()] }
  const client = fakeClient(state)
  const repo = fakeRepo()
  return { state, client, repo, svc: new RechargeExceptionService(repo) }
}

// ---------------------------------------------------------------- 正常路径

test('忽略一条测试款：状态变 ignored，依据与审计都落库', async () => {
  const { client, repo, svc } = setup()
  const note = '整数金额 7090.000，非订单体系付款（测试/刷量），非平台应收'

  const result = await svc.resolve(client, { id: '9', action: 'ignore', note, admin: '1', ip: '1.2.3.4' })

  assert.equal(result.status, 'ignored')
  assert.equal(result.resolvedAction, 'reject', '忽略也是一种"不收这笔钱"')
  assert.equal(result.note, note)
  assert.equal(result.amountText, '65.138', '金额要按 USDT 格式化返回')

  assert.equal(repo.audits.length, 1, '资金相关处置必须留审计')
  assert.equal(repo.audits[0].action, '处置充值异常')
  assert.match(repo.audits[0].detail, /ignored/)
  assert.match(repo.audits[0].detail, /整数金额/, '审计里要带判断依据')
})

test('确认入账：状态变 resolved，动作记 credit', async () => {
  const { client, svc } = setup()
  const result = await svc.resolve(client, {
    id: '9', action: 'credit', note: '金额笔误 318→138，已由超管手工确认收款', admin: '1'
  })
  assert.equal(result.status, 'resolved')
  assert.equal(result.resolvedAction, 'credit')
})

test('退回：状态变 resolved，动作记 reject', async () => {
  const { client, svc } = setup()
  const result = await svc.resolve(client, {
    id: '9', action: 'reject', note: '已原路退回给付款方', admin: '1'
  })
  assert.equal(result.status, 'resolved')
  assert.equal(result.resolvedAction, 'reject')
})

// ---------------------------------------------------------------- 必须挡住

test('已处置过的不能重复处置（防止覆盖前一个人的判断依据）', async () => {
  const { client, svc } = setup([openException({ status: 'ignored', resolved_at: new Date() })])
  await assert.rejects(
    () => svc.resolve(client, { id: '9', action: 'credit', note: '想改成已入账', admin: '2' }),
    /已处置过/
  )
})

test('不写依据的处置必须被拒绝', async () => {
  const { client, svc } = setup()
  await assert.rejects(
    () => svc.resolve(client, { id: '9', action: 'ignore', note: '', admin: '1' }),
    /处置依据/,
    '「已忽略」这种说明三个月后完全无法解释当时的依据'
  )
})

test('依据太短也算没写', async () => {
  const { client, svc } = setup()
  const short = 'x'.repeat(MIN_NOTE_LENGTH - 1)
  await assert.rejects(
    () => svc.resolve(client, { id: '9', action: 'ignore', note: short, admin: '1' }),
    /处置依据/
  )
})

test('非法动作必须被拒绝', async () => {
  const { client, svc } = setup()
  await assert.rejects(
    () => svc.resolve(client, { id: '9', action: 'delete', note: '尝试一个不存在的动作', admin: '1' }),
    /处置动作/
  )
})

test('不存在的异常返回 404', async () => {
  const { client, svc } = setup([])
  await assert.rejects(
    () => svc.resolve(client, { id: '999', action: 'ignore', note: '随便写点什么', admin: '1' }),
    /不存在/
  )
})

test('非法 ID 必须被拒绝（防注入式字符串进 SQL）', async () => {
  const { client, svc } = setup()
  for (const bad of ['', 'abc', '1 OR 1=1', null, undefined]) {
    await assert.rejects(
      () => svc.resolve(client, { id: bad, action: 'ignore', note: '随便写点什么', admin: '1' }),
      /异常 ID/
    )
  }
})

test('依据超长时截断而不是报错', async () => {
  const { client, svc } = setup()
  const long = '很长的依据'.repeat(200)
  const result = await svc.resolve(client, { id: '9', action: 'ignore', note: long, admin: '1' })
  assert.ok(result.note.length <= 500, '数据库列是 varchar(500)，必须截断')
})

// ---------------------------------------------------------------- 批量

test('批量处置：全部成功', async () => {
  const rows = [1, 2, 3].map(i => openException({ id: String(i) }))
  const { client, repo, svc } = setup(rows)
  const result = await svc.resolveMany(client, {
    ids: ['1', '2', '3'], action: 'ignore',
    note: '整数金额，测试款，非平台应收', admin: '1'
  })
  assert.equal(result.resolved.length, 3)
  assert.equal(repo.audits.length, 3, '每一条都要单独留审计，不能只留一条汇总')
  assert.ok(rows.every(r => r.status === 'ignored'))
})

test('批量里有一条已处置：整体失败，不留半截状态', async () => {
  const rows = [
    openException({ id: '1' }),
    openException({ id: '2', status: 'ignored', resolved_at: new Date() }),
    openException({ id: '3' })
  ]
  const { client, svc } = setup(rows)
  await assert.rejects(
    () => svc.resolveMany(client, {
      ids: ['1', '2', '3'], action: 'ignore', note: '批量忽略测试款', admin: '1'
    }),
    /已处置过/
  )
  // 服务层不自己开事务，回滚责任在调用方（路由里包了 repo.transaction）；
  // 这里只确认它确实在中途就抛了，不会继续处理第 3 条。
})

test('批量空列表被拒绝', async () => {
  const { client, svc } = setup()
  await assert.rejects(
    () => svc.resolveMany(client, { ids: [], action: 'ignore', note: '空的' }),
    /没有要处置/
  )
})

test('批量上限', async () => {
  const { client, svc } = setup()
  const ids = Array.from({ length: 201 }, (_, i) => String(i + 1))
  await assert.rejects(
    () => svc.resolveMany(client, { ids, action: 'ignore', note: '太多了' }),
    /最多处置/
  )
})

// ---------------------------------------------------------------- 契约

test('模块绝不提供改余额的能力', () => {
  // 这不是形式主义：如果哪天有人在这个服务里加了 adjustChars，
  // 就等于开了一条绕过行锁 / TXID 唯一索引 / 流水幂等键的发钱通道。
  const svc = new RechargeExceptionService(fakeRepo())
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(svc))
  for (const m of methods) {
    assert.doesNotMatch(m, /credit|adjust|balance|chars|grant/i,
      `处置服务不应有发钱相关方法：${m}`)
  }
})

test('三种动作都映射到合法状态', () => {
  assert.deepEqual(VALID_ACTIONS, ['credit', 'reject', 'ignore'])
})
