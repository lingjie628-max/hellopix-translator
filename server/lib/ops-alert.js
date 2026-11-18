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
 * Telegram 告警通道。
 *
 * ## 为什么必须有第二条通道
 *
 * 2026-10-27 的真事故：Resend 每日额度用尽（`550 You have reached your
 * daily email sending quota`），邮件通道**整条哑掉**。而巡检脚本把
 * "发送失败"当成自己的执行失败（exit 1），于是：
 *
 *     alert 发不出邮件 → exit 1 → systemd 标记 failed
 *       → host-health 报「有服务处于 failed」→ Telegram
 *         → 10 分钟后重复……
 *
 * 结果是**告警系统自己成了故障源**，每 10 分钟骚扰一次，
 * 真正要报的「充值异常积压 59998 USDT」反而被淹在里面。
 *
 * Telegram 走的是和邮件完全不同的通道（api.telegram.org，无需额度），
 * 且主机巡检已经在用同一套 `TELEGRAM_TOKEN` / `TELEGRAM_CHAT_ID`，
 * 运维本来就在那个群里看着，不需要新增群、也不需要新凭证。
 */
function telegramConfig() {
  const envFile = '/etc/host-health.env'
  let cfg = {}
  try {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i < 0) continue
      cfg[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')
    }
  } catch (_e) { cfg = {} }
  const token = String(process.env.TELEGRAM_TOKEN || cfg.TELEGRAM_TOKEN || '').trim()
  const chat = String(process.env.TELEGRAM_CHAT_ID || cfg.TELEGRAM_CHAT_ID || '').trim()
  return { token, chat, enabled: !!(token && chat) }
}

/**
 * 发一条 Telegram 消息。返回是否真的送达。
 *
 * 刻意**吞掉所有异常**并返回 false：通道失败是调用方要处理的事，
 * 不该在这里再抛一次把上游的 return 变成 throw。
 */
async function sendTelegram(subject, lines, source) {
  const { token, chat, enabled } = telegramConfig()
  if (!enabled) return false
  // Telegram 单条上限 4096 字符，超了会被直接拒绝。先截断，宁可少几条明细
  // 也不能整条发不出去。
  const LIMIT = 3800
  let text = `<b>${subject}</b>\n` + lines.map(l => '· ' + l).join('\n') +
    `\n\n<i>来自 ${source || os.hostname()} 的自动告警</i>`
  if (text.length > LIMIT) text = text.slice(0, LIMIT) + '\n…（已截断）'
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(15000)
    })
    const data = await res.json().catch(() => ({}))
    if (!data || !data.ok) {
      console.error('Telegram 告警发送失败:', (data && data.description) || ('HTTP ' + res.status))
      return false
    }
    return true
  } catch (e) {
    console.error('Telegram 告警发送失败:', (e && e.message) || String(e))
    return false
  }
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
    }
    let mailError = ''
    if (recipient) {
      try {
        const mailer = new Mailer(repo)
        await mailer.send(recipient, subject,
          `<div style="font-family:-apple-system,'PingFang SC',sans-serif;line-height:1.8">
            <h3 style="margin:0 0 12px">${esc(subject)}</h3>
            <ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
            <p style="color:#8a94a3;font-size:12px">来自 ${esc(opts.source || os.hostname())} 的自动告警</p>
          </div>`)
        // 邮件通道成功就不再发 Telegram：两条都发等于双倍打扰。
        if (opts.silenceKey) {
          const state = loadState(stateFile)
          state[opts.silenceKey] = Date.now()
          saveState(state, stateFile)
        }
        return { sent: true, channel: 'mail' }
      } catch (e) {
        mailError = (e && e.message) || String(e)
        console.error('告警邮件发送失败:', mailError)
      }
    }

    // ★ 回退到 Telegram ★
    //
    // 邮件挂了（额度用尽 / SMTP 故障 / 未配收件人）时，不能就这样返回失败 ——
    // 那样上游会 exit 1，systemd 标记 failed，host-health 再报一次，
    // 而真正的告警内容一次都没送到人手上。
    const viaTelegram = await sendTelegram(subject, lines, opts.source)
    if (viaTelegram) {
      if (opts.silenceKey) {
        const state = loadState(stateFile)
        state[opts.silenceKey] = Date.now()
        saveState(state, stateFile)
      }
      return { sent: true, channel: 'telegram', mailError }
    }

    return { sent: false, reason: 'ALL_CHANNELS_FAILED', mailError }
  } finally {
    if (ownsPool) await pool.end().catch(() => {})
  }
}

module.exports = {
  sendOpsAlert, resolveRecipient, shouldAlert, loadState, saveState,
  sendTelegram, telegramConfig,
  DEFAULT_STATE_FILE, DEFAULT_SILENCE_HOURS
}
