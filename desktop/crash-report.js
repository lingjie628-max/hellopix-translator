'use strict'

/**
 * 崩溃日志上报。
 *
 * ## 解决什么
 *
 * 0.1.36 起客户端会记 `[crash]` 与 `[memory]` 两类日志，但**只留在用户本机**。
 * 用户不主动发，我们就永远看不到 —— 加了取证却没有把证据收回来。
 * 这个模块在**下次启动**时，把上次异常退出的痕迹自动送上来。
 *
 * ## 三道安全边界（改之前务必读）
 *
 * 1. **只传 crash / memory 两个域的行**，白名单过滤。
 *    完整日志里有 WhatsApp 群名、联系人、翻译正文 —— 绝不能上服务器。
 *    服务端会再做一次同样的过滤，不信任客户端。
 *
 * 2. **不上传账号密码/代理凭据**。日志写入时已过 `redact()`，
 *    但这里只挑白名单行，等于又多一层。
 *
 * 3. **失败静默**。上报失败不写任何可见日志、不弹窗、不阻塞启动 ——
 *    这是后台行为，不能因为服务器连不上而干扰用户。
 *
 * ## 为什么只在"异常退出"后上报
 *
 * 正常退出也会留下当天的日志。若每次启动都传，等于每次启动都打服务器一下，
 * 且数据里 99% 是"没崩"的记录。用 `last-clean-exit` 标记区分：
 *   · 正常退出 → 写标记
 *   · 启动时发现标记不存在 → 上次是异常退出 → 上报
 */

const fs = require('fs')
const path = require('path')

/** 只接受这两个域 —— 白名单，不是黑名单。 */
const ALLOWED_SCOPES = ['crash', 'memory']

// 单次上报的行数上限。
// 400 行 × 600 字符最坏约 240KB，正好顶到服务端 256kb 的 body 上限 ——
// 一旦超了会**整包被拒**，一条都收不到。压到 200 行后最坏约 120KB，
// 留足余量；而 200 行足够覆盖一天的内存档位切换 + 崩溃现场。
const MAX_LINES = 200
const MAX_LINE_CHARS = 600     // 单行上限，与 log-file 的截断口径一致
const MARKER_FILE = 'last-clean-exit'

/** 时间戳形如 `2026-10-19 09:57:01.123`（log-file.js 的 formatLine 格式）。 */
const LINE_RE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\s+\[[A-Z ]+\]\s+\[(\w+)\]\s*(.*)$/

function markerPath(dir) {
  return path.join(dir, MARKER_FILE)
}

function readMarker(dir) {
  try {
    return fs.readFileSync(markerPath(dir), 'utf8').trim()
  } catch (e) {
    return ''
  }
}

function writeMarker(dir) {
  try { fs.writeFileSync(markerPath(dir), String(Date.now())) } catch (e) {}
}

/**
 * 从一段文本里挑出可上报的行。
 *
 * 拆成纯函数是为了能单测 —— 过滤逻辑写错会导致**用户隐私外泄**，
 * 这种地方不能只靠"跑一遍看着没问题"。
 *
 * @returns {{lines:Array<{at:string,scope:string,text:string}>, dropped:number}}
 */
function pickReportableLines(text) {
  const lines = []
  let dropped = 0
  for (const raw of String(text || '').split('\n')) {
    const row = raw.trim()
    if (!row) continue
    const m = LINE_RE.exec(row)
    // 解析不了的行（多行堆栈、原生崩溃转储等）一律丢弃 ——
    // 无法确认作用域就无法确认它不含隐私。
    if (!m) { dropped++; continue }
    if (ALLOWED_SCOPES.indexOf(m[2]) < 0) { dropped++; continue }
    lines.push({
      at: m[1].replace(' ', 'T'),
      scope: m[2],
      text: m[3].slice(0, MAX_LINE_CHARS)
    })
  }
  // 只保留**最后**若干行：崩溃现场的尾巴比开头的内存爬升更有价值，
  // 但两者都要 —— MAX_LINES 足够容纳一天的内存档位切换。
  return { lines: lines.slice(-MAX_LINES), dropped }
}

/** 汇总：崩溃条数、内存峰值、崩溃原因。后台按这些字段排序比读文本快得多。 */
function summarize(lines) {
  let crashCount = 0
  let memoryPeak = null
  const reasons = new Set()
  for (const line of lines || []) {
    if (line.scope === 'crash') {
      crashCount++
      const r = /reason=([a-z0-9_-]+)/i.exec(line.text)
      if (r) reasons.add(r[1])
    } else if (line.scope === 'memory') {
      const p = /整机已用\s*(\d+)%/.exec(line.text)
      if (p) {
        const pct = Number(p[1])
        if (Number.isFinite(pct) && (memoryPeak === null || pct > memoryPeak)) memoryPeak = pct
      }
    }
  }
  return { crashCount, memoryPeak, reasons: Array.from(reasons) }
}

/** 找到"最近一个含可上报内容的日志文件"。返回 { file, day } 或 null。 */
function findLatestLog(dir) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    return null
  }
  const rows = []
  for (const name of names) {
    const m = /^hello-pix-(\d{4}-\d{2}-\d{2})\.log(?:\.(\d+))?$/.exec(name)
    if (!m) continue
    rows.push({ name, day: m[1], index: Number(m[2] || 0) })
  }
  // 按日期倒序、同日按轮转序号倒序 —— 最新的在最前。
  rows.sort((a, b) => (a.day === b.day ? b.index - a.index : (a.day < b.day ? 1 : -1)))
  for (const row of rows) {
    const file = path.join(dir, row.name)
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch (e) { continue }
    const picked = pickReportableLines(text)
    if (picked.lines.length) return { file, day: row.day, picked }
  }
  return null
}

/**
 * 判断上次是否是异常退出。
 *
 * 判据：标记文件里的时间戳 **早于** 最新日志文件里最后一条记录的时间。
 * 单纯"标记不存在"不够 —— 首次安装、升级后被清理等都满足这一条，
 * 那会把"没崩过"误报成崩溃。要求"日志比标记更新"才说明：
 * 上次跑过、写了日志、但没来得及写标记 → 异常退出。
 */
function detectAbnormalExit(dir) {
  const marker = readMarker(dir)
  const latest = findLatestLog(dir)
  if (!latest) return null
  const lastLine = latest.picked.lines[latest.picked.lines.length - 1]
  const lastAt = lastLine ? Date.parse(lastLine.at) : 0
  if (!Number.isFinite(lastAt) || lastAt <= 0) return null
  // 标记时间 >= 最后一条日志时间 → 上次是正常退出（或在写日志之后正常退出）。
  if (marker && Number(marker) >= lastAt) return null
  return latest
}

module.exports = {
  ALLOWED_SCOPES,
  MAX_LINES,
  markerPath,
  readMarker,
  writeMarker,
  pickReportableLines,
  summarize,
  findLatestLog,
  detectAbnormalExit
}
