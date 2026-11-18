/**
 * 工单系统：状态机 + 路由行为 + 权限边界。
 *
 * ## 为什么状态机要用单测钉死
 *
 * 工单的 bug 通常不是崩溃，而是**悄悄算错**：
 *   · 已关闭的单被重开 → 平均解决时长和复发率全部失真；
 *   · 反复「解决→重开→再解决」把 resolved_at 刷成最后一次 → 时长被稀释；
 *   · 商户回复已解决的单却没回到处理中 → 客服永远看不到。
 * 这三类都不会报错，只会让统计慢慢变成废数据。所以逐条写成断言。
 *
 * ## 路由测试为了什么
 *
 * 路由里的 SQL 参数拼接（动态 SET / WHERE）最容易出错，而且出错方式是
 * 「值写进了错误的列」—— 不崩、不报错、数据静默错位。这里用假 repo
 * 捕获 SQL 和参数，逐条核对。
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  STATUSES, PRIORITIES, CATEGORIES, canTransition, nextState, afterUserReply,
  normalizePriority, normalizeCategory
} = require('../server/services/ticket-service')
const { registerAdminTickets } = require('../server/routes/admin/tickets')
const { ROUTE_CAPS, OPERATOR_CAPS, HIGH_RISK_CAPS, allows, requiresReauth } = require('../server/lib/capabilities')

// ── 状态机 ────────────────────────────────────────────────

test('已关闭是终态：不能重开成任何状态（否则时长/复发率失真）', () => {
  for (const to of STATUSES) {
    assert.equal(canTransition('closed', to), false, `closed → ${to} 不该允许`)
  }
})

test('resolved 可以退回 in_progress（商户说还没好），但不能再回到 new', () => {
  assert.equal(canTransition('resolved', 'in_progress'), true)
  assert.equal(canTransition('resolved', 'new'), false)
})

test('同状态流转被拒绝（避免刷 updated_at 造成"刚有动静"的假象)', () => {
  for (const s of STATUSES) assert.equal(canTransition(s, s), false, s)
})

test('非法状态值不抛错也不放行 —— 返回 false', () => {
  assert.equal(canTransition('bogus', 'closed'), false)
  assert.equal(canTransition('new', ''), false)
  assert.equal(canTransition(null, 'new'), false)
})

test('第一次进入 resolved 写 resolved_at，之后不再覆盖', () => {
  const t1 = new Date('2026-01-01T00:00:00Z')
  const t2 = new Date('2026-02-01T00:00:00Z')

  const first = nextState({ status: 'in_progress' }, 'resolved', t1)
  assert.equal(first.resolvedAt.getTime(), t1.getTime())

  // 退回 in_progress（不清时间戳）→ 再次 resolved：必须保留第一次的时间
  const back = nextState({ status: 'resolved', resolved_at: first.resolvedAt }, 'in_progress', t2)
  assert.equal(back.resolvedAt.getTime(), t1.getTime(), '退回时不能擦掉 resolved_at')

  const again = nextState({ status: 'in_progress', resolved_at: back.resolvedAt }, 'resolved', t2)
  assert.equal(again.resolvedAt.getTime(), t1.getTime(), '第二次解决不能覆盖首次解决时间')
})

test('第一次进入 closed 写 closed_at，resolved_at 缺失时保持为空', () => {
  const now = new Date('2026-03-01T00:00:00Z')
  const s = nextState({ status: 'new' }, 'closed', now)
  assert.equal(s.closedAt.getTime(), now.getTime())
  assert.equal(s.resolvedAt, null)
})

test('非法流转抛 ApiError（带 status=400），而不是静默改成合法值', () => {
  assert.throws(() => nextState({ status: 'closed' }, 'in_progress'), err => {
    assert.equal(err.status, 400)
    assert.equal(err.code, 'TICKET_BAD_TRANSITION')
    return true
  })
})

test('商户回复：球在商户那边时推回 in_progress，其它状态不动', () => {
  assert.equal(afterUserReply('waiting_user'), 'in_progress')
  assert.equal(afterUserReply('resolved'), 'in_progress')
  // 商户在客服正在处理的单上追加信息，不该把接单状态重置
  assert.equal(afterUserReply('in_progress'), 'in_progress')
  assert.equal(afterUserReply('new'), 'new')
  // 已关闭的不该被回复改写（路由层会直接拒绝）
  assert.equal(afterUserReply('closed'), 'closed')
})

test('优先级 / 分类：空值给默认，非法值拒绝', () => {
  assert.equal(normalizePriority(undefined), 'medium')
  assert.equal(normalizeCategory(''), 'other')
  assert.throws(() => normalizePriority('critical'), /优先级/)
  assert.throws(() => normalizeCategory('refund'), /分类/)
  // 大小写不宽容：数据库 CHECK 也是精确匹配
  assert.throws(() => normalizePriority('URGENT'))
  assert.equal(PRIORITIES.length, 4)
  assert.equal(CATEGORIES.length, 6)
})

// ── 权限边界 ──────────────────────────────────────────────

test('工单读档对 operator 开放（客服的本职工作）', () => {
  const OPERATOR = { role: 'operator' }
  assert.equal(allows(OPERATOR, 'admin.read.ticket').allowed, true)
  assert.equal(allows(OPERATOR, 'admin.write.ticket').allowed, true)
})

test('工单能力不标高危：客服一天回几十条，每条都要输密码等于不可用', () => {
  assert.equal(HIGH_RISK_CAPS.has('admin.write.ticket'), false)
  assert.equal(requiresReauth('POST', 'admin.write.ticket'), false)
})

test('工单路由没有删除接口（工单是审计证据，只能关闭）', () => {
  const ticketRoutes = Object.keys(ROUTE_CAPS).filter(k => k.includes('/admin/tickets'))
  assert.ok(ticketRoutes.length > 0)
  for (const route of ticketRoutes) {
    assert.doesNotMatch(route, /^DELETE /, `${route}：不应该有删除工单的接口`)
    assert.doesNotMatch(route, /delete/i, `${route}：不应该有删除工单的接口`)
  }
})

test('工单列表面板不能借道变成客户数据接口', () => {
  // 读工单不等于读全站客户名单。两者的能力名必须不同 ——
  // 否则将来把 admin.data.customers 下放给 operator 时，工单会一起被牵连。
  assert.notEqual(ROUTE_CAPS['GET /admin/tickets'], ROUTE_CAPS['GET /admin/customers'])
})

// ── 路由行为 ──────────────────────────────────────────────

/**
 * 造一个只记录 SQL 的假 router + 假 repo，用来直接调用 handler。
 */
