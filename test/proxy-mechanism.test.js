'use strict'

/**
 * 线路代理的**线上（wire-level）机制测试**。
 *
 * ## 这个测试回答什么
 *
 * 单元测试（desktop-proxy-settings.test.js）证明"决策对了"：
 * 该不该 apply、该不该 reload、A 会不会污染 B。
 *
 * 这个测试证明**产品生成的代理规则串本身是能真正连出去的**：
 * 起真实的 HTTP 代理与 SOCKS5 代理（真实 TCP、真实代理协议、真实认证），
 * 用 `proxyRulesOf()` 产出的字符串去连，看流量到底从哪个代理出去。
 *
 * 为什么值得单独测：这类缺陷的表现是"填了代理反而连不上"，
 * 而且单元测试完全看不出来 —— 例如
 * `proxyHost = '1.2.3.4:8080:u1:p1'`（用户把代理后台给的一整行粘进来）
 * 曾会被拼成 `http://u1:p1@1.2.3.4:8080:u1:p1:8080` 这种坏规则。
 * 本文件里 `parseProxyRules()` 会直接抛错，把这个坑钉死。
 *
 * ## 这里**没有**覆盖什么（重要，别误读）
 *
 * Chromium 自己怎么解释 `setProxy()`、真实出口公网 IP 是多少 ——
 * 那需要在**真 Electron** 里跑，见 desktop/scripts/proxy-mechanism-electron.js。
 * 本文件证明的是"规则串正确且可达"，不是"Chromium 按规则走了"。
 */

const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const test = require('node:test')

const { proxyRulesOf, proxyAuthOf, applySessionProxy } = require('../desktop/proxy-settings')
const { createSocksRelay } = require('../desktop/socks-relay')

// ─────────────────────────────────────────────────────────── 真实目标站

function startOrigin() {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.headers['x-pix-exit'] || 'direct')
    const body = JSON.stringify({
      ok: true,
      via: req.headers['x-pix-exit'] || 'direct',
      host: req.headers.host,
      path: req.url
    })
    // 显式给 Content-Length：否则 Node 走 chunked，测试端还要解分块框架，
    // 一旦解错就会把"代理没生效"误判成"代理坏了"，干扰结论。
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    })
    res.end(body)
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        seen,
        close: () => new Promise(r => server.close(r))
      })
    })
  })
}

// ─────────────────────────────────────────────────────────── 真实 HTTP 代理

/** 支持 absolute-URI 转发；带 creds 时强制 Basic 认证。 */
function startHttpProxy(name, creds) {
  const state = { hits: 0, authed: 0, rejected: 0 }
  const server = http.createServer((req, res) => {
    if (creds) {
      const raw = String(req.headers['proxy-authorization'] || '')
      const expect = 'Basic ' + Buffer.from(creds.user + ':' + creds.pass).toString('base64')
      if (raw !== expect) {
        state.rejected++
        res.writeHead(407, { 'proxy-authenticate': 'Basic realm="pix"' })
        res.end('proxy auth required')
        return
      }
      state.authed++
    }
    state.hits++
    let target = null
    try { target = new URL(req.url) } catch (e) { target = null }
    if (!target) {
      res.writeHead(400)
      res.end('not an absolute-URI proxy request')
      return
    }
    const headers = Object.assign({}, req.headers)
    delete headers['proxy-authorization']
    delete headers['proxy-connection']
    headers.host = target.host
    headers['x-pix-exit'] = name
    const upstream = http.request({
      host: target.hostname,
      port: Number(target.port || 80),
      path: target.pathname + target.search,
      method: req.method,
      headers
    }, upRes => {
      res.writeHead(upRes.statusCode, upRes.headers)
      upRes.pipe(res)
    })
    upstream.on('error', e => {
      res.writeHead(502)
      res.end('proxy upstream error: ' + e.message)
    })
    req.pipe(upstream)
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, state, close: () => new Promise(r => server.close(r)) })
    })
  })
}

