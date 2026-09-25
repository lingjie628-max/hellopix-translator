/**
 * 翻译通道连通性探针 —— 真实调用厂商 API，回答"这个通道到底能不能翻"。
 *
 * 为什么需要它：`channelStatus().credentialReady` 只判"凭据填了没有"，
 * 而 translation-adapters.js 里写得很清楚 —— 凭据填了**不代表能调通**
 * （密钥过期、配额用尽、模型名不存在、端点写错，都要真调一次才知道）。
 * 另外后台页面上"启用/接通"两个开关是人手动点的，点错了没有任何反馈，
 * 只有用户翻译时才发现"坏了"。所以需要一个能随时验真的手段。
 *
 * **不产生计费**：本脚本直接调适配器，不经过 core-service 的预留/扣费链路，
 * 不写 translate_logs，不动任何商户的字符余额。但会真实消耗厂商配额
 * （每次调用一小段文本，成本可忽略）。
 *
 * 用法：
 *   node scripts/probe-translate-engines.js           # 只探已接通(wired)的通道
 *   node scripts/probe-translate-engines.js --all     # 连未接通的也探（看缺什么凭据）
 *   node scripts/probe-translate-engines.js google    # 只探指定通道
 *
 * 安全：
 *   - 永不打印凭据原文，只回答"有没有/能不能用"；
 *   - 有任一 wired=true 的通道失败时以非 0 退出，方便接到监控里。
 */

const { query, closePostgres } = require('../server/db/postgres')
const { translate, detectLang } = require('../server/services/translation-provider')
const { decryptSecret } = require('../server/lib/credentials')

// 一小段英文，含标点与大小写，够判断译文是否真实产生。
const SAMPLE_TEXT = 'Hello, this is a connectivity test.'

function parseArgs(argv) {
  const args = argv.slice(2)
  const all = args.includes('--all')
  const ids = args.filter(a => !a.startsWith('--'))
  return { all, ids }
}

function truncate(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

async function main() {
  const { all, ids } = parseArgs(process.argv)

  const { rows } = await query(
    `SELECT id, name, enabled, wired, model, endpoint,
            api_key_ciphertext, secret_ciphertext, note
       FROM engines
      ${all ? '' : 'WHERE wired = true'}
      ORDER BY wired DESC, id`
  )
  const targets = ids.length ? rows.filter(r => ids.includes(r.id)) : rows

  if (!targets.length) {
    console.log(all ? '数据库里没有任何通道。' : '没有 wired=true 的通道。加 --all 看全部。')
    return
  }

  const missing = ids.filter(id => !rows.some(r => r.id === id))
  if (missing.length) console.log(`忽略未知通道: ${missing.join(', ')}\n`)

  console.log(`探针样本: "${SAMPLE_TEXT}"  →  目标语种 zh\n`)
  console.log('通道         接通  启用  凭据  结果   延迟   说明')
  console.log('─'.repeat(96))

  const failures = []

  for (const row of targets) {
    const engine = {
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      wired: row.wired,
      model: row.model,
      endpoint: row.endpoint
    }
    // decryptSecret 在密钥缺失/轮换/数据损坏时返回空串 —— 那等于"没有凭据"，
    // 是 fail-closed 的正确表现，这里如实反映出来。
    const credentials = {
      apiKey: decryptSecret(row.api_key_ciphertext),
      secret: decryptSecret(row.secret_ciphertext)
    }
    const hasKey = Boolean(String(credentials.apiKey || '').trim() || String(credentials.secret || '').trim())

    const started = Date.now()
    let result
    try {
      result = await translate(engine, {
        text: SAMPLE_TEXT,
        from: 'en',
        to: 'zh',
        detected: detectLang(SAMPLE_TEXT)
      }, { credentials, timeoutMs: 30_000 })
    } catch (error) {
      result = { ok: false, msg: `探针异常：${(error && error.message) || error}` }
    }
    const elapsed = Date.now() - started

    const ok = Boolean(result && result.ok)
    const detail = ok
      ? `译文「${truncate(result.text, 40)}」`
      : truncate((result && result.msg) || '未知失败', 60)

    console.log(
      `${row.id.padEnd(12)}  ${(row.wired ? '✅' : '—').padEnd(4)}  ` +
      `${(row.enabled ? '✅' : '❌').padEnd(4)}  ${(hasKey ? '✅' : '❌').padEnd(4)}  ` +
      `${(ok ? '✅ 通' : '❌ 失败').padEnd(5)}  ${String(elapsed + 'ms').padEnd(6)} ${detail}`
    )

    // 只有"已接通却翻了"才是真问题 —— 未接通本来就不该能用
    if (row.wired && !ok) failures.push({ id: row.id, name: row.name, msg: detail })
  }

  console.log('─'.repeat(96))

  const wiredCount = targets.filter(r => r.wired).length
  const wiredOk = targets.filter(r => r.wired).length - failures.length
  console.log(`已接通通道实测可用: ${wiredOk}/${wiredCount}`)

  if (failures.length) {
    console.log('\n⚠️  以下通道 wired=true（用户能选中并会被计费），但实际翻不了：')
    for (const f of failures) console.log(`   - ${f.id}（${f.name}）：${f.msg}`)
    console.log('\n   处置：修好凭据后重跑本探针；短期止血用')
    console.log('   `node scripts/set-engine-wired.js <id> false` 先关掉，')
    console.log('   否则商户选中它只会拿到 502「翻译服务暂不可用」。')
    process.exitCode = 1
  }
}

main()
  .catch(error => {
    console.error('探针失败:', (error && error.message) || error)
    process.exitCode = 1
  })
  .finally(() => closePostgres())
