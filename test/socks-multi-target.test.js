'use strict'

/**
 * 0.1.33 —— 三件真机反馈驱动的改造，这里是它们的**回归护栏**：
 *
 *   1. **多目标并发预检**：只要有一个目标能 CONNECT 成功，节点就算可用。
 *      以前只试 `api.ipify.org` 一个，一次失败就判"节点连不上" ——
 *      而真机抓到的节点对不同目标回不同应答码（1.1.1.1 → 0x01，
 *      8.8.8.8 / 域名 → 0x08），说明它是活的不让出去，单目标判定太脆弱。
 *
 *   2. **0x08 的文案不能再宣称"只支持 IPv4"**：同一节点对纯 IPv4
 *      字面量也拒绝，这个说法被真机反证了。
 *
 *   3. **同节点复用中继**：同一组 host/port/账密只起一个本地中继，
 *      靠引用计数保证"最后一个窗口关掉才真正关闭"。
 *      这条是防"关 A 窗口把 B 窗口的连接一起掐掉"的回归。
 */

const assert = require('node:assert/strict')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const {
  precheckSocks5,
  describeConnectReply,
  pickWorstOutcome,
  PRECHECK_TARGETS
} = require(path.join(root, 'desktop', 'socks-relay.js'))

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 可编排的假 SOCKS5 上游：按「目标域名」决定回什么。
 *
 * `behavior(host)` 返回：
 *   'ok'      → 0x00 成功
 *   number    → 以该 SOCKS5 REP 码拒绝
 *   'silent'  → 不回（模拟假死）
 *
 * 这里用的是**真 TCP + 真 SOCKS5 字节**，不是替身对象 ——
 * 所以它能覆盖真实的握手顺序与粘包。
 */
function startSwitchableUpstream (behavior) {
  const seen = []
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let stage = 'greet'
    let pendingHost = ''
    socket.on('data', chunk => {
      if (stage === 'greet') {
        if (chunk[0] !== 0x05) return
        stage = 'req'
        socket.write(Buffer.from([0x05, 0x00]))       // 无认证
        return
      }
      if (stage === 'req') {
        // ★ 注意字段位置：本实现的 CONNECT 请求是 [VER][CMD][ATYP][LEN][HOST…][PORT..] ★
        //
        // 第一版测试按 [VER][CMD][RSV][ATYP] 取 chunk[3] 当 ATYP，取到了域名的首字母
        // （0x16='w'）—— 于是行为永远落到 default 分支，四个目标都被"拒"。
        // 用第 3 字节（索引 2）判断才是对的：0x03 域名 / 0x01 IPv4。
        const cmd = chunk[1]
        const atyp = chunk[2]
        if (cmd !== 0x01 || (atyp !== 0x03 && atyp !== 0x01)) {
          // 还是问候包（客户端可能分两包发），按问候应答回去
          socket.write(Buffer.from([0x05, 0x00]))
          return
        }
        let host = ''
        if (atyp === 0x03) {
          const len = chunk[3]
          host = chunk.slice(4, 4 + len).toString()
        } else {
          host = Array.from(chunk.slice(3, 7)).join('.')
        }
        seen.push(host)
        stage = 'done'
        const act = behavior(host)
        if (act === 'silent') return
        if (act === 'ok') { socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1F, 0x90])); return }
        socket.write(Buffer.from([0x05, act, 0x00, 0x01, 186, 240, 232, 207, 213, 37]))
      }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        seen,
        close () {
          for (const s of sockets) { try { s.destroy() } catch (e) {} }
          return new Promise(r => server.close(() => r()))
        }
      })
    })
  })
}

// ---------------------------------------------------------------------------
// 1. 多目标：任一成功即判可用
// ---------------------------------------------------------------------------

test('多目标预检：只有 web.whatsapp.com 通 → 必须判可用（单目标时代的误杀）', async () => {
  const up = await startSwitchableUpstream(host => (host === 'web.whatsapp.com' ? 'ok' : 0x08))
  try {
    const r = await precheckSocks5({ host: '127.0.0.1', port: up.port, timeoutMs: 3000 })
    assert.equal(r.ok, true, '只有一个目标通也必须判可用：' + JSON.stringify(r))
    assert.equal(r.code, 'OK')
    assert.ok(up.seen.includes('web.whatsapp.com'), '必须真的去试 WhatsApp Web')
  } finally { await up.close() }
})

test('多目标预检：全部被拒 → 判失败，并给出节点侧原因', async () => {
  const up = await startSwitchableUpstream(() => 0x08)
  try {
    const r = await precheckSocks5({ host: '127.0.0.1', port: up.port, timeoutMs: 3000 })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'CONNECT_REFUSED')
    // 0x08 = RFC1928「地址类型不受支持」。文案要说这个，不能说成"账号欠费"。
    assert.match(r.reason, /地址/)
    assert.doesNotMatch(r.reason, /流量用尽|套餐到期/)
  } finally { await up.close() }
})

test('多目标预检：任一目标假死，也不能把整体拖死（其余目标仍能定论）', async () => {
  const up = await startSwitchableUpstream(host => (host === 'www.google.com' ? 'silent' : 0x08))
  try {
    const t0 = Date.now()
    const r = await precheckSocks5({ host: '127.0.0.1', port: up.port, timeoutMs: 3000 })
    const ms = Date.now() - t0
    assert.equal(r.ok, false)
    assert.ok(ms < 2500, '一个目标假死不该拖到超时，实际 ' + ms + 'ms')
  } finally { await up.close() }
})

