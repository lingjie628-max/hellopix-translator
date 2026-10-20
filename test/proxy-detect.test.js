'use strict'

/**
 * 代理节点检测的单元测试。
 *
 * 这段代码的每一行注释背后都是一次真机事故，所以测试也必须守住这些：
 *
 *   1. 预检**没有否决权** —— 只有 TIMEOUT 能直接判死。
 *      CONNECT 被拒 / 应答码不认识 都必须继续走真实网页探测。
 *      （0.1.29~0.1.33 的回归：以前能检测、修完就再也检测不过）
 *
 *   2. 探测窗口必须"先优雅中止、再延迟销毁"。
 *      卡在握手的渲染进程需要一拍才能收口，立刻 destroy 会把整个
 *      渲染基础设施弄坏 —— 之后应用再也起不了窗口。
 *
 *   3. IP 只保留 \w . : —— 防止上游往响应里塞东西。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createProxyDetect } = require('../desktop/src/proxy/detect')

function makeProbeWindow (behaviour) {
  const b = behaviour || {}
  const wc = new EventEmitter()
  wc.id = 7
  let destroyed = false
  Object.assign(wc, {
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true; b.destroyedBy = 'wc' },
    stop: () => { b.stopped = true },
    removeAllListeners: EventEmitter.prototype.removeAllListeners.bind(wc),
    loadURL: url => {
      b.loadedUrl = url
      setImmediate(() => {
        if (b.failWith) wc.emit('did-fail-load', {}, b.failWith, 'ERR_FAILED')
        else wc.emit('did-finish-load')
      })
    }
  })
  const win = {
    webContents: wc,
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true }
  }
  return { win, wc, behaviour: b }
}

function harness (opts) {
  const o = opts || {}
  const probeWindows = new Set()
  const proxyAuthByWebContents = new Map()
  const logs = []
  const notes = []
  const windows = []
  let setProxyCalls = []
  let clearedStorage = 0

  const ses = {
    setProxy: async arg => { setProxyCalls.push(arg) },
    clearStorageData: async () => { clearedStorage++ }
  }

  const detect = createProxyDetect({
    electron: {
      BrowserWindow: function () {
        const made = makeProbeWindow(o.probe)
        windows.push(made)
        return made.win
      },
      session: { fromPartition: () => ses }
    },
    maps: { probeWindows, proxyAuthByWebContents },
    libs: {
      readPageText: async () => o.pageText === undefined ? '1.2.3.4' : o.pageText,
      precheckSocks5: async () => o.pre || { ok: true, code: 'OK', ms: 12, tried: [] },
      createSocksRelay: () => ({
        start: async () => ({ port: 12345 }),
        close: async () => {}
      }),
      proxyTargetOf: s => o.target || {
        scheme: 'socks5', host: '127.0.0.1', port: 1080, direct: false, hasAuth: false
      },
      proxyAuthOf: () => (o.creds || null),
      proxyRulesOf: () => 'socks5://127.0.0.1:1080',
      lookupIpGeo: async (ip, ch) => ({ ip, country: 'US', channel: ch }),
      parseJsonSafe: txt => { try { return JSON.parse(txt) } catch (e) { return null } }
    },
    io: {
      log: () => ({ info: (ch, msg) => logs.push([ch, msg]) }),
      noteProxyIp: ip => { notes.push(ip); return 1700000000000 }
    },
    env: { PROBE_TIMEOUT_MS: 5000 }
  })
  return { detect, probeWindows, proxyAuthByWebContents, logs, notes, windows,
    ses, setProxyCalls: () => setProxyCalls, clearedStorage: () => clearedStorage }
}

test('填了直连 / 缺主机时立刻拒绝，不建窗口', async () => {
  const { detect, windows } = harness({ target: { direct: true, host: '' } })
  const r = await detect.detectProxyNode({})
  assert.equal(r.success, false)
  assert.match(r.msg, /代理主机和端口/)
  assert.equal(windows.length, 0)
})

test('★ 预检 TIMEOUT 才允许直接判死（而且不建窗口）', async () => {
  const { detect, windows } = harness({
    pre: { ok: false, code: 'TIMEOUT', reason: '节点无响应', ms: 5000, tried: [{ host: 'a', port: 1, code: 'TIMEOUT', ms: 5000 }] }
  })
  const r = await detect.detectProxyNode({})
  assert.equal(r.success, false)
  assert.equal(r.code, 'TIMEOUT')
  assert.match(r.msg, /节点连不上/)
  assert.equal(windows.length, 0, '不回话的节点绝不能进 Chromium —— 那会弄坏渲染基础设施')
})

test('★ 预检否定但不是 TIMEOUT 时，必须继续走真实网页探测', async () => {
  const { detect, windows } = harness({
    pre: { ok: false, code: 'CONNECT_REPLY_0x05', reason: '连接被拒', ms: 30, tried: [] },
    pageText: '9.9.9.9'
  })
  const r = await detect.detectProxyNode({})
  assert.equal(windows.length, 1, '预检没有否决权：必须真的开窗试一次')
  assert.equal(r.success, true, '真实探测成功就该判成功')
  assert.equal(r.ip, '9.9.9.9')
})

test('预检通过但真实加载失败 → 以真实加载为准，预检码只作线索', async () => {
  const { detect } = harness({
    pre: { ok: true, code: 'OK', ms: 10, tried: [] },
    probe: { failWith: -105 }
  })
  const r = await detect.detectProxyNode({})
  assert.equal(r.success, false)
  assert.match(r.msg, /节点连不上/)
})

test('真实加载失败时，预检的否定结论作为补充线索附上（不冒充原因）', async () => {
  const { detect } = harness({
    pre: { ok: false, code: '0x08', reason: '地址类型不支持', ms: 5, tried: [] },
    probe: { failWith: -105 }
  })
  const r = await detect.detectProxyNode({})
  assert.equal(r.success, false)
  assert.match(r.msg, /预检线索/)
  assert.match(r.msg, /地址类型不支持/)
})

test('探测成功：返回 IP + 地理信息 + 使用历史', async () => {
  const { detect, notes } = harness({ pageText: '8.8.8.8' })
  const r = await detect.detectProxyNode({ proxyChannel: 'ipinfo' })
  assert.equal(r.success, true)
  assert.equal(r.ip, '8.8.8.8')
  assert.equal(r.geo.channel, 'ipinfo')
  assert.ok(r.history && r.history.at)
  assert.deepEqual(notes, ['8.8.8.8'])
})

test('JSON 形式的响应能取出 ip 字段', async () => {
  const { detect } = harness({ pageText: '{"ip":"5.5.5.5"}' })
  const r = await detect.detectProxyNode({})
  assert.equal(r.ip, '5.5.5.5')
})

test('★ IP 只保留 \\w . : —— 上游响应里塞的其它字符必须被剔掉', async () => {
  const { detect } = harness({ pageText: '<script>alert(1)</script>1.2.3.4' })
  const r = await detect.detectProxyNode({})
  assert.equal(r.success, true)
  assert.doesNotMatch(r.ip, /[<>()/]/, '危险字符必须被剔掉：' + r.ip)
})

test('IPv6 模式使用 v6 探测地址', async () => {
  const { detect, windows } = harness({ pageText: '::1' })
  await detect.detectProxyNode({ proxyIpVer: 'ipv6' })
  assert.match(windows[0].behaviour.loadedUrl, /api64|api6|icanhazip/, 'IPv6 模式不能打 v4 地址')
})

test('★ 探测窗口必须"先 stop 再延迟 destroy"', async () => {
  const { detect, windows } = harness({ pageText: '1.1.1.1' })
  await detect.detectProxyNode({})
  const b = windows[0].behaviour
  assert.equal(b.stopped, true, '必须先优雅中止加载')
  assert.equal(b.destroyedBy, undefined, '不能立刻 destroy —— 卡在握手的进程要一拍才收口')
  await new Promise(r => setTimeout(r, 300))
  assert.ok(b.destroyedBy, '延迟后必须销毁，不能漏窗口')
})

test('探测结束后必须清 session：清存储 + 把代理改回直连', async () => {
  const h = harness({ pageText: '1.1.1.1' })
  await h.detect.detectProxyNode({})
  assert.ok(h.clearedStorage() > 0, '共享 partition 的残留会影响下次探测')
  const last = h.setProxyCalls()[h.setProxyCalls().length - 1]
  assert.deepEqual(last, { mode: 'direct' })
})

test('★ 预检过程必须真的写日志（原来那个 try 里引用了作用域外的 log，一行都没写进去）', async () => {
  const { detect, logs } = harness({
    pre: { ok: true, code: 'OK', ms: 12, tried: [{ host: 't1', port: 443, code: 'OK', ms: 11 }] }
  })
  await detect.detectProxyNode({})
  assert.ok(logs.length >= 2, '预检必须有日志，否则真机出问题只能靠截图猜')
  assert.match(logs[0][1], /precheck/)
  assert.match(logs[1][1], /target t1:443/)
})

test('日志里不能出现密码', async () => {
  const { detect, logs } = harness({
    creds: { user: 'u', pass: 'TOPSECRET' },
    target: { scheme: 'socks5', host: 'h', port: 1080, direct: false, hasAuth: true, user: 'u', pass: 'TOPSECRET' }
  })
  await detect.detectProxyNode({})
  const all = logs.map(l => l[1]).join('\n')
  assert.doesNotMatch(all, /TOPSECRET/, '日志绝不能带密码')
})

test('带认证的 SOCKS5 走中继，规则里用回环地址', async () => {
  const { detect, windows } = harness({
    target: { scheme: 'socks5', host: 'h', port: 1080, direct: false, hasAuth: true, user: 'u', pass: 'p' },
    pageText: '2.2.2.2'
  })
  const r = await detect.detectProxyNode({})
  assert.equal(r.success, true)
  assert.equal(windows.length, 1)
})

test('代理规则为空时明确拒绝', async () => {
  const h = harness()
  // 让 proxyRulesOf 返回空
  const detect2 = createProxyDetect({
    electron: { BrowserWindow: function () { return makeProbeWindow({}).win }, session: { fromPartition: () => h.ses } },
    maps: { probeWindows: new Set(), proxyAuthByWebContents: new Map() },
    libs: {
      readPageText: async () => '',
      precheckSocks5: async () => ({ ok: true, code: 'OK', ms: 1, tried: [] }),
      createSocksRelay: () => ({ start: async () => ({ port: 1 }), close: async () => {} }),
      proxyTargetOf: () => ({ scheme: 'http', host: 'h', port: 1, direct: false, hasAuth: false }),
      proxyAuthOf: () => null,
      proxyRulesOf: () => '',
      lookupIpGeo: async ip => ({ ip }),
      parseJsonSafe: () => null
    },
    io: { log: () => null, noteProxyIp: () => 0 },
    env: { PROBE_TIMEOUT_MS: 100 }
  })
  const r = await detect2.detectProxyNode({})
  assert.equal(r.success, false)
  assert.match(r.msg, /代理主机和端口/)
})
