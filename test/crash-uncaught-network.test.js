'use strict'

/**
 * 「打开就闪退」的回归护栏 —— 0.1.37 真实上报定位到的根因。
 *
 * ## 现场
 *
 * 用户装好 0.1.37（Windows x64）后打开就闪退。上报回来的崩溃记录全是同一形状：
 *
 *     [crash] 主进程未捕获异常：Error: This socket has been ended by the other party
 *         at Socket.writeAfterFIN [as write] (node:net:566:14)
 *         at D:\固件\Hello Pix\resources\app.asar\socks-relay.js:361:14
 *
 *     [crash] 主进程未捕获异常：Error: read ECONNRESET
 *         at TCP.onStreamRead (node:internal/stream_base_commons:218:20)
 *
 *     [memory] 整机已用 45%（14762/32465MB）  实例 0 个
 *
 * 90 分钟内 16 次，内存只用了 45%~62% —— **与内存无关**。
 *
 * ## 根因（两层，缺一不可）
 *
 * 1. `socks-relay.js` 的 socket 在 `FrameReader.detach()` 之后处于**无 error
 *    监听**状态。detach 会 removeListener('error')，而 `once('error', reject)`
 *    只管握手期。此后上游一 RST，ECONNRESET 无处可去 → uncaughtException。
 * 2. `log-file.js` 的 `uncaughtException` **无条件 exit(1)**
 *    → 「节点抖一下」=「用户整个软件消失」。
 */

const assert = require('node:assert/strict')
const test = require('node:test')
const net = require('node:net')
const { EventEmitter } = require('node:events')

const { attachProcessHandlers } = require('../desktop/log-file')
const socksRelay = require('../desktop/socks-relay')

// ---------------------------------------------------------------------------
// 1. 未捕获异常分类：网络错误不该杀进程，其他必须杀
// ---------------------------------------------------------------------------

function runUncaught(error) {
  const proc = new EventEmitter()
  proc.exit = code => { proc.exited = code }
  const rows = []
  attachProcessHandlers(proc, {
    fatal: (scope, msg) => rows.push({ level: 'fatal', scope, msg }),
    error: (scope, msg) => rows.push({ level: 'error', scope, msg })
  }, { flush: () => {} })
  proc.emit('uncaughtException', error)
  return { exited: proc.exited, rows }
}

test('★ ECONNRESET 不再杀进程（本次闪退的直接原因之一）', () => {
  const err = new Error('read ECONNRESET')
  err.code = 'ECONNRESET'
  const r = runUncaught(err)
  assert.equal(r.exited, undefined, 'ECONNRESET 是代理常态，不能 exit')
  assert.equal(r.rows.length, 1, '仍必须留痕，否则复发时看不到')
})

test('★ writeAfterFIN 不再杀进程（堆栈里最常见的那条）', () => {
  const err = new Error('This socket has been ended by the other party')
  err.code = 'ERR_STREAM_WRITE_AFTER_END'
  assert.equal(runUncaught(err).exited, undefined)
})

test('writeAfterFIN 即使没有 code 也不杀（按 message 兜底）', () => {
  assert.equal(runUncaught(new Error('This socket has been ended by the other party')).exited, undefined)
})

test('EPIPE / ERR_STREAM_DESTROYED / ETIMEDOUT / ECONNABORTED 不杀', () => {
  for (const code of ['EPIPE', 'ERR_STREAM_DESTROYED', 'ETIMEDOUT', 'ECONNABORTED']) {
    const err = new Error('x')
    err.code = code
    assert.equal(runUncaught(err).exited, undefined, code + ' 不应退出')
  }
})

test('★ 未知异常必须仍然退出 ★', () => {
  // 安全边界：吞掉未知异常会造出"界面还在、功能已坏"的僵尸进程，
  // 比闪退更难排查。放行清单必须是白名单。
  assert.equal(runUncaught(new TypeError('Cannot read properties of undefined')).exited, 1)
  assert.equal(runUncaught(new Error('MODULE_NOT_FOUND')).exited, 1)
  assert.equal(runUncaught(new RangeError('boom')).exited, 1)
})

test('空异常按致命处理（不能静默吞掉未知状态）', () => {
  assert.equal(runUncaught(undefined).exited, 1)
  assert.equal(runUncaught(null).exited, 1)
})

// ---------------------------------------------------------------------------
// 2. 中继层：socket 不得裸奔、上游重置不得泄漏
//
// ⚠️ 注意：这一节的测试**不是**崩溃日志里 `read ECONNRESET` 的精确复现。
//    那条堆栈只有 `TCP.onStreamRead` 一行、没有任何业务帧，说明来源 socket
//    不在中继里（中继的 socket 全程都挂着 error 监听，已实测确认）。
//    这些测试的价值是**防回归**：确保中继在任何阶段都不会把网络错误
//    升级成进程级事件，而不是"证明修好了那条崩溃"。
// ---------------------------------------------------------------------------

function fakeUpstream(onConn) {
  const server = net.createServer(socket => onConn(socket))
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server,
    port: server.address().port
  })))
}

