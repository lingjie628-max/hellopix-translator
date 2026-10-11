'use strict'

/**
 * 「重置商户密码」入口 + 密码策略放宽到 6 位。
 *
 * ## 起因
 *
 * 商户 `jiufa` 忘了密码，超管在商户后台想重置时发现"根本没有重置密码的选项"。
 * 实查下来有两层原因：
 *
 *   1. **入口不显眼**：`/admin/users/save`（编辑商户）虽然在收起时能改密码，
 *      但它开头就 `repo.package(versionId)` —— 不传套餐直接 404「套餐不存在」。
 *      只想改个密码却被迫把套餐一起传对，很容易失败，于是看起来像"改不了"。
 *   2. **规则与文案对不上**：占位符写「至少 8 位」，后端 `validPassword`
 *      却要求 **10 位且必须同时含字母和数字**，被拒时只在 toast 里闪一句
 *      `WEAK_PASSWORD`，像极了"没有这个功能"。
 *
 * ## 本文件守什么（源码级断言，不需要数据库）
 *
 *   1. 密码策略：最少 6 位、不限字符类型、上限 128（唯一真源 lib/password.js）
 *   2. 前端有独立「重置密码」按钮与弹窗，走**只做一件事**的独立接口
 *   3. 服务端 `/admin/users/resetPassword` 存在，且**不依赖套餐**、改完踢会话、写审计
 *   4. 全站文案不再残留「10-128 / 含字母和数字 / 至少 8 位」
 *
 * 真库真路由那一侧由既有套件覆盖（admin-users / recharge-package-entitlement）。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const read = p => fs.readFileSync(path.join(root, p), 'utf8')

const { validPassword } = require('../server/lib/password')

// --- 1. 密码策略 ---------------------------------------------------------

test('密码策略：最少 6 位，且不再限制字符类型', () => {
  assert.equal(validPassword('123456'), true, '6 位纯数字必须通过（用户明确要求「6 位数」）')
  assert.equal(validPassword('abc123'), true)
  assert.equal(validPassword('abcdef'), true, '纯字母也必须通过 —— 已取消「含字母和数字」的复杂度要求')
  assert.equal(validPassword('a'.repeat(128)), true, '128 位是上限，必须通过')
  assert.equal(validPassword('a'.repeat(129)), false, '超过 128 位仍应拒绝')
  assert.equal(validPassword('12345'), false, '5 位必须拒绝')
  assert.equal(validPassword(''), false, '空密码必须拒绝')
})

test('密码策略：hash/verify 对 6 位纯数字可用（放宽后不能反而存不进去）', async () => {
  const { hashPassword, verifyPassword } = require('../server/lib/password')
  const hash = await hashPassword('123456')
  assert.match(hash, /^scrypt\$[^$]+\$[^$]+$/, '必须仍是 scrypt 格式，满足 users.password_hash 的 CHECK 约束')
  assert.equal(await verifyPassword(hash, '123456'), true)
  assert.equal(await verifyPassword(hash, '999999'), false, '错码不得通过')
})

// --- 2. 前端入口 ---------------------------------------------------------

const usersVue = read('src/components/admin/AdminUsers.vue')

test('商户列表有独立的「重置密码」按钮，且指向 openReset', () => {
  assert.match(usersVue, /@click="openReset\(scope\.row\)"/,
    '商户行操作里必须有「重置密码」按钮。原先只能靠编辑弹窗里那个密码框，'
    + '既不难找也不明确，用户直接认为"没有这个选项"')
  assert.match(usersVue, /<el-dialog title="重置密码"/, '必须有独立的重置密码弹窗')
})

test('重置密码弹窗：两次输入必须一致，且不少于 6 位', () => {
  const at = usersVue.indexOf('submitReset() {')
  assert.ok(at > 0, '找不到 submitReset()')
  const block = usersVue.slice(at, usersVue.indexOf('\n    },', at))
  assert.match(block, /length < 6/, '前端必须挡一下 <6 位（规则以服务端为准）')
  assert.match(block, /!==\s*String\(this\.resetPwd2\)|String\(this\.resetPwd\) !== String\(this\.resetPwd2\)/,
    '必须校验两次输入一致')
  assert.match(block, /\/admin\/users\/resetPassword/,
    '必须走独立的 /admin/users/resetPassword，而不是复用要求套餐的 /admin/users/save')
})

// --- 3. 服务端接口 -------------------------------------------------------

const routes = read('server/routes/production.js')

test('服务端存在 /admin/users/resetPassword，且只做一件事', () => {
  const at = routes.indexOf("'/admin/users/resetPassword'")
  assert.ok(at > 0, '服务端必须有 /admin/users/resetPassword 接口')
  // 处理器以 "\n  }))" 收尾，据此切出函数体
  const block = routes.slice(at, routes.indexOf('\n  }))', at))

  assert.match(block, /await auth\.hash\(data\.password\)/,
    '必须经 auth.hash 落库 —— 它内部走 validPassword，是 6 位规则的唯一真源')
  assert.match(block, /UPDATE users SET password_hash/,
    '只更新 password_hash 一列，不得顺带改套餐/状态/到期等字段')
  assert.match(block, /await auth\.revokeUser\('main',\s*userId\)/,
    '改密码后必须踢掉所有旧会话，否则"重置"防不住已经被登录的旧会话')

  // 这条是本次的核心回归：绝不能因为缺套餐而 404
  assert.ok(!/repo\.package\(/.test(block),
    '重置密码接口不得依赖 repo.package —— 那正是编辑商户接口改不了密码的原因'
    + '（不传套餐就 404「套餐不存在」）')
})

// --- 4. 文案一致性 -------------------------------------------------------

test('全站不再残留过时的密码文案（10-128 / 含字母和数字 / 至少 8 位）', () => {
  const files = [
    'server/services/auth-service.js',
    'server/services/account-service.js',
    'src/components/Register.vue',
    'src/components/Forgot.vue',
    'src/components/admin/AdminUsers.vue',
    'src/components/admin/AdminStaff.vue',
    'src/components/user/UserTeam.vue'
  ]
  for (const f of files) {
    const body = read(f)
    assert.ok(!/10-128|包含字母和数字|至少 ?8 ?位|length >= 10|min: 8/.test(body),
      `${f} 里还残留旧密码文案/规则：占位符写 8 位、后端要 10 位且含字母数字，`
      + '正是让用户以为"没有重置密码功能"的根源')
  }
})
