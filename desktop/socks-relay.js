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
 * 预检要试探的目标 —— **任一个 CONNECT 成功就算节点可用**。
 *
 * ## 为什么不能只试一个（0.1.32 真机事故）
 *
 * 原先只 CONNECT `api.ipify.org:443`，一次失败就判"节点连不上"。真机上抓到一个
 * 节点：对 `1.1.1.1:443` 回 0x01、对 `8.8.8.8:53` 和域名回 0x08 —— 它**对不同目标
 * 行为不一致**。只测一个目标就下"坏节点"结论，等于把判定权交给一次偶然。
 *
 * 同类产品（比特浏览器）的做法可以印证：它经代理去轮询
 * `google.com / cloudflare.com / github.com / wikipedia.org / baidu.com` 等多个目标，
 * 拿到任意一个的内容就算代理可用。判定标准是「**能不能真的出去**」，不是「握手是否漂亮」。
 *
 * ## 目标怎么选
 *
 *   · `web.whatsapp.com` 排第一 —— 用户真正要打开的站点。它连不上，节点对我们就是没用的，
 *     哪怕别的目标都通。
 *   · 其余是轻量、全球可达的兜底，覆盖不同机房策略。
 *
 * 全部走**域名**（远程 DNS）：这样测的是节点自己的解析与出网能力，与用户实际访问方式一致。
 */
const PRECHECK_TARGETS = [
  { host: 'web.whatsapp.com', port: 443 },
  { host: 'api.ipify.org', port: 443 },
  { host: 'www.google.com', port: 443 },
  { host: 'www.cloudflare.com', port: 443 }
]

/**
 * 「都拒了」到「可以下结论」之间要等的宽限期。
 *
 * ## 为什么需要
 *
 * 全部失败时不能一看最后一个快目标回了就立刻收工 —— 那个**慢的**目标可能正在
 * 成功（有的人节点响应慢但可用）。但也不能一直等：只要有目标假死，
 * 用户就要干等满 8 秒，这跟"检测转圈"没区别。
 *
 * 折中：已经失败的目标里，如果有任何一个返回得比这个宽限期还早（说明节点是秒拒的），
 * 就认为剩下的目标只在"收尸"，立即以失败定论；否则继续等，
 * 直到全部回齐或整体超时。
 *
 * 取 1000ms 的依据：秒拒类节点（本事故里那个）实测 0.5~1.4 秒就回 REP 了；
 * 而真能用的节点在 1 秒内通常早就 CONNECT 成功了。
 */
const PRECHECK_SETTLE_MS = 1000

/**
 * 把 SOCKS5 CONNECT 的应答码翻成**用户能看懂、并能据此行动**的话。
 *
 * ## 为什么要有这个函数（0.1.31 的真机教训）
 *
 * 原先只在"节点检测"那一个分支里映射了 0x02~0x05，其余全部落到
 * `节点拒绝了连接请求（reply=N）`。真机上节点回的是 **0x08**（地址类型不支持）
 * 和 **0x01**（通用故障）—— 用户拿到 `reply=8` 这种原始数字，
 * 既不知道什么意思、也不知道该做什么，只能来问客服：
 * 「新版本是不是把节点检测封了？」（实际是节点自己拒的，与版本无关。）
 *
 * ## 每个分支必须回答两件事
 *
 *   1. **是什么问题** —— 说清是节点侧还是配置侧；
 *   2. **用户该做什么** —— 绝大多数情况唯一的出路是"换节点"，
 *      那就直说，不要让用户去反复检查自己填的地址。
 *
 * 参考 RFC1928 的 REP 字段定义。
 */
