'use strict'

/**
 * 超管两步验证服务的行为测试。
 *
 * 关于 Redis：本地开发机不一定有 Redis，所以这里用一个内存实现，
 * 并**按语义仿真**服务用到的两个 Lua 脚本（取出即删、比较并写入）。
 * 需要说明的是：这验证的是"服务在原子语义下的行为是否正确"，
 * 而不是"Lua 脚本本身在真实 Redis 上是否原子" —— 后者由部署时
 * 针对真 Redis 的验证覆盖（见 deploy/verify-totp-redis.sh）。
 *
 * 重点覆盖的是安全属性，不是happy path：
 *   - 动态码不能用两次（防重放）
 *   - 票据不能用两次（防重放）
 *   - 错够次数票据作废（防暴力枚举 6 位码）
 *   - 恢复码一次性
 */

const assert = require('node:assert/strict')
const test = require('node:test')
const { AdminTotpService } = require('../server/services/admin-totp-service')
const totpLib = require('../server/lib/totp')
const { key } = require('../server/stores/redis-client')

const TAKE = 'redis.call(\'DEL\', KEYS[1])'
const CONSUME = 'tonumber(last) >= tonumber(ARGV[1])'

/** 内存 Redis：只需支持服务实际用到的命令，Lua 按语义仿真 */
function fakeRedis() {
  const store = new Map()
  return {
    status: 'ready',
    options: {},
    pipeline: () => {},
    async get(k) {
      const entry = store.get(k)
      if (!entry) return null
      if (entry.expireAt && entry.expireAt <= Date.now()) {
        store.delete(k)
        return null
      }
      return entry.value
    },
    async set(k, v, ...rest) {
      // 兼容 set(k, v, 'PX', ttl)
      let ttl = 0
      const pxIndex = rest.indexOf('PX')
      if (pxIndex !== -1) ttl = Number(rest[pxIndex + 1])
      store.set(k, { value: String(v), expireAt: ttl ? Date.now() + ttl : 0 })
      return 'OK'
    },
    async del(keys) {
      const list = Array.isArray(keys) ? keys : [keys]
      let n = 0
      for (const k of list) if (store.delete(k)) n++
      return n
    },
    async eval(script, numKeys, ...args) {
      const keys = args.slice(0, numKeys)
      const argv = args.slice(numKeys).map(String)
      if (script.includes(TAKE)) {
        const entry = store.get(keys[0])
        if (!entry) return null
        store.delete(keys[0])
        return entry.value
      }
      if (script.includes(CONSUME)) {
        const entry = store.get(keys[0])
        if (entry && Number(entry.value) >= Number(argv[0])) return 0
        store.set(keys[0], { value: argv[0], expireAt: Date.now() + Number(argv[1]) })
        return 1
      }
      throw new Error('测试用假 Redis 不认识这个脚本')
    },
    _dump: () => store
  }
}

function fakeRepo(admin) {
  const events = []
  const codes = []
  return {
    events,
    codes,
    async adminById() {
      return admin
    },
    async countAdminRecoveryCodes() {
      return codes.filter(c => !c.used).length
    },
    async consumeAdminRecoveryCode(_adminId, hash) {
      const hit = codes.find(c => c.hash === hash && !c.used)
      if (!hit) return false
      hit.used = true
      return true
    },
    async enableAdminTotp(_adminId, secret, hashes) {
      admin.totpSecret = secret
      admin.totpEnabled = true
      codes.length = 0
      hashes.forEach(hash => codes.push({ hash, used: false }))
    },
    async regenerateAdminRecoveryCodes(_adminId, hashes) {
      codes.length = 0
      hashes.forEach(hash => codes.push({ hash, used: false }))
    },
    async disableAdminTotp() {
      admin.totpSecret = null
      admin.totpEnabled = false
      codes.length = 0
    },
    async recordAdminTotpEvent(_adminId, event, detail) {
      events.push({ event, detail })
    }
  }
}

function setup(overrides) {
  const secret = totpLib.generateSecret().base32
  const admin = Object.assign(
    { id: '7', username: 'pixadmin', totpEnabled: true, totpSecret: secret },
    overrides || {}
  )
  const repo = fakeRepo(admin)
  const redis = fakeRedis()
  const service = new AdminTotpService(repo, redis, { maxAttempts: 3 })
  return { admin, repo, redis, service, secret }
}

test('未开启 2FA 的超管不需要第二步', async () => {
  const { service, admin } = setup({ totpEnabled: false, totpSecret: null })
  assert.equal((await service.status(admin)).enabled, false)
})

test('第一步票据：正确动态码通过，且票据立即失效（不能用两次）', async () => {
  const { service, admin, secret } = setup()
  const { ticket } = await service.issueLoginTicket(admin)

  const code = totpLib.totp(secret)
  const ok = await service.completeLogin(ticket, code, '1.2.3.4')
  assert.equal(ok.admin.id, admin.id)
  assert.equal(ok.usedRecovery, false)

  // 同一张票据再用一次必须失败 —— 否则等于拿到票据就能无限次试码
  await assert.rejects(
    () => service.completeLogin(ticket, totpLib.totp(secret)),
    /验证已超时|重新登录/
  )
})

test('防重放：同一个动态码不能用于第二次登录（新的票据也不行）', async () => {
  const { service, admin, secret } = setup()
  const code = totpLib.totp(secret)

  await service.completeLogin((await service.issueLoginTicket(admin)).ticket, code, '1.1.1.1')

  // 换一张新票据，仍用刚才那个码：应被拒（同一 30 秒窗口内重放）
  const second = await service.issueLoginTicket(admin)
  await assert.rejects(
    () => service.completeLogin(second.ticket, code, '1.1.1.1'),
    /刚被使用过/
  )
})

