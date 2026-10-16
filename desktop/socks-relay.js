'use strict'

/**
 * 带认证的 SOCKS5「本地回环中继」。
 *
 * ## 为什么需要它（这是 Chromium 的硬限制）
 *
 * 我们的代理设置里可以填「账号 + 密码」。但把凭据拼进 `proxyRules`
 * （`socks5://user:pass@host:port`）会被 Chromium 直接拒绝：
 * 实测报 `net::ERR_NO_SUPPORTED_PROXIES`。Chromium 的 proxyRules 字符串
 * **不接受内嵌凭据**，这是它的既定行为，不是可以绕过的写法。
 *
 * Chromium 对「代理需要认证」的正规做法是触发认证事件，由宿主机提供凭据 ——
 * Electron 里就是 `app.on('login')`。但实测：
 *
 *   · **HTTP/HTTPS 代理**：Basic 认证会触发 `login` 事件（`authInfo.isProxy === true`），
 *     我们可以在那里把账号密码交回去 —— 这条路是通的（见 main.js 的 login 处理）。
 *   · **SOCKS5 代理**：用户名/密码子协商（RFC1929）**不触发** `login` 事件。
 *     Chromium 不支持从宿主机为 SOCKS5 提供凭据，于是带认证的 SOCKS5 无路可走。
 *
 * 所以本模块把「带认证的 SOCKS5」拆成两段：
 *
 *   浏览器 ──(socks5，无认证，127.0.0.1:随机端口)──▶ 本中继 ──(socks5 + 用户名/密码)──▶ 上游代理
 *
 * 对 Chromium 而言，它连的是一个**不需要认证的本地 SOCKS5**，凭据由我们在中继里补上；
 * 对上游而言，凭据照常提供、认证照常发生。两段都只在本机内。
 *
 * ## 隔离
 *
 * 一个中继实例只服务**一条线路**、只带**那一条线路**的凭据，监听在 `127.0.0.1`
 * 的**随机端口**上，且不复用给第二条线路 —— 复用就等于让 A 线路的凭据可能被 B 线路
 * 用上，这正是 P0 里明令禁止的「线路之间串凭据」。
 *
 * ## 本文件不 require electron
 *
 * 中继是纯 Node 网络代码（`net` 模块），与 Electron 无关。这样它能在普通 Node 里
 * 被真实 TCP 测试覆盖（见 test/proxy-mechanism.test.js），产品里用的也是同一份实现。
 */

const net = require('node:net')

const SOCKS_VERSION = 0x05
const AUTH_NONE = 0x00
const AUTH_USERPASS = 0x02
const AUTH_NO_ACCEPTABLE = 0xff
const CMD_CONNECT = 0x01
const ATYP_IPV4 = 0x01
const ATYP_DOMAIN = 0x03
const ATYP_IPV6 = 0x04

/**
 * 与上游握手的**硬超时**（连接、问候、认证、CONNECT reply 每一步都算）。
 *
 * 为什么必须有：TCP 连得上但**不回数据**的上游（防火墙静默丢弃、节点假死、
 * 手机热点切换中）会让 `await reader.need(n)` 永远挂着。节点检测链路上，
 * 一旦卡在这里，Chromium 侧也永远收不到 `did-finish-load`/`did-fail-load`，
 * 用户看到的就是「一直正在检测」。
 */
const HANDSHAKE_TIMEOUT_MS = 8000

/**
 * 给一个 Promise 加硬超时。
 *
 * 超时后先调用 `onTimeout()`（通常是 destroy 掉底层 socket，让对端感知），
 * 再以 `error` reject —— **绝不允许出现"永远 pending"的分支**。
 */
function withDeadline(promise, ms, onTimeout, message) {
  let timer = null
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      try { if (typeof onTimeout === 'function') onTimeout() } catch (e) {}
      const err = new Error(message || '操作超时')
      err.code = 'TIMEOUT'
      reject(err)
    }, ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * 逐字节读取工具：TCP 会把数据切成任意大小的块，不能假设一次收齐。
 * 只实现「读恰好 n 字节」与「取走已缓冲的剩余字节」两件事 —— 握手够用。
 */
