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

/**
 * 下面两条守的是「开关看着是关的 → 点开 → 保存 → 还是关的」那一类缺陷。
 *
 * 前半是 Vue 的绑定问题（显示不出来），后半是服务端的解析问题（存不对），
 * 两者必须一起修：只修前端则数据仍可能被静默改掉，只修服务端则开关仍旧
 * 显示为关、超管依然以为没保存成功（生产上连点过三次保存）。
 */
test('编辑态：布尔列必须归一成 0/1，否则开关永远显示为「关」', () => {
  const at = source.indexOf('openEdit(row) {')
  assert.ok(at > 0, '找不到 openEdit()')
  const block = source.slice(at, source.indexOf('\n    },', at))

  assert.match(block, /enterprise:\s*Number\(row\.enterprise\)\s*\?\s*1\s*:\s*0/,
    'openEdit 必须把 row.enterprise 归一成 1/0。列表接口回的是 Postgres 布尔 true，'
    + '而开关声明的是 :active-value="1" —— true !== 1，开关就永远渲染成「关」，'
    + '哪怕库里明明是开的（生产上就是这么被误判成"没保存成功"的）')
  assert.match(block, /autoReply:\s*Number\(row\.autoReply\)\s*\?\s*1\s*:\s*0/,
    '自动回复同理：不归一的话这个开关同样永远显示为「关」')
})

test('服务端 bool()：必须认得表单发来的 "true"/"false"，且认不出来时不动原值', () => {
  const { bool } = require('../server/services/core-service')

  // 真实载荷：encodeForm 对 JS 布尔做 encodeURIComponent(true) === 'true'，
  // 所以线上过来的就是这两个字符串。用 Boolean(number(...)) 会把 "true" 判成 false，
  // 于是一个"打开"的开关存进库变成"关闭" —— 而且全程不报错。
  assert.equal(bool('true'), true, '字符串 "true" 必须判成开')
  assert.equal(bool('false'), false, '字符串 "false" 必须判成关')
  assert.equal(bool('1'), true)
  assert.equal(bool('0'), false)
  assert.equal(bool(true), true, '布尔原样透传')
  assert.equal(bool(false), false)

  // 没传 / 空串 → null，调用方靠 COALESCE 保持原值
  assert.equal(bool(undefined), null, '没传必须是 null，否则会把开关当成"关"')
  assert.equal(bool(''), null, '空串同理：界面没碰这个字段，就不该动它')

  // 认不出来一律 null（保持原值），**不能**猜成 false ——
  // 猜错就是静默改掉别人的开关，比"不动"危险得多
  assert.equal(bool('maybe'), null, '无法识别的值必须保持原值，不能猜成关闭')
  assert.equal(bool('  TRUE  '), true, '两端空白与大小写要能容忍')
})

test('编辑商户的 UPDATE 必须写 enterprise 与 auto_reply，且不得再用 Boolean(number(...))', () => {
  const routes = fs.readFileSync(
    path.join(__dirname, '..', 'server/routes/production.js'), 'utf8')
  const at = routes.indexOf('UPDATE users SET nickname=COALESCE')
  assert.ok(at > 0, '找不到「编辑商户」的 UPDATE 语句')
  const block = routes.slice(at, routes.indexOf('WHERE id=$1', at))

  assert.match(block, /enterprise=COALESCE/, 'enterprise 必须在编辑态可改')
  // 这条守的是"哑巴开关"：编辑态原来根本没写 auto_reply，新建时却会写，
  // 于是同一个开关在新建页好使、在编辑页点了没反应
  assert.match(block, /auto_reply=COALESCE/,
    '编辑商户的 UPDATE 里必须有 auto_reply —— 原先漏了这一列，'
    + '自动回复开关在编辑弹窗里点了等于没点（新建页却有效，两边行为不一致）')

  // 开关一律走 bool()；Boolean(number("true")) 会把"开"判成"关"
  assert.ok(!/Boolean\(number\(data\.(?:enterprise|autoReply)\)\)/.test(block),
    '布尔开关不能用 Boolean(number(...)) 解析：请求体里是字符串 "true"，'
    + 'Number("true") 是 NaN，会被判成 false —— 打开开关保存反而把它关掉')
})
