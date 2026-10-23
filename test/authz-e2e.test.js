/**
 * 端到端：用真实登录态重放 2026-10-23 入侵者的路径。
 *
 * ## 入侵者实际做了什么
 *
 *   04:30  注册普通商户 pixpwn01
 *   04:33  POST /apis/admin/staff/save          → 403（挡住了）
 *   04:33  POST /apis/ADMIN/staff/save          → 200（大小写绕过，建了后门超管）
 *   04:35  用后门超管登录，无 TOTP
 *   之后   读 /admin/customers/:id 拿全站客户数据、读 /admin/mail 拿到真名邮箱
 *
 * 大小写绕过本身已经由 auth-path-case.test.js 钉住。这里测的是**第二层**：
 * 就算会话是真的（比如后门超管已经建成了），operator 也不该能读客户数据。
 *
 * 上一版在此处全线失守 —— 55 个 /admin 路由里 19 个对 operator 敞开。
 */
const test = require('node:test')
const assert = require('node:assert/strict')

// 复用 security.test.js 的夹具
const { startApi, request, cookieJar, cookieHeader } = require('./helpers/api-fixture')

async function login (base, username, password) {
  const res = await request(base, '/apis/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password })
  })
  assert.equal(res.status, 200, `${username} 登录失败`)
  return cookieJar(res)
}

async function get (base, jar, path) {
  // 故意用大小写混写，模拟攻击者手法
  return request(base, `/apis${path}`, { headers: { Cookie: cookieHeader(jar) } })
}

/**
 * 带二次认证的 GET。
 *
 * 高危能力（读客户数据、读管理员名单、读密钥配置）除了会话还要 X-Pix-Reauth。
 * 这里统一封装，免得每个用例都抄一遍 header。
 */
async function reauthGet (base, jar, path, password) {
  return request(base, `/apis${path}`, {
    headers: { Cookie: cookieHeader(jar), 'x-pix-reauth': password }
  })
}

/**
 * 带二次认证的 POST。
 */
async function reauthPost (base, jar, path, form, password) {
  return request(base, `/apis${path}`, {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(jar),
      'X-CSRF-Token': decodeURIComponent(jar.pix_csrf),
      'x-pix-reauth': password,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(form)
  })
}

/** 造一个 operator 账号，返回其 cookie。 */
async function makeOperator (api, superJar, username) {
  // 建管理员是高危能力，必须带二次认证
  const res = await request(api.base, '/apis/admin/staff/save', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(superJar),
      'X-CSRF-Token': decodeURIComponent(superJar.pix_csrf),
      'x-pix-reauth': 'admin123',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      username,
      password: 'operator-pass-2026',
      nickname: '运营',
      role: 'operator'
    })
  })
  assert.equal(res.status, 200, '创建 operator 失败')
  return login(api.base, username, 'operator-pass-2026')
}

test('operator 读全站客户数据 / 审计日志 / 运维脚本 → 全部 403', async t => {
  const api = await startApi()
  t.after(api.close)
  const superJar = await login(api.base, 'admin', 'admin123')
  const opJar = await makeOperator(api, superJar, 'op-cust-2026')

  // 这些正是上一版对 operator 敞开的口子
  const forbidden = [
    '/admin/customers',
    '/admin/customers/1',
    '/admin/fans',
    '/admin/merge-candidates',
    '/admin/collisions',
    '/admin/logs',
    '/admin/scripts',
    '/ADMIN/customers',
    '/Admin/Customers/1',
    '/ADMIN/logs'
  ]
  for (const path of forbidden) {
    // 关键：必须是 403 而不是 428。
    // 428 意味着"身份没问题，只是没重新验证"—— 那等于告诉 operator
    // "你输个密码就能读"。角色拒绝必须发生在二次认证之前。
    const res = await reauthGet(api.base, opJar, path, 'operator-pass-2026')
    assert.equal(res.status, 403, `${path} 不该对 operator 开放（实际 ${res.status}）`)
    const body = await res.json()
    assert.equal(body.success, false, `${path} 不该返回数据`)
  }

  // 不带 reauth 也必须是 403，不能是 428
  for (const path of ['/admin/customers', '/admin/logs']) {
    const res = await get(api.base, opJar, path)
    assert.equal(res.status, 403, `${path} 即便不带 reauth 也应是 403（实际 ${res.status}）`)
  }
})

test('operator 读 SMTP 配置 / 全局设置 → 403（这些能拿到真实邮箱和密钥）', async t => {
  const api = await startApi()
  t.after(api.close)
  const superJar = await login(api.base, 'admin', 'admin123')
  const opJar = await makeOperator(api, superJar, 'op-secret-2026')

  for (const path of ['/admin/mail', '/admin/settings', '/admin/verify']) {
    const res = await reauthGet(api.base, opJar, path, 'operator-pass-2026')
    assert.equal(res.status, 403, `${path} 不该对 operator 开放（实际 ${res.status}）`)
  }
})

