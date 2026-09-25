'use strict'

const { ProductionRepository } = require('./repositories/production-repository')
const { AuthService } = require('./services/auth-service')
const { CoreService } = require('./services/core-service')
const { CustomerRepository } = require('./repositories/customer-repository')
const { CustomerIdentityService } = require('./services/customer-identity-service')
const { AccountService } = require('./services/account-service')
const { productionRouter } = require('./routes/production')
const { sendError } = require('./lib/http')

/**
 * Registers the persistent API only. The caller owns pool/redis lifecycle and
 * must install its final 500 error handler after this function.
 */
function registerProductionApi(app, context, options) {
  if (!app || typeof app.use !== 'function') throw new TypeError('app 必须是 Express application')
  const deps = context || {}
  const requiredSecurity = [
    'createSession', 'resolveSession', 'destroySession', 'revokeSubject',
    'csrf', 'headers', 'originGuard'
  ]
  if (!deps.security || requiredSecurity.some(name => typeof deps.security[name] !== 'function')) {
    throw new TypeError(`context.security 必须提供 ${requiredSecurity.join('/')}`)
  }

  const repository = new ProductionRepository(deps.pool)
  const auth = new AuthService(repository, deps.security)
  const core = new CoreService(repository, deps.redis, auth, options)
  // 统一客户身份层。仓储复用 ProductionRepository 的 query/transaction，
  // 不另开连接池 —— 多一个池就多一处要配的容量与超时。
  const customers = new CustomerIdentityService(new CustomerRepository(repository))
  // 注册 / 找回密码 / 邮箱验证码。之前这三条是 stub。
  const accounts = new AccountService(repository, auth, deps.redis, options)

  app.use(deps.security.headers)

  /**
   * API 响应一律不许被浏览器缓存。
   *
   * ## 为什么必须显式声明
   *
   * Express 默认给每个响应加一个**弱 ETag**（`W/"..."`），而这里此前没有任何
   * `Cache-Control`。没有 `Cache-Control` 时，浏览器会按"启发式缓存"处理：
   * 把响应当成可缓存的，之后每次请求带上 `If-None-Match`，服务端比对 ETag 后
   * 回 **304 Not Modified（0 字节）**，浏览器再把本地那份旧响应端出来。
   *
   * 这在后台是**实打实出过事故**的：
   *
   *   1. 接口修好、代码也部署了，但运营页面上仍然是旧的 503 报错 ——
   *      因为浏览器压根没去取新数据，一直拿本地缓存的旧 JSON；
   *   2. 会话相关的接口（`/admin/totp` 等）按会话返回不同内容，
   *      被缓存后可能端出上一个会话的响应体，页面卡在加载态；
   *   3. nginx 日志里几乎每个后台 GET 都是 304，真实请求量被掩盖，
   *      排查时看不到"到底请求了什么"。
   *
   * `/apis/*` 全是动态的、且大多与会话/权限相关，**没有任何一个适合缓存**。
   * 具体地：`no-store` 让浏览器既不存也不重验证，`If-None-Match` 从此不再发出，
   * 304 自然消失；`private` 防止中间代理缓存；`Pragma` 照顾老客户端。
   *
   * 注意只对 `/apis` 生效 —— `dist/` 下的静态资源仍然走 ETag/强缓存，
   * 那是应该缓存的，不能一起关掉。
   */
  app.use('/apis', (_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
    next()
  })

  app.use('/apis', deps.security.originGuard)
  app.use('/apis', productionRouter({
    repository,
    auth,
    core,
    customers,
    accounts,
    security: deps.security
  }))
  app.use('/apis', sendError)

  if (!options || options.startReconciliation !== false) {
    core.startReservationReconciliation(options && options.reconciliation)
  }

  return {
    repository,
    auth,
    core,
    customers,
    accounts,
    reconcileExpiredReservations: (...args) => core.reconcileExpiredReservations(...args),
    stop: () => core.stopReservationReconciliation()
  }
}

module.exports = registerProductionApi
module.exports.registerProductionApi = registerProductionApi
