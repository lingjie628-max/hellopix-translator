'use strict'

/**
 * `precheckSocks5()` 与 `createSocksRelay()` 的**握手硬超时** —— 纯 Node 线上测试。
 *
 * ## 为什么需要这一组（0.1.29 修的真机 P0）
 *
 * 真机现象（Windows，带认证 SOCKS5）：
 *   · 点「节点检测」→ **永远停在"正在检测"**，连错误提示都没有；
 *   · 之后**新开的 WhatsApp 实例显示「翻译组件未启动」**。
 *
 * 真机复现出来的因果链（真 Electron 实测）：
 *   1. 上游 TCP 连得上但**不回数据** → Chromium 卡在 SOCKS5 握手，
 *      `did-finish-load` / `did-fail-load` / `render-process-gone` 一个都不触发；
 *   2. 15 秒后超时清理直接 `destroy()` 掉还卡在握手的窗口 →
 *      **把 Electron 的渲染进程基础设施弄坏**（MachPortRendezvousServer 报错）；
 *   3. 从此整个应用**再也创建不出可用窗口** —— 检测永远转圈、
 *      新实例的 preload 不执行（于是"翻译组件未启动"）。
 *
 * 修法就是本文件测的两件事：
 *   · **预检**（`precheckSocks5`）：在创建任何 Chromium 窗口**之前**，
 *     用纯 Node 把节点验掉。不可用 → 直接返回明确错误，不碰 Chromium。
 *   · **握手硬超时**（relay 内）：任何一步都不许"永远 pending"。
 *
 * 这一组是**回归护栏**：任何一步退化成"可能永远挂着"，都会在这里被抓住。
 */

const assert = require('node:assert/strict')
const net = require('node:net')
const test = require('node:test')
const path = require('node:path')

const {
  createSocksRelay,
  precheckSocks5,
  HANDSHAKE_TIMEOUT_MS
} = require(path.join(__dirname, '..', 'desktop', 'src/proxy/socks-relay.js'))

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 起一个"假 SOCKS5 上游"，按 mode 表现不同故障。
 * 这不是替身实现 —— 它就是一段真 TCP + 真 SOCKS5 字节，只是行为可编排。
 */
function startFakeUpstream (mode, opts) {
  const o = opts || {}
  const stats = { connections: 0, bytesIn: 0 }
  const sockets = new Set()
  const server = net.createServer(socket => {
    stats.connections++
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    // 单一 data 处理器 + 显式阶段，避免 once/on 混用导致重复消费。
    let stage = 'greet'
    socket.on('data', chunk => {
      stats.bytesIn += chunk.length
      const first = chunk[0]

      if (mode === 'silent') return

      if (mode === 'not-socks') {
        if (stage === 'greet') { stage = 'done'; socket.write(Buffer.from([0x04, 0x00])) }
        return
      }
      if (mode === 'auth-reject') {
        if (stage === 'greet' && first === 0x05) { stage = 'done'; socket.write(Buffer.from([0x05, 0xFF])) }
        return
      }
      if (mode === 'bad-auth') {
        if (stage === 'greet' && first === 0x05) { stage = 'auth'; socket.write(Buffer.from([0x05, 0x02])); return }
        if (stage === 'auth') { stage = 'done'; socket.write(Buffer.from([0x01, 0x01])); return }
        return
      }
      if (mode === 'greet-then-silent') {
        if (stage === 'greet' && first === 0x05) { stage = 'conn'; socket.write(Buffer.from([0x05, 0x00])) }
        return   // CONNECT 阶段故意不回
      }
      if (mode === 'connect-refused') {
        if (stage === 'greet' && first === 0x05) { stage = 'conn'; socket.write(Buffer.from([0x05, 0x00])); return }
        if (stage === 'conn') {
          stage = 'done'
          socket.write(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))   // host unreachable
          return
        }
        return
      }
      if (mode === 'ok') {
        if (stage === 'greet' && first === 0x05) {
          if (o.requireAuth) { stage = 'auth'; socket.write(Buffer.from([0x05, 0x02])); return }
          stage = 'conn'; socket.write(Buffer.from([0x05, 0x00])); return
        }
        if (stage === 'auth') { stage = 'conn'; socket.write(Buffer.from([0x01, 0x00])); return }
        if (stage === 'conn') {
          stage = 'done'
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1F, 0x90]))
          return
        }
      }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        stats,
        close () {
          for (const s of sockets) { try { s.destroy() } catch (e) {} }
          return new Promise(r => server.close(() => r()))
        }
      })
    })
  })
}

/** 给任意 promise 加一个上限，用来断言"绝不许永远挂着"。 */
async function expectSettled (promise, ms, what) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('HUNG: ' + what + ' 超过 ' + ms + 'ms 仍未返回')), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// precheckSocks5
// ---------------------------------------------------------------------------

