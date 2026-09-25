'use strict'

/**
 * RC-03 服务端实时核对。
 *
 * 你在 Windows 上划词翻译，我在这边核对服务端到底发生了什么 ——
 * 这是「真实扣费证据」的来源：客户端说翻译成功不算数，
 * `translate_logs` 里有没有那一行、余额有没有真的减、有没有重复扣，
 * 只有数据库能证明。
 *
 * 用法（在生产机上跑）：
 *
 *   node deploy/rc03-server-watch.js baseline          # 记录基线
 *   node deploy/rc03-server-watch.js diff              # 与基线对比
 *   node deploy/rc03-server-watch.js live              # 持续打印新事件
 *   node deploy/rc03-server-watch.js who <商户名>      # 看某商户的全部证据
 */

const fs = require('node:fs')
const path = require('node:path')

const APP = process.env.APP_DIR || '/opt/hello-pix'
const BASELINE = '/tmp/rc03-baseline.json'

const env = Object.fromEntries(
  fs.readFileSync('/etc/hello-pix/hello-pix.env', 'utf8')
    .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const { Client } = require(path.join(APP, 'node_modules/pg'))
const db = new Client({ connectionString: env.DATABASE_URL })

const line = (n = 70) => console.log('─'.repeat(n))

function fmtTime(v) {
  if (!v) return '-'
  const d = new Date(v)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 全量快照 —— 用来做前后对比 */
async function snapshot() {
  const totals = (await db.query(`
    SELECT (SELECT count(*) FROM translate_logs)                       AS logs,
           (SELECT coalesce(sum(chars),0) FROM translate_logs)         AS chars,
           (SELECT count(*) FROM char_ledger)                          AS ledger,
           (SELECT count(*) FROM messages)                             AS messages,
           (SELECT count(*) FROM translation_reservations)             AS reservations,
           (SELECT count(*) FROM customers)                            AS customers,
           (SELECT count(*) FROM conversations)                        AS conversations,
           (SELECT coalesce(sum(char_balance),0) FROM users)           AS balance,
           (SELECT coalesce(sum(char_used),0)    FROM users)           AS used,
           (SELECT coalesce(sum(translate_count),0) FROM users)        AS tcount
  `)).rows[0]

  const users = (await db.query(`
    SELECT u.id, u.username, u.char_balance, u.char_used, u.translate_count,
           p.title AS package_title
      FROM users u LEFT JOIN packages p ON p.id = u.package_id
     ORDER BY u.id
  `)).rows

  return { at: new Date().toISOString(), totals, users }
}

function showTotals(t) {
  console.log(`  translate_logs 条数      ${t.logs}`)
  console.log(`  translate_logs 字符合计  ${t.chars}`)
  console.log(`  char_ledger 条数         ${t.ledger}`)
  console.log(`  messages 条数            ${t.messages}`)
  console.log(`  translation_reservations ${t.reservations}`)
  console.log(`  客户数 customers         ${t.customers}`)
  console.log(`  会话数 conversations     ${t.conversations}`)
  console.log(`  商户余额合计             ${t.balance}`)
  console.log(`  已用字符合计             ${t.used}`)
  console.log(`  翻译次数合计             ${t.tcount}`)
}

async function cmdBaseline() {
  const snap = await snapshot()
  fs.writeFileSync(BASELINE, JSON.stringify(snap, null, 2))
  line()
  console.log(`  RC-03 基线已记录  ${snap.at}`)
  line()
  showTotals(snap.totals)
  line()
  console.log('  商户明细：')
  for (const u of snap.users) {
    console.log(`    #${u.id} ${u.username}  套餐=${u.package_title}  余额=${u.char_balance}  已用=${u.char_used}  次数=${u.translate_count}`)
  }
  line()
  console.log(`  已写入 ${BASELINE}`)
}

async function cmdDiff() {
  if (!fs.existsSync(BASELINE)) {
    console.log('  还没有基线，先跑： node deploy/rc03-server-watch.js baseline')
    return
  }
  const before = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  const after = await snapshot()

  line()
  console.log(`  基线 ${fmtTime(before.at)}  →  现在 ${fmtTime(after.at)}`)
  line()
  const keys = [
    ['logs', 'translate_logs 条数'],
    ['chars', 'translate_logs 字符合计'],
    ['ledger', 'char_ledger 条数'],
    ['messages', 'messages 条数'],
    ['reservations', 'translation_reservations'],
    ['customers', '客户数'],
    ['conversations', '会话数'],
    ['balance', '商户余额合计'],
    ['used', '已用字符合计'],
    ['tcount', '翻译次数合计']
  ]
  for (const [k, label] of keys) {
    const b = Number(before.totals[k])
    const a = Number(after.totals[k])
    const d = a - b
    const mark = d === 0 ? '  ' : (d > 0 ? '↑ ' : '↓ ')
    console.log(`  ${label.padEnd(26)} ${String(b).padStart(8)} → ${String(a).padStart(8)}   ${mark}${d > 0 ? '+' : ''}${d}`)
  }

  line()
  console.log('  商户明细变化：')
  const beforeById = Object.fromEntries(before.users.map(u => [String(u.id), u]))
  let changed = 0
  for (const u of after.users) {
    const b = beforeById[String(u.id)]
    if (!b) { console.log(`    + 新增商户 #${u.id} ${u.username}`); changed++; continue }
    const db_ = Number(u.char_balance) - Number(b.char_balance)
    const du = Number(u.char_used) - Number(b.char_used)
    const dc = Number(u.translate_count) - Number(b.translate_count)
    if (db_ || du || dc) {
      changed++
      console.log(`    #${u.id} ${u.username}`)
      console.log(`        余额  ${b.char_balance} → ${u.char_balance}   (${db_ > 0 ? '+' : ''}${db_})`)
      console.log(`        已用  ${b.char_used} → ${u.char_used}   (+${du})`)
      console.log(`        次数  ${b.translate_count} → ${u.translate_count}   (+${dc})`)
    }
  }
  if (!changed) console.log('    (没有任何商户的余额/用量发生变化)')

  // 这段时间新增的翻译流水 —— 这就是「真实扣费证据」
  line()
  console.log('  基线之后新增的 translate_logs：')
  const rows = (await db.query(`
    SELECT t.id, t.user_id, u.username, t.engine_id, t.source_language, t.target_language,
           t.chars, t.cached, t.duration_ms, t.reservation_id, t.created_at,
           left(t.snippet, 46) AS snippet
      FROM translate_logs t LEFT JOIN users u ON u.id = t.user_id
     WHERE t.created_at > $1
     ORDER BY t.id`, [before.at])).rows
  if (!rows.length) {
    console.log('    (没有新增流水)')
  } else {
    console.log(`    共 ${rows.length} 条`)
    for (const r of rows) {
      console.log(`    #${r.id} ${fmtTime(r.created_at)} ${r.username || r.user_id} ` +
        `${r.engine_id} ${r.source_language}→${r.target_language} chars=${r.chars} ` +
        `cached=${r.cached} ${r.duration_ms}ms res=${r.reservation_id}`)
      console.log(`         「${r.snippet}」`)
    }
  }

  // 重复扣费检测：同 reservation 出现多行 = 严重问题
  line()
  console.log('  重复扣费检测（同一 reservation 出现多行即为异常）：')
  const dup = (await db.query(`
    SELECT reservation_id, count(*) AS n
      FROM translate_logs
     WHERE created_at > $1 AND reservation_id IS NOT NULL
     GROUP BY reservation_id HAVING count(*) > 1`, [before.at])).rows
  console.log(dup.length ? `    ✗ 发现 ${dup.length} 组重复！${JSON.stringify(dup)}` : '    ✓ 无重复')

  // 预留表里有没有卡住的
  const stuck = (await db.query(
    `SELECT count(*)::int AS n FROM translation_reservations WHERE status='reserved'`)).rows[0].n
  console.log(`  仍处于 reserved 的预留： ${stuck}   ${stuck ? '(可能有请求没走完)' : '✓'}`)

  line()
  console.log('  新增的 messages（客户消息落库）：')
  const msgs = (await db.query(`
    SELECT id, user_id, direction, source_platform, source_account,
           left(body, 40) AS body, sent_at
      FROM messages WHERE ingested_at > $1 ORDER BY id`, [before.at])).rows
  console.log(msgs.length ? `    共 ${msgs.length} 条` : '    (没有新增)')
  for (const m of msgs) {
    console.log(`    #${m.id} ${fmtTime(m.sent_at)} ${m.direction} ${m.source_platform}/${m.source_account} 「${m.body}」`)
  }
  line()
}

async function cmdLive() {
  const since = new Date()
  console.log(`  实时监听中（从 ${fmtTime(since)} 开始），Ctrl+C 退出`)
  let lastLog = 0
  let lastMsg = 0
  for (;;) {
    const logs = (await db.query(`
      SELECT t.id, u.username, t.engine_id, t.source_language, t.target_language,
             t.chars, t.cached, t.duration_ms, t.created_at, left(t.snippet,40) AS snippet
        FROM translate_logs t LEFT JOIN users u ON u.id=t.user_id
       WHERE t.id > $1 ORDER BY t.id`, [lastLog])).rows
    for (const r of logs) {
      lastLog = Math.max(lastLog, Number(r.id))
      console.log(`  [翻译] ${fmtTime(r.created_at)} ${r.username} ${r.engine_id} ` +
        `${r.source_language}→${r.target_language} chars=${r.chars} cached=${r.cached} ` +
        `${r.duration_ms}ms 「${r.snippet}」`)
    }
    const msgs = (await db.query(`
      SELECT id, user_id, direction, source_platform, left(body,36) AS body, sent_at
        FROM messages WHERE id > $1 ORDER BY id`, [lastMsg])).rows
    for (const m of msgs) {
      lastMsg = Math.max(lastMsg, Number(m.id))
      console.log(`  [消息] ${fmtTime(m.sent_at)} ${m.direction} ${m.source_platform} 「${m.body}」`)
    }
    const bal = (await db.query(
      `SELECT username, char_balance, char_used, translate_count FROM users ORDER BY id`)).rows
    process.stdout.write('\r  余额: ' + bal.map(b => `${b.username}=${b.char_balance}`).join('  ').slice(0, 150) + '   ')
    await new Promise(r => setTimeout(r, 2000))
  }
}

async function cmdWho(username) {
  const u = (await db.query(
    `SELECT u.*, p.title AS package_title FROM users u
      LEFT JOIN packages p ON p.id=u.package_id WHERE u.username=$1`, [username])).rows[0]
  if (!u) { console.log(`  没有商户 ${username}`); return }

  line()
  console.log(`  商户 ${u.username}  #${u.id}  套餐=${u.package_title}`)
  line()
  console.log(`  字符余额   ${u.char_balance}`)
  console.log(`  已用字符   ${u.char_used}`)
  console.log(`  翻译次数   ${u.translate_count}`)
  console.log(`  当前通道   ${u.active_engine_id || '(未设置，走套餐默认)'}`)

  line()
  console.log('  翻译流水（最近 30 条）：')
  const logs = (await db.query(`
    SELECT id, engine_id, source_language, target_language, chars, cached,
           duration_ms, created_at, left(snippet,50) AS snippet
      FROM translate_logs WHERE user_id=$1 ORDER BY id DESC LIMIT 30`, [u.id])).rows
  if (!logs.length) console.log('    (没有流水)')
  for (const r of logs) {
    console.log(`    #${r.id} ${fmtTime(r.created_at)} ${r.engine_id} ` +
      `${r.source_language}→${r.target_language} chars=${r.chars} cached=${r.cached} ${r.duration_ms}ms`)
    console.log(`        「${r.snippet}」`)
  }

  line()
  console.log('  消息落库（最近 20 条）：')
  const msgs = (await db.query(`
    SELECT id, direction, source_platform, source_account, left(body,44) AS body,
           left(coalesce(body_translated,''),30) AS translated, sent_at
      FROM messages WHERE user_id=$1 ORDER BY id DESC LIMIT 20`, [u.id])).rows
  if (!msgs.length) console.log('    (没有消息)')
  for (const m of msgs) {
    console.log(`    #${m.id} ${fmtTime(m.sent_at)} ${m.direction} ${m.source_platform}/${m.source_account}`)
    console.log(`        原文「${m.body}」  译文「${m.translated}」`)
  }

  // 客户身份是两层模型：
  //   customers          全局实体，按 primary_fingerprint 唯一（跨商户同一个"人"）
  //   conversations      按商户的会话，带 platform / account_key / peer_key
  //   customer_identities 指纹 → 客户 的映射
  // 所以这里从 conversations 查"这个商户见过哪些客户"。
  line()
  console.log('  会话与客户身份线索：')
  const cs = (await db.query(`
    SELECT c.id, c.platform, c.account_key, c.peer_key, c.display_name,
           c.customer_id, c.last_message_at,
           cu.public_id, cu.primary_fingerprint
      FROM conversations c
      LEFT JOIN customers cu ON cu.id = c.customer_id
     WHERE c.user_id=$1 ORDER BY c.id DESC LIMIT 15`, [u.id])).rows
  if (!cs.length) console.log('    (没有会话 —— 客户端还没上报过线索)')
  for (const c of cs) {
    console.log(`    #${c.id} ${c.platform} account=${c.account_key || '-'} peer=${c.peer_key || '-'}`)
    console.log(`        客户=${c.public_id || '-'} 指纹=${(c.primary_fingerprint || '-').slice(0, 24)} ` +
      `显示名=${c.display_name || '-'} 最近=${fmtTime(c.last_message_at)}`)
  }

  line()
  console.log('  归属关系 customer_owners：')
  const own = (await db.query(`
    SELECT id, customer_id, employee_id, account_key, status,
           assigned_at, last_activity_at
      FROM customer_owners WHERE user_id=$1 ORDER BY id DESC LIMIT 15`, [u.id])).rows
  if (!own.length) console.log('    (没有归属记录)')
  for (const o of own) {
    console.log(`    #${o.id} 客户=${o.customer_id} 员工=${o.employee_id || '(主账号)'} ` +
      `账号=${o.account_key || '-'} 状态=${o.status} 分配=${fmtTime(o.assigned_at)} 活跃=${fmtTime(o.last_activity_at)}`)
  }

  line()
  console.log('  套餐可用引擎（★=未接通，选中会 503）：')
  const eng = (await db.query(`
    SELECT e.id, e.name, e.enabled, e.wired
      FROM package_engines pe JOIN engines e ON e.id=pe.engine_id
     WHERE pe.package_id=$1 ORDER BY e.id`, [u.package_id])).rows
  if (!eng.length) console.log('    (套餐没有绑定任何引擎 —— 该商户无法翻译)')
  for (const e of eng) {
    console.log(`    ${e.wired ? '✓' : '★'} ${e.id.padEnd(10)} ${e.name}  enabled=${e.enabled} wired=${e.wired}`)
  }
  line()
}

const cmd = process.argv[2] || 'diff'
const arg = process.argv[3]

db.connect()
  .then(() => {
    if (cmd === 'baseline') return cmdBaseline()
    if (cmd === 'diff') return cmdDiff()
    if (cmd === 'live') return cmdLive()
    if (cmd === 'who') return cmdWho(arg)
    console.log('用法: node deploy/rc03-server-watch.js [baseline|diff|live|who <商户名>]')
  })
  .then(() => { if (cmd !== 'live') return db.end() })
  .catch(e => { console.error('异常:', (e && e.stack) || e); process.exitCode = 1; db.end() })
