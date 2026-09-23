'use strict'

/**
 * Shadow 运行报告生成器。
 *
 * 数据来源全部是**客观记录**，不靠人工统计：
 *   - /var/log/hello-pix/recharge-watcher-stats.jsonl  每轮一行 JSON
 *   - 数据库：chain_transactions / recharge_exceptions / recharges / users
 *
 * 用法：
 *   cd /opt/hello-pix && node deploy/shadow-report.js
 *   node deploy/shadow-report.js --since "2026-09-23T17:00:00Z"
 */

const fs = require('node:fs')
const path = require('node:path')

const APP = process.env.APP_DIR || '/opt/hello-pix'
const STATS_FILE = process.env.RECHARGE_WATCHER_STATS_FILE ||
  '/var/log/hello-pix/recharge-watcher-stats.jsonl'
const LOG_FILE = process.env.RECHARGE_WATCHER_LOG || '/var/log/hello-pix/recharge-watcher.log'

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}

const SINCE = argValue('--since') ? new Date(argValue('--since')) : null

function readStats() {
  let text = ''
  try { text = fs.readFileSync(STATS_FILE, 'utf8') } catch (_e) { return [] }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line)
      if (SINCE && new Date(rec.ts) < SINCE) continue
      out.push(rec)
    } catch (_e) { /* 半截行（轮转瞬间）忽略 */ }
  }
  return out
}

/** 从原始日志里数一次错误码出现次数（统计文件只记当轮结果，不含历史） */
function countLogPattern(pattern) {
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8')
    return (text.match(pattern) || []).length
  } catch (_e) { return 0 }
}

