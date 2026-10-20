'use strict'

/**
 * 翻译桥看门狗的**误报修复**（0.1.31）。
 *
 * ## 真机现场（2026-10-16 的 hello-pix 日志）
 *
 * 一个用户装了 **0.1.26**、同时开着 **54 个 WhatsApp 实例**。日志里：
 *
 * ```
 *   实例            报「未启动」      实际就绪        延迟
 *   green-39        20:02:54        20:26:47       1433s
 *   green-48        20:22:28        20:25:26        178s
 *   green-47        20:22:16        20:24:29        133s
 *   green-25        19:30:00        19:32:01        120s
 *   ...
 *   43 个实例报过「未启动」，其中 42 个后来都就绪了
 *   延迟：中位 28 秒，超 8 秒的 35 个
 * ```
 *
 * 结论：**桥没坏，只是慢。** 54 个渲染进程同时装载把 CPU/磁盘瓜分掉，
 * preload 跑完 exec + 首次 IPC 远超 8 秒。
 *
 * 而误报的代价很大 —— 告警文案说「用户输入不会被拦截，按回车就会把原文直接发出去」，
 * 用户看到就不敢用了；侧边栏还挂 ⚠。42 个实例白挂警告，信任就没了。
 *
 * ## 修法
 *
 * 单一死线拆成两段：
 *   · 软线 `BRIDGE_PROBE_MS`(8s)：只记 debug，**不判死、不告警**
 *   · 硬线 `BRIDGE_DEAD_MS`(90s)：仍无消息才判"真未启动"
 * 装载期就抛错（`__pixPreloadError`）仍是**立即判死** —— 那是确凿证据。
 *
 * 这些测试直接对着 main.js 的源码断言，因为看门狗是主进程里的时序逻辑，
 * 起真 Electron 也难稳定复现"并发装载导致慢 30 秒"。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const MAIN = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')

/** 取出 watchdogBridge 的完整函数体。 */
function watchdogBody() {
  const start = MAIN.indexOf('function watchdogBridge(')
  assert.ok(start > 0, '找不到 watchdogBridge')
  // 到下一个顶层 function 定义为止
  const rest = MAIN.slice(start + 10)
  const nextFn = rest.search(/\nfunction [a-zA-Z_$]/)
  return nextFn > 0 ? rest.slice(0, nextFn) : rest
}

// ------------------------------------------------------------------ 两段阈值

test('软线与硬线都存在，且硬线明显大于软线', () => {
  assert.match(MAIN, /const BRIDGE_PROBE_MS = (\d+)/, '软线常量必须保留（老测试也依赖它）')
  assert.match(MAIN, /const BRIDGE_DEAD_MS = (\d+)/, '必须新增硬线常量')
  const soft = Number(/const BRIDGE_PROBE_MS = (\d+)/.exec(MAIN)[1])
  const dead = Number(/const BRIDGE_DEAD_MS = (\d+)/.exec(MAIN)[1])
  assert.equal(soft, 8000, '软线保持 8 秒不变')
  assert.ok(dead >= 60000, '硬线至少 1 分钟，否则覆盖不了真机的中位 28 秒')
  assert.ok(dead <= 300000, '硬线也别太长，真坏了要尽早告诉用户')
  assert.ok(dead > soft, '硬线必须晚于软线')
})

test('硬线 90 秒的依据：覆盖真机中位延迟（28s）的 3 倍以上', () => {
  const dead = Number(/const BRIDGE_DEAD_MS = (\d+)/.exec(MAIN)[1])
  assert.ok(dead >= 28000 * 3, '真机中位 28 秒 —— 硬线短于它的 3 倍就会继续误报')
})

// ------------------------------------------------------------------ 软线不得告警

