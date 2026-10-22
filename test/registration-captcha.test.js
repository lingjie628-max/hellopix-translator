'use strict'

/**
 * 注册链路 · 图形验证码守卫（V1.0.1 Hotfix）
 *
 * ## 修的是什么
 *
 * 生产现象：注册页图形验证码显示正常，用户填完后点「获取验证码」，
 * 立刻提示「图形验证码已过期，请刷新」，永远收不到邮箱验证码 —— 无法注册。
 *
 * 生产复现（真 Redis）证明：
 *   · 签发：key = `pix:captcha:img_xxx`，exists=1，PTTL=299998ms —— Redis/TTL 全部正常
 *   · 前端「获取验证码」的真实载荷是 `{ email, scene }` —— **没带 imageId / imageCode**
 *   · 后端据此用 undefined 拼出 key `pix:captcha:`（空的一段），Redis 里当然没有
 *   · 于是被判成 missing → 返回「图形验证码已过期，请刷新」
 *
 * 也就是说：验证码根本没过期，是前端从没把它提交上来；那句话在说谎。
 * 对照组（带上 imageId、码故意填错）返回的是「图形验证码错误」，
 * 证明只要 imageId 到位，key 就能找到、链路就通。
 *
 * ## 这一组测试锁什么
 *
 * 1. lib/captcha 的返回契约：EXPIRED 与 INVALID 必须可区分
 * 2. TTL 由服务端唯一控制（10 分钟）且真的写进了 Redis
 * 3. **取邮箱验证码不再需要图形验证码**（见下），但发信仍受频率/配额限制
 * 4. 注册 / 找回的**提交**仍然需要图形验证码，且一次性、失败后要换图
 * 5. 旧 captcha 一次性，不能重复使用
 * 6. 前端取码时不再要求填图形验证码，提交时仍把它带上
 *
 * ## 后续变更：取邮箱验证码去掉了图形验证码（2026-10-11）
 *
 * 上面那次 hotfix 修的是"前端没把 imageId 传上去"，修法是**让前端必须传**。
 * 但真机使用后暴露了更根本的问题：注册页把图形验证码排在邮箱验证码**之后**，
 * 而绝大多数商户根本不知道要先填那一格 —— 他们点「获取验证码」，
 * 得到的永远是「图形验证码已过期」，于是注册卡死。
 *
 * 这一轮把它反过来：**发信不需要图形验证码**（防护交给 IP 限流 +
 * 按邮箱冷却/配额），图形验证码只在真正建号 / 改密时才要。
 * 所以 `sendEmailCode` 不再 consume captcha，
 * `register` / `forgot` 仍然 consume —— 后者是本文件第 4 条守的东西。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const captcha = require('../server/lib/captcha')
const { RedisVerificationStore } = require('../server/stores/verification-store')
const { AccountService } = require('../server/services/account-service')
const { VerificationService } = require('../server/services/verification-service')
const { key } = require('../server/stores/redis-client')

const root = path.join(__dirname, '..')

// ------------------------------------------------------------------ 测试用假 Redis
//
// 故意做成 ioredis 的形状（status / options / pipeline + 位置参数），
// 这样 redis-client 的 usesPositionalArguments 会走位置参数分支 ——
// 与生产完全一致，避免"测试走 A 分支、生产走 B 分支"的假绿灯。
class FakeRedis {
  constructor() {
    this.status = 'ready'
    this.options = {}
    this.values = new Map()
    this.expires = new Map()
  }

  pipeline() { return { exec: async () => [] } }

  _expire(key) {
    const at = this.expires.get(key)
    if (at !== undefined && at <= Date.now()) {
      this.values.delete(key)
      this.expires.delete(key)
    }
  }

  async get(key) {
    this._expire(key)
    return this.values.has(key) ? this.values.get(key) : null
  }

  async set(key, value, ...rest) {
    this._expire(key)
    this.values.set(key, String(value))
    if (rest.length === 2) {
      const unit = String(rest[0]).toUpperCase()
      const amount = Number(rest[1])
      this.expires.set(key, Date.now() + (unit === 'EX' ? amount * 1000 : amount))
    }
    return 'OK'
  }

  async del(...args) {
    const keys = Array.isArray(args[0]) ? args[0] : args
    let count = 0
    for (const key of keys) {
      if (this.values.delete(key)) count += 1
      this.expires.delete(key)
    }
    return count
  }

  async incr(key) {
    const next = Number(await this.get(key) || 0) + 1
    this.values.set(key, String(next))
    return next
  }

  async expire(key, seconds) {
    this.expires.set(key, Date.now() + Number(seconds) * 1000)
    return 1
  }

  async pttl(key) {
    this._expire(key)
    if (!this.values.has(key)) return -2
    const at = this.expires.get(key)
    return at === undefined ? -1 : at - Date.now()
  }

  async eval(script, numkeys, ...rest) {
    const keys = rest.slice(0, numkeys)
    const args = rest.slice(numkeys).map(String)
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

// ------------------------------------------------------------------ 测试用桩
function makeHarness() {
  const settings = { 'site.name': 'Hello Pix', 'registration.trial_chars': 0 }
  const users = new Map()
  const repo = {
    settings: async () => settings,
    setting: async key => settings[key],
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
  const sent = []
  svc.mailer = {
    configured: async () => true,
    send: async (to, subject) => { sent.push({ to, subject }) },
    verificationMail: (code, scene, siteName) => ({
      subject: `${siteName} ${scene} ${code}`, html: '<p>x</p>'
    })
  }
  return { repo, redis, svc, sent, users }
}

const EMAIL = 'merchant@example.com'
const CAPTCHA_KEY = id => key('captcha', id)
// 键名必须由业务自己算，测试不能复制一份前缀字面量。
// 前缀的唯一来源是 REDIS_KEY_PREFIX（见 stores/redis-client），
// 写死 `pix:verify:...` 会在前缀为空的环境里全部失配。
const CODE_KEY = (scene, email) => new VerificationService(null).key('code', scene, email)

/** 直接种一张已知答案的图形验证码（与 issue 走同一个 store，同一套哈希/键） */
async function seedCaptcha(redis, imageId, code, ttlMs) {
  await new RedisVerificationStore(redis).setCaptcha(imageId, code, ttlMs)
}