// ─────────────────────────────────────────────────────────── 真实 SOCKS5 代理

/** RFC1928 握手 + RFC1929 用户名/密码子协商 + CONNECT 隧道。 */
function startSocks5Proxy(name, creds) {
  const state = { hits: 0, authed: 0, rejected: 0 }
  const server = net.createServer(socket => {
    let phase = 'greeting'
    let buf = Buffer.alloc(0)
    let upstream = null
    let queued = Buffer.alloc(0)
    socket.on('error', () => { if (upstream) upstream.destroy() })

    socket.on('data', chunk => {
      if (phase === 'tunnel') {
        if (upstream) upstream.write(chunk)
        else queued = Buffer.concat([queued, chunk])
        return
      }
      buf = Buffer.concat([buf, chunk])
      if (phase === 'greeting') {
        if (buf.length < 2) return
        const count = buf[1]
        if (buf.length < 2 + count) return
        const methods = Array.from(buf.slice(2, 2 + count))
        buf = buf.slice(2 + count)
        if (creds) {
          if (!methods.includes(2)) { socket.end(Buffer.from([5, 0xff])); return }
          socket.write(Buffer.from([5, 2]))
          phase = 'auth'
        } else {
          if (!methods.includes(0)) { socket.end(Buffer.from([5, 0xff])); return }
          socket.write(Buffer.from([5, 0]))
          phase = 'request'
        }
      }
      if (phase === 'auth') {
        if (buf.length < 2) return
        const ulen = buf[1]
        if (buf.length < 2 + ulen + 1) return
        const user = buf.slice(2, 2 + ulen).toString()
        const plen = buf[2 + ulen]
        if (buf.length < 3 + ulen + plen) return
        const pass = buf.slice(3 + ulen, 3 + ulen + plen).toString()
        buf = buf.slice(3 + ulen + plen)
        if (user === creds.user && pass === creds.pass) {
          state.authed++
          socket.write(Buffer.from([1, 0]))
          phase = 'request'
        } else {
          state.rejected++
          socket.end(Buffer.from([1, 1]))
          return
        }
      }
      if (phase === 'request') {
        if (buf.length < 4) return
        const atyp = buf[3]
        let host = ''
        let port = 0
        let need = 0
        if (atyp === 1) {
          need = 10
          if (buf.length < need) return
          host = buf.slice(4, 8).join('.')
          port = buf.readUInt16BE(8)
        } else if (atyp === 3) {
          if (buf.length < 5) return
          const len = buf[4]
          need = 7 + len
          if (buf.length < need) return
          host = buf.slice(5, 5 + len).toString()
          port = buf.readUInt16BE(5 + len)
        } else {
          socket.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]))
          return
        }
        buf = buf.slice(need)
        state.hits++
        phase = 'tunnel'
        upstream = net.connect(port, host, () => {
          socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          if (queued.length) { upstream.write(queued); queued = Buffer.alloc(0) }
          if (buf.length) { upstream.write(buf); buf = Buffer.alloc(0) }
          upstream.pipe(socket)
        })
        upstream.on('error', () => socket.destroy())
        return
      }
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, state, close: () => new Promise(r => server.close(r)) })
    })
  })
}

// ─────────────────────────────────────────────────────────── 规则串解析

/**
 * 按 Chromium proxyRules 的格式解析。
 * 解析不了就直接抛 —— 这正是我们要拦住的那类缺陷。
 */
function parseProxyRules(rules) {
  if (!rules) return null
  const m = /^(socks5|http|https):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^:@/]+)(?::(\d+))?$/i.exec(String(rules))
  if (!m) throw new Error('代理规则串无法解析（等同于客户端连不上代理）: ' + rules)
  const scheme = m[1].toLowerCase()
  return {
    scheme,
    user: m[2] ? decodeURIComponent(m[2]) : '',
    pass: m[3] !== undefined ? decodeURIComponent(m[3]) : '',
    host: m[4],
    port: Number(m[5] || (scheme === 'http' ? 80 : 1080))
  }
}

