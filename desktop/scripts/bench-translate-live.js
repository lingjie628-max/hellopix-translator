'use strict'

/**
 * 真机「翻译调用」耗时探针 —— 用**客户端自己的账号与网络栈**打生产接口，
 * 报告 GPT / DeepSeek 各自的 P50 / P95。
 *
 * 跑法（必须在 desktop/ 目录下，必须用真 Electron —— 登录口令是
 * `safeStorage`（macOS Keychain）加密的，只有同一个 app name 能解开）：
 *
 *   # 先看你这次会打多少次、大概花多少字符（不发任何请求）：
 *   npx electron scripts/bench-translate-live.js --runs 20 --dry-run
 *
 *   # 真跑（会真实扣字符）：
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/bench-translate-live.js --runs 20 --yes
 *
 * ## 它测的是什么
 *
 * 只测**服务端 + 厂商模型**这一段（也就是客户端 `SEND_PERF.translate` 那一段）：
 * 从发出 `/apis/translate/run` 到拿到译文。客户端自身的开销由
 * `bench-send-timing.js` 单独精确测量（真 Electron + 真原生输入）。
 * 两者相加就是用户感知的端到端时间。
 *
 * ## 计费与安全
 *
 * · 每次调用都会**真实消耗字符**（和用户手动点发送完全一样），所以默认
 *   必须显式 `--yes` 才发请求；`--dry-run` 只打印计划。
 * · 用的是客户端已经保存的登录态（auth.json + Keychain），**不解密、不打印口令**；
 *   只从登录响应里读余额，用于前后对照。
 * · 每次换一条不重复的文本，避免命中服务端/客户端缓存（否则测出来的不是真耗时）。
 */

const electron = require('electron')
const { app } = electron
// ★ 必须在任何 app.getPath() 之前 ★ —— userData 目录与 Keychain 条目都由 app name 推导，
//   名字不对就既读不到 auth.json、也解不开口令。
app.setName('Hello Pix')

const fs = require('fs')
const path = require('path')

function arg (name, dflt) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  return (v === undefined || v.startsWith('--')) ? true : v
}
const RUNS = Math.max(1, Number(arg('runs', 20)))
const ENGINES = String(arg('engines', 'gpt,deepseek')).split(',').map(s => s.trim()).filter(Boolean)
const DRY = !!arg('dry-run', false)
const YES = !!arg('yes', false)
// 起始序号：分两阶段跑时用它保证**两阶段的文本不重复**（重复会命中缓存，测不准）。
const OFFSET = Math.max(0, Number(arg('offset', 0)))
// 调用来源。**必须是服务端白名单里的值**（见 core-service.js 的 TRIGGER_VALUES）：
// 不在白名单里的值会被静默记成空串（"未声明"），把计费归因的账搅浑。
// manual_send 就是客户端真实点发送时用的值，语义最贴合本探针要测的链路。
const TRIGGER = String(arg('trigger', 'manual_send'))
// 只读余额模式：登录 + 读会话，**不发任何翻译请求**，用于测试前后对账。
const BALANCE_ONLY = !!arg('balance-only', false)
const TRIGGER_ALLOWED = ['manual_click', 'auto_receive', 'manual_send', 'retranslate']
// ★ 硬性安全栏杆（用户给定）★：请求总上限 40 次、字符预算上限 600。
const MAX_REQUESTS = Number(arg('max-requests', 40))
const MAX_CHARS = Number(arg('max-chars', 600))
// 连续失败到这个数就立即停 —— 连续错误通常意味着通道/账号出了问题，
// 继续打只会继续扣费。
const MAX_CONSECUTIVE_FAILS = Number(arg('max-consecutive-fails', 3))

function percentile (sorted, p) {
  if (!sorted.length) return null
  if (sorted.length === 1) return sorted[0]
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return lo === hi ? sorted[lo] : Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo))
}
function stats (values) {
  const clean = values.filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b)
  if (!clean.length) return { n: 0 }
  return {
    n: clean.length,
    min: clean[0],
    p50: percentile(clean, 0.5),
    p95: percentile(clean, 0.95),
    max: clean[clean.length - 1],
    mean: Math.round(clean.reduce((a, b) => a + b, 0) / clean.length)
  }
}

// ★ 计费口径必须与服务端一致 ★
//   server/services/translation-provider.js: countBillableChars —— 中日韩字符算 2，
//   其余算 1。不按这个口径算，预算栏杆和余额对账都会对不上。
const CJK_RE = /[\u4e00-\u9fff]/
function countBillableChars (text) {
  let count = 0
  for (const char of String(text || '')) count += CJK_RE.test(char) ? 2 : 1
  return count
}

