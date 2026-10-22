'use strict'

/**
 * 商户列表的「子账号 / 工单」两列，以及「到期时间可设为无限期」。
 *
 * ## 起因（超管在后台看到的两个"假象"）
 *
 *   1. **子账号数恒为 0**：`AdminUsers.vue` 的列表有「子账号」列（读 `subCount`）
 *      与「工单」列（读 `orderCount`），而生产 `/admin/users` 的 SELECT
 *      **从来没查过这两列** —— 只有 mock 的 `enrichUser` 会算它们。
 *      于是生产上这两列永远是 0/空白：jiufa 名下明明有 3 个子账号，
 *      界面却显示 0，超管据此以为"商户开不出子账号"。
 *      （顺带：生产上 `orders` 表当前确实是空的，所以工单数真是 0 —— 但那是
 *       数据为空，不是列坏了；列本身也在本文件守的范围内。）
 *
 *   2. **到期时间改不成"无限"**：`/admin/users/save` 用的是
 *      `expires_at=COALESCE($6::timestamptz,expires_at)` —— 传 null 只会
 *      **保留原值**，于是没有任何界面手段能把已设到期时间的商户改回不过期。
 *      实际后果就是 jiufa 的到期时间被填成了 `2038-10-10` 这种假日期来"假装无限"。
 *
 * ## 为什么用源码断言
 *
 * 与 `test/admin-user-edit.test.js` / `test/admin-password-reset.test.js` 一致：
 * 这两条都是**契约级**问题（"SELECT 里到底有没有这两列"、"哪个参数决定清空"），
 * 用源码断言最直接；真实读写那一侧由 `test/recharge-package-entitlement.test.js`
 * 用真库真路由覆盖。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8')

const usersVue = read('src/components/admin/AdminUsers.vue')
const { readAllServerSource } = require('./helpers/route-source')

// 路由已按域拆分，读整个 routes 目录
const routes = readAllServerSource()
const mock = read('mock/index.js')

// --- 1. 列表必须回真实计数 -----------------------------------------------

test('商户列表 SELECT 必须查真实的子账号数与工单数', () => {
  const at = routes.indexOf("router.get('/admin/users'")
  assert.ok(at > 0, '找不到 /admin/users 路由')
  const block = routes.slice(at, routes.indexOf('})))', at) + 4)

  assert.match(block, /AS sub_count/,
    '/admin/users 必须查 sub_count（子账号真实数）。原先真后端根本没查，'
    + '只有 mock 的 enrichUser 会算 —— 生产上这一列恒为 0，'
    + '超管会以为商户没有子账号（jiufa 实际有 3 个）')
  assert.match(block, /FROM sub_accounts s WHERE s\.parent_id=u\.id/,
    '子账号数要按 parent_id 关联到当前商户，且只取 count')

  // 工单已随功能下线一起移除，不该再查
  assert.ok(!/AS order_count/.test(block),
    '工单功能已下线（产线 orders 表 0 行、无任何创建入口），'
    + '商户列表不该再统计 order_count')
})

// --- 2. 到期时间必须能清空（无限期） -------------------------------------

test('编辑商户：到期时间必须支持三态（清空 / 按日期设置 / 保持原值）', () => {
  const at = routes.indexOf('UPDATE users SET nickname=COALESCE')
  assert.ok(at > 0, '找不到「编辑商户」的 UPDATE')
  const block = routes.slice(at, routes.indexOf('WHERE id=$1', at))

  assert.match(block, /expires_at=CASE WHEN \$14::boolean THEN NULL/,
    '必须能靠显式开关把 expires_at 清成 NULL（无限期）。'
    + '原来的 COALESCE($6::timestamptz,expires_at) 传 null 只保留原值，'
    + '导致后台根本无法把已设到期时间的商户改回不过期 —— '
    + 'jiufa 的 2038-10-10 就是这么"假装无限"填出来的')

  // 三态的另一半：给了日期要按日期写
  assert.match(block, /WHEN \$6::timestamptz IS NOT NULL THEN \$6::timestamptz/,
    '没勾无限期且给了日期时，仍要按日期更新')
  // 三态的兜底：都没给就保持原值（不能把人家的到期时间顺手清掉）
  assert.match(block, /ELSE expires_at END/,
    '既没勾无限期也没给日期时必须保持原值 —— 只改个备注不能动到期时间')

  // 回归：那条"传 null 只保留原值"的老写法不能再回来
  assert.ok(!/expires_at=COALESCE\(\$6::timestamptz,expires_at\)/.test(block),
    '不能退回 COALESCE($6::timestamptz,expires_at)：它使"清空到期时间"不可能实现')
})

test('新建商户：勾「无限期」时建的号不过期', () => {
  const at = routes.indexOf('INSERT INTO users(username,password_hash,nickname,status,package_id,port_limit,expires_at')
  assert.ok(at > 0, '找不到「新建商户」的 INSERT')
  const block = routes.slice(at, routes.indexOf('RETURNING id,username', at))
  assert.match(block, /CASE WHEN \$16::boolean THEN NULL/,
    '新建时勾「无限期」要建成不过期的号（expires_at = NULL）')
  assert.match(block, /COALESCE\(\$6::timestamptz,NOW\(\)\+interval '30 days'\)/,
    '没勾无限期时维持原行为：给了日期用日期，没给默认 30 天')
})

// --- 3. 前端 -------------------------------------------------------------

test('编辑表单有「无限期」开关，且开启时禁用到期时间选择器', () => {
  const at = usersVue.indexOf('<el-form-item label="到期时间">')
  assert.ok(at > 0, '找不到表单里的「到期时间」项')
  // 表单里的选择器是唯一的 type="datetime" 那个
  const block = usersVue.slice(at, usersVue.indexOf('</el-form-item>', at))

  assert.match(block, /v-model="form\.expireUnlimited"/,
    '「到期时间」下必须有「无限期」开关。原先没有任何办法清空到期时间，'
    + '只能填 2038 这种假日期')
  assert.match(block, /:disabled="!!form\.expireUnlimited"/,
    '开了无限期就该禁用到期时间选择器，否则两个控件语义互相打架')
})

test('列表的到期时间列：无到期时间要显示「无限期」而不是空白', () => {
  const at = usersVue.indexOf('label="到期时间"')
  assert.ok(at > 0, '找不到列表的「到期时间」列')
  const block = usersVue.slice(at, usersVue.indexOf('</el-table-column>', at))
  assert.match(block, /无限期/,
    '无到期时间（expires_at 为 NULL）必须显示「无限期」。'
    + '空白会让人以为"没设置"，而它其实是有意义的业务状态：永不过期')
  assert.match(block, /formatDateTime/,
    '有到期时间时用全局 formatDateTime 过滤器，避免把 ISO 字符串原样丢给用户')
})

test('openEdit 必须把"无到期时间"归一成「无限期」', () => {
  const at = usersVue.indexOf('openEdit(row) {')
  assert.ok(at > 0, '找不到 openEdit()')
  const block = usersVue.slice(at, usersVue.indexOf('\n    },', at))
  assert.match(block, /expireUnlimited:\s*row\.expireTime\s*\?\s*0\s*:\s*1/,
    '编辑一个不过期的商户时，开关必须显示为「开」。'
    + '不归一的话开关显示为「关」，超管会误以为这个号有到期时间')
})

// --- 2b. 「改不成无限期」的真正入口（2026-10-11 超管再次反馈）-------------

test('openEdit 必须把 ISO 时间串归一成选择器认得的格式', () => {
  const at = usersVue.indexOf('openEdit(row) {')
  const block = usersVue.slice(at, usersVue.indexOf('\n    },', at))
  assert.match(block, /expireTime:\s*row\.expireTime\s*\?\s*formatDateTime\(row\.expireTime\)/,
    '接口回的是 Postgres timestamptz 的 ISO 串（2038-10-10T16:42:04.000Z），'
    + '而 el-date-picker 的 value-format 是 yyyy-MM-dd HH:mm:ss。'
    + 'Element UI 解析失败会**原样回显那个串**（picker.vue 里 '
    + '`parseAsFormatAndType(...) || this.value`），编辑框里就是一段 ISO 原文 ——'
    + '超管会以为这个字段坏了，转而去手动清它')
  assert.match(usersVue, /from '\.\.\/\.\.\/utils\/filters'/,
    'formatDateTime 是全局过滤器，JS 里要用必须显式 import')
})

test('清空到期时间 = 无限期（这是"改不成无限期"的死路所在）', () => {
  const at = usersVue.indexOf('<el-form-item label="到期时间">')
  const block = usersVue.slice(at, usersVue.indexOf('</el-form-item>', at))
  assert.match(block, /@change="onExpireChange"/,
    '选择器必须有 @change。缺了它，用户把日期清空后保存，'
    + '服务端走的是「既没勾无限期也没给日期 → 保持原值」分支 —— '
    + '日期纹丝不动，用户看到"清掉了却还在"，于是认定后台没有设置无限期的能力')

  const fn = usersVue.slice(usersVue.indexOf('onExpireChange(value) {'),
    usersVue.indexOf('\n    },', usersVue.indexOf('onExpireChange(value) {')))
  assert.match(fn, /this\.form\.expireUnlimited\s*=\s*value\s*\?\s*0\s*:\s*1/,
    'onExpireChange 必须把"清空"翻译成「无限期」——'
    + '清空就是用户表达"不要到期时间"的自然手势，控件要顺着它走')
})

test('列表「更多」里要有「设为无限期」，且只在有到期时间时出现', () => {
  const at = usersVue.indexOf('<el-table-column label="操作"')
  const block = usersVue.slice(at, usersVue.indexOf('</el-table-column>', at))
  assert.match(block, /:command="'unlimited'"/,
    '等价能力原先只藏在「编辑」弹窗的一枚小开关里，藏得深就等于没有 —— '
    + '超管的原话是"我没办法去自己改成无限期"')
  assert.match(block, /v-if="scope\.row\.expireTime"[^>]*:command="'unlimited'"/,
    '本来就不过期的号不需要这个动作，有到期时间时才显示')

  const dispatch = usersVue.slice(usersVue.indexOf('onAction(cmd, row) {'),
    usersVue.indexOf('\n    },', usersVue.indexOf('onAction(cmd, row) {')))
  assert.match(dispatch, /unlimited:\s*\(\)\s*=>\s*this\.setUnlimited\(row\)/,
    'onAction 要把 unlimited 派发到 setUnlimited，否则菜单点了没反应')
})

test('设为无限期走独立接口，不借用整套更新的 save', () => {
  const at = usersVue.indexOf('setUnlimited(row) {')
  assert.ok(at > 0, '找不到 setUnlimited()')
  const fn = usersVue.slice(at, usersVue.indexOf('\n    },', at))
  assert.match(fn, /'\/admin\/users\/expiry'/,
    '要调只改到期时间的独立接口。复用 /admin/users/save 要求带 versionId '
    + '并按整套字段更新，从列表一键触发太重，还可能顺手把套餐刷一遍')
})

// --- 2c. 服务端那个独立接口 ------------------------------------------------

test('/admin/users/expiry 只碰 expires_at 一列', () => {
  const at = routes.indexOf("router.post('/admin/users/expiry'")
  assert.ok(at > 0, '找不到 /admin/users/expiry 路由')
  const block = routes.slice(at, routes.indexOf('}))', routes.indexOf('await repo.audit', at)))

  assert.match(block, /UPDATE users SET expires_at=NULL,updated_at=NOW\(\) WHERE id=\$1/,
    '必须是一条只改 expires_at 的 UPDATE。列越少，越不可能误伤 ——'
    + '这正是它与 /admin/users/save 分开的理由')
  // 不能顺手改别的列
  for (const col of ['package_id', 'port_limit', 'sub_quota', 'enterprise', 'char_balance', 'status']) {
    assert.ok(!new RegExp(col + '\\s*=').test(block),
      `这条路由不该碰 ${col}：它的职责只有"清空到期时间"`)
  }
  assert.match(block, /repo\.audit\([^)]*'设为无限期'/,
    '要写审计：事后被问"谁把这个号设成永不过期"必须有答案')
  assert.match(block, /USER_NOT_FOUND/,
    '商户不存在要报 404，不能静默成功')
})

test('mock 与真后端行为一致地提供「设为无限期」', () => {
  const at = mock.indexOf("app.post('/apis/admin/users/expiry'")
  assert.ok(at > 0, 'mock 缺少 /admin/users/expiry —— 本地开发的列表会没有这个动作')
  const block = mock.slice(at, mock.indexOf('app.post(', at + 10))
  assert.match(block, /user\.expireTime = null/,
    'mock 也要把到期时间清成 null（null 才是"无限期"，列表据此显示）')
})

test('操作列收窄：不再横向滚动，但 7 个动作一个都不能少', () => {
  const at = usersVue.indexOf('<el-table-column label="操作"')
  assert.ok(at > 0, '找不到操作列')
  const block = usersVue.slice(at, usersVue.indexOf('</el-table-column>', at))

  // 宽度必须收窄（原来是 500，整个表格因此横向滚动）
  const width = Number((/width="(\d+)"/.exec(block) || [])[1])
  assert.ok(width > 0 && width <= 200,
    `操作列宽度应当收窄到 200 以内（当前 ${width}）。原来 7 个文字按钮并排占 500px，`
    + '导致表格必须横向滚动，超管抱怨"太长了要左右滑"')

  // 高频动作留在外面
  assert.match(block, /@click="openEdit\(scope\.row\)"/, '「编辑」要留在外面，最常用')
  assert.match(block, /@click="openReset\(scope\.row\)"/, '「重置密码」要留在外面')

  // 其余动作收进「更多」，但都必须仍然可达
  assert.match(block, /<el-dropdown/, '其余动作要收进「更多」下拉')
  for (const cmd of ['enterprise', 'unbind', 'toggle', 'reclaim', 'delete']) {
    assert.match(block, new RegExp(`:command="'${cmd}'"`),
      `「更多」菜单里缺少 ${cmd} —— 收窄操作列不能等于删功能`)
  }

  // 派发函数要把每个命令映射回原来的处理函数
  const dispatch = usersVue.slice(usersVue.indexOf('onAction(cmd, row) {'),
    usersVue.indexOf('\n    },', usersVue.indexOf('onAction(cmd, row) {')))
  for (const fn of ['setEnterprise', 'unbind', 'toggle', 'reclaim', 'openDelete']) {
    assert.match(dispatch, new RegExp(`this\\.${fn}\\(row\\)`),
      `onAction 必须把命令派发到 ${fn}，否则菜单点了没反应`)
  }
})

// --- 4. mock 与真后端保持一致 -------------------------------------------

test('mock 的编辑商户也要认得「无限期」', () => {
  const at = mock.indexOf("app.post('/apis/admin/users/save'")
  assert.ok(at > 0, '找不到 mock 的 /admin/users/save')
  const block = mock.slice(at, mock.indexOf('// 与 server/routes/production.js', at))

  assert.match(block, /isUnlimited\(query\.expireUnlimited\)/,
    'mock 必须与真后端行为一致地处理「无限期」——'
    + '否则本地开发看到的到期时间和生产不一样')
  assert.ok(!/user\.expireTime\s*=\s*query\.expireTime\s*\|\|\s*user\.expireTime/.test(block),
    '不能退回 `query.expireTime || user.expireTime`：那样永远清不掉到期时间')
  assert.match(block, /isUnlimited\(query\.expireUnlimited\) \? null/,
    'mock 的新建路径也要支持勾「无限期」建成不过期的号')
})
