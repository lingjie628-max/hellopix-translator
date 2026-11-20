'use strict'

/**
 * health-guard 的纯 Node 单测（不需要 Electron）。
 *
 *   node --test test/health-guard.test.js
 *
 * 这些断言锁的是「行为」而不是实现：
 *   · 哪些错误不该打死进程；
 *   · 崩溃后必须自动重载，且必须按退避；
 *   · 同一视图连续崩太多次必须熔断（否则会变成崩溃→重载→崩溃的死循环）；
 *   · 短窗口内连续启动必须进安全模式；
 *   · 致命错误必须先 relaunch 再退出（用户体感从"消失"变成"闪一下回来了"）。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const { createHealthGuard, isFatal, isRecoverable } = require('../desktop/src/stability/health-guard')

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pix-guard-'))
}

/** 可控定时器：手动推进，避免测试等真实秒数。 */
function fakeTimers() {
  let seq = 0
  let elapsed = 0
  const jobs = new Map()
  return {
    setTimeout(fn, ms) {
      const id = ++seq
      // 记「到期时刻」而不是「延时」—— 否则 run(1000) 两次不会推进到 2000，
      // 退避类断言会永远等不到回调（第一版就是这么误报的）。
      jobs.set(id, { fn, at: elapsed + Math.max(0, Number(ms) || 0) })
      return id
    },
    clearTimeout(id) { jobs.delete(id) },
    /** 推进时间：执行所有已到期的任务（按到期顺序）。 */
    run(ms) {
      elapsed += Math.max(0, Number(ms) || 0)
      const due = [...jobs.entries()].filter(([, j]) => j.at <= elapsed)
      due.sort((a, b) => a[1].at - b[1].at)
      for (const [id, job] of due) {
        jobs.delete(id)
        job.fn()
      }
      return due.length
    },
    get size() { return jobs.size }
  }
}

test('网络类错误不致命，未知异常仍然致命', () => {
  assert.equal(isFatal(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), false)
  assert.equal(isFatal(new Error('socket has been ended by the other party')), false)
  assert.equal(isFatal(new Error('net::ERR_PROXY_CONNECTION_FAILED')), false)
  assert.equal(isFatal(new Error('TypeError: x is not a function')), true)
  assert.equal(isFatal(null), true)
})

test('已销毁对象 / 帧被回收这类生命周期错误不该打死进程', () => {
  // 这几条是真机上最常见的「关标签/切代理时整个软件消失」的原因。
  assert.equal(isRecoverable(new Error('Object has been destroyed')), true)
  assert.equal(isRecoverable(new Error('Render frame was disposed')), true)
  assert.equal(isFatal(new Error('Error: Object has been destroyed')), false)
})

test('实例崩溃后按退避自动重载', () => {
  const timers = fakeTimers()
  const events = []
  const guard = createHealthGuard({
    app: {},
    log: { info: (s, m) => events.push(['info', m]), warn: (s, m) => events.push(['warn', m]), error: (s, m) => events.push(['error', m]), fatal: () => {} },
    dir: tmpDir(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  })
  let reloads = 0
  const view = new EventEmitter()
  guard.watchView(view, { id: 'wa-1', reload: () => { reloads++ } })

  view.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
  // 2000ms 之前不该重载
  timers.run(1000)
  assert.equal(reloads, 0)
  timers.run(1000)
  assert.equal(reloads, 1)

  // 第二次崩溃：退避应变成 8000ms
  view.emit('render-process-gone', {}, { reason: 'oom' })
  timers.run(2000)
  assert.equal(reloads, 1, '第二次崩溃不能沿用 2s 退避')
  timers.run(6000)
  assert.equal(reloads, 2)
})

test('主动关闭（killed / clean-exit）不自动重载', () => {
  const timers = fakeTimers()
  const guard = createHealthGuard({ app: {}, dir: tmpDir(), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout })
  let reloads = 0
  const view = new EventEmitter()
  guard.watchView(view, { id: 'wa-2', reload: () => { reloads++ } })
  view.emit('render-process-gone', {}, { reason: 'killed', exitCode: 0 })
  view.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
  timers.run(60000)
  assert.equal(reloads, 0)
})

test('10 分钟内崩太多次要熔断，而不是无限重载', () => {
  const timers = fakeTimers()
  let giveUps = 0
  const guard = createHealthGuard({ app: {}, dir: tmpDir(), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout })
  const view = new EventEmitter()
  guard.watchView(view, { id: 'wa-3', reload: () => {}, giveUp: () => { giveUps++ } })
  for (let i = 0; i < 5; i++) {
    view.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
    timers.run(40000)
  }
  assert.equal(giveUps, 1, '超过阈值后必须放弃并交给界面提示')
})

test('宽限期内仍无响应 → 主动重载；恢复响应则取消', () => {
  const timers = fakeTimers()
  const guard = createHealthGuard({ app: {}, dir: tmpDir(), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout })
  let reloads = 0
  const view = new EventEmitter()
  guard.watchView(view, { id: 'wa-4', reload: () => { reloads++ } })

  view.emit('unresponsive')
  view.emit('responsive')          // 自己缓过来了
  timers.run(20000)
  assert.equal(reloads, 0, '恢复响应后不能再动它')

  view.emit('unresponsive')
  timers.run(12000)
  assert.equal(reloads, 1, '超过宽限期必须主动重载')
})

test('短窗口内连续启动判定为崩溃循环，进入安全模式', () => {
  const dir = tmpDir()
  const timers = fakeTimers()
  let disabledGpu = false
  const app = {
    disableHardwareAcceleration: () => { disabledGpu = true },
    commandLine: { appendSwitch: () => {} }
  }
  // 连着启动三次（每次崩溃都写 crashed=true，且 starts 在窗口内累积）
  for (let i = 0; i < 3; i++) {
    const guard = createHealthGuard({ app, dir, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout })
    const stats = guard.begin()
    if (i < 2) {
      // 模拟「启动后立刻崩」：写 crashed 标记，不写 clean exit
      const { hardExit } = { hardExit: () => guard.hardExit(1) }
      hardExit()
    }
    if (i === 2) {
      assert.equal(stats.starts, 3)
      assert.equal(stats.safeMode, true, '第三次启动必须判定为崩溃循环')
      assert.equal(disabledGpu, true, '安全模式必须关 GPU')
      assert.equal(guard.policy().maxTabs, 2)
    }
  }
})

test('升级到新版本时清掉旧版本留下的崩溃循环计数', () => {
  const dir = tmpDir()
  const oldStarts = [Date.now(), Date.now(), Date.now()]
  fs.writeFileSync(path.join(dir, 'health-state.json'), JSON.stringify({
    version: '1.3.13',
    starts: oldStarts,
    crashed: true
  }))

  const guard = createHealthGuard({ app: {}, dir, version: '1.3.14' })
  const stats = guard.begin()
  assert.equal(stats.starts, 1, '新版本只能从本次启动开始计数')
  assert.equal(stats.safeMode, false, '旧版本的崩溃循环不能把修复版第一次启动按进安全模式')

  const state = JSON.parse(fs.readFileSync(path.join(dir, 'health-state.json'), 'utf8'))
  assert.equal(state.version, '1.3.14')
  assert.equal(state.starts.length, 1)
  assert.equal(state.crashed, false)
})

test('致命错误：先 relaunch 再 exit，并留 crashed 标记', () => {
  const dir = tmpDir()
  let relaunched = 0
  let exited = null
  const app = {
    relaunch: () => { relaunched++ },
    exit: code => { exited = code }
  }
  const guard = createHealthGuard({ app, dir })
  guard.hardExit(1)
  assert.equal(relaunched, 1)
  assert.equal(exited, 0)
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'health-state.json'), 'utf8'))
  assert.equal(state.crashed, true)
})

