'use strict'

/**
 * 账号到期必须在**每一次请求**上生效，而不只是登录那一刻。
 *
 * 线上踩到的形态：
 *   · 登录时确实判断了 `expiresAt`；
 *   · 但 `resolve()`（每个请求都会走）只校验 `status`；
 *   · 于是「到期」只会拦住**下一次登录**，已经登录的会话可以一直翻译下去。
 *   · 子账号更离谱：连主账号的 `status` 都没在此前被校验过，
 *     停用主账号对团队账号完全无效。
 *
 * 这里用真实的 AuthService + 假仓库跑，不连库：边界清楚，跑得快。
 */

const test = require('node:test')
const assert = require('node:assert')

const { AuthService } = require('../server/services/auth-service')

/** 造一个能返回指定 session 的仓库 + 安全的 resolveSession */
function harness(session) {
  const revoked = []
  const repository = {
    sessionAccount: async () => session,
    adminById: async () => null,
    query: async () => ({ rows: [] }),
    packageEngines: async () => []
  }
  const security = {
    resolveSession: async () => ({ subjectId: `${session.kind}:${session.account.id}`, deviceId: '' }),
    revokeSubject: async (type, subject) => { revoked.push(`${type}:${subject}`) }
  }
  const auth = new AuthService(repository, security, {})
  return { auth, revoked }
}

function req() {
  return { path: '/translate', method: 'POST', headers: {}, ip: '127.0.0.1' }
}

function mainAccount(overrides) {
  return {
    kind: 'main',
    account: Object.assign({ id: 1, status: 1, username: 'boss' }, (overrides || {}).account),
    parent: Object.assign({ id: 1, status: 1, username: 'boss', expiresAt: null }, (overrides || {}).parent)
  }
}

function subAccount(overrides) {
  return {
    kind: 'sub',
    account: Object.assign({ id: 7, status: 1, username: 'kid', parentId: 1 }, (overrides || {}).account),
    parent: Object.assign({ id: 1, status: 1, username: 'boss', expiresAt: null }, (overrides || {}).parent)
  }
}

const past = () => new Date(Date.now() - 60_000).toISOString()
const future = () => new Date(Date.now() + 86_400_000).toISOString()

test('主账号未过期 → 放行', async () => {
  const { auth } = harness(mainAccount({ parent: { expiresAt: future() } }))
  const found = await auth.resolve(req(), 'user')
  assert.ok(found, '没过期却被拦了')
})

test('★ 主账号已过期 → 已有会话也必须立刻失效（不能只拦登录）', async () => {
  const { auth } = harness(mainAccount({ parent: { expiresAt: past() } }))
  const found = await auth.resolve(req(), 'user')
  assert.strictEqual(found, null, '过期账号的旧会话还能用 —— 他挂着窗口就能一直翻译')
})

test('expiresAt 为 null = 无限期，放行', async () => {
  const { auth } = harness(mainAccount({ parent: { expiresAt: null } }))
  assert.ok(await auth.resolve(req(), 'user'))
})

test('★ 主账号被停用 → 子账号同时失效', async () => {
  const { auth } = harness(subAccount({ parent: { status: 0 } }))
  assert.strictEqual(await auth.resolve(req(), 'user'), null,
    '停用主账号对子账号无效 —— 团队账号能绕过停用继续用')
})

test('★ 主账号到期 → 子账号同时失效', async () => {
  const { auth } = harness(subAccount({ parent: { expiresAt: past() } }))
  assert.strictEqual(await auth.resolve(req(), 'user'), null,
    '主账号到期了子账号还能翻译')
})

test('子账号自己被停用 → 失效（原有行为不能回退）', async () => {
  const { auth } = harness(subAccount({ account: { status: 0 } }))
  assert.strictEqual(await auth.resolve(req(), 'user'), null)
})

test('主号与子号都正常 → 子账号放行', async () => {
  const { auth } = harness(subAccount({ parent: { expiresAt: future() } }))
  assert.ok(await auth.resolve(req(), 'user'))
})

// ---------------------------------------------------------------------------
// 按字符计费（2026-11-17 起）
//
// 背景：jiufa 的套餐 04:23 到期、04:24 就被锁在门外，而账上还有 254 万字符
// 没用完。基础/高级/专业版卖的是**字符额度**，不是租期，所以这三档改成
// 只看余额。单人包月（solo_monthly）卖的是时间，必须继续看到期。
// ---------------------------------------------------------------------------

const { isAccountUnavailable } = require('../server/services/auth-service')

test('★ 高级版到期但还有余额 → 仍可用（用户买的是字符不是租期）', () => {
  const parent = { packageCode: 'advanced', expiresAt: past(), charBalance: 2_540_000 }
  assert.strictEqual(isAccountUnavailable(parent), false,
    '字符没用完却被到期时间锁住 —— 用户会认为钱白花了')
})

test('★ 高级版字符用完 → 不可用（交给 INSUFFICIENT_CHARS 之外的兜底）', () => {
  const parent = { packageCode: 'advanced', expiresAt: past(), charBalance: 0 }
  assert.strictEqual(isAccountUnavailable(parent), true)
})

test('基础版 / 专业版 同样按字符计', () => {
  for (const code of ['basic', 'pro']) {
    assert.strictEqual(
      isAccountUnavailable({ packageCode: code, expiresAt: past(), charBalance: 1 }),
      false, `${code} 有余额却不可用`)
    assert.strictEqual(
      isAccountUnavailable({ packageCode: code, expiresAt: past(), charBalance: 0 }),
      true, `${code} 没余额却可用`)
  }
})

test('★ 单人包月是按时长卖的 → 到期必须失效（不能被字符规则放行）', () => {
  const parent = { packageCode: 'solo_monthly', expiresAt: past(), charBalance: 99_999_999 }
  assert.strictEqual(isAccountUnavailable(parent), true,
    '包月套餐被当成字符套餐 —— 等于白送无限期使用')
})

test('单人包月未到期 → 可用', () => {
  const parent = { packageCode: 'solo_monthly', expiresAt: future(), charBalance: 0 }
  assert.strictEqual(isAccountUnavailable(parent), false)
})

test('★ 拿不到套餐 code → 退回按时间判断（不能把全站变无限期）', () => {
  assert.strictEqual(isAccountUnavailable({ expiresAt: past(), charBalance: 999 }), true)
  assert.strictEqual(isAccountUnavailable({ expiresAt: future(), charBalance: 0 }), false)
})

test('余额字段异常 → 退回按时间判断，不误判为可用', () => {
  const parent = { packageCode: 'advanced', expiresAt: past(), charBalance: 'not-a-number' }
  assert.strictEqual(isAccountUnavailable(parent), true)
})

test('子账号受主账号余额约束（主号没字符了，整个团队一起停）', async () => {
  const { auth } = harness(subAccount({
    parent: { packageCode: 'advanced', expiresAt: past(), charBalance: 0 }
  }))
  assert.strictEqual(await auth.resolve(req(), 'user'), null)
})

test('子账号在主账号有字符时照常可用（即使已过原到期日）', async () => {
  const { auth } = harness(subAccount({
    parent: { packageCode: 'advanced', expiresAt: past(), charBalance: 500_000 }
  }))
  assert.ok(await auth.resolve(req(), 'user'), '主账号有余额，子账号却被拦了')
})
