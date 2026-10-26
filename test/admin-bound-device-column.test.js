'use strict'

/**
 * ★ 后台「电脑（已绑定/未绑定）」列在生产上恒显示"未绑定" ★
 *
 * ## 现象
 *
 * 超管在「商户管理」列表看到的「电脑」列，对**所有**商户都是"未绑定"。
 * 而查库可见 jiufa 名下 6 个活着的子账号每个都绑着设备。
 *
 * ## 根因：mock 有 bound，真后端没有
 *
 *   mock/index.js  enrichUser:  copy.bound = u.boundDevice ? 1 : 0
 *   mock/index.js  publicSub:   copy.bound = s.boundDevice ? 1 : 0
 *   AdminUsers.vue 「电脑」列:   {{ scope.row.bound ? '已绑定' : '未绑定' }}
 *
 * 而真后端 adminJoinedList 只 `mapRows()` —— 下划线转驼峰，
 * `bound_device` 变成 `boundDevice`，**永远不会产生 `bound`**。
 *
 * 于是：本地对着 mock 开发一切正常（mock 补了 bound），一上生产就全假。
 * 同一类问题此前已经发生过一次（subCount 恒为 0），见
 * test/admin-users-expiry-and-counts.test.js 的说明。
 *
 * ## 顺带
 *
 * 解绑按钮原名「踢下线」—— 名字只说了踢人，实际做的是"清设备绑定 + 撤销会话"。
 * 超管想找"解绑设备"按字面搜不到，以为后台没这功能。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8')

const adminShared = read('server/routes/admin/shared.js')
const dashboard = read('server/routes/admin/dashboard.js')
const usersVue = read('src/components/admin/AdminUsers.vue')
const accountsRoute = read('server/routes/admin/accounts.js')

test('★ adminJoinedList 必须补出前端真正读的 bound 字段', () => {
  assert.match(adminShared, /bound:/,
    'adminJoinedList 没有产出 bound —— 前端「电脑」列读 scope.row.bound，'
    + '而真后端只给 boundDevice，于是这一列恒显示"未绑定"')

  // 必须是从 boundDevice 推出来的，不能写死
  assert.match(adminShared, /row\.boundDevice/,
    'bound 必须由 boundDevice 推导，不能写死成常量')

  // 原字段要保留，别把已有消费者（若有）弄坏
  assert.match(adminShared, /Object\.assign\(\{\},\s*row/,
    '补 bound 时应保留原行字段，不要只返回 bound')
})

test('两个列表的 SELECT 都必须查 bound_device（否则补不出 bound）', () => {
  const usersAt = dashboard.indexOf("router.get('/admin/users'")
  assert.ok(usersAt > 0, '找不到 /admin/users 路由')
  const usersBlock = dashboard.slice(usersAt, dashboard.indexOf('})))', usersAt) + 4)
  assert.match(usersBlock, /bound_device/,
    '/admin/users 的 SELECT 缺 bound_device，前端「电脑」列无从判断')

  const subsAt = dashboard.indexOf("router.get('/admin/subs'")
  assert.ok(subsAt > 0, '找不到 /admin/subs 路由')
  const subsBlock = dashboard.slice(subsAt, dashboard.indexOf('})))', subsAt) + 4)
  assert.match(subsBlock, /bound_device/,
    '/admin/subs 的 SELECT 缺 bound_device，子账号弹窗「电脑」列无从判断')
})

test('★ 解绑按钮不能再叫「踢下线」（名字必须说明它会解绑设备）', () => {
  /**
   * 只断言**按钮文案**，不断言整个文件 ——
   * 注释里解释历史叫法、以及「重置密码」弹窗里那句
   * "会话会被踢下线" 都是正常表述，不该被这条误伤。
   */
  // 取 el-button / el-dropdown-item 的文本节点，看有没有写成「踢下线」的
  const buttonTexts = []
  const re = /<el-(?:button|dropdown-item)[^>]*>\s*([^<>{}]+?)\s*<\/el-/g
  let m
  while ((m = re.exec(usersVue)) !== null) buttonTexts.push(m[1])
  assert.ok(buttonTexts.length > 0, '没解析到任何按钮文案，断言无效')

  assert.ok(!buttonTexts.includes('踢下线'),
    '仍有按钮文案是「踢下线」：' + JSON.stringify(buttonTexts.filter(t => t.includes('踢下线')))
    + '。这个动作实际是"清 bound_device + 撤销所有会话"，'
    + '只写踢下线会让超管以为后台没有解绑设备的功能')

  assert.match(usersVue, /解绑设备/,
    '必须出现「解绑设备」字样，否则超管按字面搜不到这个能力')
})

test('解绑按钮按绑定状态给不同文案（已绑定 vs 未绑定）', () => {
  // 已绑定 → 解绑设备；未绑定 → 强制下线（没有绑定可解，只剩踢会话）
  assert.match(usersVue, /bound\s*\?\s*'解绑设备'\s*:\s*'强制下线'/,
    '解绑按钮应按 row.bound 区分文案：已绑定给「解绑设备」，未绑定给「强制下线」')
})

test('解绑接口仍必须同时清绑定与撤销会话（不许只做一半）', () => {
  const at = accountsRoute.indexOf("router.post('/admin/users/unbind'")
  assert.ok(at > 0, '找不到 /admin/users/unbind')
  const block = accountsRoute.slice(at, accountsRoute.indexOf('}))', at) + 3)

  assert.match(block, /bound_device=''/, '解绑必须清掉 bound_device')
  assert.match(block, /revokeUser/, '解绑必须撤销在线会话 —— 只清字段不踢人等于没用')
})
