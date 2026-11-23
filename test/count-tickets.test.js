'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  CountTicketService,
  normalizeTicket,
  normalizeDedupScope,
  normalizeLinkedTicketIds,
  normalizeGroup,
  normalizeBaseLines,
  normalizeShare,
  shareTokenHash,
  validTimezone,
  validZeroTime
} = require('../server/services/count-ticket-service')
const { CoreService } = require('../server/services/core-service')
const { CountTicketRepository } = require('../server/repositories/count-ticket-repository')
const { capabilityFor } = require('../server/lib/capabilities')
const { packageAllowsCounter } = require('../server/lib/client-catalog')
const { CustomerRepository } = require('../server/repositories/customer-repository')
const { CustomerIdentityService } = require('../server/services/customer-identity-service')
const { publicUser } = require('../server/routes/context')

const databaseUrl = process.env.PIX_TEST_DATABASE_URL

test('计数工单参数：时区、置零时间；目标设置已退役', () => {
  assert.equal(validTimezone('Asia/Shanghai'), 'Asia/Shanghai')
  assert.throws(() => validTimezone('Mars/Olympus'), error => error.code === 'COUNT_TIMEZONE_BAD')
  assert.equal(validZeroTime('04:30'), '04:30:00')
  assert.equal(validZeroTime('23:59:58'), '23:59:58')
  assert.throws(() => validZeroTime('24:00'), error => error.code === 'COUNT_ZERO_TIME_BAD')

  const normalized = normalizeTicket({
    title: '  WhatsApp 进粉  ',
    platform: 'whatsapp-green',
    dayTarget: '12',
    totalTarget: -3,
    timezone: 'Asia/Shanghai',
    zeroTime: '04:00'
  })
  assert.equal(normalized.title, 'WhatsApp 进粉')
  assert.equal(normalized.platform, 'whatsapp-green')
  assert.equal(Object.hasOwn(normalized, 'dayTarget'), false)
  assert.equal(Object.hasOwn(normalized, 'totalTarget'), false)
  assert.equal(normalized.zeroTime, '04:00:00')
})

test('计数工单查重范围：默认保持同商户，支持当前工单和指定工单', () => {
  assert.equal(normalizeDedupScope(undefined), 'merchant')
  assert.equal(normalizeDedupScope('merchant'), 'merchant')
  assert.equal(normalizeDedupScope('ticket'), 'ticket')
  assert.equal(normalizeDedupScope('group'), 'group')
  assert.equal(normalizeDedupScope('linked'), 'linked')
  assert.throws(
    () => normalizeDedupScope('global'),
    error => error.code === 'COUNT_DEDUP_SCOPE_BAD'
  )
  assert.deepEqual(normalizeLinkedTicketIds([9, '3', 3, 1]), [1, 3, 9])
  assert.throws(
    () => normalizeLinkedTicketIds([-1]),
    error => error.code === 'COUNT_DEDUP_LINKS_BAD'
  )
  assert.deepEqual(
    normalizeGroup({ name: '  马来 A 组 ', platform: 'WhatsApp-Green' }),
    { id: null, name: '马来 A 组', platform: 'whatsapp-green' }
  )
  const base = normalizeBaseLines([
    'username,name,source',
    '628111----客户甲----WhatsApp',
    '628111----客户甲更新----广告',
    '628222,客户乙,LINE'
  ].join('\n'))
  assert.equal(base.totalLines, 4)
  assert.deepEqual(base.entries, [
    { peerKey: '628111', displayName: '客户甲更新', source: '广告' },
    { peerKey: '628222', displayName: '客户乙', source: 'LINE' }
  ])
})

test('工单分享默认带密码，短密码拒绝，token 只以哈希落库', () => {
  const generated = normalizeShare({})
  assert.equal(generated.passwordProtected, true)
  assert.equal(generated.password.length, 10)
  assert.equal(generated.expiresInDays, 30)

  const open = normalizeShare({ passwordProtected: false, password: 'abcdef' })
  assert.deepEqual(open, {
    passwordProtected: false,
    password: '',
    expiresInDays: 30
  })
  assert.throws(
    () => normalizeShare({ passwordProtected: true, password: '12345' }),
    error => error.code === 'COUNT_SHARE_PASSWORD_WEAK'
  )
  assert.equal(normalizeShare({ expiresInDays: 999 }).expiresInDays, 365)
  assert.equal(shareTokenHash('abc'), shareTokenHash('abc'))
  assert.notEqual(shareTokenHash('abc'), shareTokenHash('abcd'))
  assert.match(shareTokenHash('abc'), /^[0-9a-f]{64}$/)
})

test('跨工单周期查重按候选工单自己的当前周期判断', () => {
  const root = path.join(__dirname, '..')
  const migration = fs.readFileSync(
    path.join(root, 'migrations', '060_count_ticket_share_cycles.js'),
    'utf8'
  )
  assert.match(migration, /JOIN count_tickets candidate_ticket/)
  assert.match(
    migration,
    /candidate\.cycle_no = candidate_ticket\.cycle_no/,
    '其它工单只应使用它自己的当前周期事件参与查重'
  )
  assert.doesNotMatch(
    migration,
    /candidate\.cycle_no = t\.cycle_no/,
    '不能要求不同工单的周期编号相同，否则 A 第二次结算后会漏掉 B 当前周期的重粉'
  )
})

test('计数工单删除采用软删除，历史账本保留且不再参与后续查重', () => {
  const root = path.join(__dirname, '..')
  const migration = fs.readFileSync(
    path.join(root, 'migrations', '061_count_ticket_soft_delete.js'),
    'utf8'
  )
  const repository = fs.readFileSync(
    path.join(root, 'server', 'repositories', 'count-ticket-repository.js'),
    'utf8'
  )
  assert.match(migration, /ADD COLUMN IF NOT EXISTS deleted_at timestamptz/,
    '删除必须记录软删除时间')
  assert.match(migration, /candidate_ticket\.deleted_at IS NULL/,
    '已删除工单的历史事件不能再被当成其它工单的重粉依据')
  assert.match(repository, /softDeleteTicket/,
    '仓储层必须提供软删除方法')
  assert.match(repository, /deactivateTicketAccounts/,
    '删除后必须停用接入账号，防止继续自动计粉')
  assert.match(repository, /removeDedupLinksForTicket/,
    '删除后必须清理指向它的关联查重关系')
  assert.match(repository, /t\.deleted_at IS NULL/,
    '列表、详情和自动计粉查询必须排除已删除工单')
})

test('计数工单超管读接口全部显式声明客户数据权限', () => {
  assert.equal(capabilityFor('GET', '/admin/count-tickets'), 'admin.data.customers')
  assert.equal(capabilityFor('GET', '/admin/count-tickets/:id'), 'admin.data.customers')
  assert.equal(capabilityFor('GET', '/admin/count-tickets/:id/fans'), 'admin.data.customers')
})

test('计数工单权益认套餐 clients.counter 或企业账号', () => {
  assert.equal(packageAllowsCounter({ counter: true }), true)
  assert.equal(packageAllowsCounter({ counter: 1 }), true)
  assert.equal(packageAllowsCounter({ counter: false }), false)
  assert.equal(packageAllowsCounter('{"counter":true}'), true)
  assert.equal(packageAllowsCounter('bad-json'), false)

  const baseSession = {
    kind: 'main',
    account: { username: 'demo', nickname: 'Demo', charBalance: 1 },
    parent: { id: 1, packageClients: { counter: false }, enterprise: 0 }
  }
  assert.equal(publicUser(baseSession).counterSuite, false)
  baseSession.parent.packageClients = { counter: true }
  assert.equal(publicUser(baseSession).counterSuite, true)

  // 企业账号是已售权益的一部分：即使当前套餐是基础/高级版，也必须能使用。
  baseSession.parent.packageClients = { counter: false }
  baseSession.parent.enterprise = 1
  assert.equal(publicUser(baseSession).counterSuite, true)

  const service = new CountTicketService({})
  assert.equal(service.isEntitled({ enterprise: false, packageClients: { counter: false } }), false)
  assert.equal(service.isEntitled({ enterprise: true, packageClients: { counter: false } }), true)
})

