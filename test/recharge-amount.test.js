'use strict'

/**
 * 金额预约的**并发**与**保护期**测试（需要真实 PostgreSQL）。
 *
 * 为什么必须打真库：这两件事的保证都在数据库里 ——
 *   并发唯一性靠部分唯一索引 `(地址, 合约, 金额) WHERE state='held'`
 *   保护期靠 `reusable_after` 与懒释放
 * 用内存假仓储测，测的是假仓储的实现，不是生产行为。
 *
 * 覆盖 Rule A（24 小时保护期，迟到款不错配）与
 * Rule B（池满必须失败，不降级、不回退 000、不顺序 +1）。
 *
 * 运行方式（不设 PIX_TEST_DATABASE_URL 时整组跳过，
 * 所以 npm run test:security 在任何机器上都是绿的）：
 *
 *   PIX_TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/hellopix_rc02 \
 *     node --test test/recharge-amount.test.js
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const databaseUrl = process.env.PIX_TEST_DATABASE_URL

const ADDRESS = 'TEfCDDuYwYdjCn2WDa7TNWCU9bkBk9EXPX'
const TOKEN = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const BASE = 35000n // 35.000 USDT
const HOUR = 3600 * 1000

test('充值金额预约：并发唯一性与 24 小时保护期', { skip: !databaseUrl }, async t => {
  process.env.DATABASE_URL = databaseUrl
  const { Pool } = require('pg')
  const { RechargeAmountService, POOL_SIZE } = require('../server/services/recharge-amount-service')
  const { formatMilli, toMilli } = require('../server/lib/money')

  const pool = new Pool({ connectionString: databaseUrl, max: 40 })
  const svc = new RechargeAmountService()
  const created = { recharges: [], users: [] }
  let userSeq = 0

  // 每个子测试用独立地址，避免互相污染
  let addrSeq = 0
  const nextAddress = () => `${ADDRESS.slice(0, 20)}${String(++addrSeq).padStart(3, '0')}${ADDRESS.slice(23)}`

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
    } finally {
      client.release()
    }
  }

  /** 造一个最小可用的商户，用于挂 recharges（外键需求） */
  async function makeUser() {
    const name = `rc02_${process.pid}_${Date.now()}_${++userSeq}`
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, nickname, email, email_verified, status,
                          char_balance, char_used, translate_count, sub_quota, auto_alloc_master,
                          auto_reply, enterprise, port_limit, ports_in_use, remarks)
       VALUES ($1,$2,$1,$3,false,1,0,0,0,0,false,false,false,1,0,'')
       RETURNING id`,
      // users_password_hash_check 要求 scrypt$salt$hash 形状，随便给个 'x' 会被拒
      [name, 'scrypt$testsalt$testhash', `${name}@example.test`]
    )
    created.users.push(rows[0].id)
    return rows[0].id
  }

  /** 造一张订单，并占用一个金额（走真实服务） */
  async function makeOrder({ address, token, base, expiresAt, protection }) {
    const userId = await makeUser()
    const amountSvc = protection === undefined
      ? svc
      : new RechargeAmountService({ protectionHours: protection })
    return withTx(async client => {
      const alloc = await amountSvc.allocate(client, {
        payAddress: address,
        tokenContract: token,
        baseAmountMilli: base,
        expiresAt
      })
      const orderNumber = `RC02${Date.now()}${Math.floor(Math.random() * 1e6)}`
      // 必须用事务的 client —— 用 pool.query 会走另一条连接，
      // 刚插入的预约在那个连接上不可见，外键直接报错
      const { rows } = await client.query(
        `INSERT INTO recharges (user_id, order_number, kind, payment_type, quantity, chars,
           original_amount, discount_amount, surcharge_amount, paid_amount, status,
           idempotency_key, expires_at, amount_reservation_id)
         VALUES ($1,$2,'package','USDT-TRC20',1,1000,
           $3,0,$4,$5,0,$6,$7,$8)
         RETURNING id, paid_amount, surcharge_amount, expires_at`,
        [
          userId, orderNumber,
          formatMilli(base),
          formatMilli(alloc.suffixMilli),
          formatMilli(alloc.amountMilli),
          `rc02:${orderNumber}`,
          expiresAt.toISOString(),
          String(alloc.reservationId)
        ]
      )
      await amountSvc.attachToRecharge(client, alloc.reservationId, rows[0].id)
      created.recharges.push(rows[0].id)
      return { order: rows[0], alloc, userId }
    })
  }

  /** 把订单推进到终态（模拟结算成功 / 过期），并延长保护期 */
  async function terminalize(orderId, reservationId, status, at) {
    await withTx(async client => {
      await client.query(
        `UPDATE recharges
            SET status = $2::smallint,
                terminal_at = $3::timestamptz,
                paid_at = CASE WHEN $2::smallint = 1 THEN $3::timestamptz ELSE paid_at END,
                terminal_reason = $4,
                updated_at = now()
          WHERE id = $1`,
        [String(orderId), status, at.toISOString(), status === 1 ? 'settled' : 'expired']
      )
      await svc.extendProtection(client, reservationId, at)
    })
  }

  t.after(async () => {
    // 清理顺序受外键约束：先删预约的引用，再删订单，最后删用户
    if (created.recharges.length) {
      await pool.query('UPDATE recharge_amount_reservations SET recharge_id=NULL WHERE recharge_id = ANY($1::bigint[])',
        [created.recharges])
      await pool.query('DELETE FROM recharges WHERE id = ANY($1::bigint[])', [created.recharges])
    }
    if (created.users.length) {
      await pool.query('DELETE FROM recharges WHERE user_id = ANY($1::bigint[])', [created.users])
      await pool.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [created.users])
    }
    await pool.query("DELETE FROM recharge_amount_reservations WHERE pay_address LIKE 'TEfCDDuYwYdjCn2WDa7%'")
    await pool.end()
  })

  // =========================================================== 并发唯一性

  await t.test('100 个并发请求拿到 100 个互不相同的金额', async () => {
    const address = nextAddress()
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000)

    const results = await Promise.all(
      Array.from({ length: 100 }, () => withTx(client => svc.allocate(client, {
        payAddress: address, tokenContract: TOKEN, baseAmountMilli: BASE, expiresAt
      })))
    )

    const amounts = results.map(r => String(r.amountMilli))
    assert.equal(new Set(amounts).size, 100, '并发下出现了重复金额 —— 唯一索引没起作用')

    // 全部落在 base+1 .. base+999
    for (const r of results) {
      assert.ok(r.amountMilli > BASE && r.amountMilli <= BASE + 999n,
        `金额 ${r.amountMilli} 越界`)
    }
    assert.equal(await svc.heldCount(pool, {
      payAddress: address, tokenContract: TOKEN, baseAmountMilli: BASE
    }), 100)
  })

  await t.test('数据库唯一索引是硬保证：绕过服务直接插同金额也只有一个成功', async () => {
    const address = nextAddress()
    const amount = BASE + 427n
    const deadline = new Date(Date.now() + HOUR).toISOString()

    const insert = () => pool.query(
      `INSERT INTO recharge_amount_reservations
         (pay_address, pay_token_contract, amount_milli, suffix, reusable_after)
       VALUES ($1,$2,$3::bigint,427,$4::timestamptz)
       ON CONFLICT (pay_address, pay_token_contract, amount_milli) WHERE state='held' DO NOTHING
       RETURNING id`,
      [address, TOKEN, String(amount), deadline]
    )

    const outcomes = await Promise.all(Array.from({ length: 20 }, insert))
    const inserted = outcomes.filter(r => r.rows.length > 0)
    assert.equal(inserted.length, 1, '同一金额必须只能有一条 held 预约')
  })

  // =========================================================== Rule B 池耗尽

  await t.test('池满时抛 AMOUNT_POOL_EXHAUSTED —— 不回退 000、不顺序 +1', async () => {
    // 用一个全新的基数，等价于一个独立的 999 池子
    const address = nextAddress()
    const base = 88000n
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000)

    // 一次事务里占满 999 个
    await withTx(async client => {
      const seen = new Set()
      for (let i = 0; i < POOL_SIZE; i++) {
        // 直接用随机重试占满（走真实服务，保证占用方式与生产一致）
        let got = null
        for (let attempt = 0; attempt < 200 && !got; attempt++) {
          const r = await svc.allocate(client, {
            payAddress: address, tokenContract: TOKEN, baseAmountMilli: base, expiresAt
          })
          if (!seen.has(String(r.amountMilli))) { seen.add(String(r.amountMilli)); got = r }
        }
        assert.ok(got, `第 ${i + 1} 个占位失败`)
      }
    })

    assert.equal(await svc.heldCount(pool, {
      payAddress: address, tokenContract: TOKEN, baseAmountMilli: base
    }), POOL_SIZE)

    // 池满：必须明确失败
    await withTx(async client => {
      await assert.rejects(
        () => svc.allocate(client, {
          payAddress: address, tokenContract: TOKEN, baseAmountMilli: base, expiresAt
        }),
        err => {
          assert.equal(err.code, 'AMOUNT_POOL_EXHAUSTED', `错误码应为 AMOUNT_POOL_EXHAUSTED，实际 ${err.code}`)
          assert.equal(err.status, 503)
          assert.match(err.message, /已用尽/)
          return true
        }
      )
    })

    // 且没有产生 000 尾数（不许回退到标准价）
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM recharge_amount_reservations
        WHERE pay_address=$1 AND amount_milli = $2::bigint`,
      [address, String(base)]
    )
    assert.equal(rows[0].n, 0, '池满时不得回退到 000 尾数（即标准价本身）')
  })

  await t.test('随机尾数不是顺序递增 —— 50 次的分布足够散', async () => {
    const address = nextAddress()
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000)
    const suffixes = await withTx(async client => {
      const out = []
      for (let i = 0; i < 50; i++) {
        const r = await svc.allocate(client, {
          payAddress: address, tokenContract: TOKEN, baseAmountMilli: BASE, expiresAt
        })
        out.push(Number(r.suffixMilli))
      }
      return out
    })

    assert.equal(new Set(suffixes).size, 50, '尾数出现重复')
    assert.ok(suffixes.every(s => s >= 1 && s <= 999), '尾数越界')
    // 顺序递增会得到 [1..50]，跨度 49；随机应当明显更散
    const spread = Math.max(...suffixes) - Math.min(...suffixes)
    assert.ok(spread > 60, `尾数跨度过小（${spread}），疑似顺序生成`)
    assert.notDeepEqual(suffixes, Array.from({ length: 50 }, (_, i) => i + 1))
  })

  await t.test('随机源恒定时第二个订单不会拿到同一金额（证明没有 +1 复用）', async () => {
    const address = nextAddress()
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000)
    const fixed = new RechargeAmountService({ randomSuffix: () => 427 })

    const { first, second } = await withTx(async client => {
      const a = await fixed.allocate(client, {
        payAddress: address, tokenContract: TOKEN, baseAmountMilli: BASE, expiresAt
      })
      const b = await fixed.allocate(client, {
        payAddress: address, tokenContract: TOKEN, baseAmountMilli: BASE, expiresAt
      })
      return { first: a, second: b }
    })

    assert.equal(Number(first.suffixMilli), 427)
    assert.notEqual(String(first.amountMilli), String(second.amountMilli),
      '两次分配拿到了同一金额')
    assert.ok(second.suffixMilli >= 1n && second.suffixMilli <= 999n)
    assert.notEqual(Number(second.suffixMilli), 0, '绝不回退到 000')
  })

  // =========================================================== Rule A 保护期

  await t.test('订单进入终态后，金额在保护期内仍不可被复用', async () => {
    const address = nextAddress()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000)

    const { order, alloc } = await makeOrder({ address, token: TOKEN, base: BASE, expiresAt })
    const amount = String(alloc.amountMilli)

    // 订单过期
    await terminalize(order.id, alloc.reservationId, 2, new Date(now.getTime() + 31 * 60 * 1000))

    // 预约仍是 held
    const row = await svc.lookupByAmount(pool, {
      payAddress: address, tokenContract: TOKEN, amountMilli: BigInt(amount)
    })
    assert.equal(row.state, 'held', '保护期内预约必须仍是 held')

    // 保护期内尝试占用同一金额：必须拿不到
    const taken = await withTx(async client => {
      const results = []
      for (let i = 0; i < 200; i++) {
        const r = await svc.allocate(client, {
          payAddress: address, tokenContract: TOKEN, baseAmountMilli: BASE, expiresAt
        })
        results.push(String(r.amountMilli))
      }
      return results
    })
    assert.ok(!taken.includes(amount),
      `保护期内金额 ${amount} 被重新分配出去了 —— 迟到款会错配到新订单`)
  })

  await t.test('保护期内到达的迟到款能找回原订单 —— 这是进异常池的依据', async () => {
    const address = nextAddress()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000)

    const { order, alloc } = await makeOrder({ address, token: TOKEN, base: BASE, expiresAt })
    await terminalize(order.id, alloc.reservationId, 2, new Date(now.getTime() + 31 * 60 * 1000))

    // 链上此刻到账同一金额
    const found = await svc.lookupByAmount(pool, {
      payAddress: address, tokenContract: TOKEN, amountMilli: alloc.amountMilli
    })
    assert.ok(found, '迟到的金额必须能反查到预约')
    assert.equal(String(found.recharge_id), String(order.id),
      '反查到的必须正是原订单，而不是别的订单')
  })

  await t.test('保护期到期后金额被释放，可以重新分配', async () => {
    const address = nextAddress()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000)

    const { order, alloc } = await makeOrder({ address, token: TOKEN, base: BASE, expiresAt })
    await terminalize(order.id, alloc.reservationId, 2, new Date(now.getTime() + 31 * 60 * 1000))

    // 模拟 24 小时已过：把 reserved_at 与 reusable_after 一起往前拨。
    // 不能只把 reusable_after 拨到过去 —— 那会违反
    // CHECK (reusable_after > reserved_at)，而那条约束本身是对的。
    await pool.query(
      `UPDATE recharge_amount_reservations
          SET reserved_at = now() - interval '25 hours',
              reusable_after = now() - interval '1 hour'
        WHERE id = $1`,
      [String(alloc.reservationId)]
    )

    const released = await withTx(client => svc.releaseExpired(client, {
      payAddress: address, tokenContract: TOKEN
    }))
    assert.equal(released, 1, '到点的预约应被释放')

    const row = await svc.lookupByAmount(pool, {
      payAddress: address, tokenContract: TOKEN, amountMilli: alloc.amountMilli
    })
    assert.equal(row.state, 'released')
    // released 的历史行必须保留 —— 迟到款归属靠它
    assert.equal(String(row.recharge_id), String(order.id))
  })

  await t.test('释放后的金额可以被新订单占用', async () => {
    const address = nextAddress()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000)

    const { order, alloc } = await makeOrder({ address, token: TOKEN, base: BASE, expiresAt })
    await terminalize(order.id, alloc.reservationId, 2, new Date(now.getTime() + 31 * 60 * 1000))
    await pool.query(
      `UPDATE recharge_amount_reservations
          SET reserved_at = now() - interval '25 hours',
              reusable_after = now() - interval '1 hour'
        WHERE id = $1`,
      [String(alloc.reservationId)]
    )

    // 用固定随机源直接指名要那个金额，验证它确实空出来了
    const pinned = new RechargeAmountService({
      randomSuffix: () => Number(alloc.suffixMilli)
    })
    const reused = await withTx(client => pinned.allocate(client, {
      payAddress: address, tokenContract: TOKEN, baseAmountMilli: BASE, expiresAt
    }))
    assert.equal(String(reused.amountMilli), String(alloc.amountMilli),
      '释放后的金额应当可以被重新占用')
  })

  await t.test('提前终态不会缩短保护期（GREATEST 语义）', async () => {
    const address = nextAddress()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000)

    const { order, alloc } = await makeOrder({ address, token: TOKEN, base: BASE, expiresAt })
    // 5 分钟就付款成功 —— 远早于 expires_at
    await terminalize(order.id, alloc.reservationId, 1, new Date(now.getTime() + 5 * 60 * 1000))

    const { rows } = await pool.query(
      'SELECT reusable_after FROM recharge_amount_reservations WHERE id=$1',
      [String(alloc.reservationId)]
    )
    const deadline = new Date(rows[0].reusable_after).getTime()
    const expiresBased = expiresAt.getTime() + 24 * HOUR
    const terminalBased = now.getTime() + 5 * 60 * 1000 + 24 * HOUR

    assert.ok(deadline >= expiresBased - 1000,
      '提前付款把保护期缩短了 —— 临到期才转出的迟到款会失去归属')
    assert.ok(deadline > terminalBased,
      '保护期应当以 expires_at 为下界，而不是付款时刻')
  })

  await t.test('不同收款地址的尾数池互不干扰', async () => {
    const addrA = nextAddress()
    const addrB = nextAddress()
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000)
    const pinned = () => 500

    const svcA = new RechargeAmountService({ randomSuffix: pinned })
    const a = await withTx(c => svcA.allocate(c, {
      payAddress: addrA, tokenContract: TOKEN, baseAmountMilli: BASE, expiresAt
    }))
    const b = await withTx(c => svcA.allocate(c, {
      payAddress: addrB, tokenContract: TOKEN, baseAmountMilli: BASE, expiresAt
    }))
    assert.equal(String(a.amountMilli), String(b.amountMilli),
      '不同地址可以持有相同金额 —— 唯一性是按地址隔离的')
  })
})
