'use strict'

/**
 * 「登录与审计」页的时间列必须真的有值。
 *
 * ## 起因
 *
 * 超管反馈：每一条日志都该有个时间，但页面上时间是空的。
 *
 * 实查是**字段名对不上**：库里时间列叫 `created_at`，`mapRows` 只会
 * 转成 `createdAt`；而 `AdminLogs.vue` 读的是 `loginTime` / `createTime`。
 * 两边永远接不上。
 *
 * 惨的是这个 bug **本地开发看不见**：mock 里那两条日志恰好就叫
 * `loginTime` / `createTime`，所以对着 mock 跑一切正常，连真库才发现
 * 整列空白。表格照样渲染，只是那一格空着 —— 看着像"这条日志本来就没时间"。
 *
 * ## 守的是什么
 *
 * 1. 后端 `/admin/logs` 必须显式把时间列别名成前端读的字段；
 * 2. mock 与真后端返回的字段名必须一致（否则又是本地绿、线上红）；
 * 3. 前端不能只认一个名字 —— 真库给 `createTime`，历史 mock 给 `loginTime`。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8')

const route = read('server/routes/admin/dashboard.js')
const page = read('src/components/admin/AdminLogs.vue')
const mock = read('mock/index.js')

test('/admin/logs 必须显式把 created_at 别名成前端读的时间字段', () => {
  const block = route.slice(route.indexOf("router.get('/admin/logs'"))
  const body = block.slice(0, block.indexOf('router.get(', 10) + 1 || undefined)

  assert.match(body, /created_at AS create_time/, '审计日志缺时间别名，页面时间列会是空的')
  assert.match(body, /created_at AS login_time/, '登录日志缺时间别名')
})

test('登录日志要回连商户名（login_logs 本身没有 username 列）', () => {
  const block = route.slice(route.indexOf("router.get('/admin/logs'"))
  assert.match(block, /LEFT JOIN users u ON u\.id = l\.user_id/, '登录日志要能看出是哪个商户')
  assert.match(block, /LEFT JOIN sub_accounts s ON s\.id = l\.sub_account_id/, '子账号登录要归到主账号')
})

test('审计的 detail 是 jsonb，必须取成文本再回前端（否则渲染成 [object Object]）', () => {
  const block = route.slice(route.indexOf("router.get('/admin/logs'"))
  assert.match(block, /typeof detail === 'object'/, '需要把 jsonb 的 message 取出来')
})

test('前端读时间时两种字段名都要认（真库 createTime / 历史 mock loginTime）', () => {
  assert.match(page, /loginTime \|\| scope\.row\.createTime|createTime/, '前端要能读 createTime')
  assert.match(page, /formatDateTime/, '时间要用统一的格式化函数，不能直接显示 ISO 串')
})

test('mock 与真后端返回的时间字段名一致（否则本地绿、线上空）', () => {
  // mock 的日志样例必须带 createTime，和真库别名后的结果对齐
  const loginSample = mock.slice(mock.indexOf('logins: ['), mock.indexOf('targets: ['))
  assert.match(loginSample, /createTime/, 'mock 登录日志缺 createTime')
  // 审计日志本来就是 createTime，这里确认没被改掉
  const auditSample = mock.slice(mock.indexOf('audits: ['), mock.indexOf('notices: ['))
  assert.match(auditSample, /createTime/, 'mock 审计日志缺 createTime')
})

test('没人再调用会把列名原样吐出来的 adminList（死代码已删）', () => {
  // adminList 做的是 repo.list(table)，不认别名 —— 用它查日志时间列就是空的。
  // 留着它，下一个加列表页的人会照抄。
  const shared = read('server/routes/admin/shared.js')
  assert.doesNotMatch(shared, /async function adminList/, 'adminList 应已删除')
  const dashboard = read('server/routes/admin/dashboard.js')
  assert.doesNotMatch(dashboard, /adminList\(/, '不应再调用 adminList')
})

// ── jsonb detail 的两种边界 ───────────────────────────────
//
// 真库上验证时踩到的：`detail.message || 兜底` 在 message 是**空串**时
// 会掉进兜底，页面显示成 `{"message":""}` 这坨原始 JSON。
// 「登录超管后台（两步验证）」这类不带说明的记录全都长这样 —— 日志页
// 大半是这类，所以不是边角情况。

test('detail 取 message 时按"字段是否存在"判断，不按"值真不真"', () => {
  const block = route.slice(route.indexOf("router.get('/admin/logs'"))
  assert.match(block, /detail\.message !== undefined/, '空串 message 必须原样返回空串')
  assert.doesNotMatch(block, /String\(detail\.message \|\|/, '用 || 兜底会把空串换成原始 JSON')
})
