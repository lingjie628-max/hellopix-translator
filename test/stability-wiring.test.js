'use strict'

/**
 * stability-wiring 单测（纯 Node，不需要 Electron）：
 *   node --test test/stability-wiring.test.js
 *
 * 锁三件事：
 *   · 不改 main.js 也能把 log-file 的「异常就 exit」换成「异常就重启」；
 *   · 包装必须幂等（热重启不会越包越深）；
 *   · 哪些 webContents 该装恢复链、哪些必须放过（DevTools / 离屏）。
 */

const test = require('node:test')
const assert = require('node:assert')

const wiring = require('../desktop/stability-wiring')

function fakeGuard() {
  return {
    fatalCalls: [],
    exitCalls: [],
    isFatal(error) {
      this.fatalCalls.push(error)
      // 用一个可辨认的判据，证明真的走到了注入的版本上
      return !(error && error.code === 'ECONNRESET')
    },
    hardExit(code) {
      this.exitCalls.push(code)
      return true
    }
  }
}

test('包装之后：致命判定与退出动作都被替换（main.js 不用改）', () => {
  const captured = []
  const logFile = {
    attachProcessHandlers(proc, logger, options) {
      captured.push(options)
      return 'ok'
    }
  }
  const guard = fakeGuard()
  assert.equal(wiring.wrapAttachProcessHandlers(logFile, guard), true)

  const fakeProcess = { on() {} }
  logFile.attachProcessHandlers(fakeProcess, {}, { flush: () => {}, exit: () => 'OLD' })

  assert.equal(captured.length, 1)
  const opts = captured[0]
  assert.equal(typeof opts.isFatal, 'function', '必须注入 isFatal')
  assert.equal(typeof opts.exit, 'function', '必须注入 exit')

  // 注入后的 exit 走 guard.hardExit（重启），而不是原来的 app.exit
  opts.exit(1)
  assert.deepEqual(guard.exitCalls, [1])

  // 注入后的 isFatal 走 guard 的判据
  assert.equal(opts.isFatal({ code: 'ECONNRESET' }), false)
  assert.equal(opts.isFatal(new Error('boom')), true)
  assert.equal(guard.fatalCalls.length, 2)
})

test('重复包装是幂等的（不会把方法套娃）', () => {
  const logFile = { attachProcessHandlers() {} }
  const guard = fakeGuard()
  wiring.wrapAttachProcessHandlers(logFile, guard)
  const first = logFile.attachProcessHandlers
  wiring.wrapAttachProcessHandlers(logFile, guard)
  assert.equal(logFile.attachProcessHandlers, first)
})

test('结构不对的 logFile 不会抛错（老版本兼容）', () => {
  assert.equal(wiring.wrapAttachProcessHandlers(null, fakeGuard()), false)
  assert.equal(wiring.wrapAttachProcessHandlers({}, fakeGuard()), false)
})

test('该装的装：window / browserView / webview', () => {
  for (const type of ['window', 'browserView', 'webview']) {
    assert.equal(wiring.shouldWatch({ getType: () => type }), true, type)
  }
})

test('不该装的放过：remote(DevTools) / offscreen / 没有类型', () => {
  for (const type of ['remote', 'offscreen', '', 'browser']) {
    assert.equal(wiring.shouldWatch({ getType: () => type }), false, type)
  }
  assert.equal(wiring.shouldWatch(null), false)
  assert.equal(wiring.shouldWatch({}), false)
  assert.equal(wiring.shouldWatch({ getType() { throw new Error('destroyed') } }), false)
})

test('日志标签：主机名 + webContents id', () => {
  const wc = { id: 42, getURL: () => 'https://web.whatsapp.com/' }
  assert.equal(wiring.labelOf(wc), 'web.whatsapp.com#42')

  const blank = { id: 7, getURL: () => '' }
  assert.equal(wiring.labelOf(blank), 'view#7')

  const broken = { id: 9, getURL() { throw new Error('gone') } }
  assert.equal(wiring.labelOf(broken), 'view#9')
})

test('熔断错误页：data URL、含错误码、对 HTML 做了转义', () => {
  const page = wiring.buildGiveUpPage({ code: 'crash-loop', title: '崩溃 <script>', hint: '请联系客服 & 重开' })
  assert.ok(page.startsWith('data:text/html'), '必须是 data URL（不依赖网络）')
  const decoded = decodeURIComponent(page.replace('data:text/html;charset=utf-8,', ''))
  assert.ok(decoded.includes('crash-loop'), '错误码必须露出，便于用户复述')
  assert.ok(decoded.includes('&lt;script&gt;'), '标题必须转义，不能被当 HTML 执行')
  assert.ok(decoded.includes('&amp;'))
  assert.ok(decoded.includes('重新加载'))
})
