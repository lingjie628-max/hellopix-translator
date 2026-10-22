'use strict'

/**
 * 下单（/userRecharge/create）的业务规则。
 *
 * ## 为什么这条必须有真跑测试
 *
 * 这是**资金主路径**。算错一分钱，链上就对不上，钱只能进异常池人工捞。
 * 原实现埋在 113 行的路由里，只能靠"读源码断言写了这行"来守 ——
 * 那种测试证明不了"金额算对了"，只能证明"代码里有 parseMilli 这个词"。
 *
 * 下面每条都对应一个**真实踩过的坑**（注释在 service 里）。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const { RechargeOrderService, RECHARGE_TTL_MINUTES } = require('../server/services/recharge-order-service')
const { USDT_TRC20_CONTRACT } = require('../server/services/tron/transfer')

const ADDRESS = 'TXxxxValidLookingAddress0000000000000'

/** 造一个记录所有 SQL 的假 client/repo */
function harness(overrides = {}) {
  const inserts = []
  const attached = []
  const client = {
    query: async (sql, params) => {
      inserts.push({ sql, params })
      return { rows: [{ id: 101, order_number: params[2], quantity: params[4], chars: params[5] }] }
    }
  }
  const repo = {
    package: async () => overrides.pack || {
      id: 5, title: '专业版', catalogVersion: 12, price: 100
    },
    transaction: async fn => fn(client)
  }
  const core = {
    quote: async () => overrides.quote || {
      qty: 1,
      chars: 100000,
      originalMilli: '100000',
      discountMilli: '10000',
      paidMilli: '90000'      // 90.000
    }
  }
  const rechargeAmount = {
    allocate: async (c, params) => {
      assert.equal(c, client, 'allocate 必须拿到事务里的同一个 client')
      if (overrides.allocation) return overrides.allocation
      // **按真实公式算**：实付 = 传入的 baseAmountMilli + 尾数。
      //
      // 这里绝不能返回写死的 amountMilli —— 第一版就是这么写的，
      // 结果把 parseMilli 换成 toMilli（金额放大一千倍）测试照样全绿：
      // 假对象根本不看传入的 baseAmountMilli，被测逻辑被屏蔽了。
      // 这个测试的价值全在"它真的用了传入的基数"，所以必须在这里算。
      const suffixMilli = overrides.suffixMilli === undefined ? 37n : overrides.suffixMilli
      return {
        reservationId: 7,
        suffixMilli,
        amountMilli: params.baseAmountMilli + suffixMilli
      }
    },
    attachToRecharge: async (c, reservationId, rechargeId) => {
      attached.push({ reservationId, rechargeId })
    }
  }
  const settings = {
    paymentChannels: async () => overrides.channels || [{
      id: 'usdt-trc20', name: 'USDT', network: 'TRC20', address: ADDRESS, note: ''
    }]
  }
  return {
    svc: new RechargeOrderService({ repo, core, rechargeAmount, settings }),
    inserts,
    attached
  }
}

const MAIN_USER = { kind: 'main', account: { id: 1 }, parent: { id: 1 } }

// ---------------------------------------------------------------- 权限与前置

test('子账号不能下单（资金只认主账号）', async () => {
  const { svc } = harness()
  await assert.rejects(
    () => svc.create({ user: { kind: 'sub', parent: { id: 1 } }, data: { baseid: 5 } }),
    err => err.code === 'MAIN_ACCOUNT_REQUIRED'
  )
})

test('套餐不存在 → 404，不能在缺套餐时继续算钱', async () => {
  const { svc } = harness({ pack: null })
  const repo = { package: async () => null, transaction: async fn => fn({}) }
  const real = new RechargeOrderService({
    repo,
    core: { quote: async () => ({ qty: 1, chars: 1, originalMilli: '1', discountMilli: '0', paidMilli: '1' }) },
    rechargeAmount: { allocate: async () => { throw new Error('不该走到这里') } },
    settings: { paymentChannels: async () => [] }
  })
  await assert.rejects(
    () => real.create({ user: MAIN_USER, data: { baseid: 999 } }),
    err => err.code === 'PACKAGE_NOT_FOUND'
  )
  assert.ok(svc)
})

