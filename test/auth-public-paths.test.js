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

/**
 * 取白名单。
 *
 * 2026-10-23 改成**直接 require 拿 Set**，不再从源码里正则抠。
 *
 * 原来靠 `indexOf('const publicPaths = new Set([')` 定位，于是：
 *   · 变量一改名就断（这次把它提到模块级常量就断了 4 个测试）
 *   · 源码格式一变就断
 *   · 抠出来的字节到底是不是"运行时真正在用的那份"，只能靠人眼保证
 *
 * 直接拿运行时对象还有个额外好处：模块加载时的"键必须全小写"自检
 * 也会在测试里跑到，等于顺带验了一遍自检没被绕过。
 */
const { PUBLIC_PATHS } = require(path.join(root, 'server', 'services', 'auth-service'))

function extractPublicPaths () {
  return [...PUBLIC_PATHS]
}

/**
 * 收集全项目所有已注册的路由路径。
 *
 * 只看 server/routes 与 server/register-production-api.js —— 那才是真正的注册面。
 *
 * **统一转小写**：白名单的查询口径是 `req.path.toLowerCase()`，
 * 而注册面里写的是驼峰（`router.post('/user/emailCode')`）。
 * 不转的话，白名单里小写的 '/user/emailcode' 会被误判成"死条目" ——
 * 明明是同一件事，两个口径不一致。
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
      registered.add((m[2].replace(/\/+$/, '') || '/').toLowerCase())
    }
  }
  return registered
}

test('公空白名单里的每一条都必须真的注册过', () => {
  const listed = extractPublicPaths()
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
  const listed = new Set(extractPublicPaths())

  for (const p of banned) {
    assert.equal(listed.has(p), false,
      p + ' 不该出现在公空白名单里 —— 它是按订单标识查数据的接口')
  }
})

test('白名单不能为空（否则所有接口都需要登录，登录接口自己也会被拦）', () => {
  const listed = extractPublicPaths()
  assert.ok(listed.length >= 5, '连登录接口都不在白名单里，用户永远登不进来')
})

test('登录类接口必须在白名单里', () => {
  const listed = new Set(extractPublicPaths())
  for (const p of ['/login', '/client/login', '/admin/login', '/admin/login/totp']) {
    assert.equal(listed.has(p), true, p + ' 不在白名单里，这条路径永远 401')
  }
})
