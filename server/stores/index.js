'use strict'

const { RedisSessionStore } = require('./session-store')
const { RedisFixedWindowStore } = require('./rate-limit-store')
const { RedisVerificationStore } = require('./verification-store')
const { RedisTranslationCache } = require('./translation-cache')
const memory = require('./memory')

function createRedisStores(redis, options) {
  const opts = options || {}
  return {
    sessions: new RedisSessionStore(redis, opts.sessions),
    rateLimits: new RedisFixedWindowStore(redis, opts.rateLimits),
    verification: new RedisVerificationStore(redis, opts.verification),
    translations: new RedisTranslationCache(redis, opts.translations)
  }
}

function createMemoryStores(options) {
  const opts = options || {}
  return {
    sessions: new memory.MemorySessionStore(opts.sessions),
    rateLimits: new memory.MemoryFixedWindowStore(opts.rateLimits),
    verification: new memory.MemoryVerificationStore(opts.verification),
    translations: new memory.MemoryTranslationCache(opts.translations)
  }
}

module.exports = Object.assign({
  RedisSessionStore,
  RedisFixedWindowStore,
  RedisVerificationStore,
  RedisTranslationCache,
  createRedisStores,
  createMemoryStores
}, memory)