test('商户管理员始终能找到计数工单入口，未购权益时明确提示升级', () => {
  const root = path.join(__dirname, '..')
  const home = fs.readFileSync(path.join(root, 'src', 'components', 'Home.vue'), 'utf8')
  const router = fs.readFileSync(path.join(root, 'src', 'router', 'index.js'), 'utf8')
  const page = fs.readFileSync(path.join(root, 'src', 'components', 'count', 'CountTickets.vue'), 'utf8')

  assert.match(home, /v-if="isMain" index="\/count\/tickets"/,
    '商户管理员即使套餐未开通也应看到入口，不能静默隐藏')
  assert.match(home, /需专业版/,
    '未开通时必须明确提示需要专业版')
  assert.doesNotMatch(router, /to\.path === '\/count\/tickets'[\s\S]{0,160}next\('\/home\/index'\)/,
    '路由不能把未开通用户静默弹回首页')
  assert.match(page, /当前套餐未开通计数工单/,
    '页面必须说明未开通原因，而不是显示空白或原始 403')
  assert.match(home, /refreshEntitlement/,
    '后台调整套餐或企业权益后，商户布局应刷新权益，避免用户必须退出重登')
  assert.match(page, /counterSuite\(enabled\)[\s\S]{0,80}this\.load\(\)/,
    '权益在页面打开期间变为可用时，应立即加载计数工单')
  assert.match(page, /还没有计数工单/,
    '零工单时必须显示明确引导，不能只剩一张空表')
  assert.match(page, /新建第一张工单/,
    '空状态必须给出可直接执行的下一步')
  assert.match(page, /ticket \? platformName\(ticket\.platform\) : ''/,
    '隐藏的绑定账号弹窗不能在 ticket=null 时读取 ticket.platform，否则整页白屏')
  assert.doesNotMatch(page, /:value="platformName\(ticket\.platform\)"/,
    '模板首帧必须能容忍 ticket 尚未选择')
  assert.match(page, /getRequest\('\/site\/platforms'\)/,
    '商户计数页必须使用公开站点平台接口')
  assert.doesNotMatch(page, /getRequest\('\/client\/platforms'\)/,
    '商户网页不能调用原生客户端专用接口；401 会被全局拦截器当成掉线并退出登录')
  assert.match(page, /查重范围/, '工单必须允许配置新粉/重粉比较范围')
  assert.match(page, /仅当前工单/, '必须支持只看当前工单')
  assert.match(page, /同商户全部工单/, '必须支持同一商户跨工单识别')
  assert.match(page, /指定关联工单/, '必须支持人工选择参与比较的工单')
  assert.match(page, /命名分组内/, '必须支持命名分组查重')
  assert.match(page, /底库管理/, '必须提供底库管理入口')
  assert.match(page, /命中底库记为重粉/, '工单必须能启用底库去重')
  assert.match(page, /分享对账/, '工单详情必须提供粉商对账分享入口')
  assert.match(page, /周期重置/, '工单必须支持结算周期归档')
  assert.match(page, /历史进粉不会删除/, '周期重置文案必须说明历史账本保留')
  assert.match(page, /删除工单/, '编辑弹窗必须提供删除工单入口')
  assert.match(page, /\/count-tickets\/delete/, '删除按钮必须调用后端删除接口')
  assert.match(page, /历史进粉账本保留供核对/, '删除确认必须说明历史账本仍保留')
  assert.match(page, /不再参与后续查重/, '删除确认必须说明后续重粉口径不再使用该工单')
  const sharePage = fs.readFileSync(
    path.join(root, 'src', 'components', 'count', 'CountShare.vue'),
    'utf8'
  )
  assert.match(sharePage, /分享密码/, '分享页必须支持密码解锁')
  assert.match(sharePage, /本周期重粉/, '分享页必须展示重粉指标')
  assert.match(sharePage, /接粉账号/, '分享页必须提供逐账号对账')
})

test('商户 profile 刷新时企业账号仍返回 counterSuite=1', () => {
  const redis = { get: async () => null, set: async () => 'OK' }
  const core = new CoreService({}, redis, null, {})
  const session = {
    kind: 'main',
    account: { id: 37, username: 'jiufa', nickname: 'jiufa', charBalance: 1 },
    parent: {
      id: 37,
      enterprise: true,
      packageClients: { counter: false },
      packageId: 2,
      packageTitle: 'Hello Pix 高级版'
    }
  }
  assert.equal(core.profile(session).counterSuite, 1)
})

test('计数只接真实入站消息，打开会话与出向消息带独立事件类型', () => {
  const root = path.join(__dirname, '..')
  const guest = fs.readFileSync(path.join(root, 'desktop', 'guest-inject.js'), 'utf8')
  const route = fs.readFileSync(path.join(root, 'server', 'routes', 'production.js'), 'utf8')
  assert.match(guest, /reportClue\(text, direction, messageTime\(node\), 'message'\)/)
  assert.match(guest, /reportClue\('', 'in', null, 'conversation'\)/)
  assert.match(guest, /eventType:\s*eventType \|\|/)
  assert.match(route, /direction:\s*data\.direction/)
  assert.match(route, /body:\s*data\.body/)
  assert.match(route, /eventType:\s*data\.eventType/)
})

test('计数列表页码有安全上限，Infinity 不能打进 SQL offset', async () => {
  let seen = null
  const service = new CountTicketService({
    async listTickets(filters) {
      seen = filters
      return { rows: [], total: 0 }
    }
  })
  const result = await service.list(1, { page: Infinity, rows: 30 })
  assert.equal(result.page, 1_000_000)
  assert.equal(seen.offset, (1_000_000 - 1) * 30)
})

