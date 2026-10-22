const Redis = require('ioredis')
const config = require('../config')

let client

function createRedisClient() {
  const redis = new Redis(config.redis.url, {
    lazyConnect: true,
    enableReadyCheck: true,
    // ⚠️ **不要**再把 `config.redis.keyPrefix` 传给 ioredis。
    //
    // `server/stores/redis-client.js` 的 `key()` 已经在拼完整键名前缀，
    // 两边都加就成了 `pix:pix:...`（线上曾因此堆积 4600+ 个双前缀键）。
    // 前缀唯一来源：`REDIS_KEY_PREFIX`，由 redis-client.js 负责拼接。
    connectTimeout: config.redis.connectTimeout,
    commandTimeout: config.redis.commandTimeout,
    maxRetriesPerRequest: config.redis.maxRetriesPerRequest,
    retryStrategy(times) {
      return Math.min(times * 100, 2_000)
    }
  })

  redis.on('error', error => {
    console.error('Redis connection error:', error.message)
  })
  return redis
}

function getRedis() {
  if (!client) client = createRedisClient()
  return client
}

async function connectRedis() {
  const redis = getRedis()
  if (redis.status === 'wait' || redis.status === 'end') await redis.connect()
  return redis
}

async function checkRedis() {
  const redis = await connectRedis()
  return (await redis.ping()) === 'PONG'
}

async function closeRedis() {
  if (!client) return
  const redis = client
  client = undefined
  if (redis.status === 'ready' || redis.status === 'connecting' || redis.status === 'connect') {
    await redis.quit()
  } else {
    redis.disconnect()
  }
}

module.exports = {
  getRedis,
  connectRedis,
  checkRedis,
  closeRedis
}
