/**
 * 客户数据隔离 —— 静态扫描测试。
 *
 * 这是隔离的**第二道防线**（第一道是表结构上每张内容表都带 user_id，
 * 第三道是接口出口白名单）。
 *
 * 为什么不用代码评审：评审会漏，而且明天新加一个查询没人会记得回头看。
 * 这个测试直接扫源码文本 —— 只要有人写了一条忘记带 user_id 的内容查询，
 * `npm test` 立刻失败。**把纪律变成机器能检查的事。**
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const REPO_PATH = path.join(__dirname, '..', 'server', 'repositories', 'customer-repository.js')
const SERVICE_PATH = path.join(__dirname, '..', 'server', 'services', 'customer-identity-service.js')

/** 内容层：这些表的数据属于某个商户，任何查询都必须限定 user_id */
const CONTENT_TABLES = ['conversations', 'messages', 'customer_owners']

/**
 * 身份层：平台级共享，按设计可以跨商户查 —— 但它们**不含聊天内容**。
 * 一旦有人往这些表里加了内容字段，这个白名单就必须重新审视。
 */
const IDENTITY_TABLES = ['platform_identities', 'customers', 'customer_identities', 'customer_merchant_links']

function methodBodies(source) {
  // 按 "  async xxx(" 或 "  xxx(" 切分方法体，够用且不引入解析器依赖
  const out = []
  const re = /^  (?:async )?([A-Za-z_][\w]*)\([^)]*\)\s*\{/gm
  let m
  while ((m = re.exec(source))) {
    const start = m.index
    let depth = 0
    let i = source.indexOf('{', start)
    const bodyStart = i
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    out.push({ name: m[1], body: source.slice(bodyStart, i + 1), start })
  }
  return out
}

/**
 * 管理端查询的豁免清单。
 *
 * 超管按设计需要跨商户视角（客户详情、合并、撞单历史），所以这几个方法
 * 查询内容表时**不带 user_id**，这是需求而不是疏漏。
 *
 * 但豁免必须满足两个条件，缺一不可：
 *   1. 明确列在这里 —— 不能靠命名巧合蒙混过关
 *   2. 只被 /admin/ 路由调用 —— 由下一个测试强制校验
 *
 * 换句话说：允许超管看全局，但绝不允许这些方法被商户端路由捞走。
 */
const ADMIN_EXEMPT = new Set([
  'countCustomers', 'customerDetail', 'mergeCustomers', 'collisionHistory', 'listCustomers',
  'listMergeCandidates', 'resolveMergeCandidate'
])

/** 管理端区块的起始标记，用于确认豁免方法确实写在标注过的区域里 */
const ADMIN_SECTION_MARK = '管理端查询（超管视角）'

test('内容层的读改删必须带 user_id —— 漏一条就失败', () => {
  const source = fs.readFileSync(REPO_PATH, 'utf8')
  const offenders = []
  const adminSectionStart = source.indexOf(ADMIN_SECTION_MARK)

  for (const { name, body, start } of methodBodies(source)) {
    if (!/this\.query\(/.test(body)) continue
    // 豁免方法必须**物理位于标注过的管理端区块内**，
    // 否则"豁免"就只是白名单上的一个名字，谁都能加。
    if (ADMIN_EXEMPT.has(name)) {
      assert.ok(
        adminSectionStart >= 0 && start > adminSectionStart,
        `${name} 在豁免清单里，但不在「${ADMIN_SECTION_MARK}」区块内 —— 豁免必须写在标注过的地方`
      )
      continue
    }

    // 只针对**读取/修改/删除**：这三类如果没有 user_id 条件，
    // 就会把别的商户的数据捞出来。INSERT 由下一个测试单独把关
    // （它靠列清单与 ON CONFLICT 目标来限定归属，形态不同）。
    const readsOrWrites = CONTENT_TABLES.some(t =>
      new RegExp(`(FROM|UPDATE|DELETE\\s+FROM)\\s+${t}\\b`, 'i').test(body)
    )
    if (!readsOrWrites) continue

    // 允许 user_id = $n 或 user_id <> $n（后者用于跨商户反查，见 otherMerchantActiveOwners）
    const hasUserIdFilter = /user_id\s*(=|<>|IN)\s*\$/.test(body)
    if (!hasUserIdFilter) offenders.push(name)
  }

  assert.deepEqual(
    offenders, [],
    `以下内容查询缺少 user_id 条件，会造成跨商户数据泄露：${offenders.join(', ')}`
  )
})

test('内容层的 INSERT ... ON CONFLICT 必须把 user_id 纳入冲突目标', () => {
  const source = fs.readFileSync(REPO_PATH, 'utf8')
  const offenders = []

  for (const { name, body } of methodBodies(source)) {
    for (const table of CONTENT_TABLES) {
      const re = new RegExp(`INSERT INTO\\s+${table}[\\s\\S]*?ON CONFLICT\\s*\\(([^)]*)\\)`, 'i')
      const m = body.match(re)
      if (!m) continue
      // 冲突目标不含 user_id 的话，A 商户的写入可能更新到 B 商户的同一行
      if (!/user_id/.test(m[1])) offenders.push(`${name} → ${table}`)
    }
  }

  assert.deepEqual(offenders, [], `以下 upsert 的冲突目标缺少 user_id：${offenders.join(', ')}`)
})

test('管理端豁免方法只能出现在 /admin/ 路由里 —— 防止被商户端捞走', () => {
  const routes = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'routes', 'production.js'), 'utf8')

  for (const name of ADMIN_EXEMPT) {
    // 找出所有 customers.<name>( 的调用，回溯它所在的路由声明
    const re = new RegExp('customers\\.' + name + '\\(', 'g')
    let m
    while ((m = re.exec(routes))) {
      // 往前找最近的一条 router.xxx('路径'
      const before = routes.slice(0, m.index)
      const decls = [...before.matchAll(/router\.(get|post|put|delete)\(\s*'([^']+)'/g)]
      const last = decls[decls.length - 1]
      assert.ok(last, `${name} 的调用找不到所属路由`)
      assert.ok(
        last[2].startsWith('/admin/'),
        `${name} 被非管理端路由 ${last[1].toUpperCase()} ${last[2]} 调用了 —— ` +
        '这个方法没有商户隔离，只能挂在 /admin/ 下'
      )
    }
  }
})

