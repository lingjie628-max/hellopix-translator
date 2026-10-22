'use strict'

/**
 * 登录限流必须按入口分桶。
 *
 * 线上真出得来：三个入口共用 `login-ip` 一个计数器时，
 * 攻击者只要从某个 IP 往 /login 刷 30 次失败登录，
 * 同 IP 的**超管后台**就被一起锁死了 —— 攻击者进不去，
 * 运维也进不去，只能等 15 分钟或上机器改 Redis。
 *
 * 这条测试直接读路由中间件链，确认每个入口挂的是自己的桶。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const contextSrc = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'context.js'), 'utf8')
const authSrc = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'auth.js'), 'utf8')

function routeSlot(route) {
  const at = authSrc.indexOf(`router.post('${route}'`)
  assert.ok(at > 0, `找不到路由 ${route}`)
  const next = authSrc.indexOf('asyncRoute(', at)
  return authSrc.slice(at, next)
}

test('三个登录入口各用各的 IP 桶，互不牵连', () => {
  const slots = {
    '/login': routeSlot('/login'),
    '/client/login': routeSlot('/client/login'),
    '/admin/login': routeSlot('/admin/login')
  }
  const buckets = Object.entries(slots).map(([route, slot]) => {
    const m = slot.match(/limits\.(\w+)/)
    assert.ok(m, `${route} 没有挂 IP 限流 —— 裸奔的登录口`)
    return m[1]
  })
  assert.deepStrictEqual(
    new Set(buckets).size,
    3,
    `多个登录口共用了同一个限流桶（${buckets.join(' / ')}）：一个口被刷爆会连带锁死另一个口`
  )
})

test('每个登录入口的 IP 桶都在 context.js 里独立定义', () => {
  for (const name of ['loginIp', 'clientLoginIp', 'adminLoginIp']) {
    assert.match(contextSrc, new RegExp(`^\\s*${name}:\\s*limit\\(`, 'm'), `context.js 里缺少 ${name}`)
  }
  // 命名空间也必须不同，否则同一个 Redis 计数器还是被复用
  const namespaces = [...contextSrc.matchAll(/limit\('([a-z-]+)',/g)].map((m) => m[1])
  assert.strictEqual(new Set(namespaces).size, namespaces.length, `限流命名空间有重复：${namespaces.join(', ')}`)
})

test('账号维度限流仍然全局共享（这是对的，同一账号不管从哪个口登都要计数）', () => {
  for (const route of ['/login', '/client/login', '/admin/login']) {
    assert.match(routeSlot(route), /limits\.loginAccount/, `${route} 丢了按账号的限流`)
  }
})
