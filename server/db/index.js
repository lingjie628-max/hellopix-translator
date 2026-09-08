const postgres = require('./postgres')
const redis = require('./redis')

async function checkDependencies() {
  const [postgresOk, redisOk] = await Promise.all([
    postgres.checkPostgres(),
    redis.checkRedis()
  ])
  return { postgres: postgresOk, redis: redisOk }
}

async function closeDependencies() {
  await Promise.allSettled([
    postgres.closePostgres(),
    redis.closeRedis()
  ])
}

module.exports = {
  ...postgres,
  ...redis,
  checkDependencies,
  closeDependencies
}
