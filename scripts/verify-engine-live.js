#!/usr/bin/env node
'use strict'

/**
 * 单通道「真实调用 + 计费 + 幂等」端到端验证。
 *
 * ## 为什么需要它
 *
 * `probe-translate-engines.js` 回答"这个通道能不能翻"（绕过 core-service、不计费、
 * 不写日志）。本脚本回答的是**上线收口**才会问的那组问题：
 *
 *   1. 这个通道真的调通了上游吗？上游回的 HTTP 状态是什么？
 *   2. 翻译这一下，**客户侧扣了多少字符**、`translate_logs` 有没有新增一行？
 *   3. **同一个 Idempotency-Key 重放，会不会重复扣费？**
 *
 * 第 3 条是资金正确性的核心：客户端超时重发是常态，幂等一旦破了就是"重发一次扣一次"。
 * 幂等靠 `translation_reservations(user_id, idempotency_key)` 唯一约束 +
 * `response_json` 短路实现（见 core-service.translate 第 481 行附近）—— 但那是我读代码
 * 得出的结论，**必须真跑一次证明它成立**。
 *
 * ## 与另外两个脚本的分工
 *
 *   · probe-translate-engines.js —— 只测连通性，不计费、不写台账；
 *   · verify-usage-ledger.js   —— 走完整链路验**成本台账**（translation_usage）；
 *   · 本脚本                   —— 走完整链路验**客户侧字符账 + 幂等**（translate_logs /
 *                                 translation_reservations），并抓上游 HTTP 状态。
 *
 * ## 会真实扣字符
 *
 * 所以**必须显式指定商户**，且只用测试账号。扣费前后余额都会打印出来。
 *
 * ## 用法
 *
 *   node scripts/verify-engine-live.js <商户> <通道> [原文]
 *   node scripts/verify-engine-live.js ceshi gpt
 *   node scripts/verify-engine-live.js ceshi grok
 */

const { createRuntime } = require('../server/index.js')

function parseArgs(argv) {
  const args = argv.slice(2).filter(a => !a.startsWith('--'))
  return { merchant: args[0], engine: args[1], text: args[2] }
}

async function resolveSubject(repo, merchant) {
  if (/^main:[1-9][0-9]*$/.test(String(merchant))) return String(merchant)
  const result = await repo.query('SELECT id FROM users WHERE lower(username)=lower($1) LIMIT 1', [String(merchant)])
  const row = result.rows[0]
  return row ? `main:${row.id}` : null
}

/** 余额 / 已用 / 翻译次数 / 两张日志表行数 —— 判定"这次到底动了什么"的依据。 */
async function snapshot(repo, userId) {
  const [user, logs, usage, reservations] = await Promise.all([
    repo.query('SELECT char_balance, char_used, translate_count FROM users WHERE id=$1', [userId]),
    repo.query('SELECT count(*)::int AS n FROM translate_logs'),
    repo.query('SELECT count(*)::int AS n FROM translation_usage'),
    repo.query('SELECT count(*)::int AS n FROM translation_reservations')
  ])
  const u = user.rows[0]
  return {
    balance: Number(u.char_balance),
    used: Number(u.char_used),
    translateCount: Number(u.translate_count),
    logRows: logs.rows[0].n,
    usageRows: usage.rows[0].n,
    reservationRows: reservations.rows[0].n
  }
}

function fmt(s) {
  return `余额=${s.balance} 已用=${s.used} 翻译次数=${s.translateCount} ` +
    `translate_logs=${s.logRows} translation_usage=${s.usageRows} reservations=${s.reservationRows}`
}