test('正常退出清掉 crashed 标记，避免下次被误判为崩溃循环', () => {
  const dir = tmpDir()
  const guard = createHealthGuard({ app: {}, dir })
  guard.begin()
  guard.markCleanExit()
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'health-state.json'), 'utf8'))
  assert.equal(state.crashed, false)
})

// ---- 2026-11-08 线上事故回归 ----
// 现象：某台 Mac 打开就闪退/不翻译，服务端收到 11 条「异常退出」。
// 根因：stability-boot 在**单实例锁之前**调用 begin()，用户重复点图标时，
// 第二个进程先把启动计数 +1 再 exit(0)，几次误触就把主进程推进安全模式。
// 下面两条锁死「误触不计数」和「crashed 不留残留」。

test('crashed 标记必须在 begin() 里消费掉，不能残留到下一次启动', () => {
  const dir = tmpDir()
  // 模拟被系统强杀（活动监视器 / 断电）：只留下 crashed=true，没有 clean exit
  fs.writeFileSync(path.join(dir, 'health-state.json'), JSON.stringify({ starts: [], crashed: true }))

  // 第一次重启：读到了 crashed，本次消费掉
  createHealthGuard({ app: {}, dir }).begin()
  let state = JSON.parse(fs.readFileSync(path.join(dir, 'health-state.json'), 'utf8'))
  assert.equal(state.crashed, false, 'begin() 之后 crashed 必须复位')

  // 隔很久再开一次（超过窗口）：绝不能再因为这个残留标记被判循环
  const guard = createHealthGuard({ app: {}, dir })
  const stats = guard.begin()
  assert.equal(stats.safeMode, false, '残留的 crashed 不能把正常重启判成崩溃循环')
})

test('hardExit 自己安排的重启，单次不该判成崩溃循环', () => {
  const dir = tmpDir()
  const app = { relaunch: () => {}, exit: () => {}, disableHardwareAcceleration: () => {}, commandLine: { appendSwitch: () => {} } }

  // 第一次：正常启动 → 主进程致命错误 → hardExit 写 crashed + selfRelaunch 并 relaunch
  createHealthGuard({ app, dir }).begin()
  createHealthGuard({ app, dir }).hardExit(1)

  // 第二次启动（同一个硬重启）：只有 2 次启动、且是我们自己安排的，
  // 不能因为「crashedLast && >=2」就把用户按进安全模式。
  const stats = createHealthGuard({ app, dir }).begin()
  assert.equal(stats.starts, 2)
  assert.equal(stats.safeMode, false, '我们自己 relaunch 的那一次不算崩溃循环')
})

test('但我们自己重启连续发生 3 次，仍然要判循环（真死循环必须抓住）', () => {
  const dir = tmpDir()
  const app = { relaunch: () => {}, exit: () => {}, disableHardwareAcceleration: () => {}, commandLine: { appendSwitch: () => {} } }
  let last = null
  for (let i = 0; i < 3; i++) {
    last = createHealthGuard({ app, dir }).begin()
    createHealthGuard({ app, dir }).hardExit(1)
  }
  assert.equal(last.starts, 3)
  assert.equal(last.safeMode, true, '3 次连续起不来必须进安全模式，不能因为是我们自己重启就放过')
})
