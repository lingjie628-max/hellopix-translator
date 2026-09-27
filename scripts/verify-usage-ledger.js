/**
 * 成本台账（translation_usage）端到端验证 —— 真实翻一句，确认那笔账真的记上了。
 *
 * ## 为什么需要它
 *
 * `translation_usage` 是**权威成本口径**（见 migration 031 与 033）：厂商按 token
 * 或字符真实计费，客户按字符付费，两笔账必须分开记。但这张表有一个致命的特点 ——
 *
 *   **它写不写得进去、写得对不对，翻译照样成功，没有任何人会发现。**
 *
 * 翻译链路的健壮性做了很多（幂等、退款、锁），台账是"旁路"：写失败只打一条日志
 * （见 core-service 的 recordUpstreamUsage）。所以"翻译能用"完全不能证明"账记得对"。
 * 而且它 2026-09-25 建表之后**一次也没被写入过** —— 那批翻译发生在建表之前。
 *
 * 于是需要这个脚本：用真实商户走一次真实翻译，然后回答三个问题 ——
 *   1. 台账有没有写进去？
 *   2. 成本是不是 0？如果价目表查不到单价，0 是**假**的（不代表免费）。
 *   3. 客户那边扣的字符数与台账记的渠道对不对得上？
 *
 * ## 与 probe-translate-engines.js 的分工（两者都需要，别混）
 *
 *   · probe-translate-engines.js：**绕过** core-service 直接调适配器，
 *     回答"这个通道能不能翻"。不产生计费、不写台账。
 *   · 本脚本：**走完整** core-service 链路（预留 → 计费 → 台账），
 *     回答"这笔账记对了吗"。**会真实扣字符**。
 *
 * 两个都要跑：通道能翻（后者）不等于账记得对（前者）—— 这次就是靠后者
 * 才发现谷歌的成本被静默记成 0。
 *
 * ## 用法
 *
 *   node scripts/verify-usage-ledger.js <商户>            # 商户为用户名或 main:<id>
 *   node scripts/verify-usage-ledger.js <商户> google     # 指定通道
 *
 * 例：node scripts/verify-usage-ledger.js ceshi google
 *
 * ## 安全
 *
 *   - **会真实扣字符**（几十个字符），所以**必须显式指定商户**，
 *     绝不给"默认拿第一个商户"这种方便 —— 那等于允许一条命令误伤真实客户。
 *   - 请只对测试账号运行。脚本会打印扣费前后余额，让影响一目了然。
 *   - 台账没写进去时以非 0 退出，方便接到监控里。
 */

const { createRuntime } = require('../server/index.js')

// 够长以产生可辨认的译文与确定的字符数；内容无意义，避免被缓存命中掩盖问题
// （缓存命中的翻译**不写台账**，那是刻意设计：没打上游就没产生费用）。
const SAMPLE_TEXT = 'Hello, this is a billing ledger verification.'

function parseArgs(argv) {
  const args = argv.slice(2).filter(a => !a.startsWith('--'))
  return { merchant: args[0], engine: args[1] }
}

/** 把用户名解析成 main:<id> 形式；已经是 main:<id> 就原样返回。 */
async function resolveSubject(repo, merchant) {
  if (/^main:[1-9][0-9]*$/.test(String(merchant))) return String(merchant)
  const result = await repo.query('SELECT id FROM users WHERE lower(username)=lower($1) LIMIT 1', [String(merchant)])
  const row = result.rows[0]
  return row ? `main:${row.id}` : null
}

async function snapshot(repo, userId) {
  const usage = await repo.query('SELECT count(*)::int AS n FROM translation_usage')
  const logs = await repo.query('SELECT count(*)::int AS n FROM translate_logs')
  const user = await repo.query('SELECT char_balance, char_used FROM users WHERE id=$1', [userId])
  return {
    usageRows: usage.rows[0].n,
    logRows: logs.rows[0].n,
    balance: Number(user.rows[0].char_balance),
    used: Number(user.rows[0].char_used)
  }
}