function describeConnectReply(rep) {
  switch (rep) {
    case 0x01: return '节点内部故障（可能是流量用尽、套餐到期或账号已失效），请联系代理服务商'
    case 0x02: return '节点规则不允许连接该目标，请联系代理服务商'
    case 0x03: return '节点所在网络不可达，请更换节点'
    case 0x04: return '节点找不到目标主机，请更换节点'
    case 0x05: return '节点无法解析目标域名，请更换节点'
    case 0x06: return '节点连接目标超时，请更换节点'
    case 0x07: return '节点不支持该连接命令，请联系代理服务商'
    // 0x08 曾经写成「可能只支持 IPv4」，0.1.32 又改成「流量用尽/套餐到期」。
    // 两个都错。RFC1928 原文：
    //   X'08' Address type not supported
    // 它说的是**节点处理不了这次 CONNECT 的地址**，不是"节点坏了"。
    // 真机上同一节点对 1.1.1.1 回 0x01、对域名回 0x08，正是"按地址区别对待"的表现，
    // 而不是账号被停 —— 当成"套餐到期"会直接把用户送去换节点，问题永远查不出来。
    case 0x08: return '节点无法转发到这个地址（地址类型不受支持），请更换节点或联系代理服务商'
    default: return '节点拒绝了连接（错误码 ' + rep + '），请联系代理服务商'
  }
}

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
        throw new Error('上游 CONNECT 失败：' + describeConnectReply(conn.reply[1]))
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
  const targets = Array.isArray(opts.targets) && opts.targets.length ? opts.targets : PRECHECK_TARGETS

  // ★ 地址非法必须**同步之前**就判掉，不能进并发调度 ★
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return Promise.resolve({ ok: false, reason: '代理地址无效', code: 'BAD_TARGET', ms: 0, tried: [] })
  }

  /**
   * 并发探测所有目标，**第一个成功立即整体成功**，全部失败才判失败。
   *
   * 为什么并发：单目标串行时最坏要等 N × timeout。四目标串行 = 32 秒，
   * 用户会以为软件卡死。并发后最坏仍是 1 × timeout。
   *
   * 为什么"任一成功即成功"：节点的出网策略各不相同（有的只放特定域名、
   * 有的 DNS 走远程、有的限制端口）。只要有一条路能出去，用户的浏览器就能用。
   */
  let settled = false
  let timer = null
  const probes = []

  const settle = (ok, reason, code, tried) => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    // 一旦定论，把**仍在飞行中的**探测全部掐掉，不留悬挂 socket。
    for (const p of probes) p.abort()
    resolveFn({ ok: !!ok, reason: reason || '', code: code || (ok ? 'OK' : 'FAIL'), ms: Date.now() - started, tried: tried || [] })
  }

  let resolveFn = null
  const outer = new Promise(r => { resolveFn = r })

  // 整体硬上限：无论各目标怎么挂，到这个点必须给用户一个答复。
  timer = setTimeout(() => {
    settle(false, '节点无响应（' + Math.round(timeoutMs / 1000) + ' 秒内没有回话）', 'TIMEOUT', outcomes.slice())
  }, timeoutMs)
  if (timer && typeof timer.unref === 'function') timer.unref()

  const outcomes = []
  const record = o => { outcomes.push(o) }

  for (const t of targets) {
    const probe = probeOneTarget({ host, port, user, pass, target: t, timeoutMs })
    probes.push(probe)
    probe.promise.then(res => {
      record({ host: t.host, port: t.port, ok: res.ok, code: res.code, reason: res.reason, ms: res.ms })
      if (settled) return
      if (res.ok) {
        settle(true, pickSuccessReason(user, pass), 'OK', outcomes.slice())
        return
      }
      // 全部回齐且都失败 → 用**最有信息量**的那条当结论。
      if (outcomes.length === targets.length) {
        const pick = pickWorstOutcome(outcomes)
        settle(false, pick.reason, pick.code, outcomes.slice())
        return
      }
      // ★ 快速收敛：都已经有目标"秒拒"了，就别陪着可能假死的目标耗到整体超时 ★
      //
      // 判据：已回的目标全部失败，且**最快的那一个**比宽限期还早返回。
      // 这代表节点是立刻拒绝的 —— 剩下没回的只会在超时后被收尸，
      // 继续等只会让用户对着"正在检测"多盯几秒。
      //
      // 反过来，如果回得慢（>宽限期），说明这是"慢而可能可用"的节点，
      // 必须给其他目标留出成功的机会，不能提前判死。
      const fastest = outcomes.reduce((m, o) => (o.ms < m ? o.ms : m), Infinity)
      if (fastest <= PRECHECK_SETTLE_MS) {
        const pick = pickWorstOutcome(outcomes)
        settle(false, pick.reason, pick.code, outcomes.slice())
      }
    })
  }

  return outer
}

/**
 * 单目标探测：TCP → 问候 → 认证 → CONNECT 该目标 → 读回 reply。
 *
 * 返回 `{ promise, abort }`。`abort()` 必须幂等 —— 整体定论时会被调用，
 * 而正常结束时也可能被再次调用。
 */
