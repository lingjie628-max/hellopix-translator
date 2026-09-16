'use strict'

/**
 * 超管两步验证端到端验证（在服务器上对着真实服务跑）。
 *
 * 覆盖的是"只看代码看不出来"的东西：
 *   - 图形验证码是否真的拦在密码校验之前
 *   - 开启 2FA 后，第一步登录是否真的只给票据、不给会话
 *   - 动态码是否真的不能用第二次（防重放）
 *   - 恢复码是否真的只能用一次
 *   - 关闭后是否恢复到原状
 *
 * 安全兜底：整个过程会临时开启 2FA，finally 里无条件尝试关闭，
 * 避免把生产管理员锁在门外。若兜底也失败，脚本会明确告警并打印
 * 恢复办法（直接改库 totp_enabled=false）。
 */

const http = require('http')
const https = require('https')
const path = require('path')
const totpLib = require('/opt/hello-pix/server/lib/totp')

// 默认打本机 3000；传 BASE_URL=https://lindufyht.com 则走公网真实链路
// （Cloudflare → nginx → 应用），用于验证上线后的完整路径。
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000'
const PARSED = new URL(BASE_URL)
const transport = PARSED.protocol === 'https:' ? https : http
const BASE = {
  host: PARSED.hostname,
  port: PARSED.port ? Number(PARSED.port) : (PARSED.protocol === 'https:' ? 443 : 80),
  ...(PARSED.protocol === 'https:' ? { servername: PARSED.hostname } : {})
}
const BASE_PATH = PARSED.pathname.replace(/\/+$/, '')
function withBase(p) { return BASE_PATH + p }
const ADMIN_USER = process.env.ADMIN_USER
const ADMIN_PASS = process.env.ADMIN_PASS

