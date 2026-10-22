'use strict'

/**
 * 读取路由层全部源码，拼成一份文本供静态断言使用。
 *
 * ## 为什么要有这个文件
 *
 * 有一批测试不执行路由，而是**读源码做静态断言** ——
 * 例如「/admin/stats 必须回前端要用的每一个字段」、
 * 「/admin/verify/save 真的把 SMTP 字段写进 mail.smtp」。
 * 这类断言守的是"代码里有没有这件事"，比跑一遍接口更容易定位回归。
 *
 * 但 `production.js` 正在按域拆成多个模块。测试若钉死单个文件，
 * 每拆一次就会假红一批 —— 而且修法往往是"把断言删掉"，那等于把守卫拆没了。
 *
 * 所以统一走这里：整目录读进来拼接，拆分前后断言都成立。
 *
 * ## 注意
 *
 * 拼接后不同文件的行会连在一起，**不要**用带 `^`/`$` 锚点的多行正则去匹配；
 * 单行内的子串匹配不受影响。需要精确定位时用 `readRoute(file)` 单独读。
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const ROUTES_DIR = path.join(ROOT, 'server', 'routes')

/** 递归列出路由目录下所有 .js（含 admin/ 子目录），按相对路径排序 */
function listRouteFiles(dir = ROUTES_DIR, prefix = '') {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isDirectory()) {
      // 子目录同样展开：admin.js 已按业务域拆成 admin/*.js，
      // 只读顶层会让那些断言全部假红（换成删断言就等于把守卫拆了）
      out.push(...listRouteFiles(path.join(dir, entry.name), prefix + entry.name + '/'))
    } else if (entry.name.endsWith('.js')) {
      out.push(prefix + entry.name)
    }
  }
  return out
}

/** 读单个路由文件，返回源码（可传 `admin/accounts.js` 这样的相对路径） */
function readRoute(file) {
  return fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8')
}

/** 读 routes 目录下所有 .js（递归），按路径排序后拼接 */
function readAllRoutes() {
  return listRouteFiles()
    .map(name => readRoute(name))
    .join('\n')
}

const SERVICES_DIR = path.join(ROOT, 'server', 'services')

/**
 * 读 routes + services 全部源码。
 *
 * 业务逻辑正在从路由层下沉到 service（`packages`/`settings`/`adminAccounts` …）。
 * 静态断言若只扫 routes，每次下沉都会假红 —— 而修法往往是删断言，
 * 那等于把守卫拆掉。凡是想守"这件事代码里做了没有"的断言，用这个。
 */
function readAllServerSource() {
  const services = fs.readdirSync(SERVICES_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map(entry => fs.readFileSync(path.join(SERVICES_DIR, entry.name), 'utf8'))
  return [readAllRoutes()].concat(services).join('\n')
}

/**
 * 取出某个路由处理函数的源码片段。
 *
 * 静态断言经常要检查"某个接口里到底写了什么"，而不是全文件里搜。
 * 全文件搜会误命中：比如 `/admin/users` 和 `/admin/users/save` 里
 * 可能都有 `char_balance`，断言就分不清是哪个接口。
 *
 * 从 `router.<method>('<path>'` 开始，按括号深度找到这条注册语句的结尾。
 *
 * @returns {string|null} 找不到返回 null
 */
function routeBlock(method, routePath) {
  const all = readAllRoutes()
  // 结尾必须紧跟 `'`，否则 '/admin/engines' 会误命中 '/admin/engines/save'
  const needle = `router.${method}('${routePath}'`
  const start = all.indexOf(needle)
  if (start < 0) return null

  // 从左括号开始配平。要跳过字符串、模板串和正则字面量，
  // 否则 SQL 里的括号或 `\/\/` 会打乱深度判断。
  let i = all.indexOf('(', start)
  let depth = 0
  let quote = null
  let inTemplate = 0
  for (; i < all.length; i++) {
    const ch = all[i]
    const next = all[i + 1]
    const prev = all[i - 1]

    if (quote) {
      if (quote === '`') {
        if (ch === '\\') { i++; continue }
        if (ch === '$' && next === '{') { inTemplate++; i++; continue }
        if (ch === '}' && inTemplate > 0) { inTemplate--; continue }
        if (ch === '`' && inTemplate === 0) { quote = null; continue }
        continue
      }
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }

    if (ch === '/' && next === '/') { while (i < all.length && all[i] !== '\n') i++; continue }
    if (ch === '/' && next === '*') { i = all.indexOf('*/', i) + 1; continue }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }

    // 正则字面量：/.../flags。判据是 / 出现在「运算符位置」——
    // 上一个非空白字符是 ( , = : [ ! & | ? { } ; + - * % < > ~ 或空白开头。
    // 否则 `a / b` 的除号会被当成正则开头，把后面的代码全吞掉。
    if (ch === '/') {
      const before = all.slice(Math.max(0, i - 24), i).replace(/\s+$/, '')
      const prevCh = before[before.length - 1]
      const startsRegex = !prevCh || '(,=:[!&|?{};+-*%<>~'.includes(prevCh)
      if (startsRegex) {
        let j = i + 1
        let inClass = false
        while (j < all.length) {
          const c = all[j]
          if (c === '\\') { j += 2; continue }
          if (c === '[') inClass = true
          else if (c === ']') inClass = false
          else if (c === '/' && !inClass) { j++; break }
          else if (c === '\n') break    // 正则不跨行，说明判断错了
          j++
        }
        i = j - 1
        continue
      }
    }

    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) return all.slice(start, i + 1) }
  }
  return null
}

module.exports = { ROOT, ROUTES_DIR, SERVICES_DIR, listRouteFiles, readRoute, readAllRoutes, readAllServerSource, routeBlock }
