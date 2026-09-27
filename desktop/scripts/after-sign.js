/**
 * macOS 签名后的复核（electron-builder 的 afterSign 钩子）。
 *
 * ## 为什么必须有这一步
 *
 * electron-builder 在**拿不到公证凭据时只打一条 warning 就跳过公证**，
 * 构建照样成功（见 app-builder-lib/out/mac/MacTargetHelper.js 的
 * `notarizeIfProvided`：`log.warn({ reason: "`notarize` options were unable to
 * be generated" }, "skipped macOS notarization")`）。
 *
 * 后果：你会发出一个「签了名但没公证」的包，**用户照样看到
 * 「Apple 无法验证」那张图**，而构建日志末尾完全看不出异常。
 *
 * 这与 2026-09-27 那次「静默产出已损坏安装包」是**同一种病**：
 * 失败路径不中断构建，于是错误被原样发到用户手上。所以这里 fail-closed。
 *
 * ## 它做什么
 *
 * 签名/公证全部结束之后，直接问系统"这个包现在到底是什么状态"，再与
 * **构建者的意图**对照：
 *
 *   · 完全没签名 / 签名校验不过  → **构建失败**（0.1.6 那种"已损坏"包）
 *   · 用了 Developer ID 但缺 hardened runtime → **构建失败**（公证必然被拒）
 *   · 配了公证凭据但票据没钉上  → **构建失败**（公证静默失败）
 *   · 要求公证却没公证          → **构建失败**（PIX_REQUIRE_NOTARIZED=1）
 *   · 未公证的过渡期构建        → 大声警告，说清用户会看到什么
 *
 * ## 认证方式
 *
 * electron-builder 支持三套（顺序即其内部优先级）：
 *   1. APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER   ← 推荐，权限最小
 *   2. APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
 *   3. APPLE_KEYCHAIN_PROFILE（+ 可选 APPLE_KEYCHAIN）
 *
 * ## 环境变量
 *
 *   PIX_REQUIRE_NOTARIZED=1  发版时设上：没公证就让构建失败。
 *                            拿到证书后应加进发版命令，从此不可能再发出未公证的包。
 */

const path = require('node:path')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

const TIMEOUT_MS = 5 * 60 * 1000

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: TIMEOUT_MS })
  if (result.error) return { status: -1, output: String(result.error.message || result.error) }
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` }
}

/** electron-builder 内部认的三套凭据，顺序与它自己的一致。 */
const CREDENTIAL_SETS = [
  ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
  ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
  ['APPLE_KEYCHAIN_PROFILE']
]

function credentialState() {
  for (const set of CREDENTIAL_SETS) {
    if (set.every(key => process.env[key])) return { complete: set.join(' + '), partial: [] }
  }
  // 报出"配了一半"的变量名：这比笼统说"没配"有用得多，
  // 因为漏一个变量的表现与一个都没配完全不同（前者会抛错，后者只会 warning）。
  const partial = []
  for (const set of CREDENTIAL_SETS) {
    for (const key of set) if (process.env[key]) partial.push(key)
  }
  return { complete: null, partial }
}

async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const productName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${productName}.app`)
  if (!fs.existsSync(appPath)) {
    throw new Error(`[verify-sign] 找不到已签名的应用：${appPath}`)
  }

  const credentials = credentialState()
  const requireNotarized = process.env.PIX_REQUIRE_NOTARIZED === '1'

  // ---- 1) 签名本身是否有效 ------------------------------------------------
  const verify = run('codesign', ['--verify', '--deep', '--strict', appPath])
  const info = run('codesign', ['-dv', '--verbose=4', appPath]).output

  const pick = key => {
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(info)
    return m ? m[1].trim() : ''
  }
  const authority = pick('Authority')
  const teamId = pick('TeamIdentifier')
  const isAdhoc = /^Signature=adhoc\s*$/m.test(info)
  const hasRuntime = /flags=0x[0-9a-f]*\(.*runtime.*\)/i.test(info) || /runtime/.test(pick('flags'))

  const failures = []

  if (verify.status !== 0) {
    failures.push(`签名校验未通过（退出码 ${verify.status}）：${verify.output.trim()}`)
  }

  const state = isAdhoc
    ? 'ad-hoc（不证明身份，无法公证）'
    : (authority ? `Developer ID：${authority}` : '未知签名')

  // ---- 2) 未公证时的意图对照 ----------------------------------------------
  const stapled = !isAdhoc && run('xcrun', ['stapler', 'validate', appPath]).status === 0

  if (!isAdhoc && authority) {
    // 用了 Developer ID 就必须开 hardened runtime，否则公证一定被拒。
    if (!hasRuntime) {
      failures.push('已用 Developer ID 签名，但没有开启 hardened runtime —— 公证必然被拒。'
        + '检查 package.json 的 mac.hardenedRuntime 是否为 true。')
    }
  }

  if (!stapled) {
    if (isAdhoc) {
      if (requireNotarized) {
        failures.push('PIX_REQUIRE_NOTARIZED=1，但本次是 ad-hoc 签名（本机没有 Developer ID 证书），无法公证。')
      }
    } else if (credentials.complete) {
      // 最危险的一种：配了凭据、公证却静默失败/被跳过。
      failures.push(`已配置公证凭据（${credentials.complete}），但应用里**没有**公证票据。`
        + '\n    这说明公证失败了 —— electron-builder 在凭据不可用时只打 warning 就跳过，'
        + '\n    不会中断构建。请向上翻构建日志找 "notarization" 相关输出。')
    } else if (requireNotarized) {
      failures.push('PIX_REQUIRE_NOTARIZED=1，但应用没有公证票据，且未配置公证凭据。')
    }
  }

  // ---- 3) 输出结论 --------------------------------------------------------
  console.log('\n[verify-sign] macOS 签名复核')
  console.log(`  应用      : ${productName}.app`)
  console.log(`  签名      : ${state}`)
  console.log(`  TeamID    : ${teamId || '(无)'}`)
  console.log(`  hardened  : ${hasRuntime ? '已开启' : '未开启'}`)
  console.log(`  公证票据  : ${stapled ? '已钉上（离线可开）' : '无'}`)
  console.log(`  公证凭据  : ${credentials.complete || (credentials.partial.length
    ? `不完整（只设了 ${credentials.partial.join(', ')}）`
    : '未配置')}`)

  if (failures.length) {
    throw new Error('[verify-sign] 签名/公证状态不符合预期，拒绝产出安装包：\n'
      + failures.map(f => `  - ${f}`).join('\n'))
  }

  if (!stapled) {
    // 这是过渡期的正常状态，但必须让构建者**当场看见**它意味着什么，
    // 而不是等用户来投诉"装不上"。
    console.log('')
    console.log('  ⚠️  本次构建**未公证**，用户在 macOS 上首次打开时仍会看到')
    console.log('      「Apple 无法验证开发者」，需要进 系统设置 → 隐私与安全性 → 仍要打开。')
    console.log('      拿到 Apple Developer 证书后，设置公证凭据并加上')
    console.log('      PIX_REQUIRE_NOTARIZED=1，即可让此类构建立刻失败。')
  } else {
    console.log('\n  ✅ 已公证并钉上票据：用户双击即开，无任何提示。')
  }
}

module.exports = afterSign
module.exports.default = afterSign