// ─────────────────────────────────────────────────────────── 客户端

class ByteReader {
  constructor(socket) {
    this.buf = Buffer.alloc(0)
    this.pending = null
    this.done = false
    this.error = null
    socket.on('data', c => { this.buf = Buffer.concat([this.buf, c]); this.pump() })
    socket.on('end', () => { this.done = true; this.pump() })
    socket.on('close', () => { this.done = true; this.pump() })
    socket.on('error', e => { this.error = e; this.done = true; this.pump() })
  }
  pump() {
    if (!this.pending) return
    const p = this.pending
    if (this.buf.length >= p.n) {
      this.pending = null
      p.resolve(this.take(p.n))
    } else if (this.error) {
      this.pending = null
      p.reject(this.error)
    } else if (this.done) {
      this.pending = null
      p.reject(new Error('连接提前关闭，只拿到 ' + this.buf.length + '/' + p.n + ' 字节'))
    }
  }
  take(n) {
    const out = this.buf.slice(0, n)
    this.buf = this.buf.slice(n)
    return out
  }
  read(n) {
    if (this.buf.length >= n) return Promise.resolve(this.take(n))
    return new Promise((resolve, reject) => {
      this.pending = { n, resolve, reject }
      this.pump()
    })
  }
  rest() {
    return this.buf
  }
}

function readAll(socket) {
  return new Promise((resolve, reject) => {
    const parts = []
    socket.on('data', c => parts.push(c))
    socket.on('end', () => resolve(Buffer.concat(parts).toString()))
    socket.on('close', () => resolve(Buffer.concat(parts).toString()))
    socket.on('error', reject)
  })
}

function httpRequestLine(host, port, path, absolute) {
  const lines = [
    'GET ' + (absolute ? 'http://' + host + ':' + port + path : path) + ' HTTP/1.1',
    'Host: ' + host + ':' + port,
    'Connection: close'
  ]
  return lines.join('\r\n') + '\r\n\r\n'
}

function bodyOf(raw) {
  const idx = raw.indexOf('\r\n\r\n')
  const body = idx >= 0 ? raw.slice(idx + 4) : raw
  try { return JSON.parse(body) } catch (e) { return { raw: body } }
}

/** 直连目标站。 */
async function fetchDirect(host, port, path) {
  const socket = net.connect(port, host)
  const all = readAll(socket)
  await new Promise((resolve, reject) => {
    socket.on('connect', resolve)
    socket.on('error', reject)
  })
  socket.write(httpRequestLine(host, port, path, false))
  return bodyOf(await all)
}

/** 向 HTTP 代理发一次请求，返回原始响应文本。`creds` 决定是否带 Proxy-Authorization。 */
async function httpProxyRaw(p, host, port, path, creds) {
  const socket = net.connect(p.port, p.host)
  const all = readAll(socket)
  await new Promise((resolve, reject) => {
    socket.on('connect', resolve)
    socket.on('error', reject)
  })
  const lines = [
    'GET http://' + host + ':' + port + path + ' HTTP/1.1',
    'Host: ' + host + ':' + port,
    'Connection: close'
  ]
  if (creds && (creds.user || creds.pass)) {
    lines.push('Proxy-Authorization: Basic ' + Buffer.from(creds.user + ':' + creds.pass).toString('base64'))
  }
  socket.write(lines.join('\r\n') + '\r\n\r\n')
  return all
}

/**
 * 模拟 Chromium 走 HTTP 代理的完整流程：
 *   规则串只有 host:port（**不含凭据**）→ 代理回 407 挑战 → 用 `proxyAuthOf()`
 *   交回的凭据重试。这就是 P0 的机制：凭据来自认证通道，不来自规则串。
 */