test('多目标预检：成功要掐掉仍在飞行的探测，不留悬挂连接', async () => {
  const up = await startSwitchableUpstream(host => (host === 'web.whatsapp.com' ? 'ok' : 'silent'))
  try {
    const r = await precheckSocks5({ host: '127.0.0.1', port: up.port, timeoutMs: 5000 })
    assert.equal(r.ok, true)
    // 成功之后，假死的那几个必须被主动断开 —— 上游侧不应留下活跃 socket。
    // 用一个很短的等待让 close 事件跑完，再断言已无活跃连接。
    await sleep(300)
    // 无法直接读上游 socket 数，改用「再次预检能正常完成」来间接证明事件循环没被占满。
    const again = await precheckSocks5({ host: '127.0.0.1', port: up.port, timeoutMs: 5000 })
    assert.equal(again.ok, true)
  } finally { await up.close() }
})

test('PRECHECK_TARGETS：必须包含用户真实访问的 WhatsApp Web，且都用 443', () => {
  const hosts = PRECHECK_TARGETS.map(t => t.host)
  assert.ok(hosts.includes('web.whatsapp.com'), '必须把用户真正要打开的站点纳入探测：' + hosts.join(','))
  assert.ok(PRECHECK_TARGETS.length >= 3, '至少要有几个兜底目标，否则又退化成单点判定')
  for (const t of PRECHECK_TARGETS) assert.equal(t.port, 443, t.host + ' 应该走 443')
})

// ---------------------------------------------------------------------------
// 2. 应答码文案
// ---------------------------------------------------------------------------

test('0x08 的文案必须回到 RFC1928 原意：地址类型不受支持', () => {
  const text = describeConnectReply(0x08)
  assert.doesNotMatch(text, /IPv4/, '纯 IPv4 目标同样被拒，这个解释是错的：' + text)
  // 0.1.32 把它改成"流量用尽/套餐到期"，这个说法没有协议依据，
  // 且会把用户直接送去换节点，真正的"节点连不上目标网站"永远查不出来。
  assert.doesNotMatch(text, /流量用尽|套餐到期/, 'RFC1928 里 X\'08\' 不是账号欠费的意思：' + text)
  assert.match(text, /地址/, 'RFC1928 原文：X\'08\' Address type not supported')
  assert.match(text, /服务商|更换节点/, '要给出用户能做的下一步')
})

test('main.js：预检不得拥有否决权（0.1.29~0.1.33 回归的护栏）', () => {
  const src = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  // 只有"节点没回话"允许短路返回；其他任何预检结论都必须继续走真实网页探测。
  assert.match(src, /const hardBlock = pre && pre\.code === 'TIMEOUT'/,
    '预检只允许 TIMEOUT 直接返回')
  assert.doesNotMatch(src, /if \(!pre\.ok\)\s*\{\s*return \{ success: false/,
    '不许再用 !pre.ok 直接判死 —— 那正是"以前能过、修完就过不了"的原因')
})

test('0x01 / 未知码 都要给出可行动的下一步，而不是裸数字', () => {
  for (const rep of [0x01, 0x02, 0x07, 0x63]) {
    const text = describeConnectReply(rep)
    assert.match(text, /服务商|更换节点/, '应答码 ' + rep + ' 的文案没有出路：' + text)
    assert.doesNotMatch(text, /reply=/, '不该把裸数字丢给用户：' + text)
  }
})

test('pickWorstOutcome：账号密码错必须优先于"网络无响应"报出来', () => {
  const pick = pickWorstOutcome([
    { code: 'TIMEOUT', reason: '超时' },
    { code: 'AUTH_FAILED', reason: '账号或密码不对' },
    { code: 'CONNECT_FAILED', reason: '连接失败' }
  ])
  assert.equal(pick.code, 'AUTH_FAILED', '用户自己就能改的问题要优先说')
})

test('pickWorstOutcome：CONNECT 应答码**不得**凌驾于"节点没回话"之上', () => {
  // 0.1.33 时这里断言的是相反方向（CONNECT_REFUSED 优先）。那个排序在真机上造成了回归：
  // 只要某一个目标的 CONNECT 被拒，整个节点就被判死，连"真实打开网页"都不再尝试。
  // CONNECT 应答码只说明**那一个地址**没被放行，换目标可能就通了 —— 它不能当死因。
  const pick = pickWorstOutcome([
    { code: 'TIMEOUT', reason: '超时' },
    { code: 'CONNECT_REFUSED', reason: '节点拒绝了连接' }
  ])
  assert.equal(pick.code, 'TIMEOUT', '只有"没回话"才是确定的节点侧死因')
})

// ---------------------------------------------------------------------------
// 3. 同节点复用中继（源码级护栏）
// ---------------------------------------------------------------------------

test('main.js：中继按 key 池化，且用引用计数保护"关一个不影响其他"', () => {
  const src = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  assert.match(src, /const relayPool = new Map\(\)/, '必须有中继池')
  assert.match(src, /entry\.refs \+= 1/, '复用时必须增加引用计数')
  assert.match(src, /if \(entry\.refs > 0\) return/, '最后一个租约归还前不许关闭')
  assert.match(src, /relayPool\.delete\(cur\.key\)/, '引用归零后要出池')
  // 池化不能削弱隔离：key 必须仍然包含账密
  assert.match(src, /\[target\.host, target\.port, target\.user, target\.pass\]/,
    'key 必须包含 host/port/账密，否则不同账号会串中继')
})

test('main.js：退出时清理的是池里的中继，不是 tab 记录', () => {
  const src = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8')
  assert.match(src, /relayPool\.forEach\(entry => \{ try \{ entry\.relay\.close\(\) \}/,
    '退出清理必须遍历 relayPool，否则端口不释放')
})