test('没有可用收款渠道 → 503，不能让商户拿到空地址', async () => {
  const { svc } = harness({ channels: [] })
  await assert.rejects(
    () => svc.create({ user: MAIN_USER, data: { baseid: 5 } }),
    err => err.code === 'PAYMENT_NOT_CONFIGURED'
  )
})

test('指定 channelId 时用指定的；不认识的回落到第一个', async () => {
  const channels = [
    { id: 'a', name: 'A', network: 'TRC20', address: 'ADDR_A', note: '' },
    { id: 'b', name: 'B', network: 'TRC20', address: 'ADDR_B', note: '' }
  ]
  const { svc } = harness({ channels })
  const picked = await svc.create({ user: MAIN_USER, data: { baseid: 5, channelId: 'b' } })
  assert.equal(picked.channel.id, 'b')

  const fallback = await svc.create({ user: MAIN_USER, data: { baseid: 5, channelId: 'nope' } })
  assert.equal(fallback.channel.id, 'a')
})

// ---------------------------------------------------------------- 金额（核心）

test('金额全程 milli 整数：实付 = 折后价 + 尾数，一分不差', async () => {
  const { svc, inserts } = harness()
  const r = await svc.create({ user: MAIN_USER, data: { baseid: 5 } })

  // paidMilli 90000 + suffix 37 = 90037
  assert.equal(r.paidText, '90.037')
  assert.equal(r.originalText, '100.000')
  assert.equal(r.discountText, '10.000')
  assert.equal(r.surchargeText, '0.037')

  const ins = inserts.find(i => /INSERT INTO recharges/.test(i.sql))
  // 参数顺序：..., $6 original, $7 discount, $8 surcharge, $9 paid
  assert.equal(ins.params[6], '100.000', 'original_amount')
  assert.equal(ins.params[7], '10.000', 'discount_amount')
  assert.equal(ins.params[8], '0.037', 'surcharge_amount')
  assert.equal(ins.params[9], '90.037', 'paid_amount')
})

test('尾数必须加在整数毫上 —— 用 toMilli 会放大一千倍', async () => {
  const { svc } = harness()
  const r = await svc.create({ user: MAIN_USER, data: { baseid: 5 } })
  // 若误用 toMilli('90000')，结果是 90000000 毫 = 90000.000
  assert.equal(r.paidText, '90.037')
  assert.ok(!r.paidText.startsWith('9000'), '金额被放大了')
})

test('金额文本来自 milli，不是从 mapRow 的 Number 反推', async () => {
  // mapRow 会把 numeric 变成 JS Number（36.157），
  // formatMilli 只吃整数毫 —— 反推会直接抛
  const { svc } = harness()
  const r = await svc.create({ user: MAIN_USER, data: { baseid: 5 } })
  assert.match(r.paidText, /^\d+\.\d{3}$/, '金额必须是三位小数的精确文本')
})

test('尾数为 0 时金额仍是整数价，不出现 -0 或空值', async () => {
  const { svc, inserts } = harness({ suffixMilli: 0n })
  const r = await svc.create({ user: MAIN_USER, data: { baseid: 5 } })
  assert.equal(r.paidText, '90.000')
  assert.equal(r.surchargeText, '0.000')
  const ins = inserts.find(i => /INSERT INTO recharges/.test(i.sql))
  assert.equal(ins.params[8], '0.000')
})

// ---------------------------------------------------------------- 订单快照

