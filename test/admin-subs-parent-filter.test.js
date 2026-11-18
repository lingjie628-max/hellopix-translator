'use strict'

/**
 * 超管后台 · 「子账号」弹窗必须按商户过滤
 *
 * ## 生产现象（2026-11-11 反馈）
 *
 * 用户原话：「商户管理后台没办法给子账户解绑设备」
 *
 * ## 根因
 *
 * `AdminUsers.vue` 的「子账号」弹窗：
 *
 *   openSubs(row) {
 *     this.getRequest('/admin/subs', { userId: row.id })
 *   }
 *
 * 但 `/admin/subs` 走的是通用壳子 `adminJoinedList`，而它**只读 keyword**，
 * 从来不读 `userId` —— 于是不管点哪家商户，返回的都是**全站所有子账号**。
 *
 * 后果很实际：
 *   · 弹窗里列着别人的子账号，超管以为是这家的；
 *   · 点「踢下线」时 `row.id` 可能是另一家的账号，被解绑的是不相干的人；
 *   · 而真正想解绑的那个，按钮点了几次都"没反应"
 *     （其实每次都成功解绑了别人，或者被 404 挡掉）。
 *
 * 所以"解绑不了"不是解绑接口坏了，是**列表给错了人**。
 *
 * ## 这一组锁什么
 *
 *   1. 壳子必须支持按父账号过滤，且必须**校验参数**
 *   2. `/admin/subs` 必须声明自己的父账号列（`s.parent_id`）
 *   3. 未声明 parentColumn 的路由保持原行为（不能顺手把别的列表改坏）
 *   4. 占位符编号必须随参数增长（关键字与父账号同时存在时不能串位）
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const shared = read('server/routes/admin/shared.js')
const dashboard = read('server/routes/admin/dashboard.js')

test('★ adminJoinedList 必须支持按父账号过滤', () => {
  assert.ok(/data\.userId/.test(shared),
    'adminJoinedList 完全不读 userId —— 子账号弹窗会返回全站所有子账号')
  assert.ok(/data\.parentId/.test(shared),
    '也应支持 parentId 别名（前端两种写法都出现过）')
  assert.ok(/parentColumn/.test(shared),
    '必须由调用方声明父账号列名，不能硬编码 parent_id（不是每张表都叫这个）')
})

test('★ 父账号参数要校验，不能直接把用户输入拼进 SQL', () => {
  assert.ok(/Number\.isSafeInteger/.test(shared),
    '必须校验父账号参数是安全整数')
  assert.ok(/BAD_PARENT_ID/.test(shared),
    '非法参数要回明确的错误码，而不是 500 或静默忽略')
  // 值必须走占位符
  assert.ok(/\$\$\{values\.length\}/.test(shared),
    '父账号必须用参数化占位符，不能字符串拼接')
})

test('★ /admin/subs 必须声明 s.parent_id', () => {
  const at = dashboard.indexOf("router.get('/admin/subs'")
  assert.ok(at > 0, '找不到 /admin/subs')
  const block = dashboard.slice(at, at + 700)
  assert.ok(/parentColumn:\s*'s\.parent_id'/.test(block),
    '/admin/subs 没有声明 parentColumn —— 弹窗仍会返回全站子账号')
})

test('★ 占位符编号不能串位（关键字与父账号同时存在）', () => {
  // 两个条件都出现时，keyword 必须接在父账号参数**之后**
  assert.ok(/values\.push\(parentId\)/.test(shared),
    '父账号值必须先入参数数组')
  assert.ok(/const start = values\.length/.test(shared),
    '关键字的占位符必须从当前参数长度起算 —— 写死 $1 会与父账号撞位')
  assert.ok(/ILIKE \$\$\{start\}/.test(shared),
    '关键字占位符必须用动态编号')
})

test('★ 未声明 parentColumn 的列表保持原行为', () => {
  // 条件里必须有 config.parentColumn 判断：否则所有列表路由都会被
  // 一个不相干的 userId 参数改变结果。
  assert.ok(/if \(config\.parentColumn &&/.test(shared),
    '必须门控在 parentColumn 上，不能无条件过滤')
  // 抽查几个不该受影响的列表
  for (const route of ['/admin/users', '/admin/recharges']) {
    const at = dashboard.indexOf("'" + route + "'")
    assert.ok(at > 0, '找不到 ' + route)
    const block = dashboard.slice(at, at + 500)
    assert.ok(!/parentColumn/.test(block),
      route + ' 不应声明 parentColumn —— 它没有父账号这个概念')
  }
})

test('★ ApiError 必须已导入（否则非法参数会 500 而不是 400）', () => {
  assert.ok(/require\('\.\.\/\.\.\/lib\/http'\)/.test(shared))
  const m = /const\s*\{([^}]*)\}\s*=\s*require\('\.\.\/\.\.\/lib\/http'\)/.exec(shared)
  assert.ok(m, '找不到 lib/http 的解构导入')
  assert.ok(/ApiError/.test(m[1]),
    'ApiError 没有从 lib/http 导入 —— 抛出去会是 ReferenceError')
})

test('★ 前端确实传了 userId（否则改了后端也没用）', () => {
  const vue = read('src/components/admin/AdminUsers.vue')
  assert.ok(/getRequest\('\/admin\/subs',\s*\{\s*userId:\s*row\.id\s*\}\)/.test(vue),
    'AdminUsers.vue 必须继续传 userId，否则过滤条件拿不到值')
})

test('★ 解绑子账号必须用 subId，不能落到主账号分支', () => {
  const vue = read('src/components/admin/AdminUsers.vue')
  assert.ok(/subId:\s*row\.id/.test(vue),
    '解绑子账号必须传 subId —— 传错会让服务端去 update users 表')
})
