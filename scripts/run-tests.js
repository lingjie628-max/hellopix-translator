'use strict'

/**
 * 带跳过闸门的测试运行器。
 *
 * 直接用 `node --test test/*.test.js` 的话，被 skip 的测试不影响退出码：
 * 即使 14 个资金测试全部因"没配库"而跳过，进程照样返回 0。
 * 这个脚本在跑完之后读 TAP 报告，按 `PIX_TEST_STRICT` 决定要不要红。
 *
 * 用法：
 *   node scripts/run-tests.js                             # 本地默认 warn
 *   PIX_TEST_STRICT=required node scripts/run-tests.js    # 发布前 / CI
 *   node scripts/run-tests.js test/foo.test.js            # 只跑指定文件
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { enforce } = require('../test/helpers/skip-guard')

const projectRoot = path.resolve(__dirname, '..')
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['test/*.test.js']
const tapFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pix-tap-')), 'report.tap')

/**
 * 两个 reporter 并存：
 *   - spec → stderr，给人看（带 ✔/✖ 和耗时）
 *   - tap  → 临时文件，给闸门机器读
 *
 * 注意 Node 26 的 `json` reporter 已损坏（会当模块名去 resolve），
 * 所以只能用 tap。这是实测出来的，不是猜的。
 */
const args = [
  '--test',
  '--test-reporter=spec',
  '--test-reporter-destination=stderr',
  '--test-reporter=tap',
  `--test-reporter-destination=${tapFile}`,
  ...targets
]

const result = spawnSync(process.execPath, args, {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
  // 硬超时。测试挂住比测试失败更糟：挂住既不红也不绿，CI 就那么卡着，
  // 人还以为是"跑得慢"。真踩过一次 —— PG 变量指向已关掉的端口，
  // pg 客户端的 connect 超时是无限，整轮挂了 40 分钟。
  timeout: Number(process.env.PIX_TEST_TIMEOUT_MS || 25 * 60 * 1000),
  killSignal: 'SIGKILL'
})

if (result.error && result.error.code === 'ETIMEDOUT') {
  console.error('\n✖ 测试运行超时，已强杀。最后一次连接的目标环境可能已经挂了 —— 先跑 npm run test:env。')
  process.exit(1)
}

const tap = fs.existsSync(tapFile) ? fs.readFileSync(tapFile, 'utf8') : ''
fs.rmSync(path.dirname(tapFile), { recursive: true, force: true })

if (result.status !== 0) {
  // 测试本身就红了。仍然把跳过情况报出来 —— 修一个 bug 时顺便看见
  // "还有 14 个没跑"，比先修完再说更有意义。
  enforce(tap, { mode: 'warn' })
  process.exit(result.status === null ? 1 : result.status)
}

const verdict = enforce(tap)
process.exit(verdict.code)
