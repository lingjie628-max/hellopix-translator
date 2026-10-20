/**
 * 登录页线路选择（lines.js）的语义测试。
 *
 * ## 为什么不只查源码字符串
 *
 * 线路这块真正会出错的地方都在**状态流转**上，而且全都是"不报错但行为不对"：
 *   · 只有一条线路时没锁死 → 照样走 ping，多等一轮网络才登录；
 *   · resetLines() 之后又调 renderLines() → 单线路时把 preferAuto 推回 true，
 *     退出登录后"自动选择"神秘复活；
 *   · 选"自动"时高亮却落在上一条手工线路上。
 * 这些用 grep 一个都抓不到，所以这里把 lines.js + pure.js 放进 vm 真的跑。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const renderer = name => fs.readFileSync(path.join(root, 'desktop', 'renderer', name), 'utf8')

/** 最小 DOM：lineMenu 记录追加了哪些行，其它只要能 hold 住属性。 */
function makeContext (pixOverrides) {
  const appended = []
  const classes = new Set()
  // 返回**新对象但属性可写**：lines.js 会往 textContent/className 上写，
  // 用同一个惰性对象会让断言读到上一个用例的残留值。
  const el = () => ({
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      toggle: () => {},
      contains: c => classes.has(c)
    },
    style: {}, dataset: {}, innerHTML: '', textContent: '', className: '',
    setAttribute () {}, appendChild (child) { appended.push(child) }, focus () {},
    closest: () => null, children: []
  })
  const ctx = vm.createContext({
    document: { createElement: () => el(), querySelector: () => null },
    console: { log () {}, warn () {}, error () {} },
    setTimeout () {}, clearTimeout () {}, setInterval () { return 1 }, clearInterval () {},
    esc: s => String(s == null ? '' : s),
    lineDd: el(), lineMenu: el(), lineTriggerName: el(), lineTriggerMs: el(),
    loginScreen: el(),
    window: { pix: Object.assign({
      pingAll: () => Promise.resolve({ rows: [], best: null }),
      selectLine: () => Promise.resolve({})
    }, pixOverrides) }
  })
  vm.runInContext(renderer('pure.js'), ctx, { filename: 'pure.js' })
  vm.runInContext(renderer('lines.js'), ctx, { filename: 'lines.js' })
  return { ctx, appended, classes }
}

const run = (ctx, code) => vm.runInContext(code, ctx)

test('★ 只有一条线路时锁死它，并且不渲染"自动选择"', () => {
  const { ctx, appended } = makeContext()
  run(ctx, "setLineRows([{ id: 'cn', name: '默认线路', ms: 20 }])")
  assert.equal(run(ctx, 'preferAuto'), false, '单线路不该还留着自动模式')
  assert.equal(run(ctx, 'selectedId'), 'cn')
  // 整个选择器被隐藏，所以菜单里一条都不该有（尤其是"自动选择"）。
  // 这正是原实现的行为，别"顺手"补一行进去 —— 隐藏的菜单没人点，
  // 补上去只会多一份要维护的渲染路径。
  assert.equal(appended.length, 0, '单线路时下拉菜单不该渲染任何行')
  assert.equal(run(ctx, 'lineTriggerName.textContent'), '默认线路', '触发器仍要显示实际用的那条')
})

test('★ 多条线路时提供"自动选择"且默认选中它', () => {
  const { ctx, appended } = makeContext()
  run(ctx, "setLineRows([{ id: 'cn', name: '国内', ms: 20 }, { id: 'us', name: '美国', ms: 180 }])")
  assert.equal(run(ctx, 'preferAuto'), true)
  const html = appended.map(r => r.innerHTML).join('|')
  assert.match(html, /自动选择/)
  // 第一行是"自动选择"，应该带 active
  assert.match(appended[0].className, /active/)
})

test('★ 选"自动"时高亮落在自动上，而不是上一条手工线路', () => {
  const { ctx } = makeContext()
  run(ctx, "setLineRows([{ id: 'cn', name: '国内' }, { id: 'us', name: '美国' }])")
  run(ctx, "selectedId = 'cn'") // 之前手工选过国内
  assert.equal(run(ctx, "isActive('auto')"), true)
  assert.equal(run(ctx, "isActive('cn')"), false, '选了自动之后不该还高亮手工线路')
})

test('resetLines() 把状态归零，且不会因为单线路又被推回去', () => {
  const { ctx } = makeContext()
  run(ctx, "setLineRows([{ id: 'cn', name: '国内' }, { id: 'us', name: '美国' }])")
  run(ctx, "chooseLine('us')")
  assert.equal(run(ctx, "selectedId"), 'us')
  run(ctx, 'resetLines()')
  assert.equal(run(ctx, 'preferAuto'), true)
  assert.equal(run(ctx, 'selectedId'), 'auto')
  assert.equal(run(ctx, 'fastest'), null)
})

