'use strict'

/**
 * 客户端崩溃日志上报的解析与落库。
 *
 * ## 为什么单独成文件
 *
 * 这段原本是 `production.js` 里 85 行的内联 handler。长不是主要问题 ——
 * 问题是它里面装的全是**安全决策**：
 *
 *   - 只接受 `crash` / `memory` 两个作用域（其余一律丢弃）
 *   - 单行截断 600 字符、整包最多 200 行
 *   - 摘要（崩溃条数 / 内存峰值 / 原因集合）由**服务端自己算**
 *   - 畸形 payload 视为"没有内容"，不能 500
 *
 * 这些规则混在一条路由里时，评审很难回答"这次改动有没有动隐私边界"。
 * 抽出来之后，这个文件就是隐私边界本身。
 *
 * ## 跨进程契约（重要）
 *
 * 白名单、行数上限、单行长度必须与客户端的
 * `desktop/src/stability/crash-report.js` **逐字一致**。
 *
 * 两边都放宽 → 用户聊天内容会被传上来；
 * 服务端更严  → 客户端挑出来的行被服务端二次丢弃，看着"上报成功"但库里是空的；
 * 服务端更松  → 有人改客户端就能把任意作用域塞进库。
 *
 * 所以三个常量在这里导出，由 `test/crash-report-contract.test.js` 直接比对两端的值。
 * 改任何一个都必须同步改另一端，并有测试挡着。
 */

/** 允许的作用域。★ 必须与 desktop/src/stability/crash-report.js 的 ALLOWED_SCOPES 一致 ★ */
const ALLOWED_SCOPES = ['crash', 'memory']

/** 单次上报最多保留的行数。客户端同样取 200，最坏约 120KB，顶不到服务端 body 上限。 */
const MAX_LINES = 200

/** 单行最多保留的字符数。 */
const MAX_LINE_CHARS = 600

/** `at` 字段的长度上限。时间戳正常 24 字符，给足余量但不许无限长。 */
const MAX_AT_CHARS = 32

/** version / platform / arch 的长度上限 —— 都会落库，不能让人塞正文进来。 */
const FIELD_LIMITS = { version: 32, platform: 16, arch: 16, deviceId: 64, username: 64 }

/**
 * 解析并过滤客户端提交的 lines 字段。
 *
 * @param {string|Array} raw `lines` 字段（urlencoded 下是 JSON 字符串）
 * @returns {Array<{at: string, scope: string, text: string}>}
 *
 * 上限 200、单行 600、未知作用域丢弃 —— 三条缺一不可：
 * 少了第一条能撑爆库，少了第二条能塞整段正文，少了第三条能塞任意日志。
 */
function parseLines(raw) {
  let parsed
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (e) {
    return []
  }
  if (!Array.isArray(parsed)) return []

  return parsed
    .filter(row => row && ALLOWED_SCOPES.indexOf(String(row.scope || '')) >= 0)
    // 只留末尾若干行：崩溃现场在尾部，开头的内存爬升没诊断价值。
    // slice(-N) 而不是 slice(0, N) —— 与客户端 pickReportableLines 一致。
    .slice(-MAX_LINES)
    .map(row => ({
      at: String(row.at || '').slice(0, MAX_AT_CHARS),
      scope: String(row.scope),
      // 单行再截一次：客户端可能被换掉或被改过，不能信任它的截断
      text: String(row.text || '').slice(0, MAX_LINE_CHARS)
    }))
}

/**
 * 从日志行里提取摘要。
 *
 * **必须由服务端自己算**，不能采信客户端提交的 crashCount / memoryPeak ——
 * 否则谁都能往库里写"这台设备崩溃了 9999 次"，把告警和统计带偏。
 *
 * @param {Array} lines 已过滤的行
 * @returns {{crashCount: number, memoryPeak: number|null, reasons: string[], crashedAt: Date|null}}
 */
function summarize(lines) {
  let crashCount = 0
  let memoryPeak = null
  const reasons = new Set()

  for (const line of lines) {
    if (line.scope === 'crash') {
      crashCount++
      const r = /reason=([a-z0-9_-]+)/i.exec(line.text)
      if (r) reasons.add(r[1])
    } else {
      // 只在 memory 行里找峰值；crash 行里出现"整机已用 90%"不算内存峰值
      const p = /整机已用\s*(\d+)%/.exec(line.text)
      if (p) {
        const pct = Number(p[1])
        if (Number.isFinite(pct) && (memoryPeak === null || pct > memoryPeak)) memoryPeak = pct
      }
    }
  }

  // 日志按时间顺序写，最后一行就是崩溃时刻。
  // 解析失败给 null 而不是 new Date()：编一个"现在"会让去重键失效。
  const lastAt = lines.length ? lines[lines.length - 1].at : ''
  const ts = lastAt ? Date.parse(lastAt) : NaN

  return {
    crashCount,
    memoryPeak,
    reasons: Array.from(reasons),
    crashedAt: Number.isFinite(ts) ? new Date(ts) : null
  }
}

class CrashReportService {
  /**
   * @param {object} repo ProductionRepository
   */
  constructor(repo) {
    if (!repo || typeof repo.query !== 'function') {
      throw new TypeError('CrashReportService 需要 repo.query')
    }
    this.repo = repo
  }

  /**
   * 处理一次上报。
   *
   * @param {object} params
   * @param {string|Array} params.lines  原始 lines 字段
   * @param {object} params.data         整个请求体（取 version / platform / arch）
   * @param {object|null} params.user    已登录用户（可能为 null —— 崩溃常发生在登录前）
   * @param {string} params.deviceId     设备标识
   * @returns {Promise<{stored: boolean, crashCount: number, memoryPeak: number|null}>}
   */
  async submit({ lines: rawLines, data = {}, user = null, deviceId = '' }) {
    const lines = parseLines(rawLines)

    // 没有可存内容就不落库 —— 避免把"什么都没发生"也塞进表里。
    if (!lines.length) {
      return { stored: false, crashCount: 0, memoryPeak: null }
    }

    const summary = summarize(lines)
    const clip = (value, key) => String(value || '').slice(0, FIELD_LIMITS[key])

    const result = await this.repo.query(
      `INSERT INTO client_crash_logs
         (user_id, device_id, username, version, platform, arch, crashed_at,
          lines, crash_count, memory_peak_pct, reasons)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
       -- 同一台设备、同一崩溃时刻视为重复上报：客户端重试或双开会撞到这里。
       -- crashed_at 为 NULL 时唯一索引不生效（部分索引），所以必须显式写
       -- WHERE crashed_at IS NOT NULL，否则 ON CONFLICT 会因找不到匹配索引而报错。
       ON CONFLICT (device_id, crashed_at) WHERE crashed_at IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        user ? Number(user.id) || null : null,
        String(deviceId || '').slice(0, FIELD_LIMITS.deviceId),
        user ? clip(user.username, 'username') : '',
        clip(data.version, 'version'),
        clip(data.platform, 'platform'),
        clip(data.arch, 'arch'),
        summary.crashedAt ? summary.crashedAt.toISOString() : null,
        JSON.stringify(lines),
        summary.crashCount,
        summary.memoryPeak,
        summary.reasons
      ]
    )

    return {
      // DO NOTHING 时 RETURNING 为空 —— 那种情况是"重复上报被去重"，不是失败。
      stored: !!(result && result.rows && result.rows.length),
      crashCount: summary.crashCount,
      memoryPeak: summary.memoryPeak
    }
  }
}

module.exports = {
  CrashReportService,
  parseLines,
  summarize,
  ALLOWED_SCOPES,
  MAX_LINES,
  MAX_LINE_CHARS
}