async function main() {
  const { merchant, engine } = parseArgs(process.argv)
  if (!merchant) {
    console.error('用法: node scripts/verify-usage-ledger.js <商户> [通道]')
    console.error('说明: 商户为用户名或 main:<id>；本脚本会**真实扣字符**，请只对测试账号运行。')
    process.exitCode = 1
    return
  }

  const runtime = await createRuntime({})
  const repo = runtime.services.repository
  const core = runtime.services.core

  try {
    const subject = await resolveSubject(repo, merchant)
    if (!subject) throw new Error(`找不到商户「${merchant}」`)
    const userId = Number(subject.split(':')[1])

    const session = await repo.sessionAccount(subject)
    if (!session) throw new Error(`商户「${merchant}」的会话解析失败（status 可能不是 1）`)

    console.log(`商户: ${session.account.username}（id=${userId}，套餐=${session.parent.packageCode}）`)
    console.log(`样本: "${SAMPLE_TEXT}"  →  zh${engine ? `，指定通道 ${engine}` : ''}`)
    console.log('⚠️  本脚本会真实扣字符并写一条翻译日志 + 一条成本台账。\n')

    const before = await snapshot(repo, userId)
    console.log(`[翻译前] 台账=${before.usageRows} 行  翻译日志=${before.logRows} 行  ` +
      `余额=${before.balance} 已用=${before.used}`)

    const key = `verify-usage-ledger-${Date.now()}`
    let result
    try {
      result = await core.translate(session, {
        text: SAMPLE_TEXT,
        from: 'en',
        to: 'zh',
        engine: engine || undefined
      }, key)
    } catch (error) {
      console.error(`\n❌ 翻译失败: ${(error && error.code) || ''} ${(error && error.message) || error}`)
      process.exitCode = 1
      return
    }

    console.log(`译文: 「${result.translation}」`)
    console.log(`本次: 通道=${result.engine || result.engineId || engine || '(自动)'}  ` +
      `字符=${result.chars}  余额=${result.remain}  缓存命中=${Boolean(result.cached)}`)

    const after = await snapshot(repo, userId)
    console.log(`[翻译后] 台账=${after.usageRows} 行  翻译日志=${after.logRows} 行  ` +
      `余额=${after.balance} 已用=${after.used}`)

    const deducted = before.balance - after.balance
    console.log(`\n客户侧: 扣了 ${deducted} 字符（日志 +${after.logRows - before.logRows} 行）`)

    const usage = await repo.query(
      `SELECT id,engine_id,provider,model,prompt_tokens,completion_tokens,billed_units,billed_unit,
              upstream_cost,currency,cost_verified,cost_note,cost_source,cost_as_of,retries,cached
       FROM translation_usage ORDER BY id DESC LIMIT 1`)
    const row = usage.rows[0]

    console.log('\n=== 成本台账最新一行 ===')
    if (!row) {
      console.error('❌ 台账没有写入 —— 翻译成功了但成本没记账（这是最危险的情况：账在悄悄丢）')
      process.exitCode = 1
      return
    }
    for (const [k, v] of Object.entries(row)) {
      console.log(`  ${k} = ${v === null ? '(null)' : v}`)
    }

    console.log('')
    const wrote = after.usageRows > before.usageRows
    if (!wrote) {
      console.error('❌ 台账行数没有增加 —— 上面这行是**旧**记录，本次翻译没有记账。')
      process.exitCode = 1
      return
    }
    console.log('✅ 台账写入正常（行数 +1）')

    // cost_verified=false 时成本 0 是"不知道"，不是"免费"。这正是要盯的异常。
    if (!row.cost_verified) {
      console.error(`❌ 本次成本未核实（cost_verified=false，记账 ${row.upstream_cost} ${row.currency || '(无币种)'}）`)
      console.error(`   0 不代表免费。原因：${row.cost_note || '未说明'}`)
      console.error('   处置：在 server/lib/upstream-pricing.js 补上该模型的官方单价，')
      console.error('   或把该通道的「真实模型」改成价目表里已有的键（注意 model 会真的发给 API）。')
      process.exitCode = 1
      return
    }
    console.log(`✅ 成本已核实: ${row.upstream_cost} ${row.currency}（单价出处 ${row.cost_source || '未记'}，截至 ${row.cost_as_of || '未记'}）`)
  } finally {
    await runtime.stop()
  }
}

main().catch(error => {
  console.error('验证失败:', (error && error.stack) || error)
  process.exitCode = 1
})