test('中继全程每个 socket 都保持 error 监听', async () => {
  // 不去追"精确复现某个时序"，而是验证根因的**本质不变量**：
  //   detach() 会 removeListener('error')，若此时没有别的常驻监听，
  //   socket 就进入裸奔状态，任何 RST 都直冲 uncaughtException。
  // 这个断言与时序无关，稳定可复现。
  const upstreamSockets = []
  const { server, port } = await fakeUpstream(socket => {
    socket.on('error', () => {})
    upstreamSockets.push(socket)
    let step = 0
    socket.on('data', () => {
      step++
      if (step === 1) socket.write(Buffer.from([0x05, 0x00]))
      else if (step === 2) socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
      // 之后保持连接，让中继进入转发阶段
    })
  })

  const relay = socksRelay.createSocksRelay({ host: '127.0.0.1', port, onError: () => {} })
  const samples = []
  let clientSock = null

  const sample = phase => {
    if (!clientSock) return
    samples.push({
      phase,
      client: clientSock.destroyed ? null : clientSock.listenerCount('error'),
      upstream: upstreamSockets.length && !upstreamSockets[0].destroyed
        ? upstreamSockets[0].listenerCount('error')
        : null
    })
  }

  try {
    const { port: localPort } = await relay.start()
    await new Promise(resolve => {
      clientSock = net.connect(localPort, '127.0.0.1')
      clientSock.on('error', () => {})
      clientSock.on('connect', () => {
        clientSock.write(Buffer.from([0x05, 0x01, 0x00]))
        sample('问候发出')
        clientSock.once('data', () => {
          sample('收到问候应答')
          const host = Buffer.from('example.com')
          clientSock.write(Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, Buffer.from([0x00, 0x50])
          ]))
          sample('CONNECT 发出')
          clientSock.once('data', () => {
            sample('CONNECT 应答后（detach 已发生）')
            clientSock.write('x')
            setTimeout(() => { sample('转发中'); resolve() }, 150)
          })
        })
      })
      setTimeout(resolve, 4000)
    })
  } finally {
    try { clientSock && clientSock.destroy() } catch (e) {}
    await relay.close()
    await new Promise(r => server.close(r))
  }

  const naked = samples.filter(r => r.client === 0 || r.upstream === 0)
  assert.deepEqual(
    naked, [],
    'socket 出现 0 个 error 监听（裸奔）—— 此时任何 RST 都会杀掉主进程：\n'
      + JSON.stringify(samples, null, 2)
  )
})

test('中继建立后上游重置，不得泄漏未捕获异常', async () => {
  const { server, port } = await fakeUpstream(socket => {
    socket.on('error', () => {})
    let step = 0
    socket.on('data', () => {
      step++
      if (step === 1) socket.write(Buffer.from([0x05, 0x00]))
      else if (step === 2) {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        setImmediate(() => socket.resetAndDestroy())
      }
    })
  })

  const relay = socksRelay.createSocksRelay({ host: '127.0.0.1', port, onError: () => {} })
  const leaked = []
  const onLeak = e => leaked.push(e)
  process.once('uncaughtException', onLeak)

  try {
    const { port: localPort } = await relay.start()
    await new Promise(resolve => {
      const c = net.connect(localPort, '127.0.0.1')
      c.on('error', () => {})
      c.on('connect', () => c.write(Buffer.from([0x05, 0x01, 0x00])))
      c.once('data', () => {
        const host = Buffer.from('example.com')
        c.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, Buffer.from([0x00, 0x50])
        ]))
        setTimeout(() => { c.destroy(); resolve() }, 400)
      })
      setTimeout(resolve, 4000)
    })
    await new Promise(r => setTimeout(r, 200))
  } finally {
    process.removeListener('uncaughtException', onLeak)
    await relay.close()
    await new Promise(r => server.close(r))
  }

  assert.deepEqual(leaked, [], '上游重置泄漏成了未捕获异常 —— 主进程会被杀，用户看到闪退')
})

test('客户端中途断开也不得泄漏未捕获异常', async () => {
  const { server, port } = await fakeUpstream(socket => {
    socket.on('error', () => {})
    socket.once('data', () => socket.write(Buffer.from([0x05, 0x00])))
  })
  const relay = socksRelay.createSocksRelay({ host: '127.0.0.1', port, onError: () => {} })

  const leaked = []
  const onLeak = e => leaked.push(e)
  process.once('uncaughtException', onLeak)

  try {
    const { port: localPort } = await relay.start()
    await new Promise(resolve => {
      const c = net.connect(localPort, '127.0.0.1')
      c.on('error', () => {})
      c.on('connect', () => {
        c.write(Buffer.from([0x05, 0x01, 0x00]))
        c.once('data', () => setTimeout(() => { c.resetAndDestroy(); setTimeout(resolve, 150) }, 0))
      })
      setTimeout(resolve, 2000)
    })
  } finally {
    process.removeListener('uncaughtException', onLeak)
    await relay.close()
    await new Promise(r => server.close(r))
  }

  assert.deepEqual(leaked, [], '客户端提前断开不得泄漏成未捕获异常')
})
