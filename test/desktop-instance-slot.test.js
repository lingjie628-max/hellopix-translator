const { coversFile, missingFromWhitelist } = require('./helpers/whitelist')
'use strict'

/**
 * 多开实例槽位分配的守卫测试。
 *
 * ## 被测的真实缺陷
 *
 * 分区名是 `persist:pix-<用户名>-<平台>-<序号>`，而**序号来自进程内的内存计数器**，
 * `Partitions/` 目录却由所有进程共享。于是两个客户端进程会各自从同样的起点开始数，
 * 给 Telegram 分到**同一个分区名** → 共享 Cookie / LocalStorage / 登录态。
 * "多开"是这个产品的核心卖点，两个窗口互相踢下线是致命的。
 *
 * 另外这组测试盯住一个**升级安全**约束：槽位 1 的分区名必须与历史命名逐字符相同，
 * 否则所有单实例用户升级后会丢掉 Telegram / WhatsApp 登录态（要重新收验证码 / 扫码）。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  acquireSlot,
  releaseSlot,
  slotInfix,
  slotFile,
  processAlive,
  lockIsStale,
  partitionBelongsTo,
  SLOT_MAX
} = require('../desktop/src/window/instance-slot')

const root = path.join(__dirname, '..')

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pix-slot-'))
}

// ---------------------------------------------------------------- 分区命名

test('槽位 1 的分区名与历史命名逐字符一致（升级不能丢登录态）', () => {
  assert.equal(slotInfix(1), '', '槽位 1 不允许加任何中缀')

  // 复刻 main.js 的命名规则，确认和历史线上跑的名字一模一样
  const make = (user, platform, index, slot) =>
    'persist:pix-' + user + '-' + slotInfix(slot) + platform + '-' + index
  assert.equal(make('alice', 'telegram-z', 1, 1), 'persist:pix-alice-telegram-z-1')
  assert.equal(make('alice', 'whatsapp-green', 2, 1), 'persist:pix-alice-whatsapp-green-2')
  assert.equal(make('anon', 'telegram-z', 1, 1), 'persist:pix-anon-telegram-z-1')
})

test('槽位 2+ 带 s<N>- 中缀，因此与槽位 1 天然隔离', () => {
  assert.equal(slotInfix(2), 's2-')
  assert.equal(slotInfix(10), 's10-')
  const make = (slot) => 'persist:pix-alice-' + slotInfix(slot) + 'telegram-z-1'
  assert.notEqual(make(1), make(2))
  assert.equal(make(2), 'persist:pix-alice-s2-telegram-z-1')
})

test('槽位耗尽时的一次性槽位也能生成合法中缀', () => {
  assert.equal(slotInfix('x9f3a1c'), 'x9f3a1c-')
  assert.equal(slotInfix(null), '')
  assert.equal(slotInfix(undefined), '')
  assert.equal(slotInfix(0), '')
})

test('两个槽位拿到的分区名绝不相等（这就是隔离本身）', () => {
  const parts = [1, 2, 3].map(s => 'persist:pix-alice-' + slotInfix(s) + 'telegram-z-1')
  assert.equal(new Set(parts).size, 3, '不同槽位必须产出不同分区名')
})

// ------------------------------------------------------- 分区归属判断（修 bug）

test('分区归属判断能认出真实命名（原来的前缀匹配永远不命中）', () => {
  // 原实现：name.indexOf('pix-' + id + '-') === 0
  // 而实际名字以**用户名**开头，平台在中间 —— 前缀永远对不上。
  const realName = 'pix-alice-telegram-z-1'
  assert.equal(realName.indexOf('pix-telegram-z-') === 0, false,
    '这正是原来的判断方式，它对真实名字返回 false')

  assert.equal(partitionBelongsTo(realName, 'telegram-z'), true, '新实现必须认得出来')
})

test('分区归属判断覆盖所有命名形态', () => {
  const cases = [
    ['pix-alice-telegram-z-1', 'telegram-z', true],
    ['pix-alice-s2-telegram-z-1', 'telegram-z', true],       // 槽位 2
    ['pix-alice-x9f3a1c-telegram-z-1', 'telegram-z', true],  // 一次性槽位
    ['pix-my-account-telegram-z-3', 'telegram-z', true],     // 用户名含 -
    ['pix-alice-whatsapp-green-1', 'whatsapp-green', true],
    ['pix-alice-whatsapp-green-1', 'telegram-z', false],     // 平台不能串
    ['pix-alice-telegram-z-1', 'whatsapp-green', false],
    ['pix-alice-line-1', 'line', true],
    ['pix-alice-linkedin-1', 'line', false],                 // 子串不算
    ['', 'telegram-z', false],
    ['pix-alice-telegram-z-1', '', false]
  ]
  for (const [name, id, want] of cases) {
    assert.equal(partitionBelongsTo(name, id), want, `${name} / ${id}`)
  }
})

// ---------------------------------------------------------------- 槽位分配

// 测试里不可能真的 spawn 一堆进程来占槽位，用一个显式的存活判定代替。
const ALL_ALIVE = () => true
const ALL_DEAD = () => false

test('同一时刻两个进程拿到不同槽位', () => {
  const dir = tmpDir()
  const a = acquireSlot(dir, { pid: 1001, isAlive: ALL_ALIVE })
  const b = acquireSlot(dir, { pid: 1002, isAlive: ALL_ALIVE })
  assert.equal(a.slot, 1)
  assert.equal(b.slot, 2)
  assert.notEqual(a.slot, b.slot)
})

test('槽位号可预测：先到先得，从 1 开始', () => {
  const dir = tmpDir()
  assert.equal(acquireSlot(dir, { pid: 2001, isAlive: ALL_ALIVE }).slot, 1)
  assert.equal(acquireSlot(dir, { pid: 2002, isAlive: ALL_ALIVE }).slot, 2)
  assert.equal(acquireSlot(dir, { pid: 2003, isAlive: ALL_ALIVE }).slot, 3)
})

test('持有者进程已死 → 槽位可被接管（崩溃不会永久占位）', () => {
  const dir = tmpDir()
  const dead = 999999
  assert.equal(processAlive(dead), false, '前提：这个 PID 不该存在')

  fs.writeFileSync(slotFile(dir, 1), JSON.stringify({ pid: dead, startedAt: Date.now() }))
  const got = acquireSlot(dir, { pid: 3001, isAlive: ALL_DEAD })
  assert.equal(got.slot, 1, '陈旧锁应被接管，而不是跳到槽位 2')
})

test('持有者进程活着 → 不能抢它的槽位', () => {
  const dir = tmpDir()
  const first = acquireSlot(dir, { pid: 3001, isAlive: ALL_ALIVE })
  assert.equal(first.slot, 1)
  const second = acquireSlot(dir, { pid: 3002, max: 3, isAlive: ALL_ALIVE })
  assert.equal(second.slot, 2, '槽位 1 被活着的人占着，不能被抢')
})

test('锁文件损坏（非 JSON）视为陈旧，可接管', () => {
  const dir = tmpDir()
  fs.writeFileSync(slotFile(dir, 1), 'not json at all')
  assert.equal(acquireSlot(dir, { pid: 4001, isAlive: ALL_ALIVE }).slot, 1)
})

test('超过 7 天的锁无条件视为陈旧（防 PID 复用把槽位永久占死）', () => {
  const now = Date.now()
  const old = { pid: process.pid, startedAt: now - 8 * 24 * 3600 * 1000 }
  assert.equal(lockIsStale(old, now), true, 'PID 活着但锁太老，必须能收回')
  const fresh = { pid: process.pid, startedAt: now - 1000 }
  assert.equal(lockIsStale(fresh, now), false)
  assert.equal(lockIsStale(null, now), true)
})

test('槽位全满 → 退化为一次性随机槽位，绝不复用别人的分区', () => {
  const dir = tmpDir()
  // 必须用**活着的** PID 占位：假 PID 会被判为陈旧锁而接管，
  // 那样槽位根本没被占住，测的就不是"满了"这个场景。
  for (let i = 1; i <= 3; i++) acquireSlot(dir, { pid: 5000 + i, max: 3, isAlive: ALL_ALIVE })
  const overflow = acquireSlot(dir, { pid: 5999, max: 3, isAlive: ALL_ALIVE })
  assert.equal(typeof overflow.slot, 'string', '溢出时槽位应是字符串标识')
  assert.match(overflow.slot, /^x[0-9a-f]{6}$/)
  assert.equal(overflow.file, null)
})

test('归还槽位后，下一个进程能拿回同一个（重启恢复登录态）', () => {
  const dir = tmpDir()
  const first = acquireSlot(dir, { pid: process.pid })
  assert.equal(first.slot, 1)
  assert.equal(releaseSlot(first), true)

  // 模拟"关掉再打开"：新进程（同 pid 无所谓）应当拿回槽位 1，
  // 于是分区名不变，Telegram / WhatsApp 登录态得以保留。
  const again = acquireSlot(dir, { pid: process.pid })
  assert.equal(again.slot, 1)
})

test('归还时不会删掉别人接管的锁', () => {
  const dir = tmpDir()
  const mine = acquireSlot(dir, { pid: process.pid })
  // 模拟：我的锁因为超时被别的进程接管了
  fs.writeFileSync(mine.file, JSON.stringify({ pid: 999999, startedAt: Date.now() }))
  assert.equal(releaseSlot(mine), false, '锁已不属于我，不能删')
  assert.equal(fs.existsSync(mine.file), true, '别人的锁必须还在')
})

test('一次性槽位没有锁文件，归还是空操作', () => {
  assert.equal(releaseSlot({ slot: 'xabc123', file: null }), false)
  assert.equal(releaseSlot(null), false)
})

// ------------------------------------------------------------ 集成：真并发

test('模拟两个并发进程：不会撞同一个分区（这就是原始缺陷）', () => {
  const dir = tmpDir()

  // 模拟旧的错误行为：每个进程各自从 1 开始数
  const oldBehaviour = () => 'persist:pix-alice-telegram-z-1'
  assert.equal(oldBehaviour(), oldBehaviour(), '旧实现下两个进程的分区名相同 —— 正是 bug')

  // 新行为：各自抢槽位再命名
  const nameFor = (handle) => 'persist:pix-alice-' + slotInfix(handle.slot) + 'telegram-z-1'
  const a = acquireSlot(dir, { pid: process.pid })
  const b = acquireSlot(dir, { pid: process.pid })
  assert.notEqual(nameFor(a), nameFor(b), '两个实例必须落到不同分区')

  // Telegram + WhatsApp 混合多开同样互不干扰
  const waA = 'persist:pix-alice-' + slotInfix(a.slot) + 'whatsapp-green-1'
  const tgB = 'persist:pix-alice-' + slotInfix(b.slot) + 'telegram-z-1'
  assert.notEqual(waA, tgB)
})

// ------------------------------------------------------------------ 接线守卫

test('main.js 在创建窗口之前就拿到槽位', () => {
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  const acquireAt = main.indexOf('acquireInstanceSlot()')
  const createAt = main.indexOf('createWindow()', main.indexOf('app.whenReady'))
  assert.ok(acquireAt > 0, 'main.js 没有调用 acquireInstanceSlot')
  assert.ok(createAt > acquireAt, '必须在 createWindow 之前拿到槽位，否则分区名已经定死')
  assert.match(main, /releaseSlot\(instanceSlotHandle\)/, '退出时没有归还槽位')
})

test('instance-slot.js 在打包白名单里（漏了会让安装包启动即崩）', () => {
  // main.js require 了它，白名单没覆盖的话打包产物里根本没有这个文件。
  // 白名单现在允许目录通配（src/**/*.js），所以用 coversFile 判断而不是 includes。
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'))
  assert.ok(pkg.build && Array.isArray(pkg.build.files), 'package.json 缺少 build.files')
  assert.ok(coversFile(pkg.build.files, 'src/window/instance-slot.js'), 'instance-slot.js 不在打包白名单覆盖范围内')

  // 顺带保证：main.js 直接 require 的每个本地模块都在白名单里
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  const missing = missingFromWhitelist(main, pkg.build.files, rel => fs.existsSync(path.join(root, 'desktop', rel)))
  assert.deepEqual(missing, [], '这些本地模块被 main.js require 但不在白名单覆盖范围内')
})

test('打包白名单里的模块全部真实存在', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'))
  for (const f of pkg.build.files) {
    if (f.startsWith('!') || f.includes('*')) continue
    assert.ok(fs.existsSync(path.join(root, 'desktop', f)), `build.files 列的 ${f} 不存在`)
  }
})
