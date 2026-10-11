'use strict'

/**
 * 真机「发送翻译」耗时统计：从客户端日志里算出 P50 / P95。
 *
 * 用法：
 *   node scripts/rc-send-perf.js                       # 自动找今天的客户端日志
 *   node scripts/rc-send-perf.js /path/to/log.txt
 *   node scripts/rc-send-perf.js /path/to/log.txt --engine gpt   # 只看某个通道
 *   cat log.txt | node scripts/rc-send-perf.js -
 *
 * 数据来源是 guest-inject 打的 `SEND_PERF` 一行 trace（同一个 sendActionId 上的
 * 分段耗时），所以这里报的就是**真机上用户实际等待的时间**，不是模拟值。
 *
 * 分段含义（与 0.1.19 性能专项的分段一一对应）：
 *   intercept    用户点击发送 → 原生发送被拦截
 *   translate    翻译请求开始 → API 返回            ← 服务端 + 厂商模型
 *   handoff      API 返回 → 原生输入开始
 *   nativeInput  原生输入开始 → 编辑器确认稳定        ← 沉降窗（本轮优化点）
 *   validate     稳定 → 触发发送
 *   send         触发发送 → 发送确认
 *   uiClose      发送确认 → 状态提示收口
 *   total        点击 → 提示收口（= 用户实际感知的等待）
 *
 * 只读，不改任何东西。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const TRACE_RE = /\[PIX_TRACE\]\s+(\w+)\s*(\{.*\})\s*$/

const STAGES = [
  ['intercept', '点击→拦截'],
  ['translate', '翻译请求(API)'],
  ['handoff', 'API返回→原生输入'],
  ['nativeInput', '原生输入→编辑器稳定'],
  ['validate', '稳定→触发发送'],
  ['send', '触发发送→发送确认'],
  ['uiClose', '发送确认→提示关闭']
]

function readInput (argv) {
  const arg = argv[2]
  if (arg && arg !== '-') return fs.readFileSync(arg, 'utf8')
  if (arg === '-') return fs.readFileSync(0, 'utf8')
  const dir = path.join(os.homedir(), 'Library', 'Application Support', 'Hello Pix', 'logs')
  if (!fs.existsSync(dir)) throw new Error('找不到日志目录：' + dir)
  const files = fs.readdirSync(dir).filter(f => /^hello-pix-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort()
  if (!files.length) throw new Error('日志目录里没有 hello-pix-*.log')
  // 默认取**最近一天**。
  const picked = path.join(dir, files[files.length - 1])
  console.log('（未指定文件，自动使用 ' + picked + '）\n')
  return fs.readFileSync(picked, 'utf8')
}

function parseTrace (text) {
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(TRACE_RE)
    if (!m) continue
    let payload = {}
    try { payload = JSON.parse(m[2]) } catch (e) { continue }
    rows.push({ event: m[1], payload: payload, at: extractTime(line) })
  }
  return rows
}

/** 日志行首的时间戳（用于分组，不是耗时来源）。 */
function extractTime (line) {
  const m = String(line).match(/\b(\d{1,2}:\d{2}:\d{2})\b/)
  return m ? m[1] : ''
}

function percentile (sorted, p) {
  if (!sorted.length) return null
  if (sorted.length === 1) return sorted[0]
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return lo === hi ? sorted[lo] : Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo))
}

function stats (values) {
  const clean = values.filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b)
  if (!clean.length) return null
  return {
    n: clean.length,
    min: clean[0],
    p50: percentile(clean, 0.5),
    p95: percentile(clean, 0.95),
    max: clean[clean.length - 1],
    mean: Math.round(clean.reduce((a, b) => a + b, 0) / clean.length)
  }
}

function pad (s, n) { return String(s == null ? '-' : s).padStart(n) }

