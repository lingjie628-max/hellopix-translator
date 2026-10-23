/**
 * 能力授权模型 —— 2026-10-23 入侵后的架构重建。
 *
 * ## 上一版的毛病
 *
 * 授权规则是 auth-service.js 里一个 4 元素数组 + "非 GET 一律 403"：
 *
 *     const superOnly = ['/admin/staff','/admin/users','/admin/subs','/admin/translate/grant']
 *
 * 结果：55 个 /admin 路由里，**19 个对 operator 完全敞开**，包括
 *   GET /admin/customers/:id  全站客户名单 + 对话内容 + 跨商户共享关系
 *   GET /admin/logs           所有管理员的操作和 IP
 *   GET /admin/scripts        运维脚本清单
 *
 * 更根本的是：新加一个接口时，授权那边**不会自动知道它存在** ——
 * 它默认落进"GET 放行"那一档。这是 fail-open。
 *
 * ## 这一版
 *
 * 每个路由必须在 lib/capabilities.js 里显式声明能力，按
 * `METHOD + 路由模板` 精确查表。查不到 = 拒绝。这是 fail-closed。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')

const {
  ROUTE_CAPS, OPERATOR_CAPS, HIGH_RISK_CAPS, capabilityFor, requiresReauth, allows
} = require('../server/lib/capabilities')
const { matchRouteTemplate } = require('../server/lib/route-match')

const SUPER = { id: 1, role: 'superadmin', username: 'pix' }
const OPERATOR = { id: 2, role: 'operator', username: 'staff' }

// ── 能力表完整性 ──────────────────────────────────────────

test('能力表里每条都是 "METHOD /path" 形式且方法合法', () => {
  const ok = /^(GET|POST|PUT|DELETE|PATCH) \/[A-Za-z0-9_\-/:.]*$/
  for (const key of Object.keys(ROUTE_CAPS)) {
    assert.match(key, ok, `能力表 key 格式不对: ${key}`)
  }
})

test('能力表里没有重复登记同一个 METHOD+path', () => {
  const seen = new Set()
  for (const key of Object.keys(ROUTE_CAPS)) {
    assert.ok(!seen.has(key), `重复登记: ${key}`)
    seen.add(key)
  }
})

test('每个 admin 路由的能力名都以 admin. 开头', () => {
  for (const [key, cap] of Object.entries(ROUTE_CAPS)) {
    if (!key.includes(' /admin/')) continue
    assert.match(cap, /^admin\./, `${key} 的能力名应为 admin.*，实际是 ${cap}`)
  }
})

// ── 核心：operator 不能再碰客户数据 / 审计 / 运维 ──────────

test('operator 读全站客户数据 → 拒绝（上一版的最大口子）', () => {
  for (const [method, path] of [
    ['GET', '/admin/customers'],
    ['GET', '/admin/customers/:id'],
    ['GET', '/admin/fans'],
    ['GET', '/admin/merge-candidates'],
    ['GET', '/admin/collisions']
  ]) {
    const cap = capabilityFor(method, path)
    assert.ok(cap, `${method} ${path} 必须有能力声明`)
    const v = allows(OPERATOR, cap)
    assert.equal(v.allowed, false, `${method} ${path} 不该对 operator 开放`)
    assert.equal(v.reason, 'OPERATOR_DENIED')
  }
})

test('operator 读审计日志 → 拒绝（里面是超管的 IP 和操作序列）', () => {
  const v = allows(OPERATOR, capabilityFor('GET', '/admin/logs'))
  assert.equal(v.allowed, false)
})

test('operator 读运维脚本清单 / SMTP 配置 / 全局设置 → 拒绝', () => {
  for (const [method, path] of [
    ['GET', '/admin/scripts'],
    ['GET', '/admin/mail'],
    ['GET', '/admin/settings'],
    ['GET', '/admin/verify']
  ]) {
    const v = allows(OPERATOR, capabilityFor(method, path))
    assert.equal(v.allowed, false, `${method} ${path} 不该对 operator 开放`)
  }
})

test('operator 创建/修改管理员 → 拒绝，且属于高危能力', () => {
  const cap = capabilityFor('POST', '/admin/staff/save')
  assert.equal(allows(OPERATOR, cap).allowed, false)
  assert.ok(HIGH_RISK_CAPS.has(cap), '建超管必须标为高危')
})

test('operator 重置商户密码 / 删商户 → 拒绝', () => {
  for (const path of ['/admin/users/resetPassword', '/admin/users/delete', '/admin/users/save']) {
    assert.equal(allows(OPERATOR, capabilityFor('POST', path)).allowed, false, path)
  }
})

test('operator 能动钱的接口 → 拒绝', () => {
  for (const path of [
    '/admin/recharges/status',
    '/admin/recharge-exceptions/resolve',
    '/admin/translate/grant',
    '/admin/users/enterprise',
    '/admin/users/expiry',
    '/admin/packages/save'
  ]) {
    assert.equal(allows(OPERATOR, capabilityFor('POST', path)).allowed, false, path)
  }
})

// ── operator 该有的不能误伤 ───────────────────────────────

test('operator 仍能做日常运营：看统计 / 充值单 / 翻译记录 / 通道状态', () => {
  for (const [method, path] of [
    ['GET', '/admin/stats'],
    ['GET', '/admin/recharges'],
    ['GET', '/admin/recharge-exceptions'],
    ['GET', '/admin/translate/logs'],
    ['GET', '/admin/engines'],
    ['GET', '/admin/packages'],
    ['GET', '/admin/faqs']
  ]) {
    assert.equal(allows(OPERATOR, capabilityFor(method, path)).allowed, true, `${method} ${path} 应允许 operator`)
  }
})

test('每个 operator 能力都在能力表里真的被用到（不留死能力）', () => {
  const used = new Set(Object.values(ROUTE_CAPS))
  for (const cap of OPERATOR_CAPS) {
    assert.ok(used.has(cap), `OPERATOR_CAPS 里的 ${cap} 没有任何路由在用`)
  }
})

// ── superadmin 全能 ──────────────────────────────────────

test('superadmin 通过所有已登记能力', () => {
  for (const [key, cap] of Object.entries(ROUTE_CAPS)) {
    assert.equal(allows(SUPER, cap).allowed, true, `${key} 应允许 superadmin`)
  }
})

test('没有身份 → 一律拒绝', () => {
  for (const bad of [null, undefined, {}, { role: '' }]) {
    const v = allows(bad, 'admin.read.overview')
    assert.equal(v.allowed, false)
    assert.equal(v.reason, 'NO_IDENTITY')
  }
})

test('未知角色 → 拒绝（不给"没写 role 就当超管"留后门）', () => {
  for (const role of ['', ' ', 'Operator', 'root', 'ADMIN', 'superadmin ']) {
    assert.equal(allows({ role }, 'admin.secret.audit').allowed, false, `role=${JSON.stringify(role)}`)
  }
})

// ── 未声明的路由必须失败 ─────────────────────────────────

test('未声明的路由 capabilityFor 返回 null（fail-closed 的前提）', () => {
  for (const [method, path] of [
    ['GET', '/admin/not-a-real-route'],
    ['POST', '/admin/staff/save/extra'],
    ['DELETE', '/admin/users/:id'],
    ['GET', '/admin/staffx']
  ]) {
    assert.equal(capabilityFor(method, path), null, `${method} ${path} 不该有声明`)
  }
})

// ── 路由模板匹配：必须和 Express 同一套口径 ───────────────

function routerOf (routes) {
  const r = express.Router()
  for (const [m, p] of routes) r[m.toLowerCase()](p, (_q, _s) => {})
  return r
}

test('真实 URL 能还原成登记用的模板', () => {
  const r = routerOf([
    ['GET', '/admin/users/:id'],
    ['POST', '/admin/staff/save'],
    ['GET', '/admin/customers/:id']
  ])
  assert.equal(matchRouteTemplate(r, 'GET', '/admin/users/42'), '/admin/users/:id')
  assert.equal(matchRouteTemplate(r, 'POST', '/admin/staff/save'), '/admin/staff/save')
  assert.equal(matchRouteTemplate(r, 'GET', '/admin/customers/7'), '/admin/customers/:id')
})

test('大小写混写的 URL 也能还原（否则鉴权查不到表）', () => {
  const r = routerOf([['POST', '/admin/staff/save']])
  for (const p of ['/ADMIN/staff/save', '/Admin/Staff/Save', '/admin/STAFF/SAVE']) {
    assert.equal(matchRouteTemplate(r, 'POST', p), '/admin/staff/save', p)
  }
})

test('尾斜杠不影响匹配', () => {
  const r = routerOf([['GET', '/admin/users/:id']])
  assert.equal(matchRouteTemplate(r, 'GET', '/admin/users/42/'), '/admin/users/:id')
})

test('不做前缀匹配：/admin/staffx 不等于 /admin/staff', () => {
  const r = routerOf([['GET', '/admin/staff']])
  assert.equal(matchRouteTemplate(r, 'GET', '/admin/staffx'), null)
  assert.equal(matchRouteTemplate(r, 'GET', '/admin/staff/extra'), null)
})

test('方法不匹配时返回 null（GET 路由不认 POST）', () => {
  const r = routerOf([['GET', '/admin/staff']])
  assert.equal(matchRouteTemplate(r, 'POST', '/admin/staff'), null)
})

test('模板还原后再查能力表，链路是通的', () => {
  const r = routerOf([['GET', '/admin/customers/:id']])
  const template = matchRouteTemplate(r, 'GET', '/admin/customers/99')
  assert.equal(capabilityFor('GET', template), 'admin.data.customers')
  assert.equal(allows(OPERATOR, 'admin.data.customers').allowed, false)
})

// ── 新 IP 登录提醒 ───────────────────────────────────────
//
// 2026-10-23 入侵后加的观测：登录成功后，如果这个 IP 是该管理员 30 天内
// 没见过的，写一条醒目审计。它不是门禁（出差换网很正常），但能让运营在
// 日志里一眼看到"这个账号刚从没见过的 IP 登进来了"。

test('30 天内没见过的 IP → 写一条"新 IP 登录提醒"审计', async () => {
  const { AuthService } = require('../server/services/auth-service')
  const svc = Object.create(AuthService.prototype)
  const audits = []
  svc.repository = {
    // 查历史：没有任何记录
    query: async () => ({ rowCount: 0, rows: [] }),
    audit: async (_c, _a, action, detail, ip) => { audits.push({ action, detail, ip }) }
  }
  await svc.flagNewLoginIp({ id: 1, username: 'pix' }, '203.0.113.9')
  assert.equal(audits.length, 1)
  assert.equal(audits[0].action, '新 IP 登录提醒')
  assert.match(audits[0].detail, /203\.0\.113\.9/)
})

test('见过的 IP 不重复告警（避免每次登录都刷屏）', async () => {
  const { AuthService } = require('../server/services/auth-service')
  const svc = Object.create(AuthService.prototype)
  const audits = []
  svc.repository = {
    query: async () => ({ rowCount: 1, rows: [{}] }),
    audit: async (_c, _a, action) => { audits.push(action) }
  }
  await svc.flagNewLoginIp({ id: 1 }, '203.0.113.9')
  assert.deepEqual(audits, [])
})

test('IP 查询出错不能把登录搞挂（观测失败不阻断）', async () => {
  const { AuthService } = require('../server/services/auth-service')
  const svc = Object.create(AuthService.prototype)
  svc.repository = {
    query: async () => { throw new Error('db down') },
    audit: async () => {}
  }
  // 不抛异常即为通过
  await svc.flagNewLoginIp({ id: 1 }, '203.0.113.9')
})

test('非法 IP / 空 IP 直接跳过，不去打数据库', async () => {
  const { AuthService } = require('../server/services/auth-service')
  const svc = Object.create(AuthService.prototype)
  let queried = 0
  svc.repository = {
    query: async () => { queried++; return { rowCount: 0 } },
    audit: async () => {}
  }
  await svc.flagNewLoginIp({ id: 1 }, '')
  await svc.flagNewLoginIp({ id: 1 }, 'not-an-ip')
  assert.equal(queried, 0, '非法 IP 不该进 SQL（$2::inet 会抛错，等于静默失效）')
})

// ── 读 / 写 高危分级 ─────────────────────────────────────

/**
 * 2026-10-23 事故：`GET /admin/mail` 和 `POST /admin/mail` 共用
 * `admin.secret.mail`，而它在 HIGH_RISK_CAPS 里 —— 于是**只是打开邮件设置页**
 * 也要带 X-Pix-Reauth（管理员密码）。
 *
 * 前端从不带，接口回 428，表单全空白，页面显示"邮件服务未配置 / 缺：未知"，
 * 而库里 SMTP 配置完好（vlen=179）。运维会以为配置丢了。
 *
 * 这里守的规则：**只读接口不该要求二次认证；改动密钥的接口必须要求。**
 */