test('订单必须快照收款地址与合约（换地址后历史订单才能核对）', async () => {
  const { svc, inserts } = harness()
  await svc.create({ user: MAIN_USER, data: { baseid: 5 } })
  const ins = inserts.find(i => /INSERT INTO recharges/.test(i.sql))
  assert.equal(ins.params[12], ADDRESS, 'pay_address 快照')
  assert.equal(ins.params[13], USDT_TRC20_CONTRACT, 'pay_token_contract 快照')
})

test('订单必须钉住套餐权益版本', async () => {
  const { svc, inserts } = harness({
    pack: { id: 5, title: 'x', catalogVersion: 12 }
  })
  await svc.create({ user: MAIN_USER, data: { baseid: 5 } })
  const ins = inserts.find(i => /INSERT INTO recharges/.test(i.sql))
  assert.equal(ins.params[15], 12)
})

test('套餐没有 catalogVersion 时存 null，不能存 0', async () => {
  const { svc, inserts } = harness({ pack: { id: 5, title: 'x' } })
  await svc.create({ user: MAIN_USER, data: { baseid: 5 } })
  const ins = inserts.find(i => /INSERT INTO recharges/.test(i.sql))
  assert.equal(ins.params[15], null)
})

test('订单号唯一且带 HP 前缀', async () => {
  const { svc, inserts } = harness()
  await svc.create({ user: MAIN_USER, data: { baseid: 5 } })
  await svc.create({ user: MAIN_USER, data: { baseid: 5 } })
  const nums = inserts.filter(i => /INSERT INTO recharges/.test(i.sql)).map(i => i.params[2])
  assert.equal(nums.length, 2)
  assert.match(nums[0], /^HP\d{10,}$/)
  assert.notEqual(nums[0], nums[1])
})

test('幂等键跟订单号一一对应', async () => {
  const { svc, inserts } = harness()
  await svc.create({ user: MAIN_USER, data: { baseid: 5 } })
  const ins = inserts.find(i => /INSERT INTO recharges/.test(i.sql))
  assert.equal(ins.params[10], `recharge:${ins.params[2]}`)
})

test('有效期 30 分钟，且 expires_at 落在 insert 的时刻上', async () => {
  const before = Date.now()
  const { svc, inserts } = harness()
  await svc.create({ user: MAIN_USER, data: { baseid: 5 } })
  const ins = inserts.find(i => /INSERT INTO recharges/.test(i.sql))
  const expires = new Date(ins.params[11]).getTime()
  const expected = before + RECHARGE_TTL_MINUTES * 60 * 1000
  assert.ok(Math.abs(expires - expected) < 5000,
    `expires_at 应约等于 now + ${RECHARGE_TTL_MINUTES} 分钟，实际差 ${expires - expected}ms`)
})

test('预约先分配、订单后插入，再回填归属', async () => {
  const { svc, inserts, attached } = harness()
  await svc.create({ user: MAIN_USER, data: { baseid: 5 } })
  assert.equal(attached.length, 1, '必须回填预约归属')
  assert.equal(attached[0].reservationId, 7)
  assert.equal(attached[0].rechargeId, 101)
  // 订单里引用的 reservation_id 与回填的是同一个
  const ins = inserts.find(i => /INSERT INTO recharges/.test(i.sql))
  assert.equal(ins.params[14], '7')
})

test('下单不写 audit_logs（admin_id 外键会冲突）', async () => {
  const { svc, inserts } = harness()
  await svc.create({ user: MAIN_USER, data: { baseid: 5 } })
  assert.ok(!inserts.some(i => /INSERT INTO audit_logs/.test(i.sql)),
    '商户下单不是超管操作，写进 audit_logs 会外键冲突')
})

test('下单写入的用户是主账号 id，不是子账号', async () => {
  const { svc, inserts } = harness()
  await svc.create({ user: { kind: 'main', account: { id: 99 }, parent: { id: 42 } }, data: { baseid: 5 } })
  const ins = inserts.find(i => /INSERT INTO recharges/.test(i.sql))
  assert.equal(ins.params[0], 42, '订单要挂在主账号上')
})
