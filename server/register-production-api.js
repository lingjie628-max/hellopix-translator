'use strict'

const { ProductionRepository } = require('./repositories/production-repository')
const { AuthService } = require('./services/auth-service')
const { CoreService } = require('./services/core-service')
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

  app.use(deps.security.headers)
  app.use('/apis', deps.security.originGuard)
  app.use('/apis', productionRouter({
    repository,
    auth,
    core,
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
    reconcileExpiredReservations: (...args) => core.reconcileExpiredReservations(...args),
    stop: () => core.stopReservationReconciliation()
  }
}

module.exports = registerProductionApi
module.exports.registerProductionApi = registerProductionApi