test('读邮件配置不要求二次认证（否则打开设置页就 428）', () => {
  const cap = capabilityFor('GET', '/admin/mail')
  assert.ok(cap, 'GET /admin/mail 必须声明能力')
  assert.equal(HIGH_RISK_CAPS.has(cap), false,
    `GET /admin/mail 用的是高危能力 ${cap}，会导致后台整页空白`)
})

test('写邮件配置仍然要求二次认证（能劫持全部验证邮件 = 接管账号）', () => {
  const cap = capabilityFor('POST', '/admin/mail')
  assert.ok(cap, 'POST /admin/mail 必须声明能力')
  assert.equal(HIGH_RISK_CAPS.has(cap), true)
})

test('发测试信仍是高危：它按调用方给的地址真发信，等于免费发信通道', () => {
  const cap = capabilityFor('POST', '/admin/mail/test')
  assert.ok(cap)
  assert.equal(HIGH_RISK_CAPS.has(cap), true)
})

test('读邮件配置的能力不给 operator（SMTP 与告警邮箱是超管的东西）', () => {
  const cap = capabilityFor('GET', '/admin/mail')
  assert.equal(OPERATOR_CAPS.has(cap), false)
  assert.equal(allows(OPERATOR, cap).allowed, false)
  assert.equal(allows(SUPER, cap).allowed, true)
})

