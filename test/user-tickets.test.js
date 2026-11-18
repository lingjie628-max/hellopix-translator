/**
 * 商户端工单：越权边界 + 内部备注隔离 + 状态流转。
 *
 * ## 为什么这几条必须钉死
 *
 * 商户端是**对外**接口，出错的后果和管理端不是一个量级：
 *   · 按 id 取单不校验归属 → 改个 URL 数字就能读别人和客服的对话；
 *   · 内部备注被带出去 → 客服写的"这客户有点难缠"直接给客户看到；
 *   · 已关闭的单还能回复 → 时间线被改写，审计记录失去意义。
 * 这三条都不会崩，只会静默泄数据。所以逐条写成断言。
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const { registerUserTickets } = require('../server/routes/user-tickets')

/**
 * 假 router + 假 repo。
 *
 * repo 按 SQL 意图返回最小形状，并记录每条 SQL 与参数 ——
 * 归属校验不是靠读代码确认的，是靠检查「SQL 里到底有没有 user_id=$2」。
 */
function harness (opts) {
  const o = opts || {}
  const queries = []
  const repo = {
    async transaction (work) {
      return work()
    },
    query: async (sql, values) => {
      const text = String(sql)
      queries.push({ sql: text, values })
      // 回复前的归属+状态查询。必须排在详情查询之前匹配 ——
      // 两条 SQL 都以 `FROM tickets WHERE id=$1` 开头，顺序反了会被吃掉，
      // 结果变成「工单不存在」。
      if (/SELECT id,status FROM tickets WHERE id=\$1/.test(text)) {
        return { rows: o.ownTicket ? [{ id: 7, status: o.ownTicket.status }] : [] }
      }
      if (/FROM tickets WHERE id=\$1 AND user_id=\$2/.test(text)) {
        return { rows: o.ticket ? [Object.assign({}, o.ticket)] : [] }
      }
      if (/FROM ticket_messages/.test(text)) {
        return { rows: o.messages || [] }
      }
      // 未读计数要在「未关闭」计数之前判，两条 SQL 都带 status <> 'closed'
      if (/user_unread=true|admin_unread = true/.test(text)) {
        return { rows: [{ n: o.unread || 0 }] }
      }
      if (/count\(\*\).*status <> 'closed'.*FROM tickets WHERE user_id/.test(text) ||
          /FROM tickets WHERE user_id=\$1 AND status <> 'closed'/.test(text)) {
        return { rows: [{ n: o.openCount || 0 }] }
      }
      if (/count\(\*\)/.test(text)) {
        return { rows: [{ n: o.total || 0 }] }
      }
      if (/INSERT INTO tickets\(/.test(text)) return { rows: [{ id: 42 }] }
      if (/INSERT INTO ticket_messages/.test(text)) return { rows: [{ id: 501 }] }
      return { rows: [], rowCount: 1 }
    }
  }
  const routes = new Map()
  const router = {
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h)
  }
  registerUserTickets(router, { repo })

  /** 主账号 session：id=100 / username=jiufa */
  const mainSession = {
    kind: 'main',
    parent: { id: 100, username: 'jiufa' },
    account: { id: 100, username: 'jiufa' }
  }
  /** 子账号 session：挂在同一个主账号名下 */
  const subSession = {
    kind: 'sub',
    parent: { id: 100, username: 'jiufa' },
    account: { id: 205, username: 'kefu01' }
  }

  async function call (key, data, session) {
    const handler = routes.get(key)
    assert.ok(handler, `${key} 没注册`)
    const body = Object.assign({}, data || {})
    const params = body.__params || {}
    delete body.__params
    const req = {
      params,
      body,
      query: body,
      headers: {},
      ip: '203.0.113.9',
      pixUser: session === undefined ? mainSession : session,
      get: () => ''
    }
    const out = { body: null, status: 200 }
    const res = {
      json: (b) => { out.body = b },
      status: (s) => { out.status = s; return res }
    }
    let settled
    let done = false
    const finish = (err) => {
      if (done) return
      done = true
      if (err) settled = err
      else settled = null
    }
    try {
      await handler(req, res, finish)
    } catch (err) {
      if (!done) { done = true; settled = err }
    }
    // 异步 handler 里抛的错会走 next()
    for (let i = 0; i < 50 && !done; i++) await new Promise(r => setImmediate(r))
    if (settled) throw settled
    return out
  }

  return { call, queries, routes }
}

