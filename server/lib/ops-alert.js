'use strict'

/**
 * 运维告警发送（共享实现）。
 *
 * ## 为什么抽出来
 *
 * 原本这段逻辑只写在 `scripts/alert.js` 里。RC-02 的 ChainWatcher 也需要
 * 在「TronGrid 凭据失效」这类**不可重试**错误上立刻告警，如果各写一份，
 * 迟早分叉 —— 而且分叉的表现是"某一类告警悄悄不发"。所以统一到这里。
 *
 * ## 顺带修掉的一个真 bug
 *
 * 原实现读的是 `settings.mail.alertTo` / `settings.mail.smtp`（**嵌套**），
 * 而 `repo.settings()` 返回的是**扁平点号键** `'mail.alert_to'` / `'mail.smtp'`。
 * 结果是收件人永远取不到，每次都走「告警无法送达」分支 ——
 * **告警从来没发出去过**。这和邮件服务那个 bug 是同一类错误。
 *
 * ## 静默
 *
 * 同一个问题在静默期内只发一次。没有静默的告警等于没有告警：
 * 每分钟一封会被直接无视，最后连真出事那次也没人看。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const DEFAULT_STATE_FILE = '/var/lib/hello-pix-alert-state.json'
const DEFAULT_SILENCE_HOURS = 1

function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file || DEFAULT_STATE_FILE, 'utf8')) } catch (_e) { return {} }
}

function saveState(state, file) {
  const target = file || DEFAULT_STATE_FILE
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(state))
  } catch (_e) { /* 状态存不下来不该让告警本身失败 */ }
}

/** 同一问题在静默期内不重复告警 */
function shouldAlert(key, state, silenceHours) {
  const hours = Number.isFinite(silenceHours) ? silenceHours : DEFAULT_SILENCE_HOURS
  const last = Number((state || {})[key] || 0)
  return Date.now() - last > hours * 3600 * 1000
}

/** 取告警收件地址：优先 mail.alert_to，退回发件地址 */
function resolveRecipient(settings) {
  const s = settings || {}
  const alertTo = String(s['mail.alert_to'] || '').trim()
  if (alertTo) return alertTo
  const smtp = s['mail.smtp']
  const from = smtp && typeof smtp === 'object' ? String(smtp.from || '').trim() : ''
  return from
}

/**
 * 发一封运维告警。
 *
 * @param {object} options
 * @param {string} options.subject
 * @param {string[]} options.lines
 * @param {object} [options.pool]        pg Pool（不传则自建，调用方负责关）
 * @param {string} [options.silenceKey]  给了就按它做静默
 * @param {number} [options.silenceHours]
 * @param {string} [options.stateFile]
 * @param {boolean} [options.dryRun]     只打印不发送
 * @param {string} [options.source]      邮件落款里的来源说明
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function sendOpsAlert(options) {
  const opts = options || {}
  const subject = String(opts.subject || 'Hello Pix 告警')
  const lines = Array.isArray(opts.lines) ? opts.lines : [String(opts.lines || '')]
  const stateFile = opts.stateFile || DEFAULT_STATE_FILE

  // 静默检查放在最前面：被静默的问题不该浪费一次数据库连接
  if (opts.silenceKey) {
    const state = loadState(stateFile)
    if (!shouldAlert(opts.silenceKey, state, opts.silenceHours)) {
      return { sent: false, reason: 'SILENCED' }
    }
  }

  if (opts.dryRun) {
    console.log('[dry] 告警:', subject)
    lines.forEach(l => console.log('      -', l))
    return { sent: false, reason: 'DRY_RUN' }
  }

  const { Mailer, esc } = require('./mailer')
  const { ProductionRepository } = require('../repositories/production-repository')

  let ownsPool = false
  let pool = opts.pool
  if (!pool) {
    const { Pool } = require('pg')
    const config = require('../config')
    pool = new Pool({ connectionString: config.database.connectionString, ssl: config.database.ssl, max: 1 })
    ownsPool = true
  }

  try {
    const repo = new ProductionRepository(pool)
    const recipient = resolveRecipient(await repo.settings())
    if (!recipient) {
      // 不能静默丢弃 —— 否则等于没有告警。写日志让巡检脚本能发现。
      console.error('告警无法送达：后台未配置收件地址（mail.alert_to）')
      return { sent: false, reason: 'NO_RECIPIENT' }
    }
    const mailer = new Mailer(repo)
    await mailer.send(recipient, subject,
      `<div style="font-family:-apple-system,'PingFang SC',sans-serif;line-height:1.8">
        <h3 style="margin:0 0 12px">${esc(subject)}</h3>
        <ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
        <p style="color:#8a94a3;font-size:12px">来自 ${esc(opts.source || os.hostname())} 的自动告警</p>
      </div>`)

    if (opts.silenceKey) {
      const state = loadState(stateFile)
      state[opts.silenceKey] = Date.now()
      saveState(state, stateFile)
    }
    return { sent: true }
  } finally {
    if (ownsPool) await pool.end().catch(() => {})
  }
}

module.exports = {
  sendOpsAlert, resolveRecipient, shouldAlert, loadState, saveState,
  DEFAULT_STATE_FILE, DEFAULT_SILENCE_HOURS
}
