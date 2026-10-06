'use strict'

/**
 * 「编辑商户」必须能改套餐（源码级守卫，不需要数据库）。
 *
 * ## 守的是什么
 *
 * `AdminUsers.vue` 的编辑弹窗原本把「字符余额」渲染成**可编辑输入框**，
 * `openEdit()` 用 `row.charBalance` 填充它，`save()` 又把整个 form 原样提交。
 * 而服务端 `/admin/users/save` 有一条刻意的守卫：
 *
 *     只要带 charBalance 就 400（USE_CHARACTER_GRANT）
 *
 * 因为余额只能经 `char_ledger` 变更（见 `server/lib/merchant-purge.js` 与
 * 「回收字符」）。两者一撞，后果是**每一次「编辑商户」都失败** ——
 * 生产上的表现就是"能建号、改不了套餐"，商户的 `package_id` 永远是 NULL，
 * 商户端首页套餐栏空白，子账号也开不出来。
 *
 * ## 为什么用源码断言而不是渲染测试
 *
 * 这条链路的缺陷不在 Vue 逻辑，而在**"表单回了哪个字段"**这个契约上。
 * 仓库里已有同样的做法（`test/recharge-effective-status.test.js` 直接读
 * `production.js` 断言筛选口径），前端这两个不变量也照此守：
 *
 *   1. 编辑态的余额输入框必须 `disabled`
 *   2. 编辑态的提交载荷必须剔除 `charBalance`
 *
 * 真实路由那一侧（带 charBalance 必须 400、不带必须改成功）由
 * `test/recharge-package-entitlement.test.js` 用真库真路由覆盖。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src/components/admin/AdminUsers.vue'), 'utf8')

test('编辑态：余额输入框必须只读', () => {
  // 定位编辑弹窗里的「字符余额」表单项。
  // 表格列也叫「字符余额」，所以必须带上 <el-form-item 前缀才不会选错。
  const at = source.indexOf('<el-form-item label="字符余额">')
  assert.ok(at > 0, '找不到编辑表单里的「字符余额」表单项')
  const block = source.slice(at, source.indexOf('</el-form-item>', at))

  assert.match(block, /v-model="form\.charBalance"/, '余额输入框应当仍然绑定 form.charBalance')
  assert.match(block, /:disabled="!!form\.id"/,
    '余额输入框在编辑态（form.id 有值）必须 disabled —— 否则超管会以为改这里能生效，'
    + '而提交后要么被服务端 400 拦下、要么静默失效')
  assert.match(block, /v-if="!form\.id"/, '试用赠送提示只该在新建时出现')
})

test('编辑态：提交载荷必须剔除 charBalance', () => {
  const at = source.indexOf('save() {')
  assert.ok(at > 0, '找不到 save() 方法')
  const block = source.slice(at, source.indexOf('\n    },', at))

  assert.match(block, /delete payload\.charBalance|delete request\.charBalance/,
    'save() 在编辑态必须把 charBalance 从载荷里剔除。'
    + '只要它进了请求体，服务端守卫必定 400（USE_CHARACTER_GRANT），'
    + '「编辑商户」就整体不可用 —— 套餐、到期时间、备注一个都改不了')

  // 反过来确认：不能靠"服务端别拦"来解决。
  // 守卫本身是资金安全的必要条件，必须原样保留在服务端。
  const routes = fs.readFileSync(
    path.join(__dirname, '..', 'server/routes/production.js'), 'utf8')
  assert.match(routes, /USE_CHARACTER_GRANT/,
    '服务端的余额守卫不能被删掉 —— 余额只能走 char_ledger，不能从用户编辑接口改')
})

test('子账号额度在编辑表单里可见可改', () => {
  const at = source.indexOf('<el-form-item label="子账号额度">')
  assert.ok(at > 0,
    '编辑表单缺少「子账号额度」输入项。缺了它，超管没有任何界面手段给商户额度，'
    + '而子账号数正是由 users.sub_quota 决定的')
  const block = source.slice(at, source.indexOf('</el-form-item>', at))
  assert.match(block, /v-model="form\.subQuota"/, '子账号额度必须绑定 form.subQuota')
})

test('换套餐时带出该套餐的子账号额度', () => {
  const at = source.indexOf('onPack(id) {')
  assert.ok(at > 0, '找不到 onPack()')
  const block = source.slice(at, source.indexOf('\n    },', at))
  assert.match(block, /subQuota/,
    '换套餐时要同步把该套餐的 sub_quota 带进表单，'
    + '否则超管改档位后额度仍停在旧档的值')
})
