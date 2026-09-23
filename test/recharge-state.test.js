'use strict'

/**
 * 充值订单状态机测试。
 *
 * 重点是**终态不可逆**与**异常必须有人收尾**这两条业务规则 ——
 * 它们一旦破掉，对账会永远对不平：
 *   - 已入账订单被改回未支付 → 字符发出去了但订单显示没付
 *   - 异常状态没有出口       → 钱和字符的归属永远悬着
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  STATUS,
  STATUS_TEXT,
  TERMINAL_STATUSES,
  TERMINAL_REASON,
  ALL_STATUSES,
  isValidStatus,
  isTerminal,
  isPending,
  statusText,
  canTransition,
  assertTransition,
  isExpired
} = require('../server/services/recharge-state')

test('五个状态：pending / paid / expired / cancelled / exception', () => {
  assert.deepEqual(ALL_STATUSES, [0, 1, 2, 3, 4])
  assert.equal(STATUS.PENDING, 0)
  assert.equal(STATUS.PAID, 1)
  assert.equal(STATUS.EXPIRED, 2)
  assert.equal(STATUS.CANCELLED, 3)
  assert.equal(STATUS.EXCEPTION, 4)
  Object.values(STATUS_TEXT).forEach(text => assert.ok(text && text.length > 0))
})

test('pending 可以走向四个方向', () => {
  for (const to of [STATUS.PAID, STATUS.EXPIRED, STATUS.CANCELLED, STATUS.EXCEPTION]) {
    assert.equal(canTransition(STATUS.PENDING, to), true, `pending → ${statusText(to)} 应当允许`)
  }
})

test('paid / expired / cancelled 是终态，出不去', () => {
  for (const from of TERMINAL_STATUSES) {
    for (const to of ALL_STATUSES) {
      assert.equal(canTransition(from, to), false,
        `${statusText(from)} → ${statusText(to)} 必须被拒绝（终态不可逆）`)
    }
  }
})

test('已支付订单不能改回未支付 —— 否则字符发出去了订单却显示没付', () => {
  assert.equal(canTransition(STATUS.PAID, STATUS.PENDING), false)
  assert.equal(isTerminal(STATUS.PAID), true)
})

test('异常不是终态：必须有出口，否则归属永远悬着', () => {
  assert.equal(isTerminal(STATUS.EXCEPTION), false)
  assert.equal(canTransition(STATUS.EXCEPTION, STATUS.PAID), true)
  assert.equal(canTransition(STATUS.EXCEPTION, STATUS.CANCELLED), true)
  // 但不能从异常回到 pending
  assert.equal(canTransition(STATUS.EXCEPTION, STATUS.PENDING), false)
  // 也不能从异常直接跳到过期
  assert.equal(canTransition(STATUS.EXCEPTION, STATUS.EXPIRED), false)
})

test('终态集合与转移表一致 —— 不能出现"终态却有出口"的矛盾', () => {
  for (const status of ALL_STATUSES) {
    const hasExit = canTransition(status, STATUS.PAID) || canTransition(status, STATUS.EXPIRED) ||
      canTransition(status, STATUS.CANCELLED) || canTransition(status, STATUS.EXCEPTION)
    if (isTerminal(status)) {
      assert.equal(hasExit, false, `${statusText(status)} 是终态却有出口`)
    }
  }
})

test('assertTransition 抛 409 且带明确错误码', () => {
  assert.doesNotThrow(() => assertTransition(STATUS.PENDING, STATUS.PAID))
  try {
    assertTransition(STATUS.PAID, STATUS.PENDING)
    assert.fail('应当抛错')
  } catch (e) {
    assert.equal(e.status, 409)
    assert.equal(e.code, 'ILLEGAL_RECHARGE_TRANSITION')
    assert.match(e.message, /已支付/)
    assert.match(e.message, /待支付/)
  }
})

test('非法状态值抛 500（这是代码 bug，不是用户输入问题）', () => {
  assert.equal(isValidStatus(9), false)
  assert.equal(isValidStatus(-1), false)
  assert.throws(() => assertTransition(9, STATUS.PAID), /订单状态非法/)
  assert.throws(() => assertTransition(STATUS.PENDING, 9), /目标状态非法/)
})

test('isPending / isTerminal 判定', () => {
  assert.equal(isPending(STATUS.PENDING), true)
  assert.equal(isPending(STATUS.PAID), false)
  assert.deepEqual(TERMINAL_STATUSES, [STATUS.PAID, STATUS.EXPIRED, STATUS.CANCELLED])
})

test('每个非 pending 状态都有对应的 terminal_reason', () => {
  for (const status of [STATUS.PAID, STATUS.EXPIRED, STATUS.CANCELLED, STATUS.EXCEPTION]) {
    assert.ok(TERMINAL_REASON[status], `状态 ${status} 缺少 terminal_reason`)
  }
})

// ------------------------------------------------------------------ 过期判定

test('过期是惰性判定，不依赖定时任务先把状态改成 expired', () => {
  const order = { expiresAt: '2026-09-23T10:00:00Z' }
  // 有效期内的任意时刻都算未过期
  assert.equal(isExpired(order, '2026-09-23T09:59:59Z'), false)
  // 到点即过期，不需要任何任务参与
  assert.equal(isExpired(order, '2026-09-23T10:00:00Z'), true)
  assert.equal(isExpired(order, '2026-09-23T10:00:01Z'), true)
})

test('没有 expires_at 的订单不判过期（防御性：宁可让它待支付，也不要误判）', () => {
  assert.equal(isExpired({}, '2030-01-01T00:00:00Z'), false)
  assert.equal(isExpired(null, '2030-01-01T00:00:00Z'), false)
  assert.equal(isExpired({ expiresAt: null }, '2030-01-01T00:00:00Z'), false)
})
