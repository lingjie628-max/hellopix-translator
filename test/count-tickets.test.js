'use strict'

const assert = require('node:assert/strict')
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
    dayTarget: '12',
    totalTarget: -3,
    timezone: 'Asia/Shanghai',
    zeroTime: '04:00'
  })
  assert.equal(normalized.title, 'WhatsApp 进粉')
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
    dayTarget: 20,
    totalTarget: 100,
    timezone: 'Asia/Shanghai',
    zeroTime: '04:00'
  })
  await service.saveAccount(merchantA.id, {
    ticketId: ticketA.id, platform: 'whatsapp-green', accountKey: 'acc-a'
  })
  await service.saveAccount(merchantA.id, {
    ticketId: ticketA.id, platform: 'whatsapp-green', accountKey: 'acc-b'
  })

  const conv1 = await makeConversation(merchantA.id, customer.id, 'acc-a', 'peer-1')
  const first = await service.captureFan(merchantA.id, {
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

  const duplicate = await service.captureFan(merchantA.id, {
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
  const secondAccount = await service.captureFan(merchantA.id, {
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
  const other = await service.captureFan(merchantA.id, {
    conversationId: conv3,
    customerId: otherCustomer.id,
    platform: 'whatsapp-green',
    accountKey: 'acc-a',
    peerKey: 'peer-3',
    displayName: '另一位客户',
    eventAt: '2026-11-18T04:00:02+08:00'
  })
  assert.equal(other.fanType, 'new')

  const available = await service.availableAccounts(merchantA.id)
  assert.deepEqual(
    available.map(item => item.accountKey).sort(),
    ['acc-a', 'acc-b'],
    '绑定弹窗只能看到当前商户真实上报过的接入账号'
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

  // 同一客户在另一商户的工单再次出现，也只暴露“重粉”这个事实。
  const ticketB = await service.saveTicket(merchantB.id, {
    title: 'WhatsApp B 组',
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  await service.saveAccount(merchantB.id, {
    ticketId: ticketB.id, platform: 'whatsapp-green', accountKey: 'acc-cross'
  })
  const conv4 = await makeConversation(merchantB.id, customer.id, 'acc-cross', 'peer-4')
  const crossRepeat = await service.captureFan(merchantB.id, {
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
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  await service.saveAccount(merchantA.id, {
    ticketId: ticketA2.id, platform: 'whatsapp-green', accountKey: 'acc-a'
  })
  const active = await pool.query(
    `SELECT ticket_id FROM count_ticket_accounts
     WHERE user_id=$1 AND platform='whatsapp-green' AND account_key='acc-a' AND active=true`,
    [merchantA.id]
  )
  assert.deepEqual(active.rows.map(row => Number(row.ticket_id)), [ticketA2.id])

  await service.saveTicket(merchantA.id, {
    id: ticketA2.id,
    title: 'WhatsApp A 二组',
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
    timezone: 'Asia/Shanghai',
    zeroTime: '00:00'
  })
  await service.saveAccount(merchantA.id, {
    ticketId: mergeTicket.id, platform: 'whatsapp-green', accountKey: 'merge-a'
  })
  await service.saveAccount(merchantA.id, {
    ticketId: mergeTicket.id, platform: 'whatsapp-green', accountKey: 'merge-b'
  })
  const mergeConvA = await makeConversation(merchantA.id, mergeA.id, 'merge-a', 'merge-peer-a')
  const mergeConvB = await makeConversation(merchantA.id, mergeB.id, 'merge-b', 'merge-peer-b')
  await service.captureFan(merchantA.id, {
    conversationId: mergeConvA,
    customerId: mergeA.id,
    platform: 'whatsapp-green',
    accountKey: 'merge-a',
    peerKey: 'merge-peer-a',
    eventAt: '2026-11-18T11:00:00+08:00'
  })
  await service.captureFan(merchantA.id, {
    conversationId: mergeConvB,
    customerId: mergeB.id,
    platform: 'whatsapp-green',
    accountKey: 'merge-b',
    peerKey: 'merge-peer-b',
    eventAt: '2026-11-18T12:00:00+08:00'
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
})
