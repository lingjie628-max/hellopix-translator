'use strict'

/**
 * 客户端 cookieJar 的收录边界。
 *
 * ## 为什么要有这条线
 *
 * `main.js` 里的 `api()` 会把这个 jar 拼成 Cookie 头发给**每一个**
 * `/apis/client/*` 请求。所以"哪些 cookie 能进 jar"直接决定了
 * 客户端会往外带什么凭据。
 *
 * 原来的判据是前缀匹配 `/^(__Host-)?pix_/`，它把服务端下发的
 * `__Host-pix_admin`（管理后台会话）也放了进来。桌面客户端永远不会调
 * 管理员接口 —— 那个 cookie 留在 jar 里，唯一的下场就是被无谓地
 * 发到每一个客户端请求上。
 *
 * 服务端有签名校验，冒用不了；但"高权限凭据出现在不需要它的请求里"
 * 本身就是不该有的暴露面，何况这类东西一旦将来某处日志/DNS/代理
 * 把请求头落了盘，泄露的就是管理员会话。
 *
 * ## 为什么用排除法而不是白名单
 *
 * 白名单坏起来是静默的：服务端哪天真加了个客户端要用的 cookie，
 * 客户端一声不响地丢掉，表现为"后端说发了、抓包也有、登录态就是不生效"。
 * 排除法坏起来是"多带了一个" —— 服务端还拦得住。两种失效代价不对称。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8')

/** 按花括号配平切出源码里的一个函数（或函数 + 相邻 const 定义）。 */
function extract (startMarker) {
  const start = mainSource.indexOf(startMarker)
  assert.ok(start >= 0, 'main.js 里找不到 ' + startMarker + ' —— 改名了？测试要同步更新')
  const braceStart = mainSource.indexOf('{', start)
  let depth = 0
  for (let i = braceStart; i < mainSource.length; i++) {
    if (mainSource[i] === '{') depth++
    else if (mainSource[i] === '}') {
      depth--
      if (depth === 0) return mainSource.slice(start, i + 1)
    }
  }
  throw new Error('花括号没配平：' + startMarker)
}

/** 把 isClientCookie 及其依赖的 DENY 集合装进一个干净上下文。 */
function boot () {
  const denyStart = mainSource.indexOf('const CLIENT_COOKIE_DENY')
  assert.ok(denyStart >= 0, '找不到 CLIENT_COOKIE_DENY')
  const denyEnd = mainSource.indexOf('])', mainSource.indexOf('new Set([', denyStart)) + 2

  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(mainSource.slice(denyStart, denyEnd) + '\n' + extract('function isClientCookie'), ctx)
  return ctx
}

test('生产环境的用户会话可以进 jar', () => {
  const ctx = boot()
  assert.equal(ctx.isClientCookie('__Host-pix_user'), true)
})

test('生产环境的 CSRF 可以进 jar', () => {
  const ctx = boot()
  assert.equal(ctx.isClientCookie('__Host-pix_csrf'), true)
})

test('开发环境的无前缀名同样可以进 jar', () => {
  const ctx = boot()
  assert.equal(ctx.isClientCookie('pix_user'), true)
  assert.equal(ctx.isClientCookie('pix_csrf'), true)
})

test('★ 管理后台会话绝不能进客户端 jar（生产名）', () => {
  const ctx = boot()
  assert.equal(ctx.isClientCookie('__Host-pix_admin'), false,
    '管理员会话被收进客户端 jar 后，会被拼进每个 /apis/client/* 请求的 Cookie 头')
})

test('★ 管理后台会话绝不能进客户端 jar（开发名）', () => {
  const ctx = boot()
  assert.equal(ctx.isClientCookie('pix_admin_session'), false)
})

test('别的系统在同域下发的 cookie 不许混进来', () => {
  const ctx = boot()
  assert.equal(ctx.isClientCookie('sessionid'), false)
  assert.equal(ctx.isClientCookie('__Host-other_app'), false)
  assert.equal(ctx.isClientCookie('PHPSESSID'), false)
})

test('服务端将来新增的 pix_ cookie 默认放行（排除法的方向）', () => {
  const ctx = boot()
  assert.equal(ctx.isClientCookie('__Host-pix_device'), true,
    '这一步不是"保证它有用"，而是保证新 cookie 不会因为客户端白名单而静默丢失')
})

/**
 * 端到端：喂一个真实的 Set-Cookie 响应，看 jar 里剩下什么。
 * 上面测的是判据，这里测的是判据有没有真正接到 rememberCookies 上。
 */
test('★ rememberCookies 对包含 admin 的响应只保留用户侧 cookie', () => {
  const start = mainSource.indexOf('function rememberCookies')
  assert.ok(start >= 0)
  const braceStart = mainSource.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = braceStart; i < mainSource.length; i++) {
    if (mainSource[i] === '{') depth++
    else if (mainSource[i] === '}') {
      depth--
      if (depth === 0) { end = i + 1; break }
    }
  }

  const denyStart = mainSource.indexOf('const CLIENT_COOKIE_DENY')
  const denyEnd = mainSource.indexOf('])', mainSource.indexOf('new Set([', denyStart)) + 2

  const ctx = { cookieJar: {} }
  vm.createContext(ctx)
  vm.runInContext(
    mainSource.slice(denyStart, denyEnd) + '\n' +
    extract('function isClientCookie') + '\n' +
    mainSource.slice(start, end),
    ctx
  )

  const res = {
    headers: {
      getSetCookie: () => [
        '__Host-pix_user=user-token; Path=/; HttpOnly; Secure',
        '__Host-pix_csrf=csrf-token; Path=/; SameSite=Strict',
        '__Host-pix_admin=admin-token; Path=/; HttpOnly; Secure'
      ]
    }
  }

  ctx.rememberCookies(res)

  assert.equal(ctx.cookieJar['__Host-pix_user'], 'user-token')
  assert.equal(ctx.cookieJar['__Host-pix_csrf'], 'csrf-token')
  assert.equal(ctx.cookieJar['__Host-pix_admin'], undefined,
    'admin 会话漏进了 jar —— 它会被带到每一个客户端请求上')
})

test('清除 cookie（空值）也要走同一道过滤，但能正常删掉已存在的', () => {
  const start = mainSource.indexOf('function rememberCookies')
  const braceStart = mainSource.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = braceStart; i < mainSource.length; i++) {
    if (mainSource[i] === '{') depth++
    else if (mainSource[i] === '}') {
      depth--
      if (depth === 0) { end = i + 1; break }
    }
  }
  const denyStart = mainSource.indexOf('const CLIENT_COOKIE_DENY')
  const denyEnd = mainSource.indexOf('])', mainSource.indexOf('new Set([', denyStart)) + 2

  const ctx = { cookieJar: { '__Host-pix_user': 'stale' } }
  vm.createContext(ctx)
  vm.runInContext(
    mainSource.slice(denyStart, denyEnd) + '\n' +
    extract('function isClientCookie') + '\n' +
    mainSource.slice(start, end),
    ctx
  )

  ctx.rememberCookies({ headers: { getSetCookie: () => ['__Host-pix_user=; Path=/; Max-Age=0'] } })
  assert.equal(ctx.cookieJar['__Host-pix_user'], undefined, '登出时的空值应当把旧 cookie 删掉')
})
