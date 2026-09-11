'use strict'

const express = require('express')
const crypto = require('crypto')
const { asyncRoute, input, pagination, page, ok, stub, ApiError } = require('../lib/http')
const { mapRow, mapRows } = require('../repositories/production-repository')
const { number } = require('../services/core-service')
const { redisRateLimit } = require('../redis-security')
const captcha = require('../lib/captcha')
const { encryptSecret, credentialsKeyReady, KEY_ENV } = require('../lib/credentials')
const { providers, channelStatus } = require('../services/translation-provider')

function publicUser(session) {
  return {
    role: session.kind,
    username: session.account.username,
    nickname: session.account.nickname || session.account.username,
    email: session.account.email || session.parent.email || '',
    basename: session.parent.packageTitle || '',
    versionId: session.parent.packageId,
    charBalance: number(session.account.charBalance),
    enterprise: number(session.parent.enterprise)
  }
}

function productionRouter(context) {
  const { repository: repo, auth, core, security } = context
  const router = express.Router()
  const limit = (namespace, max, windowMs, key) => redisRateLimit({
    redis: core.redis,
    namespace,
    max,
    windowMs,
    key
  })
  const loginIpLimit = limit('login-ip', 30, 15 * 60_000)
  const loginAccountLimit = limit('login-account', 10, 15 * 60_000, req =>
    String(input(req).username || '').trim().toLowerCase() || 'missing'
  )
  const captchaLimit = limit('captcha-ip', 60, 10 * 60_000)
  const shareIpLimit = limit('share-ip', 30, 10 * 60_000)
  const shareOrderLimit = limit('share-order', 15, 10 * 60_000, req =>
    String(input(req).serialNumber || input(req).orderNum || 'missing')
  )
  const translateIpLimit = limit('translate-ip', 180, 60_000)
  const translateAccountLimit = limit('translate-account', 120, 60_000, req =>
    req.pixUser ? `${req.pixUser.kind}:${req.pixUser.account.id}` : 'missing'
  )

  router.use(auth.middleware())
  router.use(security.csrf)

  router.post('/login', loginIpLimit, loginAccountLimit, asyncRoute(async (req, res) => {
    const data = input(req)
    const captchaError = await captcha.consume(core.redis, data.imageId, data.imageCode)
    if (captchaError) throw new ApiError(400, captchaError, 'BAD_CAPTCHA')
    const session = await auth.loginUser(req, res, data, false)
    res.json({ success: true, msg: '登录成功', obj: publicUser(session) })
  }))
  router.get('/user/captcha', captchaLimit, asyncRoute(async (_req, res) => {
    res.json(Object.assign({ success: true }, await captcha.issue(core.redis)))
  }))
  router.post('/logout', asyncRoute(async (req, res) => {
    await security.destroySession(req, res, 'user')
    ok(res, '已退出')
  }))
  router.post('/client/login', loginIpLimit, loginAccountLimit, asyncRoute(async (req, res) => {
    const session = await auth.loginUser(req, res, input(req), true)
    res.json({ success: true, msg: '登录成功', obj: core.profile(session) })
  }))
  router.get('/client/session', asyncRoute(async (req, res) => {
    res.json({ success: true, obj: core.profile(req.pixUser) })
  }))
  router.post('/client/logout', asyncRoute(async (req, res) => {
    await security.destroySession(req, res, 'user')
    ok(res, '已退出')
  }))
  router.get('/client/platforms', (_req, res) => res.json({ success: true, rows: core.platforms() }))
  router.post('/client/translate-prefs', asyncRoute(async (req, res) => {
    const data = input(req)
    const session = req.pixUser
    const table = session.kind === 'sub' ? 'sub_accounts' : 'users'
    await repo.query(
      `UPDATE ${table} SET trans_recv=COALESCE($2,trans_recv),trans_send=COALESCE($3,trans_send),
       trans_group=COALESCE($4,trans_group),lang_mine=COALESCE($5,lang_mine),
       lang_other=COALESCE($6,lang_other),include_zh=COALESCE($7,include_zh),
       active_engine_id=COALESCE($8,active_engine_id),updated_at=NOW() WHERE id=$1`,
      [session.account.id,
        data.transRecv === undefined ? null : Boolean(number(data.transRecv)),
        data.transSend === undefined ? null : Boolean(number(data.transSend)),
        data.transGroup === undefined ? null : Boolean(number(data.transGroup)),
        data.langMine || null, data.langOther || null,
        data.includeZh === undefined ? null : Boolean(number(data.includeZh)), data.engine || null]
    )
    ok(res, '翻译选项已保存')
  }))
  router.get('/client/update', asyncRoute(async (req, res) => {
    res.json(await core.findUpdate(input(req)))
  }))

  router.get('/user/dashboard', asyncRoute(async (req, res) => res.json(await core.dashboard(req.pixUser))))
  router.get('/userVersion/getUserVersion', asyncRoute(async (req, res) => {
    res.json((await repo.package(req.pixUser.parent.packageId)) || {})
  }))
  router.post('/userVersion/getVersion', asyncRoute(async (_req, res) => res.json(await repo.packages())))
  router.get('/userRecharge/getUserRecharge', asyncRoute(async (req, res) => {
    const data = input(req)
    const paging = pagination(req)
    const values = [req.pixUser.parent.id]
    const clauses = ['user_id=$1']
    if (data.orderNum) { values.push(`%${data.orderNum}%`); clauses.push(`order_number ILIKE $${values.length}`) }
    if (data.status !== undefined && data.status !== '') { values.push(number(data.status)); clauses.push(`status=$${values.length}`) }
    const result = await repo.list('recharges', { where: clauses.join(' AND '), values, limit: paging.size, offset: paging.offset })
    result.rows = result.rows.map(row => Object.assign(row, {
      orderNum: row.orderNumber,
      originalPrice: row.originalAmount,
      discountAmount: row.discountAmount,
      paidAmount: row.paidAmount,
      price: row.paidAmount,
      type: row.paymentType,
      createTime: row.createdAt
    }))
    res.json(page(result.rows, result.total, paging))
  }))
  router.get('/user/quote', asyncRoute(async (req, res) => res.json(await core.quote(input(req)))))

  router.get('/team/info', asyncRoute(async (req, res) => res.json(await core.teamInfo(req.pixUser))))
  router.get('/team/subs', asyncRoute(async (req, res) => {
    if (req.pixUser.kind !== 'main') throw new ApiError(403, '仅主账号可管理子账号', 'MAIN_ACCOUNT_REQUIRED')
    const data = input(req)
    const paging = pagination(req)
    const values = [req.pixUser.parent.id]
    const clauses = ['parent_id=$1']
    if (data.keyword) {
      values.push(`%${data.keyword}%`)
      clauses.push(`(username ILIKE $${values.length} OR nickname ILIKE $${values.length} OR email ILIKE $${values.length})`)
    }
    const result = await repo.list('subs', { where: clauses.join(' AND '), values, limit: paging.size, offset: paging.offset })
    result.rows.forEach(row => { delete row.passwordHash })
    res.json(page(result.rows, result.total, paging))
  }))
  router.post('/team/subs/save', asyncRoute(async (req, res) => {
    await core.saveSub(req.pixUser, input(req))
    ok(res, input(req).id ? '子账号已更新' : '子账号已创建。该账号可登录无限个 Telegram / WhatsApp 等聊天号')
  }))
  router.post('/team/subs/chars', asyncRoute(async (req, res) => {
    const result = await core.transferChars(req.pixUser, input(req))
    ok(res, result.chars > 0 ? `已分配 ${result.chars} 字符给 ${result.username}` : `已从 ${result.username} 收回 ${Math.abs(result.chars)} 字符`)
  }))
  const setSubStatus = asyncRoute(async (req, res) => {
    if (req.pixUser.kind !== 'main') throw new ApiError(403, '仅主账号可管理子账号')
    const data = input(req)
    const result = await repo.query(
      'UPDATE sub_accounts SET status=$3,updated_at=NOW() WHERE id=$1 AND parent_id=$2 RETURNING id',
      [data.id, req.pixUser.parent.id, number(data.status)]
    )
    if (!result.rows[0]) throw new ApiError(404, '子账号不存在', 'SUB_NOT_FOUND')
    if (number(data.status) !== 1) await auth.revokeUser('sub', data.id)
    ok(res, number(data.status) === 1 ? '已启用' : '已停用')
  })
  router.post('/team/subs/status', setSubStatus)
  router.post('/team/subs/batch', asyncRoute(async (req, res) => {
    if (req.pixUser.kind !== 'main') throw new ApiError(403, '仅主账号可管理子账号')
    const data = input(req)
    const ids = String(data.ids || '').split(',').filter(Boolean)
    const changed = await repo.query(
      'UPDATE sub_accounts SET status=$3,updated_at=NOW() WHERE parent_id=$1 AND id=ANY($2::bigint[]) RETURNING id',
      [req.pixUser.parent.id, ids, number(data.status)]
    )
    if (number(data.status) !== 1) {
      await Promise.all(changed.rows.map(row => auth.revokeUser('sub', row.id)))
    }
    ok(res, number(data.status) === 1 ? '已开启所选' : '已关闭所选')
  }))
  router.post('/team/autoAlloc', asyncRoute(async (req, res) => {
    if (req.pixUser.kind !== 'main') throw new ApiError(403, '仅主账号可管理子账号')
    const data = input(req)
    if (data.id) {
      await repo.query('UPDATE sub_accounts SET auto_alloc=$3 WHERE id=$1 AND parent_id=$2', [data.id, req.pixUser.parent.id, Boolean(number(data.autoAlloc))])
    } else {
      await repo.query('UPDATE users SET auto_alloc_master=$2 WHERE id=$1', [req.pixUser.parent.id, Boolean(number(data.autoAlloc))])
    }
    ok(res, '已更新自动分配')
  }))
  router.post('/team/password', asyncRoute(async (req, res) => {
    const data = input(req)
    if (!await auth.verify(req.pixUser.account.passwordHash, data.oldPassword)) throw new ApiError(400, '原密码不正确', 'BAD_PASSWORD')
    const table = req.pixUser.kind === 'sub' ? 'sub_accounts' : 'users'
    await repo.query(`UPDATE ${table} SET password_hash=$2,updated_at=NOW() WHERE id=$1`, [req.pixUser.account.id, await auth.hash(data.newPassword)])
    await auth.revokeUser(req.pixUser.kind, req.pixUser.account.id)
    ok(res, '密码已修改')
  }))
  router.post('/team/device/reset', asyncRoute(async (req, res) => {
    const data = input(req)
    let kind = req.pixUser.kind
    let id = req.pixUser.account.id
    if (req.pixUser.kind === 'main' && data.id && String(data.id) !== String(req.pixUser.parent.id)) {
      const owned = await repo.query('SELECT id FROM sub_accounts WHERE id=$1 AND parent_id=$2', [data.id, req.pixUser.parent.id])
      if (!owned.rows[0]) throw new ApiError(404, '子账号不存在', 'SUB_NOT_FOUND')
      kind = 'sub'; id = data.id
    }
    await repo.query(`UPDATE ${kind === 'sub' ? 'sub_accounts' : 'users'} SET bound_device='' WHERE id=$1`, [id])
    await auth.revokeUser(kind, id)
    ok(res, '客户端绑定已重置')
  }))

  router.post('/order/getOrder', asyncRoute(async (req, res) => {
    const paging = pagination(req)
    const result = await core.listOrders(req.pixUser.parent.id, input(req), paging)
    res.json(page(result.rows, result.total, paging))
  }))
  router.post('/order/editOrder', asyncRoute(async (req, res) => {
    await core.saveOrder(req.pixUser.parent.id, input(req), req.query.orderOperates)
    ok(res, req.query.orderOperates === 'add' ? '创建成功' : '保存成功')
  }))
  router.post('/order/deleteOrder', asyncRoute(async (req, res) => {
    const ids = String(input(req).orderIds || '').split(',').filter(Boolean)
    await core.deleteOrders(req.pixUser.parent.id, ids)
    ok(res, '删除成功')
  }))
  router.post('/order/orderCloseOrOpen', asyncRoute(async (req, res) => {
    const data = input(req)
    const nums = String(data.orderNums || '').split(',').filter(Boolean)
    await repo.query('UPDATE orders SET status=$3,updated_at=NOW() WHERE user_id=$1 AND serial_number=ANY($2::text[])', [req.pixUser.parent.id, nums, number(data.type, 1)])
    ok(res, '操作成功')
  }))
  router.post('/order/setOrderExpTime', asyncRoute(async (req, res) => {
    const data = input(req)
    const nums = String(data.orderNums || '').split(',').filter(Boolean)
    await repo.query(
      `UPDATE orders SET expires_at=NOW()+($3::text||' days')::interval,updated_at=NOW()
       WHERE user_id=$1 AND serial_number=ANY($2::text[])`,
      [req.pixUser.parent.id, nums, Math.max(1, Math.floor(number(data.orderDays, 1)))]
    )
    ok(res, '续时成功')
  }))
  router.post('/order/cancelShare', asyncRoute(async (req, res) => {
    const data = input(req)
    await repo.query(`UPDATE orders SET share_password_hash=NULL,share_password_expires_at=NULL,updated_at=NOW() WHERE user_id=$1 AND (id::text=$2 OR serial_number=$2)`, [req.pixUser.parent.id, String(data.id || data.orderNum || '')])
    ok(res, '已取消分享')
  }))
  const updateShare = asyncRoute(async (req, res) => {
    const data = input(req)
    const hash = await auth.hashSecret(data.sharePassword || data.password)
    const result = await repo.query(
      `UPDATE orders SET share_password_hash=$3,share_password_expires_at=COALESCE($4::timestamptz,NOW()+interval '7 days'),updated_at=NOW()
       WHERE user_id=$1 AND (id::text=$2 OR serial_number=$2) RETURNING id`,
      [req.pixUser.parent.id, String(data.id || data.orderNum || ''), hash, data.passwordExpirationTime || null]
    )
    if (!result.rows[0]) throw new ApiError(404, '工单不存在', 'ORDER_NOT_FOUND')
    ok(res, '分享密码已更新')
  })
  router.post('/order/updateSharePwd', updateShare)
  router.post('/order/editSharePwd', updateShare)
  router.post('/order/getServerTime', (_req, res) => res.json({ data: Date.now() }))
  router.post('/order/selectOrderBySerialNumber', shareIpLimit, shareOrderLimit, asyncRoute(async (req, res) => {
    const result = await repo.query(
      `SELECT serial_number,title,zero_time,share_password_expires_at AS password_expiration_time,status
       FROM orders WHERE serial_number=$1`,
      [input(req).serialNumber]
    )
    if (!result.rows[0]) throw new ApiError(404, '工单不存在', 'ORDER_NOT_FOUND')
    res.json({ data: mapRow(result.rows[0]) })
  }))
  router.post('/order/checkSharePwd', shareIpLimit, shareOrderLimit,
    asyncRoute(async (req, res) => res.json(await core.sharePassword(input(req)))))
  router.post('/orderDetails/shareOrder', asyncRoute(async (req, res) => {
    const data = input(req)
    await core.assertShare(data.shareToken, data.orderNum)
    const paging = pagination(req)
    const values = [data.orderNum]
    const result = await repo.query(
      `SELECT d.*,d.nickname AS nick_name,o.serial_number AS order_num
       FROM order_details d JOIN orders o ON o.id=d.order_id
       WHERE o.serial_number=$1 ORDER BY d.id DESC LIMIT $2 OFFSET $3`,
      [data.orderNum, paging.size, paging.offset]
    )
    const count = await repo.query(
      'SELECT count(*)::int AS total FROM order_details d JOIN orders o ON o.id=d.order_id WHERE o.serial_number=$1',
      values
    )
    const order = await repo.query('SELECT * FROM orders WHERE serial_number=$1', values)
    res.json(Object.assign(page(mapRows(result.rows), count.rows[0].total, paging), { object: mapRow(order.rows[0]) || {} }))
  }))
  const sharedFans = asyncRoute(async (req, res) => {
    const data = input(req)
    await core.assertShare(data.shareToken, data.orderNum)
    const paging = pagination(req)
    const result = await repo.query(
      `SELECT f.*,f.nickname AS nick_name,f.fan_type AS type,o.serial_number AS order_num
       FROM order_fans f JOIN orders o ON o.id=f.order_id
       WHERE o.serial_number=$1 ORDER BY f.id DESC LIMIT $2 OFFSET $3`,
      [data.orderNum, paging.size, paging.offset]
    )
    const count = await repo.query(
      'SELECT count(*)::int AS total FROM order_fans f JOIN orders o ON o.id=f.order_id WHERE o.serial_number=$1',
      [data.orderNum]
    )
    res.json(page(mapRows(result.rows), count.rows[0].total, paging))
  })
  router.post('/orderDetails/getOrderFans', sharedFans)
  router.get('/orderDetails/getOrderFans', sharedFans)
  router.post('/orderDetails/getTodayFansCount', asyncRoute(async (req, res) => {
    const data = input(req)
    const serial = data.serialNumber || data.orderNum
    await core.assertShare(data.shareToken, serial)
    const result = await repo.query(
      `SELECT count(*)::int AS total_fans_count,
       count(*) FILTER (WHERE f.created_at>=CURRENT_DATE)::int AS today_fans_count,
       count(*) FILTER (WHERE f.created_at>=CURRENT_DATE AND f.repeated=true)::int AS today_rep_fans_count
       FROM order_fans f JOIN orders o ON o.id=f.order_id WHERE o.serial_number=$1`,
      [serial]
    )
    res.json({ data: mapRow(result.rows[0]) })
  }))

  router.get('/translate/engines', asyncRoute(async (req, res) => res.json(await core.engines(req.pixUser))))
  router.post('/translate/engines/active', asyncRoute(async (req, res) => {
    const data = input(req)
    const available = await core.engines(req.pixUser)
    if (!available.rows.some(row => String(row.id) === String(data.id) && row.allowed && number(row.enabled) === 1)) {
      throw new ApiError(403, '当前套餐未包含此通道', 'ENGINE_NOT_ALLOWED')
    }
    const table = req.pixUser.kind === 'sub' ? 'sub_accounts' : 'users'
    await repo.query(`UPDATE ${table} SET active_engine_id=$2,updated_at=NOW() WHERE id=$1`, [req.pixUser.account.id, data.id])
    ok(res, '翻译通道已切换')
  }))
  const translate = asyncRoute(async (req, res) => {
    res.json(await core.translate(req.pixUser, input(req), req.get('Idempotency-Key')))
  })
  router.post('/translate/run', translateIpLimit, translateAccountLimit, translate)
  router.post('/translate', translateIpLimit, translateAccountLimit, translate)

  router.get('/site/info', asyncRoute(async (_req, res) => res.json(await core.siteInfo())))
  router.get('/client/lines', asyncRoute(async (_req, res) => {
    const result = await repo.query('SELECT id,name,url,region,enabled FROM client_lines WHERE enabled=true ORDER BY sort_order,id')
    res.json({ success: true, rows: mapRows(result.rows) })
  }))

  router.post('/admin/login', loginIpLimit, loginAccountLimit, asyncRoute(async (req, res) => {
    const admin = await auth.loginAdmin(req, res, input(req))
    res.json({ success: true, msg: '登录成功', obj: { username: admin.username, nickname: admin.nickname, role: admin.role || 'superadmin' } })
  }))
  router.post('/admin/logout', asyncRoute(async (req, res) => {
    await security.destroySession(req, res, 'admin')
    ok(res, '已退出')
  }))
  router.get('/admin/stats', asyncRoute(async (_req, res) => {
    const result = await repo.query(
      `SELECT
       (SELECT count(*) FROM users)::int AS user_count,
       (SELECT count(*) FROM users WHERE status=1)::int AS active_users,
       (SELECT count(*) FROM orders)::int AS order_count,
       (SELECT count(*) FROM orders WHERE status=1)::int AS open_orders,
       (SELECT count(*) FROM sub_accounts)::int AS sub_count,
       (SELECT COALESCE(sum(char_balance),0) FROM users)::bigint AS char_balance,
       (SELECT COALESCE(sum(chars),0) FROM translate_logs)::bigint AS char_used,
       (SELECT COALESCE(sum(paid_amount),0) FROM recharges WHERE status=1)::numeric AS recharge_sum`
    )
    res.json(mapRow(result.rows[0]))
  }))

  async function adminList(req, res, table, whereBuilder) {
    const data = input(req)
    const paging = pagination(req, { size: 50 })
    const built = whereBuilder ? whereBuilder(data) : { where: 'TRUE', values: [] }
    const result = await repo.list(table, { where: built.where, values: built.values, limit: paging.size, offset: paging.offset })
    result.rows.forEach(row => { delete row.passwordHash })
    res.json(page(result.rows, result.total, paging))
  }
  const keyword = columns => data => {
    if (!data.keyword) return { where: 'TRUE', values: [] }
    return { where: `(${columns.map(column => `${column} ILIKE $1`).join(' OR ')})`, values: [`%${data.keyword}%`] }
  }
  async function adminJoinedList(req, res, config) {
    const data = input(req)
    const paging = pagination(req, { size: 50 })
    const values = []
    let filter = ''
    if (data.keyword) {
      values.push(`%${data.keyword}%`)
      filter = ` AND (${config.keyword.map(column => `${column} ILIKE $1`).join(' OR ')})`
    }
    const count = await repo.query(`SELECT count(*)::bigint AS total FROM ${config.from} WHERE TRUE${filter}`, values)
    const rows = await repo.query(
      `SELECT ${config.select} FROM ${config.from} WHERE TRUE${filter}
       ORDER BY ${config.order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      values.concat([paging.size, paging.offset])
    )
    res.json(page(mapRows(rows.rows), count.rows[0].total, paging))
  }
  router.get('/admin/users', asyncRoute((req, res) => adminJoinedList(req, res, {
    from: 'users u LEFT JOIN packages p ON p.id=u.package_id',
    select: `u.id,u.username,u.nickname,u.email,u.phone,u.status,u.package_id AS version_id,
      p.title AS basename,u.char_balance,u.char_used,u.translate_count,u.sub_quota,u.auto_alloc_master,
      u.auto_reply,u.enterprise,u.port_limit AS port,u.ports_in_use AS user_ports,u.bound_device,
      u.expires_at AS expire_time,u.remarks,u.created_at AS create_time`,
    keyword: ['u.username', 'u.nickname'],
    order: 'u.id DESC'
  })))
  router.get('/admin/subs', asyncRoute((req, res) => adminJoinedList(req, res, {
    from: 'sub_accounts s JOIN users u ON u.id=s.parent_id',
    select: `s.id,s.parent_id,s.username,s.nickname,s.email,s.status,s.char_balance,s.char_used,
      s.translate_count,s.auto_alloc,s.bound_device,s.active_engine_id,u.username AS parent_username,
      s.created_at AS create_time`,
    keyword: ['s.username', 's.nickname', 'u.username'],
    order: 's.id DESC'
  })))
  router.get('/admin/orders', asyncRoute((req, res) => adminJoinedList(req, res, {
    from: 'orders o JOIN users u ON u.id=o.user_id',
    select: `o.*,o.port_limit AS port,o.total_users AS total_user,o.completed_target AS complete_target,
      o.expires_at AS expiration_time,o.share_password_expires_at AS password_expiration_time,
      u.username,u.nickname`,
    keyword: ['o.serial_number', 'o.title', 'u.username'],
    order: 'o.id DESC'
  })))
  router.get('/admin/recharges', asyncRoute((req, res) => adminJoinedList(req, res, {
    from: 'recharges r JOIN users u ON u.id=r.user_id LEFT JOIN packages p ON p.id=r.package_id',
    select: `r.*,r.order_number AS order_num,r.original_amount AS original_price,
      r.paid_amount AS price,r.payment_type AS type,r.created_at AS create_time,u.username,p.title AS basename`,
    keyword: ['r.order_number', 'r.payment_type', 'u.username'],
    order: 'r.id DESC'
  })))
  router.get('/admin/translate/logs', asyncRoute((req, res) => adminJoinedList(req, res, {
    from: 'translate_logs t JOIN users u ON u.id=t.user_id',
    select: `t.*,t.engine_id AS engine,(t.source_language||'→'||t.target_language) AS direction,
      t.cost_amount AS cost,t.sell_amount AS sell,t.created_at AS create_time,u.username`,
    keyword: ['t.engine_id', 't.snippet', 'u.username'],
    order: 't.id DESC'
  })))
  router.get('/admin/logs', asyncRoute((req, res) => adminList(req, res, input(req).kind === 'audit' ? 'audits' : 'logins')))
  router.get('/admin/staff', asyncRoute(async (_req, res) => {
    const result = await repo.query('SELECT id,username,nickname,role FROM admins ORDER BY id')
    res.json(mapRows(result.rows))
  }))
  router.post('/admin/users/status', asyncRoute(async (req, res) => {
    const data = input(req)
    const result = await repo.query('UPDATE users SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING username', [data.id, number(data.status)])
    if (!result.rows[0]) throw new ApiError(404, '商户不存在', 'USER_NOT_FOUND')
    if (number(data.status) !== 1) await auth.revokeUser('main', data.id)
    await repo.audit(null, req.pixAdmin, number(data.status) === 1 ? '启用商户' : '停用商户', result.rows[0].username, req.ip, { type: 'user', id: data.id })
    ok(res, number(data.status) === 1 ? '已启用' : '已停用')
  }))
  router.post('/admin/users/enterprise', asyncRoute(async (req, res) => {
    const data = input(req)
    const result = await repo.query('UPDATE users SET enterprise=$2,updated_at=NOW() WHERE id=$1 RETURNING username', [data.id, Boolean(number(data.enterprise))])
    if (!result.rows[0]) throw new ApiError(404, '商户不存在', 'USER_NOT_FOUND')
    await repo.audit(null, req.pixAdmin, number(data.enterprise) ? '升级企业账号' : '降为个人账号', result.rows[0].username, req.ip, { type: 'user', id: data.id })
    ok(res, number(data.enterprise) ? '已升级为企业账号' : '已降为个人账号')
  }))
  router.post('/admin/users/unbind', asyncRoute(async (req, res) => {
    const data = input(req)
    const table = data.subId ? 'sub_accounts' : 'users'
    const id = data.subId || data.id
    await repo.query(`UPDATE ${table} SET bound_device='',updated_at=NOW() WHERE id=$1`, [id])
    await auth.revokeUser(data.subId ? 'sub' : 'main', id)
    ok(res, '客户端绑定已重置')
  }))
  router.post('/admin/orders/status', asyncRoute(async (req, res) => {
    const data = input(req)
    await repo.query('UPDATE orders SET status=$2,updated_at=NOW() WHERE id=$1', [data.id, number(data.status)])
    ok(res, '工单状态已更新')
  }))
  router.post('/admin/recharges/status',
    stub('admin.recharges.status', '支付结算与回调验签尚未迁移'))
  router.post('/admin/translate/grant', asyncRoute(async (req, res) => {
    const data = input(req)
    const chars = Math.trunc(number(data.chars))
    if (chars <= 0) throw new ApiError(400, '字符数必须大于 0', 'CHARS_REQUIRED')
    const result = await repo.transaction(async client => {
      const found = await repo.query('SELECT * FROM users WHERE id::text=$1 OR username=$1 FOR UPDATE', [String(data.userId || data.username || '')], client)
      const user = mapRow(found.rows[0])
      if (!user) throw new ApiError(404, '商户不存在', 'USER_NOT_FOUND')
      await repo.adjustChars(client, 'main', user.id, chars)
      await repo.query(
        `INSERT INTO recharges(user_id,order_number,kind,payment_type,quantity,chars,
         original_amount,discount_amount,paid_amount,status,idempotency_key,paid_at)
         VALUES($1,$2,'manual',$3,1,$4,$5,0,$5,1,$6,NOW())`,
        [user.id, `CHAR${Date.now()}${crypto.randomInt(100, 999)}`, data.type || '后台赠送',
          chars, Math.max(0, number(data.price)), `admin-grant:${crypto.randomUUID()}`], client
      )
      await repo.audit(client, req.pixAdmin, '调整字符', `${user.username} +${chars}`, req.ip, { type: 'user', id: user.id })
      return user
    })
    ok(res, `已为 ${result.username} 调整 ${chars} 字符`)
  }))
  router.post('/admin/staff/save', asyncRoute(async (req, res) => {
    const data = input(req)
    if (data.id) {
      const hash = data.password ? await auth.hash(data.password) : null
      const result = await repo.query(
        'UPDATE admins SET nickname=COALESCE($2,nickname),password_hash=COALESCE($3,password_hash),role=COALESCE($4,role),updated_at=NOW() WHERE id=$1 RETURNING id',
        [data.id, data.nickname || null, hash, data.role || null]
      )
      if (!result.rows[0]) throw new ApiError(404, '账号不存在', 'ADMIN_NOT_FOUND')
      if (hash) await security.revokeSubject('admin', data.id)
    } else {
      await repo.query(
        `INSERT INTO admins(username,password_hash,nickname,role) VALUES($1,$2,$3,$4)`,
        [data.username, await auth.hash(data.password), data.nickname || data.username, data.role || 'operator']
      )
    }
    ok(res, data.id ? '已更新' : '超管账号已创建')
  }))

  router.post('/admin/users/save', asyncRoute(async (req, res) => {
    const data = input(req)
    const pack = await repo.package(data.versionId || data.packageId)
    if (!pack) throw new ApiError(404, '套餐不存在', 'PACKAGE_NOT_FOUND')
    if (data.id) {
      if (data.charBalance !== undefined && data.charBalance !== '') {
        throw new ApiError(400, '余额只能通过字符调整接口变更', 'USE_CHARACTER_GRANT')
      }
      const passwordHash = data.password ? await auth.hash(data.password) : null
      const result = await repo.query(
        `UPDATE users SET nickname=COALESCE($2,nickname),status=COALESCE($3,status),
         package_id=$4,port_limit=COALESCE($5,port_limit),expires_at=COALESCE($6::timestamptz,expires_at),
         password_hash=COALESCE($7,password_hash),phone=COALESCE($8,phone),remarks=COALESCE($9,remarks),
         enterprise=COALESCE($10,enterprise),sub_quota=COALESCE($11,sub_quota),
         updated_at=NOW() WHERE id=$1 RETURNING username,status`,
        [data.id, data.nickname || null, data.status === undefined ? null : number(data.status),
          pack.id, data.port === undefined ? null : number(data.port),
          data.expireTime || null, passwordHash, data.phone === undefined ? null : (data.phone || null),
          data.remarks === undefined ? null : data.remarks,
          data.enterprise === undefined || data.enterprise === '' ? null : Boolean(number(data.enterprise)),
          data.subQuota === undefined || data.subQuota === '' ? null : number(data.subQuota)]
      )
      if (!result.rows[0]) throw new ApiError(404, '用户不存在', 'USER_NOT_FOUND')
      if (passwordHash || number(result.rows[0].status) !== 1) await auth.revokeUser('main', data.id)
      await repo.audit(null, req.pixAdmin, '编辑商户', result.rows[0].username, req.ip, { type: 'user', id: data.id })
      return ok(res, '用户已更新')
    }
    if (!data.username) throw new ApiError(400, '请填写账号', 'USERNAME_REQUIRED')
    const settings = await repo.settings()
    const gift = data.charBalance === undefined || data.charBalance === ''
      ? number(settings['registration.trial_chars'])
      : number(data.charBalance)
    await repo.transaction(async client => {
      const created = await repo.query(
        `INSERT INTO users(username,password_hash,nickname,status,package_id,port_limit,expires_at,
         char_balance,auto_reply,phone,remarks,active_engine_id,enterprise,email,sub_quota)
         VALUES($1,$2,$3,1,$4,$5,COALESCE($6::timestamptz,NOW()+interval '30 days'),
          $7,$8,$9,$10,$11,$12,$13,$14) RETURNING id,username`,
        [String(data.username).trim(), await auth.hash(data.password), data.nickname || data.username,
          pack.id, number(data.port, number(pack.portLimit)), data.expireTime || null, gift,
          Boolean(number(data.autoReply)), data.phone || null, data.remarks || '',
          String(settings['translation.active_engine'] || 'youdao'), Boolean(number(data.enterprise)),
          data.email ? String(data.email).toLowerCase() : null, number(data.subQuota)], client
      )
      if (gift) {
        await repo.query(
          `INSERT INTO recharges(user_id,package_id,order_number,kind,payment_type,quantity,chars,
           original_amount,discount_amount,paid_amount,status,idempotency_key,paid_at)
           VALUES($1,$2,$3,'manual','试用赠送',1,$4,0,0,0,1,$5,NOW())`,
          [created.rows[0].id, pack.id, `TRIAL${Date.now()}`, gift, `trial:${crypto.randomUUID()}`], client
        )
      }
      await repo.audit(client, req.pixAdmin, '新建商户', created.rows[0].username, req.ip, { type: 'user', id: created.rows[0].id })
    })
    ok(res, gift ? `用户已创建，已赠送试用 ${gift} 字符` : '用户已创建')
  }))
  router.get('/admin/clients', asyncRoute(async (req, res) => {
    const paging = pagination(req)
    const result = await core.listClientReleases(input(req), paging)
    res.json(Object.assign(page(result.rows, result.total, paging), {
      groups: result.groups,
      standaloneApps: result.standaloneApps
    }))
  }))
  router.post('/admin/clients/save', asyncRoute(async (req, res) => {
    const result = await core.saveClientRelease(input(req))
    await repo.audit(null, req.pixAdmin, result.updated ? '编辑客户端版本' : '新增客户端版本', String(result.id), req.ip, {
      type: 'client', id: result.id
    })
    ok(res, result.updated ? '客户端版本已更新' : '客户端版本已创建', { id: result.id })
  }))
  // ---- 翻译通道管理（后台「翻译通道」页）--------------------------------------
  // 密钥走 engines.api_key_ciphertext / secret_ciphertext，AES-256-GCM 加密落盘；
  // 列表只回"是否已填"，永不回密钥本体。
  async function activeEngineId() {
    const row = (await repo.query("SELECT value FROM app_settings WHERE key='translation.active_engine'")).rows[0]
    return row && row.value ? String(row.value) : ''
  }

  router.get('/admin/engines', asyncRoute(async (_req, res) => {
    const rows = await repo.enginesForAdmin()
    const active = await activeEngineId()
    const credentials = {}
    for (const row of rows) credentials[row.id] = await repo.engineCredentials(row.id)
    const readiness = channelStatus(credentials).reduce((out, item) => {
      out[item.id] = item.credentialReady
      return out
    }, {})
    const packages = await repo.packages()
    res.json({
      data: {
        rows: rows.map(row => ({
          id: row.id,
          name: row.name,
          provider: row.provider,
          tier: row.tier,
          costPerMillion: Number(row.costPerMillion || 0),
          model: row.model || '',
          endpoint: row.endpoint || '',
          note: row.note || '',
          enabled: Boolean(row.enabled),
          wired: Boolean(row.wired),
          // 只暴露"够不够用"，不暴露密钥本身
          hasKey: Boolean(row.hasKey || row.hasSecret),
          credentialReady: Boolean(readiness[row.id]),
          wiredText: row.wired ? '已接通' : (Boolean(row.enabled) ? '未接通（缺凭据或未实现）' : '未启用'),
          active: row.id === active
        })),
        activeEngine: active,
        credentialsKeyReady: credentialsKeyReady(),
        packageBill: packages
          .map(item => `${item.title} ¥${Number(item.price || 0)}/${Math.round(Number(item.chars || 0) / 10000)}万`)
          .join(' · ')
      }
    })
  }))

  router.post('/admin/engines/save', asyncRoute(async (req, res) => {
    const data = input(req)
    const id = String(data.id || '').trim()
    const engine = await repo.engineById(id)
    if (!engine) throw new ApiError(404, '通道不存在', 'ENGINE_NOT_FOUND')

    const endpoint = String(data.endpoint || '').trim()
    if (endpoint && !/^https:\/\//.test(endpoint)) {
      throw new ApiError(400, '接口地址必须是 https:// 开头', 'BAD_ENDPOINT')
    }

    // 密钥非空才更新；留空表示保持原值（前端占位符就是这么写的）
    const apiKey = String(data.apiKey || '').trim()
    const secret = String(data.secret || '').trim()
    if ((apiKey || secret) && !credentialsKeyReady()) {
      throw new ApiError(503, `服务端未配置 ${KEY_ENV}，拒绝保存厂商密钥`, 'CREDENTIAL_KEY_MISSING')
    }

    const existing = await repo.engineCredentials(id)
    const effective = {
      apiKey: apiKey || existing.apiKey,
      secret: secret || existing.secret
    }
    const enabled = Boolean(Number(data.enabled))
    const adapter = providers[id]
    const ready = Boolean(adapter && adapter.configured(effective))
    // wired 不让人手填：适配器实现 + 凭据齐备才允许接通，与 CLI 脚本同一把尺子
    const wired = enabled && ready

    await repo.query(
      `UPDATE engines SET enabled=$2, wired=$3, cost_per_million=$4, model=$5, endpoint=$6, note=$7,
              api_key_ciphertext=COALESCE($8, api_key_ciphertext),
              secret_ciphertext=COALESCE($9, secret_ciphertext),
              updated_at=NOW()
       WHERE id=$1`,
      [id, enabled, wired,
        Math.max(0, Number(data.costPerMillion) || 0),
        String(data.model || '').trim() || null,
        endpoint || null,
        String(data.note || '').slice(0, 1000),
        apiKey ? encryptSecret(apiKey) : null,
        secret ? encryptSecret(secret) : null]
    )
    await repo.audit(null, req.pixAdmin, '配置翻译通道', `${engine.name}: enabled=${enabled} wired=${wired}`, req.ip, {
      type: 'engine', id
    })
    ok(res, wired ? `${engine.name} 已接通` : `${engine.name} 已保存（未接通：${adapter ? '凭据未就绪' : '适配器未实现'}）`)
  }))

  router.post('/admin/engines/active', asyncRoute(async (req, res) => {
    const id = String(input(req).id || '').trim()
    const engine = await repo.engineById(id)
    if (!engine) throw new ApiError(404, '通道不存在', 'ENGINE_NOT_FOUND')
    if (!engine.enabled) throw new ApiError(400, '该通道未启用，不能设为默认', 'ENGINE_DISABLED')
    await repo.query(
      `INSERT INTO app_settings(key,value,description) VALUES('translation.active_engine',to_jsonb($1::text),'默认翻译引擎')
       ON CONFLICT (key) DO UPDATE SET value=to_jsonb($1::text)`,
      [id]
    )
    await repo.audit(null, req.pixAdmin, '设置默认翻译通道', engine.name, req.ip, { type: 'engine', id })
    ok(res, `默认通道已设为 ${engine.name}`)
  }))

  // ---- 套餐管理（后台「套餐管理」页）------------------------------------------
  async function packagesWithEngines() {
    const rows = await repo.packages()
    const links = await repo.query('SELECT package_id, engine_id FROM package_engines ORDER BY engine_id')
    const byPackage = {}
    for (const link of links.rows) {
      const key = String(link.package_id)
      if (!byPackage[key]) byPackage[key] = []
      byPackage[key].push(link.engine_id)
    }
    return rows.map(row => Object.assign(row, { engines: byPackage[String(row.id)] || [] }))
  }

  router.get('/admin/packages', asyncRoute(async (_req, res) => {
    res.json({ success: 'success', data: await packagesWithEngines() })
  }))

  router.post('/admin/packages/save', asyncRoute(async (req, res) => {
    const data = input(req)
    const safeParse = value => {
      try {
        return JSON.parse(value)
      } catch (error) {
        throw new ApiError(400, '提交的数据不是合法 JSON', 'BAD_JSON')
      }
    }
    const parseJson = (value, fallback, kind) => {
      if (value === undefined || value === null || value === '') return fallback
      const parsed = typeof value === 'string' ? safeParse(value) : value
      if (kind === 'array' && !Array.isArray(parsed)) throw new ApiError(400, '通道列表必须是数组', 'BAD_PACKAGE_ENGINES')
      if (kind === 'object' && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
        throw new ApiError(400, '权益配置必须是对象', 'BAD_PACKAGE_FEATURES')
      }
      return parsed
    }

    const code = String(data.code || '').trim().toLowerCase()
    const title = String(data.title || '').trim()
    if (!title) throw new ApiError(400, '套餐名称不能为空', 'PACKAGE_TITLE_REQUIRED')
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(code)) {
      throw new ApiError(400, '套餐标识必须是 2-64 位小写字母/数字/下划线/横线，且以字母开头', 'BAD_PACKAGE_CODE')
    }
    const engineIds = parseJson(data.engines, [], 'array').map(id => String(id))
    if (engineIds.length) {
      const found = await repo.query('SELECT id FROM engines WHERE id = ANY($1::text[])', [engineIds])
      const known = new Set(found.rows.map(row => row.id))
      const unknown = engineIds.filter(id => !known.has(id))
      if (unknown.length) throw new ApiError(400, `未知通道: ${unknown.join(', ')}`, 'ENGINE_NOT_FOUND')
    }

    const price = Math.max(0, Number(data.price) || 0)
    const chars = Math.max(0, Math.floor(Number(data.chars || data.includedChars) || 0))
    const portLimit = Math.max(0, Math.floor(Number(data.port || data.portLimit) || 0))
    const fields = {
      title,
      subtitle: String(data.subtitle || '').slice(0, 300),
      portLimit,
      portUnlimited: data.portUnlimited === undefined ? true : Boolean(Number(data.portUnlimited)),
      chars,
      price,
      clients: parseJson(data.clients, {}, 'object'),
      features: parseJson(data.features, {}, 'object'),
      sortOrder: Math.max(0, Math.floor(Number(data.sortOrder) || 0))
    }

    const saved = await repo.transaction(async client => {
      let packageId = data.id ? Number(data.id) : null
      if (packageId) {
        const updated = await repo.query(
          `UPDATE packages SET title=$2,subtitle=$3,port_limit=$4,port_unlimited=$5,included_chars=$6,
                  price=$7,clients=$8::jsonb,features=$9::jsonb,sort_order=$10,updated_at=NOW()
           WHERE id=$1 RETURNING id`,
          [packageId, fields.title, fields.subtitle, fields.portLimit, fields.portUnlimited,
            fields.chars, fields.price, JSON.stringify(fields.clients), JSON.stringify(fields.features),
            fields.sortOrder], client
        )
        if (!updated.rows[0]) throw new ApiError(404, '套餐不存在', 'PACKAGE_NOT_FOUND')
      } else {
        const inserted = await repo.query(
          `INSERT INTO packages(code,title,subtitle,port_limit,port_unlimited,included_chars,price,clients,features,sort_order)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10) RETURNING id`,
          [code, fields.title, fields.subtitle, fields.portLimit, fields.portUnlimited,
            fields.chars, fields.price, JSON.stringify(fields.clients), JSON.stringify(fields.features),
            fields.sortOrder], client
        )
        packageId = inserted.rows[0].id
      }
      await repo.query('DELETE FROM package_engines WHERE package_id=$1', [packageId], client)
      if (engineIds.length) {
        await repo.query(
          `INSERT INTO package_engines(package_id,engine_id)
           SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
          [packageId, engineIds], client
        )
      }
      await repo.audit(client, req.pixAdmin, data.id ? '编辑套餐' : '新建套餐',
        `${fields.title}（${engineIds.length} 个通道）`, req.ip, { type: 'package', id: packageId })
      return packageId
    })
    ok(res, data.id ? '套餐已更新' : '套餐已创建', { id: saved })
  }))

  // ---- 系统设置（后台「系统设置」「客服支持」两页共用）--------------------------
  const SETTING_KEYS = {
    siteName: 'site.name',
    announcement: 'site.announcement',
    clientDownloadUrl: 'downloads.client_url',
    officialUrl: 'links.official_url',
    guideUrl: 'links.guide_url',
    trialChars: 'registration.trial_chars',
    lines: 'service.lines',
    telegram: 'support.telegram',
    telegramUrl: 'support.telegram_url',
    supportNote: 'support.note',
    supportBtnText: 'support.button_text',
    supportShow: 'support.visible',
    notices: 'site.notices'
  }

  async function readSettings() {
    const rows = (await repo.query('SELECT key,value FROM app_settings')).rows
    const byKey = rows.reduce((out, row) => { out[row.key] = row.value; return out }, {})
    const discounts = byKey['billing.discounts'] || {}
    return {
      siteName: byKey['site.name'] || '',
      announcement: byKey['site.announcement'] || '',
      clientDownloadUrl: byKey['downloads.client_url'] || '',
      officialUrl: byKey['links.official_url'] || '',
      guideUrl: byKey['links.guide_url'] || '',
      trialChars: Number(byKey['registration.trial_chars'] || 0),
      discount1: Number(discounts['1'] || 0.9),
      discount10: Number(discounts['10'] || 0.8),
      discount50: Number(discounts['50'] || 0.75),
      telegram: byKey['support.telegram'] || '',
      telegramUrl: byKey['support.telegram_url'] || '',
      supportNote: byKey['support.note'] || '',
      supportBtnText: byKey['support.button_text'] || '联系客服',
      supportShow: byKey['support.visible'] === false ? 0 : 1,
      notices: Array.isArray(byKey['site.notices']) ? byKey['site.notices'] : [],
      lines: Array.isArray(byKey['service.lines']) ? byKey['service.lines'] : []
    }
  }

  router.get('/admin/settings', asyncRoute(async (_req, res) => {
    res.json({ success: 'success', data: await readSettings() })
  }))

  router.post('/admin/settings/save', asyncRoute(async (req, res) => {
    const data = input(req)
    const httpsOrLoopback = value => {
      const text = String(value || '').trim()
      if (!text) return true
      if (/^https:\/\//.test(text)) return true
      // 与客户端 validateApiUrl 同一策略：只放行本机回环的 http，方便本地联调
      return /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/.test(text)
    }
    const updates = []
    for (const [field, key] of Object.entries(SETTING_KEYS)) {
      if (data[field] === undefined) continue // 两页各自提交子集，缺省即不动
      let value = data[field]
      if (field === 'trialChars') value = Math.max(0, Math.floor(Number(value) || 0))
      if (field === 'supportShow') value = Number(value) ? true : false
      if (field === 'notices') {
        const parsed = typeof value === 'string' ? safeParse(value) : value
        if (!Array.isArray(parsed)) throw new ApiError(400, '公告必须是数组', 'BAD_NOTICES')
        const gone = Array.isArray(data.goneNoticeIds) ? data.goneNoticeIds.map(String) : []
        value = parsed
          .filter(item => item && item.title !== undefined)
          .filter(item => !gone.includes(String(item.id)))
          .slice(0, 200)
          .map((item, index) => ({
            id: item.id ? String(item.id) : `n${Date.now()}${index}`,
            title: String(item.title || '').slice(0, 200),
            content: String(item.content || '').slice(0, 5000),
            enabled: Number(item.enabled) ? 1 : 0,
            createTime: String(item.createTime || new Date().toISOString().slice(0, 19).replace('T', ' '))
          }))
      }
      if (field === 'lines') {
        const parsed = typeof value === 'string' ? safeParse(value) : value
        if (!Array.isArray(parsed)) throw new ApiError(400, '线路必须是数组', 'BAD_LINES')
        value = parsed.map((line, index) => {
          const url = String(line.url || '').trim()
          if (!httpsOrLoopback(url)) {
            throw new ApiError(400, `第 ${index + 1} 条线路地址必须是 https://（本机回环可 http）`, 'BAD_LINE_URL')
          }
          return {
            id: line.id ? Number(line.id) : index + 1,
            name: String(line.name || '').trim() || `线路${index + 1}`,
            url,
            region: String(line.region || '').trim(),
            enabled: Number(line.enabled) ? 1 : 0
          }
        })
      }
      if (['clientDownloadUrl', 'officialUrl', 'guideUrl', 'telegramUrl'].includes(field)) {
        const text = String(value || '').trim()
        if (text && !/^https:\/\//.test(text)) {
          throw new ApiError(400, `${field} 必须是 https:// 地址`, 'BAD_SETTING_URL')
        }
      }
      updates.push([key, JSON.stringify(value)])
    }
    const discounts = ['discount1', 'discount10', 'discount50'].filter(field => data[field] !== undefined)
    if (discounts.length) {
      const current = await readSettings()
      const pick = (field, fallback) => {
        const value = Number(data[field] === undefined ? fallback : data[field])
        if (!Number.isFinite(value) || value <= 0 || value > 1) {
          throw new ApiError(400, '折扣必须在 0 与 1 之间', 'BAD_DISCOUNT')
        }
        return value
      }
      updates.push(['billing.discounts', JSON.stringify({
        1: pick('discount1', current.discount1),
        10: pick('discount10', current.discount10),
        50: pick('discount50', current.discount50)
      })])
    }
    if (!updates.length) throw new ApiError(400, '没有需要保存的设置项', 'NOTHING_TO_SAVE')

    await repo.transaction(async client => {
      for (const [key, value] of updates) {
        await repo.query(
          `INSERT INTO app_settings(key,value,description) VALUES($1,$2::jsonb,$3)
           ON CONFLICT (key) DO UPDATE SET value=$2::jsonb`,
          [key, value, key], client
        )
      }
      await repo.audit(client, req.pixAdmin, '修改系统设置', updates.map(item => item[0]).join(','), req.ip, { type: 'settings' })
    })
    ok(res, '设置已保存')
  }))


  // ---- 验证码接口配置（后台「验证配置」页）------------------------------------
  // 真实发信/发短信尚未迁移，因此这里只保存配置，wired 恒为 false ——
  // 页面如实显示"未接通"，绝不假装可用。
  const VERIFY_DEFAULTS = [
    { id: 'email', name: '邮箱验证码', kind: '邮箱', provider: 'local', revealDemo: 0,
      resendSeconds: 60, expireMin: 10, digits: 6, note: 'SMTP 未接入，仅本地演示；生产环境注册/找回仍返回 503' },
    { id: 'sms', name: '短信验证码', kind: '短信', provider: 'local', revealDemo: 0,
      resendSeconds: 60, expireMin: 5, digits: 6, note: '短信通道未接入，保留配置位' }
  ]

  router.get('/admin/verify', asyncRoute(async (_req, res) => {
    const row = (await repo.query("SELECT value FROM app_settings WHERE key='verify.channels'")).rows[0]
    const saved = row && Array.isArray(row.value) ? row.value : []
    const byId = saved.reduce((out, item) => { if (item && item.id) out[item.id] = item; return out }, {})
    const rows = VERIFY_DEFAULTS.map(item => {
      const merged = Object.assign({}, item, byId[item.id] || {})
      return Object.assign(merged, {
        providerName: merged.provider === 'smtp' ? 'SMTP（未接入）' : '本地演示（不发信）',
        // 没有任何一条真实发信通道，接口状态如实为"未接通"
        wired: false,
        wiredText: '未接通',
        hasKey: false
      })
    })
    res.json({ data: { rows, smtpReady: false, note: '邮件/短信服务尚未迁移，注册与找回密码接口保持 503' } })
  }))

  router.post('/admin/verify/save', asyncRoute(async (req, res) => {
    const data = input(req)
    const id = String(data.id || '').trim()
    if (!VERIFY_DEFAULTS.some(item => item.id === id)) {
      throw new ApiError(404, '验证通道不存在', 'VERIFY_CHANNEL_NOT_FOUND')
    }
    const row = (await repo.query("SELECT value FROM app_settings WHERE key='verify.channels'")).rows[0]
    const saved = row && Array.isArray(row.value) ? row.value.slice() : []
    const entry = {
      id,
      provider: String(data.provider || 'local').slice(0, 30),
      revealDemo: Number(data.revealDemo) ? 1 : 0,
      resendSeconds: Math.min(300, Math.max(10, Math.floor(Number(data.resendSeconds) || 60))),
      expireMin: Math.min(60, Math.max(1, Math.floor(Number(data.expireMin) || 10))),
      digits: Math.min(8, Math.max(4, Math.floor(Number(data.digits) || 6)))
    }
    const index = saved.findIndex(item => item && item.id === id)
    if (index >= 0) saved[index] = entry
    else saved.push(entry)
    await repo.query(
      `INSERT INTO app_settings(key,value,description) VALUES('verify.channels',$1::jsonb,'验证码通道配置')
       ON CONFLICT (key) DO UPDATE SET value=$1::jsonb`,
      [JSON.stringify(saved)]
    )
    await repo.audit(null, req.pixAdmin, '配置验证码通道', JSON.stringify(entry), req.ip, { type: 'verify', id })
    ok(res, '已保存（真实发信通道未接入，暂不生效）')
  }))

  router.post('/user/register', stub('user.register', '注册依赖验证码及邮件服务迁移'))
  router.post('/user/forgot', stub('user.forgot', '找回密码依赖验证码及邮件服务迁移'))
  router.post('/user/emailCode', stub('user.emailCode', '邮件发送服务尚未迁移'))

  const unmigrated = [
    '/order/setDistributionMode', '/order/cancelAccount', '/order/resetOrder',
    '/order/getAssistantGroupByUserId',
    '/orderDetails/getOrderDetails', '/orderDetails/updateRemarks', '/orderDetails/deleteOrderDetails',
    '/orderDetails/unbindPort', '/orderDetails/setDistribution', '/orderDetails/resetOrderDetails',
    '/orderDetails/jump', '/userLogin/getUserLogin',
    '/orderTarget/getOrderTarget', '/shortLink/getShortLink', '/shortLink/getShortLinkInfo',
    '/shortLink/editShortLink', '/shortLink/deleteShortLink', '/shortLink/addShortLink',
    '/assistant/getAssistantGroup', '/assistant/getAssistantDetails', '/assistant/deleteAssistantDetails',
    '/assistant/deleteAssistantGroup', '/assistant/selectAssistantGroupById', '/assistant/editAssistant',
    '/assistant/editAssistantGroup', '/weixin/weixinPay', '/weixin/checkStatus', '/zfb/alipay',
    '/admin/accounts', '/admin/fans', '/admin/links',
    '/admin/scripts',
    '/admin/faqs', '/admin/faqs/save',
    '/admin/notices', '/admin/notices/save', '/admin/notices/delete'
  ]
  unmigrated.forEach(path => router.all(path, stub(path.slice(1), '该兼容模块尚未迁移到 PostgreSQL')))
  router.all(/^\/export2?\//, stub('export', '正式导出任务与对象存储尚未迁移'))

  router.use((_req, res) => res.status(404).json({ success: false, code: 'API_NOT_FOUND', msg: '接口不存在' }))
  return router
}

module.exports = { productionRouter }
