'use strict'

/**
 * `loginWithCredentials` 的 cookieJar 回滚契约。
 *
 * ## 这条为什么值得单独一个测试文件
 *
 * 函数一进来就 `cookieJar = {}`，目的是"别拿上一个账号的 cookie 去打新账号
 * 的登录接口"。但清空容易，恢复难 —— 只有**正常返回**那条路把
 * `previousCookies` 放回去，而 `api()` 是会抛异常的：
 *
 *   · 断网 → NETWORK_UNREACHABLE
 *   · 超时 → 被 AbortSignal.timeout 打断
 *   · 服务端回了一坨非 JSON → SERVER_BAD_RESPONSE
 *
 * 这三种都让控制流直接从 `await api(...)` 跳出去，`!data.success` 那一行
 * 永远不执行。结果是用户的 cookieJar 永久停在 `{}`，人还登着，但下一次
 * 任何请求都会 401 —— 表现为"莫名其妙掉号，重启才好"。
 *
 * 最阴的是它会在启动路径上触发：`auth:autoLogin` 走的就是这个函数。
 *
 * ## 测试方式
 *
 * main.js 一 require 就加载 electron，普通 Node 跑不了。所以这里把
 * 函数体从源码里**抽出来真跑**，注入一个会抛的 api 桩。不是正则匹配
 * 源码文本 —— 那种断言改个变量名就失效，也证明不了回滚真的发生。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8')

/**
 * 从 main.js 源码里切出 `async function loginWithCredentials(...) { ... }`
 * 的完整函数体，按花括号配平，然后在隔离的 vm 上下文里执行。
 */
function extractLoginFunction () {
  const start = mainSource.indexOf('async function loginWithCredentials(')
  assert.ok(start >= 0, 'main.js 里找不到 loginWithCredentials —— 函数改名了？这个测试需要同步更新')

  const bodyStart = mainSource.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = bodyStart; i < mainSource.length; i++) {
    const ch = mainSource[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { end = i + 1; break }
    }
  }
  assert.ok(end > bodyStart, '没找到 loginWithCredentials 的收尾花括号')
  return mainSource.slice(start, end)
}

/**
 * 起一个最小上下文：只有 loginWithCredentials 用得到的那几个名字。
 *
 * @param {object} opts
 * @param {object} opts.cookieJar  初始 cookie（模拟"已经登着"的状态）
 * @param {Function} opts.api      api 桩。抛错 / 正常返回由用例决定
 */
function boot (opts) {
  const o = opts || {}
  const calls = []
  const ctx = {
    cookieJar: o.cookieJar === undefined ? {} : Object.assign({}, o.cookieJar),
    profile: o.profile === undefined ? null : o.profile,
    api: async (pathname, init) => {
      calls.push({ pathname, init, jarAtCall: Object.assign({}, ctx.cookieJar) })
      return o.api ? o.api(pathname, init, ctx) : { success: true, obj: { username: 'u1' } }
    },
    deviceId: () => 'device-fixed',
    restoreOpenApps: (username) => { calls.push({ restore: username }) },
    Error: Error
  }
  vm.createContext(ctx)
  vm.runInContext(extractLoginFunction(), ctx)
  return { ctx, calls }
}

test('登录成功后 cookieJar 换成新账号的（这是清空的本来目的）', async () => {
  const { ctx } = boot({
    cookieJar: { old_session: 'stale' },
    api: async () => ({ success: true, obj: { username: 'newuser' } })
  })

  const data = await ctx.loginWithCredentials('newuser', 'pw')

  assert.equal(data.success, true)
  assert.equal(ctx.profile.username, 'newuser')
})

test('★ api 抛异常时必须把旧 cookie 放回去（断网不该把人踢下线）', async () => {
  const { ctx } = boot({
    // 用户已经登着，jar 里是有效会话
    cookieJar: { sid: 'live-session', '__Host-pix_csrf': 'tok' },
    profile: { username: 'already' },
    api: async () => {
      const err = new Error('network down')
      err.code = 'NETWORK_UNREACHABLE'
      throw err
    }
  })

  await assert.rejects(
    () => ctx.loginWithCredentials('someone', 'pw'),
    /network down/,
    '原始错误要原样传给上层，渲染层靠它出「无法连接后台」'
  )

  assert.deepEqual(
    Object.assign({}, ctx.cookieJar),
    { sid: 'live-session', '__Host-pix_csrf': 'tok' },
    '抛错路径没回滚 —— 用户明明登着，却被清成未登录，之后每个请求都 401'
  )
  assert.equal(ctx.profile.username, 'already', '登录没成功就不能改 profile')
})

test('★ 超时（AbortError）同样要回滚，不能只认自定义错误码', async () => {
  const { ctx } = boot({
    cookieJar: { sid: 'live' },
    api: async () => {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'TimeoutError'
      throw err
    }
  })

  await assert.rejects(() => ctx.loginWithCredentials('u', 'p'))
  assert.deepEqual(Object.assign({}, ctx.cookieJar), { sid: 'live' })
})

test('登录接口返回 success:false 时也要回滚（这条原本就是对的，别改坏）', async () => {
  const { ctx } = boot({
    cookieJar: { sid: 'live' },
    api: async () => ({ success: false, msg: '密码错误' })
  })

  const data = await ctx.loginWithCredentials('u', 'wrong')

  assert.equal(data.success, false)
  assert.equal(data.msg, '密码错误')
  assert.deepEqual(Object.assign({}, ctx.cookieJar), { sid: 'live' })
})

test('打登录接口时不能带上一个账号的 cookie（清空的目的）', async () => {
  const { ctx, calls } = boot({
    cookieJar: { sid: 'account-A-session' },
    api: async () => ({ success: true, obj: { username: 'B' } })
  })

  await ctx.loginWithCredentials('B', 'pw')

  const loginCall = calls.find(c => c.pathname === '/client/login')
  assert.ok(loginCall, '没打登录接口')
  assert.deepEqual(loginCall.jarAtCall, {},
    '请求发出时 jar 必须已经是空的 —— 否则 A 的会话会被服务端当成"已登录"直接放行或拒绝')
})

test('空 cookie 情况下抛错，回滚成空 jar 也不能炸', async () => {
  const { ctx } = boot({
    cookieJar: {},
    api: async () => { throw new Error('boom') }
  })

  await assert.rejects(() => ctx.loginWithCredentials('u', 'p'))
  assert.deepEqual(Object.assign({}, ctx.cookieJar), {})
})
