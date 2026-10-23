/**
 * 鉴权路径必须大小写不敏感 —— 2026-10-23 真实入侵的根因。
 *
 * ## 现场
 *
 * 攻击者 04:21 注册了一个普通商户账号，04:33 开始试超管接口：
 *
 *   [04:33:21] POST /apis/admin/staff/save   → 403   ← 正常，被拦
 *   [04:33:48] POST /apis/ADMIN/staff/save   → 200   ← 改成大写，绕过成功
 *   [04:33:50] POST /apis/ADMIN/staff/save   → 409   （用户名重复）
 *   [04:35:44] POST /apis/ADMIN/staff/save   → 200   （建了第二个后门超管）
 *
 * 27 秒内它就在试大小写。之后用后门账号登录超管后台 19 次，
 * 改了 53 次翻译通道配置、删了 2 个商户、给账号 PIXPWN01 加了 100000 字符。
 *
 * ## 根因
 *
 * Express 路由**默认大小写不敏感**，`/ADMIN/staff/save` 照样命中 handler；
 * 而鉴权中间件拿**原始大小写**的 `req.path` 做 `startsWith('/admin/')`，
 * 判不出来，于是落进商户分支 —— 只要商户已登录就放行。
 *
 * 修法：分类判断统一用小写，但不改写传给下游的路径。
 *
 * ## 为什么这条测试值得存在
 *
 * 防护逻辑和框架语义之间只要有一处口径不一致，整层鉴权就是装饰品。
 * 大小写只是最容易踩的一种（还有尾斜杠、URL 编码、路径穿越，
 * 后者在 nginx + Express 下已经有实际拦截记录）。
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const { AuthService } = require('../server/services/auth-service')

/** 造一个只跑中间件的 AuthService 桩。 */
function harness ({ admin = null, user = null } = {}) {
  const svc = Object.create(AuthService.prototype)
  svc.security = {
    resolveSession: async (req, type) => {
      if (type === 'admin') return admin ? { subjectId: 1, deviceId: '' } : null
      return user ? { subjectId: 2, deviceId: '' } : null
    }
  }
  svc.repository = {
    adminById: async () => admin,
    sessionAccount: async () => user
  }
  return svc
}

/**
 * 跑一次中间件。
 * @returns {{status:number|null, next:boolean, type:string}}
 */
async function run (svc, { path, method = 'POST', headers = {} }) {
  const req = { path, method, headers, ip: '1.2.3.4' }
  const res = {}
  let status = null
  let passed = false
  // ApiError 在真实链路里会被错误处理器转成 HTTP 状态码
  svc.middleware()(req, res, err => {
    if (err) { status = err.status || err.statusCode || 500; return }
    passed = true
  })
  // 中间件是 async，等一个微任务轮次
  await new Promise(r => setImmediate(r))
  return { status, next: passed, type: req.pixSessionType || (req.pixUser ? 'user' : '') }
}

const ADMIN = { id: 1, role: 'superadmin', status: 1, username: 'pix' }
const OPERATOR = { id: 2, role: 'operator', status: 1, username: 'staff' }
const USER = {
  account: { id: 2, status: 1 },
  parent: { id: 2, status: 1, expiresAt: null }
}

// ── 核心：大小写绕过 ───────────────────────────────────────

test('普通商户用大写路径调超管接口 → 必须 401，不能放行', async () => {
  const svc = harness({ user: USER })

  for (const path of [
    '/ADMIN/staff/save',
    '/Admin/staff/save',
    '/aDmIn/users/save',
    '/ADMIN/users/delete'
  ]) {
    const r = await run(svc, { path })
    assert.equal(r.next, false, `${path} 不该放行给商户`)
    assert.equal(r.status, 401, `${path} 应判为"超管未登录"`)
  }
})

test('未登录用大写路径调超管接口 → 401', async () => {
  const svc = harness({})
  const r = await run(svc, { path: '/ADMIN/staff/save' })
  assert.equal(r.status, 401)
  assert.equal(r.next, false)
})

test('大写路径也要走 operator 的角色限制，写操作 403', async () => {
  const svc = harness({ admin: OPERATOR })
  const r = await run(svc, { path: '/ADMIN/settings/save' })
  assert.equal(r.status, 403, 'operator 写操作必须被挡')
  assert.equal(r.next, false)
})

test('operator 大写路径读 superOnly 接口 → 403', async () => {
  const svc = harness({ admin: OPERATOR })
  for (const path of ['/ADMIN/staff', '/ADMIN/users', '/ADMIN/subs']) {
    const r = await run(svc, { path, method: 'GET' })
    assert.equal(r.status, 403, `${path} 仅限超管`)
  }
})

// ── 正常路径不能被误伤 ────────────────────────────────────

test('超管正常调用（大小写混用都可以）→ 放行', async () => {
  const svc = harness({ admin: ADMIN })
  for (const path of ['/admin/staff', '/ADMIN/staff', '/admin/users/save']) {
    const r = await run(svc, { path })
    assert.equal(r.next, true, `${path} 应当放行超管`)
    assert.equal(r.type, 'admin')
  }
})

test('publicPaths 大小写混用也认（登录入口不能因大小写 401）', async () => {
  const svc = harness({})
  for (const path of ['/SITE/INFO', '/Site/Info', '/ADMIN/LOGIN']) {
    const r = await run(svc, { path, method: 'GET' })
    assert.equal(r.next, true, `${path} 是公开路径`)
  }
})

test('商户正常调用不被误判成超管', async () => {
  const svc = harness({ user: USER })
  const r = await run(svc, { path: '/team/info', method: 'GET' })
  assert.equal(r.next, true)
  assert.equal(r.type, 'user')
})

test('尾斜杠 + 大小写组合也不绕过', async () => {
  const svc = harness({ user: USER })
  const r = await run(svc, { path: '/ADMIN/staff/save/' })
  assert.equal(r.next, false)
  assert.equal(r.status, 401)
})
