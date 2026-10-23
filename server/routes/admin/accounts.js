'use strict'

/**
 * 后台 · 商户管理：建号、改档、停用、改密、续期、回收、删除、子账号。
 *
 * 这些是**写操作**，读列表在 dashboard.js。
 * 拆开是因为两者改动的风险等级完全不同：
 * 列表读错最多显示错了，这里写错会动到钱和权益。
 */

const crypto = require('crypto')
const { asyncRoute, input, ok, ApiError, toggle } = require('../../lib/http')
const { mapRow, mapRows } = require('../../repositories/production-repository')
const { number, bool } = require('../../services/core-service')
const { STATUS: RECHARGE_STATUS, assertTransition } = require('../../services/recharge-state')
const purge = require('../../lib/merchant-purge')
const { saveStaff } = require('../../services/staff-service')

function registerAdminUsers(router, ctx) {
  const { repo, auth, security } = ctx
  const { rechargeAmount, rechargeEntitlement, adminAccounts } = ctx.services


  router.get('/admin/staff', asyncRoute(async (_req, res) => {
    const result = await repo.query('SELECT id,username,nickname,role FROM admins ORDER BY id')
    res.json(mapRows(result.rows))
  }))

  router.post('/admin/users/status', asyncRoute(async (req, res) => {
    const data = input(req)
    // 同 production.js 的 parseSubStatus：'': Number('') = 0 = 停用。
    // 这里传一个漏字段的请求就能把商户停掉，还回你"已停用"，毫无破绽。
    const status = toggle(data.status)
    if (status === null) throw new ApiError(400, '状态只能是 0 或 1', 'BAD_STATUS')
    const result = await repo.query('UPDATE users SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING username', [data.id, status])
    if (!result.rows[0]) throw new ApiError(404, '商户不存在', 'USER_NOT_FOUND')
    if (status !== 1) await auth.revokeUser('main', data.id)
    await repo.audit(null, req.pixAdmin, status === 1 ? '启用商户' : '停用商户', result.rows[0].username, req.ip, { type: 'user', id: data.id })
    ok(res, status === 1 ? '已启用' : '已停用')
  }))

  router.post('/admin/users/resetPassword', asyncRoute(async (req, res) => {
    const data = input(req)
    const userId = number(data.id || data.userId)
    if (!userId) throw new ApiError(400, '缺少商户 id', 'USER_ID_REQUIRED')
    // auth.hash 内部走 validPassword，不合规会抛 WEAK_PASSWORD，文案已放宽到 6 位
    const passwordHash = await auth.hash(data.password)
    const result = await repo.query(
      'UPDATE users SET password_hash=$2,updated_at=NOW() WHERE id=$1 RETURNING username',
      [userId, passwordHash]
    )
    if (!result.rows[0]) throw new ApiError(404, '商户不存在', 'USER_NOT_FOUND')
    // 改密码后必须踢掉所有旧会话 —— 否则"重置"防不住已经登录的旧会话
    await auth.revokeUser('main', userId)
    await repo.audit(null, req.pixAdmin, '重置商户密码', result.rows[0].username, req.ip,
      { type: 'user', id: userId })
    ok(res, '密码已重置')
  }))

  router.post('/admin/users/expiry', asyncRoute(async (req, res) => {
    const data = input(req)
    const userId = number(data.id || data.userId)
    if (!userId) throw new ApiError(400, '缺少商户 id', 'USER_ID_REQUIRED')
    const result = await repo.query(
      'UPDATE users SET expires_at=NULL,updated_at=NOW() WHERE id=$1 RETURNING username',
      [userId]
    )
    if (!result.rows[0]) throw new ApiError(404, '商户不存在', 'USER_NOT_FOUND')
    // 不清会话：清到期时间是**放宽**限制，不是收紧；被过期时间挡在外面的
    // 会话在下一个请求就会通过（auth-service.resolve 每次都重新比对 expires_at），
    // 这里再 revoke 一次只会把人无谓地踢下线。
    //
    // ⚠️ 2026-10 补记：上面那句注释一度是**假的** —— resolve() 当时只校验 status，
    // 到期只在登录那一次判断，所以"清掉到期时间"对已经登录的会话毫无作用。
    // 现在 resolve() 真的每次都比对，注释与实现才一致。别再把这句话当免检声明。
    await repo.audit(null, req.pixAdmin, '设为无限期', result.rows[0].username, req.ip,
      { type: 'user', id: userId })
    ok(res, `${result.rows[0].username} 已设为无限期`)
  }))

  router.post('/admin/users/enterprise', asyncRoute(async (req, res) => {
    const data = input(req)
    // 解析一次、用到底。原先 SQL 与审计/提示各自算一遍 `number(...)`，
    // 遇到字符串 "true" 时 SQL 判成 false、而这里同样是 false，
    // 于是"已降为个人账号"的提示与库里的实际值可能对不上 —— 必须先定值再写。
    const enterprise = bool(data.enterprise) === true
    const result = await repo.query('UPDATE users SET enterprise=$2,updated_at=NOW() WHERE id=$1 RETURNING username', [data.id, enterprise])
    if (!result.rows[0]) throw new ApiError(404, '商户不存在', 'USER_NOT_FOUND')
    await repo.audit(null, req.pixAdmin, enterprise ? '升级企业账号' : '降为个人账号', result.rows[0].username, req.ip, { type: 'user', id: data.id })
    ok(res, enterprise ? '已升级为企业账号' : '已降为个人账号')
  }))

  router.post('/admin/users/unbind', asyncRoute(async (req, res) => {
    const data = input(req)
    const table = data.subId ? 'sub_accounts' : 'users'
    const id = data.subId || data.id
    const result = await repo.query(
      `UPDATE ${table} SET bound_device='',updated_at=NOW() WHERE id=$1 RETURNING id`, [id])
    // 没命中就是没这个人：不能回一句"已重置"让超管以为搞定了。
    // 顺带把 kind 的判定和 SQL 绑在同一处 —— 原先 UPDATE 用 `data.subId ?`、
    // 撤销会话又用 `data.subId ?` 各算一次，只要两边判据哪天不一致，
    // 就会出现"重置的是子账号、踢的却是主账号"这种踢错人的事故。
    if (!result.rows[0]) throw new ApiError(404, '账号不存在', 'USER_NOT_FOUND')
    await auth.revokeUser(data.subId ? 'sub' : 'main', id)
    ok(res, '客户端绑定已重置')
  }))

  router.post('/admin/users/reclaim', asyncRoute(async (req, res) => {
    const data = input(req)
    const result = await purge.reclaimChars({
      repo, admin: req.pixAdmin, ip: req.ip, id: data.id, note: data.note
    })
    ok(res, result.reclaimed > 0
      ? `已回收 ${result.reclaimed} 字符，${result.username} 余额归零（已记入字符流水）`
      : `${result.username} 余额本就是 0，无需回收`)
  }))

  router.post('/admin/users/delete', asyncRoute(async (req, res) => {
    const data = input(req)
    const result = await purge.deleteMerchant({
      repo,
      admin: req.pixAdmin,
      ip: req.ip,
      id: data.id,
      confirmUsername: data.confirmUsername,
      acknowledge: data.acknowledge,
      reason: data.reason
    })
    // 账号行已经不存在了，但 Redis 里的会话还没清。
    // 撤销要放在提交之后：事务里撤销了却回滚，等于白撤。
    await auth.revokeUser('main', result.userId)
    const cleared = purge.describeRemoved(result.removed)
    ok(res, `已删除商户 ${result.username}`
      + (cleared.length ? `，一并清除 ${cleared.join('、')}` : '')
      + `；字符余额 ${result.charBalance} 随账号清除，已存档`)
  }))

  router.post('/admin/recharges/status', asyncRoute(async (req, res) => {
    const data = input(req)
    const id = number(data.id)
    if (!id) throw new ApiError(400, '缺少订单 ID', 'ORDER_ID_REQUIRED')
    const txId = String(data.providerTransactionId || data.txId || '').trim().slice(0, 160)

    const result = await repo.transaction(async client => {
      const found = await repo.query('SELECT * FROM recharges WHERE id=$1 FOR UPDATE', [id], client)
      const order = mapRow(found.rows[0])
      if (!order) throw new ApiError(404, '订单不存在', 'RECHARGE_NOT_FOUND')

      if (Number(order.status) === RECHARGE_STATUS.PAID) {
        // 已经确认过了：不重复加字符，也不报错（运维可能重复点了或刷新后重提）
        return { order, alreadyPaid: true }
      }
      // 状态机把关：pending(0) 与 exception(4) 可以入账；
      // expired(2) / cancelled(3) 是终态，不能直接改成已支付 ——
      // 过期后收到的钱走异常池，而不是把历史改写成"没过期"。
      assertTransition(Number(order.status), RECHARGE_STATUS.PAID)

      // 链上交易号重复 = 同一笔钱想充两次，交给唯一索引拦下并给出明确文案
      if (txId) {
        const dup = await repo.query(
          'SELECT order_number FROM recharges WHERE payment_type=$1 AND provider_transaction_id=$2 AND id<>$3',
          [order.paymentType, txId, id], client
        )
        if (dup.rows[0]) {
          throw new ApiError(409, `该交易号已用于订单 ${dup.rows[0].orderNumber}，不能重复充值`, 'TX_ALREADY_USED')
        }
      }

      await repo.adjustChars(client, 'main', order.userId, Number(order.chars))
      // terminal_at 必须一起写：021 的 recharges_terminal_consistency_check
      // 要求「非 pending 一定有终态时间」，只改 status 会被约束直接拒绝
      await repo.query(
        `UPDATE recharges
            SET status=$2::smallint, paid_at=NOW(),
                terminal_at=NOW(), terminal_reason='settled',
                provider_transaction_id=COALESCE(NULLIF($3,''),provider_transaction_id),
                updated_at=NOW()
          WHERE id=$1`,
        [id, RECHARGE_STATUS.PAID, txId], client
      )
      // 订单进终态 → 金额进入 24 小时保护期，防止迟到款错配到新订单
      await rechargeAmount.extendProtection(client, found.rows[0].amount_reservation_id, new Date())
      // 套餐权益落地。**手工确认与链上自动入账必须发同样的东西**：
      // 只加字符不发套餐的话，商户端首页「套餐」空白、通道权益为空、
      // 子账号额度还是 0 —— 表现就是"充了钱但什么都没生效"。
      // 非套餐订单（纯字符充值 / 后台赠送）在这里是 no-op。
      const entitlement = await rechargeEntitlement.grantFromOrder(client, order, { at: new Date() })
      await repo.audit(client, req.pixAdmin, '确认收款',
        `${order.orderNumber} +${order.chars} 字符${txId ? ' tx:' + txId : ''}`
        + (entitlement.granted
          ? `；套餐「${entitlement.packageTitle}」×${entitlement.months} 个月已发放，子账号额度 ${entitlement.subQuota}`
          : ''),
        req.ip, { type: 'user', id: order.userId })
      return { order, alreadyPaid: false, entitlement }
    })

    const grantedText = result.entitlement && result.entitlement.granted
      ? `，套餐已发放（子账号额度 ${result.entitlement.subQuota} 个）`
      : ''
    ok(res, result.alreadyPaid
      ? `订单 ${result.order.orderNumber} 此前已确认，未重复加字符`
      : `已确认收款，${result.order.chars} 字符已到账${grantedText}`)
  }))

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
    // 规则全部在 services/staff-service.js，这里只做收发。
    //
    // ★ 为什么把这一段抽走 ★
    //
    // 原本是 `INSERT ... role=$4`，$4 来自 `data.role || 'operator'` ——
    // role 完全由客户端决定，只靠数据库 CHECK 兜着。CHECK 只保证
    // "是这 4 个字面量之一"，不保证"该不该给这个角色"。
    //
    // 2026-10-23 入侵者正是靠这条建了两个后门超管。那一轮补的是
    // "二次认证 + 审计"，这次补的是第三条：**凭什么是超管**。
    // 现在有四条铁律：角色白名单、必须有第二个超管才能动自己、
    // 不能把超管数量抹到 0、新建必留审计。细节见服务文件头。
    const data = input(req)
    const result = await saveStaff({ repo, auth, security }, data, req.pixAdmin, req.ip)
    ok(res, result.created
      ? `超管账号 ${result.username} 已创建（${result.role}）`
      : '已更新')
  }))

  router.post('/admin/users/save', asyncRoute(async (req, res) => {
    // 两条路径（编辑 / 新建）都在 services/admin-account-service.js。
    // 这条路由原本 141 行，每条规则背后都有一次线上事故，挤在一起没法读。
    const data = input(req)
    if (data.id) {
      await adminAccounts.update(data, req.pixAdmin, req.ip)
      return ok(res, '用户已更新')
    }
    const { gift } = await adminAccounts.create(data, req.pixAdmin, req.ip)
    ok(res, gift ? `用户已创建，已赠送试用 ${gift} 字符` : '用户已创建')
  }))

}

module.exports = { registerAdminUsers }

/** 本文件包含的路由（仅供文档与调试参考）
 *   GET   /admin/staff
 *   POST  /admin/users/status
 *   POST  /admin/users/resetPassword
 *   POST  /admin/users/expiry
 *   POST  /admin/users/enterprise
 *   POST  /admin/users/unbind
 *   POST  /admin/users/reclaim
 *   POST  /admin/users/delete
 *   POST  /admin/recharges/status
 *   POST  /admin/translate/grant
 *   POST  /admin/staff/save
 *   POST  /admin/users/save
 */
