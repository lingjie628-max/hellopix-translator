'use strict'

/**
 * 全仓悬空标识符扫描的 CLI 入口。
 *
 * 用法：
 *   node scripts/scan-dangling.js            # 扫默认目录
 *   node scripts/scan-dangling.js server/    # 只扫指定目录
 *   node scripts/scan-dangling.js --quiet    # 只输出汇总，非零退出码表示有问题
 *
 * 退出码：0 = 干净，1 = 有悬空引用，2 = 有文件解析失败。
 * 这样能直接挂进 CI / pre-commit，不用人肉看输出。
 */

const fs = require('fs')
const path = require('path')
const { findDanglingIdentifiers, findDanglingIdentifiersInSet } = require('./scan-dangling-lib')

const ROOT = path.join(__dirname, '..')
const DEFAULT_DIRS = ['server', 'scripts', 'src', 'desktop', 'migrations']
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'release', 'coverage',
  '.tmp-audit', 'out', 'test-results',
  // 第三方/打包产物：压缩过的代码本来就依赖运行时环境，
  // 扫它只会刷出几千条 DOM/浏览器全局误报，把真问题埋掉。
  'vendor', 'assets', 'static'
])

/**
 * 共享全局词法作用域的文件组。
 *
 * `desktop/renderer/` 的十几个 .js 是用 <script src> 平铺加载的，
 * 不是模块 —— 顶层 const 在同一个全局环境里互相可见。
 * 按单文件扫会报出 900+ 条假阳性，必须整组一起扫。
 */
const SHARED_SCOPES = [
  { name: 'desktop/renderer', dir: 'desktop/renderer', ext: /\.js$/ }
]

const args = process.argv.slice(2)
const quiet = args.includes('--quiet')
const targets = args.filter(a => !a.startsWith('--'))
const dirs = targets.length ? targets : DEFAULT_DIRS

const absDirs = dirs.map(d => (path.isAbsolute(d) ? d : path.join(ROOT, d)))

/** 某个文件是否属于共享作用域组 */
function sharedGroupFor(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/')
  return SHARED_SCOPES.find(g => rel.startsWith(g.dir + '/') && g.ext.test(rel)) || null
}

/** 收集文件，跳过共享组内部的文件（它们单独处理） */
const files = []
const sharedFiles = new Map()   // group.name -> [file]

function walk(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(p)
    } else if (/\.(js|cjs|mjs)$/.test(entry.name)) {
      const group = sharedGroupFor(p)
      if (group) {
        if (!sharedFiles.has(group.name)) sharedFiles.set(group.name, [])
        sharedFiles.get(group.name).push(p)
      } else {
        files.push(p)
      }
    }
  }
}
for (const d of absDirs) walk(d)

let danglingCount = 0
let parseFailures = 0
const report = []

const rel = f => path.relative(ROOT, f)

// ---- 单文件扫描 ----
for (const file of files.sort()) {
  let src
  try {
    src = fs.readFileSync(file, 'utf8')
  } catch (e) {
    continue
  }
  try {
    const hits = findDanglingIdentifiers(src, file)
    if (hits.length) {
      danglingCount += hits.length
      report.push({ file, hits })
    }
  } catch (err) {
    parseFailures++
    report.push({ file, parseError: err.message })
  }
}

// ---- 共享作用域组扫描 ----
for (const [name, list] of sharedFiles) {
  const inputs = list.sort().map(f => ({ filename: f, source: fs.readFileSync(f, 'utf8') }))
  try {
    const hits = findDanglingIdentifiersInSet(inputs)
    if (hits.length) {
      danglingCount += hits.length
      // 按文件归组输出
      const byFile = new Map()
      for (const h of hits) {
        if (!byFile.has(h.file)) byFile.set(h.file, [])
        byFile.get(h.file).push(h)
      }
      for (const [f, hs] of byFile) report.push({ file: f, hits: hs, shared: name })
    }
  } catch (err) {
    parseFailures++
    report.push({ file: name, parseError: err.message })
  }
}

for (const item of report) {
  if (item.parseError) {
    console.log(`⚠ 解析失败  ${rel(item.file)}`)
    console.log(`    ${item.parseError.split('\n')[0]}`)
    continue
  }
  const tag = item.shared ? `  [共享作用域 ${item.shared}]` : ''
  console.log(`\n✖ ${rel(item.file)}  (${item.hits.length} 处)${tag}`)
  for (const h of item.hits) {
    console.log(`    ${String(h.line).padStart(5)}:${String(h.column || 0).padStart(3)}  ${h.name}`)
  }
}

const totalFiles = files.length + [...sharedFiles.values()].reduce((n, l) => n + l.length, 0)
if (!quiet || danglingCount || parseFailures) {
  console.log(`\n═══ 扫了 ${totalFiles} 个文件 · ${danglingCount} 处悬空引用 · ${parseFailures} 个解析失败 ═══`)
}

process.exit(danglingCount ? 1 : parseFailures ? 2 : 0)