function harness () {
  const queries = []
  const audits = []
  const repo = {
    query: async (sql, values) => {
      queries.push({ sql: String(sql), values })
      // 按调用意图返回最小的形状，让 handler 能往下走
      if (/FROM tickets WHERE id=\$1/.test(sql)) {
        const row = harness.ticket
        return { rows: row ? [Object.assign({}, row)] : [] }
      }
      if (/count\(\*\)/.test(sql)) return { rows: [{ total: 0 }] }
      if (/INSERT INTO tickets/.test(sql)) return { rows: [{ id: 99 }] }
      if (/INSERT INTO ticket_messages/.test(sql)) return { rows: [{ id: 501, created_at: new Date() }] }
      return { rows: [] }
    },
    audit: async (_c, _a, action, detail) => { audits.push({ action, detail }) }
  }

  const routes = new Map()
  const router = {
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h)
  }
  registerAdminTickets(router, { repo })

  /**
   * 调一个 handler，返回 { status, body }。
   *
   * body 里以 `__` 开头的键是测试自己用的：`__params` 塞路由参数，
   * 其余原样作为请求体。分开处理是因为路由有的从 params 取 id、有的从 body 取。
   */
  async function call (key, { body = {}, admin = { username: 'kefu', nickname: '客服小张' } } = {}) {
    const handler = routes.get(key)
    assert.ok(handler, `${key} 没注册`)
    const params = body.__params || {}
    const payload = {}
    for (const k of Object.keys(body)) if (!k.startsWith('__')) payload[k] = body[k]
    // 本项目的 POST 走 query 参数（见 utils/api.js 的 postRequest），
    // input(req) 把 query + body 合并，两边都放更贴近真实请求。
    const req = { params, body: payload, query: payload, headers: {}, ip: '203.0.113.9', pixAdmin: admin, get: () => '' }
    const out = { json: null, status: 200 }
    let settle
    let done = false
    const finish = (error) => {
      if (done) return
      done = true
      if (error) {
        out.status = error.status || 500
        out.json = { msg: error.message, code: error.code }
      }
      if (settle) settle()
    }
    const res = {
      json: (data) => { out.json = data; finish() },
      status: (code) => { out.status = code; return res }
    }
    await new Promise(resolve => {
      settle = resolve
      // 同步抛出的错误也走 settle：进 Promise 之前先兜一层
      try {
        handler(req, res, finish)
      } catch (error) {
        finish(error)
      }
    })
    return out
  }

  return { queries, audits, routes, call, repo }
}

