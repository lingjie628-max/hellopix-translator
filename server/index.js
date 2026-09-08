'use strict'

const express = require('express')
const path = require('path')
const { createSecurity } = require('./security')
const { createRedisSecurity } = require('./redis-security')
const registerProductionApi = require('./register-production-api')

const REQUIRED_MIGRATIONS = Object.freeze([
  '001_initial_schema',
  '002_seed_catalog',
  '003_support_core_api',
  '004_client_releases_draft_url'
])

function envFlag(value) {
  return /^(1|true|yes)$/i.test(String(value || ''))
}

function origins(value, production) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean).map(item => {
    let parsed
    try {
      parsed = new URL(item)
    } catch (_error) {
      throw new Error(`ALLOWED_ORIGINS 包含无效 URL：${item}`)
    }
    if (parsed.origin !== item || parsed.username || parsed.password) {
      throw new Error(`ALLOWED_ORIGINS 必须只包含来源 origin：${item}`)
    }
    if (production && parsed.protocol !== 'https:') {
      throw new Error(`生产 ALLOWED_ORIGINS 必须使用 HTTPS：${item}`)
    }
    return parsed.origin
  })
}

function assertSafeHost(production, host) {
  if (production && host !== '127.0.0.1' && host !== '::1') {
    throw new Error('生产服务必须仅监听本机地址，由 Nginx 对外提供 HTTPS')
  }
}

async function checkMigrationVersion(query) {
  let result
  try {
    result = await query('SELECT name FROM pgmigrations ORDER BY run_on,id')
  } catch (error) {
    throw new Error(`无法读取迁移版本：${error.message}`)
  }
  const applied = new Set(result.rows.map(row => String(row.name).replace(/\.js$/, '')))
  const missing = REQUIRED_MIGRATIONS.filter(name => !applied.has(name))
  if (missing.length) throw new Error(`数据库迁移未完成：缺少 ${missing.join(', ')}`)
  return { applied: Array.from(applied), required: REQUIRED_MIGRATIONS.slice() }
}

async function createRuntime(options) {
  const opts = options || {}
  const production = opts.production === undefined ? process.env.NODE_ENV === 'production' : Boolean(opts.production)
  const persistent = opts.persistent === undefined
    ? production || envFlag(process.env.PIX_USE_PERSISTENT_BACKEND)
    : Boolean(opts.persistent)
  const host = opts.host || process.env.HOST || '127.0.0.1'
  const port = Number(opts.port === undefined ? process.env.PORT || 3000 : opts.port)
  assertSafeHost(production, host)

  let db = opts.db
  let api
  let security
  if (persistent) {
    db = db || require('./db')
    try {
      const health = await db.checkDependencies()
      if (!health.postgres || !health.redis) throw new Error('PostgreSQL 或 Redis 健康检查失败')
      await checkMigrationVersion(db.query)
      const redis = opts.redis || db.getRedis()
      security = opts.security || createRedisSecurity({
        production,
        allowedOrigins: origins(process.env.ALLOWED_ORIGINS, production),
        redis
      })
      api = { register: opts.registerProductionApi || registerProductionApi, context: { pool: db.pool, redis, security } }
    } catch (error) {
      if (typeof db.closeDependencies === 'function') await db.closeDependencies()
      throw error
    }
  } else {
    security = opts.security || createSecurity({
      production: false,
      allowedOrigins: origins(process.env.ALLOWED_ORIGINS, false)
    })
    api = { register: opts.registerMockApi || require('../mock'), context: { security } }
  }

  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  app.use(express.urlencoded({ extended: false, limit: '256kb' }))
  app.use(express.json({ limit: '256kb' }))

  let services
  try {
    services = api.register(app, api.context, opts.productionApiOptions)
  } catch (error) {
    if (persistent && db && typeof db.closeDependencies === 'function') await db.closeDependencies()
    throw error
  }
  const dist = path.join(__dirname, '..', 'dist')
  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'hello-pix', backend: persistent ? 'persistent' : 'mock', time: new Date().toISOString() })
  })
  app.use(express.static(dist, { index: false, maxAge: production ? '1h' : 0 }))
  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) return next()
    res.sendFile(path.join(dist, 'index.html'))
  })
  app.use((err, _req, res, _next) => {
    console.error(err && err.stack ? err.stack : err)
    if (!res.headersSent) res.status(500).json({ success: false, msg: '服务器内部错误' })
  })

  let server = null
  let starting = null
  let stopping = null
  const runtime = {
    app,
    persistent,
    services,
    get server() { return server },
    async start() {
      if (server) return server
      if (starting) return starting
      starting = new Promise((resolve, reject) => {
        const onError = error => reject(error)
        const listener = app.listen(port, host, () => {
          listener.removeListener('error', onError)
          server = listener
          resolve(listener)
        })
        listener.once('error', onError)
      })
      try {
        return await starting
      } finally {
        starting = null
      }
    },
    async stop() {
      if (stopping) return stopping
      stopping = (async () => {
        if (services && typeof services.stop === 'function') await services.stop()
        if (server) {
          const active = server
          server = null
          await new Promise((resolve, reject) => active.close(error => error ? reject(error) : resolve()))
        }
        if (persistent && db && typeof db.closeDependencies === 'function') await db.closeDependencies()
      })()
      try {
        await stopping
      } finally {
        stopping = null
      }
    }
  }
  app.locals.runtime = runtime
  return runtime
}

async function createApp(options) {
  return (await createRuntime(options)).app
}

async function start(options) {
  const runtime = await createRuntime(options)
  try {
    await runtime.start()
    return runtime
  } catch (error) {
    await runtime.stop()
    throw error
  }
}

async function main() {
  const runtime = await start()
  const address = runtime.server.address()
  console.log(`Hello Pix server listening on http://${address.address}:${address.port}`)
  let shuttingDown = false
  const shutdown = async signal => {
    if (shuttingDown) return
    shuttingDown = true
    const timeout = setTimeout(() => process.exit(1), 10_000)
    timeout.unref()
    try {
      await runtime.stop()
      clearTimeout(timeout)
      process.exit(0)
    } catch (error) {
      console.error(`${signal} shutdown failed:`, error)
      process.exit(1)
    }
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}

if (require.main === module) {
  main().catch(error => {
    console.error(`拒绝启动：${error.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  REQUIRED_MIGRATIONS,
  checkMigrationVersion,
  createRuntime,
  createApp,
  start,
  main
}