test('通用不变量：所有只读 GET 都不要求二次认证（否则页面永久空白）', () => {
  const offenders = []
  for (const [route, cap] of Object.entries(ROUTE_CAPS)) {
    if (!route.startsWith('GET ')) continue
    if (!requiresReauth('GET', cap)) continue
    offenders.push(`${route} → ${cap}`)
  }
  assert.deepEqual(offenders, [],
    '这些 GET 路由要求二次认证，前端无法带密码，会导致页面对应区域永久空白：\n' + offenders.join('\n'))
})

test('通用不变量：所有写操作若命中高危能力，必须要求二次认证', () => {
  const offenders = []
  for (const [route, cap] of Object.entries(ROUTE_CAPS)) {
    if (!/^(POST|PUT|DELETE|PATCH) /.test(route)) continue
    if (!HIGH_RISK_CAPS.has(cap)) continue
    if (requiresReauth(route.split(' ')[0], cap)) continue
    offenders.push(`${route} → ${cap}`)
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))
})

test('requiresReauth：写入要求、读取豁免、探测豁免', () => {
  const secret = 'admin.secret.mail'
  assert.equal(requiresReauth('POST', secret), true)
  assert.equal(requiresReauth('PUT', secret), true)
  assert.equal(requiresReauth('DELETE', secret), true)
  assert.equal(requiresReauth('GET', secret), false)
  assert.equal(requiresReauth('HEAD', secret), false)
  assert.equal(requiresReauth('OPTIONS', secret), false)
  // 非高危能力，无论什么方法都不需要
  assert.equal(requiresReauth('POST', 'admin.read.faq'), false)
  // 大小写不敏感：Express 路由本身不分大小写，判定不能比路由严
  assert.equal(requiresReauth('post', secret), true)
})

test('读用的能力不被写操作复用（否则一改读的档位就漏了写）', () => {
  assert.notEqual(capabilityFor('GET', '/admin/mail'), capabilityFor('POST', '/admin/mail'))
})
