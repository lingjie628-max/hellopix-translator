'use strict'

/**
 * IPC 注册器：安全基座的测试。
 *
 * 这一层的存在意义就是"让越权 handler 写不出来"，所以测试必须证明：
 *   · 默认注册的 handler 拒绝一切非主界面来源
 *   · 重复注册会立刻炸（拆分 handler 时的高频事故）
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { createIpcRegistrar } = require('../desktop/src/ipc/registrar')

function harness () {
  const registered = {}
  const ipcMain = {
    handle: (ch, fn) => {
      if (registered[ch]) throw new Error('Attempted to register a second handler')
      registered[ch] = fn
    }
  }
  const rejected = []
  const reg = createIpcRegistrar({
    ipcMain,
    isMainSender: e => !!(e && e.trusted),
    rejectUntrustedSender: (msg) => { rejected.push(msg); return { success: false, msg: '来源不可信' } }
  })
  return { reg, registered, rejected }
}

test('受保护的 handler 对不可信来源直接拒绝，且不执行业务逻辑', async () => {
  const { reg, registered, rejected } = harness()
  let ran = false
  reg.handle('x:safe', () => { ran = true; return { ok: 1 } })

  const r = await registered['x:safe']({ trusted: false }, 'arg')
  assert.equal(r.success, false)
  assert.equal(ran, false, '校验失败时业务代码一次都不能跑')
  assert.equal(rejected.length, 1)
})

test('可信来源正常执行，参数原样透传', async () => {
  const { reg, registered } = harness()
  reg.handle('x:safe', (event, a, b) => ({ a, b, t: event.trusted }))
  assert.deepEqual(await registered['x:safe']({ trusted: true }, 1, 2), { a: 1, b: 2, t: true })
})

test('handler 抛错时异常照常冒泡（不能吞掉变成 undefined）', async () => {
  const { reg, registered } = harness()
  reg.handle('x:boom', () => { throw new Error('boom') })
  await assert.rejects(() => registered['x:boom']({ trusted: true }), /boom/)
})

test('handleUnsafe 不做来源校验 —— 这是显式决策', async () => {
  const { reg, registered, rejected } = harness()
  let seen = null
  reg.handleUnsafe('x:open', event => { seen = event; return { ok: 1 } })
  const r = await registered['x:open']({ trusted: false })
  assert.equal(r.ok, 1)
  assert.equal(seen.trusted, false)
  assert.equal(rejected.length, 0)
})

test('重复注册同名频道会立即抛错，并指出是哪个频道', () => {
  const { reg } = harness()
  reg.handle('dup:ch', () => {})
  assert.throws(() => reg.handle('dup:ch', () => {}), /IPC 频道重复注册：dup:ch/)
})

test('受保护与 unsafe 之间也不能重名', () => {
  const { reg } = harness()
  reg.handle('dup:ch', () => {})
  assert.throws(() => reg.handleUnsafe('dup:ch', () => {}), /重复注册/)
})

test('channels() 报告本注册器注册过的全部频道', () => {
  const { reg } = harness()
  reg.handle('a:1', () => {})
  reg.handleUnsafe('b:2', () => {})
  assert.deepEqual(reg.channels().sort(), ['a:1', 'b:2'])
})
