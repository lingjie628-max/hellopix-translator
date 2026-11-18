'use strict'

/**
 * 单实例锁。
 *
 * ## 现象（用户报）
 *
 * 「后台进程会重复，例如我打开了一个，再一次点击，它可以打开第二个甚至
 * 第三个，没有那种进程唯一性。」
 *
 * ## 根因
 *
 * `stability-boot.js` 是真正的入口，它在 require('./main.js') 之前做了
 * 一堆事情（启动记账、缓存上限、崩溃恢复链），但**从来没有调用过
 * `app.requestSingleInstanceLock()`**。
 *
 * Electron 的默认行为是**不限制实例数**：双击 N 次就是 N 个完整进程。每个
 * 进程各自持有 userData、各自跑定时器、各自连服务端，用户看到的就是
 * 同一账号被登了多次、凭据互相踢。
 *
 * ## 为什么必须断言"位置"
 *
 * 这个锁**只能**放在 require('./main.js') 之前。main.js 顶部就会创建窗口、
 * 注册 IPC、开始轮询；等到 ready 之后再判断，第二个进程已经完成了大半副作用
 * （抢过实例槽位、写过状态文件），再退出就是脏状态退场。
 *
 * 所以本测试除了断言"调用了"，还要断言调用发生在 require(main.js) 之前 ——
 * 这才是这次事故真正的教训。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const bootSource = fs.readFileSync(
  path.join(__dirname, '..', 'desktop', 'stability-boot.js'), 'utf8')

const mainSource = fs.readFileSync(
  path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8')

/** 去掉注释再断言，避免"注释里写了、代码里没写"的假绿。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const bootCode = stripComments(bootSource)

test('★ 必须调用 requestSingleInstanceLock（缺了它 Electron 就允许多实例）', () => {
  assert.match(bootCode, /app\.requestSingleInstanceLock\(\)/,
    'stability-boot.js 必须请求单实例锁')
})

test('★ 锁必须在 require(\'./main.js\') 之前取得', () => {
  const lockAt = bootCode.indexOf('requestSingleInstanceLock')
  const mainAt = bootCode.lastIndexOf("require('./main.js')")
  assert.ok(lockAt >= 0, '找不到 requestSingleInstanceLock')
  assert.ok(mainAt >= 0, "找不到 require('./main.js')")
  assert.ok(lockAt < mainAt,
    '单实例锁必须早于 require(main.js)：晚于它的话，第二个进程已经建过窗口、抢过槽位了')
})

test('★ 抢不到锁必须立刻退出，且用 0 退出码', () => {
  // 找 if (!gotLock) 之后那一段
  const block = bootCode.match(/if\s*\(\s*!\s*gotLock\s*\)\s*\{([\s\S]*?)\n  \}/)
  assert.ok(block, '找不到 !gotLock 分支')
  const body = block[1]

  assert.match(body, /app\.exit\(0\)/,
    '必须 app.exit(0) 立刻退出。用 exit(1) 会让外层的崩溃计数/启动记账误判成又崩了一次')
  // 退出前不能碰任何磁盘状态
  assert.doesNotMatch(body, /writeFile|mkdir|acquireSlot|readFile/,
    '抢不到锁时不能写任何磁盘状态 —— 那个目录正被第一个实例用着')
})

test('★ 第二个实例被挡下时要唤回已有窗口，而不是再建一个', () => {
  assert.match(bootCode, /app\.on\('second-instance'/,
    '必须监听 second-instance')

  const block = bootCode.match(/app\.on\('second-instance'[^{]*\{([\s\S]*?)\n    \}\)/)
  assert.ok(block, '找不到 second-instance 处理段')
  const body = block[1]

  assert.match(body, /__pixFocusMainWindow/,
    '优先走 main.js 暴露的聚焦钩子（它处理了隐藏/最小化/窗口已销毁三种情况）')

  // 兜底路径：boot 层可能在 main.js 注册钩子之前就收到事件（用户狂点）
  assert.match(body, /BrowserWindow\.getAllWindows/,
    '必须留一条不依赖 main.js 的兜底路径，否则竞态时点了没反应')
  assert.match(body, /\.restore\(\)/, '最小化的窗口要还原')
  assert.match(body, /\.focus\(\)/, '要抢焦点')

  // 第二个实例绝不能自己 createWindow
  assert.doesNotMatch(body, /createWindow\(/,
    'second-instance 里不能新建窗口 —— 那等于又开了个"它"')
})

test('★ 兜底路径必须跳过探测小窗，不能把它掀出来', () => {
  const block = bootCode.match(/app\.on\('second-instance'[^{]*\{([\s\S]*?)\n    \}\)/)
  assert.ok(block)
  const body = block[1]
  // 代理节点检测会建一个 380x260 的隐藏 BrowserWindow，尺寸是唯一稳定特征
  assert.match(body, /width\s*>=\s*600/, '必须按尺寸过滤掉探测窗口')
  assert.match(body, /bounds|getBounds/, '尺寸要从 getBounds 取')
})

test('逃生开关 PIX_ALLOW_MULTI_INSTANCE=1 必须能绕过（排障用）', () => {
  assert.match(bootCode, /PIX_ALLOW_MULTI_INSTANCE/,
    '要留一个不改代码就能临时多开的开关')
  // 开关判断必须包住整个锁逻辑
  const guard = bootCode.match(/if\s*\(\s*!\s*ALLOW_MULTI\s*\)\s*\{([\s\S]*?)require\('\.\/main\.js'\)/)
  assert.ok(guard, 'ALLOW_MULTI 必须包住锁逻辑')
  assert.match(guard[1], /requestSingleInstanceLock/,
    '开关为真时不应再请求锁')
})

test('main.js 必须把 showMainWindow 暴露给 boot 层', () => {
  const mainCode = stripComments(mainSource)
  assert.match(mainCode, /global\.__pixFocusMainWindow\s*=\s*showMainWindow/,
    'main.js 要把聚焦函数挂到 global —— boot 层在 require 它之前就执行完了，拿不到模块导出')
})

test('单实例下仍然是槽位 1，不能破坏历史分区命名（否则用户丢登录态）', () => {
  // instance-slot.js 的约定：槽位 1 = 不加中缀 = 与升级前完全一致
  const slot = require('../desktop/src/window/instance-slot')
  assert.equal(slot.slotInfix(1), '',
    '槽位 1 必须是空中缀，单实例用户升级后不能丢 Telegram / WhatsApp 登录态')
  assert.equal(slot.slotInfix(2), 's2-')
  assert.equal(slot.SLOT_MIN, 1, '第一个实例必须拿槽位 1')
})