test('★ 单线路的锁定状态在 resetLines + refreshLinesView 后依然成立', () => {
  // 这正是退出登录时的顺序：先 resetLines() 再重绘。
  // 如果重绘时把 preferAuto 推回 true，"自动选择"就会在没有选项时复活。
  const { ctx } = makeContext()
  run(ctx, "setLineRows([{ id: 'cn', name: '默认线路' }])")
  run(ctx, 'resetLines()')
  run(ctx, 'refreshLinesView()')
  assert.equal(run(ctx, 'preferAuto'), false)
  assert.equal(run(ctx, 'selectedId'), 'cn')
})

test('pingAll 失败时清掉 pending，不让界面永远转圈', async () => {
  const { ctx } = makeContext({ pingAll: () => Promise.resolve(null) })
  run(ctx, "setLineRows([{ id: 'a', name: 'A' }, { id: 'b', name: 'B', pending: true }])")
  await run(ctx, 'pingAll(false)')
  assert.equal(run(ctx, 'lineRows.every(l => !l.pending)'), true)
  assert.equal(run(ctx, 'fastest'), null)
})

test('pingAll 成功时记录最快线路', async () => {
  const { ctx } = makeContext({
    pingAll: () => Promise.resolve({ rows: [{ id: 'a', ms: 90 }, { id: 'b', ms: 30 }], best: { id: 'b' } })
  })
  run(ctx, "setLineRows([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])")
  const best = await run(ctx, 'pingAll(true)')
  assert.equal(best.id, 'b')
  assert.equal(run(ctx, 'fastest.id'), 'b')
  assert.equal(run(ctx, 'lineRows.length'), 2)
})

test('pickLine：手工指定时下发选中的线路，且不测速', async () => {
  const calls = []
  const { ctx } = makeContext({ selectLine: id => { calls.push(id); return Promise.resolve({}) } })
  run(ctx, "setLineRows([{ id: 'cn', name: '国内' }, { id: 'us', name: '美国' }])")
  run(ctx, "chooseLine('us')")
  await run(ctx, 'pickLine()')
  // chooseLine 下发一次（点一下立刻生效），pickLine 登录前再确认一次。
  // 主进程的 lines:select 是幂等的（只保存配置），所以这不是重复负担；
  // 但测试里要把这个约定钉住 —— 谁要是删掉其中一处，这里会立刻反映出来。
  assert.deepEqual(calls, ['us', 'us'])
})

test('★ pickLine：自动模式下一条都不通时要抛错', async () => {
  // 静默带着空线路去登录，用户会收到一个看起来毫不相关的鉴权失败
  const { ctx } = makeContext({ pingAll: () => Promise.resolve({ rows: [], best: null }) })
  run(ctx, "setLineRows([{ id: 'cn', name: '国内' }, { id: 'us', name: '美国' }])")
  await assert.rejects(() => run(ctx, 'pickLine()'), /线路暂时连不上/)
})

test('测速轮询只在登录页可见时打接口', async () => {
  // loginScreen 处于 hidden 时不该再 ping —— 否则进主界面后每 8 秒白打一次
  let pings = 0
  const ctx = vm.createContext({
    document: { createElement: () => ({ classList: { add () {}, remove () {}, toggle () {}, contains () {} }, style: {}, dataset: {}, appendChild () {} }), querySelector: () => null },
    console: { log () {}, warn () {}, error () {} },
    esc: s => String(s == null ? '' : s),
    lineDd: { classList: { remove () {}, toggle () {}, add () {} }, closest: () => null },
    lineMenu: { appendChild () {}, innerHTML: '' },
    lineTriggerName: { textContent: '' }, lineTriggerMs: { textContent: '', className: '' },
    loginScreen: { classList: { contains: c => c === 'hidden' } },
    window: { pix: { pingAll: () => { pings++; return Promise.resolve({ rows: [], best: null }) }, selectLine: () => Promise.resolve({}) } }
  })
  let tick = null
  ctx.setInterval = (fn) => { tick = fn; return 1 }
  ctx.clearInterval = () => {}
  vm.runInContext(renderer('pure.js'), ctx)
  vm.runInContext(renderer('lines.js'), ctx)
  vm.runInContext('setLineRows([{ id: "a", name: "A" }, { id: "b", name: "B" }])', ctx)
  const before = pings
  vm.runInContext('startSpeedWatch()', ctx)
  const afterStart = pings
  tick()
  assert.equal(pings, afterStart, '登录页不可见时轮询不该发请求')
  assert.ok(afterStart > before, '启动时应立即测一次')
})