function probeOneTarget (cfg) {
  const timeoutMs = cfg.timeoutMs
  let socket = null
  let done = false
  let stage = 'greeting'
  let stageBuf = Buffer.alloc(0)
  let resolveProbe = null
  let timer = null
  const startedAt = Date.now()

  const promise = new Promise(r => { resolveProbe = r })

  const finish = (ok, reason, code) => {
    if (done) return
    done = true
    if (timer) clearTimeout(timer)
    try { if (socket) socket.destroy() } catch (e) {}
    resolveProbe({ ok: !!ok, reason: reason || '', code: code || (ok ? 'OK' : 'FAIL'), ms: Date.now() - startedAt })
  }

  const abort = () => { finish(false, '已取消', 'ABORTED') }

  // 每个目标自身也要有上限：整体 timer 只有一个，但某个目标可能在
  // "三次握手都成功了、只是 CONNECT 不回"上耗到整体超时 —— 那时归因会变成
  // 「节点无响应」，掩盖掉真正有效的失败原因。所以单目标也计时。
  timer = setTimeout(() => finish(false, '节点无响应（' + Math.round(timeoutMs / 1000) + ' 秒内没有回话）', 'TIMEOUT'), timeoutMs)
  if (timer && typeof timer.unref === 'function') timer.unref()

  try {
    socket = net.connect(cfg.port, cfg.host)
  } catch (e) {
    finish(false, '无法建立连接：' + ((e && e.message) || '未知错误'), 'CONNECT_FAILED')
    return { promise, abort }
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
  const onData = chunk => {
    if (done) return
    stageBuf = Buffer.concat([stageBuf, chunk])

    if (stage === 'greeting') {
      if (stageBuf.length < 2) return
      if (stageBuf[0] !== SOCKS_VERSION) return finish(false, '这个端口不是 SOCKS5 代理', 'NOT_SOCKS5')
      const method = stageBuf[1]
      // ★ 进入下一阶段前必须清空缓冲 ★
      //   否则问候应答的这 2 字节会留在 stageBuf 里，与 CONNECT 应答拼在一起，
      //   解析时整体错位一字节（实测表现为"请求包变成 5,1,3,16,..."）。
      stageBuf = Buffer.alloc(0)
      if (method === AUTH_NO_ACCEPTABLE) {
        return finish(false, (cfg.user || cfg.pass) ? '节点拒绝了账号密码认证方式' : '节点要求认证，但没填账号密码', 'AUTH_REJECTED')
      }
      if (method === AUTH_USERPASS) {
        if (!cfg.user && !cfg.pass) return finish(false, '节点要求认证，但没填账号密码', 'AUTH_REQUIRED')
        const u = Buffer.from(cfg.user)
        const p = Buffer.from(cfg.pass)
        socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]))
        stage = 'auth'
        stageBuf = Buffer.alloc(0)
        return
      }
      if (method === AUTH_NONE) {
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
      // REP 码本身是判断"能不能出去"的唯一依据，不需要再读 BND.ADDR。
      if (rep !== 0x00) {
        // 逐个翻译应答码 —— 见 describeConnectReply 顶部说明。
        // 真机教训：0x08 / 0x01 曾经落到兜底，用户只看到 `reply=8`，
        // 于是怀疑「新版本封了节点检测」，实际是节点自己拒的。
        return finish(false, describeConnectReply(rep), 'CONNECT_REFUSED')
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
    const h = Buffer.from(cfg.target.host)
    socket.write(Buffer.concat([
      Buffer.from([SOCKS_VERSION, CMD_CONNECT, ATYP_DOMAIN, h.length]),
      h,
      Buffer.from([(cfg.target.port >> 8) & 0xff, cfg.target.port & 0xff])
    ]))
    stageBuf = Buffer.alloc(0)
  }

  return { promise, abort }
}

/**
 * 全部目标都失败时，挑一条**最能帮助用户行动**的原因作结论。
 *
 * 优先级（越靠前越"确定是节点侧的问题"）：
 *   CONNECT_REFUSED  >  AUTH_*  >  TIMEOUT  >  CONNECT_FAILED  >  其他
 *
 * 理由：如果有的目标被节点拒绝、有的超时，说明节点是**活的但不让出去** ——
 * 报"被拒"比报"无响应"更准确，也更能引导用户去找服务商。
 * AUTH_* 排第二：账号密码错是用户自己就能改的事，必须优先于"网络问题"报出来。
 */
function pickWorstOutcome (outcomes) {
  if (!outcomes.length) return { reason: '节点不可用，请更换节点', code: 'FAIL' }
  const rank = code => {
    switch (code) {
      // ★ CONNECT 应答码**不能**排在最高优先级 ★
      //
      // 它只说明"这一次 CONNECT 的地址没被放行"，而不同目标的地址各不相同，
      // 拿其中一个的应答码当整个节点的死因，正是 0.1.29~0.1.33 判定过严的根源。
      // 真正确定的只有认证类错误（账密错了换目标也不会对）。
      case 'AUTH_FAILED':
      case 'AUTH_REJECTED':
      case 'AUTH_REQUIRED': return 0
      case 'TIMEOUT': return 1
      case 'CONNECT_FAILED': return 2
      case 'CONNECT_REFUSED': return 3
      case 'NOT_SOCKS5':
      case 'BAD_REPLY':
      case 'AUTH_UNSUPPORTED': return 4
      default: return 5
    }
  }
  const sorted = outcomes.slice().sort((a, b) => rank(a.code) - rank(b.code))
  return sorted[0]
}

function pickSuccessReason (user, pass) {
  return (user || pass) ? '节点可用（认证通过）' : '节点可用（无需认证）'
}

module.exports = {
  createSocksRelay,
  precheckSocks5,
  probeOneTarget,
  HANDSHAKE_TIMEOUT_MS,
  PRECHECK_TARGETS,
  describeConnectReply,
  pickWorstOutcome
}
