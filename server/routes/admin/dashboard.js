'use strict'

/**
 * 后台 · 看板：统计、商户/子账号/充值列表、异常池、各类日志。
 *
 * 注意：`/admin/users` 这类**列表**路由在这里，而
 * `/admin/users/save` 这类**写操作**在 accounts.js ——
 * 按"读 / 写"分域，不是按路径前缀。
 */

const { asyncRoute, input, ok, ApiError, pagination, page } = require('../../lib/http')
const { mapRows } = require('../../repositories/production-repository')
const { effectiveStatusSql } = require('../../services/recharge-state')
const { adminJoinedList } = require('./shared')

function registerAdminDashboard(router, ctx) {
  const { repo, core } = ctx
  const { dashboardStats } = ctx.services
  const { rechargeException } = ctx.services


  /**
   * 超管总览。
   *
   * 口径（哪些数字算"商户"、进粉怎么数、毛利怎么算）全在
   * services/dashboard-stats-service.js —— 这里只做一层壳，
   * 加指标不用改路由文件。
   */
  router.get('/admin/stats', asyncRoute(async (_req, res) => {
    res.json(await dashboardStats.overview())
  }))

  router.get('/admin/users', asyncRoute((req, res) => adminJoinedList(repo, req, res, {
    from: 'users u LEFT JOIN packages p ON p.id=u.package_id',
    select: `u.id,u.username,u.nickname,u.email,u.phone,u.status,u.package_id AS version_id,
      p.title AS basename,u.package_catalog_version,u.char_balance,u.char_used,u.translate_count,u.sub_quota,u.auto_alloc_master,
      u.auto_reply,u.enterprise,u.port_limit AS port,u.ports_in_use AS user_ports,u.bound_device,
      u.expires_at AS expire_time,u.remarks,u.created_at AS create_time,
      -- 子账号数必须是**真计数**。
      -- 这个字段原先只存在于 mock 的 enrichUser 里，真后端 SELECT 从来没查过，
      -- 于是列表这一列在生产上恒为 0/空白 —— 超管会以为"商户没有子账号"，
      -- 而实际上 jiufa 名下有三个（查库可见），只是界面永远显示 0。
      -- （工单数已随工单功能一起移除，见文件上方 2026-10-11 的说明。）
      (SELECT count(*) FROM sub_accounts s WHERE s.parent_id=u.id AND s.deleted_at IS NULL)::int AS sub_count`,
    keyword: ['u.username', 'u.nickname'],
    order: 'u.id DESC'
  })))

  router.get('/admin/subs', asyncRoute((req, res) => adminJoinedList(repo, req, res, {
    from: 'sub_accounts s JOIN users u ON u.id=s.parent_id',
    select: `s.id,s.parent_id,s.username,s.nickname,s.email,s.status,s.char_balance,s.char_used,
      s.translate_count,s.auto_alloc,s.bound_device,s.active_engine_id,u.username AS parent_username,
      s.created_at AS create_time`,
    keyword: ['s.username', 's.nickname', 'u.username'],
    // 「子账号」弹窗按商户过滤。不声明 parentColumn 时会返回全站所有子账号，
    // 界面上看着像"这家商户的子账号"，解绑就会踢错人。
    parentColumn: 's.parent_id',
    order: 's.id DESC'
  })))

  router.get('/admin/recharges', asyncRoute((req, res) => adminJoinedList(repo, req, res, {
    from: 'recharges r JOIN users u ON u.id=r.user_id LEFT JOIN packages p ON p.id=r.package_id',
    // effective_status：把「已过有效期但 status 还是 0」的惰性过期订单算成 expired。
    // 后台必须按它展示/筛选，否则会把一堆再也付不了款的僵尸单显示成"待支付"。
    select: `r.*,${effectiveStatusSql('r')} AS effective_status,
      r.order_number AS order_num,r.original_amount AS original_price,
      r.paid_amount AS price,r.payment_type AS type,r.created_at AS create_time,u.username,p.title AS basename`,
    keyword: ['r.order_number', 'r.payment_type', 'u.username'],
    order: 'r.id DESC'
  })))

  router.get('/admin/recharge-exceptions', asyncRoute(async (req, res) => {
    const data = input(req)
    const status = String(data.status || 'open')
    if (!['open', 'resolved', 'ignored', 'all'].includes(status)) {
      throw new ApiError(400, 'status 只能是 open / resolved / ignored / all', 'BAD_STATUS')
    }
    const where = status === 'all' ? '' : 'WHERE e.status = $1'
    const params = status === 'all' ? [] : [status]

    const result = await repo.query(
      `SELECT e.*, r.order_number AS suspected_order_number
         FROM recharge_exceptions e
         LEFT JOIN recharges r ON r.id = e.recharge_id
         ${where}
        ORDER BY e.amount_milli DESC NULLS LAST, e.created_at ASC
        LIMIT 500`,
      params
    )
    res.json(mapRows(result.rows))
  }))

  router.post('/admin/recharge-exceptions/resolve', asyncRoute(async (req, res) => {
    const data = input(req)
    const ids = Array.isArray(data.ids) ? data.ids : [data.id]

    const result = await repo.transaction(async client => {
      const single = ids.length === 1
      const done = single
        ? await rechargeException.resolve(client, {
          id: ids[0], action: data.action, note: data.note,
          admin: req.pixAdmin, ip: req.ip
        })
        : await rechargeException.resolveMany(client, {
          ids, action: data.action, note: data.note,
          admin: req.pixAdmin, ip: req.ip
        })
      return single ? { resolved: [done], skipped: [] } : done
    })

    ok(res, `已处置 ${result.resolved.length} 条异常`)
  }))

  router.get('/admin/translate/logs', asyncRoute((req, res) => adminJoinedList(repo, req, res, {
    from: 'translate_logs t JOIN users u ON u.id=t.user_id',
    select: `t.*,t.engine_id AS engine,(t.source_language||'→'||t.target_language) AS direction,
      t.cost_amount AS cost,t.sell_amount AS sell,t.created_at AS create_time,u.username`,
    keyword: ['t.engine_id', 't.snippet', 'u.username'],
    order: 't.id DESC'
  })))

  /**
   * 登录日志 / 超管审计。
   *
   * ## 为什么要显式写别名，不能直接 adminList
   *
   * 库里时间列叫 `created_at`，mapRows 只会把它转成 `createdAt`；
   * 而 AdminLogs.vue 读的是 `loginTime` / `createTime`。两边对不上，
   * 后果是**时间列整列为空** —— 表格照样渲染，只是那一列空着，
   * 看不出是 bug 还是"这条日志本来就没时间"。
   *
   * mock 里恰好叫 `loginTime` / `createTime`，所以本地开发一路正常，
   * 只有连真库才会暴露。这和 `translate/logs` 的做法保持一致：
   * 在 SQL 里把列名对齐到前端读的字段。
   *
   * ## 登录日志的商户名
   *
   * `login_logs` 没有 username / nickname 列，只有 `account` 和
   * `user_id` / `sub_account_id` / `admin_id` 三个来源。前端要按「商户」
   * 看是谁登录的，所以在这里回连 users 取名字 —— 子账号登录时
   * 也要归到它的主账号名下，否则客服查"这个商户最近从哪登的"会查不到。
   */
  router.get('/admin/logs', asyncRoute(async (req, res) => {
    const data = input(req)
    const paging = pagination(req, { size: 50 })
    const isAudit = data.kind === 'audit'
    const values = []
    let where = 'TRUE'

    if (data.keyword) {
      values.push(`%${data.keyword}%`)
      where = isAudit
        ? `(l.action ILIKE $1 OR l.actor ILIKE $1 OR l.detail::text ILIKE $1)`
        : `(l.account ILIKE $1 OR l.login_type ILIKE $1 OR l.login_ip::text ILIKE $1 OR u.username ILIKE $1)`
    }

    const from = isAudit
      ? 'audit_logs l'
      : `login_logs l
         LEFT JOIN users u ON u.id = l.user_id
         LEFT JOIN sub_accounts s ON s.id = l.sub_account_id
         LEFT JOIN users pu ON pu.id = s.parent_id`

    // 时间统一别名成 create_time → mapRows 转成 createTime。
    // 登录日志额外补一份 login_time，是为了让 AdminLogs.vue 不用改
    // 就能同时兼容 mock 与真库（两边的字段名本来就该一致）。
    const select = isAudit
      ? `l.id,l.actor AS admin,l.action,l.detail,l.ip,l.created_at AS create_time`
      : `l.id,l.account,l.login_type,l.login_ip,
         COALESCE(u.username,'') AS username,
         COALESCE(u.nickname,'') AS nickname,
         COALESCE(pu.username,'') AS parent_username,
         CASE WHEN l.success THEN '成功' ELSE '失败' END AS result,
         l.failure_reason,
         l.created_at AS create_time,
         l.created_at AS login_time`

    const count = await repo.query(`SELECT count(*)::bigint AS total FROM ${from} WHERE ${where}`, values)
    const rows = await repo.query(
      `SELECT ${select} FROM ${from} WHERE ${where}
       ORDER BY l.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      values.concat([paging.size, paging.offset]))

    // 审计的 detail 在库里是 jsonb（形如 {"message":"..."}）。
    // 前端直接绑到表格上会显示成 [object Object]，这里取出 message 文本。
    //
    // 注意不能写 `detail.message || fallback`：message 是空串时（例如
    // 「登录超管后台（两步验证）」这类没有附加说明的记录）空串会掉进
    // fallback，页面上就出现一坨 `{"message":""}` 的原始 JSON。
    // 判据要用「有没有这个字段」，不是「值真不真」。
    const mapped = mapRows(rows.rows).map(row => {
      if (!isAudit) return row
      const detail = row.detail
      if (detail && typeof detail === 'object') {
        row.detail = detail.message !== undefined && detail.message !== null
          ? String(detail.message)
          : (detail.detail !== undefined ? String(detail.detail) : JSON.stringify(detail))
      } else {
        row.detail = detail == null ? '' : String(detail)
      }
      return row
    })

    res.json(page(mapped, count.rows[0].total, paging))
  }))

}

module.exports = { registerAdminDashboard }

/** 本文件包含的路由（仅供文档与调试参考）
 *   GET   /admin/stats
 *   GET   /admin/users
 *   GET   /admin/subs
 *   GET   /admin/recharges
 *   GET   /admin/recharge-exceptions
 *   POST  /admin/recharge-exceptions/resolve
 *   GET   /admin/translate/logs
 *   GET   /admin/logs
 */
