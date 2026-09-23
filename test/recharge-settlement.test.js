'use strict'

/**
 * RechargeSettlementService 测试（需要真实 PostgreSQL）。
 *
 * 这是资金路径上唯一允许改余额的地方，所以重点全在**不该动钱的时候有没有动钱**：
 *   - Shadow 模式命中后余额必须一分不变
 *   - 同一 TXID 再看一次必须毫无变化
 *   - 已 paid 的订单不能因为又看到一笔而重复发字符
 *   - 迟到款必须定位到**原订单**并进异常池，绝不能改配给新订单
 *   - 错代币 / 错地址 / 无匹配 一律不入账
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const databaseUrl = process.env.PIX_TEST_DATABASE_URL

const ADDRESS = 'TEfCDDuYwYdjCn2WDa7TNWCU9bkBk9EXPX'
const OTHER_ADDRESS = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const TOKEN = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const FAKE_TOKEN = 'TFAKEfakeFAKEfakeFAKEfakeFAKEfake1'
const BASE_MILLI = 40000n // 40.000 USDT

test('结算服务：Shadow / 幂等 / 异常池', { skip: !databaseUrl }, async t => {
  process.env.DATABASE_URL = databaseUrl
  const { Pool } = require('pg')
  const { ProductionRepository } = require('../server/repositories/production-repository')
  const { RechargeAmountService } = require('../server/services/recharge-amount-service')
  const {
    RechargeSettlementService, MATCH_KIND, EXCEPTION_KIND
  } = require('../server/services/recharge-settlement-service')
  const { makeTransfer, milliToChainUnits } = require('../server/services/tron/transfer')
  const { formatMilli } = require('../server/lib/money')

  const pool = new Pool({ connectionString: databaseUrl, max: 10 })
  const repo = new ProductionRepository(pool)
  const amount = new RechargeAmountService({ protectionHours: 24 })

  const created = { users: [], recharges: [], reservations: [] }
  let seq = 0
  let addrSeq = 0
  const nextAddress = () => `${ADDRESS.slice(0, 18)}${String(++addrSeq).padStart(4, '0')}${ADDRESS.slice(22)}`

  async function withTx(fn) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const out = await fn(client)
      await client.query('COMMIT')
      return out
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally { client.release() }
  }

  async function makeUser() {
    const name = `rc02set_${process.pid}_${Date.now()}_${++seq}`
    const { rows } = await pool.query(
      `INSERT INTO users(username,password_hash,nickname,email,email_verified,status,
         char_balance,char_used,translate_count,sub_quota,auto_alloc_master,auto_reply,
         enterprise,port_limit,ports_in_use,remarks)
       VALUES($1,'scrypt$s$h',$1,$2,false,1,0,0,0,0,false,false,false,1,0,'') RETURNING id, char_balance`,
      [name, `${name}@example.test`])
    created.users.push(rows[0].id)
    return rows[0]
  }

  /** 造一张带金额预约的订单 */
  async function makeOrder(opts) {
    const o = opts || {}
    const user = o.user || await makeUser()
    const address = o.address || nextAddress()
    const token = o.token || TOKEN
    const expiresAt = o.expiresAt || new Date(Date.now() + 30 * 60 * 1000)
    return withTx(async client => {
      const alloc = await amount.allocate(client, {
        payAddress: address, tokenContract: token,
        baseAmountMilli: o.baseMilli === undefined ? BASE_MILLI : o.baseMilli,
        expiresAt
      })
      const orderNumber = `SET${Date.now()}${Math.floor(Math.random() * 1e6)}`
      const { rows } = await client.query(
        `INSERT INTO recharges(user_id, order_number, kind, payment_type, quantity, chars,
           original_amount, discount_amount, surcharge_amount, paid_amount, status,
           idempotency_key, expires_at, pay_address, pay_token_contract, amount_reservation_id)
         VALUES($1,$2,'package','USDT-TRC20',1,$3,$4,0,$5,$6,0,$7,$8,$9,$10,$11)
         RETURNING *`,
        [user.id, orderNumber, o.chars || 1000,
          // 一律用 formatMilli —— 别自己拿 BigInt 除 1000（整数除法会把 0.526 变成 0）
          formatMilli(o.baseMilli === undefined ? BASE_MILLI : o.baseMilli),
          formatMilli(alloc.suffixMilli),
          formatMilli(alloc.amountMilli),
          `set:${orderNumber}`, expiresAt.toISOString(), address, token, String(alloc.reservationId)])
      await amount.attachToRecharge(client, alloc.reservationId, rows[0].id)
      created.recharges.push(rows[0].id)
      created.reservations.push(alloc.reservationId)
      return { order: rows[0], user, address, token, amountMilli: alloc.amountMilli, suffixMilli: alloc.suffixMilli }
    })
  }

  function transferFor(ctx, overrides) {
    const o = overrides || {}
    return makeTransfer({
      txId: o.txId || require('crypto').randomBytes(32).toString('hex'),
      tokenContract: o.tokenContract || ctx.token,
      fromAddress: o.fromAddress || OTHER_ADDRESS,
      toAddress: o.toAddress || ctx.address,
      chainUnits: o.chainUnits || milliToChainUnits(ctx.amountMilli).toString(),
      blockTimestamp: o.blockTimestamp || Date.now(),
      solidified: o.solidified === undefined ? true : o.solidified,
      raw: { test: true }
    })
  }

  const settle = (enabled, transfer, ctx) => withTx(client =>
    new RechargeSettlementService(repo, { amountService: amount, autoSettlementEnabled: enabled })
      .handleTransfer(client, transfer, { toAddress: ctx.address }))

  const balanceOf = async userId =>
    Number((await pool.query('SELECT char_balance FROM users WHERE id=$1', [userId])).rows[0].char_balance)

  t.after(async () => {
    try {
      if (created.recharges.length) {
        await pool.query('UPDATE recharge_amount_reservations SET recharge_id=NULL WHERE recharge_id = ANY($1::bigint[])', [created.recharges])
        await pool.query('DELETE FROM char_ledger WHERE reference_id = ANY($1::bigint[])', [created.recharges])
        await pool.query('DELETE FROM recharge_exceptions WHERE recharge_id = ANY($1::bigint[])', [created.recharges])
        await pool.query('DELETE FROM chain_transactions WHERE recharge_id = ANY($1::bigint[])', [created.recharges])
        await pool.query('DELETE FROM recharges WHERE id = ANY($1::bigint[])', [created.recharges])
      }
      if (created.reservations.length) {
        await pool.query('DELETE FROM recharge_amount_reservations WHERE id = ANY($1::bigint[])', [created.reservations])
      }
      if (created.users.length) {
        await pool.query('DELETE FROM recharges WHERE user_id = ANY($1::bigint[])', [created.users])
        await pool.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [created.users])
      }
      await pool.query("DELETE FROM chain_transactions WHERE raw->>'test' = 'true'")
      await pool.query("DELETE FROM recharge_exceptions WHERE tx_id IS NOT NULL AND detail->>'test' IS NOT NULL")
    } catch (e) { console.error('  清理出错:', e.message) }
    await pool.end()
  })

  // ============================================================ Shadow 模式

  await t.test('Shadow 模式：匹配成功但一分钱都不动', async () => {
    const ctx = await makeOrder()
    const before = await balanceOf(ctx.user.id)
    const transfer = transferFor(ctx)

    const r = await settle(false, transfer, ctx)

    assert.equal(r.outcome, 'SHADOW_MATCHED')
    assert.equal(r.matchKind, MATCH_KIND.MATCHED)
    assert.equal(String(r.rechargeId), String(ctx.order.id))
    assert.equal(r.detail.wouldSettle, true)
    assert.equal(r.detail.action, 'credit')
    assert.equal(r.detail.chars, 1000)

    assert.equal(await balanceOf(ctx.user.id), before, 'Shadow 模式绝不能改余额')

    const order = (await pool.query('SELECT status, paid_at FROM recharges WHERE id=$1', [ctx.order.id])).rows[0]
    assert.equal(Number(order.status), 0, 'Shadow 模式绝不能改订单状态')
    assert.equal(order.paid_at, null)

    const ledger = await pool.query('SELECT count(*)::int AS n FROM char_ledger WHERE reference_id=$1', [String(ctx.order.id)])
    assert.equal(ledger.rows[0].n, 0, 'Shadow 模式不该写字符流水')

    // 但"本来会做什么"必须留档
    const tx = (await pool.query(
      'SELECT mode, status, match_kind, shadow_action, recharge_id FROM chain_transactions WHERE tx_id=$1',
      [transfer.txId])).rows[0]
    assert.equal(tx.mode, 'shadow')
    assert.equal(tx.status, 'seen')
    assert.equal(tx.match_kind, 'MATCHED')
    assert.equal(String(tx.recharge_id), String(ctx.order.id))
    assert.equal(tx.shadow_action.wouldSettle, true)
    assert.match(tx.shadow_action.note, /AUTO_SETTLEMENT_ENABLED=false/)
  })

  await t.test('Live 模式：真正入账，余额、订单、流水、审计全部到位', async () => {
    const ctx = await makeOrder()
    const before = await balanceOf(ctx.user.id)
    const transfer = transferFor(ctx)

    const r = await settle(true, transfer, ctx)
    assert.equal(r.outcome, 'SETTLED')
    assert.equal(await balanceOf(ctx.user.id), before + 1000, '字符应到账')

    const order = (await pool.query(
      'SELECT status, paid_at, provider_transaction_id, chain_tx_id, terminal_reason FROM recharges WHERE id=$1',
      [ctx.order.id])).rows[0]
    assert.equal(Number(order.status), 1)
    assert.ok(order.paid_at)
    assert.equal(order.provider_transaction_id, transfer.txId)
    assert.equal(order.chain_tx_id, transfer.txId)
    assert.equal(order.terminal_reason, 'chain_settled')

    const ledger = (await pool.query(
      'SELECT delta, balance_after, reason, idempotency_key FROM char_ledger WHERE reference_id=$1',
      [String(ctx.order.id)])).rows[0]
    assert.ok(ledger, '必须写字符流水')
    assert.equal(Number(ledger.delta), 1000)
    assert.equal(Number(ledger.balance_after), before + 1000)
    assert.equal(ledger.reason, 'recharge')
    assert.equal(ledger.idempotency_key, `recharge:${ctx.order.id}`)

    const audit = (await pool.query(
      "SELECT actor FROM audit_logs WHERE action='链上自动入账' AND detail->>'message' LIKE $1 ORDER BY id DESC LIMIT 1",
      [`%${ctx.order.order_number}%`])).rows[0]
    assert.ok(audit, '必须写审计')
    assert.equal(audit.actor, 'system', '系统动作的 actor 是 system（admin_id 为 NULL）')

    const tx = (await pool.query('SELECT mode, status FROM chain_transactions WHERE tx_id=$1', [transfer.txId])).rows[0]
    assert.equal(tx.mode, 'live')
    assert.equal(tx.status, 'settled')
  })

  // ============================================================ 幂等

  await t.test('同一 TXID 再看一次：完全不动，且不报错', async () => {
    const ctx = await makeOrder()
    const transfer = transferFor(ctx)
    await settle(true, transfer, ctx)
    const after1 = await balanceOf(ctx.user.id)

    // 第二次（模拟补扫）
    const r2 = await settle(true, transfer, ctx)
    assert.equal(r2.outcome, 'DUPLICATE')
    assert.equal(r2.matchKind, MATCH_KIND.DUPLICATE_TX)
    assert.equal(await balanceOf(ctx.user.id), after1, '同一 TXID 不得产生任何余额变化')

    const ledgerCount = (await pool.query('SELECT count(*)::int AS n FROM char_ledger WHERE reference_id=$1',
      [String(ctx.order.id)])).rows[0].n
    assert.equal(ledgerCount, 1, '字符流水只能有一条')
  })

  await t.test('已 paid 的订单又来一笔新交易 → 重复付款进异常池，不改余额', async () => {
    const ctx = await makeOrder()
    await settle(true, transferFor(ctx), ctx)
    const after = await balanceOf(ctx.user.id)

    // 第二笔不同的交易，金额相同（用户手滑付了两次）
    const second = transferFor(ctx)
    const r = await settle(true, second, ctx)

    assert.equal(r.outcome, 'EXCEPTION', '重复付款不能被自动入账')
    assert.equal(await balanceOf(ctx.user.id), after, '余额不得变化')

    const exc = (await pool.query('SELECT kind, recharge_id, summary FROM recharge_exceptions WHERE tx_id=$1',
      [second.txId])).rows[0]
    assert.equal(exc.kind, EXCEPTION_KIND.EXPIRED_PAYMENT)
    assert.equal(String(exc.recharge_id), String(ctx.order.id), '异常要指向原订单')
  })

  // ============================================================ 迟到款

  await t.test('过期订单的迟到款：定位到旧订单并进异常池，绝不改配给新订单', async () => {
    // 订单 1：造一张 2 小时前创建、1.5 小时前过期的订单。
    // 不能直接建一张 expires_at 在过去的单 —— 那会违反
    // CHECK (expires_at > created_at)。把两个时间一起往前拨。
    const old = await makeOrder({})
    await pool.query(
      `UPDATE recharges
          SET created_at = now() - interval '2 hours',
              expires_at = now() - interval '90 minutes',
              status = 2, terminal_at = now(), terminal_reason = 'expired'
        WHERE id=$1`,
      [old.order.id])

    // 订单 2：新订单，用**同样的基数**，但金额由分配器保证不同
    const fresh = await makeOrder({ baseMilli: BASE_MILLI })
    assert.notEqual(String(fresh.amountMilli), String(old.amountMilli), '两张订单金额不该相同')

    const afterFresh = await balanceOf(fresh.user.id)
    const afterOld = await balanceOf(old.user.id)

    // 迟到的付款：金额是**旧订单**的金额，链上时间在旧订单过期之后
    const late = transferFor(old, { blockTimestamp: Date.now() })
    const r = await settle(true, late, old)

    assert.equal(r.outcome, 'EXCEPTION')
    assert.equal(r.matchKind, MATCH_KIND.LATE_PAYMENT)
    assert.equal(r.exceptionKind, EXCEPTION_KIND.EXPIRED_PAYMENT)
    assert.equal(await balanceOf(old.user.id), afterOld, '旧订单不得入账')
    assert.equal(await balanceOf(fresh.user.id), afterFresh, '绝不能改配给新订单')

    const exc = (await pool.query('SELECT kind, recharge_id, summary FROM recharge_exceptions WHERE tx_id=$1',
      [late.txId])).rows[0]
    assert.equal(exc.kind, EXCEPTION_KIND.EXPIRED_PAYMENT)
    assert.equal(String(exc.recharge_id), String(old.order.id), '异常必须指向旧订单')
    assert.match(exc.summary, /迟到款/)
  })

  await t.test('订单未过期但链上交易时间晚于有效期 → 同样判迟到款', async () => {
    // 订单还没被标记过期（status 仍 pending），但 expires_at 已经过去。
    // 同样要把 created_at 一起往前拨，否则违反 CHECK (expires_at > created_at)。
    const ctx = await makeOrder({})
    await pool.query(
      `UPDATE recharges SET created_at = now() - interval '2 hours',
              expires_at = now() - interval '1 minute' WHERE id=$1`,
      [ctx.order.id])
    const after = await balanceOf(ctx.user.id)
    const transfer = transferFor(ctx, { blockTimestamp: Date.now() })
    const r = await settle(true, transfer, ctx)
    assert.equal(r.outcome, 'EXCEPTION')
    assert.equal(r.matchKind, MATCH_KIND.LATE_PAYMENT)
    assert.equal(await balanceOf(ctx.user.id), after)
  })

  await t.test('有效期内的交易即使我们过了很久才发现，仍然正常入账', async () => {
    // 用户在第 29 分钟转出，链上时间在有效期内；我们一小时后才扫到
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000)
    const ctx = await makeOrder({ expiresAt })
    const txTime = expiresAt.getTime() - 60 * 1000 // 到期前 1 分钟
    const after = await balanceOf(ctx.user.id)
    const r = await settle(true, transferFor(ctx, { blockTimestamp: txTime }), ctx)
    assert.equal(r.outcome, 'SETTLED', '有效期以链上交易时间为准，不是我们发现的时间')
    assert.equal(await balanceOf(ctx.user.id), after + 1000)
  })

  // ============================================================ 异常识别

  await t.test('非指定 USDT 合约 → 进异常池，绝不入账', async () => {
    const ctx = await makeOrder()
    const after = await balanceOf(ctx.user.id)
    const transfer = transferFor(ctx, { tokenContract: FAKE_TOKEN })
    const r = await settle(true, transfer, ctx)

    assert.equal(r.outcome, 'EXCEPTION')
    assert.equal(r.matchKind, MATCH_KIND.NOT_ELIGIBLE)
    assert.equal(r.exceptionKind, EXCEPTION_KIND.WRONG_TOKEN)
    assert.equal(await balanceOf(ctx.user.id), after)

    const exc = (await pool.query('SELECT kind, summary FROM recharge_exceptions WHERE tx_id=$1', [transfer.txId])).rows[0]
    assert.equal(exc.kind, EXCEPTION_KIND.WRONG_TOKEN)
    assert.match(exc.summary, /不是指定 USDT/)
  })

  await t.test('收款地址不是平台地址 → 进异常池', async () => {
    const ctx = await makeOrder()
    const transfer = transferFor(ctx, { toAddress: OTHER_ADDRESS })
    const r = await settle(true, transfer, ctx)
    assert.equal(r.outcome, 'EXCEPTION')
    assert.equal(r.exceptionKind, EXCEPTION_KIND.WRONG_ADDRESS)
    const exc = (await pool.query('SELECT kind FROM recharge_exceptions WHERE tx_id=$1', [transfer.txId])).rows[0]
    assert.equal(exc.kind, EXCEPTION_KIND.WRONG_ADDRESS)
  })

  await t.test('金额不匹配任何订单 → NO_MATCH 进异常池', async () => {
    const ctx = await makeOrder()
    // 造一个比 40.000 大得多、不可能落在任何预约上的金额
    const transfer = transferFor(ctx, { chainUnits: milliToChainUnits(99999999n).toString() })
    const r = await settle(true, transfer, ctx)
    assert.equal(r.outcome, 'EXCEPTION')
    assert.equal(r.matchKind, MATCH_KIND.NO_MATCH)
    assert.equal(r.exceptionKind, EXCEPTION_KIND.NO_MATCH)
    const exc = (await pool.query('SELECT kind, summary FROM recharge_exceptions WHERE tx_id=$1', [transfer.txId])).rows[0]
    assert.equal(exc.kind, EXCEPTION_KIND.NO_MATCH)
    assert.match(exc.summary, /不匹配任何订单/)
  })

  await t.test('金额精度比订单更细 → 不参与匹配，进异常池', async () => {
    const ctx = await makeOrder()
    const fine = (milliToChainUnits(ctx.amountMilli) + 1n).toString() // 多 0.000001
    const transfer = transferFor(ctx, { chainUnits: fine })
    const r = await settle(true, transfer, ctx)
    assert.equal(r.outcome, 'EXCEPTION')
    assert.equal(r.matchKind, MATCH_KIND.NOT_ELIGIBLE)
    const exc = (await pool.query('SELECT kind, summary FROM recharge_exceptions WHERE tx_id=$1', [transfer.txId])).rows[0]
    assert.match(exc.summary, /精度比订单更细/)
  })

  await t.test('异常池按 (tx_id, kind) 去重 —— 补扫不会刷屏', async () => {
    const ctx = await makeOrder()
    const transfer = transferFor(ctx, { tokenContract: FAKE_TOKEN })
    await settle(true, transfer, ctx)
    // 同一笔再走一遍（第一次已把链上交易落库，所以直接短路成 DUPLICATE）
    const r2 = await settle(true, transfer, ctx)
    assert.equal(r2.outcome, 'DUPLICATE')
    const n = (await pool.query(
      'SELECT count(*)::int AS n FROM recharge_exceptions WHERE tx_id=$1', [transfer.txId])).rows[0].n
    assert.equal(n, 1, '同一笔交易的同类异常只该有一条')
  })

  await t.test('模式记录正确：同一批数据在两种模式下产生不同结论', async () => {
    const ctx = await makeOrder()
    // shadow
    const t1 = transferFor(ctx)
    const shadow = await settle(false, t1, ctx)
    assert.equal(shadow.outcome, 'SHADOW_MATCHED')
    const row1 = (await pool.query('SELECT mode FROM chain_transactions WHERE tx_id=$1', [t1.txId])).rows[0]
    assert.equal(row1.mode, 'shadow')

    // live（另一张订单，避免被幂等短路）
    const ctx2 = await makeOrder()
    const t2 = transferFor(ctx2)
    const live = await settle(true, t2, ctx2)
    assert.equal(live.outcome, 'SETTLED')
    const row2 = (await pool.query('SELECT mode FROM chain_transactions WHERE tx_id=$1', [t2.txId])).rows[0]
    assert.equal(row2.mode, 'live')
  })
})
