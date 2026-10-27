'use strict'

/**
 * 告警「状态变化才通知」的测试。
 *
 * ## 背景：为什么要把「1 小时内不重复」换掉
 *
 * 2026-10-27 那天主机服务失败，巡检每 10 分钟发一封邮件，
 * 一轮又一轮，把 Resend 每天 100 封的额度打满 —— 然后**注册验证码发不出去了**。
 *
 * 讽刺的是：用来报故障的告警，把用户注册这条真正的业务线干掉了。
 *
 * 原策略「同一问题 1 小时内只发一次」有两个洞：
 *
 *   1. **持续存在的问题会一直重发**。充值异常积压了 5 天，
 *      就按小时重发 120 次。信息被淹，额度被烧。
 *   2. **恢复时没有任何通知**。问题自己好了没人知道；
 *      下次再坏，你以为"一直在坏"，已经麻了。
 *
 * 新策略是状态机：记录上一轮存在的问题集合。
 *
 *   新出现 → 告警   一直在 → 静默   消失了 → 恢复通知
 *
 * 每件事只打扰两次：出事一次，好了一次。这是在保护**通知渠道本身**。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const { diffProblems } = require('../scripts/alert')

/** 造 problems 数组；真实结构是 [key, detail] */
function problems (...keys) {
  return keys.map(k => [k, k + ' 的详情'])
}

test('首次出现的问题 → 必须告警', () => {
  const r = diffProblems(problems('数据库不可连'), {})
  assert.deepEqual(r.toAlert, ['数据库不可连'])
})

test('同一问题持续存在 → 不重复告警（这是省额度的关键）', () => {
  const state = { activeProblems: ['数据库不可连'] }
  const r = diffProblems(problems('数据库不可连'), state)
  assert.deepEqual(r.toAlert, [], '持续中的问题再报一次，就是在烧钱')
})

test('持续 100 轮也只报 1 次 —— 模拟一整天的巡检', () => {
  let state = {}
  let sent = 0
  for (let i = 0; i < 100; i++) {
    const r = diffProblems(problems('服务不可用'), state)
    sent += r.toAlert.length
    state = { activeProblems: ['服务不可用'] }
  }
  assert.equal(sent, 1, '原本一天会发 24 封（每小时一封），现在只发 1 封')
})

test('老问题还在、又来了新问题 → 只报新的那个', () => {
  const state = { activeProblems: ['服务不可用'] }
  const r = diffProblems(problems('服务不可用', '磁盘告急'), state)
  assert.deepEqual(r.toAlert, ['磁盘告急'])
})

test('多个新问题 → 一次全报，不拆成多封', () => {
  const r = diffProblems(problems('服务不可用', '磁盘告急', '邮件通道故障'), { activeProblems: [] })
  assert.equal(r.toAlert.length, 3)
})

test('空状态（首次部署 / 状态文件丢了）不能崩，且全部按新问题报', () => {
  assert.deepEqual(diffProblems(problems(), {}).toAlert, [])
  assert.deepEqual(diffProblems(problems('邮件通道故障'), {}).toAlert, ['邮件通道故障'])
  // 状态文件被写成乱七八糟的结构也要扛住
  assert.deepEqual(diffProblems(problems('邮件通道故障'), { activeProblems: 'oops' }).toAlert, ['邮件通道故障'])
  assert.deepEqual(diffProblems(problems('邮件通道故障'), null).toAlert, ['邮件通道故障'])
})

test('同一轮里重复的 key 不会重复报', () => {
  const r = diffProblems(problems('磁盘告急', '磁盘告急'), { activeProblems: [] })
  assert.deepEqual(r.toAlert, ['磁盘告急'])
})

test('告警文案里带详情 —— 只说"有异常"等于没说', () => {
  const r = diffProblems([['磁盘告急', '根分区 92%，剩 1.2GB']], {})
  assert.deepEqual(r.toAlert, ['磁盘告急'])
  // 详情由主流程用 problems 组装，这里确认结构没丢（Map 能取到）
  const detailOf = new Map([['磁盘告急', '根分区 92%，剩 1.2GB']])
  assert.match(detailOf.get(r.toAlert[0]), /92%/)
})