async function main() {
  const { merchant, engine, text: textArg } = parseArgs(process.argv)
  if (!merchant || !engine) {
    console.error('用法: node scripts/verify-engine-live.js <商户> <通道> [原文]')
    console.error('⚠️  会真实扣字符，请只对测试账号运行。')
    process.exitCode = 1
    return
  }

  // 带 nonce：翻译结果会被 Redis 缓存，缓存命中**不写日志也不计费** ——
  // 用固定原文第二次跑就会被缓存掩盖，验不出计费链路。
  const nonce = Date.now().toString(36)
  const text = String(textArg || `Hello, this is a live ${engine} verification, run ${nonce}.`)

  const runtime = await createRuntime({})
  const repo = runtime.services.repository
  const core = runtime.services.core

  // 包装 globalThis.fetch 抓上游真实 HTTP 状态。
  // 依据：translation-provider.js 在**调用时**取 `fetch: globalThis.fetch`，
  // 且 core-service 不传自己的 fetch，所以这里换掉全局 fetch 一定能拦到。
  const realFetch = globalThis.fetch
  const httpCalls = []
  globalThis.fetch = async (url, init) => {
    const started = Date.now()
    const response = await realFetch(url, init)
    let host = String(url)
    try { host = new URL(String(url)).host } catch (_e) {}
    const call = { host, method: String((init && init.method) || 'GET'), status: response.status, ok: response.ok, ms: Date.now() - started, detail: '' }
    // 失败时把厂商的错误体留下来 —— "为什么 400" 是收口时最需要知道的。
    // 只读非 2xx，且读的是 clone，不影响适配层自己消费 body。
    if (!response.ok) {
      try { call.detail = String(await response.clone().text()).replace(/\s+/g, ' ').slice(0, 240) } catch (_e) {}
    }
    httpCalls.push(call)
    return response
  }

  try {
    const subject = await resolveSubject(repo, merchant)
    if (!subject) throw new Error(`找不到商户「${merchant}」`)
    const userId = Number(subject.split(':')[1])
    const session = await repo.sessionAccount(subject)
    if (!session) throw new Error(`商户「${merchant}」的会话解析失败（status 可能不是 1）`)

    console.log(`通道: ${engine}    商户: ${session.account.username}（id=${userId}，套餐=${session.parent.packageCode}）`)
    console.log(`原文: "${text}"（${text.length} 字符）  →  zh\n`)

    const before = await snapshot(repo, userId)
    console.log(`[翻译前] ${fmt(before)}`)

    const key = `verify-engine-live-${engine}-${nonce}`
    console.log(`Idempotency-Key: ${key}\n`)

    // ---------------- 第 1 次：真实调用 ----------------
    let first
    try {
      first = await core.translate(session, { text, from: 'en', to: 'zh', engine }, key)
    } catch (error) {
      console.error(`\n❌ 真实调用失败: [${(error && error.code) || '?'}] ${(error && error.message) || error}`)
      console.error('   上游 HTTP 调用: ' + (httpCalls.length
        ? httpCalls.map(c => `${c.host} ${c.method} → ${c.status}`).join('; ')
        : '(未发出任何上游请求 —— 失败发生在更早的一步)'))
      process.exitCode = 1
      return
    }

    const after = await snapshot(repo, userId)
    console.log('=== 结果（第 1 次）===')
    console.log(`  provider = ${first.provider}`)
    console.log(`  model    = ${first.model}`)
    console.log(`  engine   = ${first.engine}（${first.engineName}）`)
    console.log(`  译文     = 「${first.translation}」`)
    console.log(`  chars    = ${first.chars}   缓存命中 = ${Boolean(first.cached)}`)
    console.log(`  remain   = ${first.remain}`)
    console.log('\n=== 上游 HTTP ===')
    const callsAfterFirst = httpCalls.length
    if (!httpCalls.length) console.log('  ⚠️ 没有捕获到上游请求（可能走了缓存）')
    for (const c of httpCalls) {
      console.log(`  ${c.host}  ${c.method}  →  HTTP ${c.status} ${c.ok ? '(API 成功)' : '(API 失败)'}  ${c.ms}ms`)
      if (c.detail) console.log(`      ↳ ${c.detail}`)
    }

    console.log(`\n[翻译后] ${fmt(after)}`)
    const deducted = before.balance - after.balance
    console.log(`客户侧: 扣了 ${deducted} 字符；translate_logs +${after.logRows - before.logRows} 行`)

    const logRow = (await repo.query(
      `SELECT id,user_id,sub_account_id,engine_id,reservation_id,source_language,target_language,
              chars,cost_amount,sell_amount,cached,duration_ms,created_at
         FROM translate_logs ORDER BY id DESC LIMIT 1`)).rows[0]
    console.log('\n=== translate_logs 新增行 ===')
    if (logRow) for (const [k, v] of Object.entries(logRow)) console.log(`  ${k} = ${v === null ? '(null)' : v}`)

    // ---------------- 第 2 次：同 key 幂等重放 ----------------
    console.log('\n=== 幂等重放（同一个 Idempotency-Key + 同一请求体）===')
    let replay
    try {
      replay = await core.translate(session, { text, from: 'en', to: 'zh', engine }, key)
    } catch (error) {
      console.error(`❌ 重放报错: [${(error && error.code) || '?'}] ${(error && error.message) || error}`)
      process.exitCode = 1
      return
    }
    const afterReplay = await snapshot(repo, userId)
    const replayDeducted = after.balance - afterReplay.balance
    console.log(`  [重放后] ${fmt(afterReplay)}`)
    console.log(`  重放是否重复扣费: ${replayDeducted === 0 ? '✅ 没有（+0 字符）' : `❌ 又扣了 ${replayDeducted} 字符`}`)
    console.log(`  重放译文是否与首次一致: ${replay.translation === first.translation ? '✅ 一致' : '❌ 不一致'}`)
    console.log(`  重放是否再次打上游: ${httpCalls.length - callsAfterFirst === 0
      ? '✅ 没有（命中预留快照，未产生新的上游调用）'
      : `❌ 又发了 ${httpCalls.length - callsAfterFirst} 个上游请求`}`)

    // ---------------- 判定 ----------------
    const problems = []
    if (after.logRows - before.logRows !== 1) problems.push('translate_logs 没有恰好新增 1 行')
    if (deducted !== first.chars) problems.push(`扣费(${deducted}) 与 chars(${first.chars}) 不一致`)
    if (replayDeducted !== 0) problems.push('幂等重放重复扣费')
    if (httpCalls.length - callsAfterFirst !== 0) problems.push('幂等重放又打了上游')
    if (!httpCalls.some(c => c.ok)) problems.push('没有捕获到成功的上游 HTTP 响应')

    console.log('')
    if (problems.length) {
      console.error('❌ 验证不通过：')
      for (const p of problems) console.error(`   - ${p}`)
      process.exitCode = 1
    } else {
      console.log(`✅ ${engine} 验证通过：真实调用成功、计费正确、幂等重放不重复扣费`)
    }
  } finally {
    globalThis.fetch = realFetch
    await runtime.stop()
  }
}

main().catch(error => {
  console.error('验证失败:', (error && error.stack) || error)
  process.exitCode = 1
})
