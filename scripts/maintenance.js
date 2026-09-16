/**
 * 运营维护任务。设计成可重复执行（幂等），由 cron 每天跑一次。
 *
 * 做三件事：
 *
 * 1. **提前建好消息分区**
 *    messages 按月分区。建表时只建了两个月，之后没人建新的 ——
 *    实测确认：往没有分区的月份插入会直接报
 *      `no partition of relation "messages" found for row`
 *    而采集是"尽力而为"、失败不报错，所以那天会**静默失效**：
 *    消息不落库、客户身份不识别、撞单不检测，直到有人发现数据是空的。
 *    这里提前 3 个月建好，留足缓冲。
 *
 * 2. **按留存期清理过期分区**
 *    用 DROP 整个分区，而不是 DELETE 行 —— 快几个数量级，
 *    也不会因为一个大事务把库拖住。
 *
 * 3. **顺带报告当前状态**，方便人工核对。
 *
 * 用法：
 *   node scripts/maintenance.js            # 干跑，只报告不修改
 *   node scripts/maintenance.js --apply    # 真执行
 */

const path = require('path')
const { Pool } = require('pg')
const config = require('../server/config')

const APPLY = process.argv.includes('--apply')
const AHEAD_MONTHS = 3

// config.database 是 { connectionString, ssl, max, ... } ——
// 直接把它的连接参数摊进来，与主服务用同一套配置，
// 免得脚本连上了而服务连不上（或反过来）。
const pool = new Pool({
  connectionString: config.database.connectionString,
  ssl: config.database.ssl,
  max: 1,
  connectionTimeoutMillis: config.database.connectionTimeoutMillis
})

/** 分区名：messages_2026_11 */
function partitionName(year, month) {
  return `messages_${year}_${String(month).padStart(2, '0')}`
}

/** 某月边界的 ISO 日期串，交给 SQL 当字面量 —— 不拼用户输入，无注入面 */
function bounds(year, month) {
  const from = `${year}-${String(month).padStart(2, '0')}-01`
  const nextY = month === 12 ? year + 1 : year
  const nextM = month === 12 ? 1 : month + 1
  const to = `${nextY}-${String(nextM).padStart(2, '0')}-01`
  return { from, to }
}

function monthKey(d) {
  return d.getFullYear() * 12 + d.getMonth()
}

async function readRetentionDays(client) {
  const r = await client.query(
    `SELECT value FROM app_settings WHERE key = 'customer.message_retention_days'`)
  const n = Number(r.rows[0] && r.rows[0].value)
  // 兜底 180 天：设置缺失或非法时不能变成"永不过期"，
  // 否则消息会无限堆积，磁盘迟早满
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 180
}

async function ensurePartitions(client) {
  const now = new Date()
  const created = []
  // 从**上个月**开始建：月初那几天如果任务没跑成功，
  // 上个月的分区仍需存在（否则跨月那批消息会插不进去）
  for (let i = -1; i <= AHEAD_MONTHS; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    const name = partitionName(d.getFullYear(), d.getMonth() + 1)
    const { from, to } = bounds(d.getFullYear(), d.getMonth() + 1)

    const exists = await client.query(
      `SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'r'`, [name])
    if (exists.rows.length) continue

    created.push(name)
    if (APPLY) {
      // IF NOT EXISTS 兜底：两个进程同时跑也不会互相打断
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF messages
         FOR VALUES FROM ('${from}') TO ('${to}')`)
    }
  }
  return created
}

async function dropExpired(client, retentionDays) {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retentionDays)
  const cutoffKey = monthKey(cutoff)

  const rows = await client.query(
    `SELECT relname FROM pg_class
     WHERE relname ~ '^messages_[0-9]{4}_[0-9]{2}$' AND relkind = 'r'`)

  const dropped = []
  for (const row of rows.rows) {
    const m = row.relname.match(/^messages_(\d{4})_(\d{2})$/)
    const key = Number(m[1]) * 12 + (Number(m[2]) - 1)
    // 整个月都在留存期之外才丢 —— 按月粒度，不做月中切割
    if (key >= cutoffKey) continue
    dropped.push(row.relname)
    if (APPLY) await client.query(`DROP TABLE IF EXISTS ${row.relname}`)
  }
  return dropped
}

async function messageStats(client) {
  const r = await client.query(`SELECT count(*)::bigint AS n FROM messages`)
  const size = await client.query(
    `SELECT pg_size_pretty(pg_total_relation_size('messages')) AS s`)
  return { count: r.rows[0].n, size: size.rows[0].s }
}

async function main() {
  const label = APPLY ? '执行' : '干跑'
  console.log(`\n=== 运营维护（${label}）===`)

  const client = await pool.connect()
  try {
    const retention = await readRetentionDays(client)
    console.log(`  留存策略: ${retention} 天`)

    const created = await ensurePartitions(client)
    console.log(created.length
      ? `  ${APPLY ? '已建' : '待建'}分区: ${created.join(', ')}`
      : '  分区齐全，无需新建')

    const dropped = await dropExpired(client, retention)
    console.log(dropped.length
      ? `  ${APPLY ? '已删' : '待删'}过期分区: ${dropped.join(', ')}`
      : '  无过期分区')

    const stats = await messageStats(client)
    console.log(`  消息表: ${stats.count} 行 / ${stats.size}`)

    if (!APPLY) console.log('\n  （干跑模式，未做任何改动。加 --apply 才真正执行）')
    console.log('')
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(err => {
  // 退出码非 0，让 cron 与告警能感知失败
  console.error('维护任务失败:', err && err.message ? err.message : err)
  process.exit(1)
})