// ================================================================== 1. 契约
test('captcha.consume 能区分「过期」与「错误」—— 前端才能决定换图还是提示', async () => {
  const redis = new FakeRedis()
  await seedCaptcha(redis, 'img-ok', 'ABCD')

  const ok = await captcha.consume(redis, 'img-ok', 'abcd') // 大小写不敏感
  assert.equal(ok.ok, true)
  assert.equal(ok.code, '')

  await seedCaptcha(redis, 'img-bad', 'ABCD')
  const invalid = await captcha.consume(redis, 'img-bad', 'WXYZ')
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'CAPTCHA_INVALID')
  assert.equal(invalid.message, '图形验证码错误')

  // 历史缺陷的核心：前端没提交 imageId → 后端拿到 undefined
  const missing = await captcha.consume(redis, undefined, undefined)
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'CAPTCHA_EXPIRED')
})

test('没提交 imageId 时算出的就是空键 —— 这正是生产误报「已过期」的成因', async () => {
  const { key, PREFIX } = require('../server/stores/redis-client')
  assert.equal(key('captcha', undefined), `${PREFIX}captcha:`)
  assert.equal(key('captcha', null), `${PREFIX}captcha:`)
  assert.notEqual(key('captcha', undefined), key('captcha', 'img-1'))
})

test('过期的图形验证码返回 CAPTCHA_EXPIRED（真的等它过期，不是快进）', async () => {
  const redis = new FakeRedis()
  await seedCaptcha(redis, 'img-ttl', 'ABCD', 40)
  assert.equal((await captcha.consume(redis, 'img-ttl', 'abcd')).ok, true, '没过期时应通过')

  await seedCaptcha(redis, 'img-ttl2', 'ABCD', 40)
  await new Promise(resolve => setTimeout(resolve, 60))
  const expired = await captcha.consume(redis, 'img-ttl2', 'abcd')
  assert.equal(expired.ok, false)
  assert.equal(expired.code, 'CAPTCHA_EXPIRED')
})

test('图形验证码是一次性的：用过的 imageId 不能再用', async () => {
  const redis = new FakeRedis()
  await seedCaptcha(redis, 'img-once', 'ABCD')
  assert.equal((await captcha.consume(redis, 'img-once', 'abcd')).ok, true)
  const second = await captcha.consume(redis, 'img-once', 'abcd')
  assert.equal(second.ok, false)
  assert.equal(second.code, 'CAPTCHA_EXPIRED', '第二次必须已不存在')
})

