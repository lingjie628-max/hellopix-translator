'use strict'

/**
 * 路由拆分的不变量守卫。
 *
 * ## 为什么需要它
 *
 * `production.js`（2283 行 / 95 个路由）正在拆成多个模块。
 * Express 按**注册顺序**匹配路由，一旦顺序变了，可能出现
 *
 *   `/admin/users` 被 `/admin/users/:id` 抢先匹配
 *   （静态段被参数化路由吞掉，表现为"列表页返回了单条记录"）
 *
 * 这类 bug 编译器抓不到、类型检查抓不到、单测也未必覆盖到，
 * 上线后表现还很怪。所以把「路由清单 + 顺序」本身钉成快照。
 *
 * ## 快照怎么维护
 *
 * 有意增删路由时，更新 `EXPECTED` 数组即可。**顺序就是断言的一部分** ——
 * 不要为了让它通过而排序，排序就失去了守卫的意义。
 *
 * ## 为什么用静态解析而不是真正加载 router
 *
 * 真正加载需要 repo / auth / redis 全套依赖，测试环境里跑不起来。
 * 静态提取能看到的就是"注册语句本身"，而那正是顺序的唯一来源。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROUTES_DIR = path.join(__dirname, '..', 'server', 'routes')

/** 参与拆分的路由文件。新增模块时加进来。 */

/**
 * 拆分后 `production.js` 里有多处 `require('./xxx').registerYyy(router, ctx)`，
 * 真正的注册语句在子模块里。为了还原**真实注册顺序**，这里把
 * production.js 里的 "模块挂载" 位置当作锚点，把子模块的路由插回原处。
 *
 * 用通配解析而不是写死列表：以后继续拆模块时，**不需要改测试**，
 * 只要还沿用 `require('./x').registerY(router, ctx)` 这个写法即可。
 */
const MOUNT_RE = /require\('\.\/([\w/-]+)'\)\.(\w+)\(router,\s*ctx\)/

/**
 * 路由文件清单：顶层文件 + `admin/` 子目录。
 *
 * `admin.js` 已按业务域拆成 `admin/{content,dashboard,accounts,clients,ops,settings}.js`。
 * 这里递归收集，以后再加子目录也不用改测试。
 */
function listRouteFiles(dir = ROUTES_DIR, prefix = '') {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isDirectory()) out.push(...listRouteFiles(path.join(dir, entry.name), prefix + entry.name + '/'))
    else if (entry.name.endsWith('.js')) out.push(prefix + entry.name)
  }
  return out
}

const ROUTE_FILES = listRouteFiles()

/** 按函数名切出 auth.js 里某个 register 函数的路由 */
function extractFunctionRoutes(file, fnName) {
  const src = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8')
  const start = src.indexOf(`function ${fnName}(`)
  if (start < 0) return []
  // 到下一个顶层 function 或文件末尾
  const rest = src.slice(start + 10)
  const next = rest.search(/\nfunction /)
  const body = next < 0 ? rest : rest.slice(0, next)
  const re = /router\.(get|post|put|delete|patch|all|use)\(\s*'([^']+)'/g
  const out = []
  let m
  while ((m = re.exec(body))) out.push(`${m[1].toUpperCase()} ${m[2]}`)
  return out
}

/** 从源码里按出现顺序提取路由注册 */
function extract(file) {
  const src = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8')
  const re = /router\.(get|post|put|delete|patch|all|use)\(\s*'([^']+)'/g
  const out = []
  let m
  while ((m = re.exec(src))) out.push(`${m[1].toUpperCase()} ${m[2]}`)
  return out
}

/**
 * 按真实注册顺序提取：逐行扫 production.js，
 * 遇到模块挂载点就展开该函数的路由。
 */
function extractInOrder() {
  const src = fs.readFileSync(path.join(ROUTES_DIR, 'production.js'), 'utf8')
  const lines = src.split('\n')
  const out = []
  const re = /router\.(get|post|put|delete|patch|all|use)\(\s*'([^']+)'/

  for (const line of lines) {
    const hook = MOUNT_RE.exec(line)
    if (hook) {
      const [, mod, fn] = hook
      out.push(...extractFunctionRoutes(`${mod}.js`, fn))
      continue
    }
    const m = re.exec(line)
    if (m) out.push(`${m[1].toUpperCase()} ${m[2]}`)
  }
  return out
}