// 短中文句：贴近客服真实输入，同时把**计费字符**压到最低。
// ★ 全部为虚构文本，不含任何真实客户内容 ★
// 之所以短到 5 个汉字：服务端中日韩字符算 2，40 次请求必须落在 600 计费字符的
// 预算内（长句会超）。翻译耗时由网络往返 + 模型首 token 决定，这个长度足够。
function sampleText (i) {
  return '基准' + i + '号：稍等'
}

function userFile (name) {
  return path.join(app.getPath('userData'), name)
}

function loadAuth () {
  const file = userFile('auth.json')
  if (!fs.existsSync(file)) return null
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return null }
}

async function main () {
  const base = 'https://pixfanyi.com'
  const auth = loadAuth()
  if (!auth || !auth.username) {
    console.log('找不到已保存的登录态（auth.json）。请先在客户端里登录一次再跑。')
    app.exit(2); return
  }
  const password = (auth.passwordEnc && electron.safeStorage && electron.safeStorage.isEncryptionAvailable())
    ? electron.safeStorage.decryptString(Buffer.from(auth.passwordEnc, 'base64'))
    : ''
  if (!passwordEncOk(password)) {
    console.log('登录口令解不开（Keychain 条目对不上）。请先在客户端里重新登录一次。')
    app.exit(2); return
  }

  console.log('='.repeat(78))
  console.log(' 翻译调用耗时探针（生产）')
  console.log('  账号=' + auth.username + ' · 通道=' + ENGINES.join(' / ') +
    ' · 每通道 ' + RUNS + ' 次 · 合计 ' + (ENGINES.length * RUNS) + ' 次')
  console.log('  起始序号=' + (OFFSET + 1) + ' · trigger=' + TRIGGER +
    ' · 硬上限=' + MAX_REQUESTS + ' 次请求 / ' + MAX_CHARS + ' 计费字符')
  const perReq = countBillableChars(sampleText(OFFSET + 1))
  console.log('  每次约 ' + perReq + ' 计费字符 → 预计消耗约 ' +
    (ENGINES.length * RUNS * perReq) + ' 计费字符')
  console.log('='.repeat(78))

  // ---- 安全栏杆预检：不满足就一个请求都不发 ----
  if (TRIGGER_ALLOWED.indexOf(TRIGGER) < 0) {
    console.log('\n✖ trigger「' + TRIGGER + '」不在服务端白名单里：' + TRIGGER_ALLOWED.join(' / '))
    console.log('  不在白名单的值会被静默记成空串（"未声明"），会污染计费归因。请换一个再跑。')
    app.exit(2); return
  }
  const planned = ENGINES.length * RUNS
  if (planned > MAX_REQUESTS) {
    console.log('\n✖ 计划请求数 ' + planned + ' 超过上限 ' + MAX_REQUESTS + '。已中止，未发任何请求。')
    app.exit(2); return
  }
  const plannedChars = planned * perReq
  if (plannedChars > MAX_CHARS) {
    console.log('\n✖ 预计消耗 ' + plannedChars + ' 计费字符，超过预算 ' + MAX_CHARS + '。已中止，未发任何请求。')
    app.exit(2); return
  }

  if (DRY) {
    console.log('\n--dry-run：以上是计划，未发出任何请求。去掉 --dry-run 加上 --yes 才会真跑。')
    app.exit(0); return
  }
  if (!YES && !BALANCE_ONLY) {
    console.log('\n这会真实扣字符。确认请加 --yes。')
    app.exit(2); return
  }

  // ---- 登录（和客户端 auth:login 完全同一条链路）----
  const deviceId = readOrCreateDeviceId()
  deviceIdCache = deviceId
  const jar = {}
  const login = await post(base, '/apis/client/login', { username: auth.username, password: password, deviceId: deviceId }, jar)
  if (!login || !login.success) {
    console.log('登录失败：' + JSON.stringify(login))
    app.exit(2); return
  }
  const profile = login.obj || {}
  const balanceBefore = balanceOf(profile)
  console.log('\n登录成功 · 余额=' + fmt(balanceBefore) + ' 已用=' + fmt(profile.charUsed))

  // ---- 只读余额模式：**一个翻译请求都不发**（用于测试前后对账）----
  if (BALANCE_ONLY) {
    const sess = await get(base, '/apis/client/session', jar).catch(() => null)
    const p = (sess && (sess.obj || sess)) || {}
    console.log('\n[只读] 当前余额=' + fmt(balanceOf(p)) + ' 已用=' + fmt(p.charUsed) +
      ' · 本次未发出任何翻译请求，消耗 0 字符')
    app.exit(0); return
  }

  const table = {}
  let requestCount = 0
  let charSpent = 0
  let consecutiveFails = 0
  let aborted = ''
  let lastRemain = null
  const remainTrail = []
  for (const engine of ENGINES) {
    if (aborted) break
    const rows = []
    console.log('\n── 通道 ' + engine)
    for (let i = OFFSET + 1; i <= OFFSET + RUNS; i++) {
      // ★ 两道硬栏杆：请求数 / 字符预算。到上限立即停，不再发下一个请求。★
      if (requestCount >= MAX_REQUESTS) { aborted = '已达请求上限 ' + MAX_REQUESTS + ' 次'; break }
      const text = sampleText(i)
      const needChars = countBillableChars(text)
      if (charSpent + needChars > MAX_CHARS) {
        aborted = '再加这一次会超出计费字符预算 ' + MAX_CHARS + '（已用 ' + charSpent + '）'
        break
      }
      const t0 = Date.now()
      const data = await post(base, '/apis/translate/run', {
        text: text, from: 'zh', to: 'en', engine: engine, trigger: TRIGGER,
        requestId: 'bench:' + deviceId + ':' + engine + ':' + i + ':' + Date.now()
      }, jar)
      const ms = Date.now() - t0
      requestCount++
      charSpent += needChars
      const out = String((data && (data.translation || data.text)) || '').trim()
      const ok = !!(data && data.success && out)
      // 服务端每次都会回 remain（这次之后还剩多少字符），用它做逐次对账。
      if (data && data.remain !== undefined && data.remain !== null && data.remain !== '') {
        lastRemain = Number(data.remain)
        remainTrail.push({ i: i, engine: engine, remain: lastRemain })
      }
      if (ok) consecutiveFails = 0
      else consecutiveFails++
      rows.push({ ms: ms, ok: ok, code: (data && data.code) || '', i: i })
      process.stdout.write('  · 第' + String(i).padStart(2) + '条  ' + String(ms).padStart(6) + 'ms  ' +
        (ok ? 'ok  ' + JSON.stringify(out.slice(0, 40)) : 'FAIL ' + ((data && data.code) || '?') + ' ' + ((data && data.msg) || '')) +
        '   [累计 ' + requestCount + ' 次 / ' + charSpent + ' 计费字符]\n')
      // ★ 连续失败熔断：多半是通道/账号出问题了，再打只会继续扣费。★
      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        aborted = '连续 ' + consecutiveFails + ' 次失败（最后一次 code=' + ((data && data.code) || '?') + '）—— 立即停止'
        break
      }
      // 小间隔：贴近真实客服节奏，也避免打爆限流。
      await sleep(120)
    }
    const s = stats(rows.filter(r => r.ok).map(r => r.ms))
    table[engine] = s
    const fails = rows.filter(r => !r.ok)
    const failRate = rows.length ? Math.round(fails.length / rows.length * 1000) / 10 : 0
    console.log('    成功 ' + s.n + '/' + rows.length + '（失败率 ' + failRate + '%）' +
      (s.n ? '  P50=' + s.p50 + 'ms  P95=' + s.p95 + 'ms  max=' + s.max + 'ms  mean=' + s.mean + 'ms' : '') +
      (fails.length ? '  ✖ 失败码：' + fails.map(f => f.code || '(空)').join(',') : ''))
  }
  if (aborted) console.log('\n⛔ 已提前停止：' + aborted)
  console.log('\n 本次实际发出 ' + requestCount + ' 次请求 / ' + charSpent + ' 计费字符' +
    '（上限 ' + MAX_REQUESTS + ' 次 / ' + MAX_CHARS + ' 计费字符）')

  // ---- 与服务端自报的耗时对照（如果响应里带了）----
  console.log('\n' + '='.repeat(78))
  console.log(' 汇总（这一段就是 SEND_PERF.translate，服务端 + 厂商模型）')
  console.log('='.repeat(78))
  console.log(' ' + '通道'.padEnd(12) + 'P50'.padStart(8) + 'P95'.padStart(8) + 'max'.padStart(8) + 'mean'.padStart(8) + 'n'.padStart(6))
  for (const e of ENGINES) {
    const s = table[e] || { n: 0 }
    if (!s.n) continue
    console.log(' ' + e.padEnd(12) + String(s.p50).padStart(8) + String(s.p95).padStart(8) +
      String(s.max).padStart(8) + String(s.mean).padStart(8) + String(s.n).padStart(6))
  }

  // ---- 对账：余额前后 + 服务端自报的每次剩余额度 ----
  // /client/session 是 **GET**（GET 属于安全方法，服务端 csrf 中间件会直接放行）。
  const sess = await get(base, '/apis/client/session', jar).catch(() => null)
  const p2 = (sess && (sess.obj || sess)) || {}
  const balanceAfter = balanceOf(p2) != null ? balanceOf(p2) : lastRemain
  console.log('\n' + '='.repeat(78))
  console.log(' 计费对账')
  console.log('='.repeat(78))
  console.log(' 余额：' + fmt(balanceBefore) + ' → ' + fmt(balanceAfter) +
    '（差额 ' + ((balanceBefore != null && balanceAfter != null) ? (balanceBefore - balanceAfter) : '?') + ' 字符）')
  console.log(' 探针自身计数的消耗：' + charSpent + ' 字符（' + requestCount + ' 次请求）')
  if (lastRemain != null) console.log(' 服务端自报的最后剩余额度：' + fmt(lastRemain))
  if (balanceBefore != null && balanceAfter != null) {
    const diff = balanceBefore - balanceAfter
    console.log(' 对账结果：' + (diff === charSpent
      ? '✔ 一致（扣费 = 探针计数）'
      : '△ 不一致：余额差 ' + diff + ' vs 计数 ' + charSpent +
        '（若期间有其它客户端在翻译，差额会包含那部分）'))
  }
  console.log('\n 客户端自身开销另由 bench-send-timing.js 测得（真 Electron + 真原生输入）。')
  app.exit(0)
}

