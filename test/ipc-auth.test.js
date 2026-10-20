'use strict'

/**
 * 账号 IPC 的单元测试。
 *
 * 这一组握着 profile（当前账号）和 cookieJar（登录态）。
 * 断言的重点不是"返回什么"，而是**状态有没有被正确写回或清掉**：
 *   · 登出必须清 cookieJar + profile，但保留"记住的密码"
 *   · 登录失败必须回滚 cookieJar（否则半登录状态会串号）
 *   · 自动登录四个条件缺一不可
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { registerAuthIpc } = require('../desktop/src/ipc/auth')

function harness (opts) {
  const o = opts || {}
  const handlers = {}
  const state = {
    profile: o.profile === undefined ? null : o.profile,
    cookieJar: o.cookieJar === undefined ? {} : o.cookieJar
  }
  const calls = []
  const stored = o.storedAuth || {}

  registerAuthIpc({
    reg: {
      handle: (ch, fn) => { handlers[ch] = fn },
      handleUnsafe: (ch, fn) => { handlers[ch] = fn }
    },
    state,
    actions: {
      publicAuth: () => ({ username: state.profile && state.profile.username }),
      saveAuth: (p) => { calls.push(['saveAuth', p]); return { success: true } },
      loadStoredAuth: () => stored,
      loginWithCredentials: async (u, p) => {
        calls.push(['login', u, p])
        if (o.loginResult) return o.loginResult(u, p)
        state.profile = { username: u }
        return { success: true }
      },
      clearTabs: (arg) => { calls.push(['clearTabs', arg]) },
      sendKicked: (msg) => { calls.push(['kicked', msg]) },
      sendSession: () => { calls.push(['sendSession']) },
      api: async (path) => {
        calls.push(['api', path])
        if (o.apiResult) return o.apiResult(path)
        return { success: true }
      }
    },
    env: { timingEqual: (a, b) => a === b }
  })
  return { handlers, state, calls }
}

test('auth:logout 清掉登录态，但保留记住的账号（否则下次还得手输）', async () => {
  const { handlers, state, calls } = harness({ profile: { username: 'u1' }, cookieJar: { c: '1' } })
  const r = await handlers['auth:logout']({})
  assert.equal(r.success, true)
  assert.deepEqual(state.cookieJar, {}, 'cookieJar 必须清空')
  assert.equal(state.profile, null, 'profile 必须清空')
  assert.deepEqual(calls.find(c => c[0] === 'clearTabs')[1], { keepSaved: true })
})

test('auth:logout 服务端失败也要清本地（用户的意图是退出）', async () => {
  const { handlers, state } = harness({
    profile: { username: 'u1' },
    cookieJar: { c: '1' },
    apiResult: () => { throw new Error('network down') }
  })
  const r = await handlers['auth:logout']({})
  assert.equal(r.success, true, '网络不好不能把用户留在登录态里')
  assert.equal(state.profile, null)
  assert.deepEqual(state.cookieJar, {})
})

test('auth:autoLogin 四个条件缺一不可', async () => {
  const base = { remember: true, autoLogin: true, username: 'u', password: 'p' }
  const missing = ['remember', 'autoLogin', 'username', 'password']
  for (const key of missing) {
    const stored = Object.assign({}, base)
    delete stored[key]
    const { handlers, calls } = harness({ storedAuth: stored })
    const r = await handlers['auth:autoLogin']({})
    assert.equal(r.success, false, '缺 ' + key + ' 时不应尝试登录')
    assert.match(r.msg, /未启用自动登录/)
    assert.equal(calls.filter(c => c[0] === 'login').length, 0, '半份凭据不能打接口')
  }
})

test('auth:autoLogin 条件齐全时才真正登录', async () => {
  const { handlers, calls } = harness({
    storedAuth: { remember: true, autoLogin: true, username: 'u', password: 'p' }
  })
  const r = await handlers['auth:autoLogin']({})
  assert.equal(r.success, true)
  assert.deepEqual(calls.find(c => c[0] === 'login'), ['login', 'u', 'p'])
})

test('auth:verifyLock 密码为空直接拒，不打服务器', async () => {
  const { handlers, calls } = harness({ storedAuth: { password: '123' } })
  const r = await handlers['auth:verifyLock']({}, '')
  assert.equal(r.success, false)
  assert.equal(calls.filter(c => c[0] === 'login').length, 0)
})

test('auth:verifyLock 本地有密码时走本地比对', async () => {
  const { handlers, calls } = harness({
    profile: { username: 'u1' },
    storedAuth: { username: 'u1', password: '123' }
  })
  assert.equal((await handlers['auth:verifyLock']({}, '123')).success, true)
  assert.equal((await handlers['auth:verifyLock']({}, 'wrong')).success, false)
  assert.equal(calls.filter(c => c[0] === 'login').length, 0, '本地能验就不该打接口')
})

test('auth:verifyLock 存的是别人的密码时不拿来比对（防串号）', async () => {
  const { handlers, calls } = harness({
    profile: { username: 'u2' },
    storedAuth: { username: 'u1', password: '123' },
    // u1 的密码在 u2 的会话里本来就该失败
    loginResult: (u, p) => ({ success: false, msg: '密码不正确' })
  })
  // u1 的密码绝不能解锁 u2 的会话
  const r = await handlers['auth:verifyLock']({}, '123')
  assert.equal(r.success, false, 'u1 存的密码不能解锁 u2')
  assert.equal(calls.filter(c => c[0] === 'login').length, 1, '应回退到在线校验 u2')
  assert.deepEqual(calls.find(c => c[0] === 'login'), ['login', 'u2', '123'])
})

test('auth:verifyLock 无登录态且无本地密码 → 登录状态已失效', async () => {
  const { handlers } = harness({ storedAuth: {} })
  const r = await handlers['auth:verifyLock']({}, 'x')
  assert.equal(r.success, false)
  assert.match(r.msg, /登录状态已失效/)
})

test('auth:session 拿到 obj 就写回 profile 并通知渲染层', async () => {
  const { handlers, state, calls } = harness({
    apiResult: () => ({ success: true, obj: { username: 'u9' } })
  })
  await handlers['auth:session']({})
  assert.equal(state.profile.username, 'u9')
  assert.equal(calls.filter(c => c[0] === 'sendSession').length, 1)
})

test('auth:session 失效时踢人，不改 profile', async () => {
  const { handlers, state, calls } = harness({
    profile: { username: 'old' },
    apiResult: () => ({ success: false, msg: '过期了' })
  })
  await handlers['auth:session']({})
  assert.equal(state.profile.username, 'old', '失效时不能清掉，否则界面会瞬间变未登录态')
  assert.deepEqual(calls.find(c => c[0] === 'kicked'), ['kicked', '过期了'])
})

test('auth:login 缺字段时按空串传，不抛错', async () => {
  const { handlers, calls } = harness()
  await handlers['auth:login']({})
  assert.deepEqual(calls.find(c => c[0] === 'login'), ['login', '', ''])
})
