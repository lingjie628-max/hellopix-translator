const fs = require('fs')

const production = process.env.NODE_ENV === 'production'
const forbiddenProductionFlags = [
  'PIX_ENABLE_DEMO_DATA',
  'PIX_ENABLE_DEMO_PAYMENT',
  'PIX_ALLOW_PUBLIC_TRANSLATION'
]

if (production) {
  const enabled = forbiddenProductionFlags.filter(name => /^(1|true|yes)$/i.test(String(process.env[name] || '')))
  if (enabled.length) throw new Error(`Production forbids demo flags: ${enabled.join(', ')}`)
}

function required(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function integer(name, fallback, minimum, maximum) {
  const raw = process.env[name]
  const value = raw == null || raw === '' ? fallback : Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function parseUrl(name, value, protocols) {
  let parsed
  try {
    parsed = new URL(value)
  } catch (_error) {
    throw new Error(`${name} must be a valid URL`)
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} must use ${protocols.join(' or ')}`)
  }
  return parsed
}

function isLoopback(hostname) {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname)
}

function isPlaceholder(value) {
  return /^(change[-_]?me|replace[-_]?me|example|password)$/i.test(decodeURIComponent(value || ''))
}

const databaseUrl = production
  ? required('DATABASE_URL')
  : String(process.env.DATABASE_URL || 'postgres://hello_pix:hello_pix@127.0.0.1:5432/hello_pix')
const redisUrl = production
  ? required('REDIS_URL')
  : String(process.env.REDIS_URL || 'redis://:hello_pix@127.0.0.1:6379/0')

const parsedDatabaseUrl = parseUrl('DATABASE_URL', databaseUrl, ['postgres:', 'postgresql:'])
const parsedRedisUrl = parseUrl('REDIS_URL', redisUrl, ['redis:', 'rediss:'])

if (production && (!parsedDatabaseUrl.username || !parsedDatabaseUrl.password)) {
  throw new Error('DATABASE_URL must include non-empty credentials in production')
}
if (production && !parsedRedisUrl.password) {
  throw new Error('REDIS_URL must include a password in production')
}
if (production && (isPlaceholder(parsedDatabaseUrl.password) || isPlaceholder(parsedRedisUrl.password))) {
  throw new Error('Production database credentials must not use example placeholders')
}

const databaseSslMode = String(process.env.DATABASE_SSL_MODE || (isLoopback(parsedDatabaseUrl.hostname) ? 'disable' : 'verify-full'))
const validSslModes = new Set(['disable', 'require', 'verify-ca', 'verify-full'])
if (!validSslModes.has(databaseSslMode)) {
  throw new Error('DATABASE_SSL_MODE must be disable, require, verify-ca, or verify-full')
}
if (production && !isLoopback(parsedDatabaseUrl.hostname) && databaseSslMode !== 'verify-full') {
  throw new Error('Remote production PostgreSQL connections require DATABASE_SSL_MODE=verify-full')
}
if (production && !isLoopback(parsedRedisUrl.hostname) && parsedRedisUrl.protocol !== 'rediss:') {
  throw new Error('Remote production Redis connections require rediss://')
}

function databaseSsl() {
  if (databaseSslMode === 'disable') return false
  if (databaseSslMode === 'require') return { rejectUnauthorized: false }

  const caFile = required('DATABASE_SSL_CA_FILE')
  return {
    ca: fs.readFileSync(caFile, 'utf8'),
    rejectUnauthorized: true
  }
}

module.exports = Object.freeze({
  env: process.env.NODE_ENV || 'development',
  production,
  database: Object.freeze({
    connectionString: databaseUrl,
    ssl: databaseSsl(),
    max: integer('DATABASE_POOL_MAX', 10, 1, 100),
    idleTimeoutMillis: integer('DATABASE_IDLE_TIMEOUT_MS', 30_000, 1_000, 600_000),
    connectionTimeoutMillis: integer('DATABASE_CONNECT_TIMEOUT_MS', 5_000, 500, 60_000),
    statementTimeout: integer('DATABASE_STATEMENT_TIMEOUT_MS', 15_000, 1_000, 300_000),
    applicationName: String(process.env.DATABASE_APPLICATION_NAME || 'hello-pix')
  }),
  redis: Object.freeze({
    url: redisUrl,
    keyPrefix: String(process.env.REDIS_KEY_PREFIX || ''),
    connectTimeout: integer('REDIS_CONNECT_TIMEOUT_MS', 5_000, 500, 60_000),
    commandTimeout: integer('REDIS_COMMAND_TIMEOUT_MS', 5_000, 500, 60_000),
    maxRetriesPerRequest: integer('REDIS_MAX_RETRIES', 2, 0, 10)
  }),
  /**
   * 链监听与自动结算（RC-02 Phase 2）。
   *
   * `autoSettlementEnabled` **默认 false** —— 默认走 Shadow/Dry-run：
   * 照常查链、落库、推进游标、匹配订单，但绝不改余额、绝不改订单状态，
   * 只记录"如果开启本来会做什么"。先证明看得准，再允许动钱。
   *
   * 打开它需要显式设置 AUTO_SETTLEMENT_ENABLED=true。
   * 用 `=== 'true'` 而不是布尔转换：写成 =1 或 =yes 这类"看着像真"的值
   * 不会意外开启资金路径。
   */
  chain: Object.freeze({
    provider: String(process.env.TRON_PROVIDER || 'trongrid'),
    trongridApiKey: String(process.env.TRONGRID_API_KEY || ''),
    baseUrl: String(process.env.TRONGRID_BASE_URL || ''),
    timeoutMs: integer('TRON_API_TIMEOUT_MS', 15_000, 1_000, 120_000),
    autoSettlementEnabled: String(process.env.AUTO_SETTLEMENT_ENABLED || '') === 'true',
    maxTransfersPerScan: integer('TRON_MAX_TRANSFERS_PER_SCAN', 500, 1, 5_000),
    backoffBaseMs: integer('TRON_BACKOFF_BASE_MS', 30_000, 1_000, 3_600_000)
  })
})
