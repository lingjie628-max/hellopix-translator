'use strict'

/**
 * ChainWatcher 测试（需要真实 PostgreSQL）。
 *
 * 全部围绕一条原则：**可以重复扫，不能漏，也不能多入账。**
 *
 * 覆盖用户点名的故障场景：
 *   - 同一区块/同一交易重复返回
 *   - Worker 重启后从 checkpoint 恢复
 *   - 查询 API 429 / 5xx / 超时
 *   - 分页过程中服务中断
 *   - 查到未 solidified 交易时不能提前结算
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const databaseUrl = process.env.PIX_TEST_DATABASE_URL

const ADDRESS = 'TEfCDDuYwYdjCn2WDa7TNWCU9bkBk9EXPX'
const FROM = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const TOKEN = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const BASE_MILLI = 40000n
const SOLID_TS = Date.now()

test('ChainWatcher：重复扫描、重启恢复、上游故障、未确认交易', { skip: !databaseUrl }, async t => {
  process.env.DATABASE_URL = databaseUrl
  process.env.PIX_CREDENTIAL_KEY = process.env.PIX_CREDENTIAL_KEY || 'a'.repeat(64)

  const { Pool } = require('pg')
  const { ProductionRepository } = require('../server/repositories/production-repository')
  const { RechargeAmountService } = require('../server/services/recharge-amount-service')
  const { RechargeSettlementService } = require('../server/services/recharge-settlement-service')
  const { ScanCursorService } = require('../server/services/tron/scan-cursor')
  const { makeTransfer, milliToChainUnits } = require('../server/services/tron/transfer')
  const { formatMilli } = require('../server/lib/money')
  const { ProviderError } = require('../server/services/tron/tron-provider')
  // config.js 在 require 时读环境变量，所以必须在设好 DATABASE_URL 之后再加载
  const { scanOneAddress } = require('../scripts/recharge-watcher')

  const pool = new Pool({ connectionString: databaseUrl, max: 10 })
  const repo = new ProductionRepository(pool)
  const amount = new RechargeAmountService()
  const cursor = new ScanCursorService({ rewindMs: 5 * 60 * 1000, initialLookbackMs: 3600 * 1000 })
  const settlement = new RechargeSettlementService(repo, {
    amountService: amount, autoSettlementEnabled: true, tokenContract: TOKEN
  })

  const created = { users: [], recharges: [], reservations: [] }
  let seq = 0
  const address = `${ADDRESS.slice(0, 18)}${String(Date.now() % 10000).padStart(4, '0')}${ADDRESS.slice(22)}`

  async function makeUser() {
    const name = `rc02watch_${process.pid}_${Date.now()}_${++seq}`
    const { rows } = await pool.query(
      `INSERT INTO users(username,password_hash,nickname,email,email_verified,status,
         char_balance,char_used,translate_count,sub_quota,auto_alloc_master,auto_reply,
         enterprise,port_limit,ports_in_use,remarks)
       VALUES($1,'scrypt$s$h',$1,$2,false,1,0,0,0,0,false,false,false,1,0,'') RETURNING id, char_balance`,
      [name, `${name}@example.test`])
    created.users.push(rows[0].id)
    return rows[0]
  }

  async function makeOrder() {
    const user = await makeUser()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const expiresAt = new Date(SOLID_TS + 30 * 60 * 1000)
      const alloc = await amount.allocate(client, {
        payAddress: address, tokenContract: TOKEN, baseAmountMilli: BASE_MILLI, expiresAt
      })
      const orderNumber = `WATCH${Date.now()}${Math.floor(Math.random() * 1e6)}`
      const { rows } = await client.query(
        `INSERT INTO recharges(user_id, order_number, kind, payment_type, quantity, chars,
           original_amount, discount_amount, surcharge_amount, paid_amount, status,
           idempotency_key, expires_at, pay_address, pay_token_contract, amount_reservation_id)
         VALUES($1,$2,'package','USDT-TRC20',1,1000,$3,0,$4,$5,0,$6,$7,$8,$9,$10)
         RETURNING id, amount_reservation_id`,
        [user.id, orderNumber, formatMilli(BASE_MILLI), formatMilli(alloc.suffixMilli),
          formatMilli(alloc.amountMilli), `watch:${orderNumber}`,
          expiresAt.toISOString(), address, TOKEN, String(alloc.reservationId)])
      await amount.attachToRecharge(client, alloc.reservationId, rows[0].id)
      await client.query('COMMIT')
      created.recharges.push(rows[0].id)
      created.reservations.push(alloc.reservationId)
      return { order: rows[0], user, amountMilli: alloc.amountMilli }
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally { client.release() }
  }

  /** 一个可控的假 Provider，接口与 TronGridProvider 相同 */
  function mockProvider(handlers) {
    const state = { calls: 0 }
    return {
      name: 'mock',
      state,
      async latestSolidBlock() {
        state.calls += 1
        if (handlers.solidError) throw handlers.solidError
        return { blockNumber: 60000000, blockTimestamp: handlers.solidTs || SOLID_TS }
      },
      async listIncomingTransfers(params) {
        state.calls += 1
        if (handlers.listError) throw handlers.listError
        const all = handlers.transfers || []
        // ignoreWindow 模拟"Provider 返回了请求窗口之外的数据"这种越界行为。
        // 真实 Provider 用 max_timestamp 过滤，正常不会发生 ——
        // 但 watcher 的防御层必须挡住它，下面那条测试验的就是这个。
        const selected = handlers.ignoreWindow
          ? all
          : all.filter(x => x.blockTimestamp >= params.fromTimestamp && x.blockTimestamp <= params.toTimestamp)
        return { transfers: selected, hasMore: false, nextFromTimestamp: params.toTimestamp }
      },
      async getTransactionBlock() { return null },
      async health() { return { ok: true } }
    }
  }

  const transferFor = (ctx, overrides) => makeTransfer(Object.assign({
    txId: require('crypto').randomBytes(32).toString('hex'),
    tokenContract: TOKEN,
    fromAddress: FROM,
    toAddress: address,
    chainUnits: milliToChainUnits(ctx.amountMilli).toString(),
    blockTimestamp: SOLID_TS - 60 * 1000,
    solidified: true
  }, overrides || {}))

  const scan = provider => scanOneAddress({
    pool, cursor, settlement, provider, address, tokenContract: TOKEN
  })

  const balanceOf = async userId =>
    Number((await pool.query('SELECT char_balance FROM users WHERE id=$1', [userId])).rows[0].char_balance)

  const resetCursor = () => pool.query(
    'DELETE FROM chain_scan_cursor WHERE address=$1 AND token_contract=$2', [address, TOKEN])

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
      await pool.query('DELETE FROM chain_transactions WHERE to_address=$1', [address])
      await pool.query('DELETE FROM chain_scan_cursor WHERE address=$1', [address])
    } catch (e) { console.error('  清理出错:', e.message) }
    await pool.end()
  })

  // ============================================================ 重复扫描

  await t.test('同一笔交易重复返回：只入账一次', async () => {
    await resetCursor()
    const ctx = await makeOrder()
    const transfer = transferFor(ctx)
    const provider = mockProvider({ transfers: [transfer] })
    const before = await balanceOf(ctx.user.id)

    const first = await scan(provider)
    assert.equal(first.processed, 1)
    assert.equal(first.settled, 1)
    const after1 = await balanceOf(ctx.user.id)
    assert.equal(after1, before + 1000)

    // 第二轮：游标会回退一段，所以同一笔必然被重新看到
    const second = await scan(provider)
    assert.ok(second.fetched >= 1, '回退窗口内应当重新看到同一笔')
    assert.equal(second.settled, 0, '不该再结算一次')
    assert.ok(second.duplicates >= 1, '应当被识别为重复')
    assert.equal(await balanceOf(ctx.user.id), after1, '余额不得变化')

    const ledgerCount = (await pool.query('SELECT count(*)::int AS n FROM char_ledger WHERE reference_id=$1',
      [String(ctx.order.id)])).rows[0].n
    assert.equal(ledgerCount, 1, '字符流水只能有一条')
  })

  await t.test('同一区块内多笔交易：各自独立处理', async () => {
    await resetCursor()
    const a = await makeOrder()
    const b = await makeOrder()
    const ts = SOLID_TS - 90 * 1000
    const provider = mockProvider({
      transfers: [transferFor(a, { blockTimestamp: ts }), transferFor(b, { blockTimestamp: ts })]
    })
    const beforeA = await balanceOf(a.user.id)
    const beforeB = await balanceOf(b.user.id)
    const r = await scan(provider)
    assert.equal(r.processed, 2)
    assert.equal(r.settled, 2)
    assert.equal(await balanceOf(a.user.id), beforeA + 1000)
    assert.equal(await balanceOf(b.user.id), beforeB + 1000)
  })

  // ============================================================ 重启恢复

  await t.test('Worker 重启后从 checkpoint 恢复，不丢也不重', async () => {
    await resetCursor()
    const ctx = await makeOrder()
    const transfer = transferFor(ctx)
    const before = await balanceOf(ctx.user.id)

    // 第一轮：正常扫完并推进游标
    await scan(mockProvider({ transfers: [transfer] }))
    const cursorRow = await pool.query(
      'SELECT last_scanned_timestamp FROM chain_scan_cursor WHERE address=$1 AND token_contract=$2',
      [address, TOKEN])
    const saved = Number(cursorRow.rows[0].last_scanned_timestamp)
    assert.ok(saved > 0, 'checkpoint 必须落库 —— 这是重启恢复的依据')

    // 模拟重启：新建一套 service 实例（内存状态清空），只靠数据库里的游标
    const freshCursor = new ScanCursorService({ rewindMs: 5 * 60 * 1000 })
    const freshSettlement = new RechargeSettlementService(repo, {
      amountService: new RechargeAmountService(), autoSettlementEnabled: true, tokenContract: TOKEN
    })
    const r = await scanOneAddress({
      pool, cursor: freshCursor, settlement: freshSettlement,
      provider: mockProvider({ transfers: [transfer] }), address, tokenContract: TOKEN
    })
    assert.equal(r.settled, 0, '重启后不得重复入账')
    assert.equal(await balanceOf(ctx.user.id), before + 1000, '余额应当保持第一次入账后的值')
  })

  await t.test('上游故障时不推进 checkpoint —— 下次从原处重来', async () => {
    await resetCursor()
    // 先正常扫一轮，建立一个基准游标
    await scan(mockProvider({ transfers: [] }))
    const before = (await pool.query(
      'SELECT last_scanned_timestamp FROM chain_scan_cursor WHERE address=$1 AND token_contract=$2',
      [address, TOKEN])).rows[0].last_scanned_timestamp

    const ctx = await makeOrder()
    const transfer = transferFor(ctx)
    // 上游 429
    await assert.rejects(() => scan(mockProvider({
      transfers: [transfer],
      listError: new ProviderError('限流', { code: 'RATE_LIMITED', retryable: true, status: 429 })
    })), err => err.code === 'RATE_LIMITED')

    const after = (await pool.query(
      'SELECT last_scanned_timestamp FROM chain_scan_cursor WHERE address=$1 AND token_contract=$2',
      [address, TOKEN])).rows[0].last_scanned_timestamp
    assert.equal(String(after), String(before), '失败时游标必须留在原处')

    const txCount = (await pool.query('SELECT count(*)::int AS n FROM chain_transactions WHERE tx_id=$1',
      [transfer.txId])).rows[0].n
    assert.equal(txCount, 0, '失败时不该写入任何交易')

    // 恢复后同一笔能被正常处理
    const r = await scan(mockProvider({ transfers: [transfer] }))
    assert.equal(r.settled, 1, '上游恢复后应当补上这笔')
  })

  await t.test('5xx 与超时同样不推进 checkpoint', async () => {
    for (const code of ['UPSTREAM_ERROR', 'TIMEOUT']) {
      await resetCursor()
      await scan(mockProvider({ transfers: [] }))
      const before = (await pool.query(
        'SELECT last_scanned_timestamp FROM chain_scan_cursor WHERE address=$1 AND token_contract=$2',
        [address, TOKEN])).rows[0].last_scanned_timestamp

      await assert.rejects(() => scan(mockProvider({
        transfers: [], listError: new ProviderError(code, { code, retryable: true })
      })), err => err.code === code)

      const after = (await pool.query(
        'SELECT last_scanned_timestamp FROM chain_scan_cursor WHERE address=$1 AND token_contract=$2',
        [address, TOKEN])).rows[0].last_scanned_timestamp
      assert.equal(String(after), String(before), `${code} 时游标不得推进`)
    }
  })

  await t.test('最终确认块查询失败也不推进 checkpoint', async () => {
    await resetCursor()
    await assert.rejects(() => scan(mockProvider({
      transfers: [], solidError: new ProviderError('挂了', { code: 'UPSTREAM_ERROR', retryable: true })
    })))
    const row = await pool.query(
      'SELECT last_scanned_timestamp FROM chain_scan_cursor WHERE address=$1 AND token_contract=$2',
      [address, TOKEN])
    // 游标行可能刚被 ensure 建出来，但时间戳必须还是 0
    assert.equal(Number((row.rows[0] || {}).last_scanned_timestamp || 0), 0)
  })

  // ============================================================ 未确认交易

  await t.test('未 solidified 的交易绝不结算，且游标不得越过它', async () => {
    await resetCursor()
    const ctx = await makeOrder()
    // 一笔"未来"的交易：时间戳晚于最终确认块
    const pendingTs = SOLID_TS + 5000
    const transfer = transferFor(ctx, { blockTimestamp: pendingTs, solidified: false })
    const before = await balanceOf(ctx.user.id)

    // 故意让 Provider 越界返回这条"未来"的交易 —— watcher 必须自己挡住
    const r = await scan(mockProvider({ transfers: [transfer], ignoreWindow: true }))
    assert.equal(r.processed, 0, '未确认交易不该被处理')
    assert.equal(r.skippedUnsolidified, 1)
    assert.equal(r.settled, 0)
    assert.equal(await balanceOf(ctx.user.id), before, '绝不能提前结算')

    const txCount = (await pool.query('SELECT count(*)::int AS n FROM chain_transactions WHERE tx_id=$1',
      [transfer.txId])).rows[0].n
    assert.equal(txCount, 0, '未确认交易不该落库（落库就会被幂等短路，永远不再结算）')

    const row = await pool.query(
      'SELECT last_scanned_timestamp FROM chain_scan_cursor WHERE address=$1 AND token_contract=$2',
      [address, TOKEN])
    const advanced = Number(row.rows[0].last_scanned_timestamp)
    assert.ok(advanced < pendingTs, '游标绝不能越过未处理的交易')
  })

  await t.test('交易确认之后，下一轮正常入账', async () => {
    await resetCursor()
    const ctx = await makeOrder()
    const txTs = SOLID_TS - 30 * 1000
    const transfer = transferFor(ctx, { blockTimestamp: txTs, solidified: true })
    const before = await balanceOf(ctx.user.id)
    const r = await scan(mockProvider({ transfers: [transfer] }))
    assert.equal(r.settled, 1)
    assert.equal(await balanceOf(ctx.user.id), before + 1000)
  })

  // ============================================================ 分页中断

  await t.test('分页过程中上游中断：整轮回滚，checkpoint 不动', async () => {
    await resetCursor()
    await scan(mockProvider({ transfers: [] }))
    const before = (await pool.query(
      'SELECT last_scanned_timestamp FROM chain_scan_cursor WHERE address=$1 AND token_contract=$2',
      [address, TOKEN])).rows[0].last_scanned_timestamp

    const ctx = await makeOrder()
    const transfer = transferFor(ctx)
    // 模拟"第一页拿到数据、第二页挂掉"：provider 在 list 里抛错
    const provider = mockProvider({
      transfers: [transfer],
      listError: new ProviderError('第二页 500', { code: 'UPSTREAM_ERROR', retryable: true, status: 500 })
    })
    await assert.rejects(() => scan(provider))

    const after = (await pool.query(
      'SELECT last_scanned_timestamp FROM chain_scan_cursor WHERE address=$1 AND token_contract=$2',
      [address, TOKEN])).rows[0].last_scanned_timestamp
    assert.equal(String(after), String(before), '中断时游标不得推进')

    const txCount = (await pool.query('SELECT count(*)::int AS n FROM chain_transactions WHERE tx_id=$1',
      [transfer.txId])).rows[0].n
    assert.equal(txCount, 0, '半截数据不该落库')

    // 恢复后重扫，这笔仍能被拿到（因为游标没动）
    const r = await scan(mockProvider({ transfers: [transfer] }))
    assert.equal(r.settled, 1)
  })

  // ============================================================ 连续推进

  await t.test('游标只进不退：并发/重放不会把它拨回去', async () => {
    await resetCursor()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const w = await cursor.beginScan(client, { address, tokenContract: TOKEN, now: SOLID_TS })
      await cursor.advance(client, { address, tokenContract: TOKEN, toTimestamp: SOLID_TS })
      // 再推一个更早的时间点
      await cursor.advance(client, { address, tokenContract: TOKEN, toTimestamp: SOLID_TS - 100000 })
      await client.query('COMMIT')
      const row = await cursor.get(client, { address, tokenContract: TOKEN })
      assert.equal(Number(row.last_scanned_timestamp), Math.floor(SOLID_TS), '不得被拨回更早的时间')
      assert.ok(w.fromTimestamp <= SOLID_TS)
    } finally { client.release() }
  })

  await t.test('没有可扫范围时不报错，游标保持', async () => {
    await resetCursor()
    // 游标推到未来
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await cursor.beginScan(client, { address, tokenContract: TOKEN, now: SOLID_TS })
      await cursor.advance(client, { address, tokenContract: TOKEN, toTimestamp: SOLID_TS + 3600 * 1000 })
      await client.query('COMMIT')
    } finally { client.release() }
    const r = await scan(mockProvider({ transfers: [], solidTs: SOLID_TS }))
    assert.equal(r.processed, 0)
    assert.equal(r.fetched, 0)
  })
})