test('码填错也会作废那张图（防同一 imageId 被暴力尝试）', async () => {
  const redis = new FakeRedis()
  await seedCaptcha(redis, 'img-brute', 'ABCD')
  assert.equal((await captcha.consume(redis, 'img-brute', 'ZZZZ')).code, 'CAPTCHA_INVALID')
  assert.equal(await redis.get(CAPTCHA_KEY('img-brute')), null)
})

// ================================================================== 2. TTL
test('TTL 由服务端唯一控制：10 分钟，且真的写进了 Redis', async () => {
  assert.equal(captcha.CAPTCHA_TTL_MS, 10 * 60_000, 'TTL 必须是 10 分钟')

  const redis = new FakeRedis()
  const issued = await captcha.issue(redis)
  const ttl = await redis.pttl(CAPTCHA_KEY(issued.imageId))
  assert.ok(ttl > 9 * 60_000 && ttl <= 10 * 60_000, `实际 TTL 应接近 10 分钟，实测 ${ttl}ms`)
})

test('issue 返回的是可用的 key 与 data:image/svg+xml 图片，且码已哈希', async () => {
  const redis = new FakeRedis()
  const issued = await captcha.issue(redis)
  assert.match(issued.imageId, /^img_[A-Za-z0-9_-]+$/)
  assert.ok(issued.image.startsWith('data:image/svg+xml;base64,'))
  const raw = await redis.get(CAPTCHA_KEY(issued.imageId))
  assert.ok(raw, '签发后 key 必须存在')
  assert.ok(raw.includes('codeHash'), '只存哈希，不存明文')
})

// ================================================================== 3. 发信链路
test('获取邮箱验证码不再需要图形验证码（本轮变更的核心）', async () => {
  const { svc, redis, sent } = makeHarness()

  // 不带 imageId / imageCode —— 之前这一步会被判 CAPTCHA_EXPIRED，
  // 用户永远收不到邮件，注册直接卡死。
  const result = await svc.sendEmailCode(
    { email: EMAIL, scene: 'register' },
    { ip: '1.2.3.4' }
  )

  assert.equal(result.ok, true, '不带图形验证码也必须能发信')
  assert.equal(sent.length, 1, '必须真的发了一封信')
  assert.match(String(await redis.get(CODE_KEY('register', EMAIL))), /^\d{6}$/, '邮箱验证码应已落库')
})

test('就算带了过期/错误的图形验证码，也不该拦住发信', async () => {
  for (const payload of [
    { imageId: undefined, imageCode: undefined },
    { imageId: 'img-gone', imageCode: 'ABCD' },
    { imageId: 'img-wrong', imageCode: 'ZZZZ' }
  ]) {
    const { svc, sent } = makeHarness()
    const result = await svc.sendEmailCode(
      Object.assign({ email: EMAIL, scene: 'register' }, payload),
      { ip: '1.2.3.4' }
    )
    assert.equal(result.ok, true, `载荷 ${JSON.stringify(payload)} 不应被图形验证码拦住`)
    assert.equal(sent.length, 1)
  }
})

test('发信仍受频率/配额限制 —— 图形验证码不是唯一防线', async () => {
  const { svc, sent } = makeHarness()

  const first = await svc.sendEmailCode({ email: EMAIL, scene: 'register' }, { ip: '1.2.3.4' })
  assert.equal(first.ok, true)

  // 同一邮箱立刻再来一次：60 秒冷却必须生效。
  // 去掉图形验证码之后，这道限流是防止"被当免费发信机"的关键兜底。
  await assert.rejects(
    svc.sendEmailCode({ email: EMAIL, scene: 'register' }, { ip: '1.2.3.4' }),
    error => error.code === 'TOO_FREQUENT',
    '去掉图形验证码之后，服务端自己的频率限制必须仍然拦得住重复发送'
  )
  assert.equal(sent.length, 1, '被限流的那次不得再发信')
})

test('注册本身仍然需要图形验证码（真实建号的口子不放开）', async () => {
  const { svc, users } = makeHarness()
  await assert.rejects(
    svc.register({
      userName: 'nocap', passWord: 'Abcd1234567', passWord1: 'Abcd1234567',
      email: EMAIL, code: '123456'
    }),
    error => error.code === 'CAPTCHA_EXPIRED'
  )
  assert.equal(users.size, 0, '没通过图形验证码时不得建号')
})

