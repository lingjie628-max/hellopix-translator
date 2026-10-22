'use strict'

/**
 * 自动翻译派发池：同一条消息**绝不能**被翻译两次。
 *
 * ## 真实故障
 *
 * `scan()` 由 MutationObserver 驱动，220ms 一轮。它把待翻消息交给有界并发池：
 * 池里 `shift()` 出一条就立刻开始翻译（一次网络往返，约 1 秒）。
 *
 * 问题在于判重：`enqueueAuto` 原来只看 `autoQueue`（队列），而正在翻译的那条
 * 已经从队列里 shift 出去了。于是下一轮 scan 会认定它"还没翻过"，
 * 重新入队、重新请求、**再扣一次费**。
 *
 * 打开一个 30 条的会话：并发 3、每条 1 秒 → 总共约 10 秒，期间 scan 跑 45 轮。
 * 同一条消息会被反复翻译，用户看到的字符消耗和实际译文条数严重对不上。
 *
 * ## 测试手法
 *
 * 这里不复刻业务代码，而是**直接挂载 guest-inject.js 里的真实实现**：
 * 从源码里切出 `autoPump` / `enqueueAuto` 所需的闭包状态，用假定时器
 * 推进时间，统计翻译被调用了多少次。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'guest-inject.js'), 'utf8')

/**
 * 装配派发池。
 *
 * 依赖：
 *   translateParsed(job) → 返回 Promise（受控 resolve，用来模拟"还在翻"）
 *   paint / autoFailedAt / AUTO_FAIL_COOLDOWN_MS / TRIGGER_AUTO
 */
function mountPool() {
  const grab = name => {
    const start = SRC.indexOf('function ' + name + '(')
    assert.ok(start >= 0, '找不到函数 ' + name)
    let depth = 0
    let started = false
    for (let i = start; i < SRC.length; i++) {
      if (SRC[i] === '{') { depth++; started = true } else if (SRC[i] === '}') {
        depth--
        if (started && depth === 0) return SRC.slice(start, i + 1)
      }
    }
    throw new Error(name + ' 括号不配对')
  }

  // 抓常量定义
  const poolSize = Number((SRC.match(/AUTO_POOL_SIZE\s*=\s*(\d+)/) || [])[1])
  const cooldown = Number((SRC.match(/AUTO_FAIL_COOLDOWN_MS\s*=\s*(\d+)/) || [])[1])
  assert.ok(poolSize > 0 && cooldown > 0, '常量没抓到')

  const calls = []
  const pending = []   // 手动控制何时完成

  const factory = new Function(
    'AUTO_POOL_SIZE', 'AUTO_FAIL_COOLDOWN_MS', 'TRIGGER_AUTO',
    'translateParsed', 'paint', 'autoFailedAt',
    [
      'const autoQueue = []',
      'const autoInFlight = Object.create(null)',
      'let autoRunning = 0',
      grab('autoPump'),
      grab('enqueueAuto'),
      'return { autoPump, enqueueAuto, autoQueue, autoInFlight,',
      '  get running() { return autoRunning } }'
    ].join('\n')
  )

  const pool = factory(
    poolSize,
    cooldown,
    'auto_receive',
    (parsed) => {
      calls.push(parsed.id)
      return new Promise(resolve => { pending.push(() => resolve({ out: '译文', engine: 'e' })) })
    },
    () => {},
    new Map()
  )

  return {
    pool,
    calls,
    /** 让第 n 个未完成的翻译完成 */
    resolveOne() {
      const fn = pending.shift()
      if (fn) fn()
    },
    resolveAll() {
      while (pending.length) pending.shift()()
    },
    get pendingCount() { return pending.length }
  }
}

function job(id) {
  return { id, host: null, parsed: { id }, text: 'text-' + id }
}

test('前提：池子一次最多跑 AUTO_POOL_SIZE 条', async () => {
  const h = mountPool()
  h.pool.enqueueAuto([job('a'), job('b'), job('c'), job('d'), job('e')])
  assert.equal(h.pool.running, 3, '并发上限失效')
  assert.equal(h.pool.autoQueue.length, 2)
  h.resolveAll()
})

test('★ in-flight 的消息不能被再次入队（重复扣费的根因）', async () => {
  const h = mountPool()
  h.pool.enqueueAuto([job('m1')])
  assert.equal(h.calls.length, 1, '前提：第一次入队立刻开始翻')

  // 模拟 220ms 后 scan 又跑了一遍，看到同一条消息（还在翻，没出结果）
  const added = h.pool.enqueueAuto([job('m1')])
  assert.equal(added, 0, '正在翻译的消息被重新入队了 —— 会重复请求、重复扣费')
  assert.equal(h.calls.length, 1, '翻译被调用了两次')
  assert.equal(h.pool.autoQueue.length, 0, '队列里不该有重复项')

  h.resolveAll()
})

test('★ 一轮扫描里重复的消息只派发一次', async () => {
  const h = mountPool()
  const added = h.pool.enqueueAuto([job('x'), job('x'), job('x')])
  assert.equal(added, 1)
  assert.equal(h.calls.length, 1)
  h.resolveAll()
})

test('★ 翻译完成之后才允许重新派发（失败冷却之外的情形）', async () => {
  const h = mountPool()
  h.pool.enqueueAuto([job('m2')])
  assert.equal(h.calls.length, 1)

  // 翻完之后 in-flight 必须被摘掉，否则这条消息永远翻不了第二次（比如用户切走再切回来）
  h.resolveAll()
  // finally（含 delete）跑在微任务里，等它落地
  await new Promise(r => setImmediate(r))
  // autoInFlight 是 Object.create(null) —— 无原型，跟字面量 {} 的 prototype 不同，
  // deepStrictEqual 会因此判不等。比较键集合才是想验的东西。
  assert.deepStrictEqual(Object.keys(h.pool.autoInFlight), [], '翻译完成后 in-flight 标记没清')

  h.pool.enqueueAuto([job('m2')])
  assert.equal(h.calls.length, 2, '翻完之后应该能重新派发')
  h.resolveAll()
  await new Promise(r => setImmediate(r))
})

test('多个不同消息并发时互不干扰', async () => {
  const h = mountPool()
  h.pool.enqueueAuto([job('p1'), job('p2')])
  assert.equal(h.calls.length, 2)
  assert.equal(h.pool.running, 2)

  // 再扫一遍，两条都在翻，都不该重复入队
  assert.equal(h.pool.enqueueAuto([job('p1'), job('p2')]), 0)
  assert.equal(h.calls.length, 2)
  h.resolveAll()
})