class FrameReader {
  constructor(socket) {
    this.socket = socket
    this.buf = Buffer.alloc(0)
    this.wanted = 0
    this.resolve = null
    this.reject = null
    this.closed = false
    this.error = null
    this.onData = chunk => {
      this.buf = Buffer.concat([this.buf, chunk])
      this.pump()
    }
    this.onEnd = () => { this.closed = true; this.pump() }
    this.onError = error => { this.error = error; this.closed = true; this.pump() }
    socket.on('data', this.onData)
    socket.on('end', this.onEnd)
    socket.on('close', this.onEnd)
    socket.on('error', this.onError)
  }

  pump() {
    if (!this.resolve) return
    if (this.buf.length >= this.wanted) {
      const take = this.resolve
      this.resolve = null
      this.reject = null
      const out = this.buf.slice(0, this.wanted)
      this.buf = this.buf.slice(this.wanted)
      take(out)
    } else if (this.error) {
      const fail = this.reject
      this.resolve = null
      this.reject = null
      if (fail) fail(this.error)
    } else if (this.closed) {
      const fail = this.reject
      this.resolve = null
      this.reject = null
      if (fail) fail(new Error('连接提前关闭，只拿到 ' + this.buf.length + '/' + this.wanted + ' 字节'))
    }
  }

  need(n) {
    if (this.buf.length >= n) {
      const out = this.buf.slice(0, n)
      this.buf = this.buf.slice(n)
      return Promise.resolve(out)
    }
    this.wanted = n
    return new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
      this.pump()
    })
  }

  /** 取走已缓冲但未消费的字节（握手后可能有业务数据提前到达）。 */
  rest() {
    const out = this.buf
    this.buf = Buffer.alloc(0)
    return out
  }

  /** 摘掉监听：握手完成后要交给 pipe，不能再让本读取器吞掉数据。 */
  detach() {
    this.socket.removeListener('data', this.onData)
    this.socket.removeListener('end', this.onEnd)
    this.socket.removeListener('close', this.onEnd)
    this.socket.removeListener('error', this.onError)
    return this.buf
  }
}

/** 读 SOCKS5 请求/reply 里「地址 + 端口」的字节数；域名需要先读长度字节。 */
async function readAddrPort(reader, atyp) {
  if (atyp === ATYP_IPV4) return reader.need(6)
  if (atyp === ATYP_IPV6) return reader.need(18)
  if (atyp === ATYP_DOMAIN) {
    const lenByte = await reader.need(1)
    const body = await reader.need(lenByte[0] + 2)
    return Buffer.concat([lenByte, body])
  }
  throw new Error('不支持的地址类型: ' + atyp)
}

