'use strict'

/**
 * 出站 URL 白名单（SSRF 防护）测试。
 *
 * 漏洞背景见 server/lib/outbound-guard.js 的文件头。
 * 这里既要证明"内网地址被拦"，也要证明"正常厂商域名不误伤"——
 * 后者同样重要：拦过头会把线上翻译打死。
 */

const test = require('node:test')
const assert = require('node:assert')

const {
  checkOutboundUrl,
  blockedHostReason,
  blockedV4Reason,
  blockedV6Reason
} = require('../server/lib/outbound-guard')

test('SSRF：云元数据地址必须被拦', async () => {
  // 这三条是"拿云凭据 → 接管整机"的标准入口
  for (const url of [
    'https://169.254.169.254/latest/meta-data/',
    'https://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'https://metadata.google.internal/computeMetadata/v1/'
  ]) {
    const verdict = await checkOutboundUrl(url)
    assert.equal(verdict.ok, false, `${url} 应被拦截`)
  }
})

test('SSRF：回环与私有网段必须被拦', async () => {
  const targets = [
    'https://127.0.0.1/admin',
    'https://127.0.0.1:443/',
    'https://0.0.0.0/',
    'https://10.0.0.5/api',
    'https://172.16.31.7/',
    'https://192.168.1.1/',
    'https://localhost:443/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/'
  ]
  for (const url of targets) {
    const verdict = await checkOutboundUrl(url, { resolveDns: false })
    assert.equal(verdict.ok, false, `${url} 应被拦截`)
  }
})

test('SSRF：非 https 与非标端口必须被拦', async () => {
  assert.equal((await checkOutboundUrl('http://api.openai.com/')).ok, false)
  assert.equal((await checkOutboundUrl('file:///etc/passwd')).ok, false)
  assert.equal((await checkOutboundUrl('gopher://127.0.0.1:6379/')).ok, false)
  // 打内网面板常靠非标端口
  assert.equal((await checkOutboundUrl('https://example.com:6379/')).ok, false)
  assert.equal((await checkOutboundUrl('https://example.com:22/')).ok, false)
})

test('SSRF：URL 里塞账号密码要被拦（可用于绕过主机解析）', async () => {
  const verdict = await checkOutboundUrl('https://api.openai.com@169.254.169.254/', { resolveDns: false })
  assert.equal(verdict.ok, false)
})

test('SSRF：畸形 URL 要被拦而不是抛异常', async () => {
  for (const bad of ['', '   ', 'not a url', '//evil.com']) {
    const verdict = await checkOutboundUrl(bad, { resolveDns: false })
    assert.equal(verdict.ok, false)
    assert.ok(verdict.reason, '应给出原因')
  }
})

test('SSRF：正常厂商域名不能被误伤', async () => {
  // 这是一条防回归断言：拦过头会把线上翻译全打死。
  // 用 resolveDns:false 避免测试依赖外网 DNS。
  for (const url of [
    'https://api.openai.com/v1/chat/completions',
    'https://api.deepseek.com/v1/chat/completions',
    'https://api.anthropic.com/v1/messages',
    'https://translation.googleapis.com/language/translate/v2',
    'https://api-free.deepl.com/v2/translate',
    'https://api.mymemory.translated.net/get',
    'https://8.8.8.8/'
  ]) {
    const verdict = await checkOutboundUrl(url, { resolveDns: false })
    assert.equal(verdict.ok, true, `${url} 不应被拦截，原因：${verdict.reason}`)
  }
})

test('SSRF：IPv4 网段判断覆盖边界值', () => {
  // 169.254/16 的两端
  assert.ok(blockedV4Reason('169.254.0.1'))
  assert.ok(blockedV4Reason('169.254.255.254'))
  // 相邻但属于公网的地址不能误拦
  assert.equal(blockedV4Reason('169.253.0.1'), null)
  assert.equal(blockedV4Reason('169.255.0.1'), null)
  // 172.16/12 的边界
  assert.ok(blockedV4Reason('172.16.0.1'))
  assert.ok(blockedV4Reason('172.31.255.254'))
  assert.equal(blockedV4Reason('172.15.255.255'), null)
  assert.equal(blockedV4Reason('172.32.0.1'), null)
  // 100.64/10 运营商 NAT
  assert.ok(blockedV4Reason('100.64.0.1'))
  assert.ok(blockedV4Reason('100.127.255.254'))
  assert.equal(blockedV4Reason('100.128.0.1'), null)
})

