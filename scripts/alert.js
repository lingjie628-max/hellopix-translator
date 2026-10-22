/**
 * 健康巡检与告警。由 cron 每 10 分钟跑一次。
 *
 * 检查四件事，任何一件不对就发邮件：
 *
 * 1. **服务能否响应** —— 挂了要立刻知道，而不是等用户投诉
 * 2. **磁盘是否接近满** —— 满了之后服务会以各种奇怪的方式失败
 * 3. **备份是否新鲜** —— 备份静默失败是最危险的：
 *    你以为有，实际没有，直到需要它的那一天
 * 4. **消息分区是否覆盖当前月份** —— 这是最隐蔽的一个：
 *    分区缺失时插入直接报错，而客户端采集是"尽力而为"、
 *    失败不报错，所以表现为**数据静默变空**
 *
 * 告警静默：同一问题 1 小时内只发一次，避免每 10 分钟骚扰一次。
 *
 * 用法：
 *   node scripts/alert.js            # 检查，异常则告警
 *   node scripts/alert.js --dry      # 只打印，不发邮件
 */

const fs = require('fs')
const path = require('path')
const http = require('http')
const { Pool } = require('pg')
const config = require('../server/config')
const { sendOpsAlert } = require('../server/lib/ops-alert')

const DRY = process.argv.includes('--dry')
const BACKUP_DIR = '/var/backups/hello-pix'
const BACKUP_MAX_AGE_HOURS = 26      // 每日备份，超过 26 小时说明昨天没跑成功
const DISK_MAX_PERCENT = 85
const SILENCE_HOURS = 1

/**
 * 充值异常告警阈值。
 *
 * ## 为什么要专门盯着这个
 *
 * 2026-10-21 审计发现：`recharge_exceptions` 里有 11 条 `open` 记录，
 * 最早的一条已经挂了 **28 天**，期间巡检每 10 分钟跑一次、每次都正常 ——
 * 因为它只检查服务/磁盘/备份/分区，**完全没看钱有没有进来**。
 *
 * 这批记录里只有 1 笔是真实订单的付款（65.138，金额抄错的笔误），
 * 其余是测试款与外部转账。**但系统当时无法区分这两类** ——
 * 在运维眼里它们长得一模一样。这才是要修的东西：
 * 让真实的钱能被认出来，让不相关的钱能被快速排除。
 *
 * 钱的问题不能靠"用户来投诉"发现。这里是最后一道主动防线。
 *
 * ## 两个阈值
 *
 * - `RECHARGE_OPEN_MAX`：未处理异常超过这个条数就告警
 * - `RECHARGE_OPEN_MAX_HOURS`：单条异常悬置超过这个小时数就告警
 *
 * 条数阈值抓「异常突然变多」（比如链上扫描坏了，一批进款全匹配不上）；
 * 时长阈值抓「异常一直没人管」（比如这次 28 天）。
 * 只用一个会漏：一条挂一个月，条数永远是 1，按条数永远不告警。
 */
const RECHARGE_OPEN_MAX = 3
const RECHARGE_OPEN_MAX_HOURS = 12
/** 单封告警邮件最多列多少条明细 —— 列太多会被当成噪音跳过 */
const RECHARGE_ALERT_SAMPLE = 10


const STATE_FILE = '/var/lib/hello-pix-alert-state.json'

// ---------------------------------------------------------------------------

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch (e) { return {} }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(state))
  } catch (e) { /* 状态存不下来不该让巡检本身失败 */ }
}

/** 同一问题 1 小时内不重复告警 —— 每 10 分钟一封会被无视 */
function shouldAlert(key, state) {
  const last = Number(state[key] || 0)
  return Date.now() - last > SILENCE_HOURS * 3600 * 1000
}

// ---------------------------------------------------------------------------

function checkService() {
  return new Promise(resolve => {
    const port = Number(process.env.PORT) || 3000
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 5000 }, res => {
      let body = ''
      res.on('data', c => body += c)
      res.on('end', () => resolve(
        res.statusCode === 200
          ? { ok: true }
          : { ok: false, detail: `HTTP ${res.statusCode}` }
      ))
    })
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, detail: '请求超时' }) })
    req.on('error', e => resolve({ ok: false, detail: e.message }))
  })
}

