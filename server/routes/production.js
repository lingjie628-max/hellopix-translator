'use strict'

/**
 * 商户端 / 客户端主路由，以及尚未拆分的各域。
 *
 * ## 拆分进度
 *
 *   routes/auth.js   认证（商户、客户端、超管两步验证）      14 条
 *   routes/admin.js  超管后台全部功能                        47 条
 *   routes/production.js  本文件：商户端、team、translate、
 *                         customer、site、注册/找回           38 条
 *
 * 拆分原则是**纯搬移**：逻辑、SQL、响应格式一行不改，
 * 注册顺序逐条不变（由 test/route-registry.test.js 守着）。
 *
 * ## 依赖为什么从 context.js 拿
 *
 * 限流器与 service 实例必须在**全站只构造一次**。若各模块自己 new，
 * 同名限流器的 redis key 会分裂，额度随模块数成倍放大 —— 等于把限流关掉。
 * 所以统一由 `buildContext()` 构造，各模块只接收 `ctx`。
 */

const express = require('express')
const { asyncRoute, input, pagination, page, ok, stub, ApiError, toggle } = require('../lib/http')
// mapRow（单数）和 mapRows（复数）都要 —— 下单返回单条订单时用的是单数版，
// 之前只引入了复数，导致 mapRow 悬空。
const { mapRows } = require('../repositories/production-repository')
const { number } = require('../services/core-service')
const { effectiveStatus, effectiveStatusSql } = require('../services/recharge-state')
const { buildContext } = require('./context')