function passwordEncOk (p) { return typeof p === 'string' && p.length > 0 }
function fmt (v) { return v === undefined || v === null ? '-' : String(v) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

function readOrCreateDeviceId () {
  const file = userFile('device-id')
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
    const id = 'desktop-' + require('crypto').randomBytes(8).toString('hex')
    fs.writeFileSync(file, id)
    return id
  } catch (e) { return 'desktop-bench' }
}

// 设备号缓存：每个请求都要带 X-Pix-Device（服务端会拿它做会话/设备一致性校验）。
let deviceIdCache = 'desktop-bench'

/** 从登录/会话响应里取字符余额（服务端字段是 camelCase 的 charBalance）。 */
function balanceOf (payload) {
  if (!payload || typeof payload !== 'object') return null
  const v = payload.charBalance
  return (v === undefined || v === null || v === '') ? null : Number(v)
}

async function get (base, pathname, jar) {
  const cookie = Object.keys(jar).map(k => k + '=' + jar[k]).join('; ')
  const res = await fetch(base + pathname, {
    method: 'GET',
    headers: Object.assign(
      { Accept: 'application/json', 'X-Pix-Device': deviceIdCache },
      cookie ? { Cookie: cookie } : {}
    )
  })
  rememberInto(res, jar)
  const text = await res.text()
  try { return JSON.parse(text) } catch (e) { return { success: false, code: 'BAD_JSON', raw: text.slice(0, 200) } }
}

