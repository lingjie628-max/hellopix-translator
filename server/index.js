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

  // 诊断用请求日志：/apis 下每个请求的方法、路径、状态码、耗时
  app.use('/apis', (req, res, next) => {
    const started = Date.now()
    res.on('finish', () => {
      console.log(`[api] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - started}ms`)
    })
    next()
  })

  let services
  try {
    // 公共翻译网络（"谷歌翻译"这类免费公共端点）默认关闭，需显式开启；
    // 显式传入的 productionApiOptions 优先级最高，便于测试与定制部署。
    const productionApiOptions = Object.assign({
      allowPublicNetwork: envFlag(process.env.PIX_ALLOW_PUBLIC_TRANSLATION)
    }, opts.productionApiOptions || {})
    services = api.register(app, api.context, productionApiOptions)
  } catch (error) {
    if (persistent && db && typeof db.closeDependencies === 'function') await db.closeDependencies()
    throw error
  }
  const dist = path.join(__dirname, '..', 'dist')
  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'hello-pix', backend: persistent ? 'persistent' : 'mock', time: new Date().toISOString() })
  })
  // 静态资源缓存策略：
  //   - 带内容哈希的产物（app.47bedb2c.js）内容一变文件名就变，可以永久缓存；
  //     原先统一 1 小时，回头客每次超时都要重下约 400KB（压缩后）。
  //   - index.html / favicon 这类**没有哈希**的文件必须不缓存，
  //     否则发版后用户拿到的还是旧页面，甚至因引用了已删除的 chunk 而白屏。
  // 按文件名判定，而不是给整个目录一刀切设长缓存。
  const HASHED_ASSET = /\.[0-9a-f]{8}\.(?:js|css)$/
  app.use(express.static(dist, {
    index: false,
    maxAge: production ? '1h' : 0,
    setHeaders(res, filePath) {
      if (!production) return
      if (HASHED_ASSET.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      } else {
        // 无哈希文件（theme.js / landing-boot.js / favicon.ico）必须**立刻**生效：
        // 它们没有内容哈希，改了名字也不变。
        // 这里用 no-store 而不是 no-cache，是因为实测发现 Cloudflare 会把源站的
        // `no-cache` 替换成它自己的 Browser Cache TTL 默认值（4 小时）——
        // 于是 landing-boot.js 这种控制路由分流的脚本会被浏览器缓存 4 小时，
        // 改动传不出去。no-store 明确禁止落盘，CF 不再插手。
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
      }
    }
  }))
  // 超管域名只服务后台，根路径**不能**出官网 ——
  // 否则 lindufyht.com 打开会是官网页，后台入口就没了
  // （前端路由守卫只在拿到主应用后才有机会跳转，见 src/router/index.js 的 ADMIN_HOSTS）。
  const ADMIN_HOSTS = new Set(['lindufyht.com', 'www.lindufyht.com'])
  // 根路径出**官网**入口（landing.html）而非主应用：
  // 官网与主应用已拆成两个 HTML 入口，landing 只带 3 个 Element 组件，约 254KB；
  // 主应用是 1.5MB。访客第一眼看到的是官网，不该为此下载整个后台。
  // 带 hash 的访问（/#/login）由 public/landing-boot.js 转交主应用 ——
  // hash 不会发给服务器，只能在前端分流。
  app.get('/', (req, res) => {
    const host = String(req.headers.host || '').split(':')[0].toLowerCase()
    const file = ADMIN_HOSTS.has(host) ? 'index.html' : 'landing.html'
    res.sendFile(path.join(dist, file))
  })
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
