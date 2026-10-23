/**
 * 覆盖性守门：生产里真实挂载的每一个 /admin 路由，都必须在能力表里。
 *
 * ## 这条测试是这套授权模型的最后一道保险
 *
 * 能力表（lib/capabilities.js）是手写的。手写就会有遗漏。
 * 如果某个路由没登记，运行时是 fail-closed（拒绝 + 500），不会放行 ——
 * 但那已经是**线上炸了**。这里在测试阶段就把未登记的路由抓出来。
 *
 * 反过来说：如果有人往能力表里加了路由、代码里却删了，这里也会报
 * （孤儿登记），避免能力表逐渐变成一张和现实脱节的废纸。
 *
 * 上一版之所以出问题，就是因为"路由定义"和"授权规则"分在两个地方、
 * 谁也不知道对方加了什么。这条测试把它们钉在一起。
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const { ROUTE_CAPS } = require('../server/lib/capabilities')

/** 收集某个 router 上所有路由，返回 'METHOD /path' 形式（忽略 HEAD/OPTIONS）。 */
function collect (router, out = [], prefix = '') {
  const layers = (router && router.stack) || []
  for (const layer of layers) {
    if (layer.route) {
      const path = prefix + layer.route.path
      for (const m of Object.keys(layer.route.methods || {})) {
        const method = m.toUpperCase()
        if (method === 'HEAD' || method === 'OPTIONS') continue
        // router.all() 注册出来的是 _ALL —— 它在本项目里只用于 404/桩路径，
        // 下面按"桩路径不参与能力校验"统一处理，这里保留原样以便断言。
        out.push(`${method === '_ALL' ? '_ALL' : method} ${path}`)
      }
    } else if (layer.handle && layer.handle.stack) {
      // 嵌套 router（本项目的 admin 模块都是直接挂在同一个 router 上的，
      // 这里兼容将来拆成子 router 的情况）
      collect(layer.handle, out, prefix)
    }
  }
  return out
}

/**
 * 不需要能力声明的 admin 路由。
 *
 * 两类：
 *   1. 认证入口本身 —— 调用它们时还没有会话，由 publicPaths 处理
 *   2. 兼容期的桩 —— 只返回"该模块尚未迁移"，没有数据可泄，
 *      但也没注册成正式能力（将来实现时必须补登记）
 *
 * 这个清单必须显式列出，不能靠"忘了登记就跳过" —— 否则新加的桩
 * 会悄悄绕过守门测试。
 */
const NO_CAP_REQUIRED = new Set([
  'POST /admin/login',
  'POST /admin/login/totp',
  'POST /admin/logout',
  // 兼容期桩：未迁移的旧接口，只回一句说明
  '_ALL /admin/notices',
  '_ALL /admin/notices/save',
  '_ALL /admin/notices/delete'
])

/**
 * 造一套最小依赖，把 productionRouter 装配起来。
 *
 * 目的只是拿到路由表，不会真的调用 handler —— 所以 service 全部给桩。
 * 任何被 router 注册阶段就用到的字段都要补上，否则装配时抛错。
 */
function buildProductionRouter () {
  const { productionRouter } = require('../server/routes/production')

  const noop = async () => ({ rows: [], rowCount: 0 })
  const repository = new Proxy({}, {
    get: (_t, prop) => {
      // 装配阶段可能会读一些常量/方法，一律给可调用的桩
      if (prop === 'query' || prop === 'transaction') return noop
      if (prop === 'adminById') return async () => null
      if (prop === 'sessionAccount') return async () => null
      return typeof prop === 'string' ? (async () => null) : undefined
    }
  })
  const stubService = new Proxy({}, {
    get: () => (async () => null)
  })
  const limits = new Proxy({}, { get: () => (_req, _res, next) => next() })
  const security = {
    csrf: (_req, _res, next) => next(),
    resolveSession: async () => null,
    createSession: async () => {},
    destroySession: async () => {},
    revokeSubject: async () => {},
    headers: (_req, _res, next) => next(),
    originGuard: (_req, _res, next) => next()
  }

  return productionRouter({
    repository,
    auth: {
      middleware: () => (_req, _res, next) => next(),
      resolve: async () => null
    },
    core: stubService,
    customers: stubService,
    accounts: stubService,
    security,
    limits,
    services: stubService
  })
}