test('回复：内部备注不通知商户，也不改状态', async () => {
  const h = harness()
  harness.ticket = { id: 7, status: 'waiting_user', assignee: 'kefu' }
  const out = await h.call('POST /admin/tickets/reply', { body: { id: 7, body: '这个客户之前也报过', internal: 1 } })
  assert.equal(out.status, 200)

  const msgInsert = h.queries.find(q => /INSERT INTO ticket_messages/.test(q.sql))
  assert.equal(msgInsert.values[4], true, 'internal 应写进消息表')

  const update = h.queries.find(q => /UPDATE tickets SET last_reply_at/.test(q.sql))
  assert.doesNotMatch(update.sql, /user_unread=true/, '内部备注不能把商户标成未读')
  assert.doesNotMatch(update.sql, /status=\$2/, '内部备注不能改状态')
})

test('回复：从「待商户回复」正式回复后推回处理中，并标记商户未读', async () => {
  const h = harness()
  harness.ticket = { id: 7, status: 'waiting_user', assignee: 'kefu' }
  await h.call('POST /admin/tickets/reply', { body: { id: 7, body: '已帮你补了 10 万字符', internal: 0 } })

  const update = h.queries.find(q => /UPDATE tickets SET last_reply_at/.test(q.sql))
  assert.match(update.sql, /user_unread=true/)
  assert.equal(update.values[1], 'in_progress', '球回到客服这边')
  assert.doesNotMatch(update.sql, /resolved_at=/, '回复不能动 resolved_at')
})

test('回复：等待中的单被回复时自动接单（assignee 为空才认领）', async () => {
  const h = harness()
  harness.ticket = { id: 7, status: 'waiting_user', assignee: '' }
  await h.call('POST /admin/tickets/reply', { body: { id: 7, body: '收到' } })
  const update = h.queries.find(q => /UPDATE tickets SET last_reply_at/.test(q.sql))
  assert.match(update.sql, /assignee=CASE WHEN assignee=''/, '已有负责人的不该被抢单')
  assert.equal(update.values[2], 'kefu')
})

test('回复：已关闭的工单拒绝写入（终态不能被追加消息）', async () => {
  const h = harness()
  harness.ticket = { id: 7, status: 'closed' }
  const out = await h.call('POST /admin/tickets/reply', { body: { id: 7, body: '再补一句' } })
  assert.equal(out.status, 400)
  assert.equal(out.json.code, 'TICKET_CLOSED')
  assert.equal(h.queries.filter(q => /INSERT INTO ticket_messages/.test(q.sql)).length, 0, '不该写消息')
})

