'use strict'

/**
 * 全盘审计扫描器 v2。
 *
 * v1 的教训：按单行正则匹配，误报一片。`try{...}catch(e){return {ok:false}}` 后面
 * 跟 `return {ok:true}` 明明是正确写法，被当成"失败伪装成功"；`socket.destroy()`
 * 包在 try 里根本不可能抛，也被当成吞异常。
 *
 * v2 原则：**先圈出"危险上下文"，再在里面找问题**。
 *   - 空 catch 只有在上下文涉及资金/权限/持久化，且包的不是幂等的清理调用时才算问题
 *   - 失败当成功要看 catch 块的实际返回值，不是看下一个 return
 *   - shell 拼接只算"用户可达输入"，scripts/ 里的 pid 不算
 *
 * 用法：node scripts/audit.js [--json] [--kind=xxx]
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'release', 'vendor',
  '.stage', '.cache', 'coverage', '1.1.0-验收包'
])
const PRODUCTION_DIRS = ['server', 'desktop', 'standalone', 'src', 'mock', 'migrations']

function walk(dir, out) {
  let entries
  try { entries = fs.readdirSync(dir) } catch (e) { return }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    let stat
    try { stat = fs.statSync(full) } catch (e) { continue }
    if (stat.isDirectory()) walk(full, out)
    else if (/\.(js|vue)$/.test(name)) out.push(full)
  }
  return out
}

const files = []
for (const d of PRODUCTION_DIRS) walk(path.join(ROOT, d), files)

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

const findings = []
function report(kind, severity, file, line, message, snippet) {
  findings.push({
    kind, severity,
    file: path.relative(ROOT, file),
    line,
    message,
    snippet: (snippet || '').trim().replace(/\s+/g, ' ').slice(0, 180)
  })
}

/** 幂等的清理调用：这些包在 try/catch 里吞异常是对的，不该报。 */
const IDEMPOTENT_CLEANUP = new RegExp([
  'socket\\.destroy', 'clearCache', 'clearStorageData', 'clearAuthCache',
  'removeAllListeners', 'removeListener', '\\.off\\(', 'close\\(\\)', 'unref\\(\\)',
  'kill\\(', 'disconnect', 'removeView', 'destroy\\(\\)', 'abort\\(\\)',
  'JSON\\.parse', 'JSON\\.stringify', 'console\\.(error|warn|log)',
  'process\\.exit', 'fs\\.unlink', 'fs\\.rm', 'unlinkSync', 'rmSync',
  'setTimeout', 'cancelAnimationFrame'
].join('|'))

/** 资金/权限/持久化的上下文关键词。 */
const SENSITIVE = /(recharge|settle|payment|billing|balance|credit|deduct|refund|amount|ledger|order|cookieJar|cookie|session|auth|permission|role|token|persist|flushSync|writeFile|transaction|commit|rollback)/i

// ─────────────────────────────────────────────────────────────
// 1. 敏感路径吞异常（上下文感知）
// ─────────────────────────────────────────────────────────────
for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split('\n')
  const code = stripComments(raw).split('\n')
  const base = path.basename(file)
  const fileSensitive = /(recharge|settle|payment|billing|balance|auth|account|session|redis|store|db)/i.test(base)

  code.forEach((line, i) => {
    const m = line.match(/catch\s*(?:\([^)]*\))?\s*\{\s*\}\s*$/)
    if (!m) return

    // 取出 try 块的起始行（向上找 8 行内的 try）
    let tryStart = -1
    for (let j = i; j >= Math.max(0, i - 12); j--) {
      if (/\btry\s*\{/.test(code[j])) { tryStart = j; break }
    }
    const tryBody = tryStart >= 0 ? code.slice(tryStart, i + 1).join(' ') : line

    // 幂等清理，吞异常是对的
    if (IDEMPOTENT_CLEANUP.test(tryBody)) return

    // 上下文不敏感，且文件本身不敏感 → 不报
    const ctx = lines.slice(Math.max(0, i - 15), i + 3).join(' ')
    if (!SENSITIVE.test(ctx) && !fileSensitive) return

    report('silent-catch', 'high', file, i + 1,
      '敏感路径吞掉异常，失败无痕', lines.slice(Math.max(tryStart, i - 2), i + 1).join(' '))
  })
}