async function connectDb() {
  const env = Object.fromEntries(
    fs.readFileSync('/etc/hello-pix/hello-pix.env', 'utf8')
      .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
  const { Client } = require(path.join(APP, 'node_modules/pg'))
  const db = new Client({ connectionString: env.DATABASE_URL })
  await db.connect()
  return db
}

function bar(title) {
  console.log('\n' + '='.repeat(64))
  console.log(title)
  console.log('='.repeat(64))
}

async function main() {
  const stats = readStats()
  // 这两个在「一、执行情况」里算出来，但「八、结论」还要用 ——
  // 定义在 if 块里会 ReferenceError（踩过）
  const failed = stats.filter(r => !r.ok).length
  const live = stats.filter(r => r.mode === 'live').length
  const shadow = stats.filter(r => r.mode === 'shadow').length
  const db = await connectDb()
  try {
    bar('一、Watcher 执行情况')
    console.log(`  统计区间     ${SINCE ? SINCE.toISOString() + ' 起' : '全部'}`)
    console.log(`  实际执行轮次 ${stats.length}`)
    if (stats.length) {
      const first = stats[0]
      const last = stats[stats.length - 1]
      console.log(`  首轮         ${first.ts}`)
      console.log(`  末轮         ${last.ts}`)
      const spanMin = (new Date(last.ts) - new Date(first.ts)) / 60000
      console.log(`  时间跨度     ${spanMin.toFixed(1)} 分钟`)
      if (spanMin > 0) {
        // 每分钟一次，实际轮次 / 理论轮次 = 执行率
        const expected = spanMin + 1
        console.log(`  执行率       ${(stats.length / expected * 100).toFixed(1)}%  ` +
          `(理论 ${Math.round(expected)} 轮)`)
      }
      console.log(`  成功 / 失败  ${stats.length - failed} / ${failed}`)
      console.log(`  shadow 轮次  ${shadow}`)
      console.log(`  live 轮次    ${live}${live > 0 ? '   ⚠⚠ 出现了真实结算轮次！' : '   ✓ 全程未开启真实结算'}`)
      const durations = stats.map(r => Number(r.durationMs) || 0)
      console.log(`  单轮耗时     avg ${Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)}ms` +
        ` / max ${Math.max(...durations)}ms`)
    }

    bar('二、TronGrid 请求情况')
    let calls = 0, latency = 0, apiFailures = 0
    const errors = {}
    for (const rec of stats) {
      for (const a of rec.addresses || []) {
        calls += Number(a.apiCalls) || 0
        latency += Number(a.apiLatencyMs) || 0
        apiFailures += Number(a.apiFailures) || 0
        if (a.error) errors[a.error] = (errors[a.error] || 0) + 1
      }
    }
    console.log(`  请求总数     ${calls}`)
    console.log(`  平均延迟     ${calls ? Math.round(latency / calls) : 0}ms   （总 ${latency}ms）`)
    console.log(`  失败请求     ${apiFailures}`)
    console.log('  错误码分布   ' + (Object.keys(errors).length
      ? Object.entries(errors).map(([k, v]) => `${k}×${v}`).join('  ')
      : '(无)'))
    console.log('  日志中出现次数（含被 flock 跳过的轮次）：')
    for (const code of ['RATE_LIMITED', 'UPSTREAM_ERROR', 'TIMEOUT', 'UNAUTHORIZED', 'BAD_REQUEST']) {
      console.log(`    ${code.padEnd(16)} ${countLogPattern(new RegExp(code, 'g'))}`)
    }
    const skipped = countLogPattern(/上一轮仍在运行，跳过本轮/g)
    console.log(`    flock 跳过轮次   ${skipped}`)
    const timedOut = countLogPattern(/单轮超时/g)
    console.log(`    单轮超时次数     ${timedOut}`)

    bar('三、Checkpoint 位置')
    const cursors = (await db.query(
      `SELECT address, last_scanned_timestamp, last_scanned_block, last_scanned_at,
              consecutive_failures, last_error
         FROM chain_scan_cursor ORDER BY address`)).rows
    for (const c of cursors) {
      console.log(`  地址 ${c.address}`)
      console.log(`    当前游标   ${new Date(Number(c.last_scanned_timestamp)).toISOString()}`)
      console.log(`    最终确认块 ${c.last_scanned_block || '(未记录)'}`)
      console.log(`    最近扫描   ${c.last_scanned_at ? new Date(c.last_scanned_at).toISOString() : '(从未)'}`)
      console.log(`    连续失败   ${c.consecutive_failures}` +
        (c.last_error ? `   最近错误: ${c.last_error}` : ''))
    }
    const froms = stats.flatMap(r => (r.addresses || []).map(a => Number(a.checkpointFrom) || 0)).filter(Boolean)
    const tos = stats.flatMap(r => (r.addresses || []).map(a => Number(a.checkpointTo) || 0)).filter(Boolean)
    if (froms.length) {
      console.log(`  区间内推进 ${new Date(Math.min(...froms)).toISOString()}  →  ${new Date(Math.max(...tos)).toISOString()}`)
      console.log(`  推进总量   ${((Math.max(...tos) - Math.min(...froms)) / 60000).toFixed(1)} 分钟`)
    }

    bar('四、链上交易与匹配结果')
    const sum = key => stats.reduce((acc, r) =>
      acc + (r.addresses || []).reduce((s, a) => s + (Number(a[key]) || 0), 0), 0)
    console.log(`  拉到（去重前）  ${sum('fetched')}`)
    console.log(`  处理            ${sum('processed')}`)
    console.log(`  新增落库        ${sum('inserted')}`)
    console.log(`  重复扫描命中    ${sum('duplicates')}`)
    console.log(`  shadow 匹配     ${sum('shadowMatched')}`)
    console.log(`  真实结算        ${sum('settled')}${sum('settled') > 0 ? '   ⚠⚠ 出现了真实入账！' : '   ✓ 全程为 0'}`)
    console.log(`  异常            ${sum('exceptions')}`)
    console.log(`  未确认跳过      ${sum('skippedUnsolidified')}`)

    const txTotal = (await db.query('SELECT count(*)::int AS n FROM chain_transactions')).rows[0].n
    const byKind = (await db.query(
      `SELECT coalesce(match_kind,'(未匹配)') AS kind, count(*)::int AS n
         FROM chain_transactions GROUP BY 1 ORDER BY 2 DESC`)).rows
    const byMode = (await db.query(
      'SELECT mode, count(*)::int AS n FROM chain_transactions GROUP BY 1')).rows
    console.log(`\n  数据库 chain_transactions 总数 ${txTotal}`)
    byMode.forEach(r => console.log(`    模式 ${r.mode}: ${r.n}`))
    byKind.forEach(r => console.log(`    结论 ${r.kind}: ${r.n}`))

    bar('五、异常池')
    const exc = (await db.query(
      `SELECT kind, status, count(*)::int AS n FROM recharge_exceptions
        GROUP BY 1,2 ORDER BY 3 DESC`)).rows
    const excTotal = (await db.query('SELECT count(*)::int AS n FROM recharge_exceptions')).rows[0].n
    const dupExc = (await db.query(
      `SELECT tx_id, kind, count(*)::int AS n FROM recharge_exceptions
        WHERE tx_id IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1`)).rows
    console.log(`  异常总数     ${excTotal}`)
    exc.forEach(r => console.log(`    ${r.kind} / ${r.status}: ${r.n}`))
    console.log(`  重复异常     ${dupExc.length} 组` +
      (dupExc.length ? '   ✗ (tx_id, kind) 去重失效！' : '   ✓ 无重复（(tx_id,kind) 去重生效）'))
    const openList = (await db.query(
      `SELECT kind, summary, to_char(created_at,'MM-DD HH24:MI') AS t
         FROM recharge_exceptions WHERE status='open' ORDER BY created_at DESC LIMIT 10`)).rows
    if (openList.length) {
      console.log('  待处理明细：')
      openList.forEach(r => console.log(`    [${r.t}] ${r.kind}  ${r.summary}`))
    }

    bar('六、余额与订单状态（必须全部为 0 / 未变）')
    const g = (await db.query(
      `SELECT (SELECT count(*) FROM users) AS users,
              (SELECT coalesce(sum(char_balance),0) FROM users) AS balance,
              (SELECT count(*) FROM char_ledger) AS ledger,
              (SELECT count(*) FROM recharges) AS recharges,
              (SELECT count(*) FROM recharges WHERE status=0) AS pending,
              (SELECT count(*) FROM recharges WHERE status=1) AS paid,
              (SELECT coalesce(sum(char_used),0) FROM users) AS used`)).rows[0]
    console.log(`  用户数        ${g.users}`)
    console.log(`  字符余额合计  ${g.balance}   ${Number(g.balance) === 0 ? '✓ 未被改动' : '⚠ 有变化'}`)
    console.log(`  字符流水条数  ${g.ledger}   ${Number(g.ledger) === 0 ? '✓ 未写入' : '⚠ 有写入'}`)
    console.log(`  订单总数      ${g.recharges}  (pending ${g.pending} / paid ${g.paid})`)
    console.log(`  已用字符合计  ${g.used}   ${Number(g.used) === 0 ? '✓ 未消耗' : '⚠ 有消耗'}`)
    if (Number(g.paid) > 0) console.log('  ⚠⚠ 出现了已支付订单 —— Shadow 模式下不应发生！')

    bar('七、测试订单（故意不付款）')
    const probe = (await db.query(
      `SELECT r.order_number, r.status, r.paid_amount, r.surcharge_amount,
              to_char(r.created_at,'MM-DD HH24:MI:SS') AS created,
              to_char(r.expires_at,'MM-DD HH24:MI:SS') AS expires,
              r.paid_at IS NULL AS never_paid,
              res.state AS reservation_state, res.suffix
         FROM recharges r
         LEFT JOIN recharge_amount_reservations res ON res.id = r.amount_reservation_id
         JOIN users u ON u.id = r.user_id
        WHERE u.username = 'shadowprobe'
        ORDER BY r.id DESC LIMIT 3`)).rows
    if (!probe.length) {
      console.log('  没有 shadowprobe 的测试订单')
    }
    for (const r of probe) {
      console.log(`  ${r.order_number}  应付 ${r.paid_amount}  尾数 ${r.surcharge_amount}`)
      console.log(`    状态 ${r.status} (0=pending)  预约 ${r.reservation_state}  从未支付 ${r.never_paid ? '✓' : '✗'}`)
      console.log(`    创建 ${r.created}  到期 ${r.expires}`)
    }

    bar('八、结论')
    const problems = []
    if (sum('settled') > 0) problems.push('出现了真实结算')
    if (Number(g.balance) !== 0) problems.push('字符余额发生变化')
    if (Number(g.ledger) !== 0) problems.push('写入了字符流水')
    if (Number(g.paid) > 0) problems.push('出现已支付订单')
    if (dupExc.length) problems.push('异常池出现重复记录')
    if (live > 0) problems.push('出现了 live 模式轮次')
    if (problems.length) {
      problems.forEach(p => console.log(`  ✗ ${p}`))
    } else {
      console.log('  ✓ Shadow 模式全程保持：只观察、只记录，未改动任何余额或订单状态')
    }
    return problems.length ? 1 : 0
  } finally {
    await db.end()
  }
}

main()
  .then(code => { process.exitCode = code || 0 })
  .catch(error => { console.error('报告生成失败:', (error && error.stack) || error); process.exitCode = 1 })
