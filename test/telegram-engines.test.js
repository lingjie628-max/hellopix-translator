'use strict'

/**
 * 翻译通道挑选的单元测试。
 *
 * 这段逻辑写错的后果是**静默的**：桥接文件里写进一个没接通的通道，
 * 服务端一律 503，而魔改电报的 Provider 按设计"失败就不写译文、不弹错、不崩电报"，
 * 所以现象就是气泡永远不出 [译文] —— 和"编译没成功"完全一样。
 * 真实库里 demo 账号正是这种状态：active_engine_id='deepseek'，而 deepseek 没有接通。
 *
 * 这里用的 engines 报文形状取自 core-service.js 的 engines()：
 *   { wired, activeEngine, rows: [{ id, name, wired, enabled, allowed, active }] }
 */

const assert = require('node:assert/strict')
const test = require('node:test')
const { usableEngines, resolveEngine, engineState } = require('../standalone/telegram-win/lib/engines')

// 真实库的样子：12 个通道只有 deepseek 接通，账号 activeEngine 却指向没接通的 deepseek。
function realWorldEngines() {
  return {
    wired: true,
    activeEngine: 'deepseek',
    packageTitle: '专业版',
    rows: [
      { id: 'baidu', name: '百度翻译', wired: false, enabled: true, allowed: true, active: false },
      { id: 'deepseek', name: 'DeepSeek 翻译', wired: true, enabled: true, allowed: true, active: false },
      { id: 'deepl', name: 'DeepL 翻译', wired: false, enabled: true, allowed: true, active: false },
      { id: 'deepseek', name: '有道翻译', wired: false, enabled: true, allowed: true, active: true }
    ]
  }
}

test('usableEngines 只保留已接通且启用的通道', () => {
  const rows = usableEngines(realWorldEngines())
  assert.deepEqual(rows.map(row => row.id), ['deepseek'])
})

test('usableEngines 过滤掉 enabled=false，即使已接通', () => {
  const rows = usableEngines({
    rows: [
      { id: 'a', wired: true, enabled: true },
      { id: 'b', wired: true, enabled: false },
      { id: 'c', wired: false, enabled: true }
    ]
  })
  assert.deepEqual(rows.map(row => row.id), ['a'])
})

test('账号 activeEngine 指向死通道时，绕开它挑已接通的', () => {
  // 这是真实库 demo 账号的状态：activeEngine=deepseek（未接通）。
  // 如果实现直接采信 activeEngine，气泡就永远不出译文。
  assert.equal(resolveEngine(realWorldEngines(), ''), 'deepseek')
  assert.equal(resolveEngine(realWorldEngines(), 'deepseek'), 'deepseek')
  assert.equal(resolveEngine(realWorldEngines(), 'deepl'), 'deepseek')
})

test('用户存的通道已接通时保持不变（不擅自改用户的选择）', () => {
  const engines = {
    activeEngine: 'deepseek',
    rows: [
      { id: 'deepseek', wired: true, enabled: true },
      { id: 'gpt', wired: true, enabled: true },
      { id: 'deepseek', wired: false, enabled: true }
    ]
  }
  assert.equal(resolveEngine(engines, 'gpt'), 'gpt')
})

test('用户存的通道还在，就优先于后台 activeEngine', () => {
  const engines = {
    activeEngine: 'gpt',
    rows: [
      { id: 'deepseek', wired: true, enabled: true },
      { id: 'gpt', wired: true, enabled: true }
    ]
  }
  assert.equal(resolveEngine(engines, 'deepseek'), 'deepseek')
})

test('没有已接通通道时返回空串，交给服务端按 falsy 回退', () => {
  // basic 套餐就是这个状态：套餐里一个 wired 的通道都没有。
  // 返回空串 => C++ 发 engine= 空值 => core-service 里 "" 是 falsy，
  // 回退到 activeEngineId。比硬编码一个死通道安全。
  const basic = {
    wired: false,
    activeEngine: 'deepseek',
    rows: [
      { id: 'baidu', wired: false, enabled: true },
      { id: 'deepseek', wired: false, enabled: true }
    ]
  }
  assert.equal(resolveEngine(basic, ''), '')
  assert.equal(resolveEngine(basic, 'deepseek'), '')
  assert.equal(resolveEngine(basic, 'deepl'), '')
})

test('完全没问到后台时保留用户存的值（离线不擅自清空）', () => {
  assert.equal(resolveEngine(null, 'deepseek'), 'deepseek')
  assert.equal(resolveEngine(undefined, ''), '')
  assert.equal(resolveEngine({}, 'gpt'), 'gpt')
})

test('通道 id 一律转成字符串，避免上游给数字时类型不一致', () => {
  const engines = { rows: [{ id: 7, wired: true, enabled: true }] }
  assert.equal(resolveEngine(engines, ''), '7')
  assert.equal(resolveEngine(engines, '7'), '7')
})

test('engineState 只把已接通的通道暴露给侧栏', () => {
  const state = engineState(realWorldEngines())
  assert.equal(state.known, true)
  assert.equal(state.wired, true)
  assert.deepEqual(state.rows, [{ id: 'deepseek', name: 'DeepSeek 翻译' }])
})

test('engineState 在没有可用通道时明确区分"问过了"和"没问到"', () => {
  // 侧栏据此给不同提示：前者让用户去后台接通通道，后者提示连不上后台。
  const known = engineState({ wired: false, rows: [{ id: 'deepseek', wired: false, enabled: true }] })
  assert.equal(known.known, true)
  assert.equal(known.wired, false)
  assert.deepEqual(known.rows, [])

  const unknown = engineState(null)
  assert.equal(unknown.known, false)
  assert.equal(unknown.wired, false)
})

test('通道缺 name 时回落到 id，侧栏不会渲染出空选项', () => {
  const state = engineState({ rows: [{ id: 'deepseek', wired: true, enabled: true }] })
  assert.deepEqual(state.rows, [{ id: 'deepseek', name: 'deepseek' }])
})