// ─────────────────────────────────────────────────────────────
// 2. 失败当成功：catch 块里真的返回了成功形状
// ─────────────────────────────────────────────────────────────
for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split('\n')
  const code = stripComments(raw).split('\n')

  code.forEach((line, i) => {
    const m = line.match(/catch\s*(?:\([^)]*\))?\s*\{/)
    if (!m) return
    // 从 catch 的 { 开始做括号配对，取出整个 catch 块
    let depth = 0
    let body = ''
    let started = false
    for (let j = i; j < Math.min(code.length, i + 60); j++) {
      const chunk = code[j]
      for (const ch of chunk) {
        if (ch === '{') { depth++; started = true }
        else if (ch === '}') depth--
      }
      body += ' ' + chunk
      if (started && depth === 0) break
    }
    if (/\breturn\s*\{\s*(success|ok)\s*:\s*true/.test(body) ||
        /\bcallback\s*\(\s*null/.test(body) ||
        /resolve\s*\(\s*true\s*\)/.test(body)) {
      report('failure-as-success', 'high', file, i + 1,
        'catch 块内返回成功，失败被伪装', body.slice(0, 160))
    }
  })
}

// ─────────────────────────────────────────────────────────────
// 3. 资金 UPDATE 缺事务/锁（只查 repositories + services）
// ─────────────────────────────────────────────────────────────
const MONEY_TABLE = /(balance|credit|amount|ledger|recharge|settle|deduct|refund|chars|quota|wallet)/i

for (const file of files) {
  if (!/\.js$/.test(file)) continue
  if (!/(repositories|services)[/\\]/.test(file)) continue
  const code = stripComments(fs.readFileSync(file, 'utf8'))
  const updates = [...code.matchAll(/UPDATE\s+(\w+)\s+SET([\s\S]{0,400}?)(?:WHERE|RETURNING)/gi)]
  const sensitive = updates.filter(u => MONEY_TABLE.test(u[1]))
  if (!sensitive.length) continue

  const hasTx = /\b(BEGIN|withTransaction|client\.query\('BEGIN)/.test(code)
  const hasForUpdate = /FOR\s+UPDATE/i.test(code)
  const hasAtomic = /SET[\s\S]{0,300}?=\s*[\w.]+\s*[-+]\s*\$/i.test(code) || /ON\s+CONFLICT/i.test(code)
  if (hasTx || hasForUpdate || hasAtomic) continue

  const first = sensitive[0]
  const lineNo = code.slice(0, code.indexOf(first[0])).split('\n').length
  report('money-update-no-lock', 'high', file, lineNo,
    'UPDATE ' + first[1] + ' 但没有事务/行锁/原子表达式', first[0])
}

// ─────────────────────────────────────────────────────────────
// 4. 心跳/健康检查里的静默失败
// ─────────────────────────────────────────────────────────────
for (const file of files) {
  if (!/health|guard|watchdog|heartbeat/i.test(file)) continue
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const code = stripComments(fs.readFileSync(file, 'utf8')).split('\n')
  code.forEach((line, i) => {
    // 健康检查返回 true 但前面有 catch
    if (/\breturn\s+true\b/.test(line)) {
      const ctx = code.slice(Math.max(0, i - 4), i + 1).join(' ')
      if (/catch\s*\(/.test(ctx) && !/process\.exit/.test(ctx)) {
        report('health-false-ok', 'high', file, i + 1,
          '健康检查在 catch 路径上仍返回 true', lines.slice(Math.max(0, i - 2), i + 1).join(' '))
      }
    }
  })
}

// ─────────────────────────────────────────────────────────────
// 5. 用户可达输入进 shell / 文件路径
// ─────────────────────────────────────────────────────────────
const USER_REACHABLE = /\b(req\.|ctx\.|payload\.|params\.|body\.|query\.|args\.|input\.|message\.|data\.)/
for (const file of files) {
  if (/[/\\]scripts[/\\]/.test(file)) continue   // 构建脚本，输入来自本地 pid，不算
  const code = stripComments(fs.readFileSync(file, 'utf8')).split('\n')
  code.forEach((line, i) => {
    if (/(spawn|exec|execSync)\s*\(/.test(line) && (USER_REACHABLE.test(line) || /\$\{\s*(req|ctx|payload|body|query)/.test(line))) {
      report('shell-injection', 'high', file, i + 1, 'shell 调用拼接用户输入', line)
    }
    if (/path\.(join|resolve)\(/.test(line) && USER_REACHABLE.test(line) &&
        !/(sanitize|safeJoin|basename|normalize)/.test(line)) {
      report('path-traversal', 'medium', file, i + 1, '文件路径拼接用户输入，需确认已收敛到根目录内', line)
    }
  })
}

// ─────────────────────────────────────────────────────────────
// 6. 定时器泄漏（运行时文件，不是一次性脚本）
// ─────────────────────────────────────────────────────────────
for (const file of files) {
  const rel = path.relative(ROOT, file)
  if (/[/\\](scripts|bench|probe|verify|capture)[/\\-]/.test(rel)) continue
  const code = stripComments(fs.readFileSync(file, 'utf8'))
  const set = (code.match(/setInterval\s*\(/g) || []).length
  const clr = (code.match(/clearInterval\s*\(/g) || []).length
  // 单次性诊断/守护定时器，只要 unref 过就不会把进程钉住。
  // 不认这个写法的话，每处长期运行的采样器都会报假阳性，
  // 报多了就没人看这条规则了 —— 那才是真的隐患。
  const unref = (code.match(/\.unref\s*\(\s*\)/g) || []).length
  if (set > clr + unref) {
    report('timer-leak', 'medium', file, 0,
      'setInterval ' + set + ' 处 / clearInterval ' + clr + ' 处 / unref ' + unref + ' 处')
  }
}

// ─────────────────────────────────────────────────────────────
// 7. 硬编码凭据
// ─────────────────────────────────────────────────────────────
for (const file of files) {
  if (/migrations|mock/.test(file)) continue
  const code = stripComments(fs.readFileSync(file, 'utf8')).split('\n')
  code.forEach((line, i) => {
    const m = line.match(/(password|secret|api[_-]?key|token|private[_-]?key)\s*[:=]\s*['"]([^'"]{12,})['"]/i)
    if (!m) return
    if (/process\.env|example|placeholder|test|fake|dummy|WRONG_|EXPECTED_|_[A-Z_]+:|reason/i.test(line)) return
    report('hardcoded-secret', 'high', file, i + 1, '硬编码 ' + m[1] + ' 字面量', line)
  })
}

// ─────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────
const filterKind = (process.argv.find(a => a.startsWith('--kind=')) || '').split('=')[1]
const shown = filterKind ? findings.filter(f => f.kind === filterKind) : findings

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(shown, null, 2))
  process.exit(0)
}

const bySev = { high: [], medium: [], low: [] }
for (const f of shown) (bySev[f.severity] || bySev.low).push(f)

console.log('扫了 ' + files.length + ' 个生产文件（test/scripts/deploy 不计）\n')
for (const sev of ['high', 'medium']) {
  const list = bySev[sev]
  if (!list.length) continue
  console.log('══ ' + sev.toUpperCase() + ' (' + list.length + ') ══')
  const byKind = {}
  for (const f of list) (byKind[f.kind] = byKind[f.kind] || []).push(f)
  for (const [kind, items] of Object.entries(byKind)) {
    console.log('\n  · ' + kind + '  ×' + items.length)
    items.forEach(it => {
      console.log('      ' + it.file + (it.line ? ':' + it.line : ''))
      if (it.snippet) console.log('        ' + it.snippet)
    })
  }
  console.log('')
}
console.log('合计: high ' + bySev.high.length + ' · medium ' + bySev.medium.length)