function createSocksRelay(options) {
  const opts = options || {}
  const upstreamHost = String(opts.host || '').trim()
  const upstreamPort = Number(opts.port)
  const user = String(opts.user || '')
  const pass = String(opts.pass || '')
  const useAuth = !!(user || pass)
  const onError = typeof opts.onError === 'function' ? opts.onError : () => {}

  const sockets = new Set()
  let server = null
  let listening = null

  function track(socket) {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    return socket
  }

  if (!upstreamHost || !Number.isInteger(upstreamPort) || upstreamPort <= 0 || upstreamPort > 65535) {
    return {
      start() { return Promise.reject(new Error('上游 SOCKS5 地址无效')) },
      close() { return Promise.resolve() }
    }
  }

  /** 与上游建立「已完成认证」的 SOCKS5 连接，并转发一次 CONNECT + 读回 reply。 */
  async function connectUpstream(requestChunk) {
    const upstream = track(net.connect(upstreamPort, upstreamHost))
    const reader = new FrameReader(upstream)
    await withDeadline(new Promise((resolve, reject) => {
      upstream.once('connect', resolve)
      upstream.once('error', reject)
    }), HANDSHAKE_TIMEOUT_MS, () => { try { upstream.destroy() } catch (e) {} }, '连接上游超时')

    // 1) 问候：同时提供「无认证」与「用户名/密码」，由上游选择。
    upstream.write(Buffer.from([SOCKS_VERSION, 2, AUTH_NONE, AUTH_USERPASS]))
    // ★ 每一步握手都要有硬超时 ★
    //   上游 TCP 连得上、但**不回数据**（防火墙静默丢弃、节点假死）时，
    //   `reader.need()` 会永远挂着 —— 这正是"检测一直转圈"的现场。
    const greet = await withDeadline(reader.need(2), HANDSHAKE_TIMEOUT_MS,
      () => { try { upstream.destroy() } catch (e) {} }, '上游未响应 SOCKS5 问候')
    if (greet[0] !== SOCKS_VERSION) throw new Error('上游不是 SOCKS5')
    const method = greet[1]
    if (method === AUTH_NO_ACCEPTABLE) {
      throw new Error(useAuth ? '上游拒绝了用户名/密码认证方式' : '上游要求认证，但未配置账号密码')
    }
    if (method === AUTH_USERPASS) {
      if (!useAuth) throw new Error('上游要求认证，但未配置账号密码')
      const u = Buffer.from(user)
      const p = Buffer.from(pass)
      upstream.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]))
      const authReply = await withDeadline(reader.need(2), HANDSHAKE_TIMEOUT_MS,
        () => { try { upstream.destroy() } catch (e) {} }, '上游未响应认证结果')
      if (authReply[0] !== 0x01 || authReply[1] !== 0x00) throw new Error('SOCKS5 用户名/密码认证失败')
    } else if (method !== AUTH_NONE) {
      throw new Error('上游选择了不支持的认证方式: ' + method)
    }

    // 2) 原样转发 CONNECT（客户端与上游都是 RFC1928 的地址格式）。
    upstream.write(requestChunk)

    // 3) 读回上游 reply：先 4 字节头，再按 ATYP 补足地址与端口。
    const head = await withDeadline(reader.need(4), HANDSHAKE_TIMEOUT_MS,
      () => { try { upstream.destroy() } catch (e) {} }, '上游未响应 CONNECT 结果')
    if (head[0] !== SOCKS_VERSION) throw new Error('上游 reply 版本不符')
    const tail = await withDeadline(readAddrPort(reader, head[3]), HANDSHAKE_TIMEOUT_MS,
      () => { try { upstream.destroy() } catch (e) {} }, '上游返回的地址不完整')
    const reply = Buffer.concat([head, tail])
    return { upstream, reader, reply }
  }

  function handleClient(client) {
    track(client)
    const reader = new FrameReader(client)
    let upstream = null

    const fail = error => {
      onError(error)
      try { client.destroy() } catch (e) {}
      try { if (upstream) upstream.destroy() } catch (e) {}
    }

    ;(async () => {
      // 1) 客户端问候（本地回环，一律回「无认证」）。
      const head = await reader.need(2)
      if (head[0] !== SOCKS_VERSION) throw new Error('客户端不是 SOCKS5')
      await reader.need(head[1])          // 消费方法列表
      client.write(Buffer.from([SOCKS_VERSION, AUTH_NONE]))

      // 2) 客户端请求：只支持 CONNECT。
      const reqHead = await reader.need(4)
      if (reqHead[0] !== SOCKS_VERSION) throw new Error('客户端请求版本不符')
      if (reqHead[1] !== CMD_CONNECT) {
        client.write(Buffer.from([SOCKS_VERSION, 0x07, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]))
        throw new Error('只支持 CONNECT')
      }
      const tail = await readAddrPort(reader, reqHead[3])
      const requestChunk = Buffer.concat([reqHead, tail])

      // 3) 连上游并把 reply 原样交回客户端。
      const conn = await connectUpstream(requestChunk)
      upstream = conn.upstream
      client.write(conn.reply)
      if (conn.reply[1] !== 0x00) {
        throw new Error('上游 CONNECT 失败，reply=' + conn.reply[1])
      }

      // 4) 摘掉两个读取器（否则它们会继续吞数据），把已缓冲的残字节先冲出去，再互相对接。
      const clientLeftover = reader.detach()
      const upstreamLeftover = conn.reader.detach()
      if (clientLeftover.length) upstream.write(clientLeftover)
      if (upstreamLeftover.length) client.write(upstreamLeftover)
      client.pipe(upstream)
      upstream.pipe(client)
      client.on('close', () => { try { upstream.destroy() } catch (e) {} })
      upstream.on('close', () => { try { client.destroy() } catch (e) {} })
    })().catch(fail)
  }

  return {
    start() {
      if (listening) return listening
      listening = new Promise((resolve, reject) => {
        server = net.createServer(socket => handleClient(socket))
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port }))
      })
      return listening
    },
    close() {
      return new Promise(resolve => {
        for (const socket of sockets) {
          try { socket.destroy() } catch (e) {}
        }
        sockets.clear()
        if (!server) return resolve()
        server.close(() => resolve())
      })
    }
  }
}