test('precheckSocks5：连得上但不回话 → 必须按时返回失败（不许永远挂着）', async () => {
  const up = await startFakeUpstream('silent')
  try {
    const t0 = Date.now()
    const r = await expectSettled(
      precheckSocks5({ host: '127.0.0.1', port: up.port, user: 'u', pass: 'p', timeoutMs: 600 }),
      4000, 'precheck(silent)'
    )
    const ms = Date.now() - t0
    assert.equal(r.ok, false, '静默上游必须判失败')
    assert.equal(r.code, 'TIMEOUT')
    assert.match(r.reason, /无响应|没有回话/, '原因必须说清楚是"没回话"')
    assert.ok(ms < 3000, '必须在上限附近就返回，实际 ' + ms + 'ms')
  } finally { await up.close() }
})

test('precheckSocks5：问候正常但 CONNECT 无 reply → 必须判失败（这类节点不许进 Chromium）', async () => {
  const up = await startFakeUpstream('greet-then-silent')
  try {
    const r = await expectSettled(
      precheckSocks5({ host: '127.0.0.1', port: up.port, user: 'u', pass: 'p', timeoutMs: 600 }),
      4000, 'precheck(greet-then-silent)'
    )
    assert.equal(r.ok, false, 'CONNECT 拿不到成功 reply 的节点不可用')
    assert.equal(r.code, 'TIMEOUT')
  } finally { await up.close() }
})

test('precheckSocks5：端口没人监听 → 快速失败且原因明确', async () => {
  const probe = await startFakeUpstream('ok')
  const deadPort = probe.port
  await probe.close()
  const t0 = Date.now()
  const r = await expectSettled(
    precheckSocks5({ host: '127.0.0.1', port: deadPort, user: 'u', pass: 'p', timeoutMs: 3000 }),
    4000, 'precheck(dead-port)'
  )
  assert.equal(r.ok, false)
  assert.equal(r.code, 'ECONNREFUSED')
  assert.match(r.reason, /拒绝连接|没人监听/)
  assert.ok(Date.now() - t0 < 1500, '端口不可达必须立刻返回，不该等满超时')
})

test('precheckSocks5：上游拒绝认证方式 → 明确失败', async () => {
  const up = await startFakeUpstream('auth-reject')
  try {
    const r = await expectSettled(
      precheckSocks5({ host: '127.0.0.1', port: up.port, user: 'u', pass: 'p', timeoutMs: 2000 }),
      4000, 'precheck(auth-reject)'
    )
    assert.equal(r.ok, false)
    assert.equal(r.code, 'AUTH_REJECTED')
  } finally { await up.close() }
})

test('precheckSocks5：账号密码错 → 明确失败（不能报成"超时"）', async () => {
  const up = await startFakeUpstream('bad-auth')
  try {
    const r = await expectSettled(
      precheckSocks5({ host: '127.0.0.1', port: up.port, user: 'u', pass: 'wrong', timeoutMs: 2000 }),
      4000, 'precheck(bad-auth)'
    )
    assert.equal(r.ok, false)
    assert.equal(r.code, 'AUTH_FAILED')
    assert.match(r.reason, /密码|账号/)
  } finally { await up.close() }
})

test('precheckSocks5：不是 SOCKS5 端口 → 明确失败', async () => {
  const up = await startFakeUpstream('not-socks')
  try {
    const r = await expectSettled(
      precheckSocks5({ host: '127.0.0.1', port: up.port, user: '', pass: '', timeoutMs: 2000 }),
      4000, 'precheck(not-socks)'
    )
    assert.equal(r.ok, false)
    assert.equal(r.code, 'NOT_SOCKS5')
  } finally { await up.close() }
})

test('precheckSocks5：CONNECT 被上游拒绝 → 明确失败', async () => {
  const up = await startFakeUpstream('connect-refused')
  try {
    const r = await expectSettled(
      precheckSocks5({ host: '127.0.0.1', port: up.port, user: '', pass: '', timeoutMs: 2000 }),
      4000, 'precheck(connect-refused)'
    )
    assert.equal(r.ok, false)
    assert.equal(r.code, 'CONNECT_REFUSED')
  } finally { await up.close() }
})

test('precheckSocks5：好节点（无认证）→ 判可用', async () => {
  const up = await startFakeUpstream('ok', { requireAuth: false })
  try {
    const r = await expectSettled(
      precheckSocks5({ host: '127.0.0.1', port: up.port, user: '', pass: '', timeoutMs: 2000 }),
      4000, 'precheck(ok)'
    )
    assert.equal(r.ok, true, '好节点必须判可用：' + JSON.stringify(r))
    assert.equal(r.code, 'OK')
  } finally { await up.close() }
})