// ================================================================== 4. 完整链路
test('完整注册链：图形验证码 → 邮箱验证码 → 注册成功', async () => {
  const { svc, redis, sent, users } = makeHarness()

  // 1) 直接取邮箱验证码 —— 不再需要先过图形验证码
  await svc.sendEmailCode({ email: EMAIL, scene: 'register' }, { ip: '1.2.3.4' })
  assert.equal(sent.length, 1)

  // 2) 从库里取出真实下发的邮箱验证码（用户是从邮件里看到的）
  const mailCode = String(await redis.get(CODE_KEY('register', EMAIL)))
  assert.match(mailCode, /^\d{6}$/)

  // 3) 提交注册（注册本身也要一张新的图形验证码）
  await seedCaptcha(redis, 'img-chain2', 'WXYZ')
  const created = await svc.register({
    userName: 'merchant01',
    passWord: 'Abcd1234567',
    passWord1: 'Abcd1234567',
    email: EMAIL,
    code: mailCode,
    imageId: 'img-chain2',
    imageCode: 'wxyz'
  })

  assert.equal(created.ok, true)
  assert.ok(users.get('merchant01'), '用户必须真的被创建')
})

// ================================================================== 5. 前端守卫
test('注册/找回页取邮箱验证码时不再要求图形验证码', () => {
  for (const file of ['src/components/Register.vue', 'src/components/Forgot.vue']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')

    const at = source.indexOf('/user/emailCode')
    assert.ok(at > 0, `${file}: 找不到 /user/emailCode 调用`)
    const call = source.slice(at, at + 420)

    // 关键：发信请求里不再出现图形验证码
    assert.ok(!/imageCode/.test(call), `${file}: 发信请求不应再提交 imageCode`)
    assert.ok(!/imageId/.test(call), `${file}: 发信请求不应再提交 imageId`)
    assert.match(call, /silent:\s*true/, `${file}: 需要 silent 关掉全局提示，避免提示叠两条`)

    // getCode() 里不得再有"请输入图形验证码"这道前置校验 ——
    // 正是它让商户点「获取验证码」时收不到邮件
    const getAt = source.indexOf('getCode() {')
    const getCode = source.slice(getAt, getAt + 700)
    assert.ok(!/请输入图形验证码/.test(getCode),
      `${file}: getCode() 里仍要求先填图形验证码 —— 这正是商户收不到邮箱验证码的原因`)

    // 但**提交**仍必须把整份表单（含图形验证码）发给服务端：
    // 建号 / 改密是必须拦住的写操作，这道闸门不能一起放开
    const subAt = source.indexOf('submit() {')
    const submit = source.slice(subAt, subAt + 900)
    assert.match(submit, /postRequest\('\/user\/(register|forgot)',\s*this\.form\)/,
      `${file}: 提交时应把整份表单（含 imageId/imageCode）发给服务端`)

    // 一次性图形码：提交失败后必须换图并清空输入
    assert.match(submit, /this\.refreshImageCode\(\)/,
      `${file}: 提交失败后要换一张图形验证码（那个码已经用掉了）`)
  }
})

test('前端换图时图片与 imageId 同步更新，并清空输入框', () => {
  for (const file of ['src/components/Register.vue', 'src/components/Forgot.vue']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')

    const getImage = source.slice(source.indexOf('getImageCode() {'), source.indexOf('getImageCode() {') + 700)
    assert.match(getImage, /this\.codeImg\s*=\s*resp\.data\.image/, `${file}: 未更新图片`)
    assert.match(getImage, /this\.form\.imageId\s*=\s*resp\.data\.imageId/, `${file}: 未同步 imageId`)
    assert.match(getImage, /this\.form\.imageCode\s*=\s*''/, `${file}: 未清空图形验证码输入`)

    const refresh = source.slice(source.indexOf('refreshImageCode('), source.indexOf('refreshImageCode(') + 400)
    assert.match(refresh, /this\.form\.imageCode\s*=\s*''/, `${file}: 刷新时未清空输入`)
    assert.match(refresh, /this\.getImageCode\(\)/, `${file}: 刷新时未重新取图`)
  }
})

