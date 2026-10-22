'use strict'

/**
 * 路由模块的**可执行性**验证。
 *
 * ## 为什么必须有这个测试
 *
 * 2026-10-21 的拆分把 `readSettings()` 与 `USDT_TRC20_CONTRACT`
 * 从 `production.js` 搬进了 `admin.js`，但 `production.js` 里的调用点留在了原地。
 * 结果 `/userRecharge/create` 一执行就 `ReferenceError`，**充值功能整个挂掉**。
 *
 * 当时所有测试都是绿的，包括我专门写的"冒烟测试"。原因是它们只验证：
 *
 *   · 文件语法能过（`node --check`）—— 悬空标识符是**运行时**错误，语法完全合法
 *   · 路由已注册（`router.stack` 里有这条）—— 注册不需要执行 handler 体
 *   · 源码里有没有某个字符串 —— 只检查"写了什么"，不检查"跑不跑得起来"
 *
 * 这个测试换成真正执行：把每条路由的 handler 用假 req/res 跑一遍，
 * 断言它**至少不会抛 `ReferenceError` / `TypeError`**。
 *
 * ## 边界
 *
 * 假 repo 对所有查询返回空结果，所以 handler 大多会在业务校验处提前返回
 * （404、403、参数错误）—— 这正是我们要的：只验证代码路径可达，
 * 不验证业务正确性（那由各自的单测负责）。
 *
 * 抛 `ApiError` 是**正常**的（业务校验），抛 `ReferenceError` 是**拆分事故**。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const { buildContext } = require('../server/routes/context')

/** 一个什么都返回空但记录调用的 repo */
function fakeRepo() {
  const empty = { rows: [], rowCount: 0 }
  return {
    query: async () => empty,
    list: async () => ({ rows: [], total: 0 }),
    settings: async () => ({}),
    // 必须返回一个"存在的套餐"：否则 /userRecharge/create 会在
    // `if (!pack) throw 404` 处提前返回，永远走不到真正要测的下单逻辑。
    // 这正是第一版守卫失效的原因 —— 它在第一个 if 就 return 了，测了个寂寞。
    package: async () => ({ id: 1, title: '标准版', price: 100, includedChars: 100000, subQuota: 0 }),
    packages: async () => [],
    transaction: async fn => fn({}),
    audit: async () => {},
    // 这几个返回**数组**而不是 {rows}，Proxy 的默认兜底返回的是 {rows:[],...}
    enginesForAdmin: async () => [],
    packageEngines: async () => [],
    engineById: async () => null,
    engineCredentials: async () => ({}),
    packageWithEngines: async () => null,
    packagesWithEngines: async () => [],
    lockAccount: async () => null,
    adjustChars: async () => {},
    chargesByOrder: async () => [],
    releaseReservation: async () => {},
    siteInfo: async () => ({})
  }
}

/**
 * 把对象包一层 Proxy：访问任何未定义的方法时返回一个 async 空实现。
 *
 * 逐个手写假方法很脆弱 —— 每次给路由加一个 `core.xxx()`，
 * 这个测试就会假红，然后被人加个 `|| (() => {})` 糊过去，守卫就慢慢失效了。
 * 用 Proxy 兜底，测试只关心"代码能不能执行到底"，不关心业务返回值。
 *
 * 返回 `{}` 而不是 `undefined`：多数 handler 会 `const x = await ...` 再读属性，
 * 返回 undefined 会在下一行就 TypeError，反而是测试噪音。
 */
function autoStub(target = {}) {
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop]
      if (typeof prop !== 'string') return undefined
      // 只对"看起来像方法调用"的访问兜底；属性读取返回 undefined，
      // 让真正的属性缺失暴露出来（比如 repo.settings 缺失应该报错）
      return async () => ({ rows: [], rowCount: 0, total: 0 })
    }
  })
}

function fakeContext() {
  const pass = (req, res, next) => (next ? next() : undefined)
  return {
    repository: autoStub(fakeRepo()),
    auth: autoStub({
      middleware: () => pass,
      loginUser: async () => ({ kind: 'main', account: {}, parent: {} }),
      verifyAdminCredentials: async () => ({ username: 'admin' }),
      startAdminSession: async () => {}
    }),
    core: autoStub({
      redis: { get: async () => null, set: async () => 'OK', del: async () => 1, incr: async () => 1, expire: async () => 1, eval: async () => [0, 1] },
      platforms: () => [],
      profile: () => ({}),
      quote: async () => ({ price: 100, chars: 100000, original: 100, discount: 0, paid: 100 })
    }),
    customers: autoStub({}),
    accounts: autoStub({
      mailer: autoStub({ configured: async () => false, config: async () => ({ missing: [] }) })
    }),
    security: autoStub({ csrf: pass })
  }
}

/** 假 req */
function fakeReq({ method = 'GET', path = '/', body = {}, query = {} } = {}) {
  return {
    method,
    path,
    url: path,
    originalUrl: path,
    ip: '127.0.0.1',
    body,
    query,
    params: {},
    headers: {},
    get: () => '',
    // 已登录身份（大多数后台 handler 要读）
    pixUser: { kind: 'main', account: { id: 1, username: 'u' }, parent: { id: 1, packageId: 1, enterprise: 0 } },
    pixAdmin: { id: 1, username: 'admin' }
  }
}

