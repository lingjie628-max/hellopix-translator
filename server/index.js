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
  '004_client_releases_draft_url',
  '054_count_tickets',
  '055_count_ticket_integrity',
  '056_count_ticket_dedup_scope',
  '057_count_ticket_groups_base'
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
  /**
   * 机房失联时的应急公告页（PIX_MAINTENANCE=1 开启，默认关闭）。
   *
   * 场景：生产机整段网络不可达，临时用别处机器顶班。此时这个实例里没有真实
   * 用户数据，直接放行登录只会让用户看到"账号不存在/密码错误"——比打不开更糟，
   * 用户会以为账号被删了。所以整站先回公告页。
   *
   * ★ 必须注册在 api.register 之前 ★：express 按注册顺序匹配，装在后面对
   * /apis/* 完全无效（实测漏了登录接口）。也不能依赖后面的 app.get('/')。
   *
   * 放行静态产物是有意的：浏览器会预取这些文件，全拦掉会让公告页自己白屏。
   * /health 必须始终可达，否则外部监控会把"正在顶班"误判成"彻底挂了"。
   *
   * 开关而不是改代码，是为了机房恢复后不用重新发版：删掉环境变量重启即可。
   */
  if (envFlag(process.env.PIX_MAINTENANCE)) {
    const maintenanceFile = path.join(__dirname, '..', 'dist', 'maintenance.html')
    // 域名映射到本地但 Host 千奇百怪，这里不看 Host，一律拦。
    // 判断方式与下方 express.static 的产物类型保持一致。
    const STATIC_ASSET = /\.(?:js|css|png|jpe?g|svg|ico|woff2?|ttf|otf|map)$/i
    app.use((req, res, next) => {
      if (!['GET', 'HEAD'].includes(req.method)) return next()
      if (req.path === '/health') return next()
      if (STATIC_ASSET.test(req.path)) return next()
      // 不缓存：恢复后用户刷新就该看到正常页面，不能被 503 卡在浏览器里
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
      res.setHeader('Retry-After', '3600')
      // 503 而非 200：搜索引擎会因此暂时摘除页面，而不是把公告页当成官网收录
      res.status(503).sendFile(maintenanceFile)
    })
  }
  // 业务请求不需要压缩体；显式关闭 inflation，既减少攻击面，也避免
  // body-parser 的压缩流处理成为未授权请求的入口。
  app.use(express.urlencoded({ extended: false, limit: '256kb', inflate: false }))
  app.use(express.json({ limit: '256kb', inflate: false }))

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
  /**
   * Readiness must include the dependencies that request handling actually
   * needs. `/health` stays a cheap liveness probe; monitoring must use this
   * endpoint so a running Node process cannot mask a dead database/Redis.
   */
  app.get('/ready', async (req, res) => {
    if (!persistent) {
      return res.json({ ok: true, service: 'hello-pix', backend: 'mock' })
    }
    try {
      const dependencies = await db.checkDependencies()
      await checkMigrationVersion(db.query)
      if (!dependencies.postgres || !dependencies.redis) {
        return res.status(503).json({
          ok: false,
          service: 'hello-pix',
          backend: 'persistent',
          postgres: !!dependencies.postgres,
          redis: !!dependencies.redis,
          msg: '依赖服务未就绪'
        })
      }
      return res.json({ ok: true, service: 'hello-pix', backend: 'persistent', postgres: true, redis: true })
    } catch (error) {
      console.error('[ready] dependency check failed:', error && error.message ? error.message : error)
      return res.status(503).json({
        ok: false,
        service: 'hello-pix',
        backend: 'persistent',
        msg: '依赖服务未就绪'
      })
    }
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
    /**
     * body 超限必须回 413，不能落进下面那句「服务器内部错误」。
     *
     * express.json 的 PayloadTooLargeError 带 `type: 'entity.too.large'`
     * 与 `status: 413`；原先没识别它，于是**任何超限请求都回 500**。
     * 后果是客户端分不清"我把图发太大了"和"服务挂了" —— 前者用户该换张小图，
     * 后者用户该稍后重试，提示反了只会让他反复点。
     *
     * 图片翻译尤其需要这条：16MB 上限是它唯一会撞到的边界。
     */
    if (err && (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413)) {
      // 不打印 stack —— 这是客户端问题不是服务故障，打出来只会淹没真错误
      if (!res.headersSent) {
        res.status(413).json({ success: false, code: 'PAYLOAD_TOO_LARGE', msg: '内容太大，请换小一点的图片' })
      }
      return
    }
    if (err && (err.type === 'encoding.unsupported' || err.status === 415 || err.statusCode === 415)) {
      if (!res.headersSent) {
        res.status(415).json({ success: false, code: 'UNSUPPORTED_CONTENT_ENCODING', msg: '不支持压缩请求体' })
      }
      return
    }
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
