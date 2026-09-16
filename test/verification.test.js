/**
 * 邮箱验证码测试。
 *
 * 这是注册与找回密码的唯一凭证，所以测试重点在三个攻击面：
 *   · 爆破（6 位数字只有 100 万种，不限次数几分钟就撞出来）
 *   · 滥用发信（接口公开，不限流就是免费发信机）
 *   · 场景串用（注册的码拿去重置密码）
 *
 * 用内存假 Redis，不依赖真实连接。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  VerificationService,
  CODE_TTL_SECONDS,
  SEND_INTERVAL_SECONDS,
  MAX_ATTEMPTS
} = require('../server/services/verification-service')

/** 够用的内存 Redis：只实现本服务用到的那几个命令 */
function fakeRedis() {
  const store = new Map()
  return {
    store,
    async get(k) { const v = store.get(k); return v === undefined ? null : v },
    async set(k, v, ...args) {
      // 支持 set(k, v, 'EX', ttl)
      store.set(k, String(v))
      return 'OK'
    },
    async del(k) { store.delete(k); return 1 },
    async incr(k) { const n = Number(store.get(k) || 0) + 1; store.set(k, String(n)); return n },
    async expire(k, ttl) { return 1 }
  }
}

const EMAIL = 'user@example.com'

test('验证码是 6 位数字且随机 —— 不能用 Math.random', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i++) {
    const c = VerificationService.generate()
    assert.match(c, /^\d{6}$/, '必须是 6 位数字')
    seen.add(c)
  }
  // 200 次里若大量重复，说明不是随机源
  assert.ok(seen.size > 180, `随机性不足：200 次只产生 ${seen.size} 个不同值`)
})

test('验证码校验成功后立即失效 —— 一次性', async () => {
  const svc = new VerificationService(fakeRedis(), 't')
  await svc.issue(EMAIL, 'register', '123456')
  assert.equal((await svc.verify(EMAIL, 'register', '123456')).ok, true)
  // 再用同一个码必须失败
  const again = await svc.verify(EMAIL, 'register', '123456')
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'CODE_EXPIRED', '用过即删，第二次应表现为"不存在"')
})

test('连续错误会锁死 —— 挡住 6 位数字的爆破', async () => {
  const svc = new VerificationService(fakeRedis(), 't')
  await svc.issue(EMAIL, 'register', '123456')

  // 前 MAX_ATTEMPTS-1 次失败仍可继续
  for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
    const r = await svc.verify(EMAIL, 'register', '000000')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'CODE_MISMATCH')
    assert.equal(r.left, MAX_ATTEMPTS - 1 - i, '剩余次数应递减')
  }

  // 第 MAX_ATTEMPTS 次把码作废
  const last = await svc.verify(EMAIL, 'register', '000000')
  assert.equal(last.ok, false)
  assert.equal(last.reason, 'TOO_MANY_ATTEMPTS')

  // 此时**即使输对也不再接受** —— 否则爆破者只需撞对一次
  const correct = await svc.verify(EMAIL, 'register', '123456')
  assert.equal(correct.ok, false, '锁死后正确的码也不能用，必须重新获取')
})

test('场景隔离：注册的码不能用来重置密码', async () => {
  const svc = new VerificationService(fakeRedis(), 't')
  await svc.issue(EMAIL, 'register', '123456')
  const r = await svc.verify(EMAIL, 'forgot', '123456')
  assert.equal(r.ok, false, '不同场景的码必须互不通用')
  assert.equal(r.reason, 'CODE_EXPIRED')
})

test('同一邮箱 60 秒内不能重复发送', async () => {
  const svc = new VerificationService(fakeRedis(), 't')
  assert.equal((await svc.canSend(EMAIL, '1.1.1.1')).ok, true)
  await svc.issue(EMAIL, 'register', '111111')
  const gate = await svc.canSend(EMAIL, '1.1.1.1')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'TOO_FREQUENT')
})

test('同一邮箱每小时发信有上限 —— 防止烧配额与拖累域名信誉', async () => {
  const svc = new VerificationService(fakeRedis(), 't')
  // 绕开 60 秒间隔，直接累加小时配额
  for (let i = 0; i < 8; i++) await svc.bumpQuota(svc.key('quota-mail', EMAIL))
  const gate = await svc.canSend(EMAIL, '1.1.1.1')
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'MAIL_HOURLY_LIMIT')
})

test('同一 IP 每小时发信有上限 —— 挡住换邮箱刷接口', async () => {
  const svc = new VerificationService(fakeRedis(), 't')
  const ip = '2.2.2.2'
  for (let i = 0; i < 30; i++) await svc.bumpIp(ip)
  // 换一个从没发过的邮箱，仍应被 IP 配额挡住
  const gate = await svc.canSend('fresh@example.com', ip)
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'IP_HOURLY_LIMIT')
})

test('canSend 只读不写 —— 检查通过但发信失败时不该白占配额', async () => {
  const redis = fakeRedis()
  const svc = new VerificationService(redis, 't')
  const before = redis.store.size
  await svc.canSend(EMAIL, '3.3.3.3')
  assert.equal(redis.store.size, before, 'canSend 不得写入任何键')
})

test('日志掩码不泄露完整邮箱', () => {
  assert.equal(VerificationService.mask('alice@example.com'), 'a***@example.com')
  assert.equal(VerificationService.mask('a@b.com'), '***')
  assert.equal(VerificationService.mask(''), '***')
  assert.equal(VerificationService.mask(null), '***')
  // 掩码结果里不得出现原始本地部分
  assert.doesNotMatch(VerificationService.mask('secretname@x.com'), /secretname/)
})

test('常量与文档一致', () => {
  assert.equal(CODE_TTL_SECONDS, 600, '10 分钟有效')
  assert.equal(SEND_INTERVAL_SECONDS, 60, '60 秒间隔')
  assert.equal(MAX_ATTEMPTS, 5, '5 次尝试上限')
})