function checkDisk() {
  try {
    // statfs 是 Node 内置的，不必起 shell 去解析 df 输出
    const st = fs.statfsSync('/')
    const usedPercent = Math.round(((st.blocks - st.bfree) / st.blocks) * 100)
    return usedPercent > DISK_MAX_PERCENT
      ? { ok: false, detail: `磁盘已用 ${usedPercent}%（阈值 ${DISK_MAX_PERCENT}%）` }
      : { ok: true }
  } catch (e) {
    return { ok: true }   // 取不到就不告警，避免误报刷屏
  }
}

function checkBackup() {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^hello_pix-.*\.dump$/.test(f))
    if (!files.length) return { ok: false, detail: '备份目录里一个备份都没有' }
    let newest = 0
    for (const f of files) {
      const t = fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs
      if (t > newest) newest = t
    }
    const ageHours = (Date.now() - newest) / 3600000
    return ageHours > BACKUP_MAX_AGE_HOURS
      ? { ok: false, detail: `最新备份已是 ${ageHours.toFixed(1)} 小时前（阈值 ${BACKUP_MAX_AGE_HOURS}h）` }
      : { ok: true }
  } catch (e) {
    return { ok: false, detail: '备份目录不存在或不可读: ' + BACKUP_DIR }
  }
}