test('后端不再把两种失败都叫 CAPTCHA_FAILED —— 代码里已无该值', () => {
  const files = [
    'server/routes/production.js',
    'server/services/account-service.js',
    'server/lib/captcha.js'
  ]
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    // 只看被当成错误码使用的字面量（带引号），注释里提到历史值不算
    assert.ok(!source.includes("'CAPTCHA_FAILED'"), `${file}: 不应再出现 CAPTCHA_FAILED`)
    assert.ok(!source.includes("'BAD_CAPTCHA'"), `${file}: 不应再出现 BAD_CAPTCHA`)
  }
})

// ================================================================== 6. 仓储合同
//
// 生产上修好图形验证码之后，注册**仍然 500**：
//   TypeError: this.repo.userByUsername is not a function
// 生产仓储只实现了 userByEmail，少了 userByUsername —— 而两张表都没有
// 用户名唯一约束，这道应用层检查是唯一防线。
//
// 这里的测试直接拿"服务用到了哪些方法"去比对"仓储实现了哪些方法"，
// 让这类缺失在下一次就跑红，而不是等到生产点注册才炸。

test('服务用到的每个仓储方法，对应仓储都必须实现', () => {
  const pairs = [
    ['server/services/account-service.js',
      require('../server/repositories/production-repository').ProductionRepository,
      'ProductionRepository'],
    ['server/services/customer-identity-service.js',
      require('../server/repositories/customer-repository').CustomerRepository,
      'CustomerRepository']
  ]
  for (const [file, Ctor, label] of pairs) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    const used = new Set(
      [...source.matchAll(/this\.repo\.([A-Za-z0-9_]+)\s*\(/g)].map(match => match[1])
    )
    assert.ok(used.size > 0, `${file}: 没解析出 this.repo.* 调用，检查正则是否失效`)
    for (const method of used) {
      assert.equal(
        typeof Ctor.prototype[method], 'function',
        `${label} 缺少 ${method}()，${file} 调用时会 TypeError → 500`
      )
    }
  }
})

test('注册链路依赖的仓储方法一个都不能少', () => {
  const { ProductionRepository } = require('../server/repositories/production-repository')
  const required = ['userByUsername', 'userByEmail', 'createUser', 'updateUserPassword', 'setting', 'settings']
  for (const method of required) {
    assert.equal(typeof ProductionRepository.prototype[method], 'function', `缺少 ${method}()`)
  }
})

test('userByUsername 必须同时查 users 与 merchant_identities', async () => {
  const { ProductionRepository } = require('../server/repositories/production-repository')
  const seen = []

  const makePool = rowsFor => ({
    query: async (text, values) => {
      seen.push(String(text).replace(/\s+/g, ' '))
      return { rows: rowsFor(text, values) }
    },
    connect: async () => ({ query: async () => ({ rows: [] }), release() {} })
  })

  // 用户名只存在于身份表（登录就是按这张表解析的）
  const identityOnly = new ProductionRepository(makePool(text => (
    /FROM merchant_identities/i.test(text)
      ? [{ account_type: 'main', account_id: 9, username: 'Taken', email: 'a@b.c' }]
      : []
  )))
  assert.ok(await identityOnly.userByUsername('taken'), '必须能在 merchant_identities 命中')
  assert.ok(seen.some(sql => /FROM users/i.test(sql)), '必须查 users')
  assert.ok(seen.some(sql => /FROM merchant_identities/i.test(sql)), '必须查 merchant_identities')

  // 用户名存在于 users
  const inUsers = new ProductionRepository(makePool(text => (
    /FROM users/i.test(text) ? [{ id: 3, username: 'Taken', email: 'a@b.c', status: 1 }] : []
  )))
  assert.ok(await inUsers.userByUsername('Taken'))

  // 都不存在才是可用用户名
  const free = new ProductionRepository(makePool(() => []))
  assert.equal(await free.userByUsername('BrandNew'), null)
})