async function fetchViaHttpProxy(rules, host, port, path, creds) {
  const p = parseProxyRules(rules)
  assert.equal(p.user, '', '规则串里不应再出现账号：' + rules)
  assert.equal(p.pass, '', '规则串里不应再出现密码：' + rules)
  if (creds) {
    const challenge = await httpProxyRaw(p, host, port, path, null)
    assert.ok(challenge.includes('407'), '带认证的代理在没有凭据时必须回 407 挑战')
    return bodyOf(await httpProxyRaw(p, host, port, path, creds))
  }
  return bodyOf(await httpProxyRaw(p, host, port, path, null))
}

/** 走 SOCKS5 代理（真实握手 + 真实可选认证）。 */
async function fetchViaSocks5(rules, host, port, path) {
  const p = parseProxyRules(rules)
  const socket = net.connect(p.port, p.host)
  const reader = new ByteReader(socket)
  await new Promise((resolve, reject) => {
    socket.on('connect', resolve)
    socket.on('error', reject)
  })

  const wantsAuth = !!(p.user || p.pass)
  socket.write(Buffer.from([5, 1, wantsAuth ? 2 : 0]))
  const greeting = await reader.read(2)
  assert.equal(greeting[0], 5, 'SOCKS5 版本不匹配')
  assert.notEqual(greeting[1], 0xff, 'SOCKS5 代理拒绝了我们的认证方式')

  if (wantsAuth) {
    assert.equal(greeting[1], 2, '带账密时必须走用户名/密码子协商')
    const user = Buffer.from(p.user)
    const pass = Buffer.from(p.pass)
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]))
    const authReply = await reader.read(2)
    assert.deepEqual(Array.from(authReply), [1, 0], 'SOCKS5 用户名/密码认证失败')
  }

  const ipv4 = host.split('.').map(Number)
  socket.write(Buffer.concat([
    Buffer.from([5, 1, 0, 1]),
    Buffer.from(ipv4),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(port); return b })()
  ]))
  const reply = await reader.read(10)
  assert.equal(reply[1], 0, 'SOCKS5 CONNECT 未成功，reply=' + reply[1])

  const all = readAll(socket)
  socket.write(httpRequestLine(host, port, path, false))
  return bodyOf(await all)
}

// ─────────────────────────────────────────────────────────── 测试

test('【A 直连】空规则 = 不走任何代理', async () => {
  const origin = await startOrigin()
  const proxy = await startHttpProxy('A')
  try {
    const rules = proxyRulesOf({ proxyType: 'none' })
    assert.equal(rules, '', '直连线路必须生成空规则')
    assert.equal(parseProxyRules(rules), null, '空规则不该被当成代理')

    const resp = await fetchDirect('127.0.0.1', origin.port, '/')
    assert.equal(resp.via, 'direct', '直连时目标站不该看到任何代理标记')
    assert.equal(proxy.state.hits, 0, '直连不该碰到代理')
  } finally {
    await origin.close()
    await proxy.close()
  }
})

test('【A 加代理 → 出口变化】产品生成的 http 规则真的能连上代理并到达目标', async () => {
  const origin = await startOrigin()
  const proxy = await startHttpProxy('A')
  try {
    const rules = proxyRulesOf({ proxyType: 'http', proxyHost: '127.0.0.1', proxyPort: String(proxy.port) })
    assert.equal(parseProxyRules(rules).host, '127.0.0.1')
    assert.equal(parseProxyRules(rules).port, proxy.port)

    const resp = await fetchViaHttpProxy(rules, '127.0.0.1', origin.port, '/')
    assert.equal(resp.ok, true, '请求应经代理到达目标站')
    assert.equal(resp.via, 'A', '出口应变成代理 A')
    assert.equal(proxy.state.hits, 1, '代理 A 应恰好承载 1 次请求')
  } finally {
    await origin.close()
    await proxy.close()
  }
})