/**
 * 拆分前（单一 production.js）的完整路由清单，按注册顺序。
 * 这是从 git HEAD 版本静态提取得到的基准。
 */
const EXPECTED = [
  'POST /login',
  'GET /user/captcha',
  'POST /logout',
  'POST /client/login',
  'GET /client/session',
  'POST /client/logout',
  'GET /client/platforms',
  'POST /client/translate-prefs',
  'GET /client/update',
  'POST /client/crash-report',
  'GET /user/dashboard',
  'GET /userVersion/getUserVersion',
  'POST /userVersion/getVersion',
  'GET /userRecharge/getUserRecharge',
  'GET /user/quote',
  'POST /userRecharge/create',
  'GET /team/info',
  'GET /team/subs',
  'POST /team/subs/save',
  'POST /team/subs/chars',
  'POST /team/subs/status',
  'POST /team/subs/delete',
  'POST /team/subs/batch',
  'POST /team/autoAlloc',
  'POST /team/password',
  'POST /team/device/reset',
  'GET /translate/engines',
  'POST /translate/engines/active',
  'POST /translate/run',
  'POST /translate',
  'POST /customer/ingest',
  'GET /customer/reminders',
  'GET /admin/mail',
  'POST /admin/mail',
  'POST /admin/mail/test',
  'GET /admin/customers',
  'GET /admin/customers/:id',
  'GET /admin/merge-candidates',
  'POST /admin/merge-candidates/:id/resolve',
  'GET /admin/collisions',
  'GET /admin/collision-settings',
  'PUT /admin/collision-settings',
  'GET /site/info',
  'GET /site/packages',
  'GET /site/faqs',
  'GET /site/platforms',
  'GET /client/lines',
  'POST /admin/login',
  'POST /admin/login/totp',
  'GET /admin/totp',
  'POST /admin/totp/setup',
  'POST /admin/totp/enable',
  'POST /admin/totp/disable',
  'POST /admin/totp/recovery',
  'POST /admin/logout',
  'GET /admin/stats',
  'GET /admin/users',
  'GET /admin/subs',
  'GET /admin/recharges',
  'GET /admin/recharge-exceptions',
  'POST /admin/recharge-exceptions/resolve',
  'GET /admin/translate/logs',
  'GET /admin/logs',
  'GET /admin/staff',
  'POST /admin/users/status',
  'POST /admin/users/resetPassword',
  'POST /admin/users/expiry',
  'POST /admin/users/enterprise',
  'POST /admin/users/unbind',
  'POST /admin/users/reclaim',
  'POST /admin/users/delete',
  'POST /admin/recharges/status',
  'POST /admin/translate/grant',
  'POST /admin/staff/save',
  'POST /admin/users/save',
  'GET /admin/clients',
  'POST /admin/clients/save',
  'GET /admin/engines',
  'POST /admin/engines/save',
  'POST /admin/engines/active',
  'GET /admin/faqs',
  'POST /admin/faqs/save',
  'GET /admin/links',
  'GET /admin/scripts',
  'GET /admin/accounts',
  'GET /admin/fans',
  'GET /admin/packages',
  'POST /admin/packages/save',
  'GET /admin/settings',
  'POST /admin/settings/save',
  'GET /admin/verify',
  'POST /admin/verify/save',
  'POST /user/emailCode',
  'POST /user/register',
  'POST /user/forgot'
]


/**
 * 兼容期兜底的桩路径清单（顺序即断言内容）。
 * 见下方「未迁移的桩清单不能凭空增减」测试。
 */
const EXPECTED_STUBS = [
  '/order/setDistributionMode',
  '/order/cancelAccount',
  '/order/resetOrder',
  '/order/getAssistantGroupByUserId',
  '/orderDetails/getOrderDetails',
  '/orderDetails/updateRemarks',
  '/orderDetails/deleteOrderDetails',
  '/orderDetails/unbindPort',
  '/orderDetails/setDistribution',
  '/orderDetails/resetOrderDetails',
  '/orderDetails/jump',
  '/userLogin/getUserLogin',
  '/orderTarget/getOrderTarget',
  '/shortLink/getShortLink',
  '/shortLink/getShortLinkInfo',
  '/shortLink/editShortLink',
  '/shortLink/deleteShortLink',
  '/shortLink/addShortLink',
  '/assistant/getAssistantGroup',
  '/assistant/getAssistantDetails',
  '/assistant/deleteAssistantDetails',
  '/assistant/deleteAssistantGroup',
  '/assistant/selectAssistantGroupById',
  '/assistant/editAssistant',
  '/assistant/editAssistantGroup',
  '/weixin/weixinPay',
  '/weixin/checkStatus',
  '/zfb/alipay'
]

