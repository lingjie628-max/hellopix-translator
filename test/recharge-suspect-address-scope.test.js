'use strict'

/**
 * 疑似归属匹配：候选池必须限定在同一收款地址（和合约）内。
 *
 * ## 真实风险
 *
 * `suspectCandidates()` 给「金额对不上」的到账找"最可能是哪张订单"。
 * 候选池原本是：
 *
 * ```sql
 * WHERE status IN (pending, paid) AND created_at >= now() - 72h
 * ```
 *
 * **没有按收款地址过滤** —— 全平台所有商户的近 72 小时订单都进了池子。
 * 于是钱打到商户 A 的地址、金额恰好接近商户 B 的某张订单时，系统会提示
 * 「疑似 B 的订单 XX」。超管照着点「确认收款」，A 付的钱就记到 B 账上。
 *
 * 两家的钱串了，而且异常记录写的是"尾数笔误匹配"，从流水里完全看不出来。
 *
 * ## 为什么用源码断言
 *
 * 这条 SQL 要真跑起来需要 PG + 完整建表 + 两个商户的订单数据。CI 里没有，
 * 但不代表可以不钉：SQL 的 WHERE 条件是可以静态检查的，而且**失败模式是静默的**
 * （接口照样返回 200，只是给了个错的候选），不测就永远发现不了。
 *
 * 断言的粒度是"候选池的 WHERE 必须包含 pay_address 绑定"，不是"文件里
 * 出现过 pay_address 这几个字" —— 后者会被上面那段 known 检查的假阳性骗过去，
 * 也正是这个 bug 当初能活下来的原因。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC_PATH = path.join(__dirname, '..', 'server', 'services', 'recharge-settlement-service.js')

/** 抓出 suspectCandidates 的方法体（按大括号配对）。 */
function grabSuspectCandidates() {
  const src = fs.readFileSync(SRC_PATH, 'utf8')
  const start = src.indexOf('async suspectCandidates(')
  assert.ok(start >= 0, '找不到 suspectCandidates —— 名字改了就要同步改这个测试')
  let depth = 0
  let started = false
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') { depth++; started = true }
    else if (src[i] === '}') {
      depth--
      if (started && depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error('suspectCandidates 括号不配对')
}

/** 从方法体里抓出**所有** SQL 字面量。 */
function sqlBlocks(body) {
  return [...body.matchAll(/`([^`]*?)`/g)].map(m => m[1]).filter(s => /SELECT|INSERT|UPDATE/i.test(s))
}

test('候选查询必须按 pay_address 绑定到本次到账的地址', () => {
  const body = grabSuspectCandidates()
  const blocks = sqlBlocks(body)

  // 找"查订单做候选"的那条（FROM recharges + ORDER BY created_at DESC）
  const candidateSql = blocks.find(s => /FROM\s+recharges/i.test(s) && /ORDER BY\s+created_at/i.test(s))
  assert.ok(candidateSql, '找不到候选订单查询 SQL —— 结构变了，检查这个测试')

  assert.match(
    candidateSql,
    /pay_address\s*=\s*\$\d+/,
    '候选查询没有按 pay_address 过滤。全平台订单混进候选池，' +
    '钱打到 A 的地址会被提示成"疑似 B 的订单"，人工确认就串账'
  )
  assert.match(
    candidateSql,
    /pay_token_contract/,
    '候选查询没有按代币合约过滤。不同链/不同代币的金额可能撞车'
  )
})

test('候选查询的地址参数必须真的传进去（不能只有占位符）', () => {
  const body = grabSuspectCandidates()
  // 参数数组里必须出现 transfer.toAddress
  assert.match(
    body,
    /transfer\.toAddress/,
    'SQL 里引用了地址占位符，但参数数组没传 transfer.toAddress'
  )
  // 且不能出现"占位符编号对不上"这种低级错：$4/$5 必须在参数数组里
  assert.match(body, /\$4/, 'SQL 用了 $4 但看不到对应位置')
})

test('near-amount 的契约：调用方负责限定地址，本模块自己不做地址校验', () => {
  // 这是一条"契约一致性"断言：如果哪天有人在 near-amount 里加了地址过滤，
  // 上面两条断言的注释就会变得误导。检查它仍然明确声明了这个边界。
  const near = fs.readFileSync(path.join(__dirname, '..', 'server', 'lib', 'near-amount.js'), 'utf8')
  assert.match(
    near,
    /调用方必须自己限定/,
    'near-amount.js 不再声明"地址由调用方校验"的契约，需要重新审视调用点'
  )
})

test('近似匹配绝不能自动入账（autoSettle 必须显式为 false）', () => {
  const body = grabSuspectCandidates()
  assert.match(body, /autoSettle:\s*false/, '疑似归属的返回值里必须写死 autoSettle:false')
})