test('【P0】http 代理账密走 login 通道：规则串不含凭据，凭据由 proxyAuthOf 提供', async () => {
  const origin = await startOrigin()
  const proxy = await startHttpProxy('A', { user: 'pix-user', pass: 'p@ss:word' })
  try {
    const settings = {
      proxyType: 'http',
      proxyHost: '127.0.0.1',
      proxyPort: String(proxy.port),
      proxyUser: 'pix-user',
      proxyPass: 'p@ss:word'
    }
    const rules = proxyRulesOf(settings)
    // 规则串只有地址：凭据一旦拼进去，Chromium 会直接报 ERR_NO_SUPPORTED_PROXIES
    assert.equal(rules, 'http://127.0.0.1:' + proxy.port)
    const creds = proxyAuthOf(settings)
    assert.deepEqual(creds, { scheme: 'http', host: '127.0.0.1', port: String(proxy.port), user: 'pix-user', pass: 'p@ss:word' })

    const resp = await fetchViaHttpProxy(rules, '127.0.0.1', origin.port, '/', creds)
    assert.equal(resp.via, 'A')
    assert.equal(proxy.state.authed, 1, '代理应收到并接受 login 交回的凭据')
    assert.equal(proxy.state.rejected, 1, '第一次不带凭据必须被 407 拒绝（证明凭据确实来自认证通道）')

    // 错密码：重试也会被拒，绝不能蒙混通过
    const wrong = Object.assign({}, settings, { proxyPass: 'nope' })
    const denied = await fetchViaHttpProxy(proxyRulesOf(wrong), '127.0.0.1', origin.port, '/', proxyAuthOf(wrong))
    assert.ok(String(denied.raw || '').includes('407') || proxy.state.rejected >= 2, '错误账密必须被代理拒绝')
    assert.equal(proxy.state.authed, 1, '错误账密不应被接受')
  } finally {
    await origin.close()
    await proxy.close()
  }
})

test('【SOCKS5】产品生成的 socks5 规则能走真实 SOCKS5 隧道', async () => {
  const origin = await startOrigin()
  const proxy = await startSocks5Proxy('S')
  try {
    const rules = proxyRulesOf({ proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: String(proxy.port) })
    assert.equal(rules, 'socks5://127.0.0.1:' + proxy.port)
    const resp = await fetchViaSocks5(rules, '127.0.0.1', origin.port, '/')
    assert.equal(resp.ok, true)
    assert.equal(proxy.state.hits, 1, 'SOCKS5 代理应承载 1 次 CONNECT')
  } finally {
    await origin.close()
    await proxy.close()
  }
})

test('【P0】带认证的 SOCKS5 走本地中继：Chromium 侧无凭据，中继侧完成 RFC1929', async () => {
  const origin = await startOrigin()
  const proxy = await startSocks5Proxy('S', { user: 'u1', pass: 'p1' })
  const settings = {
    proxyType: 'socks5',
    proxyHost: '127.0.0.1',
    proxyPort: String(proxy.port),
    proxyUser: 'u1',
    proxyPass: 'p1'
  }
  const relay = createSocksRelay({ host: '127.0.0.1', port: proxy.port, user: 'u1', pass: 'p1' })
  try {
    // 没有中继地址时不产出规则串（产品会先起中继，绝不静默直连）
    assert.equal(proxyRulesOf(settings), '')
    const info = await relay.start()
    const rules = proxyRulesOf(settings, { relayEndpoint: '127.0.0.1:' + info.port })
    assert.equal(rules, 'socks5://127.0.0.1:' + info.port)
    assert.ok(!rules.includes('u1') && !rules.includes('p1'), 'Chromium 看到的规则里不能有凭据')

    // 客户端（= Chromium）对中继说的是一段**无认证**的 SOCKS5；
    // 用户名/密码子协商发生在「中继 → 上游」那一段，由中继完成。
    const resp = await fetchViaSocks5(rules, '127.0.0.1', origin.port, '/')
    assert.equal(resp.ok, true)
    assert.equal(proxy.state.authed, 1, '中继必须完成上游的 RFC1929 认证')
    assert.equal(proxy.state.hits, 1, 'SOCKS5 代理应承载 1 次 CONNECT')
  } finally {
    await relay.close()
    await origin.close()
    await proxy.close()
  }
})