test('★ 软线到点只记 debug，绝不写 ERROR', () => {
  const body = watchdogBody()
  const softIdx = body.indexOf('bridgeTimer = setTimeout')
  assert.ok(softIdx > 0)
  // 软线回调里到硬线注册之间的片段，不得出现 bridgeReport(..., false, ...)
  const deadIdx = body.indexOf('bridgeDeadTimer = setTimeout')
  assert.ok(deadIdx > softIdx, '硬线必须注册在软线回调内部')
  const softBlock = body.slice(softIdx, deadIdx)
  assert.ok(!/bridgeReport\(\s*tab\.id\s*,\s*false/.test(softBlock),
    '★ 软线里判死就是这个缺陷本身 —— 42 个实例被白挂警告')
  assert.match(softBlock, /clientLog\.debug/, '软线只该记 debug')
  assert.ok(!/clientLog\.error/.test(softBlock), '软线不该写 error 级日志')
})

test('软线日志文案要说明"继续观察"，避免排障时误读成故障', () => {
  const body = watchdogBody()
  const softIdx = body.indexOf('bridgeTimer = setTimeout')
  const deadIdx = body.indexOf('bridgeDeadTimer = setTimeout')
  const softBlock = body.slice(softIdx, deadIdx)
  assert.match(softBlock, /继续观察/, '必须表明这是"再等等"而非"已失败"')
})

// ------------------------------------------------------------------ 硬线才判死

test('★ 硬线到点才判"未启动"', () => {
  const body = watchdogBody()
  const deadIdx = body.indexOf('bridgeDeadTimer = setTimeout')
  const deadBlock = body.slice(deadIdx)
  assert.match(deadBlock, /bridgeReport\(\s*tab\.id\s*,\s*false/, '硬线是唯一该判死的地方')
  assert.match(deadBlock, /未启动|没有与主进程通信/, '结论要人能看懂')
})

test('硬线判死前必须复核"是否已经活了"', () => {
  const body = watchdogBody()
  const deadIdx = body.indexOf('bridgeDeadTimer = setTimeout')
  const deadBlock = body.slice(deadIdx)
  assert.match(deadBlock, /bridgeHealth\.get\(tab\.id\)/, '必须重新查桥状态')
  assert.match(deadBlock, /ok === true/, '已经活了就不能判死')
})

test('硬线判死前也要确认 tab 还活着（用户可能已经关掉了）', () => {
  const body = watchdogBody()
  const deadIdx = body.indexOf('bridgeDeadTimer = setTimeout')
  const deadBlock = body.slice(deadIdx)
  assert.match(deadBlock, /tabs\.includes\(tab\)/, '已关闭的 tab 不该再报警')
})

test('硬线时长是"软线之后还要等"，不是从装载起重新计', () => {
  const body = watchdogBody()
  assert.match(body, /BRIDGE_DEAD_MS\s*-\s*BRIDGE_PROBE_MS/,
    '硬线注册在软线回调里，延迟必须是 DEAD - PROBE，否则总时长会变成 98 秒')
})

// ------------------------------------------------------------------ 立即判死的路径不受影响

test('★ 装载期就抛错（确凿证据）仍然立即判死，不走复核', () => {
  const body = watchdogBody()
  const preloadIdx = body.indexOf('__pixPreloadError')
  assert.ok(preloadIdx > 0, '必须保留这条快速路径')
  // 它在任何 setTimeout 之前
  const firstTimer = body.indexOf('setTimeout')
  assert.ok(preloadIdx < firstTimer, '确凿错误应当立即上报，不必等软线')
})

test('硬线复核时若拿到了 preload 错误，要报真正的原因', () => {
  const body = watchdogBody()
  const deadIdx = body.indexOf('bridgeDeadTimer = setTimeout')
  const deadBlock = body.slice(deadIdx)
  assert.match(deadBlock, /__pixPreloadError/,
    '复核时再查一次 —— 报具体原因比笼统的"没通信"对排障有用得多')
})

// ------------------------------------------------------------------ 资源清理

test('★ destroyTab 必须清掉复核定时器', () => {
  const start = MAIN.indexOf('function destroyTab(tab) {')
  assert.ok(start > 0)
  const body = MAIN.slice(start, start + 2000)
  assert.match(body, /tab\.bridgeDeadTimer/, '不清的话，已销毁的 tab 会白挂 82 秒定时器')
  assert.match(body, /clearTimeout\(tab\.bridgeDeadTimer\)/)
})

test('★ watchdogBridge 入口要幂等（重载时作废上一轮定时器）', () => {
  const body = watchdogBody()
  const firstTimer = body.indexOf('setTimeout')
  const head = body.slice(0, firstTimer)
  assert.match(head, /clearTimeout\(tab\.bridgeTimer\)/, '重入时必须先清旧软线定时器')
  assert.match(head, /clearTimeout\(tab\.bridgeDeadTimer\)/, '重入时必须先清旧硬线定时器')
})

test('两个定时器都要 unref（不能阻止进程退出）', () => {
  const body = watchdogBody()
  // 实际写法：`if (tab.xxx.unref) tab.xxx.unref()`（硬线那个还有前导缩进）
  assert.match(body, /tab\.bridgeTimer\.unref\s*\)\s*tab\.bridgeTimer\.unref\(\)/,
    '软线定时器必须 unref')
  assert.match(body, /tab\.bridgeDeadTimer\.unref\s*\)\s*tab\.bridgeDeadTimer\.unref\(\)/,
    '硬线定时器必须 unref，否则用户关不掉进程')
})

// ------------------------------------------------- 与既有约束不冲突（回归）

test('既有的"不误报 LINE / 自定义网页"约束仍然满足', () => {
  const body = watchdogBody()
  assert.match(body, /if \(!bridgeEnabledFor\(tab\.item\)\) return/)
})

test('既有的告警文案仍然保留（用户要能看懂后果）', () => {
  assert.match(MAIN, /发送翻译与接收翻译都不会生效/)
  assert.match(MAIN, /按回车就会把原文直接发出去/)
})

test('侧边栏 bridgeDown 通路未被破坏', () => {
  // 装配已搬进 src/window/tab-payload.js，这里同时验实现与 main.js 的接线
  const payloadSrc = fs.readFileSync(
    path.join(root, 'desktop', 'src', 'window', 'tab-payload.js'), 'utf8')
  assert.match(payloadSrc, /bridgeDown:\s*bridge/)
  assert.match(MAIN, /bridgeHealth:\s*\{\s*get:/, 'main.js 必须把 bridgeHealth 接进工厂')
  assert.match(MAIN, /translate:bridgeDown/)
})
