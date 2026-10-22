'use strict'

/**
 * 公开路径白名单的"无死条目"守卫。
 *
 * ## 为什么死条目是真隐患
 *
 * `auth.middleware()` 里有一张 `publicPaths` 白名单：命中就直接 `next()`，
 * **完全跳过登录校验**。这张表里每多一条，攻击面就多一块。
 *
 * 危险的不是"现在多了一条",而是"**现在多了一条没人用的**"：
 *
 *   1. 白名单里躺着 `/order/selectOrderBySerialNumber` 这类旧项目遗留路径
 *   2. 但它全项目没有任何注册点 —— 死了
 *   3. 将来有人去补实现时，看到"它已经在 publicPaths 里了"，
 *      自然地认为"这条本来就该公开"，于是不再加鉴权
 *   4. 而"按订单序列号查订单"一旦真的公开，就是订单信息泄露
 *
 * 死条目本身不产生漏洞，它产生的是**一个让人误判的信号**。
 * 所以规则是：白名单里只允许出现当前真的注册了的路由。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const authService = fs.readFileSync(path.join(root, 'server', 'services', 'auth-service.js'), 'utf8')

/** 从 middleware 里切出 publicPaths 那个数组字面量（注释已剥掉）。 */
function extractPublicPaths () {
  const start = authService.indexOf('const publicPaths = new Set([')
  assert.ok(start >= 0, 'auth-service.js 里找不到 publicPaths —— 改名了？测试要同步更新')
  const open = authService.indexOf('[', start)
  let depth = 0
  let end = -1
  for (let i = open; i < authService.length; i++) {
    if (authService[i] === '[') depth++
    else if (authService[i] === ']') {
      depth--
      if (depth === 0) { end = i + 1; break }
    }
  }
  assert.ok(end > open, 'publicPaths 数组没配平')
  return stripComments(authService.slice(open, end))
}

/**
 * 剥掉 // 与 /* *\/ 注释。
 *
 * 不剥的话，注释里引用的路径（比如"原来这里写过 /order/xxx"）会被当成
 * 真实条目 —— 说明文字把自己写成了被测对象。
 */
function stripComments (src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 从一段源码字面量里取出所有路径字符串。 */
function pathsIn (literal) {
  return [...literal.matchAll(/['"`]([^'"`]+)['"`]/g)]
    .map(m => m[1])
    .filter(p => p.startsWith('/'))
}

/**
 * 收集全项目所有已注册的路由路径。
 *
 * 只看 server/routes 与 server/register-production-api.js —— 那才是真正的注册面。
 */
function collectRegisteredPaths () {
  const files = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const stat = fs.statSync(full)
      if (stat.isDirectory()) walk(full)
      else if (name.endsWith('.js')) files.push(full)
    }
  }
  walk(path.join(root, 'server', 'routes'))

  const registered = new Set()
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    // 同时匹配 router.get('/x') 与 router.get(`/x`)；参数化路径保留原样。
    for (const m of src.matchAll(/router\.(get|post|put|delete|patch|all)\(\s*['"`]([^'"`]+)['"`]/g)) {
      registered.add(m[2].replace(/\/+$/, '') || '/')
    }
  }
  return registered
}

test('公空白名单里的每一条都必须真的注册过', () => {
  const listed = pathsIn(extractPublicPaths())
  const registered = collectRegisteredPaths()

  const dead = listed.filter(p => !registered.has(p))
  assert.deepEqual(dead, [],
    '白名单里有从未实现的路径。它会让人以为"这条本来就该公开"，' +
    '将来补实现时自然跳过鉴权。要么实现，要么从白名单删掉。')
})

test('★ 旧的订单类公开路径不得回到白名单里', () => {
  // 这几条来自旧项目官网，按序列号就能查订单 —— 一旦公开就是信息泄露。
  // 当前全项目没有实现；如果哪天真要加，必须同时补鉴权并按需修改本测试。
  const banned = [
    '/order/selectOrderBySerialNumber',
    '/order/checkSharePwd',
    '/orderDetails/shareOrder',
    '/orderDetails/getOrderFans',
    '/orderDetails/getTodayFansCount'
  ]
  const listed = new Set(pathsIn(extractPublicPaths()))

  for (const p of banned) {
    assert.equal(listed.has(p), false,
      p + ' 不该出现在公空白名单里 —— 它是按订单标识查数据的接口')
  }
})

test('白名单不能为空（否则所有接口都需要登录，登录接口自己也会被拦）', () => {
  const listed = pathsIn(extractPublicPaths())
  assert.ok(listed.length >= 5, '连登录接口都不在白名单里，用户永远登不进来')
})

test('登录类接口必须在白名单里', () => {
  const listed = new Set(pathsIn(extractPublicPaths()))
  for (const p of ['/login', '/client/login', '/admin/login', '/admin/login/totp']) {
    assert.equal(listed.has(p), true, p + ' 不在白名单里，这条路径永远 401')
  }
})