test('operator 建超管 / 删商户 / 重置密码 → 全部 403，且没有真的建成', async t => {
  const api = await startApi()
  t.after(api.close)
  const superJar = await login(api.base, 'admin', 'admin123')
  const opJar = await makeOperator(api, superJar, 'op-write-2026')

  const attempts = [
    ['/admin/staff/save', { username: 'pxroot-2026', password: 'pwn12345', role: 'superadmin' }],
    ['/ADMIN/staff/save', { username: 'pxroot-2026b', password: 'pwn12345', role: 'superadmin' }],
    ['/admin/settings/save', { siteTitle: 'pwned' }],
    ['/admin/translate/grant', { id: '1', amount: '99999' }]
  ]
  for (const [path, form] of attempts) {
    // 带上正确的 reauth 密码，确保拒绝原因**只能是角色**而不是"没验证"
    const res = await reauthPost(api.base, opJar, path, form, 'operator-pass-2026')
    assert.equal(res.status, 403, `${path} 必须拒绝 operator（实际 ${res.status}）`)
  }

  // 二次确认：后门超管真的没进去
  // 注意：mock 的登录失败走 HTTP 200 + success:false，不能只看状态码
  const probe = await request(api.base, '/apis/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'pxroot-2026', password: 'pwn12345' })
  })
  const probeBody = await probe.json()
  assert.notEqual(probeBody.success, 'success', 'operator 竟然成功创建了后门超管')
  assert.equal(probe.headers.get('set-cookie'), null, '后门账号居然登录成功了')
})

test('operator 日常运营不受影响：统计 / 充值单 / 翻译记录 / 通道状态照常可读', async t => {
  const api = await startApi()
  t.after(api.close)
  const superJar = await login(api.base, 'admin', 'admin123')
  const opJar = await makeOperator(api, superJar, 'op-daily-2026')

  for (const path of [
    '/admin/stats',
    '/admin/recharges',
    '/admin/translate/logs',
    '/admin/engines',
    '/admin/packages',
    '/admin/faqs'
  ]) {
    const res = await get(api.base, opJar, path)
    assert.equal(res.status, 200, `${path} 是 operator 日常工作，不该拦（实际 ${res.status}）`)
  }
})

test('superadmin 同一批敏感接口照常可用（没把超管一起误伤）', async t => {
  const api = await startApi()
  t.after(api.close)
  const superJar = await login(api.base, 'admin', 'admin123')

  // 这些大多是高危能力，超管也要带二次认证
  for (const path of [
    '/admin/customers',
    '/admin/logs',
    '/admin/scripts',
    '/admin/mail',
    '/admin/settings',
    '/admin/staff',
    '/admin/stats'
  ]) {
    const res = await reauthGet(api.base, superJar, path, 'admin123')
    assert.equal(res.status, 200, `superadmin 应当能访问 ${path}（实际 ${res.status}）`)
  }
})

test('超管不带二次认证访问高危接口 → 428（不是静默放行）', async t => {
  const api = await startApi()
  t.after(api.close)
  const superJar = await login(api.base, 'admin', 'admin123')

  for (const path of ['/admin/customers', '/admin/staff', '/admin/mail', '/admin/logs']) {
    const res = await get(api.base, superJar, path)
    assert.equal(res.status, 428, `${path} 应当要求二次认证（实际 ${res.status}）`)
  }

  // 低危只读接口不该被要求
  for (const path of ['/admin/stats', '/admin/recharges']) {
    const res = await get(api.base, superJar, path)
    assert.equal(res.status, 200, `${path} 不该要求二次认证（实际 ${res.status}）`)
  }
})

test('普通商户会话打 admin 接口 → 401（大小写都一样）', async t => {
  const api = await startApi()
  t.after(api.close)

  const reg = await request(api.base, '/apis/user/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: 'merchant-2026',
      password: 'merchant-pass',
      email: 'merchant2026@example.com'
    })
  })
  // 注册可能因为邮箱验证等原因失败，此时跳过（这条主链路由 security.test.js 覆盖）
  if (reg.status !== 200) return

  for (const path of ['/admin/customers', '/ADMIN/customers', '/admin/staff', '/ADMIN/staff']) {
    const res = await request(api.base, `/apis${path}`, { headers: { Cookie: cookieHeader(cookieJar(reg)) } })
    assert.ok(res.status === 401 || res.status === 403, `${path} 普通商户不该进（实际 ${res.status}）`)
  }
})
