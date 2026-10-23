'use strict'

/**
 * 注册链路 · 用户枚举防护
 *
 * ## 漏洞
 *
 * `AccountService.register` 原来的顺序是**先查重、后验邮箱码**：
 *
 *     if (await userByUsername(username)) throw 409 USERNAME_TAKEN
 *     if (await userByEmail(email))        throw 409 EMAIL_TAKEN
 *     const check = await verification.verify(email, 'register', code)   // 在后
 *
 * 也就是说，**不需要邮箱验证码**，只要提交一个图形验证码，就能通过 409 的
 * 错误码差异判断某账号/邮箱是否注册过：
 *
 *     POST /user/register {userName:'ceo', imageId, imageCode, code:''}
 *       → 409 USERNAME_TAKEN   该账号存在
 *       → 400 CODE_EXPIRED     该账号不存在（流程走到验码才失败）
 *
 * 图形验证码一次一换，但 OCR 打码平台一次几毛钱，批量跑常见用户名就能
 * 拿到全站商户清单；再和 /user/forgot 拼出「账号 ↔ 邮箱」映射。
 * 单看是低危信息泄露，组合起来就是定向钓鱼/撞库的完整前置情报。
 *
 * ## 修复后的契约（本文件锁死）
 *
 * 1. 验证码不正确时，无论账号是否存在，**一律**返回验证码错误 ——
 *    攻击者拿不到任何"存在与否"的信号
 * 2. 只有验证码**正确**（= 真的掌握该邮箱）才可能看到 409
 * 3. 验证码校验失败不消耗验证码，用户换张图形码即可重提，不用重收邮件
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { RedisVerificationStore } = require('../server/stores/verification-store')
const { AccountService } = require('../server/services/account-service')
const { VerificationService } = require('../server/services/verification-service')
const { key } = require('../server/stores/redis-client')

// ---------------------------------------------------------------- 假 Redis
//
// 形状对齐 ioredis（status / options / pipeline + 位置参数），
// 让 redis-client 走与生产一致的"位置参数"分支。
class FakeRedis {
  constructor () {
    this.status = 'ready'
    this.options = { keyPrefix: '' }
    this.values = new Map()
    this.expires = new Map()
  }

  async get (k) { return this.values.has(k) ? this.values.get(k) : null }
  async set (k, v, ...args) {
    this.values.set(k, String(v))
    this._expire(k, args)
    return 'OK'
  }
  async del (...keys) {
    let n = 0
    for (const k of keys.flat()) { if (this.values.delete(k)) n++ }
    return n
  }
  async incr (k) {
    const v = Number(this.values.get(k) || 0) + 1
    this.values.set(k, String(v))
    return v
  }
  async expire (k, s) { this.expires.set(k, Date.now() + s * 1000); return 1 }
  async pttl (k) {
    if (!this.values.has(k)) return -2
    const at = this.expires.get(k) || 0
    return at === undefined ? -1 : at - Date.now()
  }
  pipeline () {
    const ops = []
    const p = {
      get: k => { ops.push(['get', k]); return p },
      set: (k, v, ...a) => { ops.push(['set', k, v, a]); return p },
      del: (...k) => { ops.push(['del', ...k]); return p },
      exec: async () => Promise.all(ops.map(([op, ...a]) => this[op](...a).then(r => [null, r])))
    }
    return p
  }
  _expire (k, args) {
    const list = args.flat()
    const i = list.indexOf('PX')
    if (i >= 0) this.expires.set(k, Date.now() + Number(list[i + 1]))
    const j = list.indexOf('EX')
    if (j >= 0) this.expires.set(k, Date.now() + Number(list[j + 1]) * 1000)
  }
  async eval (script, numkeys, ...rest) {
    // redis-client 有两种调用形态：位置参数与对象参数（{keys, arguments}）。
    // 生产会在 ioredis 版本不同时二选一，测试必须两种都认，
    // 否则"测试走位置参数、生产走对象参数"就是假绿灯。
    let keys, args
    if (numkeys && typeof numkeys === 'object') {
      keys = numkeys.keys || []
      args = (numkeys.arguments || []).map(String)
    } else {
      keys = rest.slice(0, numkeys)
      args = rest.slice(numkeys).map(String)
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
      await this.set(keys[0], '1', 'PX', Number(args[0]))
      return [1, Number(args[0])]
    }
    throw new Error(`Unknown script: ${script.slice(0, 40)}`)
  }
}

const EMAIL_EXISTING = 'ceo@bigcorp.com'
const EMAIL_NEW = 'fresh@nowhere.com'

function makeHarness () {
  const settings = { 'site.name': 'Hello Pix', 'registration.trial_chars': 0 }
  const users = new Map()
  // 预置一个已存在的账号，用于"存在 vs 不存在"的对比
  users.set('ceo', { id: 1, username: 'ceo', email: EMAIL_EXISTING })

  const repo = {
    settings: async () => settings,
    setting: async k => settings[k],
    userByUsername: async name => users.get(String(name).toLowerCase()) || null,
    userByEmail: async email => Array.from(users.values()).find(u => u.email === email) || null,
    createUser: async data => {
      const id = users.size + 1
      users.set(String(data.username).toLowerCase(), Object.assign({ id }, data))
      return { id }
    },
    query: async () => ({ rows: [] })
  }
  const redis = new FakeRedis()
  const svc = new AccountService(repo, {}, redis)
  svc.mailer = {
    configured: async () => true,
    send: async () => {},
    verificationMail: (code, scene, siteName) => ({ subject: `${siteName} ${scene} ${code}`, html: '<p>x</p>' })
  }
  return { svc, redis, users }
}

/** 造一张**必定失效/必错**的图形验证码。 */
async function issueBadCaptcha (redis) {
  const id = `img_${Math.random().toString(36).slice(2)}`
  // 用生产存储格式写入，但给一个不可能的码
  const { RedisVerificationStore } = require('../server/stores/verification-store')
  await new RedisVerificationStore(redis).setCaptcha(id, 'ZZZZ', 600000)
  return { imageId: id, imageCode: 'AAAA' }
}