/** 打印一个分组（某个引擎 / 全部）的分段统计。 */
function reportGroup (title, perfs) {
  console.log('\n' + '─'.repeat(74))
  console.log(' ' + title + '（n=' + perfs.length + '）')
  console.log('─'.repeat(74))
  if (!perfs.length) { console.log('  （没有样本）'); return }
  console.log(' ' + '阶段'.padEnd(26) + pad('P50', 7) + pad('P95', 7) + pad('mean', 7) + pad('max', 7) + pad('n', 5))
  for (const [key, label] of STAGES) {
    const s = stats(perfs.map(p => (p.stages || {})[key]))
    if (!s) continue
    console.log(' ' + label.padEnd(26) + pad(s.p50, 7) + pad(s.p95, 7) + pad(s.mean, 7) + pad(s.max, 7) + pad(s.n, 5))
  }
  console.log(' ' + '─'.repeat(26 + 33))
  const trig = stats(perfs.map(p => (p.total != null && (p.stages || {}).send != null && (p.stages || {}).uiClose != null)
    ? p.total - p.stages.send - p.stages.uiClose : null))
  if (trig) {
    console.log(' ' + '★按下发送→触发发送'.padEnd(24) + pad(trig.p50, 7) + pad(trig.p95, 7) + pad(trig.mean, 7) + pad(trig.max, 7) + pad(trig.n, 5))
  }
  const t = stats(perfs.map(p => p.total))
  if (t) {
    console.log(' ' + '★ 总计(点击→提示关闭)'.padEnd(24) + pad(t.p50, 7) + pad(t.p95, 7) + pad(t.mean, 7) + pad(t.max, 7) + pad(t.n, 5))
  }
  // 客户端净开销 = 总计 − 翻译段
  const oh = stats(perfs.map(p => (p.total != null && (p.stages || {}).translate != null)
    ? p.total - p.stages.translate : null))
  if (oh) {
    console.log(' ' + '客户端净开销(总−翻译)'.padEnd(24) + pad(oh.p50, 7) + pad(oh.p95, 7) + pad(oh.mean, 7) + pad(oh.max, 7) + pad(oh.n, 5))
  }
  // 结果分布
  const outcomes = {}
  for (const p of perfs) outcomes[p.outcome || '(未标注)'] = (outcomes[p.outcome || '(未标注)'] || 0) + 1
  console.log(' 结果分布：' + Object.keys(outcomes).map(k => k + '×' + outcomes[k]).join('  '))
}