test('原生计数：会话去重、跨账号重粉、跨商户识别与工单隔离', { skip: !databaseUrl }, async t => {
  process.env.DATABASE_URL = databaseUrl
  const { Pool } = require('pg')
  const pool = new Pool({ connectionString: databaseUrl, max: 5 })
  const db = {
    query: (text, values, client) => (client || pool).query(text, values || []),
    transaction: async work => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }
  }
  const service = new CountTicketService(new CountTicketRepository(db))
  const customerRepository = new CustomerRepository(db)
  const customerIdentities = new CustomerIdentityService(customerRepository)
  const captureInbound = (userId, data) => service.captureFan(
    userId,
    Object.assign({ direction: 'in', body: 'hello', eventType: 'message' }, data)
  )

  async function bindAccount(
    userId, ticketId, accountKey, since = '2026-01-01T00:00:00Z', platform = 'whatsapp-green'
  ) {
    await pool.query(
      `INSERT INTO conversations(user_id,customer_id,platform,account_key,peer_key,display_name,last_message_at)
       VALUES($1,NULL,$2,$3,$4,$3,now())
       ON CONFLICT (user_id,platform,account_key,peer_key) DO NOTHING`,
      [userId, platform, accountKey, `seed-${accountKey}`]
    )
    await service.saveAccount(userId, { ticketId, platform, accountKey })
    await pool.query(
      `UPDATE count_ticket_accounts
       SET created_at=$4, updated_at=$4
       WHERE user_id=$1 AND ticket_id=$2 AND platform=$3 AND account_key=$5 AND active=true`,
      [userId, ticketId, platform, since, accountKey]
    )
  }

  let seq = 0
  const createdUsers = []
  const createdCustomers = []
  async function makeUser(label) {
    const username = `count_${label}_${process.pid}_${Date.now()}_${++seq}`
    const result = await pool.query(
      `INSERT INTO users(username,password_hash,nickname,status)
       VALUES($1,'scrypt$s$h',$1,1) RETURNING id,username`,
      [username]
    )
    createdUsers.push(result.rows[0].id)
    return result.rows[0]
  }

  async function makeCustomer(label) {
    const result = await pool.query(
      `INSERT INTO customers(public_id) VALUES('C_TEST_' || $1 || '_' || nextval('customers_id_seq'))
       RETURNING id,public_id`,
      [label]
    )
    createdCustomers.push(result.rows[0].id)
    return result.rows[0]
  }

  async function makeConversation(userId, customerId, accountKey, peerKey, platform = 'whatsapp-green') {
    const result = await pool.query(
      `INSERT INTO conversations(user_id,customer_id,platform,account_key,peer_key,display_name,last_message_at)
       VALUES($1,$2,$3,$4,$5,$5,now()) RETURNING id`,
      [userId, customerId, platform, accountKey, peerKey]
    )
    return result.rows[0].id
  }

  t.after(async () => {
    if (createdUsers.length) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [createdUsers])
    }
    if (createdCustomers.length) {
      await pool.query('DELETE FROM customers WHERE id = ANY($1::bigint[])', [createdCustomers])
    }
    await pool.end()
  })

  const merchantA = await makeUser('a')
  const merchantB = await makeUser('b')
  const customer = await makeCustomer('same')
  const otherCustomer = await makeCustomer('other')

  const ticketA = await service.saveTicket(merchantA.id, {
    title: 'WhatsApp A 组',
    platform: 'whatsapp-green',
    timezone: 'Asia/Shanghai',
    zeroTime: '04:00'
  })
  await bindAccount(merchantA.id, ticketA.id, 'acc-a')
  await bindAccount(merchantA.id, ticketA.id, 'acc-b')
  const activeSinceBefore = await pool.query(
    `SELECT updated_at FROM count_ticket_accounts
     WHERE user_id=$1 AND ticket_id=$2 AND platform='whatsapp-green' AND account_key='acc-a'`,
    [merchantA.id, ticketA.id]
  )
  await service.saveAccount(merchantA.id, {
    ticketId: ticketA.id, platform: 'whatsapp-green', accountKey: 'acc-a'
  })
  const activeSinceAfter = await pool.query(
    `SELECT updated_at FROM count_ticket_accounts
     WHERE user_id=$1 AND ticket_id=$2 AND platform='whatsapp-green' AND account_key='acc-a'`,
    [merchantA.id, ticketA.id]
  )
  assert.equal(
    String(activeSinceAfter.rows[0].updated_at),
    String(activeSinceBefore.rows[0].updated_at),
    '重复点击绑定不能重置计数起点'
  )

  const conv1 = await makeConversation(merchantA.id, customer.id, 'acc-a', 'peer-1')
  const first = await captureInbound(merchantA.id, {
    conversationId: conv1,
    customerId: customer.id,
    platform: 'whatsapp-green',
    accountKey: 'acc-a',
    peerKey: 'peer-1',
    displayName: '同一位客户',
    eventAt: '2026-11-18T03:59:59+08:00'
  })
  assert.equal(first.captured, true)
  assert.equal(first.fanType, 'new')

  const duplicate = await captureInbound(merchantA.id, {
    conversationId: conv1,
    customerId: customer.id,
    platform: 'whatsapp-green',
    accountKey: 'acc-a',
    peerKey: 'peer-1',
    displayName: '同一位客户',
    eventAt: '2026-11-18T04:00:01+08:00'
  })
  assert.equal(duplicate.captured, false)
  assert.equal(duplicate.reason, 'conversation_already_counted')

  const conv2 = await makeConversation(merchantA.id, customer.id, 'acc-b', 'peer-2')
  const secondAccount = await captureInbound(merchantA.id, {
    conversationId: conv2,
    customerId: customer.id,
    platform: 'whatsapp-green',
    accountKey: 'acc-b',
    peerKey: 'peer-2',
    displayName: '同一位客户',
    eventAt: '2026-11-18T04:00:00+08:00'
  })
  assert.equal(secondAccount.captured, true)
  assert.equal(secondAccount.fanType, 'repeat', '同客户从另一账号进入必须记重粉')

  const conv3 = await makeConversation(merchantA.id, otherCustomer.id, 'acc-a', 'peer-3')
  const other = await captureInbound(merchantA.id, {
    conversationId: conv3,
    customerId: otherCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'acc-a',
    peerKey: 'peer-3',
    displayName: '另一位客户',
    eventAt: '2026-11-18T04:00:02+08:00'
  })
  assert.equal(other.fanType, 'new')

  const gateCustomer = await makeCustomer('gate')
  const gateConversation = await makeConversation(merchantA.id, gateCustomer.id, 'acc-a', 'peer-gate')
  const gateBase = {
    conversationId: gateConversation,
    customerId: gateCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'acc-a',
    peerKey: 'peer-gate',
    eventAt: '2026-11-18T10:00:00+08:00'
  }
  assert.equal((await service.captureFan(merchantA.id, Object.assign({}, gateBase, {
    direction: 'in', body: '', eventType: 'conversation'
  }))).reason, 'not_an_inbound_message', '打开会话不能计粉')
  assert.equal((await service.captureFan(merchantA.id, Object.assign({}, gateBase, {
    direction: 'out', body: '我方主动发送', eventType: 'message'
  }))).reason, 'not_an_inbound_message', '出向消息不能计粉')
  assert.equal((await service.captureFan(merchantA.id, Object.assign({}, gateBase, {
    direction: 'in', body: '历史消息', eventType: 'message',
    eventAt: '2025-12-30T12:00:00Z'
  }))).reason, 'before_account_binding', '账号绑定前的历史不能补进新工单')
  assert.equal((await service.captureFan(merchantA.id, Object.assign({}, gateBase, {
    direction: 'in', body: '未来消息', eventType: 'message',
    eventAt: '2099-01-01T00:00:00Z'
  }))).reason, 'event_at_in_future', '未来时间不能污染计数')

  const graceCustomer = await makeCustomer('binding-grace')
  const graceTicket = await service.saveTicket(merchantA.id, {
    title: '绑定同分钟容差', platform: 'whatsapp-green', timezone: 'Asia/Shanghai', zeroTime: '00:00'
  })
  await bindAccount(merchantA.id, graceTicket.id, 'acc-grace', '2026-11-19T05:00:30Z')
  const graceConversation = await makeConversation(
    merchantA.id, graceCustomer.id, 'acc-grace', 'peer-grace'
  )
  const graceFan = await captureInbound(merchantA.id, {
    conversationId: graceConversation,
    customerId: graceCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'acc-grace',
    peerKey: 'peer-grace',
    eventAt: '2026-11-19T05:00:00Z'
  })
  assert.equal(graceFan.captured, true, '分钟精度导致的小于 2 分钟误差不能误伤刚到的消息')

  const lateCustomer = await makeCustomer('late-order')
  const lateTicket = await service.saveTicket(merchantA.id, {
    title: '乱序补扫', platform: 'whatsapp-green', timezone: 'Asia/Shanghai', zeroTime: '00:00'
  })
  await bindAccount(merchantA.id, lateTicket.id, 'acc-late')
  const laterConversation = await makeConversation(merchantA.id, lateCustomer.id, 'acc-late', 'peer-later')
  const earlierConversation = await makeConversation(merchantA.id, lateCustomer.id, 'acc-late', 'peer-earlier')
  const laterFirst = await captureInbound(merchantA.id, {
    conversationId: laterConversation,
    customerId: lateCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'acc-late',
    peerKey: 'peer-later',
    eventAt: '2026-11-19T02:00:00Z'
  })
  const earlierSecond = await captureInbound(merchantA.id, {
    conversationId: earlierConversation,
    customerId: lateCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'acc-late',
    peerKey: 'peer-earlier',
    eventAt: '2026-11-19T01:00:00Z'
  })
  assert.equal(laterFirst.fanType, 'new')
  assert.equal(earlierSecond.fanType, 'new', '迟到但时间更早的事件最终必须成为新粉')
  const ranked = await pool.query(
    `SELECT id,fan_type,repeat_of_id FROM count_ticket_fans
     WHERE ticket_id=$1 ORDER BY event_at,id`, [lateTicket.id]
  )
  assert.deepEqual(ranked.rows.map(row => row.fan_type), ['new', 'repeat'])
  assert.equal(String(ranked.rows[1].repeat_of_id), String(ranked.rows[0].id))

  const available = await service.availableAccounts(merchantA.id, ticketA.id)
  assert.deepEqual(
    available.map(item => item.accountKey).sort(),
    ['acc-a', 'acc-b', 'acc-grace', 'acc-late'],
    '绑定弹窗只能看到当前商户真实上报过的接入账号'
  )
  assert.ok(
    available.every(item => item.platform === 'whatsapp-green'),
    '工单只能看到本应用的接入账号'
  )

  await assert.rejects(
    () => service.saveAccount(merchantA.id, {
      ticketId: ticketA.id,
      platform: 'telegram-z',
      accountKey: 'tg-acc'
    }),
    error => error.code === 'COUNT_ACCOUNT_PLATFORM_MISMATCH',
    '不能把 Telegram 账号绑进 WhatsApp 工单'
  )

  const telegramTicket = await service.saveTicket(merchantA.id, {
    title: 'Telegram 独立组',
    platform: 'telegram-z',
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  await bindAccount(merchantA.id, telegramTicket.id, 'tg-acc', '2026-01-01T00:00:00Z', 'telegram-z')
  const telegramConversation = await makeConversation(
    merchantA.id, customer.id, 'tg-acc', 'tg-peer', 'telegram-z'
  )
  const telegramFan = await captureInbound(merchantA.id, {
    conversationId: telegramConversation,
    customerId: customer.id,
    platform: 'telegram-z',
    accountKey: 'tg-acc',
    peerKey: 'tg-peer',
    displayName: '同一位客户',
    eventAt: '2026-11-18T05:00:00+08:00'
  })
  assert.equal(telegramFan.fanType, 'new', '不同应用不能把同一客户串成重粉')

  await assert.rejects(
    () => service.saveTicket(merchantA.id, {
      title: '跨应用关联必须失败',
      platform: 'whatsapp-green',
      dedupScope: 'linked',
      linkedTicketIds: [telegramTicket.id],
      timezone: 'Asia/Shanghai',
      zeroTime: '00:00'
    }),
    error => error.code === 'COUNT_DEDUP_LINKS_INVALID',
    '指定关联工单不能跨计数应用'
  )

  const dedupOptions = await service.dedupOptions(merchantA.id, {
    ticketId: ticketA.id,
    platform: 'whatsapp-green'
  })
  assert.ok(
    dedupOptions.every(item => Number(item.id) !== Number(ticketA.id)),
    '关联选项不能包含当前工单'
  )
  assert.ok(
    dedupOptions.every(item => item.platform === 'whatsapp-green'),
    '关联选项不能跨应用'
  )
  const detailA = await service.detail(ticketA.id, { userId: merchantA.id })
  assert.equal(detailA.metrics.totalFans, 3)
  assert.equal(detailA.metrics.newFans, 2)
  assert.equal(detailA.metrics.repeatFans, 1)
  assert.equal(detailA.accounts.length, 2)
  const adminDetail = await service.detail(ticketA.id, { admin: true })
  assert.equal(adminDetail.metrics.totalFans, 3, '显式 admin scope 才能走超管查询')

  const cross = await service.detail(ticketA.id, { userId: merchantB.id })
    .then(() => null, error => error)
  assert.ok(cross, '其他商户读取详情必须失败')
  assert.equal(cross.code, 'COUNT_TICKET_NOT_FOUND')

  // 另一商户即使命中了统一的客户身份，也不能把对方工单当成重粉依据。
  const ticketB = await service.saveTicket(merchantB.id, {
    title: 'WhatsApp B 组',
    platform: 'whatsapp-green',
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  const isolatedDedupOptions = await service.dedupOptions(merchantA.id, {
    ticketId: ticketA.id,
    platform: 'whatsapp-green'
  })
  assert.ok(
    isolatedDedupOptions.every(item => Number(item.id) !== Number(ticketB.id)),
    '关联选项不能包含其它商户工单'
  )
  await bindAccount(merchantB.id, ticketB.id, 'acc-cross')
  const conv4 = await makeConversation(merchantB.id, customer.id, 'acc-cross', 'peer-4')
  const crossRepeat = await captureInbound(merchantB.id, {
    conversationId: conv4,
    customerId: customer.id,
    platform: 'whatsapp-green',
    accountKey: 'acc-cross',
    peerKey: 'peer-4',
    displayName: '跨商户客户',
    eventAt: '2026-11-18T10:00:00+08:00'
  })
  assert.equal(crossRepeat.fanType, 'new', '跨商户不能串重粉事实')

  // 同一商户的跨工单查重由每张工单自己决定：
  // merchant = 全商户；ticket = 只看本工单；linked = 只看人工关联工单。
  const scopeMerchantA = await service.saveTicket(merchantA.id, {
    title: '同商户 A',
    platform: 'whatsapp-green',
    dedupScope: 'merchant',
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  const scopeMerchantB = await service.saveTicket(merchantA.id, {
    title: '同商户 B',
    platform: 'whatsapp-green',
    dedupScope: 'merchant',
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  await bindAccount(merchantA.id, scopeMerchantA.id, 'scope-merchant-a')
  await bindAccount(merchantA.id, scopeMerchantB.id, 'scope-merchant-b')
  const scopeCustomer = await makeCustomer('scope')
  const scopeMerchantConvA = await makeConversation(
    merchantA.id, scopeCustomer.id, 'scope-merchant-a', 'scope-peer-a'
  )
  const scopeMerchantConvB = await makeConversation(
    merchantA.id, scopeCustomer.id, 'scope-merchant-b', 'scope-peer-b'
  )
  assert.equal((await captureInbound(merchantA.id, {
    conversationId: scopeMerchantConvA,
    customerId: scopeCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'scope-merchant-a',
    peerKey: 'scope-peer-a',
    eventAt: '2026-11-20T01:00:00Z'
  })).fanType, 'new')
  assert.equal((await captureInbound(merchantA.id, {
    conversationId: scopeMerchantConvB,
    customerId: scopeCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'scope-merchant-b',
    peerKey: 'scope-peer-b',
    eventAt: '2026-11-20T02:00:00Z'
  })).fanType, 'repeat', '同商户全部工单必须识别跨工单重粉')

  // 两个账号并发进线时，只允许一个事务写成新粉，另一个必须等待后判重粉。
  const concurrentCustomer = await makeCustomer('concurrent')
  const concurrentTicketA = await service.saveTicket(merchantA.id, {
    title: '并发 A',
    platform: 'whatsapp-green',
    dedupScope: 'merchant',
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  const concurrentTicketB = await service.saveTicket(merchantA.id, {
    title: '并发 B',
    platform: 'whatsapp-green',
    dedupScope: 'merchant',
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  await bindAccount(merchantA.id, concurrentTicketA.id, 'concurrent-a')
  await bindAccount(merchantA.id, concurrentTicketB.id, 'concurrent-b')
  const concurrentConvA = await makeConversation(
    merchantA.id, concurrentCustomer.id, 'concurrent-a', 'concurrent-peer-a'
  )
  const concurrentConvB = await makeConversation(
    merchantA.id, concurrentCustomer.id, 'concurrent-b', 'concurrent-peer-b'
  )
  const concurrentResults = await Promise.all([
    captureInbound(merchantA.id, {
      conversationId: concurrentConvA,
      customerId: concurrentCustomer.id,
      platform: 'whatsapp-green',
      accountKey: 'concurrent-a',
      peerKey: 'concurrent-peer-a',
      eventAt: '2026-11-20T02:30:00Z'
    }),
    captureInbound(merchantA.id, {
      conversationId: concurrentConvB,
      customerId: concurrentCustomer.id,
      platform: 'whatsapp-green',
      accountKey: 'concurrent-b',
      peerKey: 'concurrent-peer-b',
      eventAt: '2026-11-20T02:30:01Z'
    })
  ])
  assert.ok(concurrentResults.every(item => item.captured), '并发事件都必须真实落账')
  const concurrentRows = await pool.query(
    `SELECT fan_type,repeat_of_id
     FROM count_ticket_fans
     WHERE conversation_id = ANY($1::bigint[])
     ORDER BY event_at,id`,
    [[concurrentConvA, concurrentConvB]]
  )
  assert.deepEqual(
    concurrentRows.rows.map(row => row.fan_type),
    ['new', 'repeat'],
    '并发进线不能同时算成两个新粉'
  )
  assert.equal(
    String(concurrentRows.rows[1].repeat_of_id),
    String((await pool.query(
      'SELECT id FROM count_ticket_fans WHERE conversation_id=$1',
      [concurrentConvA]
    )).rows[0].id)
  )

  const fallbackConvA = await makeConversation(
    merchantA.id, null, 'concurrent-a', 'fallback-peer'
  )
  const fallbackConvB = await makeConversation(
    merchantA.id, null, 'concurrent-b', 'fallback-peer'
  )
  const fallbackResults = await Promise.all([
    captureInbound(merchantA.id, {
      conversationId: fallbackConvA,
      platform: 'whatsapp-green',
      accountKey: 'concurrent-a',
      peerKey: 'fallback-peer',
      eventAt: '2026-11-20T02:40:00Z'
    }),
    captureInbound(merchantA.id, {
      conversationId: fallbackConvB,
      platform: 'whatsapp-green',
      accountKey: 'concurrent-b',
      peerKey: 'fallback-peer',
      eventAt: '2026-11-20T02:40:01Z'
    })
  ])
  assert.ok(fallbackResults.every(item => item.captured), '无 customerId 的并发事件也必须落账')
  const fallbackRows = await pool.query(
    `SELECT id,ticket_id,user_id,customer_id,peer_key,fan_type,repeat_of_id,event_at
     FROM count_ticket_fans
     WHERE conversation_id = ANY($1::bigint[])
     ORDER BY event_at,id`,
    [[fallbackConvA, fallbackConvB]]
  )
  assert.deepEqual(
    fallbackRows.rows.map(row => row.fan_type),
    ['new', 'repeat'],
    '没有 customerId 时也必须用平台 peerKey 串行判重'
  )
  assert.equal(
    String(fallbackRows.rows[1].repeat_of_id),
    String(fallbackRows.rows[0].id)
  )

  const scopeTicketA = await service.saveTicket(merchantA.id, {
    title: '单工单 A',
    platform: 'whatsapp-green',
    dedupScope: 'ticket',
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  const scopeTicketB = await service.saveTicket(merchantA.id, {
    title: '单工单 B',
    platform: 'whatsapp-green',
    dedupScope: 'ticket',
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  await bindAccount(merchantA.id, scopeTicketA.id, 'scope-ticket-a')
  await bindAccount(merchantA.id, scopeTicketB.id, 'scope-ticket-b')
  const scopeTicketConvA = await makeConversation(
    merchantA.id, scopeCustomer.id, 'scope-ticket-a', 'scope-ticket-peer-a'
  )
  const scopeTicketConvB = await makeConversation(
    merchantA.id, scopeCustomer.id, 'scope-ticket-b', 'scope-ticket-peer-b'
  )
  assert.equal((await captureInbound(merchantA.id, {
    conversationId: scopeTicketConvA,
    customerId: scopeCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'scope-ticket-a',
    peerKey: 'scope-ticket-peer-a',
    eventAt: '2026-11-20T03:00:00Z'
  })).fanType, 'new')
  assert.equal((await captureInbound(merchantA.id, {
    conversationId: scopeTicketConvB,
    customerId: scopeCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'scope-ticket-b',
    peerKey: 'scope-ticket-peer-b',
    eventAt: '2026-11-20T04:00:00Z'
  })).fanType, 'new', '仅当前工单模式不能串其它工单')

  const scopeLinkTarget = await service.saveTicket(merchantA.id, {
    title: '指定关联-目标',
    platform: 'whatsapp-green',
    dedupScope: 'ticket',
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  const scopeLinkSource = await service.saveTicket(merchantA.id, {
    title: '指定关联-主工单',
    platform: 'whatsapp-green',
    dedupScope: 'linked',
    linkedTicketIds: [scopeLinkTarget.id],
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  await bindAccount(merchantA.id, scopeLinkTarget.id, 'scope-link-target')
  await bindAccount(merchantA.id, scopeLinkSource.id, 'scope-link-source')
  const scopeLinkTargetConv = await makeConversation(
    merchantA.id, scopeCustomer.id, 'scope-link-target', 'scope-link-target-peer'
  )
  const scopeLinkSourceConv = await makeConversation(
    merchantA.id, scopeCustomer.id, 'scope-link-source', 'scope-link-source-peer'
  )
  assert.equal((await captureInbound(merchantA.id, {
    conversationId: scopeLinkTargetConv,
    customerId: scopeCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'scope-link-target',
    peerKey: 'scope-link-target-peer',
    eventAt: '2026-11-20T05:00:00Z'
  })).fanType, 'new')
  assert.equal((await captureInbound(merchantA.id, {
    conversationId: scopeLinkSourceConv,
    customerId: scopeCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'scope-link-source',
    peerKey: 'scope-link-source-peer',
    eventAt: '2026-11-20T06:00:00Z'
  })).fanType, 'repeat', '指定关联工单必须参与查重')

  await assert.rejects(
    () => service.saveTicket(merchantA.id, {
      id: scopeLinkSource.id,
      title: '指定关联-主工单',
      platform: 'whatsapp-green',
      dedupScope: 'merchant',
      timezone: 'Asia/Shanghai',
      zeroTime: '00:00'
    }),
    error => error.code === 'COUNT_DEDUP_SCOPE_LOCKED',
    '已有进粉后不能偷偷改变历史口径'
  )
  await service.saveTicket(merchantA.id, {
    id: scopeLinkSource.id,
    title: '指定关联-主工单（旧前端更新）',
    platform: 'whatsapp-green',
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  const preservedScope = await service.detail(scopeLinkSource.id, { userId: merchantA.id })
  assert.equal(preservedScope.ticket.dedupScope, 'linked', '旧前端漏传新字段时必须保留原口径')
  assert.deepEqual(
    preservedScope.dedupTicketIds.map(Number),
    [Number(scopeLinkTarget.id)],
    '旧前端更新标题不能清空关联工单'
  )

  const namedGroup = await service.saveGroup(merchantA.id, {
    name: '马来 A 组',
    platform: 'whatsapp-green'
  })
  const otherGroup = await service.saveGroup(merchantA.id, {
    name: '马来 B 组',
    platform: 'whatsapp-green'
  })
  const groupTicketA = await service.saveTicket(merchantA.id, {
    title: '命名分组 A',
    platform: 'whatsapp-green',
    dedupScope: 'group',
    groupId: namedGroup.id,
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  const groupTicketB = await service.saveTicket(merchantA.id, {
    title: '命名分组 B',
    platform: 'whatsapp-green',
    dedupScope: 'group',
    groupId: namedGroup.id,
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  const groupTicketC = await service.saveTicket(merchantA.id, {
    title: '命名分组 C',
    platform: 'whatsapp-green',
    dedupScope: 'group',
    groupId: otherGroup.id,
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  await bindAccount(merchantA.id, groupTicketA.id, 'group-a')
  await bindAccount(merchantA.id, groupTicketB.id, 'group-b')
  await bindAccount(merchantA.id, groupTicketC.id, 'group-c')
  const groupCustomer = await makeCustomer('named-group')
  const groupConvA = await makeConversation(
    merchantA.id, groupCustomer.id, 'group-a', 'group-peer-a'
  )
  const groupConvB = await makeConversation(
    merchantA.id, groupCustomer.id, 'group-b', 'group-peer-b'
  )
  const groupConvC = await makeConversation(
    merchantA.id, groupCustomer.id, 'group-c', 'group-peer-c'
  )
  assert.equal((await captureInbound(merchantA.id, {
    conversationId: groupConvA,
    customerId: groupCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'group-a',
    peerKey: 'group-peer-a',
    eventAt: '2026-11-20T07:00:00Z'
  })).fanType, 'new')
  assert.equal((await captureInbound(merchantA.id, {
    conversationId: groupConvB,
    customerId: groupCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'group-b',
    peerKey: 'group-peer-b',
    eventAt: '2026-11-20T07:01:00Z'
  })).fanType, 'repeat', '同命名分组必须识别重粉')
  assert.equal((await captureInbound(merchantA.id, {
    conversationId: groupConvC,
    customerId: groupCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'group-c',
    peerKey: 'group-peer-c',
    eventAt: '2026-11-20T07:02:00Z'
  })).fanType, 'new', '不同命名分组不能串重粉')

  await assert.rejects(
    () => service.deleteGroup(merchantA.id, { id: namedGroup.id }),
    error => error.code === 'COUNT_GROUP_NOT_EMPTY',
    '分组有工单时不能删除'
  )
  await assert.rejects(
    () => service.saveTicket(merchantA.id, {
      title: '跨应用分组',
      platform: 'telegram-z',
      dedupScope: 'group',
      groupId: namedGroup.id,
      timezone: 'Asia/Shanghai',
      zeroTime: '00:00'
    }),
    error => error.code === 'COUNT_GROUP_INVALID',
    '分组不能跨应用'
  )
  const emptyGroup = await service.saveGroup(merchantA.id, {
    name: '待删除空分组',
    platform: 'whatsapp-green'
  })
  await service.deleteGroup(merchantA.id, { id: emptyGroup.id })

  const baseImport = await service.importBase(merchantA.id, {
    platform: 'whatsapp-green',
    filename: 'base.txt',
    text: [
      'username----昵称----来源',
      'base-peer-a----底库客户A----历史导入',
      'base-peer-b----底库客户B----历史导入',
      'base-peer-a----底库客户A更新----再次导入'
    ].join('\n')
  })
  assert.equal(baseImport.accepted, 2)
  assert.equal(baseImport.inserted, 2)
  const baseTicket = await service.saveTicket(merchantA.id, {
    title: '底库去重',
    platform: 'whatsapp-green',
    dedupScope: 'ticket',
    dedupBaseEnabled: true,
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  await bindAccount(merchantA.id, baseTicket.id, 'base-account')
  const baseCustomer = await makeCustomer('base-hit')
  const baseConversation = await makeConversation(
    merchantA.id, baseCustomer.id, 'base-account', 'base-peer-a'
  )
  const baseHit = await captureInbound(merchantA.id, {
    conversationId: baseConversation,
    customerId: baseCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'base-account',
    peerKey: 'base-peer-a',
    eventAt: '2026-11-20T08:00:00Z'
  })
  assert.equal(baseHit.fanType, 'repeat')
  assert.equal(baseHit.repeatType, 'base', '底库命中必须单独标记为重粉依据')
  assert.equal(baseHit.repeatOfId, null)
  const baseRow = await pool.query(
    'SELECT fan_type,repeat_type,repeat_of_id FROM count_ticket_fans WHERE id=$1',
    [baseHit.fanId]
  )
  assert.deepEqual(baseRow.rows[0], {
    fan_type: 'repeat',
    repeat_type: 'base',
    repeat_of_id: null
  })
  const baseOtherMerchant = await service.saveTicket(merchantB.id, {
    title: '其它商户底库隔离',
    platform: 'whatsapp-green',
    dedupScope: 'ticket',
    dedupBaseEnabled: true,
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  await bindAccount(merchantB.id, baseOtherMerchant.id, 'base-other')
  const baseOtherCustomer = await makeCustomer('base-other')
  const baseOtherConv = await makeConversation(
    merchantB.id, baseOtherCustomer.id, 'base-other', 'base-peer-a'
  )
  assert.equal((await captureInbound(merchantB.id, {
    conversationId: baseOtherConv,
    customerId: baseOtherCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'base-other',
    peerKey: 'base-peer-a',
    eventAt: '2026-11-20T08:10:00Z'
  })).fanType, 'new', '底库不能跨商户命中')
  const reimport = await service.importBase(merchantA.id, {
    platform: 'whatsapp-green',
    text: 'base-peer-a----底库客户A最终----更新'
  })
  assert.equal(reimport.updated, 1)
  const baseStats = await service.baseStats(merchantA.id, { platform: 'whatsapp-green' })
  assert.equal(baseStats.totalEntries, 2)
  assert.equal((await service.clearBase(merchantA.id, { platform: 'whatsapp-green' })).removed, 2)
  assert.equal((await service.baseStats(merchantA.id, { platform: 'whatsapp-green' })).totalEntries, 0)
  assert.equal((await pool.query(
    'SELECT count(*)::int AS n FROM count_ticket_fans WHERE id=$1',
    [baseHit.fanId]
  )).rows[0].n, 1, '清空底库不能删除历史进粉')

  // 业务日按工单时区与置零时间计算：03:59:59 和 04:00:00 属不同业务日。
  const dayKeys = await pool.query(
    `SELECT id,day_key::text FROM count_ticket_fans WHERE ticket_id=$1 ORDER BY id`,
    [ticketA.id]
  )
  assert.equal(dayKeys.rows[0].day_key, '2026-11-17')
  assert.equal(dayKeys.rows[1].day_key, '2026-11-18')

  // 同一账号重新绑定到另一个工单后，旧绑定自动停用。
  const ticketA2 = await service.saveTicket(merchantA.id, {
    title: 'WhatsApp A 二组',
    platform: 'whatsapp-green',
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  await bindAccount(merchantA.id, ticketA2.id, 'acc-a')
  const active = await pool.query(
    `SELECT ticket_id FROM count_ticket_accounts
     WHERE user_id=$1 AND platform='whatsapp-green' AND account_key='acc-a' AND active=true`,
    [merchantA.id]
  )
  assert.deepEqual(active.rows.map(row => Number(row.ticket_id)), [ticketA2.id])

  await service.saveTicket(merchantA.id, {
    id: ticketA2.id,
    title: 'WhatsApp A 二组',
    platform: 'whatsapp-green',
    status: 'closed',
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  const closedBinding = await pool.query(
    `SELECT active FROM count_ticket_accounts
     WHERE ticket_id=$1 AND user_id=$2 AND platform='whatsapp-green' AND account_key='acc-a'`,
    [ticketA2.id, merchantA.id]
  )
  assert.equal(closedBinding.rows[0].active, false, '关闭工单必须停止计数账号')

  await assert.rejects(
    () => service.saveTicket(merchantA.id, {
      id: ticketA.id,
      title: 'WhatsApp A 组',
      platform: 'whatsapp-green',
      timezone: 'UTC',
      zeroTime: '00:00'
    }),
    error => error.code === 'COUNT_BUSINESS_TIME_LOCKED',
    '已有粉丝后不能静默改变历史业务日口径'
  )

  await assert.rejects(
    () => service.saveAccount(merchantA.id, {
      ticketId: ticketA.id,
      platform: 'whatsapp-green',
      accountKey: 'never-reported'
    }),
    error => error.code === 'COUNT_ACCOUNT_NOT_REPORTED',
    '未由客户端上报的接入账号不能手工塞进工单'
  )

  await assert.rejects(
    () => service.detail(ticketA.id),
    error => error.code === 'COUNT_ACCESS_SCOPE_REQUIRED',
    '缺少访问作用域不能默认走超管查询'
  )

  const mergeA = await makeCustomer('merge-a')
  const mergeB = await makeCustomer('merge-b')
  const mergeTicket = await service.saveTicket(merchantA.id, {
    title: '身份合并回归',
    platform: 'whatsapp-green',
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  const mergeTicketOnlyA = await service.saveTicket(merchantA.id, {
    title: '身份合并-单工单 A',
    platform: 'whatsapp-green',
    dedupScope: 'ticket',
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  const mergeTicketOnlyB = await service.saveTicket(merchantA.id, {
    title: '身份合并-单工单 B',
    platform: 'whatsapp-green',
    dedupScope: 'ticket',
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  await bindAccount(merchantA.id, mergeTicket.id, 'merge-a')
  await bindAccount(merchantA.id, mergeTicket.id, 'merge-b')
  await bindAccount(merchantA.id, mergeTicketOnlyA.id, 'merge-only-a')
  await bindAccount(merchantA.id, mergeTicketOnlyB.id, 'merge-only-b')
  const mergeConvA = await makeConversation(merchantA.id, mergeA.id, 'merge-a', 'merge-peer-a')
  const mergeConvB = await makeConversation(merchantA.id, mergeB.id, 'merge-b', 'merge-peer-b')
  const mergeOnlyConvA = await makeConversation(
    merchantA.id, mergeA.id, 'merge-only-a', 'merge-only-peer-a'
  )
  const mergeOnlyConvB = await makeConversation(
    merchantA.id, mergeB.id, 'merge-only-b', 'merge-only-peer-b'
  )
  const mergeConvTg = await makeConversation(
    merchantA.id, mergeB.id, 'tg-acc', 'merge-peer-tg', 'telegram-z'
  )
  await captureInbound(merchantA.id, {
    conversationId: mergeConvA,
    customerId: mergeA.id,
    platform: 'whatsapp-green',
    accountKey: 'merge-a',
    peerKey: 'merge-peer-a',
    eventAt: '2026-11-18T11:00:00+08:00'
  })
  await captureInbound(merchantA.id, {
    conversationId: mergeConvB,
    customerId: mergeB.id,
    platform: 'whatsapp-green',
    accountKey: 'merge-b',
    peerKey: 'merge-peer-b',
    eventAt: '2026-11-18T12:00:00+08:00'
  })
  await captureInbound(merchantA.id, {
    conversationId: mergeOnlyConvA,
    customerId: mergeA.id,
    platform: 'whatsapp-green',
    accountKey: 'merge-only-a',
    peerKey: 'merge-only-peer-a',
    eventAt: '2026-11-18T12:10:00+08:00'
  })
  await captureInbound(merchantA.id, {
    conversationId: mergeOnlyConvB,
    customerId: mergeB.id,
    platform: 'whatsapp-green',
    accountKey: 'merge-only-b',
    peerKey: 'merge-only-peer-b',
    eventAt: '2026-11-18T12:20:00+08:00'
  })
  await captureInbound(merchantA.id, {
    conversationId: mergeConvTg,
    customerId: mergeB.id,
    platform: 'telegram-z',
    accountKey: 'tg-acc',
    peerKey: 'merge-peer-tg',
    eventAt: '2026-11-18T12:30:00+08:00'
  })
  await customerRepository.mergeCustomers(mergeB.id, mergeA.id)
  const mergedDetail = await service.detail(mergeTicket.id, { userId: merchantA.id })
  assert.equal(mergedDetail.metrics.newFans, 1)
  assert.equal(mergedDetail.metrics.repeatFans, 1)
  const mergedRows = await pool.query(
    `SELECT id,fan_type,repeat_of_id FROM count_ticket_fans
     WHERE ticket_id=$1 ORDER BY event_at,id`,
    [mergeTicket.id]
  )
  assert.equal(mergedRows.rows[0].fan_type, 'new')
  assert.equal(mergedRows.rows[1].fan_type, 'repeat')
  assert.equal(String(mergedRows.rows[1].repeat_of_id), String(mergedRows.rows[0].id))
  const mergeOnlyRows = await pool.query(
    `SELECT ticket_id,fan_type,repeat_of_id
     FROM count_ticket_fans
     WHERE ticket_id = ANY($1::bigint[])
     ORDER BY ticket_id`,
    [[mergeTicketOnlyA.id, mergeTicketOnlyB.id]]
  )
  assert.deepEqual(
    mergeOnlyRows.rows.map(row => row.fan_type),
    ['new', 'new'],
    '客户合并不能把“仅当前工单”的两张工单串成重粉'
  )
  assert.ok(
    mergeOnlyRows.rows.every(row => row.repeat_of_id == null),
    '不同单工单范围不能互相指向首粉'
  )
  const mergedTelegram = await service.detail(telegramTicket.id, { userId: merchantA.id })
  assert.equal(mergedTelegram.metrics.newFans, 2, 'Telegram 内该客户的首条仍是新粉')
  assert.equal(mergedTelegram.metrics.repeatFans, 0, 'WhatsApp 的历史不能串进 Telegram 重粉')

  const rootCustomer = await makeCustomer('chain-root')
  const middleCustomer = await makeCustomer('chain-middle')
  const leafCustomer = await makeCustomer('chain-leaf')
  await customerRepository.recordMergeCandidate(rootCustomer.id, middleCustomer.id, 'chain', 0.9, {})
  const firstCandidate = await pool.query(
    `SELECT id FROM customer_merge_candidates
     WHERE customer_a=$1 AND customer_b=$2 AND status='pending'`,
    [Math.min(rootCustomer.id, middleCustomer.id), Math.max(rootCustomer.id, middleCustomer.id)]
  )
  await customerIdentities.resolveMergeCandidate(firstCandidate.rows[0].id, 'merge', null)

  const chainTicket = await service.saveTicket(merchantA.id, {
    title: '合并链回归', platform: 'whatsapp-green', timezone: 'Asia/Shanghai', zeroTime: '00:00'
  })
  await bindAccount(merchantA.id, chainTicket.id, 'acc-chain')
  const leafConversation = await makeConversation(
    merchantA.id, leafCustomer.id, 'acc-chain', 'peer-chain-leaf'
  )
  const leafFan = await captureInbound(merchantA.id, {
    conversationId: leafConversation,
    customerId: leafCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'acc-chain',
    peerKey: 'peer-chain-leaf',
    eventAt: '2026-11-19T03:00:00Z'
  })
  assert.equal(leafFan.fanType, 'new')

  await customerRepository.recordMergeCandidate(middleCustomer.id, leafCustomer.id, 'chain', 0.9, {})
  const secondCandidate = await pool.query(
    `SELECT id FROM customer_merge_candidates
     WHERE customer_a=$1 AND customer_b=$2 AND status='pending'`,
    [Math.min(middleCustomer.id, leafCustomer.id), Math.max(middleCustomer.id, leafCustomer.id)]
  )
  await customerIdentities.resolveMergeCandidate(secondCandidate.rows[0].id, 'merge', null)

  const rootConversation = await makeConversation(
    merchantA.id, rootCustomer.id, 'acc-chain', 'peer-chain-root'
  )
  const rootFan = await captureInbound(merchantA.id, {
    conversationId: rootConversation,
    customerId: rootCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'acc-chain',
    peerKey: 'peer-chain-root',
    eventAt: '2026-11-19T04:00:00Z'
  })
  assert.equal(rootFan.fanType, 'repeat', '已合并客户再作为目标后，根客户出现仍必须是重粉')
  const chainDetail = await service.detail(chainTicket.id, { userId: merchantA.id })
  assert.equal(chainDetail.metrics.newFans, 1)
  assert.equal(chainDetail.metrics.repeatFans, 1)
  const chainLinks = await pool.query(
    'SELECT id,merged_into FROM customers WHERE id=ANY($1::bigint[]) ORDER BY id',
    [[rootCustomer.id, middleCustomer.id, leafCustomer.id]]
  )
  assert.equal(chainLinks.rows.filter(row => row.merged_into == null).length, 1)
  assert.ok(chainLinks.rows.every(row =>
    row.merged_into == null || String(row.merged_into) === String(rootCustomer.id)))
  const chainAudit = await pool.query(
    `SELECT count_ticket_fans, moved_customer_ids
     FROM customer_merge_audits
     WHERE from_customer_id=$1 AND into_customer_id=$2
     ORDER BY id DESC LIMIT 1`,
    [leafCustomer.id, rootCustomer.id]
  )
  assert.equal(chainAudit.rows.length, 1, '合并必须留下账本快照')
  assert.equal(Number(chainAudit.rows[0].count_ticket_fans[0].id), leafFan.fanId)
  assert.equal(chainAudit.rows[0].count_ticket_fans[0].event_type, 'message')
  assert.equal(chainAudit.rows[0].count_ticket_fans[0].direction, 'in')
  assert.deepEqual(chainAudit.rows[0].moved_customer_ids.map(Number), [Number(leafCustomer.id)])
})

test('周期归档把当前客户转底库，分享页只读且密码不可绕过', { skip: !databaseUrl }, async t => {
  process.env.DATABASE_URL = databaseUrl
  const { Pool } = require('pg')
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const db = {
    query: (text, values, client) => (client || pool).query(text, values || []),
    transaction: async work => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }
  }
  const service = new CountTicketService(new CountTicketRepository(db))
  const suffix = `${process.pid}_${Date.now()}`
  const user = (await pool.query(
    `INSERT INTO users(username,password_hash,nickname,status)
     VALUES($1,'scrypt$s$h',$1,1) RETURNING id`,
    [`cycle_share_${suffix}`]
  )).rows[0]
  const customer = (await pool.query(
    `INSERT INTO customers(public_id)
     VALUES('CYCLE_' || nextval('customers_id_seq')) RETURNING id`
  )).rows[0]

  t.after(async () => {
    await pool.query('DELETE FROM users WHERE id=$1', [user.id])
    await pool.query('DELETE FROM customers WHERE id=$1', [customer.id])
    await pool.end()
  })

  const conversation = (await pool.query(
    `INSERT INTO conversations
       (user_id,customer_id,platform,account_key,peer_key,display_name,last_message_at)
     VALUES($1,$2,'whatsapp-green','acc-cycle','peer-cycle','周期客户',now())
     RETURNING id`,
    [user.id, customer.id]
  )).rows[0]
  const ticket = await service.saveTicket(user.id, {
    title: '周期分享回归',
    platform: 'whatsapp-green',
    dedupScope: 'ticket',
    dedupBaseEnabled: true,
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  await service.saveAccount(user.id, {
    ticketId: ticket.id,
    platform: 'whatsapp-green',
    accountKey: 'acc-cycle'
  })
  await pool.query(
    `UPDATE count_ticket_accounts
     SET created_at='2026-01-01T00:00:00Z', updated_at='2026-01-01T00:00:00Z'
     WHERE ticket_id=$1 AND user_id=$2`,
    [ticket.id, user.id]
  )

  const first = await service.captureFan(user.id, {
    conversationId: conversation.id,
    customerId: customer.id,
    platform: 'whatsapp-green',
    accountKey: 'acc-cycle',
    peerKey: 'peer-cycle',
    displayName: '周期客户',
    direction: 'in',
    eventType: 'message',
    body: 'first',
    eventAt: '2026-11-20T01:00:00Z'
  })
  assert.equal(first.fanType, 'new')

  const share = await service.createShare(user.id, ticket.id, {
    passwordProtected: true,
    password: 'share123456',
    expiresInDays: 7
  })
  assert.match(share.sharePath, /^\/#\/share\/count\//)
  await assert.rejects(
    () => service.viewShare({ token: share.token, password: 'wrong-password' }),
    error => error.code === 'COUNT_SHARE_PASSWORD_BAD'
  )
  const firstView = await service.viewShare({
    token: share.token,
    password: 'share123456'
  })
  assert.equal(firstView.ticket.title, '周期分享回归')
  assert.equal(firstView.metrics.totalFans, 1)
  assert.equal(firstView.accounts[0].accountKey, 'acc-cycle')
  assert.equal(firstView.fans[0].peerKey, 'peer-cycle')
  assert.equal('userId' in firstView, false, '公开分享响应不能泄露商户 ID')
  assert.equal('username' in firstView.ticket, false, '公开分享响应不能泄露商户名')

  const reset = await service.resetCycle(user.id, { id: ticket.id })
  assert.equal(reset.previousCycle, 1)
  assert.equal(reset.cycleNo, 2)
  assert.equal(reset.promoted, 1)
  const afterReset = await service.detail(ticket.id, { userId: user.id })
  assert.equal(afterReset.ticket.cycleNo, 2)
  assert.equal(afterReset.metrics.totalFans, 0, '新周期必须从 0 开始')
  const historical = await pool.query(
    `SELECT cycle_no FROM count_ticket_fans
     WHERE ticket_id=$1 ORDER BY id`,
    [ticket.id]
  )
  assert.deepEqual(historical.rows.map(row => row.cycle_no), [1], '重置不能删除旧周期账本')
  const base = await pool.query(
    `SELECT source FROM count_ticket_base_entries
     WHERE user_id=$1 AND platform='whatsapp-green' AND peer_key='peer-cycle'`,
    [user.id]
  )
  assert.equal(base.rows.length, 1)
  assert.match(base.rows[0].source, /周期归档/)

  const reentry = await service.captureFan(user.id, {
    conversationId: conversation.id,
    customerId: customer.id,
    platform: 'whatsapp-green',
    accountKey: 'acc-cycle',
    peerKey: 'peer-cycle',
    displayName: '周期客户',
    direction: 'in',
    eventType: 'message',
    body: 'second cycle',
    eventAt: new Date().toISOString()
  })
  assert.equal(reentry.captured, true)
  assert.equal(reentry.fanType, 'repeat', '归档到底库的客户再进线必须算重粉')
  assert.equal(reentry.repeatType, 'base')

  const secondView = await service.viewShare({
    token: share.token,
    password: 'share123456'
  })
  assert.equal(secondView.metrics.totalFans, 1, '分享页必须只展示当前周期')
  assert.equal(secondView.metrics.repeatFans, 1)
  assert.equal(secondView.metrics.baseRepeatFans, 1)
  assert.equal(secondView.metrics.todayBaseRepeatFans, 1)
  await service.revokeShare(user.id, ticket.id)
  await assert.rejects(
    () => service.viewShare({ token: share.token, password: 'share123456' }),
    error => error.code === 'COUNT_SHARE_NOT_FOUND'
  )

  const deleteShare = await service.createShare(user.id, ticket.id, {
    passwordProtected: false,
    expiresInDays: 7
  })
  await service.viewShare({ token: deleteShare.token })
  const fanCountBeforeDelete = (await pool.query(
    'SELECT count(*)::int AS n FROM count_ticket_fans WHERE ticket_id=$1',
    [ticket.id]
  )).rows[0].n

  const deleted = await service.deleteTicket(user.id, { id: ticket.id })
  assert.equal(deleted.id, Number(ticket.id))
  assert.equal(deleted.title, '周期分享回归')
  const liveList = await service.list(user.id, { status: 'all' })
  assert.equal(
    liveList.rows.some(row => Number(row.id) === Number(ticket.id)),
    false,
    '软删除后商户列表不能再显示该工单'
  )
  await assert.rejects(
    () => service.detail(ticket.id, { userId: user.id }),
    error => error.code === 'COUNT_TICKET_NOT_FOUND',
    '软删除后详情必须按不存在处理'
  )
  await assert.rejects(
    () => service.viewShare({ token: deleteShare.token }),
    error => error.code === 'COUNT_SHARE_NOT_FOUND',
    '删除工单必须让分享链接立即失效'
  )
  const deletedRow = (await pool.query(
    'SELECT status,deleted_at FROM count_tickets WHERE id=$1',
    [ticket.id]
  )).rows[0]
  assert.equal(deletedRow.status, 'closed')
  assert.ok(deletedRow.deleted_at, '删除必须落软删除时间')
  assert.equal((await pool.query(
    'SELECT count(*)::int AS n FROM count_ticket_fans WHERE ticket_id=$1',
    [ticket.id]
  )).rows[0].n, fanCountBeforeDelete, '删除工单不能清掉历史进粉账本')
  assert.equal((await pool.query(
    `SELECT count(*)::int AS n FROM count_ticket_accounts
     WHERE ticket_id=$1 AND active=true`,
    [ticket.id]
  )).rows[0].n, 0, '删除工单必须停用全部接入账号')
})