test('【P0】中继密码错误：连接必须失败，绝不降级放行', async () => {
  const origin = await startOrigin()
  const proxy = await startSocks5Proxy('S', { user: 'u1', pass: 'p1' })
  const badRelay = createSocksRelay({ host: '127.0.0.1', port: proxy.port, user: 'u1', pass: 'wrong' })
  try {
    const info = await badRelay.start()
    await assert.rejects(
      () => fetchViaSocks5('socks5://127.0.0.1:' + info.port, '127.0.0.1', origin.port, '/'),
      /提前关闭|CONNECT 未成功|认证失败/,
      '错误密码必须失败，绝不能静默降级成无认证隧道'
    )
    assert.ok(proxy.state.rejected >= 1, '上游必须记录到一次认证拒绝')
    assert.equal(proxy.state.hits, 0, '认证失败时不该建立任何 CONNECT 隧道')
  } finally {
    await badRelay.close()
    await origin.close()
    await proxy.close()
  }
})

test('【A 修改代理 → 立即变化】最后一次规则决定出口，旧代理不再增长', async () => {
  const origin = await startOrigin()
  const proxyA = await startHttpProxy('A')
  const proxyB = await startHttpProxy('B')
  try {
    const settings = { proxyType: 'http', proxyHost: '127.0.0.1', proxyPort: String(proxyA.port) }
    await fetchViaHttpProxy(proxyRulesOf(settings), '127.0.0.1', origin.port, '/')
    assert.equal(proxyA.state.hits, 1)

    // 用户把这条线路的代理改成 B
    const changed = Object.assign({}, settings, { proxyPort: String(proxyB.port) })
    const resp = await fetchViaHttpProxy(proxyRulesOf(changed), '127.0.0.1', origin.port, '/')
    assert.equal(resp.via, 'B', '改代理后出口必须立刻变成 B')
    assert.equal(proxyB.state.hits, 1)
    assert.equal(proxyA.state.hits, 1, '旧代理不该再收到新流量')
  } finally {
    await origin.close()
    await proxyA.close()
    await proxyB.close()
  }
})

test('【A 删除代理 → 恢复直连】none 生成空规则，流量回到本机网络', async () => {
  const origin = await startOrigin()
  const proxy = await startHttpProxy('A')
  try {
    await fetchViaHttpProxy(
      proxyRulesOf({ proxyType: 'http', proxyHost: '127.0.0.1', proxyPort: String(proxy.port) }),
      '127.0.0.1', origin.port, '/'
    )
    assert.equal(proxy.state.hits, 1)

    const rules = proxyRulesOf({ proxyType: 'none' })
    assert.equal(rules, '')
    const resp = await fetchDirect('127.0.0.1', origin.port, '/')
    assert.equal(resp.via, 'direct', '删除代理后必须回到直连')
    assert.equal(proxy.state.hits, 1, '删除代理后不该再有流量进代理')
  } finally {
    await origin.close()
    await proxy.close()
  }
})

test('【不串线】A/B 两条线路各走各的代理', async () => {
  const origin = await startOrigin()
  const proxyA = await startHttpProxy('A')
  const proxyB = await startHttpProxy('B')
  try {
    const tabA = { proxyType: 'http', proxyHost: '127.0.0.1', proxyPort: String(proxyA.port) }
    const tabB = { proxyType: 'socks5', proxyHost: '127.0.0.1', proxyPort: String(proxyB.port) }
    // B 用 http 规则更直观：把 socks5 换成 http 代理做隔离验证
    tabB.proxyType = 'http'

    const respA = await fetchViaHttpProxy(proxyRulesOf(tabA), '127.0.0.1', origin.port, '/')
    const respB = await fetchViaHttpProxy(proxyRulesOf(tabB), '127.0.0.1', origin.port, '/')
    assert.equal(respA.via, 'A')
    assert.equal(respB.via, 'B')
    assert.equal(proxyA.state.hits, 1)
    assert.equal(proxyB.state.hits, 1)
    assert.notEqual(proxyRulesOf(tabA), proxyRulesOf(tabB), '两条线路的规则必须不同')
  } finally {
    await origin.close()
    await proxyA.close()
    await proxyB.close()
  }
})