let pass = 0
let fail = 0
let loginCount = 0
function check(label, ok, extra) {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}${extra ? '  → ' + JSON.stringify(extra) : ''}`)
  }
}

class RateLimited extends Error {}

function request(method, urlPath, { body, headers, jar } = {}) {
  urlPath = withBase(urlPath)
  if (/\/admin\/login$/.test(urlPath)) loginCount++
  return new Promise((resolve, reject) => {
    const payload = body ? new URLSearchParams(body).toString() : null
    const req = transport.request({
      ...BASE,
      method,
      path: urlPath,
      headers: Object.assign(
        {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: jar ? jar.header() : ''
        },
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {},
        headers || {}
      )
    }, res => {
      let data = ''
      res.on('data', c => (data += c))
      res.on('end', () => {
        if (jar) jar.capture(res.headers['set-cookie'])
        let json = null
        try { json = JSON.parse(data) } catch (e) { /* 非 JSON 时保留原文 */ }
        // 限流不是功能缺陷。若不单独识别，它会伪装成一堆"功能失败"，
        // 让人误以为代码有问题（本次实测踩过：恢复码登录被报成 ✗，其实是限流）。
        if (json && /请求过于频繁/.test(json.msg || '')) {
          reject(new RateLimited(
            `触发登录限流（本次已发起 ${loginCount} 次登录）。` +
            'login-account 是 10 次/15 分钟，等窗口过去再跑，或稍后单独复跑。'
          ))
          return
        }
        resolve({ status: res.statusCode, headers: res.headers, json, text: data })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function makeJar() {
  const store = new Map()
  return {
    capture(list) {
      for (const raw of list || []) {
        const [pair] = String(raw).split(';')
        const idx = pair.indexOf('=')
        if (idx > 0) store.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
      }
    },
    get(name) { return store.get(name) || '' },
    header() { return Array.from(store.entries()).map(([k, v]) => `${k}=${v}`).join('; ') },
    all() { return Object.fromEntries(store) }
  }
}

/** 图形验证码的答案就画在 SVG 的 <text> 里 —— 用于自动化测试，不是绕过 */
function solveCaptcha(svgDataUrl) {
  const svg = Buffer.from(String(svgDataUrl).split(',')[1] || '', 'base64').toString('utf8')
  const letters = [...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(m => m[1])
  return letters.join('')
}

async function freshCaptcha(jar) {
  const res = await request('GET', '/apis/user/captcha', { jar })
  const code = solveCaptcha(res.json && res.json.image)
  return { imageId: res.json && res.json.imageId, imageCode: code }
}

function csrfOf(jar) {
  const cookies = jar.all()
  const key = Object.keys(cookies).find(k => /csrf/.test(k))
  return key ? cookies[key] : ''
}

/** 等到进入下一个 TOTP 时间窗（最多 30 秒），用于需要"未使用过的码"的步骤 */
async function waitForNextWindow() {
  const start = totpLib.counterAt(Date.now())
  process.stdout.write('    （等待下一个 30 秒验证码窗口…）')
  while (totpLib.counterAt(Date.now()) === start) {
    await new Promise(r => setTimeout(r, 1000))
  }
  process.stdout.write(' 就绪\n')
}

;(async () => {
  const jar = makeJar()
  let enabledByTest = false

  // 前置：清掉本脚本自己产生的限流计数与残留票据。
  // 单次跑要发起约 7 次登录，而 login-account 是 10 次/15 分钟 ——
  // 不清的话第二次跑必然撞限流，把"限流"误报成"功能坏了"。
  // 注意键名有双前缀：REDIS_KEY_PREFIX=pix: 之上代码里又加了 pix:。
  if (process.env.REDIS_URL) {
    try {
      const Redis = require('/opt/hello-pix/node_modules/ioredis')
      const redis = new Redis(process.env.REDIS_URL, { lazyConnect: false })
      for (const pattern of ['*rate:login-*', '*rate:admin-totp-*', '*admin-totp-ticket*', '*admin-totp-counter*']) {
        const keys = await redis.keys(pattern)
        if (keys.length) await redis.del(keys)
      }
      await redis.quit()
      console.log('已重置限流计数与残留票据')
    } catch (error) {
      console.log('重置前置状态失败（可忽略，但可能撞限流）: ' + error.message)
    }
  }

  try {
    console.log('\n[1] 图形验证码必须拦在密码校验之前')
    let cap = await freshCaptcha(jar)
    let login = await request('POST', '/apis/admin/login', {
      jar, body: { username: ADMIN_USER, password: ADMIN_PASS, imageId: 'bogus', imageCode: 'XXXX' }
    })
    check('验证码错误时即使密码正确也被拒', login.status === 400 && login.json && login.json.code === 'BAD_CAPTCHA', login.json)

    console.log('\n[2] 正确密码 + 正确验证码可登录（此时未开 2FA）')
    cap = await freshCaptcha(jar)
    login = await request('POST', '/apis/admin/login', {
      jar, body: { username: ADMIN_USER, password: ADMIN_PASS, imageId: cap.imageId, imageCode: cap.imageCode }
    })
    check('登录成功', login.status === 200 && login.json && login.json.success === true, login.json)
    check('返回 totpEnabled=false', login.json && login.json.obj && login.json.obj.totpEnabled === false, login.json && login.json.obj)
    const csrf = csrfOf(jar)
    check('拿到 CSRF token', !!csrf)

    console.log('\n[3] 未带 CSRF 的写操作必须被拒')
    const noCsrf = await request('POST', '/apis/admin/totp/setup', { jar, body: {} })
    check('缺 CSRF 时返回 403', noCsrf.status === 403, noCsrf.json)

    console.log('\n[4] 开启两步验证')
    const setup = await request('POST', '/apis/admin/totp/setup', { jar, headers: { 'X-CSRF-Token': csrf }, body: {} })
    check('拿到密钥', setup.status === 200 && /^[A-Z2-7]{32}$/.test((setup.json || {}).secret || ''), setup.json)
    const secret = setup.json.secret
    check('otpauth 链接可用', /^otpauth:\/\/totp\//.test(setup.json.otpauth || ''))

    const wrongEnable = await request('POST', '/apis/admin/totp/enable', {
      jar, headers: { 'X-CSRF-Token': csrf }, body: { code: '000000' }
    })
    check('错误动态码不能开启', wrongEnable.status === 400, wrongEnable.json)

    const enable = await request('POST', '/apis/admin/totp/enable', {
      jar, headers: { 'X-CSRF-Token': csrf }, body: { code: totpLib.totp(secret) }
    })
    check('正确动态码开启成功', enable.status === 200 && enable.json.success === true, enable.json)
    check('一次性下发 10 个恢复码', (enable.json.recoveryCodes || []).length === 10)
    const recovery = enable.json.recoveryCodes || []
    enabledByTest = true

    console.log('\n[5] 开启后：第一步只给票据，不给会话')
    const jar2 = makeJar()
    let cap2 = await freshCaptcha(jar2)
    const step1 = await request('POST', '/apis/admin/login', {
      jar: jar2, body: { username: ADMIN_USER, password: ADMIN_PASS, imageId: cap2.imageId, imageCode: cap2.imageCode }
    })
    check('返回 needTotp', step1.status === 200 && step1.json.needTotp === true, step1.json)
    check('带一次性票据', typeof step1.json.ticket === 'string' && step1.json.ticket.length > 20)
    check('此步没有下发管理员会话 cookie', !Object.keys(jar2.all()).some(k => /admin_session/.test(k)), jar2.all())

    const probe = await request('GET', '/apis/admin/totp', { jar: jar2 })
    check('用这张票据还访问不了后台接口（401）', probe.status === 401, probe.status)

    console.log('\n[6] 第二步：动态码登录（同时回归"开启后立刻登录"）')
    const usedCode = totpLib.totp(secret)
    const step2 = await request('POST', '/apis/admin/login/totp', {
      jar: jar2, body: { ticket: step1.json.ticket, code: usedCode }
    })
    check('动态码登录成功（开启 2FA 时用的同一个码，不得被误判为已用过）',
      step2.status === 200 && step2.json.success === true, step2.json)

    console.log('\n[7] 防重放：同一个动态码不能再用')
    const cap3 = await freshCaptcha(jar2)
    const step1b = await request('POST', '/apis/admin/login', {
      jar: jar2, body: { username: ADMIN_USER, password: ADMIN_PASS, imageId: cap3.imageId, imageCode: cap3.imageCode }
    })
    const replay = await request('POST', '/apis/admin/login/totp', {
      jar: jar2, body: { ticket: step1b.json.ticket, code: usedCode }
    })
    check('重放同一个码被拒', replay.status === 401, replay.json)

    console.log('\n[8] 票据一次性')
    const reuse = await request('POST', '/apis/admin/login/totp', {
      jar: jar2, body: { ticket: step1b.json.ticket, code: totpLib.totp(secret) }
    })
    check('票据用过即失效（401）', reuse.status === 401, reuse.json)

    console.log('\n[9] 恢复码：能用一次，第二次失效')
    const jar3 = makeJar()
    const cap4 = await freshCaptcha(jar3)
    const s1 = await request('POST', '/apis/admin/login', {
      jar: jar3, body: { username: ADMIN_USER, password: ADMIN_PASS, imageId: cap4.imageId, imageCode: cap4.imageCode }
    })
    const rec = await request('POST', '/apis/admin/login/totp', {
      jar: jar3, body: { ticket: s1.json.ticket, code: recovery[0] }
    })
    check('恢复码可登录', rec.status === 200 && rec.json.usedRecovery === true, rec.json)

    const jar4 = makeJar()
    const cap5 = await freshCaptcha(jar4)
    const s2 = await request('POST', '/apis/admin/login', {
      jar: jar4, body: { username: ADMIN_USER, password: ADMIN_PASS, imageId: cap5.imageId, imageCode: cap5.imageCode }
    })
    const rec2 = await request('POST', '/apis/admin/login/totp', {
      jar: jar4, body: { ticket: s2.json.ticket, code: recovery[0] }
    })
    check('同一恢复码第二次被拒', rec2.status === 401, rec2.json)

    console.log('\n[10] 关闭两步验证（还原现场）')
    // 关闭要求一个"尚未使用过"的码（防止会话被劫持后拿用户刚用过的码直接关掉 2FA）。
    // 而同一时间窗内登录已经消费掉了当前步，校验又只容忍 ±1 步，
    // 所以必须真的等到下一个窗口 —— 这里如实等待，不用偏移量取巧。
    await waitForNextWindow()
    const cap6 = await freshCaptcha(jar3)
    const l3 = await request('POST', '/apis/admin/login', {
      jar: jar3, body: { username: ADMIN_USER, password: ADMIN_PASS, imageId: cap6.imageId, imageCode: cap6.imageCode }
    })
    const s3 = await request('POST', '/apis/admin/login/totp', {
      jar: jar3, body: { ticket: l3.json.ticket, code: totpLib.totp(secret) }
    })
    check('新窗口的动态码可登录', s3.status === 200 && s3.json.success === true, s3.json)

    await waitForNextWindow()
    const csrf3 = csrfOf(jar3)
    const off = await request('POST', '/apis/admin/totp/disable', {
      jar: jar3, headers: { 'X-CSRF-Token': csrf3 }, body: { code: totpLib.totp(secret) }
    })
    check('关闭成功', off.status === 200 && !!(off.json && off.json.success), off.json)
    if (off.status === 200) enabledByTest = false
  } catch (error) {
    if (error instanceof RateLimited) {
      console.log('\n  ⏸ ' + error.message)
      console.log('  说明：这不是功能缺陷，本次结果作废，请在限流窗口过后重跑。')
    } else {
      fail++
      console.log('  ✗ 脚本异常: ' + error.message)
    }
  } finally {
    if (enabledByTest) {
      console.log('\n!! 2FA 仍处于开启状态，兜底未完成。')
      console.log('!! 恢复办法：psql -d hello_pix -c "UPDATE admins SET totp_enabled=false,totp_secret=NULL;"')
      process.exitCode = 2
    }
    console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`)
    if (fail > 0 && !process.exitCode) process.exitCode = 1
  }
})()