test('回复：空内容直接 400，不打数据库', async () => {
  const h = harness()
  harness.ticket = { id: 7, status: 'in_progress' }
  const out = await h.call('POST /admin/tickets/reply', { body: { id: 7, body: '   ' } })
  assert.equal(out.status, 400)
  assert.equal(h.queries.length, 0)
})

test('改状态：参数顺序与列名严格对应（否则值静默写进错误的列）', async () => {
  const h = harness()
  harness.ticket = { id: 7, status: 'in_progress', resolved_at: null, closed_at: null }
  await h.call('POST /admin/tickets/update', { body: { id: 7, status: 'resolved' } })

  const update = h.queries.find(q => /UPDATE tickets SET status=/.test(q.sql))
  assert.ok(update, '应当发出 UPDATE')
  // values[0] 固定是 id，后面按 $2/$3/... 的登记顺序
  assert.equal(update.values[0], 7)
  const columns = [...update.sql.matchAll(/(\w+)=\$(\d+)/g)].map(m => [m[1], Number(m[2])])
  for (const [column, index] of columns) {
    if (column === 'status') assert.equal(update.values[index - 1], 'resolved')
    if (column === 'resolved_at') assert.ok(update.values[index - 1] instanceof Date, 'resolved_at 应是时间')
  }
})

test('改状态：非法流转 400，且不发出 UPDATE', async () => {
  const h = harness()
  harness.ticket = { id: 7, status: 'closed' }
  const out = await h.call('POST /admin/tickets/update', { body: { id: 7, status: 'new' } })
  assert.equal(out.status, 400)
  assert.equal(h.queries.filter(q => /UPDATE tickets SET/.test(q.sql)).length, 0)
})