/**
 * ★ 上游 SOCKS5 可达性**预检**（不碰 Chromium）★
 *
 * ## 为什么需要它（0.1.29 修的真机缺陷）
 *
 * 真机现象（Windows，带认证 SOCKS5）：点「节点检测」→ **永远停在"正在检测"**，
 * 连错误提示都没有。
 *
 * 真机复现出来的机理（真 Electron 实测）：
 *   1. 上游 TCP 连得上但**不回数据** → Chromium 卡在 SOCKS5 握手，
 *      `did-finish-load` / `did-fail-load` / `render-process-gone` **一个都不触发**；
 *   2. 15 秒后产品超时，走清理逻辑 `wc.destroy()` + `win.destroy()` ——
 *      而此时渲染进程正卡在握手里，**这一销毁把 Electron 的渲染进程基础设施弄坏了**
 *      （macOS 上直接看到 `bootstrap_look_up ... MachPortRendezvousServer: Permission denied`
 *      → `No rendezvous client, terminating process`）；
 *   3. 从此**整个应用再也创建不出可用窗口**：之后每一次「节点检测」都卡在
 *      第 1 步（没有任何事件），于是永远是"正在检测"。
 *
 * 所以正确做法是：**在把请求交给 Chromium 之前，先用纯 Node 把上游验一遍。**
 * 验不过的直接返回明确错误，**根本不创建窗口** —— 也就不会有机会弄坏渲染进程。
 *
 * 这一步同时把"节点到底死在哪儿"说清楚（连不上 / 没回话 / 认证错 / 地址解析失败），
 * 而不是笼统地"连接超时"。
 *
 * @returns {Promise<{ok:boolean, reason:string, code:string, ms:number}>}
 */
