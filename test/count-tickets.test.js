'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  CountTicketService,
  normalizeTicket,
  validTimezone,
  validZeroTime
} = require('../server/services/count-ticket-service')
const { CountTicketRepository } = require('../server/repositories/count-ticket-repository')
const { capabilityFor } = require('../server/lib/capabilities')
const { packageAllowsCounter } = require('../server/lib/client-catalog')
const { CustomerRepository } = require('../server/repositories/customer-repository')
const { CustomerIdentityService } = require('../server/services/customer-identity-service')
const { publicUser } = require('../server/routes/context')

const databaseUrl = process.env.PIX_TEST_DATABASE_URL

test('计数工单参数：时区、置零时间和目标值 fail-safe', () => {
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
  assert.equal(normalized.dayTarget, 12)
  assert.equal(normalized.totalTarget, 0, '非法目标不能被静默保存成负数')
  assert.equal(normalized.zeroTime, '04:00:00')
})

test('计数工单超管读接口全部显式声明客户数据权限', () => {
  assert.equal(capabilityFor('GET', '/admin/count-tickets'), 'admin.data.customers')
  assert.equal(capabilityFor('GET', '/admin/count-tickets/:id'), 'admin.data.customers')
  assert.equal(capabilityFor('GET', '/admin/count-tickets/:id/fans'), 'admin.data.customers')
})

test('计数工单权益只认套餐 clients.counter', () => {
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

  async function bindAccount(userId, ticketId, accountKey, since = '2026-01-01T00:00:00Z') {
    await service.saveAccount(userId, { ticketId, platform: 'whatsapp-green', accountKey })
    await pool.query(
      `UPDATE count_ticket_accounts
       SET created_at=$4, updated_at=$4
       WHERE user_id=$1 AND ticket_id=$2 AND platform=$3 AND account_key=$5 AND active=true`,
      [userId, ticketId, 'whatsapp-green', since, accountKey]
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
    dayTarget: 20,
    totalTarget: 100,
    timezone: 'Asia/Shanghai',
    zeroTime: '04:00'
  })
  await bindAccount(merchantA.id, ticketA.id, 'acc-a')
  await bindAccount(merchantA.id, ticketA.id, 'acc-b')

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
    eventAt: '2025-12-31T23:59:59Z'
  }))).reason, 'before_account_binding', '账号绑定前的历史不能补进新工单')
  assert.equal((await service.captureFan(merchantA.id, Object.assign({}, gateBase, {
    direction: 'in', body: '未来消息', eventType: 'message',
    eventAt: '2099-01-01T00:00:00Z'
  }))).reason, 'event_at_in_future', '未来时间不能污染计数')

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
    ['acc-a', 'acc-b', 'acc-late'],
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
  await service.saveAccount(merchantA.id, {
    ticketId: telegramTicket.id, platform: 'telegram-z', accountKey: 'tg-acc'
  })
  await pool.query(
    `UPDATE count_ticket_accounts SET created_at=$4, updated_at=$4
     WHERE user_id=$1 AND ticket_id=$2 AND platform=$3 AND account_key='tg-acc'`,
    [merchantA.id, telegramTicket.id, 'telegram-z', '2026-01-01T00:00:00Z']
  )
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

  // 同一客户在另一商户的工单再次出现，也只暴露“重粉”这个事实。
  const ticketB = await service.saveTicket(merchantB.id, {
    title: 'WhatsApp B 组',
    platform: 'whatsapp-green',
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
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
  assert.equal(crossRepeat.fanType, 'repeat')

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
  await bindAccount(merchantA.id, mergeTicket.id, 'merge-a')
  await bindAccount(merchantA.id, mergeTicket.id, 'merge-b')
  const mergeConvA = await makeConversation(merchantA.id, mergeA.id, 'merge-a', 'merge-peer-a')
  const mergeConvB = await makeConversation(merchantA.id, mergeB.id, 'merge-b', 'merge-peer-b')
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
})