// ── 越权边界 ──────────────────────────────────────────────

test('取单详情必须带归属条件：少了 user_id 就是改 URL 就能读别人对话', async () => {
  const h = harness({ ticket: { id: 7, subject: 's', category: 'bug', priority: 'low', status: 'new' } })
  await h.call('GET /tickets/:id', { __params: { id: '7' } })
  const q = h.queries.find(x => /FROM tickets WHERE id=\$1/.test(x.sql))
  assert.ok(q, '应该查了工单')
  assert.match(q.sql, /user_id=\$2/, '详情查询必须带 user_id 归属条件')
  assert.deepEqual(q.values, [7, 100], '参数必须是被查询的单号 + 自己的主账号 id')
})

test('别人的工单回 404 而不是 403（403 等于承认这个单号存在）', async () => {
  const h = harness({ ticket: null })
  await assert.rejects(
    () => h.call('GET /tickets/:id', { __params: { id: '999' } }),
    (err) => {
      assert.equal(err.status, 404, '必须回 404')
      assert.equal(err.code, 'TICKET_NOT_FOUND')
      return true
    }
  )
})

test('内部备注不能发给商户：过滤必须在 SQL 里，不能靠前端不渲染', async () => {
  const h = harness({ ticket: { id: 7, status: 'waiting_user' }, messages: [] })
  await h.call('GET /tickets/:id', { __params: { id: '7' } })
  const q = h.queries.find(x => /FROM ticket_messages/.test(x.sql))
  assert.ok(q, '应该查了消息流')
  assert.match(q.sql, /internal\s*=\s*false/, '消息查询必须带 internal=false 条件')
})

test('回复必须校验归属：SQL 带 user_id，且只对自己名下的单生效', async () => {
  const h = harness({ ownTicket: { status: 'in_progress' } })
  await h.call('POST /tickets/reply', { id: 7, body: '补充一下' })
  const q = h.queries.find(x => /SELECT id,status FROM tickets WHERE id=\$1 AND user_id=\$2/.test(x.sql))
  assert.ok(q, '回复前的状态查询必须带归属条件')
  assert.deepEqual(q.values, [7, 100])
})

// ── 状态流转 ──────────────────────────────────────────────

test('商户回复「待商户回复」的单 → 回到处理中，客服才看得到', async () => {
  const h = harness({ ownTicket: { status: 'waiting_user' } })
  await h.call('POST /tickets/reply', { id: 7, body: '还没好' })
  const upd = h.queries.find(x => /UPDATE tickets SET status=\$2/.test(x.sql))
  assert.ok(upd, '应该更新了状态')
  assert.equal(upd.values[1], 'in_progress', 'waiting_user 收到商户回复应推回 in_progress')
})

test('商户回复「处理中」的单不重置客服的接单状态', async () => {
  const h = harness({ ownTicket: { status: 'in_progress' } })
  await h.call('POST /tickets/reply', { id: 7, body: '再补一句' })
  const upd = h.queries.find(x => /UPDATE tickets SET status=\$2/.test(x.sql))
  assert.equal(upd.values[1], 'in_progress', 'in_progress 应该保持不动')
})

test('已关闭的单不能回复（时间线被改写＝审计失效）', async () => {
  const h = harness({ ownTicket: { status: 'closed' } })
  await assert.rejects(
    () => h.call('POST /tickets/reply', { id: 7, body: '还能再问吗' }),
    (err) => { assert.equal(err.code, 'TICKET_CLOSED'); return true }
  )
})

test('回复后必须点亮客服侧未读，否则新消息躺在列表里没人管', async () => {
  const h = harness({ ownTicket: { status: 'in_progress' } })
  await h.call('POST /tickets/reply', { id: 7, body: '看下这个' })
  const upd = h.queries.find(x => /UPDATE tickets SET status=\$2/.test(x.sql))
  assert.match(upd.sql, /admin_unread=true/)
})

test('商户读详情即视为已读：user_unread 置 false', async () => {
  const h = harness({ ticket: { id: 7, status: 'in_progress' }, messages: [] })
  await h.call('GET /tickets/:id', { __params: { id: '7' } })
  assert.ok(h.queries.some(x => /UPDATE tickets SET user_unread=false/.test(x.sql)), '应该清了商户侧未读')
})