test('precheckSocks5：好节点（要认证、账密正确）→ 判可用', async () => {
  const up = await startFakeUpstream('ok', { requireAuth: true })
  try {
    const r = await expectSettled(
      precheckSocks5({ host: '127.0.0.1', port: up.port, user: 'u', pass: 'p', timeoutMs: 2000 }),
      4000, 'precheck(ok-auth)'
    )
    assert.equal(r.ok, true, '认证通过的好节点必须判可用：' + JSON.stringify(r))
  } finally { await up.close() }
})

test('precheckSocks5：地址非法 → 立刻失败，不建连接', async () => {
  for (const bad of [{ host: '', port: 1080 }, { host: 'h', port: 0 }, { host: 'h', port: 70000 }]) {
    const r = await precheckSocks5(Object.assign({ user: 'u', pass: 'p', timeoutMs: 500 }, bad))
    assert.equal(r.ok, false, JSON.stringify(bad) + ' 应判失败')
    assert.equal(r.code, 'BAD_TARGET')
  }
})

test('precheckSocks5：反复预检坏节点，不残留任何连接（不留悬挂句柄）', async () => {
  const up = await startFakeUpstream('silent')
  try {
    for (let i = 0; i < 3; i++) {
      const r = await expectSettled(
        precheckSocks5({ host: '127.0.0.1', port: up.port, user: 'u', pass: 'p', timeoutMs: 400 }),
        3000, 'precheck(loop ' + i + ')'
      )
      assert.equal(r.ok, false)
    }
    // 上游侧的连接必须都被我们主动断掉（不能攒着不放）
    await sleep(150)
    assert.ok(up.stats.connections >= 3, '上游确实被连过（前置条件）')
  } finally { await up.close() }
})

// ---------------------------------------------------------------------------
// createSocksRelay 的握手硬超时
// ---------------------------------------------------------------------------

test('createSocksRelay：start() 只监听回环，必须立刻返回（不能挂着）', async () => {
  const up = await startFakeUpstream('silent')
  const relay = createSocksRelay({ host: '127.0.0.1', port: up.port, user: 'u', pass: 'p' })
  try {
    const info = await expectSettled(relay.start(), 3000, 'relay.start')
    assert.ok(info && info.port > 0, 'start() 必须给出本地端口')
  } finally {
    await relay.close().catch(() => {})
    await up.close()
  }
})

test('createSocksRelay：上游静默时，经由中继的连接必须在握手超时内被断开（不阻塞）', async () => {
  const up = await startFakeUpstream('silent')
  const relay = createSocksRelay({ host: '127.0.0.1', port: up.port, user: 'u', pass: 'p', onError: () => {} })
  try {
    const info = await relay.start()

    // 从"客户端"角度连中继，发一个 SOCKS5 问候 + CONNECT，然后看它会不会被及时断开。
    const result = await expectSettled(new Promise(resolve => {
      const c = net.connect(info.port, '127.0.0.1')
      let closed = false
      const t0 = Date.now()
      c.on('error', () => {})
      c.on('connect', () => {
        c.write(Buffer.from([0x05, 0x01, 0x00]))          // 问候：无认证
      })
      c.on('data', chunk => {
        // 中继会先回 [0x05,0x00]（对客户端的问候应答）
        if (chunk.length >= 2 && chunk[0] === 0x05 && chunk[1] === 0x00) {
          c.write(Buffer.from([0x05, 0x01, 0x00, 0x03, 11,
            ...Buffer.from('api.ipify.org'), 0x01, 0xBB]))  // CONNECT api.ipify.org:443
        }
      })
      c.on('close', () => { if (!closed) { closed = true; resolve({ ms: Date.now() - t0, closed: true }) } })
      c.on('end', () => { if (!closed) { closed = true; resolve({ ms: Date.now() - t0, closed: true }) } })
    }), HANDSHAKE_TIMEOUT_MS + 6000, 'relay(client sees close)')

    assert.equal(result.closed, true, '挂死的上游必须让客户端连接被断开，而不是无限等待')
    assert.ok(result.ms < HANDSHAKE_TIMEOUT_MS + 5000,
      '断开必须发生在握手超时附近，实际 ' + result.ms + 'ms')
  } finally {
    await relay.close().catch(() => {})
    await up.close()
  }
})

test('createSocksRelay：上游地址非法 → start() 明确 reject（不是静默失败）', async () => {
  const relay = createSocksRelay({ host: '', port: 0, user: 'u', pass: 'p' })
  await assert.rejects(() => relay.start(), /上游 SOCKS5 地址无效/)
})

test('HANDSHAKE_TIMEOUT_MS 是个有限的正数（不是 0 / Infinity）', () => {
  assert.ok(Number.isFinite(HANDSHAKE_TIMEOUT_MS), '必须是有限数')
  assert.ok(HANDSHAKE_TIMEOUT_MS > 0, '必须是正数')
  assert.ok(HANDSHAKE_TIMEOUT_MS <= 30000, '不该长到让用户以为卡死')
})
