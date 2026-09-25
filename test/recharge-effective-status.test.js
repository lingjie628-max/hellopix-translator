'use strict'

/**
 * 「有效状态」守卫测试。
 *
 * ## 为什么要有这个文件
 *
 * 订单过期是**惰性判定**的：数据库里的 `status` 不会因为时间到了就变成 2。
 * 这是刻意的设计（不为改状态而空转写库），但它埋了一个很难发现的坑：
 *
 *   **`status=0` 不等于"还在等付款"。**
 *
 * 一张三天前就该过期的订单，库里依然写着 `status=0`。只要有人直接读这个字段
 * 去做展示或统计，就会得到两种错误，而且都不会报错：
 *
 *   1. 后台把僵尸单显示成"待支付" → 运营一直等一笔永远不会来的款；
 *   2. 统计把僵尸单算进"有效待支付" → 报表数字虚高，看不出业务其实停着。
 *
 * 所以规则是：**凡是展示或统计订单状态，一律走 effective status。**
 * 这个文件就是盯着这条规则别被破坏。
 *
 * `effectiveStatus`（内存判断）和 `effectiveStatusSql`（库里判断）是同一语义的
 * 两份实现 —— 列表要排序分页就必须在 SQL 里算，单条订单又不想多查一次库。
 * 两份实现最大的风险是**改了一处忘了另一处**，所以下面有一组真库用例
 * 拿同一批订单分别跑两条路径，逐例比对结果。
 *
 * 运行方式（不设 PIX_TEST_DATABASE_URL 时真库那组自动跳过）：
 *
 *   PIX_TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/hellopix_rc02 \
 *   node --test test/recharge-effective-status.test.js
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  STATUS,
  effectiveStatus,
  effectiveStatusText,
  effectiveStatusSql,
  isEffectivelyPending,
  isPending,
  statusText
} = require('../server/services/recharge-state')

const databaseUrl = process.env.PIX_TEST_DATABASE_URL
const root = path.join(__dirname, '..')

// ------------------------------------------------------------ 内存语义

const NOW = '2026-09-24T12:00:00Z'
const order = (status, expiresAt) => ({ status, expiresAt })

test('有效状态：仍在有效期内的 pending 保持待支付', () => {
  const o = order(STATUS.PENDING, '2026-09-24T12:30:00Z')
  assert.equal(effectiveStatus(o, NOW), STATUS.PENDING)
  assert.equal(isEffectivelyPending(o, NOW), true)
  assert.equal(effectiveStatusText(o, NOW), statusText(STATUS.PENDING))
})

test('有效状态：过了 expires_at 的 pending 必须算作已过期', () => {
  const o = order(STATUS.PENDING, '2026-09-24T11:00:00Z')
  assert.equal(effectiveStatus(o, NOW), STATUS.EXPIRED)
  assert.equal(isEffectivelyPending(o, NOW), false)
  assert.notEqual(effectiveStatusText(o, NOW), statusText(STATUS.PENDING),
    '过期的订单不能再对外声称"待支付"')
})

test('有效状态：到期瞬间即过期（与 isExpired 的 <= 语义一致）', () => {
  assert.equal(effectiveStatus(order(STATUS.PENDING, '2026-09-24T12:00:00Z'), NOW), STATUS.EXPIRED)
  assert.equal(effectiveStatus(order(STATUS.PENDING, '2026-09-24T12:00:01Z'), NOW), STATUS.PENDING)
})

test('有效状态：已经是终态的订单不会被时间改写', () => {
  // 已支付的订单即使早过了有效期，也仍然、且必须显示为已支付 ——
  // 有效状态只做「pending → expired」这一个方向的推断。
  for (const status of [STATUS.PAID, STATUS.EXPIRED, STATUS.CANCELLED, STATUS.EXCEPTION]) {
    for (const expiresAt of ['2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z']) {
      assert.equal(effectiveStatus(order(status, expiresAt), NOW), status,
        `status=${status} / expires_at=${expiresAt} 被有效状态错误改写了`)
      assert.equal(isEffectivelyPending(order(status, expiresAt), NOW), false)
    }
  }
})

test('有效状态：没有 expires_at 的订单不判过期（宁可待支付，不要误判）', () => {
  // 与 isExpired 同一防御口径：字段缺失时不能把订单"猜"成过期，
  // 否则会凭空制造僵尸单，比漏判更糟。
  for (const o of [{ status: STATUS.PENDING }, { status: STATUS.PENDING, expiresAt: null }, null]) {
    assert.equal(effectiveStatus(o, NOW), STATUS.PENDING)
  }
})

test('有效状态：只读不写，不修改传入的订单对象', () => {
  const o = order(STATUS.PENDING, '2026-09-24T11:00:00Z')
  effectiveStatus(o, NOW)
  assert.equal(o.status, STATUS.PENDING, 'effectiveStatus 不该改动入参')
  assert.equal(o.expiresAt, '2026-09-24T11:00:00Z')
})

test('有效状态：pending 与 isPending(status) 的区别就是僵尸单', () => {
  // 这组对照说明了为什么要引入 isEffectivelyPending：
  // 老的 isPending 认可僵尸单，新的不认。
  const zombie = order(STATUS.PENDING, '2026-09-24T11:00:00Z')
  assert.equal(isPending(zombie.status), true, 'isPending 只看状态字段，仍会认可僵尸单')
  assert.equal(isEffectivelyPending(zombie, NOW), false, '有效待支付必须排除僵尸单')
})

// -------------------------------------------------------------- SQL 语义

test('effectiveStatusSql：表达式只做 pending+过期 这一个方向的推断', () => {
  const sql = effectiveStatusSql('r')
  assert.match(sql, /^CASE WHEN /, '必须是 CASE 表达式，才能直接放进 SELECT')
  assert.match(sql, /r\.status = 0/)
  assert.match(sql, /r\.expires_at <= now\(\)/)
  assert.match(sql, /THEN 2 /)
  assert.match(sql, /ELSE r\.status END$/)
})

test('effectiveStatusSql：常量取自 STATUS，不是散落的魔法数字', () => {
  // 硬编码 0/2 会让状态机改枚举时这里静默失配 —— 用常量拼就不会。
  const sql = effectiveStatusSql('r')
  assert.ok(sql.includes(`= ${STATUS.PENDING}`), 'pending 常量必须来自 STATUS')
  assert.ok(sql.includes(`THEN ${STATUS.EXPIRED} `), 'expired 常量必须来自 STATUS')
  assert.ok(!/\bTHEN\s+0\b/.test(sql), '终态不可能是 0，THEN 分支不该出现 0')
})

test('effectiveStatusSql：别名可省（商户端列表用的是无别名查询）', () => {
  const sql = effectiveStatusSql('')
  assert.doesNotMatch(sql, /\.status/, '无别名时不该残留 "r." 前缀')
  assert.match(sql, /CASE WHEN status = 0 AND expires_at <= now\(\) THEN 2 ELSE status END/)
})

test('后台列表：必须下发 effective_status，而不是只给原始 status', () => {
  const source = fs.readFileSync(path.join(root, 'server/routes/production.js'), 'utf8')
  const block = source.slice(
    source.indexOf("router.get('/admin/recharges'"),
    source.indexOf("router.get('/admin/translate/logs'")
  )
  assert.match(block, /effective_status/, '后台充值列表没有下发 effective_status')
  assert.match(block, /effectiveStatusSql\('r'\)/, '后台列表应复用 effectiveStatusSql，而不是自己写 CASE')
})

test('后台统计：待支付必须区分「有效」与「惰性过期」', () => {
  const source = fs.readFileSync(path.join(root, 'server/routes/production.js'), 'utf8')
  const block = source.slice(source.indexOf("router.get('/admin/stats'"), source.indexOf('async function adminList'))
  assert.match(block, /AS recharge_pending\b/, '缺少有效待支付统计')
  assert.match(block, /AS recharge_pending_stale\b/, '缺少惰性过期统计')
  // 关键：有效待支付必须带时间条件，否则又变成数 status=0。
  // 注意 SQL 里 `AS recharge_pending` 在行尾，条件写在它**前面**，
  // 所以要从上一个统计项截到 stale 那一项，才能把完整子查询包进来。
  const pendingSql = block.slice(block.indexOf('AS recharge_sum'), block.indexOf('AS recharge_pending_stale'))
  assert.match(pendingSql, /WHERE r\.status=0 AND r\.expires_at > now\(\)/,
    '「有效待支付」没有排除已过期的订单')
  assert.match(pendingSql, /AS recharge_pending\b/, '缺少有效待支付统计')
})

test('商户端列表：状态筛选必须按有效状态，不能直接比 status', () => {
  const source = fs.readFileSync(path.join(root, 'server/routes/production.js'), 'utf8')
  const block = source.slice(
    source.indexOf("router.get('/userRecharge/getUserRecharge'"),
    source.indexOf("router.get('/user/quote'")
  )
  assert.doesNotMatch(block, /clauses\.push\(`status=\$\{values\.length\}`\)/,
    '商户端还在直接按 status 筛选：这样筛"已过期"会得到 0 条，"待支付"会混进僵尸单')
  assert.match(block, /effectiveStatusSql\(''\)/, '状态筛选应走有效状态，而不是直接比 status')
  assert.match(block, /effectiveStatus: effectiveStatus\(row\)/, '商户端列表没有下发 effectiveStatus')
})

test('接口契约：后台列表下发的字段名是 effectiveStatus（mapRow 会驼峰化）', () => {
  // 这条锁的是前后端之间的字段名。SQL 里写的是 effective_status，
  // 但 repo 的 mapRow 会把所有下划线键驼峰化，最终下发 effectiveStatus。
  // 不知道这件事就会在组件里读一个永远 undefined 的字段，然后静默退回原始 status ——
  // 那正是这次要修掉的 bug，只是换了个地方复发。
  const { mapRow } = require('../server/repositories/production-repository')
  const row = mapRow({ id: 1, status: 0, expires_at: '2026-09-24T11:00:00Z', effective_status: 2 })
  assert.equal(row.effectiveStatus, 2, 'mapRow 后应能读到 effectiveStatus')
  assert.equal(row.expiresAt, '2026-09-24T11:00:00Z')
  assert.equal(effectiveStatus(row, '2026-09-24T12:00:00Z'),
    effectiveStatus({ status: 0, expiresAt: '2026-09-24T11:00:00Z' }, '2026-09-24T12:00:00Z'),
    '驼峰化后的行对象喂给 effectiveStatus 必须得到同样结果')
})

test('前端：订单状态展示不得直接读 status', () => {
  const admin = fs.readFileSync(path.join(root, 'src/components/admin/AdminRecharges.vue'), 'utf8')
  const user = fs.readFileSync(path.join(root, 'src/components/user/UserRecharge.vue'), 'utf8')

  assert.doesNotMatch(admin, /scope\.row\.status === 1 \? '已支付' : '未支付'/,
    '后台又回到了「非 1 即未支付」的老写法，僵尸单会被显示成待支付')
  assert.match(admin, /effectiveStatus/, '后台列表没有消费接口下发的 effectiveStatus')
  assert.match(admin, /statusMeta/, '后台缺少状态展示方法')

  assert.doesNotMatch(user, /支持失败/, '「支持失败」是错别字，且 status=2 的语义是已过期')
  assert.match(user, /effectiveStatus/, '商户端没有消费 effectiveStatus')
})

test('报表：pending 口径必须排除惰性过期', () => {
  const report = fs.readFileSync(path.join(root, 'deploy/shadow-report.js'), 'utf8')
  assert.doesNotMatch(report, /\(SELECT count\(\*\) FROM recharges WHERE status=0\) AS pending/,
    '报表又把 status=0 直接当成 pending 了')
  assert.match(report, /r\.expires_at > now\(\)\) AS pending/)
  assert.match(report, /AS pending_expired/)
})

// ---------------------------------------------------- 真库：两条路径必须一致

test('真库对照：JS 与 SQL 的有效状态逐例一致', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl
  const { Pool } = require('pg')
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })

  const created = []
  try {
    const uname = `eff_${process.pid}_${Date.now()}`
    const { rows: users } = await pool.query(
      `INSERT INTO users (username,password_hash,nickname,email,email_verified,status,
                          char_balance,char_used,translate_count,sub_quota,auto_alloc_master,
                          auto_reply,enterprise,port_limit,ports_in_use,remarks)
       VALUES ($1,'scrypt$testsalt$testhash','effstatus',$2,false,1,0,0,0,0,false,false,false,1,0,'')
       RETURNING id`,
      [uname, `${uname}@example.test`]
    )
    const userId = users[0].id
    created.push(userId)

    // 覆盖：真待支付 / 僵尸单 / 到期瞬间 / 终态 / 无 expires_at
    // created / expires 都是相对 now() 的偏移。过期用例必须把创建时间一起回拨 ——
    // 库里有 `expires_at > created_at` 的 CHECK，只回拨 expires 会被直接拒掉。
    const cases = [
      { label: '有效期内', status: STATUS.PENDING, created: '-10 minutes', expires: '+25 minutes' },
      { label: '刚过期', status: STATUS.PENDING, created: '-40 minutes', expires: '-1 second' },
      { label: '过期很久', status: STATUS.PENDING, created: '-4 days', expires: '-3 days' },
      { label: '到期瞬间', status: STATUS.PENDING, created: '-30 minutes', expires: '0 seconds' },
      // status=1 必须同时有 paid_at（recharges_check3），所以这里要回填付款时间
      { label: '已支付但早过期', status: STATUS.PAID, created: '-2 days', expires: '-1 day', paidAt: '-1 day 23 hours' },
      { label: '已取消', status: STATUS.CANCELLED, created: '-2 days', expires: '-1 day' },
      { label: '异常单', status: STATUS.EXCEPTION, created: '-2 days', expires: '-1 day' },
      { label: '已过期终态', status: STATUS.EXPIRED, created: '-2 days', expires: '-1 day' }
    ]

    const ids = []
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]
      // 金额必须逐单不同：recharges 上有 `(payment_type, paid_amount) WHERE status=0`
      // 的部分唯一索引，同价的两张 pending 单会被数据库直接拒掉。
      const amount = (10 + i).toFixed(3)
      const { rows } = await pool.query(
        `INSERT INTO recharges
           (order_number,user_id,kind,payment_type,original_amount,discount_amount,paid_amount,
            surcharge_amount,chars,status,expires_at,created_at,idempotency_key,paid_at)
         VALUES ($1,$2,'characters','usdt-trc20',$3,0,$3,0,1000,$4,
                 now() + $5::interval, now() + $6::interval, $7,
                 CASE WHEN $8::text IS NULL THEN NULL ELSE now() + $8::interval END)
         RETURNING id`,
        [`EFF${Date.now()}${i}`, userId, amount, c.status, c.expires, c.created,
          `effstatus:${uname}:${i}`, c.paidAt || null]
      )
      ids.push(rows[0].id)
    }

    // 一次查询同时取回：原始 status / SQL 有效状态 / JS 有效状态
    const { rows: fetched } = await pool.query(
      `SELECT id, order_number, status, expires_at, ${effectiveStatusSql('r')} AS sql_effective
         FROM recharges r WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [ids]
    )
    assert.equal(fetched.length, cases.length)

    for (let i = 0; i < fetched.length; i++) {
      const row = fetched[i]
      const expected = cases[i]
      const viaJs = effectiveStatus({ status: row.status, expiresAt: row.expires_at }, new Date())
      assert.equal(Number(row.status), expected.status, `${expected.label}: 落库状态不对`)
      assert.equal(Number(row.sql_effective), viaJs,
        `${expected.label}: SQL 算出 ${row.sql_effective}，JS 算出 ${viaJs} —— 两条路径的语义已经漂移`)
      assert.equal(Number(row.sql_effective), effectiveStatus({ status: expected.status, expiresAt: row.expires_at }, new Date()))
    }

    // 只应有 1 张真·待支付（有效期内那张）
    const { rows: live } = await pool.query(
      `SELECT count(*)::int AS n FROM recharges r
        WHERE r.id = ANY($1::bigint[]) AND r.status=0 AND r.expires_at > now()`,
      [ids]
    )
    assert.equal(live[0].n, 1, '真库里应恰好只有 1 张仍然有效的待支付订单')

    // 按有效状态筛选 expired，必须能捞到僵尸单（老写法这里是 0 条）
    const { rows: expired } = await pool.query(
      `SELECT count(*)::int AS n FROM recharges r
        WHERE r.id = ANY($1::bigint[]) AND ${effectiveStatusSql('r')} = ${STATUS.EXPIRED}`,
      [ids]
    )
    // 3 张僵尸单（刚过期 / 过期很久 / 到期瞬间）+ 1 张本来就是终态过期的单
    assert.equal(expired[0].n, 4, '按有效状态筛"已过期"应含 3 张僵尸单 + 1 张终态过期单')
  } finally {
    if (created.length) {
      await pool.query('DELETE FROM recharge_amount_reservations WHERE recharge_id IN (SELECT id FROM recharges WHERE user_id = ANY($1::bigint[]))', [created])
      await pool.query('DELETE FROM recharges WHERE user_id = ANY($1::bigint[])', [created])
      await pool.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [created])
    }
    await pool.end()
  }
})