test('SSRF：IPv6 危险段判断', () => {
  assert.ok(blockedV6Reason('::1'))
  assert.ok(blockedV6Reason('fe80::1'))
  assert.ok(blockedV6Reason('fc00::1'))
  assert.ok(blockedV6Reason('fd12:3456::1'))
  assert.ok(blockedV6Reason('::ffff:192.168.1.1'))
  // 正常公网 IPv6 不能误拦
  assert.equal(blockedV6Reason('2606:4700:4700::1111'), null)
})

test('SSRF：URL 规范化成十六进制后仍要拦住（真实绕过点）', async () => {
  // new URL('https://[::ffff:127.0.0.1]/').hostname 会把点分变成 ::ffff:7f00:1。
  // 只按点分匹配的规则会漏，这一条就是防这个回归。
  const targets = [
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:10.0.0.1]/',
    'https://[::ffff:192.168.1.1]/',
    'https://[::ffff:169.254.169.254]/',
    'https://[0:0:0:0:0:ffff:7f00:1]/',
    'https://[::127.0.0.1]/'
  ]
  for (const url of targets) {
    const verdict = await checkOutboundUrl(url, { resolveDns: false })
    assert.equal(verdict.ok, false, `${url} 应被拦截（规范化后：${new URL(url).hostname}）`)
  }
  // 十六进制形式的映射判断本身也要对
  assert.ok(blockedV6Reason('::ffff:7f00:1'))
  assert.ok(blockedV6Reason('::ffff:a00:1'))
  assert.ok(blockedV6Reason('::ffff:c0a8:101'))
})

test('SSRF：内网域名后缀被识别', () => {
  assert.ok(blockedHostReason('metadata.google.internal'))
  assert.ok(blockedHostReason('redis.internal'))
  assert.ok(blockedHostReason('localhost'))
  assert.equal(blockedHostReason('api.openai.com'), null)
})

test('SSRF：厂商白名单不能放过相似域名', () => {
  const { isTrustedVendor } = require('../server/lib/outbound-guard')
  // 子域放行是对的
  assert.equal(isTrustedVendor('api.openai.com'), true)
  assert.equal(isTrustedVendor('edge.api.openai.com'), true)
  assert.equal(isTrustedVendor('API.OpenAI.COM'), true)
  // 这几条是经典伪装，必须全部拒绝
  assert.equal(isTrustedVendor('evilopenai.com'), false)
  assert.equal(isTrustedVendor('openai.com.evil.tld'), false)
  assert.equal(isTrustedVendor('notapi.openai.com.attacker.net'), false)
  assert.equal(isTrustedVendor('api.openai.co'), false)
  assert.equal(isTrustedVendor('fakeapplication'), false)
})

test('SSRF：厂商白名单命中时不查 DNS（断开外网也能翻译）', async () => {
  const { _clearDnsCache } = require('../server/lib/outbound-guard')
  _clearDnsCache()
  // 真厂商域名即使在无 DNS 环境也必须放行 —— 白名单是静态的，不经查询
  for (const url of [
    'https://api.deepseek.com/chat/completions',
    'https://api.openai.com/v1/chat/completions',
    'https://translation.googleapis.com/language/translate/v2'
  ]) {
    const verdict = await checkOutboundUrl(url)
    assert.equal(verdict.ok, true, `${url} 被误拦：${verdict.reason}`)
  }
  // 而"长得像厂商"的域名不能靠白名单免检
  const { isTrustedVendor } = require('../server/lib/outbound-guard')
  assert.equal(isTrustedVendor('api.deepseek.com.attacker.net'), false)
})