test('防暴力枚举：连续错码达到上限后票据作废', async () => {
  const { service, admin } = setup() // maxAttempts = 3
  const { ticket } = await service.issueLoginTicket(admin)

  await assert.rejects(() => service.completeLogin(ticket, '000000', '2.2.2.2'), /还可尝试 2 次/)
  await assert.rejects(() => service.completeLogin(ticket, '111111', '2.2.2.2'), /还可尝试 1 次/)
  await assert.rejects(() => service.completeLogin(ticket, '222222', '2.2.2.2'), /次数过多/)

  // 票据已作废，即使随后给出正确码也不能继续
  await assert.rejects(() => service.completeLogin(ticket, '333333', '2.2.2.2'), /验证已超时/)
})

test('恢复码：可登录一次，用过即失效', async () => {
  const { service, admin, repo } = setup()
  repo.codes.push({ hash: totpLib.hashRecoveryCode('ABCDE-FGHIJ'), used: false })

  const first = await service.completeLogin(
    (await service.issueLoginTicket(admin)).ticket, 'ABCDE-FGHIJ', '3.3.3.3'
  )
  assert.equal(first.usedRecovery, true)
  assert.ok(repo.events.some(e => e.event === 'recovery_used'))

  // 第二次用同一个恢复码必须失败
  const retry = await service.issueLoginTicket(admin)
  await assert.rejects(
    () => service.completeLogin(retry.ticket, 'ABCDE-FGHIJ', '3.3.3.3'),
    /还可尝试/
  )
})

test('开启流程：待确认密钥不落库，确认成功后才写入并下发恢复码', async () => {
  const { service, admin, repo } = setup({ totpEnabled: false, totpSecret: null })

  const setupInfo = await service.beginSetup(admin)
  assert.match(setupInfo.secret, /^[A-Z2-7]{32}$/)
  assert.match(setupInfo.otpauth, /^otpauth:\/\/totp\//)
  assert.equal(admin.totpEnabled, false, '未确认前不得开启')
  assert.equal(admin.totpSecret, null, '未确认前密钥不得落库')

  // 错误的码不能开启
  await assert.rejects(() => service.enable(admin, '000000', '4.4.4.4'), /验证码不正确/)
  assert.equal(admin.totpEnabled, false)

  const { recoveryCodes } = await service.enable(admin, totpLib.totp(setupInfo.secret), '4.4.4.4')
  assert.equal(admin.totpEnabled, true)
  assert.equal(admin.totpSecret, setupInfo.secret)
  assert.equal(recoveryCodes.length, 10)
  // 下发的是明文，库里必须只有哈希
  assert.equal(repo.codes.length, 10)
  assert.ok(repo.codes.every(c => /^[0-9a-f]{64}$/.test(c.hash)))
  assert.ok(!repo.codes.some(c => recoveryCodes.includes(c.hash)))
})

test('待确认密钥过期后不能凭空的码开启', async () => {
  const { service, admin } = setup({ totpEnabled: false, totpSecret: null })
  await service.beginSetup(admin)
  await service.redis.del(key('admin-totp-pending', admin.id))
  await assert.rejects(() => service.enable(admin, '123456', '5.5.5.5'), /密钥已过期/)
})

test('回归：开启 2FA 不得消费防重放计数器，否则开启后立刻登录会被误判为"码已用过"', async () => {
  const { service, admin } = setup({ totpEnabled: false, totpSecret: null })
  const info = await service.beginSetup(admin)
  const code = totpLib.totp(info.secret)

  await service.enable(admin, code, '7.7.7.7')
  assert.equal(admin.totpEnabled, true)

  // 同一个 30 秒窗口内立刻登录：必须成功。
  // 若 enable 里消费了计数器，这里会抛 TOTP_REPLAYED —— 用户刚开启完 2FA
  // 就被自己锁在门外，得干等一个窗口。
  const { ticket } = await service.issueLoginTicket(admin)
  const result = await service.completeLogin(ticket, code, '7.7.7.7')
  assert.equal(result.usedRecovery, false)
})

test('关闭 2FA 必须用未被使用过的码（会话被劫持时不能拿刚用过的码关掉）', async () => {
  const { service, admin, secret } = setup()
  const code = totpLib.totp(secret)

  // 先用这个码登录（消费掉该时间步）
  await service.completeLogin((await service.issueLoginTicket(admin)).ticket, code, '8.8.8.8')

  // 再拿同一个码去关闭：应被拒，且给出可操作的提示
  await assert.rejects(
    () => service.disable(admin, code, '8.8.8.8'),
    /刚被使用过/
  )
  assert.equal(admin.totpEnabled, true, '被拒时不得关闭')
})

test('关闭 2FA 需要有效动态码，且关闭后会话里的旧密钥被清空', async () => {
  const { service, admin, secret, repo } = setup()
  await assert.rejects(() => service.disable(admin, '000000', '6.6.6.6'), /验证码不正确/)
  assert.equal(admin.totpEnabled, true, '校验失败不得关闭')

  await service.disable(admin, totpLib.totp(secret), '6.6.6.6')
  assert.equal(admin.totpEnabled, false)
  assert.equal(admin.totpSecret, null)
  assert.equal(repo.codes.length, 0, '关闭后恢复码必须一并清除')
})

test('status 反映恢复码剩余数量，用于提醒管理员补充', async () => {
  const { service, admin, repo } = setup()
  repo.codes.push({ hash: 'a'.repeat(64), used: false }, { hash: 'b'.repeat(64), used: true })
  const status = await service.status(admin)
  assert.equal(status.enabled, true)
  assert.equal(status.recoveryRemaining, 1)
})