test('createUser 只写 users —— 身份行由 users 上的触发器维护（重复写入曾 500）', async () => {
  const { ProductionRepository } = require('../server/repositories/production-repository')

  // 生产上 users 表带有触发器 users_identity_sync（migration 001_initial_schema）：
  //   AFTER INSERT ON users → INSERT INTO merchant_identities
  //     (CASE WHEN TG_TABLE_NAME='users' THEN 'user' ELSE 'sub' END, NEW.id, ...)
  //     ON CONFLICT (account_type, account_id) DO UPDATE ...
  //
  // 这里把该触发器、以及身份表的两条真实约束（check + PK）一起重放出来。
  // 只要 createUser 再自己插一次身份表，这个测试就会像生产一样炸：
  //   · 写 'main' → 违反 merchant_identities_account_type_check
  //   · 写 'user' → 违反 merchant_identities_pkey（触发器已经插过）
  const ALLOWED_TYPES = ['user', 'sub']
  const statements = []
  const users = new Map()
  const identities = new Map()
  let seq = 100

  const runTrigger = row => {
    const type = 'user' // users 表的 TG_TABLE_NAME 分支
    identities.set(`${type}:${row.id}`, { type, id: row.id, username: row.username, email: row.email })
  }

  const run = async (text, values) => {
    const sql = String(text).replace(/\s+/g, ' ').trim()
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] }

    if (/INSERT INTO users/i.test(sql)) {
      statements.push('insert users')
      const row = { id: ++seq, username: values[0], email: values[3] }
      users.set(row.id, row)
      runTrigger(row)
      return { rows: [row] }
    }

    if (/INSERT INTO merchant_identities/i.test(sql)) {
      statements.push('insert merchant_identities')
      const type = (/VALUES\s*\(\s*'([^']*)'/.exec(sql) || [])[1]
      if (!ALLOWED_TYPES.includes(type)) {
        throw new Error('new row for relation "merchant_identities" violates check constraint "merchant_identities_account_type_check"')
      }
      if (identities.has(`${type}:${values[0]}`)) {
        throw new Error('duplicate key value violates unique constraint "merchant_identities_pkey"')
      }
      return { rows: [] }
    }

    return { rows: [] }
  }

  const pool = {
    query: (text, values) => run(text, values),
    connect: async () => ({ query: (text, values) => run(text, values), release() {} })
  }

  const created = await new ProductionRepository(pool).createUser({
    username: 'newbie', password: 'Abcd1234567', email: 'newbie@example.com',
    nickname: 'newbie', charBalance: 0
  })

  assert.equal(users.size, 1)
  assert.equal(identities.size, 1, '身份行必须由触发器创建')
  assert.equal(identities.get(`user:${created.id}`).username, 'newbie', '身份行内容应与用户一致')
  assert.deepEqual(statements, ['insert users'], 'createUser 不得再手写 merchant_identities')
})

test('createUser 建出的账号能按用户名登录（users + 触发器身份行闭环）', async () => {
  const { ProductionRepository } = require('../server/repositories/production-repository')

  // 复用上面那套重放逻辑：真正建一个用户，再用 accountByUsername 查回来。
  // 这是"注册成功了但登不进去"这类问题最直接的哨兵。
  const identities = new Map()
  const users = new Map()
  let seq = 200

  const run = async (text, values) => {
    const sql = String(text).replace(/\s+/g, ' ').trim()
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] }
    if (/INSERT INTO users/i.test(sql)) {
      const row = { id: ++seq, username: values[0], email: values[3], status: 1 }
      users.set(row.id, row)
      identities.set(`user:${row.id}`, { account_type: 'user', account_id: row.id, username: row.username })
      return { rows: [row] }
    }
    if (/FROM merchant_identities/i.test(sql)) {
      const hit = Array.from(identities.values()).find(i => i.username.toLowerCase() === String(values[0]).toLowerCase())
      return { rows: hit ? [{ account_type: hit.account_type, account_id: hit.account_id }] : [] }
    }
    if (/FROM users/i.test(sql)) {
      const row = users.get(Number(values[0]))
      return { rows: row ? [row] : [] }
    }
    return { rows: [] }
  }

  const pool = {
    query: (text, values) => run(text, values),
    connect: async () => ({ query: (text, values) => run(text, values), release() {} })
  }

  const repo = new ProductionRepository(pool)
  const created = await repo.createUser({
    username: 'loginok', password: 'Abcd1234567', email: 'loginok@example.com',
    nickname: 'loginok', charBalance: 0
  })

  const account = await repo.accountByUsername('LOGINOK')
  assert.ok(account, '刚注册的账号必须能按用户名查到')
  assert.equal(account.id, created.id)
  assert.equal(account.kind, 'main')
})