// ── 提单校验 ──────────────────────────────────────────────

test('提单：标题和描述都必填，且不能提交空描述', async () => {
  const h = harness()
  await assert.rejects(() => h.call('POST /tickets/create', { subject: '', body: 'x' }),
    (err) => { assert.equal(err.code, 'TICKET_SUBJECT_REQUIRED'); return true })
  await assert.rejects(() => h.call('POST /tickets/create', { subject: '充值没到账', body: '   ' }),
    (err) => { assert.equal(err.code, 'TICKET_BODY_REQUIRED'); return true })
})

test('提单：新单必须是 admin_unread=true，否则客服红点不亮', async () => {
  const h = harness()
  await h.call('POST /tickets/create', { subject: '充值没到账', body: '付了 20U' })
  const ins = h.queries.find(x => /INSERT INTO tickets\(/.test(x.sql))
  assert.ok(ins, '应该插入了工单')
  assert.match(ins.sql, /admin_unread/)
  assert.match(ins.sql, /true,false/, 'admin_unread 应为 true、user_unread 为 false')
})

test('提单：商户不能自选优先级（否则全都选紧急）', async () => {
  const h = harness()
  await h.call('POST /tickets/create', { subject: '出bug了', body: '打不开', priority: 'urgent' })
  const ins = h.queries.find(x => /INSERT INTO tickets\(/.test(x.sql))
  assert.notEqual(ins.values[6], 'urgent', '提交的 priority 不应被采用')
})

test('提单：未关闭的单满 20 张就拦截（防止同一问题开十张）', async () => {
  const h = harness({ openCount: 20 })
  await assert.rejects(() => h.call('POST /tickets/create', { subject: '再来一张', body: 'x' }),
    (err) => { assert.equal(err.code, 'TICKET_TOO_MANY_OPEN'); return true })
})

test('提单：正文作为第一条消息落库，而不是塞进 tickets 表', async () => {
  const h = harness()
  await h.call('POST /tickets/create', { subject: '翻译不准', body: '这句翻错了' })
  const msg = h.queries.find(x => /INSERT INTO ticket_messages/.test(x.sql))
  assert.ok(msg, '应该写入首条消息')
  assert.equal(msg.values[2], '这句翻错了')
  assert.match(msg.sql, /'user'/, '作者类型必须是 user')
})

// ── 子账号 ────────────────────────────────────────────────

test('子账号提单挂在主账号名下（客服核对充值要找主账号）', async () => {
  const h = harness()
  await h.call('POST /tickets/create', { subject: '子账号登不上', body: '一直转圈' }, {
    kind: 'sub',
    parent: { id: 100, username: 'jiufa' },
    account: { id: 205, username: 'kefu01' }
  })
  const ins = h.queries.find(x => /INSERT INTO tickets\(/.test(x.sql))
  assert.equal(ins.values[0], 100, 'user_id 必须是主账号 id')
  assert.equal(ins.values[2], 'sub', 'submitter_kind 应记为 sub')
  assert.equal(ins.values[3], 'kefu01', 'submitter_name 要记下真实提交人')
})

test('没有登录态时直接拒绝，不兜底成某个 id（兜底会把 bug 变成越权）', async () => {
  const h = harness()
  await assert.rejects(() => h.call('GET /tickets', {}, null),
    (err) => { assert.equal(err.code, 'USER_AUTH_REQUIRED'); return true })
})

// ── 未读 ──────────────────────────────────────────────────

test('未读只数客服回了、商户没看、且未关闭的单', async () => {
  const h = harness({ unread: 3 })
  const out = await h.call('GET /tickets-unread')
  const q = h.queries.find(x => /user_unread=true/.test(x.sql))
  assert.match(q.sql, /status <> 'closed'/, '已关闭的单不该进未读')
  assert.match(q.sql, /user_id=\$1/)
  assert.equal(out.body.unread, 3)
})

// ── 路由清单 ──────────────────────────────────────────────

test('商户端工单没有删除接口', () => {
  const h = harness()
  for (const key of h.routes.keys()) {
    assert.doesNotMatch(key, /delete/i, `${key}：商户端不该有删除工单的能力`)
  }
})
