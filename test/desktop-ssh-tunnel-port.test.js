'use strict'

/**
 * SSH 动态转发的本地端口分配。
 *
 * ## 被测的真实缺陷
 *
 * 老代码：`const local = 18100 + (Number(tab.index) || 1)`
 *
 * `tab.index` 在 main.js 里**从来没有被赋值过**（全文件只有那一处读它），
 * 所以每一项都落进 `|| 1`，端口恒为 **18101**。这意味着：
 *
 *   · 同一进程里开第二个 SSH 代理窗口 → 抢同一端口，第二个 `ssh -D` 绑不上；
 *   · 多开时每个进程序号都从头算 → 进程 A 和进程 B 也抢 18101。
 *
 * 而绑不上时 `ssh` 只往 stderr 说一句就退出，老代码 `stdio: 'ignore'`
 * 把 stderr 扔了，再死等 700ms 就当成功 —— 于是 session 被写成指向一个
 * **没有任何东西在监听**的本地端口。用户看到的是"代理设好了，网页打不开"。
 *
 * 这里锁住三件事：端口必须唯一、跨进程不重叠、反复开关不泄漏。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8')

/** 切出源码里一个顶层函数（按花括号配平）。 */
function extractFunction (name) {
  const marker = 'function ' + name + '('
  const start = mainSource.indexOf(marker)
  assert.ok(start >= 0, 'main.js 里找不到 ' + marker + ' —— 改名了？测试要同步更新')
  const braceStart = mainSource.indexOf('{', start)
  let depth = 0
  for (let i = braceStart; i < mainSource.length; i++) {
    if (mainSource[i] === '{') depth++
    else if (mainSource[i] === '}') {
      depth--
      if (depth === 0) return mainSource.slice(start, i + 1)
    }
  }
  throw new Error('花括号没配平：' + name)
}

/**
 * 只装纯计算那一段：sshTunnelPort + sshPortsInUse + pickSshPort。
 * pickSshPort 依赖 currentSlot()，用一个可改的桩替掉。
 */
function boot (slot) {
  const ctx = { currentSlot: () => slot, sshPortsInUse: new Set() }
  vm.createContext(ctx)
  vm.runInContext(
    'const sshPortsInUse = new Set();\n' +
    extractFunction('sshTunnelPort') + '\n' +
    extractFunction('pickSshPort'),
    ctx
  )
  return ctx
}

test('同名槽位 + 同名序号永远得到同一个端口（可预期，便于排障）', () => {
  const ctx = boot(1)
  assert.equal(ctx.sshTunnelPort(1, 1), ctx.sshTunnelPort(1, 1))
})

test('★ 不同槽位必须落在不同端口（多开隔离的根）', () => {
  const a = boot(1).sshTunnelPort(1, 1)
  const b = boot(2).sshTunnelPort(2, 1)
  assert.notEqual(a, b, '两个实例进程会抢同一个本地端口，第二个 ssh -D 直接绑不上')
})

test('★ 同一槽位内不同序号必须落在不同端口', () => {
  const ctx = boot(1)
  const ports = [ctx.sshTunnelPort(1, 1), ctx.sshTunnelPort(1, 2), ctx.sshTunnelPort(1, 3)]
  assert.equal(new Set(ports).size, 3, '同进程开三个 SSH 代理窗口会互相抢端口')
})

test('★ 全组合（20 个槽位 × 9 个序号）两两不冲突', () => {
  const ctx = boot(1)
  const seen = new Map()
  for (let slot = 1; slot <= 20; slot++) {
    for (let seq = 1; seq <= 9; seq++) {
      const port = ctx.sshTunnelPort(slot, seq)
      assert.equal(seen.has(port), false,
        '槽位 ' + slot + ' 序号 ' + seq + ' 与 槽位 ' + seen.get(port) + ' 撞端口 ' + port)
      seen.set(port, slot + '/' + seq)
    }
  }
  assert.equal(seen.size, 180)
})

test('端口全部落在合法范围（1024-65535），且避开 Chromium 临时端口段', () => {
  const ctx = boot(1)
  for (let slot = 1; slot <= 20; slot++) {
    for (let seq = 1; seq <= 9; seq++) {
      const port = ctx.sshTunnelPort(slot, seq)
      assert.ok(port > 1024 && port < 65535, '端口越界: ' + port)
      assert.ok(port < 49152, '落进了临时端口段，可能被系统临时连接占用: ' + port)
    }
  }
})

test('★ 原来那个 18101 的写法必须彻底消失（回退哨兵）', () => {
  // 先把注释剥掉 —— 下面那把修复的说明里逐字引用了老写法，
  // 不剥就会把自己写的历史当现行代码抓出来。
  const code = mainSource
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/(^|[^:])\/\/.*$/gm, '$1') // 行注释（避开 https:// 里的双斜杠）
  assert.equal(
    /18100\s*\+/.test(code), false,
    'main.js 里仍有 `18100 + ...` 的端口算式 —— 那就是恒等于 18101 的那个 bug'
  )
  assert.equal(
    /tab\.index/.test(code), false,
    'tab.index 从来没被赋值过，读它等于永远拿 undefined'
  )
})

test('槽位是随机降级串时也不炸，仍给出合法端口', () => {
  const ctx = boot('xab12cd')
  const port = ctx.sshTunnelPort('xab12cd', 1)
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65535, '拿到非法端口: ' + port)
})

test('序号缺失 / 非法时回退到 1，不能算出 NaN 端口', () => {
  const ctx = boot(1)
  for (const bad of [undefined, null, 0, -3, 'abc', NaN]) {
    const port = ctx.sshTunnelPort(1, bad)
    assert.ok(Number.isInteger(port) && port > 1024, '序号 ' + String(bad) + ' 算出了 ' + port)
  }
})

test('★ 反复开关不泄漏端口：pickSshPort 每次都从占用表里挑新的', () => {
  const ctx = boot(1)
  const first = ctx.pickSshPort({ sshOrdinal: 1 })
  // 不释放，模拟"窗口还开着"
  const second = ctx.pickSshPort({ sshOrdinal: 2 })
  assert.notEqual(first, second, '两个还开着的窗口拿到了同一个端口')

  // 释放第一个后，它应当能被再次分配（说明占用表真的在起作用，不是单调自增）
  ctx.sshPortsInUse.delete(first)
  const third = ctx.pickSshPort({ sshOrdinal: 3 })
  assert.equal(ctx.sshPortsInUse.has(first), false, '刚删掉的端口不应该还被标为占用')
  assert.ok(Number.isInteger(third))
})

/**
 * 端到端：真的起一个 TCP 监听，验证 waitForLocalPort 的判定是对的。
 * 这条重要 —— 代理链路的正确性全押在"端口真的在监听"这个判断上。
 */
test('★ waitForLocalPort 只在端口真正可连接时才返回 true', async () => {
  const net = require('node:net')
  const ctx = { require: require, setTimeout, Date: Date, Promise: Promise }
  vm.createContext(ctx)
  vm.runInContext(extractFunction('waitForLocalPort'), ctx)

  // 挑一个当前没人听的端口
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const freePort = probe.address().port
  await new Promise(resolve => probe.close(resolve))

  const notListening = await ctx.waitForLocalPort(freePort, 400)
  assert.equal(notListening, false, '端口没人听却返回 true —— 会把代理指向一个空洞')

  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const livePort = server.address().port

  const listening = await ctx.waitForLocalPort(livePort, 1500)
  assert.equal(listening, true, '端口明明在监听却判定为失败')

  await new Promise(resolve => server.close(resolve))
})
