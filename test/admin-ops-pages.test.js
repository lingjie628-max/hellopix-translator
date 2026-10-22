'use strict'

/**
 * 运营两页（在线账号 / 进粉统计）守卫。
 *
 * ## 背景
 *
 * 这两页原来查旧「工单」模型的 `order_details` / `order_fans`，
 * 而那套模型在当前产品里已经不存在 —— 生产库那几张表**一行数据都没有**，
 * 于是接口干脆没实现，直接注册成桩，运营点进去只能看到
 * 503「该兼容模块尚未迁移到 PostgreSQL」。
 *
 * 现在改成读新客户模型的 `conversations` / `customers`。
 *
 * 这个文件盯三件事：
 *   1. 这两条路径**不许再回到桩清单里**
 *   2. 页面**不许再直接读 status**式的旧字段（必须用新模型的列）
 *   3. 已删除的旧工单模块**不许被顺手加回来**
 *
 * 第 3 条尤其重要：那套页面调的 20 多个接口后端一个都没实现，
 * 加回来就是给自己造一批报错页。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const { readAllRoutes, routeBlock } = require('./helpers/route-source')

// 路由已按域拆分，读整个 routes 目录；单条路由用 routeBlock 精确切出
const routeSource = readAllRoutes()

test('在线账号 / 进粉统计 不再走桩', () => {
  // 取出 unmigrated 数组的原文
  const m = /const unmigrated = \[([\s\S]*?)\]/.exec(routeSource)
  assert.ok(m, '找不到 unmigrated 数组')
  const list = m[1]
  assert.doesNotMatch(list, /'\/admin\/accounts'/, '/admin/accounts 又回到桩清单里了')
  assert.doesNotMatch(list, /'\/admin\/fans'/, '/admin/fans 又回到桩清单里了')
})

test('两条路径都有真实实现（GET）', () => {
  assert.match(routeSource, /router\.get\('\/admin\/accounts',\s*asyncRoute/, '缺少 /admin/accounts 实现')
  assert.match(routeSource, /router\.get\('\/admin\/fans',\s*asyncRoute/, '缺少 /admin/fans 实现')
})

test('实现读的是新客户模型，不是那几张空表', () => {
  // 原来靠"从 /admin/accounts 到 function safeParse"取段，
  // 拆模块后 safeParse 与路由已不在同一文件，改用括号配平精确切出单条路由
  const block = routeBlock('get', '/admin/accounts')
  assert.ok(block, '定位不到 /admin/accounts 的实现')

  assert.match(block, /FROM conversations/, '应当从 conversations 取数')
  assert.match(block, /LEFT JOIN customers/, '应当关联 customers')
  assert.match(block, /customer_owners/, '应当关联 customer_owners 拿归属')

  // 旧工单模型的表在这两页里不许再出现
  assert.doesNotMatch(block, /order_details/, '又去查空的 order_details 了')
  assert.doesNotMatch(block, /order_fans/, '又去查空的 order_fans 了')
  assert.doesNotMatch(block, /\borders\b/, '又去查空的 orders 了')
})

test('筛选条件真的参与 SQL，而不是只在参数里传', () => {
  // 曾经的坑：把窗口分钟数当 $1 传，但无筛选时 count 查询里根本不出现 $1，
  // pg 直接报 "bind message supplies 1 parameters, but prepared statement requires 0"。
  // 现在改成带整数校验的内联常量。
  assert.match(routeSource, /const ONLINE_WINDOW_SQL = Number\.isInteger\(/, '窗口常量缺少整数校验')
  const block = routeBlock('get', '/admin/accounts')
  assert.ok(block, '定位不到 /admin/accounts 的实现')
  assert.doesNotMatch(block, /\$1 \|\| ' minutes'/, '窗口又变成绑定参数了（会触发参数个数不匹配）')
  assert.match(block, /interval '\$\{ONLINE_WINDOW_SQL\} minutes'/, '窗口应内联且来自受校验的常量')
})

test('重粉判定与「被见到次数」同源，不会各算各的', () => {
  const block = routeBlock('get', '/admin/fans')
  assert.ok(block, '定位不到 /admin/fans 的实现')
  assert.match(block, /const seenCount = `\(SELECT count\(\*\) FROM conversations c2 WHERE c2\.customer_id = c\.customer_id\)`/,
    '重粉应基于「同一 customer 被几个会话见过」')
  assert.match(block, /const fanTypeExpr = `CASE WHEN c\.customer_id IS NOT NULL AND \$\{seenCount\} > 1 THEN '重粉' ELSE '新粉' END`/,
    '新粉/重粉的判定表达式变了')
  // 两处必须复用同一个表达式，否则列表显示与筛选结果会互相矛盾
  const uses = block.split('${fanTypeExpr}').length - 1
  assert.ok(uses >= 2, `fanTypeExpr 应被筛选与查询共用，实际只用了 ${uses} 次`)
})

test('前端两页消费的是新字段', () => {
  const accounts = fs.readFileSync(path.join(root, 'src/components/admin/AdminAccounts.vue'), 'utf8')
  const fans = fs.readFileSync(path.join(root, 'src/components/admin/AdminFans.vue'), 'utf8')

  // 只看 <template> —— 那是真正渲染给用户的部分。
  // 注释里保留旧字段名是**故意**的（用来解释这一页曾经查错表），
  // 拿整个文件去断言会把这段历史说明误判成"还在展示旧字段"。
  const templateOf = src => {
    const m = /<template>([\s\S]*?)<\/template>/.exec(src)
    assert.ok(m, '提取不到 <template>')
    return m[1]
  }
  for (const [name, src] of [['AdminAccounts.vue', accounts], ['AdminFans.vue', fans]]) {
    const tpl = templateOf(src)
    assert.doesNotMatch(tpl, /工单号/, `${name} 还在展示「工单号」`)
    assert.doesNotMatch(tpl, /orderNum/, `${name} 还在用 orderNum`)
    assert.doesNotMatch(tpl, /当日进粉/, `${name} 还在展示「当日进粉」`)
    assert.doesNotMatch(tpl, /占用端口/, `${name} 还在展示「占用端口」`)
    assert.doesNotMatch(tpl, /主号/, `${name} 还在展示「主号」`)
  }

  assert.match(accounts, /onlineStatus/, '在线账号页缺少 onlineStatus')
  assert.match(accounts, /lastMessageAt/, '在线账号页缺少 lastMessageAt')
  assert.match(fans, /fanType/, '进粉统计页缺少 fanType')
  assert.match(fans, /seenCount/, '进粉统计页缺少 seenCount')
})

test('已删除的旧工单模块没有被加回来', () => {
  const routerSource = fs.readFileSync(path.join(root, 'src/router/index.js'), 'utf8')

  const removedRoutes = [
    '/order/info', '/order/details', '/order/fans', '/order/detailsLog',
    '/order/userLogin', '/short/link', '/assistant/Group',
    '/order/shareDetails', '/order/shareFans'
  ]
  for (const r of removedRoutes) {
    assert.ok(!routerSource.includes(`path: '${r}'`), `旧工单路由 ${r} 又被加回来了`)
  }

  const removedDirs = ['src/components/order', 'src/components/shortLink', 'src/components/assistant']
  for (const d of removedDirs) {
    assert.equal(fs.existsSync(path.join(root, d)), false,
      `${d} 又被建回来了 —— 那套页面调的接口后端一个都没实现，加回来只会多一批报错页`)
  }
})

test('已删除模块引用的桩接口仍然存在（不能顺手删掉后端桩）', () => {
  // 前端删了，后端那些桩要留着：万一有老客户端或外链直接打这些路径，
  // 得到的应该是「未迁移」这个明确答复，而不是 404「接口不存在」。
  for (const p of ['/order/setDistributionMode', '/orderDetails/getOrderDetails', '/shortLink/getShortLink']) {
    assert.ok(routeSource.includes(`'${p}'`), `桩路径 ${p} 不应被删除`)
  }
})

test('API 响应禁止浏览器缓存（否则后台会端出旧数据）', () => {
  // 真实事故：接口修好、代码也部署了，但运营页面仍是旧的 503 报错 ——
  // 因为 Express 默认发的弱 ETag 让浏览器做了启发式缓存，
  // 之后每次带 If-None-Match 拿到 304，浏览器就把本地那份旧 JSON 端出来。
  // 会话相关的接口更危险：可能端出上一个会话的响应体。
  const source = fs.readFileSync(path.join(root, 'server/register-production-api.js'), 'utf8')
  assert.match(source, /app\.use\('\/apis',\s*\(_req, res, next\)\s*=>\s*\{/, '缺少 /apis 的缓存头中间件')
  assert.match(source, /Cache-Control',\s*'no-store/, 'API 响应必须带 no-store')
  assert.match(source, /'Pragma',\s*'no-cache'/, '缺少 Pragma: no-cache（照顾老客户端）')

  // 这个中间件必须挂在路由**之前**，否则响应已经生成，头加不上
  const guardAt = source.indexOf("app.use('/apis', (_req, res, next)")
  const routerAt = source.indexOf("app.use('/apis', productionRouter(")
  assert.ok(guardAt > 0 && routerAt > guardAt, 'no-store 中间件必须注册在 productionRouter 之前')

  // 静态资源不能被一起关掉缓存 —— 那是应该缓存的
  assert.doesNotMatch(source, /app\.use\(\(_req, res, next\)\s*=>\s*\{\s*res\.set\('Cache-Control',\s*'no-store/,
    'no-store 不能挂在全局，会把 dist/ 静态资源的缓存也关掉')
})