function productionRouter(context) {
  const { repository: repo, auth, core, customers, accounts, security } = context
  const router = express.Router()
  // 依赖与限流器集中在 context.js 里构造一次：
  // 拆成多个路由模块后，限流器若各自 new 一遍，额度会随模块数成倍放大。
  const ctx = buildContext(context)
  // 本文件剩余的 38 条路由只用得到这几个限流器。
  // 其余限流器由各子模块从 ctx.limits 自取 —— 不要再在这里顺手解构出别名，
  // 否则拆完留下的空壳变量会和真正的使用者对不上。
  const { limits } = ctx
  const emailCodeLimit = limits.emailCode
  const registerLimit = limits.register
  const translateIpLimit = limits.translateIp
  const translateAccountLimit = limits.translateAccount
  // 图片翻译的独立限额（成本是文本的几十到几百倍，不能共用额度）
  const translateImageIpLimit = limits.translateImageIp
  const translateImageAccountLimit = limits.translateImageAccount
  const crashReportLimit = limits.crashReport
  router.use(auth.middleware())
  // 下单业务逻辑在 services/recharge-order-service.js，路由只负责拼响应
  const { rechargeOrder, crashReport } = ctx.services
  router.use(security.csrf)

  // 认证前段（商户/客户端登录）。后段在 /client/lines 之后 ——
  // 原文件里认证路由不是连着的，顺序必须保持逐条不变。
  require('./auth').registerUserAuth(router, ctx)

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

  /**
   * 崩溃日志上报（0.1.36 起客户端在**异常退出后**的下次启动自动调用）。
   *
   * ## 为什么这个接口要自己再过滤一遍
   *
   * 客户端已经按白名单只挑 crash/memory 行，但**服务端不能信任客户端** ——
   * 客户端可被打包篡改，或将来有人写错过滤器。这里再过滤一次，
   * 保证落库的内容**只可能**是这两类。隐私防线不能只有一层。
   *
   * ## 为什么允许未登录上报
   *
   * 闪退最常发生在**启动阶段**（还没登录、甚至登录页都没显示）。
   * 若要求登录，最有价值的那批日志反而永远收不到。
   * 因此只靠 IP 限流控制，不要求鉴权；但仍记录能拿到的用户身份。
   */
  /**
   * 客户端崩溃日志上报。
   *
   * 过滤规则（只收 crash/memory、行数与单行长度、摘要由服务端算）全在
   * services/crash-report-service.js —— 那个文件就是隐私边界本身。
   * 这里只负责取设备标识和当前身份。
   *
   * 不要求登录：闪退最常发生在启动阶段（登录页都还没显示），
   * 要求鉴权会让最有价值的那批日志永远收不到。靠 IP 限流控制频率。
   */
  router.post('/client/crash-report', crashReportLimit, asyncRoute(async (req, res) => {
    const session = req.pixUser || null
    const result = await crashReport.submit({
      lines: input(req).lines,
      data: input(req),
      user: session && session.account ? session.account : null,
      deviceId: req.get('X-Pix-Device') || ''
    })
    // stored=false 有两种含义：无可存内容，或重复上报被去重。
    // 对客户端来说都是"收下了"，不必区分 —— 但提示文案按有无内容分一下，
    // 免得日志里看到"已上报"却什么都没存，排查时误判成写库失败。
    ok(res, result.crashCount || result.memoryPeak !== null ? '已上报' : '无需上报', result)
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
    // 按「有效状态」筛选：直接比 status 会让"已过期"筛出 0 条、让"待支付"混进僵尸单
    if (data.status !== undefined && data.status !== '') {
      values.push(number(data.status))
      clauses.push(`${effectiveStatusSql('')}=$${values.length}`)
    }
    const result = await repo.list('recharges', { where: clauses.join(' AND '), values, limit: paging.size, offset: paging.offset })
    result.rows = result.rows.map(row => Object.assign(row, {
      effectiveStatus: effectiveStatus(row),
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

  /**
   * 创建充值订单（待支付）。
   *
   * 收款用 TRC20 USDT，靠人工/链上核对确认，所以这里做了一个关键设计：
   * **给每单加 0.01~0.99 的唯一"匹配尾数"**。多家商户都转到同一个收款地址时，
   * 金额本身就是身份标识 —— 看到 200.37 到账就能精确对上哪一单，
   * 否则只能靠"谁在群里说了一声"，早晚对错账。
   *
   * 尾数会同时写进 original_amount 和 paid_amount，这样表上的
   * CHECK (original_amount - discount_amount = paid_amount) 依然成立。
   */
  /**
   * 创建充值订单（待支付）。
   *
   * 收款用 TRC20 USDT，靠链上核对人工确认，所以这里做了一个关键设计：
   * **给每单加 0.01~0.99 的唯一"匹配尾数"**。多家商户都转到同一个收款地址时，
   * 金额本身就是身份标识 —— 看到 200.37 到账就能精确对上哪一单，
   * 否则只能靠"谁在群里说了一声"，早晚对错账。
   *
   * 尾数会同时写进 original_amount 和 paid_amount，这样表上的
   * CHECK (original_amount - discount_amount = paid_amount) 依然成立。
   */
  router.post('/userRecharge/create', asyncRoute(async (req, res) => {
    // 业务逻辑在 services/recharge-order-service.js。
    // 这里只做两件事：调 service，按前端契约拼响应。
    const result = await rechargeOrder.create({ user: req.pixUser, data: input(req) })
    const { order, pack, channel } = result

    res.json({
      orderNum: order.orderNumber,
      packageTitle: pack.title,
      quantity: order.quantity,
      chars: Number(order.chars),
      // 金额全部用插入时算好的精确文本，不从 mapRow 的 Number 反推
      originalAmount: result.originalText,
      discountAmount: result.discountText,
      surchargeAmount: result.surchargeText,
      payAmount: result.paidText,
      // 明确告诉前端尾数是多少，好向商户解释"为什么不是整数"
      matchSuffix: result.surchargeText,
      // 从 mapRow 出来的订单行取，不用事务里的局部变量（那个在回调作用域内）
      expiresAt: order.expiresAt,
      expiresInMinutes: result.expiresInMinutes,
      channel: {
        id: channel.id,
        name: channel.name,
        network: channel.network,
        address: channel.address,
        tokenContract: result.tokenContract,
        note: channel.note
      },
      // 金额就是订单标识：链上按"地址 + 合约 + 金额"三者匹配，
      // 所以必须一分不差地转账，多转少转都会进异常池等人工处理
      expiresHint: `请按 ${result.paidText} USDT 准确转账（金额即订单标识，多付少付都无法自动入账）`
    })
  }))

  router.get('/team/info', asyncRoute(async (req, res) => res.json(await core.teamInfo(req.pixUser))))
  router.get('/team/subs', asyncRoute(async (req, res) => {
    if (req.pixUser.kind !== 'main') throw new ApiError(403, '仅主账号可管理子账号', 'MAIN_ACCOUNT_REQUIRED')
    const data = input(req)
    const paging = pagination(req)
    const values = [req.pixUser.parent.id]
    const clauses = ['parent_id=$1 AND deleted_at IS NULL']
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
    // 只接受 1/0。`number()` 对任意值都返回整数，不挡的话
    // `status=7` 也能写进库 —— 之后 resolve() 判 `!== 1` 当成停用，
    // 界面上却显示"启用"，两边打架。
    const status = toggle(data.status)
    if (status === null) throw new ApiError(400, '状态只能是 0 或 1', 'BAD_STATUS')
    const result = await repo.query(
      'UPDATE sub_accounts SET status=$3,updated_at=NOW() WHERE id=$1 AND parent_id=$2 AND deleted_at IS NULL RETURNING id',
      [data.id, req.pixUser.parent.id, status]
    )
    if (!result.rows[0]) throw new ApiError(404, '子账号不存在', 'SUB_NOT_FOUND')
    if (status !== 1) await auth.revokeUser('sub', data.id)
    ok(res, status === 1 ? '已启用' : '已停用')
  })
  router.post('/team/subs/status', setSubStatus)
  // 删除子账号：**软删除**，账本（translate_logs / translation_usage /
  // translation_reservations）原样保留，余额退回主账号。详见 core.deleteSub。
  router.post('/team/subs/delete', asyncRoute(async (req, res) => {
    const result = await core.deleteSub(req.pixUser, input(req))
    ok(res, result.msg || '已删除')
  }))
  router.post('/team/subs/batch', asyncRoute(async (req, res) => {
    if (req.pixUser.kind !== 'main') throw new ApiError(403, '仅主账号可管理子账号')
    const data = input(req)
    const ids = String(data.ids || '').split(',').filter(Boolean)
    // 与单个切换同一口径：只认 1/0，别让非法状态值进库
    const status = toggle(data.status)
    if (status === null) throw new ApiError(400, '状态只能是 0 或 1', 'BAD_STATUS')
    const changed = await repo.query(
      'UPDATE sub_accounts SET status=$3,updated_at=NOW() WHERE parent_id=$1 AND id=ANY($2::bigint[]) AND deleted_at IS NULL RETURNING id',
      [req.pixUser.parent.id, ids, status]
    )
    if (status !== 1) {
      await Promise.all(changed.rows.map(row => auth.revokeUser('sub', row.id)))
    }
    ok(res, status === 1 ? '已开启所选' : '已关闭所选')
  }))
  router.post('/team/autoAlloc', asyncRoute(async (req, res) => {
    if (req.pixUser.kind !== 'main') throw new ApiError(403, '仅主账号可管理子账号')
    const data = input(req)
    if (data.id) {
      await repo.query('UPDATE sub_accounts SET auto_alloc=$3 WHERE id=$1 AND parent_id=$2 AND deleted_at IS NULL', [data.id, req.pixUser.parent.id, Boolean(number(data.autoAlloc))])
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
      const owned = await repo.query('SELECT id FROM sub_accounts WHERE id=$1 AND parent_id=$2 AND deleted_at IS NULL', [data.id, req.pixUser.parent.id])
      if (!owned.rows[0]) throw new ApiError(404, '子账号不存在', 'SUB_NOT_FOUND')
      kind = 'sub'; id = data.id
    }
    await repo.query(kind === 'sub'
      ? "UPDATE sub_accounts SET bound_device='' WHERE id=$1 AND deleted_at IS NULL"
      : "UPDATE users SET bound_device='' WHERE id=$1", [id])
    await auth.revokeUser(kind, id)
    ok(res, '客户端绑定已重置')
  }))

  // 旧的商户端「工单」接口（/order/*、/orderDetails/*）已于 2026-09-25 移除：
  // 对应的 7 个前端页面在同日删除，生产库 orders / order_details / order_fans
  // 均为 0 行。
  //
  // 2026-10-11 补记：超管后台残存的「全部工单」页与 /admin/orders（读）
  // 也一并移除 —— 全代码库**没有任何 INSERT INTO orders**，这个页面永远不可能
  // 有数据，留着只会让超管以为"工单功能坏了"。orders 表本身保留
  // （merchant-purge 仍会为旧数据做快照），只是不再有读写的界面与接口。

  router.get('/translate/engines', asyncRoute(async (req, res) => res.json(await core.engines(req.pixUser))))
  router.post('/translate/engines/active', asyncRoute(async (req, res) => {
    const data = input(req)
    const available = await core.engines(req.pixUser)
    const target = available.rows.find(row => String(row.id) === String(data.id))
    if (!target || !target.allowed || number(target.enabled) !== 1) {
      // 分开报错：通道在套餐里但没接通时，用户真正需要知道的是"它还没上线"，
      // 而不是"套餐未包含"（后者会让他以为升级套餐就能用）。
      if (target && !target.allowed) {
        throw new ApiError(503, '该翻译通道尚未上线，请换一个通道', 'ENGINE_NOT_CONFIGURED')
      }
      throw new ApiError(403, '当前套餐未包含此通道', 'ENGINE_NOT_ALLOWED')
    }
    const table = req.pixUser.kind === 'sub' ? 'sub_accounts' : 'users'
    await repo.query(`UPDATE ${table} SET active_engine_id=$2,updated_at=NOW() WHERE id=$1`, [req.pixUser.account.id, data.id])
    ok(res, '翻译通道已切换')
  }))
  const translate = asyncRoute(async (req, res) => {
    res.json(await core.translate(req.pixUser, input(req), req.get('Idempotency-Key')))
  })
  /**
   * 图片翻译。
   *
   * 用**独立**的限额（不是文本那两道）—— 一次图片的成本是纯文本的几十到
   * 几百倍，挂同一份额度等于限额失效。理由与数字依据见 routes/context.js。
   *
   * 不要求 Idempotency-Key：图片翻译没有"字符预留"可退，重放一次只是
   * 多花一次 token；客户端本来也不会自动重试（见 desktop 侧的调用）。
   */
  const translateImage = asyncRoute(async (req, res) => {
    res.json(await core.translateImage(req.pixUser, input(req)))
  })
  router.post('/translate/image', translateImageIpLimit, translateImageAccountLimit, translateImage)
  router.post('/translate/run', translateIpLimit, translateAccountLimit, translate)
  router.post('/translate', translateIpLimit, translateAccountLimit, translate)

  // ---------------------------------------------------------------------
  // 统一客户身份：线索接入与撞单提醒
  //
  // 两个接口都从会话取 user_id，**不接受客户端传入的商户号** ——
  // 否则任何人都能伪造线索塞进别人的客户库。
  // ---------------------------------------------------------------------

  router.post('/customer/ingest', asyncRoute(async (req, res) => {
    const session = req.pixUser
    if (!session || !session.parent) throw new ApiError(401, '请先登录', 'AUTH_REQUIRED')
    const data = input(req)
    // 操作员工只在子账号时落库：customer_owners.employee_id 外键指向 sub_accounts，
    // 主账号自己的 id 在 users 表里，直接塞进去会违反外键。
    const operatorId = session.kind === 'sub' ? session.account.id : null
    const result = await customers.ingest(session.parent.id, Object.assign({}, data, { operatorId }))
    res.json(result)
  }))

  router.get('/customer/reminders', asyncRoute(async (req, res) => {
    const session = req.pixUser
    if (!session || !session.parent) throw new ApiError(401, '请先登录', 'AUTH_REQUIRED')
    // 默认只看最近 10 分钟，客户端每 8 秒轮询一次，窗口足够且不会重复轰炸
    const since = new Date(Date.now() - 10 * 60 * 1000)
    res.json({ items: await customers.pendingReminders(session.parent.id, since) })
  }))

  // ---------------------------------------------------------------------
  // 统一客户身份：超管后台
  //
  // 全部挂在 /admin/ 下 —— 仓储层有一组不带商户隔离的方法（customerDetail
  // 等），静态测试强制它们**只能**被 /admin/ 路由调用。商户端接口在下面
  // 单独分组，两者不能混。
  // ---------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // 邮件服务配置（超管）
  //
  // 读取时 **pass 字段一律打码**：SMTP 授权码等同于发件域名的使用权，
  // 泄露出去可以伪造该域名的任何邮件。页面不需要看到原值，
  // 保存时若提交的是掩码则保持原值不变（见 saveMailConfig）。
  // ---------------------------------------------------------------------
  // 邮件配置、客户、合并候选、撞号设置
  require('./admin/content').registerAdminContent(router, ctx)

  // 客户端会带 ?arch=<process.arch> 来要对应架构的安装包（见 desktop/main.js）。
  // 不带的调用方（如官网）拿到的仍是列表第一条，行为不变。
  router.get('/site/info', asyncRoute(async (req, res) => res.json(await core.siteInfo(input(req)))))

  // 官网（未登录可见）用的公开内容。
  // 只暴露营销信息：套餐标题/价格/额度/卖点，不含任何商户或凭据数据。
  router.get('/site/packages', asyncRoute(async (_req, res) => {
    const result = await repo.query(
      // 不要写驼峰别名：Postgres 会把未加引号的别名折叠成小写
      // （portUnlimited → portunlimited），mapRow 的下划线转换就接不上了。
      // 直接用原列名，交给 mapRow 统一转成 portLimit / portUnlimited / includedChars。
      `SELECT code,title,subtitle,price,port_limit,port_unlimited,included_chars,chars_unlimited,highlights,clients,features
       FROM packages WHERE active=true ORDER BY sort_order,id`
    )
    res.json({ success: true, rows: mapRows(result.rows) })
  }))
  router.get('/site/faqs', asyncRoute(async (_req, res) => {
    const result = await repo.query(
      'SELECT id,question,answer FROM faqs WHERE enabled=true ORDER BY sort_order,id'
    )
    res.json({ success: true, rows: mapRows(result.rows) })
  }))
  router.get('/site/platforms', (_req, res) => res.json({ success: true, rows: core.platforms() }))

  router.get('/client/lines', asyncRoute(async (_req, res) => {
    const result = await repo.query('SELECT id,name,url,region,enabled FROM client_lines WHERE enabled=true ORDER BY sort_order,id')
    res.json({ success: true, rows: mapRows(result.rows) })
  }))

  // 认证后段（超管登录 / 两步验证）。必须在这里，不能提到文件顶部。
  require('./auth').registerAdminAuth(router, ctx)

  // 总览统计与各列表（含 adminList / adminJoinedList 两个共享辅助函数）
  require('./admin/dashboard').registerAdminDashboard(router, ctx)
  // 商户写操作、充值确认、调账、员工
  require('./admin/accounts').registerAdminUsers(router, ctx)
  // 客户端版本与翻译通道
  require('./admin/clients').registerAdminClients(router, ctx)
  // FAQ、短链、话术库、账号在线、粉丝
  require('./admin/ops').registerAdminOps(router, ctx)
  // 套餐、系统设置、验证码通道
  require('./admin/settings').registerAdminSettings(router, ctx)

  // ---------------------------------------------------------------------
  // 注册 / 找回密码 / 邮箱验证码
  //
  // 这三条此前是 stub，新商户一个都注册不了。现在按真实链路实现。
  // 三条都是公开接口，所以都挂了 IP 限流 —— 尤其是发验证码那条，
  // 不限流的话会被当成免费发信机，轻则烧钱、重则发件域名被拉黑。
  // ---------------------------------------------------------------------

  router.post('/user/emailCode', emailCodeLimit, asyncRoute(async (req, res) => {
    res.json(await accounts.sendEmailCode(input(req), { ip: req.ip }))
  }))

  router.post('/user/register', registerLimit, asyncRoute(async (req, res) => {
    res.json(await accounts.register(input(req)))
  }))

  router.post('/user/forgot', registerLimit, asyncRoute(async (req, res) => {
    res.json(await accounts.forgot(input(req)))
  }))

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
    // 注意：/admin/accounts 与 /admin/fans 曾在此当桩，
    // 现已按新客户模型实现（见上方「运营 · 在线账号 / 进粉统计」）。
  ]
  // 公告没有独立接口：它以 site.notices 存在站点设置里，读写都走
  // /admin/settings 与 /admin/settings/save（前端 AdminNotices.vue 正是这么调的）。
  // 这三个遗留路径用准确的说明注册，而不是笼统的"尚未迁移"—— 功能其实早就有，
  // 只是不在这些路径上，含糊的提示会把排查引向错误方向。
  ;['/admin/notices', '/admin/notices/save', '/admin/notices/delete'].forEach(path => {
    router.all(path, stub('admin.notices', '公告没有独立接口：请用 /admin/settings 读取、/admin/settings/save 保存（site.notices）'))
  })
  unmigrated.forEach(path => router.all(path, stub(path.slice(1), '该兼容模块尚未迁移到 PostgreSQL')))
  router.all(/^\/export2?\//, stub('export', '正式导出任务与对象存储尚未迁移'))

  router.use((_req, res) => res.status(404).json({ success: false, code: 'API_NOT_FOUND', msg: '接口不存在' }))
  return router
}

module.exports = { productionRouter }