test('【重启】从落盘 rows 逐条重建规则，每条仍走自己的代理', async () => {
  const origin = await startOrigin()
  const proxyA = await startHttpProxy('A')
  const proxyB = await startHttpProxy('B')
  try {
    // 模拟 open-apps.json 落盘 → 重启 → 逐条恢复
    const persisted = [
      { id: 'A', settings: { proxyType: 'http', proxyHost: '127.0.0.1', proxyPort: String(proxyA.port) } },
      { id: 'B', settings: { proxyType: 'http', proxyHost: '127.0.0.1', proxyPort: String(proxyB.port) } },
      { id: 'C', settings: { proxyType: 'none' } }
    ]
    for (const row of persisted) {
      const rules = proxyRulesOf(row.settings)
      assert.equal(rules, proxyRulesOf(row.settings), '恢复必须可重复（幂等）')
    }
    const a = await fetchViaHttpProxy(proxyRulesOf(persisted[0].settings), '127.0.0.1', origin.port, '/')
    const b = await fetchViaHttpProxy(proxyRulesOf(persisted[1].settings), '127.0.0.1', origin.port, '/')
    const c = await fetchDirect('127.0.0.1', origin.port, '/')
    assert.equal(a.via, 'A')
    assert.equal(b.via, 'B')
    assert.equal(c.via, 'direct', 'C 是直连线路，重启后仍是直连')
    assert.equal(proxyA.state.hits, 1)
    assert.equal(proxyB.state.hits, 1)
  } finally {
    await origin.close()
    await proxyA.close()
    await proxyB.close()
  }
})

test('【P0】整行粘贴 主机:端口:账号:密码 —— 解析正确，且凭据不进规则串', async () => {
  const origin = await startOrigin()
  const proxy = await startHttpProxy('A', { user: 'u1', pass: 'p1' })
  try {
    const settings = { proxyType: 'http', proxyHost: '127.0.0.1:' + proxy.port + ':u1:p1' }
    // 旧实现会把整串当主机名，拼成 http://...:u1:p1:<port> 这种坏规则
    const rules = proxyRulesOf(settings)
    assert.equal(rules, 'http://127.0.0.1:' + proxy.port)
    assert.deepEqual(proxyAuthOf(settings), { scheme: 'http', host: '127.0.0.1', port: String(proxy.port), user: 'u1', pass: 'p1' })
    const resp = await fetchViaHttpProxy(rules, '127.0.0.1', origin.port, '/', proxyAuthOf(settings))
    assert.equal(resp.via, 'A', '整行粘贴后应能真的连出去')
    assert.equal(proxy.state.authed, 1)
  } finally {
    await origin.close()
    await proxy.close()
  }
})

test('【与 setProxy 的契约】applySessionProxy 收到的正是可用的规则串', async () => {
  const origin = await startOrigin()
  const proxy = await startHttpProxy('A')
  try {
    const seen = []
    const ses = {
      setProxy(arg) {
        seen.push(arg)
        return Promise.resolve()
      }
    }
    await applySessionProxy(ses, { proxyType: 'http', proxyHost: '127.0.0.1', proxyPort: String(proxy.port) })
    await applySessionProxy(ses, { proxyType: 'none' })

    assert.equal(seen.length, 2)
    assert.equal(seen[0].proxyRules, 'http://127.0.0.1:' + proxy.port)
    assert.equal(seen[0].proxyBypassRules, '<local>')
    assert.deepEqual(seen[1], { mode: 'direct' })

    // 交给 proxyRulesOf 之外的消费者（真实代理）也能用
    const resp = await fetchViaHttpProxy(seen[0].proxyRules, '127.0.0.1', origin.port, '/')
    assert.equal(resp.via, 'A')
  } finally {
    await origin.close()
    await proxy.close()
  }
})