test('内容表的写入必须落 user_id（不只是写入）', () => {
  const source = fs.readFileSync(REPO_PATH, 'utf8')
  const offenders = []

  for (const { name, body } of methodBodies(source)) {
    for (const table of CONTENT_TABLES) {
      const insertRe = new RegExp(`INSERT INTO\\s+${table}\\s*\\(([^)]*)\\)`, 'i')
      const m = body.match(insertRe)
      if (!m) continue
      if (!/\buser_id\b/.test(m[1])) offenders.push(`${name} → ${table}`)
    }
  }

  assert.deepEqual(offenders, [], `以下写入没有落 user_id：${offenders.join(', ')}`)
})

test('身份层不得混入聊天内容字段 —— 一旦混入，跨商户共享就变成了数据泄露', () => {
  const migrations = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '016_customer_identity.js'), 'utf8'
  )

  for (const table of IDENTITY_TABLES) {
    const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\n    \\);`, 'i')
    const m = migrations.match(re)
    assert.ok(m, `找不到 ${table} 的建表语句`)
    const cols = m[1]
    for (const forbidden of ['body', 'message', 'content', 'text_body']) {
      assert.doesNotMatch(
        cols, new RegExp(`\\b${forbidden}\\b`, 'i'),
        `身份表 ${table} 出现疑似内容字段「${forbidden}」—— 身份层必须只放身份，不能放聊天内容`
      )
    }
  }
})

test('四个 source 溯源字段必须存在于 messages 且为 NOT NULL 或显式默认', () => {
  const migrations = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '016_customer_identity.js'), 'utf8'
  )
  const m = migrations.match(/CREATE TABLE IF NOT EXISTS messages\s*\(([\s\S]*?)\n    \) PARTITION/i)
  assert.ok(m, '找不到 messages 建表语句')
  const cols = m[1]

  for (const col of ['source_platform', 'source_account', 'source_conv_id', 'source_msg_id']) {
    assert.match(cols, new RegExp(`\\b${col}\\b`), `messages 缺少溯源字段 ${col}`)
  }
  // 平台与账号必须有值 —— 不知道来源的消息无法追溯
  assert.match(cols, /source_platform\s+text\s+NOT NULL/, 'source_platform 必须 NOT NULL')
  assert.match(cols, /source_account\s+text\s+NOT NULL/, 'source_account 必须 NOT NULL')
})

test('合并只改 customer_id，不得出现改写 source_* 的语句', () => {
  const source = fs.readFileSync(REPO_PATH, 'utf8')
  // 任何 UPDATE ... SET source_xxx 都是违规：溯源一旦被改写，合并后就说不清出处了
  assert.doesNotMatch(
    source, /SET[\s\S]{0,120}?source_(platform|account|conv_id|msg_id)\s*=/i,
    '出现改写 source_* 溯源字段的语句 —— 规范要求四列在任何情况下都不动'
  )
})

test('跨商户撞单的返回体不得包含对方商户标识', () => {
  const source = fs.readFileSync(SERVICE_PATH, 'utf8')

  // 必须先锁定 pendingReminders 方法体 —— 文件里 detectCollision 也有
  // 'cross_merchant' 字面量，直接全文匹配会抓错地方（这个测试第一版就踩了）。
  const fn = methodBodies(source).find(x => x.name === 'pendingReminders')
  assert.ok(fn, '找不到 pendingReminders 方法')

  const crossBranch = fn.body.match(/row\.kind === 'cross_merchant'[\s\S]*?\n      \}/)
  assert.ok(crossBranch, '找不到 pendingReminders 里的跨商户分支')

  for (const forbidden of ['existing_user_id', 'existingUser', 'existing_employee_id', 'existingEmployeeId',
    'existing_account_key', 'existingAccountKey', 'merchantName', 'userName']) {
    assert.doesNotMatch(
      crossBranch[0], new RegExp(forbidden),
      `跨商户返回体出现「${forbidden}」—— 泄露对方标识`
    )
  }
  // 必须带匿名标记
  assert.match(crossBranch[0], /anonymous:\s*true/, '跨商户结果必须显式标记为匿名')
})

test('跨商户检测默认关闭 —— 架构支持但不默认开', () => {
  const source = fs.readFileSync(SERVICE_PATH, 'utf8')
  const m = source.match(/const COLLISION_DEFAULTS = \{([\s\S]*?)\}/)
  assert.ok(m, '找不到 COLLISION_DEFAULTS')
  assert.match(m[1], /crossMerchant:\s*false/, '跨商户检测必须默认关闭')
  assert.match(m[1], /sameMerchant:\s*true/, '同商户检测默认开启')
})

test('迁移里的撞单设置也必须是跨商户关闭', () => {
  const migrations = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '016_customer_identity.js'), 'utf8'
  )
  const m = migrations.match(/'customer\.collision'[\s\S]{0,200}?::jsonb/)
  assert.ok(m, '找不到 customer.collision 初始设置')
  assert.match(m[0], /"crossMerchant":\s*false/, '迁移里的初始值也必须关闭跨商户')
})
