'use strict'

const PREFIX = 'pix:'

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.ceil(number) : fallback
}

function segment(value) {
  return encodeURIComponent(String(value == null ? '' : value))
}

function key(namespace, ...parts) {
  return PREFIX + namespace + (parts.length ? ':' + parts.map(segment).join(':') : '')
}

function usesPositionalArguments(redis) {
  return !!(redis &&
    typeof redis.status === 'string' &&
    redis.options &&
    typeof redis.pipeline === 'function')
}

async function setJson(redis, redisKey, value, ttlMs) {
  const payload = JSON.stringify(value)
  const ttl = positiveInteger(ttlMs, 1)
  if (usesPositionalArguments(redis)) {
    return redis.set(redisKey, payload, 'PX', ttl)
  }
  try {
    return await redis.set(redisKey, payload, { PX: ttl })
  } catch (error) {
    // ioredis uses positional SET arguments; node-redis uses an options object.
    if (!/argument|syntax|option/i.test(String(error && error.message))) throw error
    return redis.set(redisKey, payload, 'PX', ttl)
  }
}

async function del(redis, ...keys) {
  if (!keys.length) return 0
  try {
    return await redis.del(keys)
  } catch (error) {
    return redis.del(...keys)
  }
}

async function evalScript(redis, script, keys, args) {
  if (usesPositionalArguments(redis)) {
    return redis.eval(script, keys.length, ...keys, ...args.map(String))
  }
  try {
    return await redis.eval(script, {
      keys,
      arguments: args.map(String)
    })
  } catch (error) {
    if (!/argument|syntax|option|number of keys/i.test(String(error && error.message))) throw error
    return redis.eval(script, keys.length, ...keys, ...args.map(String))
  }
}

async function getJson(redis, redisKey) {
  const raw = await redis.get(redisKey)
  if (raw == null) return null
  try {
    return JSON.parse(raw)
  } catch (error) {
    await del(redis, redisKey)
    return null
  }
}

module.exports = {
  PREFIX,
  positiveInteger,
  segment,
  key,
  usesPositionalArguments,
  setJson,
  getJson,
  del,
  evalScript
}