async function checkPartitions(pool) {
  const now = new Date()
  const name = `messages_${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}`
  const r = await pool.query(`SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'r'`, [name])
  if (!r.rows.length) {
    return { ok: false, detail: `缺少当月分区 ${name} —— 消息写入会直接失败且不报错` }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 充值异常
// ---------------------------------------------------------------------------

/**
 * 检查未处理的充值异常。
 *
 * ## 三个独立判据（任一成立就告警）
 *
 * 1. **条数**：`open` 太多 → 可能是扫描/匹配整体坏了
 * 2. **时长**：有条 `open` 挂了太久 → 有人在等钱，没人管
 * 3. **金额**：有「疑似订单」却没人工确认 → 系统已经指出可能是谁的钱了
 *
 * ## 为什么把「疑似」单列一条
 *
 * 普通 `NO_MATCH` 可能真是外部转账、测试款，运维看一眼就能忽略。
 * 但带 `suspicion` 的那种，系统已经算出「这笔像订单 HPxxx 的笔误」——
 * 它需要的是一个**决定**（认或不认），而不是一个**观察**。
 * 混在总数里会被稀释掉，所以单独拎出来。
 */
async function checkRechargeExceptions(pool) {
  const problems = []

  const { rows: summary } = await pool.query(
    `SELECT count(*)::int AS n,
            COALESCE(sum(amount_milli), 0)::text AS total_milli,
            COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at))) / 3600, 0)::float AS oldest_hours,
            count(*) FILTER (WHERE detail ? 'suspicion'
                              AND detail->'suspicion' <> 'null'::jsonb)::int AS suspicious_n
       FROM recharge_exceptions
      WHERE status = 'open'`
  )
  const s = summary[0] || { n: 0, total_milli: '0', oldest_hours: 0, suspicious_n: 0 }

  if (!Number(s.n)) return problems

  const totalUsdt = (Number(s.total_milli) / 1000).toFixed(3)
  const oldestHours = Number(s.oldest_hours) || 0

  // ① 条数
  if (Number(s.n) > RECHARGE_OPEN_MAX) {
    problems.push([
      '充值异常积压',
      `${s.n} 条未处理（阈值 ${RECHARGE_OPEN_MAX}），合计 ${totalUsdt} USDT`
    ])
  }

  // ② 时长
  if (oldestHours > RECHARGE_OPEN_MAX_HOURS) {
    problems.push([
      '充值异常长时间未处理',
      `最早一条已悬置 ${oldestHours.toFixed(1)} 小时（阈值 ${RECHARGE_OPEN_MAX_HOURS}h），`
      + `共 ${s.n} 条 / ${totalUsdt} USDT`
    ])
  }

  // ③ 疑似归属待确认
  if (Number(s.suspicious_n) > 0) {
    problems.push([
      '有到账疑似某张订单但未确认',
      `${s.suspicious_n} 条已识别出疑似归属，需人工核对（系统不会自动入账）`
    ])
  }

  // 明细。按金额降序 —— 金额大的先看，这是唯一合理的排序。
  const { rows: sample } = await pool.query(
    `SELECT id, kind, amount_milli, created_at, summary,
            detail->'suspicion' AS suspicion
       FROM recharge_exceptions
      WHERE status = 'open'
      ORDER BY amount_milli DESC, created_at ASC
      LIMIT $1`,
    [RECHARGE_ALERT_SAMPLE]
  )

  for (const row of sample) {
    const usdt = (Number(row.amount_milli) / 1000).toFixed(3)
    const hours = Math.max(0, Math.floor((Date.now() - new Date(row.created_at).getTime()) / 3600000))
    let line = `#${row.id} ${usdt} USDT · ${row.kind} · ${hours}h 前`
    if (row.suspicion) {
      const sus = typeof row.suspicion === 'string' ? JSON.parse(row.suspicion) : row.suspicion
      if (sus && sus.orderNumber) {
        line += ` · 疑似 ${sus.orderNumber}（${sus.reason || ''}）`
      }
    }
    problems.push(['　└ 异常明细', line])
  }

  if (Number(s.n) > RECHARGE_ALERT_SAMPLE) {
    problems.push(['　└ 异常明细', `…另有 ${Number(s.n) - RECHARGE_ALERT_SAMPLE} 条未列出`])
  }

  return problems
}


// ---------------------------------------------------------------------------

/**
 * 发告警。实现在 server/lib/ops-alert.js —— 抽出去是因为 ChainWatcher
 * 也要用同一套（凭据失效必须立刻告警），各写一份迟早分叉。
 *
 * 抽取时顺带修掉一个真 bug：这里原本读 `settings.mail.alertTo`（嵌套），
 * 而 repo.settings() 返回扁平键 `'mail.alertTo'` —— 收件人永远取不到，
 * 告警从来没发出去过。
 */
async function sendAlert(subject, lines) {
  // 不传 pool：调用点那个 pool 在告警之前就已经 end() 了。
  // 让共享模块自己建一个短连接，顺便避免"用到已关闭连接"这类隐蔽问题。
  return sendOpsAlert({
    subject,
    lines,
    source: require('os').hostname() + ' 的自动巡检'
  })
}

// ---------------------------------------------------------------------------

async function main() {
  const problems = []
  const svc = await checkService()
  if (!svc.ok) problems.push(['服务不可用', svc.detail])

  const disk = checkDisk()
  if (!disk.ok) problems.push(['磁盘空间告急', disk.detail])

  const backup = checkBackup()
  if (!backup.ok) problems.push(['备份异常', backup.detail])

  const pool = new Pool({
    connectionString: config.database.connectionString,
    ssl: config.database.ssl,
    max: 1,
    connectionTimeoutMillis: 5000
  })
  try {
    const part = await checkPartitions(pool)
    if (!part.ok) problems.push(['消息分区缺失', part.detail])

    // 充值异常。单独 try：一张表查不了不该让其余巡检也中断，
    // 但**必须计入问题** —— 静默跳过等于这次巡检又在"什么都很正常"。
    try {
      problems.push(...await checkRechargeExceptions(pool))
    } catch (e) {
      problems.push(['充值异常检查失败', String(e.message || e).slice(0, 120)])
    }
  } catch (e) {
    problems.push(['数据库不可连', String(e.message || e).slice(0, 120)])
  } finally {
    await pool.end().catch(() => {})
  }

  if (!problems.length) {
    console.log(`[${new Date().toISOString()}] 巡检正常`)
    return
  }

  const state = loadState()
  const fresh = problems.filter(([k]) => shouldAlert(k, state))
  for (const [k] of problems) console.log(`异常: ${k}`)

  if (!fresh.length) {
    console.log('（同一问题 1 小时内已告警过，本次静默）')
    return
  }
  for (const [k] of fresh) state[k] = Date.now()
  saveState(state)

  const lines = fresh.map(([k, d]) => `<b>${k}</b>：${d}`)
  if (DRY) {
    console.log('（--dry 模式，不发邮件）\n' + lines.join('\n'))
    return
  }
  try {
    await sendAlert('【Hello Pix 告警】' + fresh.map(p => p[0]).join(' / '), lines)
    console.log('告警邮件已发送')
  } catch (e) {
    // 邮件发不出去也要留下痕迹 —— 这是最后一道防线
    console.error('告警邮件发送失败:', e.message)
    process.exit(1)
  }
}

// 直接执行时才跑巡检；被测试 import 时只暴露函数。
// require.main === module 在 `node scripts/alert.js` 与 systemd 环境下都成立。
if (require.main === module) {
  main().catch(e => { console.error('巡检异常:', e.message); process.exit(1) })
}

module.exports = {
  checkRechargeExceptions,
  RECHARGE_OPEN_MAX,
  RECHARGE_OPEN_MAX_HOURS,
  RECHARGE_ALERT_SAMPLE
}
