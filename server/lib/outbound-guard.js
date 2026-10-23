'use strict'

/**
 * 出站 URL 白名单 —— 防 SSRF。
 *
 * ## 漏洞
 *
 * 后台「翻译通道」允许管理员填自定义接口地址（`POST /admin/engines/save`
 * 的 `endpoint` 字段），校验只有一条：
 *
 *     if (endpoint && !/^https:\/\//.test(endpoint)) reject
 *
 * 也就是 **只要求 https，域名随便填**。这个值最终会进
 * `translation-adapters.js` 的 `fetch(endpoint)` —— 服务器替攻击者发请求。
 *
 * 于是只要拿到超管会话（本次事件里攻击者就是直接建后门超管），
 * 一条 SSRF 链就成立了：
 *
 *   1. endpoint 改成 https://169.254.169.254/latest/meta-data/iam/...
 *      → 读云厂商实例元数据，拿临时 AK/SK，接管整台机器（AWS/GCP/阿里云都吃这套）
 *   2. endpoint 改成 https://127.0.0.1:6379 或内网面板
 *      → 探测内网资产、打内网面板
 *   3. endpoint 改成 https://attacker.tld/collect
 *      → 把 apiKey 一起发过去（请求体里就带着密钥），等于密钥外带
 *
 * 单看"只有超管能填"像是低危，但配上"后门超管"就是完整 RCE 的前置步骤 ——
 * 这正是"多个低危组合成高危链路"。
 *
 * ## 防护策略
 *
 * 1. **保存时**解析主机名，落在禁止网段直接拒绝
 * 2. **发起请求时再校验一次** —— 只查保存时不够：攻击者可以让域名先解析到
 *    公网 IP 通过校验，之后再改成内网 IP（DNS rebinding）。所以真正发请求前
 *    必须用**解析结果**再判一次。
 * 3. 按白名单思路做：默认禁止私有/保留网段，而不是只拦几个已知地址。
 *
 * ## 性能与可用性
 *
 * 翻译是热路径，每次出站都解析 DNS 会显著增加延迟（一次查询 1~20ms，
 * 还要吃满 resolver）。所以：
 *
 * · **解析结果短期缓存**（默认 60 秒），命中缓存不查询；
 * · 已知厂商域名走**静态白名单**，连查询都省掉 —— 它们不可能指向内网；
 * · 解析失败（DNS 故障）**拒绝**，不放行。理由是：放行等于攻击者只要让
 *   域名解析超时就能绕过整道闸；而 DNS 故障时本来也发不出请求。
 *   为了不让一次抖动把翻译打死，失败的"域名 → 拒绝"只缓存很短时间，
 *   且**已知厂商域名永不因解析失败被拦**。
 */

const dns = require('dns')

/**
 * 明确禁止的网段。
 *
 * 判据是"这个地址从服务器发起请求，会不会打到不该打的地方"。
 * 覆盖云元数据、内网、回环、链路本地、以及各类保留段。
 */
const BLOCKED_V4 = [
  ['0.0.0.0', 8], // 本网络
  ['10.0.0.0', 8], // 私有 A
  ['100.64.0.0', 10], // 运营商级 NAT
  ['127.0.0.0', 8], // 回环
  ['169.254.0.0', 16], // 链路本地 —— 云元数据 169.254.169.254 在这里
  ['172.16.0.0', 12], // 私有 B
  ['192.0.0.0', 24], // IETF 协议分配
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // 私有 C
  ['198.18.0.0', 15], // 基准测试
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4] // 保留（含 255.255.255.255）
]

/** 把 'a.b.c.d' 转成 32 位无符号整数。 */
function ipv4ToInt (ip) {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = (value * 256) + n
  }
  return value >>> 0
}

/**
 * 判断一个 IPv4 是否落在禁止网段。
 * @returns {string|null} 命中时返回网段描述，否则 null
 */
function blockedV4Reason (ip) {
  const value = ipv4ToInt(ip)
  if (value === null) return null
  for (const [base, bits] of BLOCKED_V4) {
    const baseValue = ipv4ToInt(base)
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0
    if (((value & mask) >>> 0) === ((baseValue & mask) >>> 0)) {
      return `${base}/${bits}`
    }
  }
  return null
}

/**
 * 把 IPv6 展开成完整的 8 组 16 进制（例如 '::ffff:7f00:1' → '0:0:0:0:0:ffff:7f00:1'）。
 *
 * 为什么要自己写：`new URL('https://[::ffff:127.0.0.1]/').hostname` 会被规范化成
 * `[::ffff:7f00:1]`——点分形式变成十六进制。所有"按点分匹配"的规则都会漏掉它，
 * 攻击者用这一种写法就能绕过回环/内网判定。所以必须先展开再按位判断。
 *
 * @returns {number[]|null} 8 个 16 位整数，非法时返回 null
 */
