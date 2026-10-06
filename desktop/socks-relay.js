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
    await new Promise((resolve, reject) => {
      upstream.once('connect', resolve)
      upstream.once('error', reject)
    })

    // 1) 问候：同时提供「无认证」与「用户名/密码」，由上游选择。
    upstream.write(Buffer.from([SOCKS_VERSION, 2, AUTH_NONE, AUTH_USERPASS]))
    const greet = await reader.need(2)
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
      const authReply = await reader.need(2)
      if (authReply[0] !== 0x01 || authReply[1] !== 0x00) throw new Error('SOCKS5 用户名/密码认证失败')
    } else if (method !== AUTH_NONE) {
      throw new Error('上游选择了不支持的认证方式: ' + method)
    }

    // 2) 原样转发 CONNECT（客户端与上游都是 RFC1928 的地址格式）。
    upstream.write(requestChunk)

    // 3) 读回上游 reply：先 4 字节头，再按 ATYP 补足地址与端口。
    const head = await reader.need(4)
    if (head[0] !== SOCKS_VERSION) throw new Error('上游 reply 版本不符')
    const tail = await readAddrPort(reader, head[3])
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

module.exports = { createSocksRelay }
