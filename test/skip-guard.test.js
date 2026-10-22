'use strict'

/**
 * 跳过闸门自身的单测。
 *
 * 闸门的职责是"让没跑的测试不再伪装成通过"。它自己出错的后果比不做检查更糟：
 * 全绿但实际一个资金测试都没跑，而人以为有人守着。
 *
 * 所以这里用**合成的 TAP 文本**直接喂 `enforce()`，不依赖真实测试环境：
 * 把判定逻辑从"跑一遍整个套件"里剥出来，才能覆盖到 requried / warn / off
 * 三种模式和各种畸形输入。
 */

const test = require('node:test')
const assert = require('node:assert')

const { enforce, collectSkippedFromTap, missingDependencies } = require('./helpers/skip-guard')

/** 真实 node:test 的 TAP 片段，字段顺序与缩进都照抄 */
const TAP_WITH_SKIPS = `TAP version 13
# Subtest: 结算服务：Shadow / 幂等 / 异常池
ok 1 - 结算服务：Shadow / 幂等 / 异常池 # SKIP
  ---
  duration_ms: 0.5
  ...
# Subtest: 别的测试
ok 2 - 别的测试
  ---
  duration_ms: 1.2
  ...
# Subtest: 待办的事
not ok 3 - 待办的事 # TODO 以后再补
  ---
  duration_ms: 0
  ...
1..3
`

const TAP_ALL_GREEN = `TAP version 13
# Subtest: 一个真跑了的测试
ok 1 - 一个真跑了的测试
  ---
  duration_ms: 2.1
  ...
1..1
`

const FULL_ENV = {
  PIX_TEST_DATABASE_URL: 'postgres://x',
  PIX_TEST_REDIS_URL: 'redis://y'
}

/** 收集日志，避免测试输出被闸门的警告刷屏 */
function harness() {
  const lines = []
  return { lines, log: (text) => lines.push(String(text)) }
}

test('能从 TAP 里认出 SKIP 与 TODO', () => {
  const skipped = collectSkippedFromTap(TAP_WITH_SKIPS)
  assert.equal(skipped.length, 2)
  assert.equal(skipped[0].path, '结算服务：Shadow / 幂等 / 异常池')
  assert.equal(skipped[0].kind, 'skip')
  assert.equal(skipped[1].kind, 'todo')
  assert.equal(skipped[1].reason, '以后再补')
})

test('没有 skip 时什么都不捞', () => {
  assert.deepEqual(collectSkippedFromTap(TAP_ALL_GREEN), [])
})

test('带 SKIP 但括号里是中文说明的也要认', () => {
  const tap = 'ok 1 - 某些测试 # SKIP 需要 PIX_TEST_DATABASE_URL\n'
  const skipped = collectSkippedFromTap(tap)
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].reason, '需要 PIX_TEST_DATABASE_URL')
})

test('★ required 模式：有 skip 就必须返回退出码 1', () => {
  const { lines, log } = harness()
  const verdict = enforce(TAP_WITH_SKIPS, { mode: 'required', env: FULL_ENV, log })
  assert.equal(verdict.code, 1, '环境齐全还跳过 = 代码里有问题，必须红')
  assert.equal(verdict.skipped.length, 2)
  assert.ok(lines.join('\n').includes('不允许任何跳过'))
})

test('★ required 模式：没有 skip 就放行', () => {
  const { log } = harness()
  const verdict = enforce(TAP_ALL_GREEN, { mode: 'required', env: FULL_ENV, log })
  assert.equal(verdict.code, 0)
})

test('warn 模式：有 skip 只警告，不红', () => {
  const { lines, log } = harness()
  const verdict = enforce(TAP_WITH_SKIPS, { mode: 'warn', env: { }, log })
  assert.equal(verdict.code, 0)
  assert.equal(verdict.skipped.length, 2)
  const text = lines.join('\n')
  assert.ok(text.includes('没有执行'), '必须用"没有执行"这种措辞，不能含糊成"跳过"')
  assert.ok(text.includes('test-env.sh up'), '要告诉人怎么修')
  assert.ok(!text.includes('PIX_TEST_DATABASE_URL, PIX_TEST_REDIS_URL') === false,
    '缺的依赖要列出来')
})

test('warn 模式：环境齐全但有 skip 时，不能甩锅给环境变量', () => {
  const { lines, log } = harness()
  enforce(TAP_WITH_SKIPS, { mode: 'warn', env: FULL_ENV, log })
  assert.ok(!lines.join('\n').includes('缺少环境变量'),
    '环境都配好了还报"缺少环境变量"会把人引到错误方向')
})

test('off 模式：完全不检查', () => {
  const { log } = harness()
  const verdict = enforce(TAP_WITH_SKIPS, { mode: 'off', env: {}, log })
  assert.equal(verdict.code, 0)
  assert.deepEqual(verdict.skipped, [])
})

test('mode 缺省时读 PIX_TEST_STRICT', () => {
  const { log } = harness()
  assert.equal(
    enforce(TAP_WITH_SKIPS, { env: Object.assign({ PIX_TEST_STRICT: 'required' }, FULL_ENV), log }).code,
    1)
  assert.equal(
    enforce(TAP_WITH_SKIPS, { env: FULL_ENV, log }).code,
    0, '没设变量时默认 warn')
})

test('missingDependencies 只认两个测试专用变量', () => {
  assert.deepEqual(missingDependencies({}), ['PIX_TEST_DATABASE_URL', 'PIX_TEST_REDIS_URL'])
  assert.deepEqual(missingDependencies(FULL_ENV), [])
  assert.deepEqual(
    missingDependencies({ DATABASE_URL: 'x', REDIS_URL: 'y' }),
    ['PIX_TEST_DATABASE_URL', 'PIX_TEST_REDIS_URL'],
    '生产用的 DATABASE_URL 不算数 —— 拿它连库会把测试数据写进真库')
})

test('空输入不会崩', () => {
  assert.deepEqual(collectSkippedFromTap(''), [])
  assert.deepEqual(collectSkippedFromTap(null), [])
  assert.deepEqual(collectSkippedFromTap(undefined), [])
  const { log } = harness()
  assert.equal(enforce('', { mode: 'required', env: FULL_ENV, log }).code, 0)
})

test('畸形行不能误判成 skip', () => {
  const tap = [
    'ok 1 - 正常测试',
    'ok 2 - 名字里带 SKIP 但不是指令',
    '# 注释里写了 SKIP',
    'ok 3 - 名字里带 # 号 # 但不是指令结尾'
  ].join('\n')
  assert.deepEqual(collectSkippedFromTap(tap), [])
})
