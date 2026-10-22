'use strict'

/**
 * 全仓悬空引用守卫。
 *
 * 这条测试把 scripts/scan-dangling.js 的结论钉进测试套件：
 * 只要仓库里出现"引用了某个根本不存在于作用域链里的标识符"，
 * 这里就红，阻断提交。
 *
 * ## 为什么要有这条
 *
 * 2026-10-21 拆分 `production.js`，同一个事故连捅五刀：
 *
 *   `readSettings` / `USDT_TRC20_CONTRACT` / `RECHARGE_TTL_MINUTES`
 *   / `repo`（闭包丢失）/ `crypto` + `mapRow` + `rechargeAmount`
 *
 * 前四刀是我拆 admin 时发现的；后三刀全在 `/userRecharge/create`
 * 这条**下单主路径**上，是拆完之后才被扫描器抓出来的。
 *
 * 每一次都是线上 500，每一次测试都是绿的。
 */

const assert = require('node:assert/strict')
const test = require('node:test')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

test('全仓没有悬空标识符（搬代码搬漏会在这里红）', () => {
  let stdout = ''
  try {
    // 不加 --quiet：干净时也要输出汇总行，下面要断言它
    stdout = execFileSync(process.execPath, [path.join(ROOT, 'scripts/scan-dangling.js')], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    stdout = (err.stdout || '') + (err.stderr || '')
    assert.fail(
      '发现悬空标识符 —— 通常是拆分模块时把函数/常量搬走了，调用点留在了原地。\n'
      + '这类错误语法完全合法，node --check 查不出来，但一执行就 ReferenceError。\n\n'
      + stdout
    )
  }
  assert.ok(/0 处悬空引用/.test(stdout), `扫描输出异常：${stdout}`)
})