/** 把响应里的 pix_* cookie 收进 jar（与客户端 rememberCookies 同口径）。 */
function rememberInto (res, jar) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : String(res.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/)
  for (const item of list) {
    const part = String(item || '').split(';')[0]
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (/^(__Host-)?pix_/.test(name) && value) jar[name] = value
  }
  return jar
}

async function post (base, pathname, form, jar) {
  const cookie = Object.keys(jar).map(k => k + '=' + jar[k]).join('; ')
  // ★ 必须和客户端 main.js 的 api() 完全一致 ★
  //   服务端的 csrf 中间件要求 X-CSRF-Token 与 cookie 里的 token **双向**匹配，
  //   否则一律 403「安全校验失败」（本探针第一版就是漏了这个头）。
  //   登录接口本身豁免（见 security.js 的 SAFE 列表），所以只有后续请求受影响。
  const csrf = jar['__Host-pix_csrf'] || jar['pix_csrf'] || ''
  const res = await fetch(base + pathname, {
    method: 'POST',
    headers: Object.assign(
      {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Pix-Device': deviceIdCache
      },
      cookie ? { Cookie: cookie } : {},
      csrf ? { 'X-CSRF-Token': csrf } : {}
    ),
    body: new URLSearchParams(form).toString()
  })
  rememberInto(res, jar)
  const text = await res.text()
  try { return JSON.parse(text) } catch (e) { return { success: false, code: 'BAD_JSON', raw: text.slice(0, 200) } }
}

app.whenReady().then(() => {
  main().catch(err => {
    console.error('脚本自身异常：', (err && err.stack) || err)
    app.exit(9)
  })
})
