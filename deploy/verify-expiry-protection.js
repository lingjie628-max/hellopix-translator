'use strict'

/**
 * 测试订单「自然过期 + 24 小时保护期」验证。
 *
 * 针对 HP1790182973367652（36.736 USDT，故意不付款）逐条验证：
 *   1. 不再具备正常自动结算资格（业务上按 expired 处理）
 *   2. 不会因为到期被错误改成 paid
 *   3. 字符余额仍然为 0
 *   4. 字符流水仍然为 0
 *   5. 36.736 的金额预约仍受保护
 *   6. reusable_after 至少覆盖 expires_at + 24h
 *   7. 保护期内不能把 0.736 尾数重新分配出去
 *   8. watcher 重扫不制造重复异常
 *
 * ## 关于「惰性过期」
 *
 * 订单到期后 status 不会被自动改成 2（expired）—— 那是**刻意的**：
 * 为了"让页面显示 expired"而每分钟去改一遍数据库，是无意义的写入。
 * 业务上是否按 expired 处理，靠的是 `isExpired(order, txTime)` 实时判定。
 *
 * 所以第 1 条不能靠"看 status 是不是 2"来证明，必须**真的喂一笔转账进去**，
 * 看结算服务把它判成 MATCHED 还是 LATE_PAYMENT。
 *
 * 用法：cd /opt/hello-pix && node deploy/verify-expiry-protection.js
 */

const fs = require('node:fs')
const path = require('node:path')

const APP = process.env.APP_DIR || '/opt/hello-pix'
const ORDER_NUMBER = 'HP1790182973367652'

let pass = 0
let fail = 0
function check(label, ok, extra) {
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}