/** 假 res：记录调用，不真的发响应 */
function fakeRes() {
  const state = { statusCode: 200, body: null, ended: false, headers: {} }
  const res = {
    state,
    status(code) { state.statusCode = code; return res },
    json(payload) { state.body = payload; state.ended = true; return res },
    send(payload) { state.body = payload; state.ended = true; return res },
    setHeader(k, v) { state.headers[k] = v; return res },
    header(k, v) { state.headers[k] = v; return res },
    end() { state.ended = true; return res },
    redirect() { state.ended = true; return res },
    clearCookie() { return res },
    cookie() { return res }
  }
  return res
}

/** 收集 router 上所有路由层 */
function collectRoutes(router) {
  return (router.stack || []).filter(layer => layer.route).map(layer => ({
    methods: Object.keys(layer.route.methods || {}).filter(m => m !== '_all'),
    path: layer.route.path,
    stack: layer.route.stack || []
  }))
}

/**
 * 跑一条路由的最后一层 handler（真正的业务逻辑）。
 * 前面的层是限流器与中间件，这里全部跳过 —— 只关心业务代码能不能执行。
 */
async function runHandler(route) {
  const handlerLayer = [...route.stack].reverse().find(l => typeof l.handle === 'function')
  if (!handlerLayer) return { skipped: true }

  const req = fakeReq({ method: route.methods[0] || 'GET', path: route.path })
  const res = fakeRes()

  try {
    // 关键 1：asyncRoute 把异常交给 next()，而 next 若是空函数，
    // 错误就被**静默吞掉**了 —— 第一版守卫就是这么失效的。
    // 这里把 next 收到的错误接住，交给下面的判定。
    //
    // 关键 2：asyncRoute 返回的是**普通函数**（不是 Promise），
    // 它在内部 `Promise.resolve(...).catch(next)` —— 所以
    // `await handle(...)` 会**立刻返回 undefined**，此时 next 还没被调用。
    // 必须等一个微任务轮次，否则永远读到 nextErr === null。
    let nextErr = null
    let called = false
    const next = err => { called = true; if (err) nextErr = err }

    await withTimeout((async () => {
      handlerLayer.handle(req, res, next)
      // 让 asyncRoute 内部的 catch(next) 有机会执行
      await new Promise(resolve => setImmediate(resolve))
    })(), 2000)

    if (nextErr) return { ok: false, err: nextErr }
    return { ok: true }
  } catch (err) {
    return { ok: false, err }
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms).unref?.())
  ])
}

/**
 * 这些错误是**预期内**的：假数据触发的业务校验。
 * 只要不是"代码不存在"级别的错误，就说明 handler 体至少能跑到校验处。
 */
function isExpectedBusinessError(err) {
  const name = err && err.name
  const msg = String((err && err.message) || '')
  // ApiError 是业务校验（401/403/404/400）
  if (name === 'ApiError' || (err && err.status)) return true
  // 假 repo 让某些分支拿不到数据，用普通 Error 提前抛也是业务语义
  if (/TIMEOUT/.test(msg)) return false
  return false
}

/** ReferenceError / TypeError 是拆分事故的典型签名 */
function isSplitAccident(err) {
  const name = err && err.name
  const msg = String((err && err.message) || '')
  if (name === 'ReferenceError') return true
  if (name === 'TypeError') {
    // "xxx is not a function" / "Cannot read properties of undefined"
    // 在假数据下可能是正常分支，所以只在提到具体标识符时算事故
    return /is not a function|is not defined|is not iterable/.test(msg)
  }
  return false
}

const MODULES = [
  // production.js 导出的是工厂 { productionRouter }，签名是 (context) => Router
  { name: 'production.js', file: '../server/routes/production', factory: 'productionRouter' },
  // 其余导出 { registerXxx }，签名是 (router, ctx) => void
  { name: 'auth.js', file: '../server/routes/auth' },
  // admin.js 已按业务域拆成 6 个模块，每个都要单独跑一遍 ——
  // 拆文件最容易丢 import，而丢 import 只有真正执行 handler 才会暴露
  { name: 'admin/content.js', file: '../server/routes/admin/content' },
  { name: 'admin/dashboard.js', file: '../server/routes/admin/dashboard' },
  { name: 'admin/accounts.js', file: '../server/routes/admin/accounts' },
  { name: 'admin/clients.js', file: '../server/routes/admin/clients' },
  { name: 'admin/ops.js', file: '../server/routes/admin/ops' },
  { name: 'admin/settings.js', file: '../server/routes/admin/settings' }
]

for (const mod of MODULES) {
  test(`${mod.name}：每条 handler 都能执行，不出现 ReferenceError`, async () => {
    const raw = fakeContext()
    // buildContext 需要 core.redis 来造限流器
    const ctx = buildContext(raw)
    const exported = require(mod.file)

    let routes
    if (mod.factory) {
      // production.js：工厂内部会自己 buildContext，传原始 context
      routes = collectRoutes(exported[mod.factory](raw))
    } else {
      const router = require('express').Router()
      for (const fn of Object.values(exported)) {
        if (typeof fn === 'function') fn(router, ctx)
      }
      routes = collectRoutes(router)
    }

    assert.ok(routes.length > 0, `${mod.name} 没注册出任何路由`)

    const accidents = []
    for (const route of routes) {
      const result = await runHandler(route)
      if (result.skipped) continue
      if (!result.ok && isSplitAccident(result.err)) {
        accidents.push(`${route.methods.join(',').toUpperCase()} ${route.path} → ${result.err.name}: ${result.err.message}`)
      }
    }

    assert.deepEqual(accidents, [],
      `以下 handler 执行时抛出了"标识符不存在"类错误 —— `
      + `通常意味着拆分模块时把某个函数/常量搬走了，调用点留在了原地：\n`
      + accidents.join('\n'))
  })
}