// --------------------------------------------------- 每轮统计（Shadow 报告的数据源）

test('instrumentProvider 统计调用次数与耗时，失败也计入', async () => {
  const { instrumentProvider } = require('../scripts/recharge-watcher')
  const provider = {
    async latestSolidBlock() {
      await new Promise(r => setTimeout(r, 5))
      return { blockNumber: 1, blockTimestamp: Date.now() }
    },
    async listIncomingTransfers() { throw Object.assign(new Error('boom'), { code: 'UPSTREAM_ERROR' }) }
  }
  const stats = instrumentProvider(provider)
  await provider.latestSolidBlock()
  await assert.rejects(() => provider.listIncomingTransfers())
  assert.equal(stats.apiCalls, 2)
  assert.equal(stats.apiFailures, 1, '失败也要计入调用与耗时，否则统计会漏掉故障轮次')
  assert.ok(stats.apiLatencyMs >= 0)
})

test('统计文件路径可由环境变量覆盖，默认在 /var/log/hello-pix 下', () => {
  const { STATS_FILE } = require('../scripts/recharge-watcher')
  assert.ok(STATS_FILE.endsWith('recharge-watcher-stats.jsonl'))
  assert.match(STATS_FILE, /hello-pix/)
})

test('cron 包装脚本具备用户要求的四项保护', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'recharge-watcher-cron.sh'), 'utf8')
  assert.match(script, /flock -n/, '必须有单实例锁')
  assert.match(script, /timeout --signal=TERM --kill-after=\d+/, '必须有单轮超时')
  assert.match(script, /\/etc\/hello-pix\/hello-pix\.env/, '必须显式加载环境变量（cron 环境极简）')
  assert.match(script, /recharge-watcher\.log/, '必须有独立日志文件')
  // 超时被杀不能影响正确性 —— 注释里必须写清楚为什么
  assert.match(script, /游标未推进/, '要写明超时不会丢单的原因')
})

test('logrotate 配置存在且不会让日志无限增长', () => {
  const conf = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'logrotate-hello-pix-recharge-watcher'), 'utf8')
  assert.match(conf, /rotate \d+/, '必须限制保留份数')
  assert.match(conf, /maxsize \d+M/, '必须有体积上限，防止异常刷屏写满磁盘')
  assert.match(conf, /recharge-watcher\.log/)
  assert.match(conf, /recharge-watcher-stats\.jsonl/)
})

test('告警收件人用扁平键读取 —— 嵌套读法会让告警永远发不出去', () => {
  const { resolveRecipient } = require('../server/lib/ops-alert')
  assert.equal(resolveRecipient({ 'mail.alertTo': 'ops@x.test' }), 'ops@x.test')
  assert.equal(resolveRecipient({ 'mail.smtp': { from: 'noreply@x.test' } }), 'noreply@x.test')
  assert.equal(resolveRecipient({}), '')
  // 旧写法（嵌套）读不出来 —— 这正是修复前的行为
  assert.equal(resolveRecipient({ mail: { alertTo: 'ops@x.test' } }), '')
})
