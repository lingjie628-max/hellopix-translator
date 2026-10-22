'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  RedisSessionStore,
  RedisFixedWindowStore,
  RedisVerificationStore,
  RedisTranslationCache,
  createMemoryStores
} = require('../server/redis-security')
const { key } = require('../server/stores/redis-client')

class FakeRedis {
  constructor() {
    this.values = new Map()
    this.sets = new Map()
    this.expires = new Map()
  }

  _expire(key) {
    if (this.expires.has(key) && this.expires.get(key) <= Date.now()) {
      this.values.delete(key)
      this.sets.delete(key)
      this.expires.delete(key)
    }
  }

  async get(key) {
    this._expire(key)
    return this.values.has(key) ? this.values.get(key) : null
  }

  async set(key, value, options) {
    this._expire(key)
    if (options && options.NX && this.values.has(key)) return null
    this.values.set(key, String(value))
    if (options && options.PX) this.expires.set(key, Date.now() + Number(options.PX))
    return 'OK'
  }

  async del(input) {
    const keys = Array.isArray(input) ? input : Array.from(arguments)
    let count = 0
    for (const key of keys) {
      count += this.values.delete(key) || this.sets.delete(key) ? 1 : 0
      this.expires.delete(key)
    }
    return count
  }

  async eval(script, options) {
    const keys = options.keys
    const args = options.arguments
    if (script.includes('pix:put-session')) {
      await this.set(keys[0], args[0], { PX: Number(args[1]) })
      if (!this.sets.has(keys[1])) this.sets.set(keys[1], new Set())
      this.sets.get(keys[1]).add(keys[0])
      this.expires.set(keys[1], Date.now() + Number(args[1]))
      return 1
    }
    if (script.includes('pix:delete-session')) {
      await this.del(keys[0])
      if (args[0] && this.sets.has(keys[1])) this.sets.get(keys[1]).delete(keys[0])
      return 1
    }
    if (script.includes('pix:revoke-subject')) {
      this._expire(keys[0])
      const members = Array.from(this.sets.get(keys[0]) || [])
      await this.del(members)
      await this.del(keys[0])
      return members.length
    }
    if (script.includes('pix:fixed-window')) {
      this._expire(keys[0])
      const count = Number(this.values.get(keys[0]) || 0) + 1
      this.values.set(keys[0], String(count))
      if (count === 1) this.expires.set(keys[0], Date.now() + Number(args[0]))
      return [count, this.expires.get(keys[0]) - Date.now()]
    }
    if (script.includes('pix:verify-code')) {
      const raw = await this.get(keys[0])
      if (!raw) return 0
      const matched = JSON.parse(raw).codeHash === args[0]
      if (args[1] === '1' || !matched) await this.del(keys[0])
      return matched ? 1 : -1
    }
    if (script.includes('pix:reserve-send')) {
      this._expire(keys[0])
      if (this.values.has(keys[0])) return [0, this.expires.get(keys[0]) - Date.now()]
      await this.set(keys[0], '1', { PX: Number(args[0]), NX: true })
      return [1, Number(args[0])]
    }
    throw new Error('Unknown script')
  }
}

test('Redis session JSON has TTL, subject index, and revoke', async () => {
  const redis = new FakeRedis()
  const store = new RedisSessionStore(redis, { ttlMs: 1000 })
  await store.set('token-a', { type: 'user', subjectId: 7, csrf: 'csrf' })
  await store.set('token-b', { type: 'user', subjectId: 7, csrf: 'csrf' })
  assert.equal((await store.get('token-a', 'user')).subjectId, '7')
  assert.equal(await store.revokeSubject('user', 7), 2)
  assert.equal(await store.get('token-a', 'user'), null)
  assert.ok(Array.from(redis.values.keys()).every(value => value.startsWith('pix:')))
})

test('Redis fixed-window limiter increments atomically', async () => {
  const store = new RedisFixedWindowStore(new FakeRedis(), { windowMs: 1000, max: 2 })
  assert.equal((await store.consume('ip:1')).allowed, true)
  assert.equal((await store.consume('ip:1')).remaining, 0)
  const blocked = await store.consume('ip:1')
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.count, 3)
  assert.ok(blocked.retryAfterMs > 0)
})

test('Redis verification store hashes and consumes captcha codes', async () => {
  const redis = new FakeRedis()
  const store = new RedisVerificationStore(redis)
  await store.setCaptcha('image-1', 'AbC9')
  // 用 key() 构造键名，别写死 'pix:captcha:...'：
  // 前缀的唯一来源是 REDIS_KEY_PREFIX，测试不该复制一份字面量。
  const raw = await redis.get(key('captcha', 'image-1'))
  assert.ok(raw, '验证码应已写入 Redis')
  assert.equal(raw.includes('abc9'), false)
  assert.equal((await store.verifyCaptcha('image-1', 'abc9', true)).ok, true)
  assert.equal((await store.verifyCaptcha('image-1', 'abc9', true)).missing, true)
})

test('email resend reservation and code scene are isolated', async () => {
  const store = new RedisVerificationStore(new FakeRedis(), { resendTtlMs: 1000 })
  assert.equal((await store.reserveEmailSend('USER@example.com')).allowed, true)
  assert.equal((await store.reserveEmailSend('user@example.com')).allowed, false)
  await store.setEmailCode('user@example.com', '123456', 'register')
  assert.equal((await store.verifyEmailCode('user@example.com', '123456', 'forgot')).ok, false)
  assert.equal((await store.verifyEmailCode('user@example.com', '123456', 'register', true)).ok, true)
})

test('translation cache is tenant scoped', async () => {
  const store = new RedisTranslationCache(new FakeRedis())
  const request = { engine: 'deepseek', from: 'en', to: 'zh', text: 'hello' }
  await store.set('tenant-a', request, '你好')
  assert.equal(await store.get('tenant-a', request), '你好')
  assert.equal(await store.get('tenant-b', request), null)
})

test('memory stores expose the same asynchronous interfaces', async () => {
  const stores = createMemoryStores({ rateLimits: { max: 1 } })
  await stores.sessions.create('token', { type: 'admin', subjectId: 1 })
  assert.equal((await stores.sessions.resolve('token', 'admin')).subjectId, '1')
  assert.equal((await stores.rateLimits.increment('admin')).allowed, true)
  assert.equal((await stores.rateLimits.increment('admin')).allowed, false)
})
