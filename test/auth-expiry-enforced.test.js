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