function precheckSocks5(options) {
  const opts = options || {}
  const host = String(opts.host || '').trim()
  const port = Number(opts.port)
  const user = String(opts.user || '')
  const pass = String(opts.pass || '')
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : HANDSHAKE_TIMEOUT_MS
  const started = Date.now()

  return new Promise(resolve => {
    let socket = null
    let done = false
    let buf = Buffer.alloc(0)
    // ★ timer 必须在 finish() 之前就声明 ★
    //   否则"地址非法"这条提前 return 的分支会在 finish() 里碰到 TDZ，抛 ReferenceError。
    //   这类"只有错误路径才炸"的写法正是真机上最难查的一类。
    let timer = null

    const finish = (ok, reason, code) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      try { if (socket) socket.destroy() } catch (e) {}
      resolve({ ok: !!ok, reason: reason || '', code: code || (ok ? 'OK' : 'FAIL'), ms: Date.now() - started })
    }

    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return finish(false, '代理地址无效', 'BAD_TARGET')
    }

    timer = setTimeout(() => finish(false, '节点无响应（' + Math.round(timeoutMs / 1000) + ' 秒内没有回话）', 'TIMEOUT'), timeoutMs)

    try {
      socket = net.connect(port, host)
    } catch (e) {
      return finish(false, '无法建立连接：' + ((e && e.message) || '未知错误'), 'CONNECT_FAILED')
    }

    socket.on('error', e => {
      const code = (e && e.code) || ''
      const text = code === 'ECONNREFUSED' ? '节点拒绝连接（端口没人监听）'
        : code === 'ENOTFOUND' ? '节点域名解析不了'
          : code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ? '节点网络不可达'
            : '连接失败：' + ((e && e.message) || code || '未知错误')
      finish(false, text, code || 'CONNECT_FAILED')
    })

    socket.on('connect', () => {
      // 同时提供「无认证」与「用户名/密码」，由上游选 —— 与中继里的握手完全一致。
      socket.write(Buffer.from([SOCKS_VERSION, 2, AUTH_NONE, AUTH_USERPASS]))
    })

    // ★ 单一 data 处理器 + 显式阶段状态机 ★
    //
    // 曾经这里用 `socket.once('data', …)` 处理"认证应答"和"CONNECT 应答"，
    // 外层再挂一个常驻 `socket.on('data')`。这是**错的**：Node 会把同一份数据
    // 分发给**所有**监听器，于是认证应答（首字节 0x01）也会被外层当成
    // "首个数据包"去解析 `buf[0] !== 0x05` → 误判成 NOT_SOCKS5。
    // 结果：**带认证的好节点被一律判成坏节点**。
    // （真机就是 socks5_auth —— 症状与"检测不出来"完全对得上。）
    //
    // 现在只有一个处理器，阶段由 stage 显式推进：greeting → auth → connect → done。
    let stage = 'greeting'
    let stageBuf = Buffer.alloc(0)

    const onData = chunk => {
      if (done) return
      stageBuf = Buffer.concat([stageBuf, chunk])

      if (stage === 'greeting') {
        buf = Buffer.concat([buf, chunk])
        if (buf.length < 2) return
        if (buf[0] !== SOCKS_VERSION) return finish(false, '这个端口不是 SOCKS5 代理', 'NOT_SOCKS5')
        const method = buf[1]
        if (method === AUTH_NO_ACCEPTABLE) {
          return finish(false, (user || pass) ? '节点拒绝了账号密码认证方式' : '节点要求认证，但没填账号密码', 'AUTH_REJECTED')
        }
        if (method === AUTH_USERPASS) {
          if (!user && !pass) return finish(false, '节点要求认证，但没填账号密码', 'AUTH_REQUIRED')
          const u = Buffer.from(user)
          const p = Buffer.from(pass)
          socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]))
          stage = 'auth'
          stageBuf = Buffer.alloc(0)
          return
        }
        if (method === AUTH_NONE) {
          buf = Buffer.alloc(0)
          stage = 'connect'
          stageBuf = Buffer.alloc(0)
          sendConnect()
          return
        }
        return finish(false, '节点选择了不支持的认证方式：' + method, 'AUTH_UNSUPPORTED')
      }

      if (stage === 'auth') {
        if (stageBuf.length < 2) return
        if (stageBuf[0] !== 0x01) return finish(false, '节点返回的认证应答不合法', 'BAD_REPLY')
        if (stageBuf[1] !== 0x00) return finish(false, '账号或密码不对', 'AUTH_FAILED')
        stage = 'connect'
        stageBuf = Buffer.alloc(0)
        sendConnect()
        return
      }

      if (stage === 'connect') {
        if (stageBuf.length < 4) return
        if (stageBuf[0] !== SOCKS_VERSION) return finish(false, '节点返回的应答不合法', 'BAD_REPLY')
        const rep = stageBuf[1]
        if (rep !== 0x00) {
          const why = rep === 0x05 ? '节点无法解析目标域名'
            : rep === 0x02 ? '节点不允许该目标'
              : rep === 0x03 ? '节点网络不可达'
                : rep === 0x04 ? '节点找不到目标主机'
                  : '节点拒绝了连接请求（reply=' + rep + '）'
          return finish(false, why, 'CONNECT_REFUSED')
        }
        stage = 'done'
        return finish(true, '节点可用', 'OK')
      }
    }
    socket.on('data', onData)

    /**
     * 认证过了还不算"节点可用" —— 必须**真的 CONNECT 一次**。
     *
     * 为什么（0.1.29 真机证据）：有的节点问候/认证都正常，但 CONNECT 之后
     * **不回 reply**（假死、被限流、隧道没通）。这种节点如果放进 Chromium，
     * 就会卡住渲染进程 → 正是我们要根除的那类现场。所以在这里就用真 CONNECT 验掉。
     */
    function sendConnect () {
      // 目标固定用 ipify 的 443：轻、稳、全球可达；只是用来确认"隧道通不通"。
      const hostBuf = Buffer.from('api.ipify.org')
      socket.write(Buffer.concat([
        Buffer.from([SOCKS_VERSION, CMD_CONNECT, ATYP_DOMAIN, hostBuf.length]),
        hostBuf,
        Buffer.from([0x01, 0xBB])   // 443
      ]))
      stageBuf = Buffer.alloc(0)
    }
  })
}

module.exports = { createSocksRelay, precheckSocks5, HANDSHAKE_TIMEOUT_MS }