function main () {
  const text = readInput(process.argv)
  const engineFilter = (() => {
    const i = process.argv.indexOf('--engine')
    return i >= 0 ? String(process.argv[i + 1] || '').toLowerCase() : ''
  })()

  const rows = parseTrace(text)
  if (!rows.length) {
    console.log('日志里一条 [PIX_TRACE] 都没有 —— 可能装的是旧版本，或日志被截断。')
    process.exit(2)
  }

  let perfs = rows.filter(r => r.event === 'SEND_PERF')
  const settled = rows.filter(r => r.event === 'LEXICAL_SETTLED')
  const driftMarks = rows.filter(r => r.event === 'COMPOSER_DRIFT_SAMPLE')
  const mismatches = rows.filter(r => r.event === 'SEND_BODY_MISMATCH_DETAIL' || r.event === 'SEND_BLOCKED_BODY_MISMATCH')
  const failClosed = rows.filter(r => r.event === 'SEND_FAIL_CLOSED')
  const nativeBegin = rows.filter(r => r.event === 'NATIVE_INPUT_BEGIN')
  const inserted = rows.filter(r => r.event === 'NATIVE_TEXT_INSERTED')

  console.log('='.repeat(74))
  console.log(' 真机「发送翻译」耗时统计')
  console.log('='.repeat(74))
  console.log(' 本次发送动作数(SEND_PERF)  : ' + perfs.length)
  console.log(' 原生输入链开始(NATIVE_INPUT_BEGIN): ' + nativeBegin.length)
  console.log(' 原生插入成功(NATIVE_TEXT_INSERTED): ' + inserted.length)
  console.log(' 正文不一致(mismatch 取证)  : ' + mismatches.length)
  console.log(' fail-closed 拦截           : ' + failClosed.length)

  if (engineFilter) {
    perfs = perfs.filter(p => String(p.payload.engine || '').toLowerCase() === engineFilter)
    console.log(' （已按 --engine ' + engineFilter + ' 过滤）')
  }

  if (!perfs.length) {
    console.log('\n没有可统计的 SEND_PERF 样本。')
    console.log('请确认本轮包已安装，并且日志里出现 [PIX_TRACE] SEND_PERF。')
    process.exit(1)
  }

  // 按引擎分组（payload.engine 为空说明实例没显式选通道）
  const groups = {}
  for (const p of perfs) {
    const key = String(p.payload.engine || '').trim() || '未标注(未显式选通道)'
    ;(groups[key] = groups[key] || []).push(p.payload)
  }
  const names = Object.keys(groups).sort()
  for (const name of names) reportGroup('通道：' + name, groups[name])
  if (names.length > 1) {
    reportGroup('全部通道合计', perfs.map(p => p.payload))
  }

  // 沉降窗质量：这是本轮优化点，单独看一眼
  console.log('\n' + '─'.repeat(74))
  console.log(' 沉降窗质量（本轮优化点）')
  console.log('─'.repeat(74))
  const settleMs = stats(settled.map(s => s.payload.ms))
  if (settleMs) {
    console.log(' LEXICAL_SETTLED 耗时: P50=' + settleMs.p50 + 'ms  P95=' + settleMs.p95 +
      'ms  max=' + settleMs.max + 'ms  mean=' + settleMs.mean + 'ms  n=' + settleMs.n)
  }
  const unstable = settled.filter(s => s.payload.stable === false)
  const notEqual = settled.filter(s => s.payload.canonicalEqual === false)
  const drifted = driftMarks.filter(d => d.payload && d.payload.equal === false)
  console.log(' 未确认稳定(stable=false)   : ' + unstable.length)
  console.log(' 沉降后正文不符(canonicalEqual=false): ' + notEqual.length)
  console.log(' 漂移采样出现 equal=false   : ' + drifted.length)
  if (unstable.length || notEqual.length || drifted.length) {
    console.log(' ⚠️  出现以上任一项 → 说明发生了"写入后正文被编辑器改掉"，请把日志发回。')
  } else {
    console.log(' ✔ 写入后正文稳定、且与译文一致（无漂移）')
  }

  // 安全底线
  console.log('\n' + '─'.repeat(74))
  console.log(' 安全底线核对')
  console.log('─'.repeat(74))
  console.log(' ' + (mismatches.length === 0 ? '✔' : '✖') + ' 无正文不一致（BODY_MISMATCH 取证 ' + mismatches.length + ' 次）')
  console.log(' ' + (failClosed.length === 0 ? '✔' : 'ℹ') + ' fail-closed 拦截 ' + failClosed.length + ' 次（有拦截本身不是坏事，说明闸门在工作）')
  const outcomes = {}
  for (const p of perfs) outcomes[p.payload.outcome || '(未标注)'] = (outcomes[p.payload.outcome || '(未标注)'] || 0) + 1
  const okCount = outcomes.ok || 0
  console.log(' ' + (okCount === perfs.length ? '✔' : 'ℹ') + ' 成功发送 ' + okCount + ' / ' + perfs.length + ' 次')

  console.log('\n说明：以上是**客户端侧**的精确耗时（真机埋点，非模拟）。')
  console.log('     WhatsApp 自身的"已送达"确认取决于对方在线状态，不由客户端埋点覆盖，')
  console.log('     请按手册用秒表记录，与这里的 total 相减即得到 WhatsApp 侧耗时。')
}

main()