test('生产挂载的每个 /admin 路由都在能力表里有声明', () => {
  const router = buildProductionRouter()
  const routes = collect(router)
    .filter(r => r.split(' ')[1].startsWith('/admin/'))
    .filter(r => !NO_CAP_REQUIRED.has(r))
  assert.ok(routes.length > 30, `应当收集到足够多的 admin 路由，实际 ${routes.length}`)

  const missing = routes.filter(r => !ROUTE_CAPS[r])
  assert.deepEqual(missing, [], `以下路由未在 lib/capabilities.js 里声明能力：\n  ${missing.join('\n  ')}`)
})

test('能力表里登记的路由，代码里必须真的存在（不留孤儿）', () => {
  const router = buildProductionRouter()
  const actual = new Set(collect(router))

  const orphans = Object.keys(ROUTE_CAPS).filter(key => {
    // 只校验 admin 路由：/site /client 等公开路由由中间件的 publicPaths 处理，
    // 不在能力表里，这里也不该要求它们出现在能力表
    return key.includes(' /admin/') && !actual.has(key)
  })
  assert.deepEqual(orphans, [], `能力表登记了但代码里不存在：\n  ${orphans.join('\n  ')}`)
})

test('能力表里的 admin 路由总数与真实路由一致', () => {
  const router = buildProductionRouter()
  const actual = collect(router)
    .filter(r => r.split(' ')[1].startsWith('/admin/'))
    .filter(r => !NO_CAP_REQUIRED.has(r))
  const declared = Object.keys(ROUTE_CAPS).filter(k => k.includes(' /admin/'))
  assert.equal(
    declared.length, actual.length,
    `能力表 ${declared.length} 条，真实路由 ${actual.length} 条 —— 数量对不上说明有遗漏或多写`
  )
})

/**
 * mock 必须实现生产里的每一条 admin 路由。
 *
 * ## 为什么这条必须有
 *
 * 2026-10-23 审计发现：能力表 52 条 admin 路由，mock 里缺 19 条。
 * 后果是**所有端到端测试都跑不到这 19 条**——包括当时对 operator
 * 完全敞开的那几个（/admin/customers、/admin/logs）。
 *
 * 测试全绿 ≠ 安全。测试打到一个不存在的接口，会拿到 404，
 * 而 404 不违反任何断言。接口缺失造成的"假绿"比 bug 更阴险：
 * 它让人以为已经覆盖了。
 */
test('mock 实现了生产里的每一条 admin 路由（防止假绿）', () => {
  const express = require('express')
  const registerMock = require('../mock')
  const { createSecurity } = require('../server/security')

  const app = express()
  app.use(express.urlencoded({ extended: false }))
  registerMock(app, { security: createSecurity({ production: false }), testMode: true })

  const mockRoutes = new Set()
  const layers = Array.isArray(app.stack) ? app.stack : (app.router && app.router.stack) || []
  for (const layer of layers) {
    if (!layer.route) continue
    const path = String(layer.route.path).replace(/^\/apis/, '')
    for (const m of Object.keys(layer.route.methods || {})) {
      mockRoutes.add(`${m.toUpperCase()} ${path}`)
    }
  }

  const missing = Object.keys(ROUTE_CAPS)
    .filter(k => k.includes(' /admin/'))
    .filter(k => !mockRoutes.has(k))

  assert.deepEqual(missing, [], `mock 缺少以下 admin 路由实现（端到端测试打不到它们）：\n  ${missing.join('\n  ')}`)
})
