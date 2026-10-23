'use strict'

/**
 * 攻击链回归测试 —— 把"单个低危"拼成"完整接管"的那些路径，逐环钉死。
 *
 * ## 为什么要写这个文件
 *
 * 单个漏洞的 CVSS 往往不高，攻击者真正可怕的地方是**串起来**：
 *
 *   ① 普通商户账号注册
 *      ↓  （大小写绕过 /ADMIN/staff/save）—— 已修
 *   ② 后门超管建成，无 TOTP 也能登录 —— 已修（TOTP 强制开关）
 *      ↓
 *      ↓  ↓ 下面这两条是本轮发现并修掉的
 *   ③ 改翻译通道 endpoint → 服务器替他去读云元数据 → 拿 AK/SK
 *      ↓
 *   ④ 注册接口不用验证码就能探出全站账号 → 定向钓鱼拿密码
 *
 * 这个文件只测 ③④ 和它们各自的前置，② 的回归在 authz-e2e.test.js。
 *
 * 每一环失败时，测试要能**直接指出是哪一环漏了**，而不是只报一句 assert failed。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const guard = require('../server/lib/outbound-guard')

// ---------------------------------------------------------------- 第 ③ 环：SSRF

test('攻击链 ③：拿到超管后改 endpoint 打元数据，必须被拦住', async () => {
  // 攻击者在后台填的 endpoint（都是真实可用的元数据/内网入口）
  const payloads = [
    // AWS IMDS
    'https://169.254.169.254/latest/meta-data/iam/security-credentials/',
    // AWS IPv6 元数据（fd20:ce::254 是 IPv6 版元数据地址）
    'https://[fd20:ce::254]/latest/meta-data/iam/security-credentials/',
    // GCP
    'https://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    // 阿里云
    'https://100.100.100.200/latest/meta-data/ram/security-credentials/',
    // 本机 Redis / 管理面板
    'https://127.0.0.1:443/',
    // 内网跳板
    'https://10.0.0.1/',
    'https://192.168.1.1/'
  ]
  for (const endpoint of payloads) {
    const verdict = await guard.checkOutboundUrl(endpoint, { resolveDns: false })
    assert.equal(verdict.ok, false, `SSRF 未被拦住：${endpoint}`)
  }
})

test('攻击链 ③：用十六进制 IPv4-mapped 绕过（真实 CVE 手法）必须被拦住', async () => {
  // 参考 GHSA-vrcj-hv2q-c58m（twenty-server）：
  // URL 解析器把 [::ffff:169.254.169.254] 规范化成 [::ffff:a9fe:a9fe]，
  // 只按点分匹配的防护会被完整绕过。
  const bypasses = [
    'https://[::ffff:a9fe:a9fe]/latest/meta-data/', // 169.254.169.254
    'https://[::ffff:7f00:1]/', // 127.0.0.1
    'https://[::ffff:a00:1]/', // 10.0.0.1
    'https://[::ffff:c0a8:101]/', // 192.168.1.1
    'https://[0:0:0:0:0:ffff:a9fe:a9fe]/'
  ]
  for (const url of bypasses) {
    const verdict = await guard.checkOutboundUrl(url, { resolveDns: false })
    assert.equal(verdict.ok, false, `mapped 绕过未被拦住：${url}`)
  }
})

test('攻击链 ③：用尾点绕过 localhost 判定必须被拦住', async () => {
  const bypasses = [
    'https://localhost./',
    'https://127.0.0.1./',
    'https://169.254.169.254./latest/meta-data/'
  ]
  for (const url of bypasses) {
    const verdict = await guard.checkOutboundUrl(url, { resolveDns: false })
    assert.equal(verdict.ok, false, `尾点绕过未被拦住：${url}`)
  }
})

test('攻击链 ③：把 apiKey 外带到攻击者服务器 —— 用相似域名绕过白名单', async () => {
  // 白名单只放行精确域名与子域。下列全是攻击者能注册的"长得像"域名。
  for (const host of [
    'api.openai.com.attacker.net',
    'attacker.api.openai.com.evil.tld',
    'evilapi.openai.com',
    'api-deepseek.com',
    'api.deepseek.com.evil.tld'
  ]) {
    assert.equal(guard.isTrustedVendor(host), false, `${host} 不该被当成厂商白名单`)
  }
})

// ---------------------------------------------------------------- 第 ④ 环：枚举

test('攻击链 ④：注册接口的错误响应不能区分"账号已存在"', async () => {
  // 这一环的完整行为测试在 registration-enumeration.test.js，
  // 这里只做一条"契约级"断言：源码里验码必须早于查重。
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'services', 'account-service.js'), 'utf8')
  const start = src.indexOf('async register(')
  const end = src.indexOf('async forgot(')
  const body = src.slice(start, end)
  assert.ok(body.indexOf('verification.verify(') < body.indexOf("'USERNAME_TAKEN'"),
    '验码必须在查重之前，否则注册接口就是账号枚举器')
})

// ---------------------------------------------------------------- 组合视角

test('攻击链总览：任何一条"服务器替攻击者发请求"的路径都过同一道闸', async () => {
  // 结论性断言：所有出站都走 pooledFetch → checkOutboundUrl。
  // 如果将来有人在适配器里直接用 globalThis.fetch，这条会红。
  const fs = require('node:fs')
  const path = require('node:path')
  const pool = fs.readFileSync(path.join(__dirname, '..', 'server', 'lib', 'http-pool.js'), 'utf8')
  assert.ok(pool.includes('checkOutboundUrl(url)'),
    'pooledFetch 必须调用 checkOutboundUrl —— 这是所有出站的唯一闸门')
  assert.ok(pool.includes('SSRF_BLOCKED'),
    '连接层必须有 SSRF 拦截（防 DNS rebinding）')

  const provider = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'services', 'translation-provider.js'), 'utf8')
  assert.ok(provider.includes('fetch: pooledFetch'),
    '翻译适配器必须用 pooledFetch，不能是裸 fetch')
  assert.equal(/fetch:\s*globalThis\.fetch/.test(provider), false,
    '不能有裸 globalThis.fetch 直连')
})