function expandV6 (ip) {
  let v = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!v.includes(':')) return null

  // 处理末尾的 IPv4 点分（::ffff:1.2.3.4）
  const dotted = v.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  let tail = ''
  if (dotted) {
    const v4 = ipv4ToInt(dotted[2])
    if (v4 === null) return null
    tail = `${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`
    v = dotted[1] + tail
  }

  const halves = v.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 2) {
    if (missing < 1) return null
  } else if (head.length !== 8) {
    return null
  }

  const parts = head.concat(new Array(halves.length === 2 ? missing : 0).fill('0'), rest)
  if (parts.length !== 8) return null
  const out = []
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null
    out.push(parseInt(part, 16))
  }
  return out
}

/**
 * 判断 IPv6 是否落在禁止网段。
 *
 * 覆盖：回环、未指定、链路本地、唯一本地（fc00::/7）、组播，
 * 以及 **IPv4 映射地址**（::ffff:x.x.x.x，含十六进制压缩形式）按 IPv4 规则再判一次。
 */
function blockedV6Reason (ip) {
  const groups = expandV6(ip)
  if (!groups) return null
  const allZeroPrefix = groups.slice(0, 5).every(g => g === 0)

  // ::ffff:a.b.c.d —— 映射地址，按 IPv4 判
  if (allZeroPrefix && groups[5] === 0xffff) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
    const reason = blockedV4Reason(v4)
    return reason ? `IPv4 映射地址 ${v4}（${reason}）` : null
  }
  // ::a.b.c.d —— 已废弃的 IPv4 兼容地址，同样按 IPv4 判
  if (allZeroPrefix && groups[5] === 0 && (groups[6] || groups[7])) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
    const reason = blockedV4Reason(v4)
    return reason ? `IPv4 兼容地址 ${v4}（${reason}）` : null
  }

  if (groups.every(g => g === 0)) return '未指定地址'
  if (groups.slice(0, 7).every(g => g === 0) && groups[7] === 1) return '回环'
  if ((groups[0] & 0xffc0) === 0xfe80) return 'fe80::/10 链路本地'
  if ((groups[0] & 0xfe00) === 0xfc00) return 'fc00::/7 唯一本地'
  if ((groups[0] & 0xff00) === 0xff00) return 'ff00::/8 组播'
  return null
}

/**
 * 主机名是否指向禁止网段（同步判断，仅用于字面量 IP 与 localhost 类）。
 * @returns {string|null}
 */
function blockedHostReason (hostname) {
  // ★ 先去掉 FQDN 尾点 ★
  //
  // DNS 语义上 `localhost.` 与 `localhost` 是同一个名字（末尾点表示"绝对域名"），
  // 但**字符串比较完全不同**。这是公开的 SSRF 绕过手法：
  // `http://localhost./` 能过掉 `host === 'localhost'` 这种判断，
  // 而实际连接的仍然是本机。
  // 同理 `169.254.169.254.` 也解析到元数据服务。
  // 参考：WHATWG URL 不会规范化尾点（实测 hostname 保持为 'localhost.'）。
  const host = String(hostname || '').trim().toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
  if (!host) return '空主机名'
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost'
  // 各类内网常用的"名字"
  if (host === 'metadata.google.internal' || host.endsWith('.internal')) return '内网域名'
  if (blockedV4Reason(host)) return blockedV4Reason(host)
  if (host.includes(':') && blockedV6Reason(host)) return blockedV6Reason(host)
  return null
}

/**
 * 已知厂商域名 —— 静态白名单，免 DNS 查询直接放行。
 *
 * 判据：这些是代码里**硬编码**调用目标（翻译/链上节点），运维无法通过后台改。
 * 它们不可能指向内网，所以不需要每次解析；万一 DNS 挂了，翻译也该继续
 * 报"网络错误"而不是报"出站被拦截"（后者会让人误判成被墙/被封）。
 *
 * 注意：**只放行精确匹配或子域**。绝不能写成 endsWith('openai.com') 就算了 ——
 * 攻击者注册 `evil-openai.com` 不匹配，但 `notopenai.com` 会不会误匹配取决于
 * 前缀加点。这里统一用 `.` 前缀判子域，避免 `evilopenai.com` 漏进来。
 */
const TRUSTED_VENDOR_HOSTS = [
  'api.openai.com',
  'api.deepseek.com',
  'api.anthropic.com',
  'api.x.ai',
  'api.mistral.ai',
  // MiniMax 有两个域名：老的是 api.minimax.chat，线上 engines 表里配的是
  // api.minimaxi.com。两个都留着 —— 只列一个的话，将来谁在后台启用这条线
  // 就会被 SSRF 闸门拦下，而且报的错是"出站被拦截"，大概率被误判成"被封"。
  'api.minimax.chat',
  'api.minimaxi.com',
  'api.moonshot.cn',
  'open.bigmodel.cn',
  'dashscope.aliyuncs.com',
  'ark.cn-beijing.volces.com',
  'api-free.deepl.com',
  'api.deepl.com',
  'translation.googleapis.com',
  'api.mymemory.translated.net',
  'api.cognitive.microsofttranslator.com',
  'translate.amazonaws.com',
  'translation.tencentcloudapi.com',
  'api.niutrans.com',
  'openapi.naver.com',
  'api.telegram.org'
]