/** 造一张**可正常通过**的图形验证码。 */
async function issueGoodCaptcha (redis) {
  const id = `img_${Math.random().toString(36).slice(2)}`
  const { RedisVerificationStore } = require('../server/stores/verification-store')
  await new RedisVerificationStore(redis).setCaptcha(id, 'ABCD', 600000)
  return { imageId: id, imageCode: 'ABCD' }
}

function basePayload (overrides) {
  return Object.assign({
    userName: 'someone_new',
    email: EMAIL_NEW,
    passWord: 'Str0ngPass!23',
    passWord1: 'Str0ngPass!23',
    code: '',
    imageCode: 'abcd',
    imageId: 'img_x'
  }, overrides)
}

/** 抽出错误里的安全判别信息。 */
function signature (error) {
  return `${error && error.status}|${error && error.code}`
}

test('枚举防护：账号存在 + 验证码错，不能和「账号不存在 + 验证码错」有任何区别', async () => {
  const { svc, redis } = makeHarness()

  // 攻击者场景：不知道邮箱码，只想探"ceo 这个账号在不在"
  const captchaA = await issueBadCaptcha(redis)
  const existed = await svc.register(basePayload({
    userName: 'ceo', email: EMAIL_EXISTING, code: '000000', ...captchaA
  })).then(() => null, e => e)

  const captchaB = await issueBadCaptcha(redis)
  const missing = await svc.register(basePayload({
    userName: 'definitely_not_here', email: EMAIL_NEW, code: '000000', ...captchaB
  })).then(() => null, e => e)

  assert.ok(existed, '该被拒')
  assert.ok(missing, '该被拒')
  assert.notEqual(signature(existed), 'null|null')
  // 两个响应必须完全一致，否则就是可探测信号
  assert.equal(signature(existed), signature(missing),
    `存在与不存在必须给出相同响应，实际：存在=${signature(existed)} 不存在=${signature(missing)}`)
  assert.equal(existed.message, missing.message)
})

