'use strict'

/**
 * 把当前请求匹配到某个 Express 路由模板。
 *
 * ## 为什么需要这个东西
 *
 * 能力表是按 **`METHOD /admin/users/:id`** 这种模板登记的，但中间件运行时
 * 手上只有真实 URL（`/admin/users/42`）。要查表就必须先把真实 URL 还原成模板。
 *
 * Express 自己提供 `req.route`，但它**只在进入 handler 之后才存在** ——
 * 鉴权中间件跑在那之前，拿不到。所以只能自己遍历 router.stack。
 *
 * ## 为什么不用"前缀匹配"凑合
 *
 * 上一个漏洞就是这么来的：`/admin/staff` 和 `/admin/staffx` 被当成一回事。
 * 这里直接用 Express 自己的 matcher（Express 5 的 `layer.matchers`），
 * 规则与实际路由**完全同一套**，不会出现第二套口径。
 *
 * 实测（Express 5.2.1）：
 *   layer.matchers[0] 是一个函数，命中时返回 { path, params }，否则返回 false。
 *   Express 4 是 layer.regexp.test()，这里两个版本都兼容，避免升级时静默失效。
 */

/**
 * 拿到一个 Express 应用/路由的 layer 列表。
 *
 * Express 5 把 `app.stack` 移到了 `app.router.stack`（app.router 是个函数对象，
 * 上面挂着 stack）。Router 实例仍然有 `.stack`。
 * 这个差异极其隐蔽：写错就是**永远匹配不到路由**，表现为所有 admin 接口 403。
 */
function layersOf (host) {
  if (!host) return []
  if (Array.isArray(host.stack)) return host.stack
  if (host.router && Array.isArray(host.router.stack)) return host.router.stack
  return []
}

/**
 * @param {import('express').Application|import('express').Router} host
 * @param {string} method
 * @param {string} urlPath 不含 query。挂载在 router 上时传相对路径（'/admin/users/42'），
 *                         挂载在 app 上时传完整路径（'/apis/admin/users/42'）
 * @param {string} [stripPrefix] 当 host 是 app 时，需要从 urlPath 前面剥掉的前缀（如 '/apis'）
 * @returns {string|null} 路由模板，如 '/admin/users/:id'
 */
function matchRouteTemplate (host, method, urlPath, stripPrefix) {
  const want = String(method || '').toUpperCase()
  let target = urlPath
  if (stripPrefix && target.startsWith(stripPrefix)) {
    target = target.slice(stripPrefix.length) || '/'
  }
  for (const layer of layersOf(host)) {
    // 只关心真正的路由层（纯中间件层没有 .route）
    if (!layer.route) continue
    const route = layer.route
    const methods = Object.keys(route.methods || {}).map(m => m.toUpperCase())
    // router.all() 注册的层 method 是 _ALL，视为全方法
    const isAll = methods.includes('_ALL')
    if (!isAll && !methods.includes(want) && !methods.includes('ALL')) continue
    if (matchesLayer(layer, target)) return route.path
  }
  return null
}

/** 优先用 Express 5 的 matcher，退化到 Express 4 的 regexp。 */
function matchesLayer (layer, urlPath) {
  const matcher = Array.isArray(layer.matchers) ? layer.matchers[0] : null
  if (typeof matcher === 'function') {
    const hit = matcher(urlPath)
    return Boolean(hit)
  }
  if (matcher && typeof matcher.test === 'function') {
    matcher.lastIndex = 0
    return matcher.test(urlPath)
  }
  // Express 4
  const re = layer.regexp
  if (!re || typeof re.test !== 'function') return false
  re.lastIndex = 0
  if (re.test(urlPath)) return true
  if (!urlPath.endsWith('/')) {
    re.lastIndex = 0
    return re.test(urlPath + '/')
  }
  return false
}

module.exports = { matchRouteTemplate }