test('改状态：会留一条审计（谁把单从哪改到哪）', async () => {
  const h = harness()
  harness.ticket = { id: 7, status: 'in_progress', resolved_at: null, closed_at: null }
  await h.call('POST /admin/tickets/update', { body: { id: 7, status: 'resolved' } })
  assert.equal(h.audits.length, 1)
  assert.match(h.audits[0].detail, /#7 处理中 → 已解决/)
})

test('改状态：解决/关闭时清客服红点、标商户未读（单有结论了）', async () => {
  const h = harness()
  harness.ticket = { id: 7, status: 'in_progress', resolved_at: null, closed_at: null }
  await h.call('POST /admin/tickets/update', { body: { id: 7, status: 'resolved' } })
  const update = h.queries.find(q => /UPDATE tickets SET status=/.test(q.sql))
  assert.match(update.sql, /admin_unread=false/)
  assert.match(update.sql, /user_unread=true/)
})

test('改字段：什么都没给时 400，而不是发一条空 UPDATE', async () => {
  const h = harness()
  harness.ticket = { id: 7, status: 'in_progress' }
  const out = await h.call('POST /admin/tickets/update', { body: { id: 7 } })
  assert.equal(out.status, 400)
  assert.equal(out.json.code, 'TICKET_NOTHING_TO_UPDATE')
})

test('开单：主题或内容为空直接拒绝', async () => {
  const h = harness()
  for (const body of [{ body: '有内容' }, { subject: '有主题' }]) {
    const out = await h.call('POST /admin/tickets/create', { body })
    assert.equal(out.status, 400)
  }
  assert.equal(h.queries.length, 0)
})

test('开单：商户名从库里取，不信前端传的快照（防止把 A 的票挂到 B 名下）', async () => {
  const h = harness()
  // 让 users 查询返回一条真实记录
  const originalQuery = h.repo.query
  h.repo.query = async (sql, values) => {
    if (/FROM users WHERE id=\$1/.test(sql)) return { rows: [{ id: 10001, username: 'pix' }] }
    return originalQuery(sql, values)
  }
  const out = await h.call('POST /admin/tickets/create', {
    body: { subject: '充不上', body: '客户说付款没到账', userId: 10001, username: '冒充的名字' }
  })
  assert.equal(out.status, 200)
  const insert = h.queries.find(q => /INSERT INTO tickets/.test(q.sql))
  assert.equal(insert.values[1], 'pix', '商户名必须来自数据库')
  assert.ok(!insert.values.includes('冒充的名字'), '前端传的 username 不能落库')
})

test('列表：关键词与状态条件都走参数化（不拼字符串）', async () => {
  const h = harness()
  await h.call('GET /admin/tickets', { body: { status: 'in_progress', keyword: "x'; DROP TABLE tickets;--" } })
  const listQuery = h.queries.find(q => /FROM tickets WHERE/.test(q.sql))
  assert.ok(listQuery)
  assert.doesNotMatch(listQuery.sql, /DROP TABLE/, '用户输入不能进 SQL 文本')
  assert.ok(listQuery.values.some(v => String(v).includes('DROP TABLE')), '应作为参数传入')
})

test('列表：status=open 时不带参数（未关闭是固定条件，不是用户值）', async () => {
  const h = harness()
  await h.call('GET /admin/tickets', { body: { status: 'open' } })
  // 注意要挑 LIMIT 那一条：count 查询也是 FROM tickets WHERE，参数为空
  const listQuery = h.queries.find(q => /LIMIT \$/.test(q.sql))
  assert.match(listQuery.sql, /status <> 'closed'/)
  assert.equal(listQuery.values.length, 2, '只有 LIMIT/OFFSET 两个参数')
  assert.deepEqual(listQuery.values, [30, 0], '参数必须是 [size, offset]，顺序反了会静默翻错页')
})

test('列表：非法 status 400，不打数据库', async () => {
  const h = harness()
  const out = await h.call('GET /admin/tickets', { body: { status: 'deleted' } })
  assert.equal(out.status, 400)
  assert.equal(h.queries.length, 0)
})

test('详情：打开即清客服未读', async () => {
  const h = harness()
  harness.ticket = { id: 7, status: 'new', admin_unread: true }
  const out = await h.call('GET /admin/tickets/:id', { body: { __params: { id: 7 } } })
  assert.equal(out.status, 200)
  assert.ok(h.queries.some(q => /SET admin_unread=false/.test(q.sql)), '详情页打开要清红点')
  assert.equal(out.json.adminUnread, false)
})

test('详情：不存在的票 404', async () => {
  const h = harness()
  harness.ticket = null
  const out = await h.call('GET /admin/tickets/:id', { body: { __params: { id: 12345 } } })
  assert.equal(out.status, 404)
  assert.equal(out.json.code, 'TICKET_NOT_FOUND')
})

/**
 * 写操作靠 mustGet 取当前状态。它少查一列，写操作就会把那一列当成
 * undefined —— 而 undefined 在参数化里是 NULL，等于**静默清空**。
 *
 * 真机上踩过一次：mustGet 没查 user_unread，内部备注后商户红点被抹掉。
 * 这条断言把列清单钉死。
 */
test('mustGet 必须查全状态机与未读标记需要的列', async () => {  const h = harness()
  harness.ticket = { id: 7, status: 'in_progress' }
  await h.call('GET /admin/tickets/:id', { body: { __params: { id: 7 } } })
  const q = h.queries.find(x => /FROM tickets WHERE id=\$1/.test(x.sql))
  for (const column of ['status', 'resolved_at', 'closed_at', 'admin_unread', 'user_unread', 'assignee']) {
    assert.match(q.sql, new RegExp(`\\b${column}\\b`), `mustGet 缺少 ${column}：写操作会把该列写成 NULL`)
  }
})

// ── mock 与真后端行为一致 ─────────────────────────────────
//
// 本地开发全对着 mock 跑。mock 对非法输入"宽容"（返回空列表），
// 真后端会 400 —— 本地一路正常，上线才发现错误处理压根没生效。
// 这一组用同一批非法输入分别打 mock 和路由，要求状态码一致。

test('mock 对非法枚举的处理与真后端一致（都 400，不静默吞掉）', async () => {
  const express = require('express')
  const registerMock = require('../mock')
  const { createSecurity } = require('../server/security')

  const app = express()
  app.use('/apis', express.urlencoded({ extended: true }))
  app.use('/apis', express.json())
  registerMock(app, { security: createSecurity({ production: false }), testMode: true })

  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}/apis`

  try {
    const login = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=admin&password=admin123'
    })
    assert.equal(login.status, 200)
    // 同名 cookie 先清空再赋值，只保留最后一个非空值
    const jar = {}
    for (const raw of login.headers.getSetCookie()) {
      const [k, v] = raw.split(';')[0].split('=')
      if (v) jar[k] = v
    }
    const headers = {
      cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
      'x-csrf-token': decodeURIComponent(jar.pix_csrf || '')
    }

    const badStatus = await fetch(`${base}/admin/tickets?status=deleted`, { headers })
    assert.equal(badStatus.status, 400, 'mock 对非法 status 应和真后端一样回 400')

    const badCategory = await fetch(`${base}/admin/tickets/create?subject=x&body=y&category=refund`, { method: 'POST', headers })
    assert.equal(badCategory.status, 400, 'mock 对非法分类应和真后端一样回 400')

    // 正常输入仍然通过
    const okCreate = await fetch(`${base}/admin/tickets/create?subject=${encodeURIComponent('测试单')}&body=内容`, { method: 'POST', headers })
    assert.equal(okCreate.status, 200)
  } finally {
    server.close()
  }
})

// ── 侧栏未读数 ────────────────────────────────────────────

test('未读数只回数字，不带任何工单内容（侧栏每页都在轮询它）', async () => {
  const h = harness()
  const out = await h.call('GET /admin/tickets-unread', { body: {} })
  assert.equal(out.status, 200)
  assert.deepEqual(Object.keys(out.json), ['unread'], '只能回 unread 一个字段')
  assert.equal(typeof out.json.unread, 'number')

  const q = h.queries.find(x => /count\(\*\)/.test(x.sql))
  assert.match(q.sql, /admin_unread = true/)
  assert.match(q.sql, /status <> 'closed'/, '已关闭的不该算进未读数')
})

test('未读数接口有独立的能力声明（否则鉴权层查不到，线上直接 500）', () => {
  const cap = ROUTE_CAPS['GET /admin/tickets-unread']
  assert.ok(cap, '必须登记能力')
  assert.equal(OPERATOR_CAPS.has(cap), true, '客服要能看到自己的未读数')
})

test('未读数不能被路由参数吞掉：/admin/tickets-unread 不等于 /admin/tickets/:id', async () => {
  // Express 里 `/admin/tickets/:id` 会匹配 `/admin/tickets-unread`（把 unread 当 id）。
  // 注册顺序决定谁先命中：unread 必须在 :id 之前。这里用真实 router 验证。
  const express = require('express')
  const { matchRouteTemplate } = require('../server/lib/route-match')
  const router = express.Router()
  registerAdminTickets(router, { repo: { query: async () => ({ rows: [] }), audit: async () => {} } })
  assert.equal(matchRouteTemplate(router, 'GET', '/admin/tickets-unread'), '/admin/tickets-unread',
    'unread 被 :id 抢走了：红点会拿到 404 或把一个叫 unread 的工单当详情')
})

test('转入「待商户回复」必须点亮商户未读（否则追问静默躺在库里）', async () => {
  const h = harness()
  harness.ticket = { id: 7, status: 'in_progress', resolved_at: null, closed_at: null }
  await h.call('POST /admin/tickets/update', { body: { id: 7, status: 'waiting_user' } })
  const update = h.queries.find(q => /UPDATE tickets SET status=/.test(q.sql))
  assert.match(update.sql, /user_unread=true/, '球交给商户了，商户必须收到通知')
})