/** 按"精确 或 .子域"判断是否属于白名单主机。 */
function isTrustedVendor (host) {
  const h = String(host || '').toLowerCase()
  return TRUSTED_VENDOR_HOSTS.some(base => h === base || h.endsWith('.' + base))
}

/** DNS 解析结果缓存：host → { at, ok, reason }。防止热路径每次查 DNS。 */
const DNS_CACHE = new Map()
const DNS_CACHE_MS = 60_000
/** 解析失败只缓存很短时间：一次网络抖动不该让某域名 60 秒都发不出去。 */
const DNS_FAIL_CACHE_MS = 5_000
const DNS_CACHE_MAX = 256

function cacheGet (host) {
  const hit = DNS_CACHE.get(host)
  if (!hit) return null
  const ttl = hit.ok ? DNS_CACHE_MS : DNS_FAIL_CACHE_MS
  if (Date.now() - hit.at > ttl) {
    DNS_CACHE.delete(host)
    return null
  }
  return hit
}

function cacheSet (host, value) {
  if (DNS_CACHE.size >= DNS_CACHE_MAX) {
    // 简单的 FIFO 淘汰：Map 保留插入顺序
    DNS_CACHE.delete(DNS_CACHE.keys().next().value)
  }
  DNS_CACHE.set(host, Object.assign({ at: Date.now() }, value))
}

/** 仅供测试：清空缓存，避免用例之间互相污染。 */
function _clearDnsCache () {
  DNS_CACHE.clear()
}

/**
 * 校验一个出站 URL 是否允许。
 *
 * @param {string} raw      待校验的 URL
 * @param {object} [options] { resolveDns: boolean } 默认做 DNS 解析（防 rebinding）
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function checkOutboundUrl (raw, options) {
  const opts = options || {}
  let url
  try {
    url = new URL(String(raw || '').trim())
  } catch (_e) {
    return { ok: false, reason: '不是合法的 URL' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: '只允许 https' }
  if (url.username || url.password) return { ok: false, reason: 'URL 不能带账号密码' }
  // 端口只放行 443 与常规 HTTPS 端口。攻击内网常靠非标端口。
  if (url.port && url.port !== '443') {
    return { ok: false, reason: `不允许的端口 ${url.port}` }
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')

  const literalReason = blockedHostReason(host)
  if (literalReason) return { ok: false, reason: `目标地址被禁止：${literalReason}` }

  // 字面量 IP 已经判过了；域名需要解析后再判，否则可以用域名绕过
  const isLiteralIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
  if (isLiteralIp) {
    // 走到这里说明字面量判定没命中，但 IPv6 展开可能还有别的形态没覆盖
    // （例如大写、带方括号、压缩写法）。用展开后的结果再确认一遍。
    if (host.includes(':')) {
      const v6Reason = blockedV6Reason(host)
      if (v6Reason) return { ok: false, reason: `目标地址被禁止：${v6Reason}` }
    }
    return { ok: true }
  }

  // 已知厂商域名：静态白名单，免查询。
  if (isTrustedVendor(host)) return { ok: true }

  if (opts.resolveDns === false) return { ok: true }

  const cached = cacheGet(host)
  if (cached) return cached.ok ? { ok: true } : { ok: false, reason: cached.reason }

  let records
  try {
    records = await dns.promises.lookup(host, { all: true })
  } catch (error) {
    const reason = `域名无法解析：${error.code || error.message}`
    cacheSet(host, { ok: false, reason })
    return { ok: false, reason }
  }
  if (!records || !records.length) {
    const reason = '域名没有解析结果'
    cacheSet(host, { ok: false, reason })
    return { ok: false, reason }
  }
  for (const record of records) {
    const reason = record.family === 6
      ? blockedV6Reason(record.address)
      : blockedV4Reason(record.address)
    if (reason) {
      const text = `域名解析到被禁止的地址 ${record.address}（${reason}）`
      cacheSet(host, { ok: false, reason: text })
      return { ok: false, reason: text }
    }
  }
  cacheSet(host, { ok: true })
  return { ok: true }
}

module.exports = {
  checkOutboundUrl,
  blockedHostReason,
  blockedV4Reason,
  blockedV6Reason,
  isTrustedVendor,
  TRUSTED_VENDOR_HOSTS,
  _clearDnsCache,
  BLOCKED_V4
}