/** 按真实注册顺序提取全部路由 */
function extractAll() {
  return extractInOrder()
}

test('路由总数不变', () => {
  assert.equal(extractAll().length, EXPECTED.length,
    `拆分过程中路由数量变了。实际 ${extractAll().length}，期望 ${EXPECTED.length}`)
})

test('路由清单与注册顺序完全一致', () => {
  const actual = extractAll()
  const firstDiff = EXPECTED.findIndex((item, i) => actual[i] !== item)
  if (firstDiff !== -1) {
    // 一次只报第一个差异，并给出上下文 —— 全量 diff 在顺序错位时会淹没重点
    const ctxStart = Math.max(0, firstDiff - 2)
    const ctxEnd = Math.min(EXPECTED.length, firstDiff + 3)
    assert.fail(
      `第 ${firstDiff + 1} 个路由不一致：\n`
      + `  期望: ${EXPECTED[firstDiff]}\n`
      + `  实际: ${actual[firstDiff]}\n`
      + `上下文（期望）:\n${EXPECTED.slice(ctxStart, ctxEnd).map((x, i) => `    ${ctxStart + i + 1}. ${x}`).join('\n')}`
    )
  }
})

test('没有重复注册的路由', () => {
  const all = extractAll()
  const seen = new Map()
  for (const entry of all) {
    const count = (seen.get(entry) || 0) + 1
    seen.set(entry, count)
  }
  const dups = [...seen.entries()].filter(([, n]) => n > 1)
  assert.deepEqual(dups, [], '同一 path+method 被注册了两次，后一个永远不会被命中')
})

test('静态段不能排在参数化路由之后', () => {
  // /admin/users 必须排在 /admin/users/:id 这类之前，
  // 否则列表请求会被参数化路由吞掉。
  const all = extractAll()
  const problems = []
  for (let i = 0; i < all.length; i++) {
    const [method, p] = all[i].split(' ')
    if (!p.includes(':')) continue
    const prefix = p.split('/:')[0]
    // 找有没有同 method 的更长静态路径挂在这个前缀下，且排在它后面
    for (let j = i + 1; j < all.length; j++) {
      const [m2, p2] = all[j].split(' ')
      if (m2 !== method) continue
      if (p2.startsWith(prefix + '/') && !p2.includes(':')) {
        problems.push(`${p2} 排在 ${p} 之后，静态段会被参数化路由吞掉`)
      }
    }
  }
  assert.deepEqual(problems, [])
})

test('拆分后 production.js 不再是巨石', () => {
  const file = path.join(ROUTES_DIR, 'production.js')
  const lines = fs.readFileSync(file, 'utf8').split('\n').length
  // 2026-10-21 拆出 auth.js(173) / admin.js(1669) / context.js(128) 之后为 593 行。
  // 阈值留 100 行余量：只挡住"又把整块功能塞回来"的反弹，
  // 不约束正常增长，否则每次加功能都要改这个数字，守卫就失去意义。
  assert.ok(lines < 700, `production.js 又长回去了：${lines} 行（阈值 700）`)
})

test('未迁移的桩清单不能凭空增减', () => {
  // 这些桩是**兼容期兜底**：老客户端还在调这些接口，删掉会从 503 变成 404，
  // 调用方无法区分"功能未迁移"和"路由不存在"。
  // 拆分模块时最容易顺手把整段 unmigrated 数组删掉，这里钉住它。
  const base = fs.readFileSync(path.join(ROUTES_DIR, 'production.js'), 'utf8')
  const at = base.indexOf('const unmigrated = [')
  assert.ok(at > 0, '找不到 unmigrated 桩清单')
  const block = base.slice(at, base.indexOf(']', at))
  const paths = block.match(/'\/[^']+'/g) || []
  assert.equal(paths.length, EXPECTED_STUBS.length,
    `桩数量变了：实际 ${paths.length}，期望 ${EXPECTED_STUBS.length}`)
  assert.deepEqual(paths.map(p => p.slice(1, -1)), EXPECTED_STUBS,
    '桩清单的内容或顺序变了')
})
