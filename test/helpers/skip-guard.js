'use strict'

/**
 * 测试跳过闸门。**防止"没配库"伪装成"全绿"。**
 *
 * ## 问题
 *
 * `test/` 下有 10 个文件、14 处测试这样写：
 *
 *   test('结算服务…', { skip: !databaseUrl }, ...)
 *
 * 本地没配 `PIX_TEST_DATABASE_URL` 时它们**静默 skip**，`node --test` 退出码
 * 依然是 0。于是 `npm run test:security` 天天显示"全部通过"，而碰钱的
 * 结算、充值、对账测试一个都没跑过。
 *
 * 这不是测试通过，这是测试不存在。
 *
 * ## 策略
 *
 * 三种模式，由 `PIX_TEST_STRICT` 控制：
 *
 *   - `required`（CI / 发布前必用）
 *       只要出现被跳过的测试 → **退出码 1**。
 *
 *   - `warn`（本地日常，默认）
 *       打印醒目警告并列出被跳过的测试名，退出码保持 0。
 *
 *   - `off`
 *       完全不检查。
 *
 * ## 为什么解析 TAP 而不是 JSON reporter
 *
 * Node 26 的 `--test-reporter=json` 会把它当模块名去 resolve，
 * 直接报 `ERR_MODULE_NOT_FOUND: Cannot find package 'json'`。
 * TAP 输出稳定、可机读，`ok 3 - name # SKIP reason` 这一行就是全部信息。
 */

const SKIP_LINE = /^(not ok|ok)\s+\d+\s+-\s+(.*?)(?:\s+#\s+(SKIP|TODO)\b\s*(.*))?$/i

/**
 * 从 TAP 输出里抠出所有被跳过的测试。
 *
 * 注意 TAP 的层级是扁平的 `# Subtest:` 段落，子测试与顶层测试混在一起，
 * 不保留父子路径。对闸门来说够用 —— 我们要的是"哪些没跑、为什么"，
 * 不需要精确的调用树。
 */
function collectSkippedFromTap(tap) {
  const skipped = []
  const lines = String(tap || '').split('\n')
  for (const line of lines) {
    const match = SKIP_LINE.exec(line.trim())
    if (!match) continue
    const directive = (match[3] || '').toUpperCase()
    if (directive !== 'SKIP' && directive !== 'TODO') continue
    skipped.push({
      path: match[2].trim(),
      kind: directive === 'SKIP' ? 'skip' : 'todo',
      reason: (match[4] || '').trim() || '无说明'
    })
  }
  return skipped
}

/** 环境变量里该有的依赖是否齐全 —— 用于告诉人"为什么会被跳过" */
function missingDependencies(env) {
  const missing = []
  if (!env.PIX_TEST_DATABASE_URL) missing.push('PIX_TEST_DATABASE_URL')
  if (!env.PIX_TEST_REDIS_URL) missing.push('PIX_TEST_REDIS_URL')
  return missing
}

/**
 * 检查并决定退出行为。
 *
 * @param {string} tap node:test 的 TAP 输出全文
 * @param {{ mode?: string, env?: object, log?: Function }} options
 * @returns {{ code: number, skipped: Array, missing: string[] }}
 */
function enforce(tap, options) {
  const opts = options || {}
  const env = opts.env || process.env
  const log = opts.log || console.error
  const mode = String(opts.mode || env.PIX_TEST_STRICT || 'warn').toLowerCase()

  if (mode === 'off') return { code: 0, skipped: [], missing: [] }

  const skipped = collectSkippedFromTap(tap)
  const missing = missingDependencies(env)

  if (!skipped.length) {
    if (missing.length) {
      log(`\n⚠ 测试依赖未配置：${missing.join(', ')}`)
      log('  本次没有测试报 skip，但依赖确实缺失 —— 说明跳过条件可能失效了，值得查一眼。\n')
    }
    return { code: 0, skipped, missing }
  }

  const header = mode === 'required'
    ? `\n✗ 有 ${skipped.length} 个测试被跳过。PIX_TEST_STRICT=required 不允许任何跳过。`
    : `\n⚠ 有 ${skipped.length} 个测试被跳过 —— 这些用例本次**没有执行**。`
  log(header)

  if (missing.length) {
    log(`  原因：缺少环境变量 ${missing.join(', ')}`)
    log('  修复：eval "$(./scripts/test-env.sh up)"')
  }

  for (const item of skipped) {
    log(`  - [${item.kind}] ${item.path}  (${item.reason})`)
  }

  if (mode === 'required') return { code: 1, skipped, missing }
  log('  （本地模式仅警告；发布前请用 PIX_TEST_STRICT=required 复跑）\n')
  return { code: 0, skipped, missing }
}

module.exports = { collectSkippedFromTap, missingDependencies, enforce }