async function main() {
  const { Pool } = require(path.join(APP, 'node_modules/pg'))
  const config = require(path.join(APP, 'server/config'))
  const { ProductionRepository } = require(path.join(APP, 'server/repositories/production-repository'))
  const { RechargeAmountService } = require(path.join(APP, 'server/services/recharge-amount-service'))
  const {
    RechargeSettlementService, MATCH_KIND, EXCEPTION_KIND
  } = require(path.join(APP, 'server/services/recharge-settlement-service'))
  const { makeTransfer, milliToChainUnits } = require(path.join(APP, 'server/services/tron/transfer'))
  const { isExpired, statusText } = require(path.join(APP, 'server/services/recharge-state'))
  const { formatMilli, parseMilli } = require(path.join(APP, 'server/lib/money'))

  const pool = new Pool({
    connectionString: config.database.connectionString, ssl: config.database.ssl, max: 4
  })
  const repo = new ProductionRepository(pool)
  const amount = new RechargeAmountService()
  const settlement = new RechargeSettlementService(repo, {
    amountService: amount,
    // 故意用 live —— 只有 live 模式才真正走到入账分支，
    // 这样"到期后不会被错误入账"才是有意义的验证（shadow 本来就不会入账）
    autoSettlementEnabled: true
  })

  const withTx = async fn => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const out = await fn(client)
      await client.query('COMMIT')
      return out
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
  }

  let probeReservationId = null

  try {
    // ---------------------------------------------------------------- 读取订单
    console.log('=== 0. 订单当前状态（只读）===')
    const order = (await pool.query(
      `SELECT r.*, u.id AS uid, u.username, u.char_balance,
              res.id AS res_id, res.state AS res_state, res.suffix,
              res.amount_milli, res.reusable_after, res.recharge_id AS res_recharge_id
         FROM recharges r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN recharge_amount_reservations res ON res.id = r.amount_reservation_id
        WHERE r.order_number = $1`, [ORDER_NUMBER])).rows[0]
    if (!order) {
      console.log(`  找不到订单 ${ORDER_NUMBER} —— 可能已被清理`)
      return 1
    }
    const now = new Date()
    const expiresAt = new Date(order.expires_at)
    const expiredForMs = now.getTime() - expiresAt.getTime()

    console.log(`  订单号     ${order.order_number}`)
    console.log(`  应付       ${order.paid_amount} USDT（尾数 ${order.surcharge_amount}）`)
    console.log(`  状态       ${order.status} (${statusText(Number(order.status))})`)
    console.log(`  有效期至   ${expiresAt.toISOString()}`)
    console.log(`  已过期     ${(expiredForMs / 60000).toFixed(1)} 分钟`)
    console.log(`  预约       id=${order.res_id} state=${order.res_state} suffix=${order.suffix}`)
    console.log(`  保护期至   ${order.reusable_after ? new Date(order.reusable_after).toISOString() : '(无)'}`)

    console.log('\n=== 1. 业务上按 expired 处理（惰性判定）===')
    const expired = isExpired({ expiresAt: order.expires_at }, now)
    check('isExpired(order) 判定为已过期', expired === true, expired)
    check('有效期确实已过', expiredForMs > 0, `${(expiredForMs / 60000).toFixed(1)} 分钟`)
    // status 保持 0 是刻意的惰性设计，不是 bug
    console.log(`  · status 仍为 ${order.status} 属预期的惰性设计（不为显示而制造无意义写入）`)

    console.log('\n=== 2. 到期不会导致被错误改成 paid ===')
    check('订单不是 paid(1)', Number(order.status) !== 1, order.status)
    check('paid_at 为空', order.paid_at === null, order.paid_at)
    check('无 TXID 绑定', !order.provider_transaction_id, order.provider_transaction_id)

    console.log('\n=== 3 & 4. 余额与流水仍为 0 ===')
    const balance = Number((await pool.query(
      'SELECT char_balance FROM users WHERE id=$1', [order.uid])).rows[0].char_balance)
    const ledger = (await pool.query(
      'SELECT count(*)::int AS n FROM char_ledger WHERE user_id=$1', [String(order.uid)])).rows[0].n
    check('字符余额为 0', balance === 0, balance)
    check('字符流水条数为 0', ledger === 0, ledger)

    console.log('\n=== 5 & 6. 金额预约仍受保护 ===')
    check('预约仍为 held', order.res_state === 'held', order.res_state)
    check('预约仍指向本订单', String(order.res_recharge_id) === String(order.id), order.res_recharge_id)
    const protectUntil = new Date(order.reusable_after).getTime()
    const needUntil = expiresAt.getTime() + 24 * 3600 * 1000
    check('reusable_after 至少覆盖 expires_at + 24h',
      protectUntil >= needUntil - 1000,
      { 实际: new Date(protectUntil).toISOString(), 要求: new Date(needUntil).toISOString() })
    check('保护期尚未到点（仍在保护中）', protectUntil > now.getTime(),
      `${((protectUntil - now.getTime()) / 3600000).toFixed(1)} 小时后可复用`)

    console.log('\n=== 7. 保护期内尾数不能被重新分配 ===')
    // 用固定随机源**指名**要那个尾数 —— 如果保护期失效，它就会被分配出去
    const pinned = new RechargeAmountService({ randomSuffix: () => Number(order.suffix) })
    // 基数 = 标准价 - 折扣（尾数之外的部分），全程整数毫
    const baseMilli = parseMilli(String(Math.round(Number(order.original_amount) * 1000)))
      - parseMilli(String(Math.round(Number(order.discount_amount) * 1000)))
    const probe = await withTx(client => pinned.allocate(client, {
      payAddress: order.pay_address,
      tokenContract: order.pay_token_contract,
      baseAmountMilli: baseMilli,
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000)
    }))
    probeReservationId = probe.reservationId
    check('指名索要同一尾数时被拒绝，拿到了别的金额',
      String(probe.amountMilli) !== String(order.amount_milli),
      { 想要: formatMilli(BigInt(order.amount_milli)), 实得: formatMilli(probe.amountMilli) })
    check('新预约的金额仍落在合法尾数区间',
      Number(probe.suffixMilli) >= 1 && Number(probe.suffixMilli) <= 999, Number(probe.suffixMilli))

    console.log('\n=== 8. 到期订单收到付款 → 判为迟到款，不进账 ===')
    const txTime = now.getTime() // 链上时间在有效期之后
    const transfer = makeTransfer({
      txId: require('crypto').randomBytes(32).toString('hex'),
      tokenContract: order.pay_token_contract,
      fromAddress: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8',
      toAddress: order.pay_address,
      chainUnits: milliToChainUnits(BigInt(order.amount_milli)).toString(),
      blockTimestamp: txTime,
      solidified: true,
      raw: { verify: 'expiry-protection' }
    })
    const beforeBalance = Number((await pool.query(
      'SELECT char_balance FROM users WHERE id=$1', [order.uid])).rows[0].char_balance)
    const result = await withTx(client =>
      settlement.handleTransfer(client, transfer, { toAddress: order.pay_address }))

    check('判为 LATE_PAYMENT 而不是 MATCHED',
      result.matchKind === MATCH_KIND.LATE_PAYMENT, result.matchKind)
    check('结果为 EXCEPTION', result.outcome === 'EXCEPTION', result.outcome)
    check('异常类型为 EXPIRED_PAYMENT',
      result.exceptionKind === EXCEPTION_KIND.EXPIRED_PAYMENT, result.exceptionKind)
    const afterBalance = Number((await pool.query(
      'SELECT char_balance FROM users WHERE id=$1', [order.uid])).rows[0].char_balance)
    check('余额未变化', afterBalance === beforeBalance, { before: beforeBalance, after: afterBalance })
    const stillPending = (await pool.query(
      'SELECT status FROM recharges WHERE id=$1', [order.id])).rows[0].status
    check('订单状态未被改动', Number(stillPending) === Number(order.status),
      { before: order.status, after: stillPending })

    const exc = (await pool.query(
      'SELECT kind, recharge_id, summary FROM recharge_exceptions WHERE tx_id=$1',
      [transfer.txId])).rows[0]
    check('异常记录指向原订单',
      exc && String(exc.recharge_id) === String(order.id), exc && exc.recharge_id)
    console.log(`  · 异常摘要: ${exc ? exc.summary : '(无)'}`)

    console.log('\n=== 9. 同一笔重扫不制造重复异常 ===')
    const again = await withTx(client =>
      settlement.handleTransfer(client, transfer, { toAddress: order.pay_address }))
    check('重扫被识别为重复', again.outcome === 'DUPLICATE', again.outcome)
    const excCount = (await pool.query(
      'SELECT count(*)::int AS n FROM recharge_exceptions WHERE tx_id=$1', [transfer.txId])).rows[0].n
    check('异常记录仍只有 1 条', excCount === 1, excCount)

    // 清理本次验证产生的数据（不动测试订单本身）
    await pool.query('DELETE FROM recharge_exceptions WHERE tx_id=$1', [transfer.txId])
    await pool.query('DELETE FROM chain_transactions WHERE tx_id=$1', [transfer.txId])
    console.log('  · 已清理本次验证产生的异常与链上记录（测试订单保持原样）')
  } finally {
    if (probeReservationId) {
      await pool.query('DELETE FROM recharge_amount_reservations WHERE id=$1', [String(probeReservationId)])
      console.log('  · 已清理验证用临时预约')
    }
    await pool.end()
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  return fail ? 1 : 0
}

main()
  .then(code => { process.exitCode = code || 0 })
  .catch(error => { console.error('验证异常:', (error && error.stack) || error); process.exitCode = 1 })
