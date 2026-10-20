'use strict'

/**
 * 客户端诊断模块（日志 / 崩溃上报 / 内存采样）。
 *
 * 这三段是启动路径上的代码。它们出问题的表现不是报错，而是
 * **应用启动变慢**或**该留下的证据没留下**——两者单测都很难发现，
 * 所以这里专挑"硬约束"来钉：
 *
 *   · 采样必须异步起步（同步跑会在 macOS 上卡 3 秒）
 *   · 上报必须不 await（网络不通不能拖住启动）
 *   · 上报失败必须完全静默（线路不通是常态，不该变成新噪音）
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const d = require('../desktop/src/stability/client-diagnostics')

const tick = () => new Promise(r => setImmediate(r))

// ------------------------------------------------------------ startMemorySampling

test('★ 内存采样首拍必须延迟 ~1 秒，不能同步跑', async () => {
  // macOS 上摸内存要 execSync vm_stat，系统繁忙时最长卡 3 秒。
  // 若同步执行，用户看到的就是"双击了没反应"。
  const calls = []
  const log = { info: (...a) => calls.push(a) }
  const timer = d.startMemorySampling({
    memoryPressure: () => ({ ratio: 0.5, used: 100, total: 200, source: 'test' }),
    tabCount: () => 0
  }, log)
  assert.equal(calls.length, 0, '同步阶段一条都不该写 —— 说明 tick 被同步执行了')
  clearInterval(timer)
})

test('★ 采样的两个定时器都要 unref（不能吊住进程退出）', () => {
  const timer = d.startMemorySampling({
    memoryPressure: () => ({ ratio: 0.5, used: 1, total: 2, source: 't' }),
    tabCount: () => 1
  }, { info () {} })
  assert.ok(timer, '应当返回 interval 句柄')
  // unref 过的定时器不会阻止进程退出；node 里可以用 hasRef 验证
  assert.equal(timer.hasRef(), false, 'interval 没 unref 的话，关窗口后进程退不掉')
  clearInterval(timer)
})

test('水位不分档就不重复写（避免一天 1440 行噪音）', () => {
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'desktop', 'src', 'stability', 'client-diagnostics.js'), 'utf8')
  assert.match(src, /if \(bucket === lastBucket\) return/,
    '必须在档位没变时直接返回')
  assert.match(src, /Date\.now\(\) - lastAt < 30000/,
    '必须有 30 秒节流，否则窗口抖动会重复写')
})

test('采样：缺依赖时不崩，返回 null', () => {
  assert.equal(d.startMemorySampling({}, { info () {} }), null)
  assert.equal(d.startMemorySampling({ memoryPressure: () => ({}) }, null), null)
})

test('采样：memoryPressure 抛异常也不会打崩进程', async () => {
  let wrote = 0
  const timer = d.startMemorySampling({
    memoryPressure: () => { throw new Error('vm_stat 挂了') },
    tabCount: () => 0
  }, { info () { wrote++ } })
  await new Promise(r => setTimeout(r, 1200))
  clearInterval(timer)
  assert.equal(wrote, 0, '取不到内存数据就不写，但不能崩')
})

test('采样：数据不完整时跳过（total 为 0 不能算出 Infinity%）', async () => {
  let wrote = 0
  const timer = d.startMemorySampling({
    memoryPressure: () => ({ ratio: NaN, used: 0, total: 0, source: 't' }),
    tabCount: () => 0
  }, { info () { wrote++ } })
  await new Promise(r => setTimeout(r, 1200))
  clearInterval(timer)
  assert.equal(wrote, 0)
})

test('采样写出来的内容要能还原现场：百分比 / 实例数 / RSS', async () => {
  const got = []
  const timer = d.startMemorySampling({
    memoryPressure: () => ({ ratio: 0.85, used: 850, total: 1000, source: 'vm_stat' }),
    tabCount: () => 7
  }, { info: (scope, msg) => got.push(scope + ':' + msg) })
  await new Promise(r => setTimeout(r, 1200))
  clearInterval(timer)
  assert.equal(got.length, 1, '首拍应当只写一条')
  const line = got[0]
  assert.match(line, /^memory:/)
  assert.match(line, /85%/, '要写整机百分比')
  assert.match(line, /实例 7 个/, '要写窗口数 —— 崩溃前开了几个是事后唯一能判断的依据')
  assert.match(line, /主进程 RSS \d+MB/, '要写主进程自身占用，才能区分"是我们涨了"还是"整机就这样"')
  assert.match(line, /vm_stat/, '要写口径，否则数字没法解读')
})

// ------------------------------------------------------------ reportCrashIfNeeded

const fakeApp = { getVersion: () => '9.9.9' }

test('★ 崩溃上报绝不能拖住启动：函数本身不同步调用网络', () => {
  let called = 0
  const api = () => { called++; return Promise.resolve() }
  d.reportCrashIfNeeded({
    app: fakeApp,
    crashReport: {
      detectAbnormalExit: () => ({ picked: { lines: ['[crash] x'] } }),
      summarize: () => ({ crashCount: 1, memoryPeak: null }),
      writeMarker () {}
    },
    api
  }, { dir: '/tmp/x', info () {} })
  assert.equal(called, 0, '必须放进 setImmediate —— 同步发就是拿启动速度换诊断')
})

test('崩溃上报：没有异常退出痕迹就不发请求', async () => {
  let called = 0
  d.reportCrashIfNeeded({
    app: fakeApp,
    crashReport: {
      detectAbnormalExit: () => null,
      summarize: () => ({}),
      writeMarker () {}
    },
    api: () => { called++; return Promise.resolve() }
  }, { dir: '/tmp/x', info () {} })
  await tick()
  assert.equal(called, 0, '正常退出 / 首次安装都不该上报')
})

test('崩溃上报：detectAbnormalExit 抛异常时静默返回', () => {
  assert.doesNotThrow(() => {
    d.reportCrashIfNeeded({
      app: fakeApp,
      crashReport: {
        detectAbnormalExit: () => { throw new Error('日志目录读不了') },
        summarize: () => ({}),
        writeMarker () {}
      },
      api: () => Promise.resolve()
    }, { dir: '/tmp/x', info () {} })
  })
})

test('崩溃上报：没有 log 时直接返回', () => {
  let called = 0
  d.reportCrashIfNeeded({
    app: fakeApp, crashReport: {}, api: () => { called++; return Promise.resolve() }
  }, null)
  assert.equal(called, 0)
})

test('★ 崩溃上报失败必须完全静默（不写日志、不弹窗）', async () => {
  const logs = []
  d.reportCrashIfNeeded({
    app: fakeApp,
    crashReport: {
      detectAbnormalExit: () => ({ picked: { lines: ['[crash] x'] } }),
      summarize: () => ({ crashCount: 1, memoryPeak: null }),
      writeMarker () { throw new Error('不能写标记') }
    },
    api: () => Promise.reject(new Error('线路不通'))
  }, { dir: '/tmp/x', info: (s, m) => logs.push(s + m), warn: (s, m) => logs.push('WARN' + s + m) })
  await tick(); await tick(); await tick()
  assert.deepEqual(logs, [], '线路不通是常态，写成 WARN 就成了每个用户都看到的新噪音')
})

test('上报成功后才写标记（否则同一次崩溃每次启动都重传）', async () => {
  let marked = 0
  d.reportCrashIfNeeded({
    app: fakeApp,
    crashReport: {
      detectAbnormalExit: () => ({ picked: { lines: ['[crash] x'] } }),
      summarize: () => ({ crashCount: 2, memoryPeak: 91 }),
      writeMarker: () => { marked++ }
    },
    api: () => Promise.resolve({ obj: {} })
  }, { dir: '/tmp/x', info () {} })
  await tick(); await tick(); await tick()
  assert.equal(marked, 1)
})

test('上报带上网关需要的版本信息', async () => {
  let body
  d.reportCrashIfNeeded({
    app: fakeApp,
    crashReport: {
      detectAbnormalExit: () => ({ picked: { lines: ['[crash] a', '[memory] b'] } }),
      summarize: () => ({ crashCount: 1, memoryPeak: null }),
      writeMarker () {}
    },
    api: (p, opts) => { body = { p, opts }; return Promise.resolve() }
  }, { dir: '/tmp/x', info () {} })
  await tick(); await tick()
  assert.equal(body.p, '/client/crash-report')
  assert.equal(body.opts.form.version, '9.9.9')
  assert.equal(typeof body.opts.form.lines, 'string', 'lines 要以 JSON 字符串塞进单个字段')
  assert.deepEqual(JSON.parse(body.opts.form.lines), ['[crash] a', '[memory] b'])
  // 诊断流量不该和用户操作抢带宽
  assert.ok(body.opts.totalTimeoutMs <= 20000)
})

// ------------------------------------------------------- attachChildProcessWatch

test('子进程崩溃要被记下来，且分清 gpu / utility', () => {
  const handler = { fn: null }
  const app = { on: (evt, fn) => { if (evt === 'child-process-gone') handler.fn = fn } }
  const out = []
  d.attachChildProcessWatch({
    app,
    getLog: () => ({ error: (s, m) => out.push(s + ':' + m) })
  })
  assert.ok(handler.fn, '必须挂 child-process-gone')
  handler.fn({}, { type: 'GPU', reason: 'crashed', exitCode: 1 })
  assert.match(out[0], /^crash:/)
  assert.match(out[0], /type=GPU/, '要记清是哪个进程崩的 —— gpu 崩和白屏直接相关')
})

test('OOM 退出要额外标出来（这是"闪退"最常见的真凶）', () => {
  const handler = { fn: null }
  const out = []
  d.attachChildProcessWatch({
    app: { on: (e, f) => { handler.fn = f } },
    getLog: () => ({ error: (s, m) => out.push(m) })
  })
  handler.fn({}, { type: 'Utility', reason: 'oom', exitCode: 137 })
  assert.match(out[0], /★内存不足/)
})

test('logger 还没建好时收到子进程崩溃，不能抛', () => {
  const handler = { fn: null }
  d.attachChildProcessWatch({
    app: { on: (e, f) => { handler.fn = f } },
    getLog: () => null
  })
  assert.doesNotThrow(() => handler.fn({}, { type: 'GPU', reason: 'crashed' }))
})

// -------------------------------------------------------------- createClientLog

test('createClientLog：userData 取不到时回落到 temp，两个都取不到返回 null', () => {
  const calls = []
  const logFile = {
    createLogger: (dir) => { calls.push(dir); return { dir, info () {}, error () {}, flush () {} } },
    installConsoleBridge () {},
    attachProcessHandlers () {}
  }
  const okApp = { getPath: () => '/tmp/ud' }
  const log = d.createClientLog({ app: okApp, logFile })
  assert.equal(log.dir, path.join('/tmp/ud', 'logs'))

  const noUserData = { getPath: (k) => { if (k === 'userData') throw new Error('no'); return '/tmp/t' } }
  calls.length = 0
  const log2 = d.createClientLog({ app: noUserData, logFile })
  assert.equal(calls[0], path.join('/tmp/t', 'hello-pix-logs'), '取不到 userData 要回落到 temp')

  const broken = { getPath: () => { throw new Error('全挂了') } }
  assert.equal(d.createClientLog({ app: broken, logFile }), null)
})

test('createClientLog：日志写失败走 onFatalError，不能走 console（会回环）', () => {
  const fatal = []
  const logFile = {
    createLogger: (dir, opts) => {
      opts.onError(new Error('磁盘满了'))
      return { dir, info () {}, error () {}, flush () {} }
    },
    installConsoleBridge () {},
    attachProcessHandlers () {}
  }
  d.createClientLog({
    app: { getPath: () => '/tmp/ud' },
    logFile,
    onFatalError: e => fatal.push(e.message)
  })
  assert.deepEqual(fatal, ['磁盘满了'])
})

test('createClientLog：必须把 console 和进程钩子都接上', () => {
  const seen = []
  const logFile = {
    createLogger: (dir) => ({ dir, flush () {}, info () {}, error () {} }),
    installConsoleBridge: (c, l) => seen.push('console'),
    attachProcessHandlers: (p, l, o) => {
      seen.push('process')
      assert.equal(typeof o.flush, 'function', '退出前要能 flush，否则最后几条崩溃日志丢了')
      assert.equal(typeof o.exit, 'function')
    }
  }
  d.createClientLog({ app: { getPath: () => '/tmp/ud', exit () {} }, logFile })
  assert.deepEqual(seen, ['console', 'process'])
})