test('枚举防护：邮箱已注册也不能在验码前泄露', async () => {
  const { svc, redis } = makeHarness()
  const cap = await issueBadCaptcha(redis)
  const error = await svc.register(basePayload({
    userName: 'brand_new_name',
    email: EMAIL_EXISTING,
    code: '000000',
    ...cap
  })).then(() => null, e => e)

  assert.ok(error, '应被拒')
  assert.notEqual(error.code, 'EMAIL_TAKEN', '没有验证码时不能告诉他邮箱已注册')
})

test('枚举防护：验证码正确后才允许出现 409（此时他确实掌握该邮箱）', async () => {
  const { svc, redis } = makeHarness()

  // 正常注册流程：发码 → 收码
  await svc.sendEmailCode({ email: EMAIL_NEW, scene: 'register' }, { ip: '1.1.1.1' })
  const saved = await redis.get(new VerificationService(null).key('code', 'register', EMAIL_NEW))
  assert.ok(saved, '验证码应已落 Redis')
  const realCode = saved

  const cap = await issueGoodCaptcha(redis)
  const error = await svc.register(basePayload({
    userName: 'ceo', email: EMAIL_NEW, code: realCode, ...cap
  })).then(() => null, e => e)

  // 账号名 ceo 已被占用 —— 验码通过后才该报重名
  assert.ok(error)
  assert.equal(error.code, 'USERNAME_TAKEN')
})

test('枚举防护：正常新账号仍然能注册成功（不能修过头）', async () => {
  const { svc, redis, users } = makeHarness()
  await svc.sendEmailCode({ email: EMAIL_NEW, scene: 'register' }, { ip: '1.1.1.1' })
  const saved = await redis.get(new VerificationService(null).key('code', 'register', EMAIL_NEW))
  const realCode = saved

  const cap = await issueGoodCaptcha(redis)
  const result = await svc.register(basePayload({
    userName: 'brand_new_name', email: EMAIL_NEW, code: realCode, ...cap
  }))
  assert.equal(result.ok, true)
  assert.ok(users.get('brand_new_name'))
})

test('枚举防护：验证码填错不消耗验证码，用户换图形码即可重提', async () => {
  const { svc, redis } = makeHarness()
  await svc.sendEmailCode({ email: EMAIL_NEW, scene: 'register' }, { ip: '1.1.1.1' })
  const codeKey = new VerificationService(null).key('code', 'register', EMAIL_NEW)
  const saved = await redis.get(codeKey)
  const realCode = saved

  // 第一次填错
  const cap1 = await issueBadCaptcha(redis)
  await svc.register(basePayload({ userName: 'newbie_one', email: EMAIL_NEW, code: '999999', ...cap1 }))
    .then(() => null, e => e)

  // 邮箱验证码必须还在（否则用户得重新收信）
  assert.ok(await redis.get(codeKey), '验证码填错后不应被销毁')

  // 第二次填对就能成功
  const cap2 = await issueGoodCaptcha(redis)
  const result = await svc.register(basePayload({ userName: 'newbie_one', email: EMAIL_NEW, code: realCode, ...cap2 }))
  assert.equal(result.ok, true)
})

test('枚举防护：顺序断言 —— 源码里 verify 必须在查重之前', () => {
  // 行为测试已经覆盖，但加一条源码顺序断言：将来谁把查重挪回去，
  // 即使行为测试被改松，这条也会立刻红。
  const fs = require('node:fs')
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'account-service.js'), 'utf8')
  const start = src.indexOf('async register(')
  const end = src.indexOf('async forgot(')
  assert.ok(start > 0 && end > start)
  const body = src.slice(start, end)
  const verifyAt = body.indexOf('verification.verify(')
  const takenAt = body.indexOf("'USERNAME_TAKEN'")
  assert.ok(verifyAt > 0, 'register 里应调用 verification.verify')
  assert.ok(takenAt > 0, 'register 里应有 USERNAME_TAKEN 判定')
  assert.ok(verifyAt < takenAt, '验码必须在查重之前，否则又成了用户枚举接口')
})