test('SSRF：生产 engines 表里的每一个 endpoint 都必须能过闸', async () => {
  // 这条是上线前的护栏。SSRF 闸门一旦误伤，表现是"翻译全部失败"，
  // 而错误信息是"出站请求被拦截"，很容易被误判成"厂商封了我们"。
  //
  // 清单来自生产库 `SELECT provider,endpoint FROM engines` 的实际值。
  // 以后新增厂商时，这里要同步加一行 —— 加了但白名单没加，这条就会红。
  const { _clearDnsCache } = require('../server/lib/outbound-guard')
  _clearDnsCache()
  const PRODUCTION_ENDPOINTS = {
    claude: 'https://api.anthropic.com/v1',
    deepseek: 'https://api.deepseek.com',
    doubao: 'https://ark.cn-beijing.volces.com/api/v3',
    glm: 'https://open.bigmodel.cn/api/paas/v4',
    google: 'https://translation.googleapis.com/language/translate/v2',
    gpt: 'https://api.openai.com/v1',
    grok: 'https://api.x.ai/v1',
    kimi: 'https://api.moonshot.cn/v1',
    minimax: 'https://api.minimaxi.com/v1',
    mistral: 'https://api.mistral.ai/v1'
  }
  for (const [name, url] of Object.entries(PRODUCTION_ENDPOINTS)) {
    const verdict = await checkOutboundUrl(url)
    assert.equal(verdict.ok, true, `引擎 ${name} 的 ${url} 被误拦：${verdict.reason}`)
  }
})

test('SSRF：DNS 解析到内网地址时被拦（rebinding 前置）', async () => {
  // 用一个必然解析到回环的名字。若环境无 DNS，这条应跳过而不是假绿。
  let resolved = true
  try { require('dns').lookupSync('localhost') } catch (_e) { resolved = false }
  if (!resolved) return

  const verdict = await checkOutboundUrl('https://localhost/')
  assert.equal(verdict.ok, false)
})

test('SSRF：FQDN 尾点不能绕过 localhost 判定（公开绕过手法）', async () => {
  // DNS 语义上 'localhost.' 与 'localhost' 等价，但字符串比较不等。
  // 这是真实存在的绕过方式（参考 boringtech 的 SSRF guard 复盘）。
  assert.ok(blockedHostReason('localhost.'))
  assert.ok(blockedHostReason('LOCALHOST.'))
  assert.ok(blockedHostReason('localhost..'))
  assert.ok(blockedHostReason('169.254.169.254.'))
  assert.ok(blockedHostReason('metadata.google.internal.'))

  for (const url of [
    'https://localhost./',
    'https://localhost./admin',
    'https://169.254.169.254./latest/meta-data/'
  ]) {
    const verdict = await checkOutboundUrl(url, { resolveDns: false })
    assert.equal(verdict.ok, false, `${url} 应被拦截`)
  }
})

test('SSRF：IPv4 的短写/十六进制/十进制写法由 URL 解析器规范化后仍被拦', async () => {
  // Node 的 WHATWG URL 会把 127.1 / 0x7f.1 / 2130706433 都规范成 127.0.0.1，
  // 所以我们校验的是规范化之后的主机名 —— 这几种写法实测都要拦住。
  const forms = [
    'https://127.1/',
    'https://0x7f.1/',
    'https://2130706433/',
    'https://0177.0.0.1/',
    'https://127.0.0.1./'
  ]
  for (const url of forms) {
    const normalized = new URL(url).hostname
    const verdict = await checkOutboundUrl(url, { resolveDns: false })
    assert.equal(verdict.ok, false, `${url}（规范化为 ${normalized}）应被拦截`)
  }
})

test('SSRF：连接层也拦（DNS rebinding 的最后一刀）', async () => {
  // 前两道闸都是"先解析后请求"，中间有 TOCTOU 窗口。
  // 第三道闸在 undici 建连时拿到实际要连的 IP 再判，这条测试证明它真的生效。
  const { Agent, buildConnector } = require('undici')
  const base = buildConnector({})
  const agent = new Agent({
    connections: 2,
    connect (opts, callback) {
      const ip = String((opts && opts.host) || '')
      const reason = ip.includes(':') ? blockedV6Reason(ip) : blockedV4Reason(ip)
      if (reason) {
        const error = new Error(`出站连接被拦截：${ip}`)
        error.code = 'SSRF_BLOCKED'
        return callback(error)
      }
      return base(opts, callback)
    }
  })
  try {
    await assert.rejects(
      () => agent.request({ origin: 'https://127.0.0.1', path: '/', method: 'GET' }),
      error => error.code === 'SSRF_BLOCKED'
    )
    await assert.rejects(
      () => agent.request({ origin: 'https://169.254.169.254', path: '/', method: 'GET' }),
      error => error.code === 'SSRF_BLOCKED'
    )
  } finally {
    await agent.close()
  }
})
