'use strict'

const express = require('express')
const crypto = require('crypto')
const { asyncRoute, input, pagination, page, ok, stub, ApiError } = require('../lib/http')
const { mapRow, mapRows } = require('../repositories/production-repository')
const { number, bool } = require('../services/core-service')
const { redisRateLimit } = require('../redis-security')
const captcha = require('../lib/captcha')
const { encryptSecret, credentialsKeyReady, KEY_ENV } = require('../lib/credentials')
const { providers, channelStatus } = require('../services/translation-provider')
const { AdminTotpService } = require('../services/admin-totp-service')
const { RechargeAmountService } = require('../services/recharge-amount-service')
const { RechargeEntitlement } = require('../services/recharge-entitlement')
const { STATUS: RECHARGE_STATUS, assertTransition, effectiveStatus, effectiveStatusSql } = require('../services/recharge-state')
const { parseMilli, formatMilli } = require('../lib/money')
const { validTronAddress, normalizeTronAddress } = require('../lib/tron-address')
const { objectSetting, readAlertTo, setting: settingOf } = require('../lib/mailer')
const purge = require('../lib/merchant-purge')

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
  const { repository: repo, auth, core, customers, accounts, security } = context
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
  // 发验证码：每 IP 每 10 分钟 10 次。比图形验证码更严 ——
  // 它背后是真金白银的发信配额，滥用还会拖累发件域名信誉。
  const emailCodeLimit = limit('emailcode-ip', 10, 10 * 60_000)
  // 注册与找回密码：每 IP 每 10 分钟 20 次。
  // 验证码本身有 5 次尝试上限，这里只挡批量刷接口。
  const registerLimit = limit('register-ip', 20, 10 * 60_000)
  const translateIpLimit = limit('translate-ip', 180, 60_000)
  const translateAccountLimit = limit('translate-account', 120, 60_000, req =>
    req.pixUser ? `${req.pixUser.kind}:${req.pixUser.account.id}` : 'missing'
  )

  // 超管两步验证
  const adminTotp = new AdminTotpService(repo, core.redis)
  // 充值金额预约：随机尾数分配 + 24 小时复用保护（RC-02）
  const rechargeAmount = new RechargeAmountService()
  // 套餐权益发放。手工确认与链上自动入账必须走**同一份**逻辑 ——
  // 否则会出现"自动入账发了套餐、手工确认没发"，同一张订单两种结果。
  const rechargeEntitlement = new RechargeEntitlement(repo)
  // 第二步的限流按来源 IP：票据本身还有尝试次数上限，两层叠加
  const adminTotpLimit = limit('admin-totp-ip', 20, 15 * 60_000)
  // 动态码/密钥相关操作只可能在已登录会话里发生，给个宽松上限防脚本刷
  const adminTotpOpLimit = limit('admin-totp-op', 60, 15 * 60_000, req =>
    req.pixAdmin ? `admin:${req.pixAdmin.id}` : 'missing'
  )

  router.use(auth.middleware())
  router.use(security.csrf)

  router.post('/login', loginIpLimit, loginAccountLimit, asyncRoute(async (req, res) => {
    const data = input(req)
    const captchaCheck = await captcha.consume(core.redis, data.imageId, data.imageCode)
    if (!captchaCheck.ok) throw new ApiError(400, captchaCheck.message, captchaCheck.code)
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
    // 充值涉及资金，只允许主账号操作；子账号需让主账号来充
    if (req.pixUser.kind !== 'main') {
      throw new ApiError(403, '仅主账号可发起充值', 'MAIN_ACCOUNT_REQUIRED')
    }
    const data = input(req)
    const quote = await core.quote({ baseid: data.baseid || data.id, month: data.month || data.qty })
    const pack = await repo.package(data.baseid || data.id)
    if (!pack) throw new ApiError(404, '套餐不存在', 'PACKAGE_NOT_FOUND')

    // 收款渠道未启用/未填地址时拒绝下单，避免商户拿到空地址
    const channels = (await readSettings()).paymentChannels.filter(item => item.enabled && item.address)
    if (!channels.length) {
      throw new ApiError(503, '收款方式尚未配置，请联系客服', 'PAYMENT_NOT_CONFIGURED')
    }
    const channel = channels.find(item => item.id === String(data.channelId || '')) || channels[0]

    const { order, originalText, discountText, surchargeText, paidText } =
      await repo.transaction(async client => {
      const now = new Date()
      // 有效期 30 分钟。到期后金额仍被保护 24 小时（见 recharge-amount-service），
      // 保护期内到账的迟到款会被识别成"原订单的迟到款"而不是新订单的钱。
      const expiresAt = new Date(now.getTime() + RECHARGE_TTL_MINUTES * 60 * 1000)

      // 金额全部走 milli-USDT 整数，**不经过任何浮点**。
      // quote.paidMilli 是折后价（字符串形式的毫），尾数直接加在整数上。
      // 注意用 parseMilli 而不是 toMilli：paidMilli 已经是「毫」，
      // 用 toMilli 会再乘 1000，订单金额静默放大一千倍（踩过）
      const baseMilli = parseMilli(quote.paidMilli)
      const allocation = await rechargeAmount.allocate(client, {
        payAddress: channel.address,
        tokenContract: USDT_TRC20_CONTRACT,
        baseAmountMilli: baseMilli,
        expiresAt,
        now
      })

      // 先把三个金额格式化成文本，插入与响应都复用它们。
      //
      // 不要从 mapRow 之后的 order.paidAmount 反推 —— mapRow 会把 numeric
      // 转成 JS Number（36.157），而 formatMilli 只接受整数毫，
      // 直接喂进去会抛 `Cannot convert 36.157 to a BigInt`（踩过）。
      // 精确值只有一份：这里的 milli。
      const originalText = formatMilli(quote.originalMilli)   // 标准价，不含尾数
      const discountText = formatMilli(quote.discountMilli)   // 折扣
      const surchargeText = formatMilli(allocation.suffixMilli) // 尾数（0.001–0.999）
      const paidText = formatMilli(allocation.amountMilli)    // 实付 = 标准价 − 折扣 + 尾数

      const orderNumber = `HP${Date.now()}${crypto.randomInt(100, 999)}`
      const created = await client.query(
        `INSERT INTO recharges(user_id,package_id,order_number,kind,payment_type,quantity,chars,
         original_amount,discount_amount,surcharge_amount,paid_amount,status,idempotency_key,
         expires_at,pay_address,pay_token_contract,amount_reservation_id,package_catalog_version)
         VALUES($1,$2,$3,'package',$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [req.pixUser.parent.id, pack.id, orderNumber, `USDT-${channel.network}`,
          quote.qty, quote.chars,
          originalText, discountText, surchargeText, paidText,
          `recharge:${orderNumber}`,
          expiresAt.toISOString(),
          channel.address,
          USDT_TRC20_CONTRACT,
          String(allocation.reservationId),
          // 下单瞬间把「这一单卖的是哪一版套餐权益」钉死在订单上。
          // 不存的话，日后调整套餐组合就再也证明不了当初卖给客户的是哪几个通道 ——
          // 而客户付的钱是按当时那版算的。
          Number(pack.catalogVersion) || null])
      // 预约先于订单插入（订单要引用它），这里回填归属
      await rechargeAmount.attachToRecharge(client, allocation.reservationId, created.rows[0].id)

      // 这里**不写** repo.audit：audit_logs 是「超管操作记录」，
      // 其 admin_id 有指向 admins 表的外键，商户下单写进去会外键冲突。
      // 下单本身在 recharges 表里已有完整记录（时间/金额/状态），足够追溯。
      // 金额文本必须从事务里带出来：它们在回调作用域内，
      // 直接在外面用会 ReferenceError（踩过）
      return {
        order: mapRow(created.rows[0]),
        originalText, discountText, surchargeText, paidText
      }
    })

    res.json({
      orderNum: order.orderNumber,
      packageTitle: pack.title,
      quantity: order.quantity,
      chars: Number(order.chars),
      // 金额全部用插入时算好的精确文本，不从 mapRow 的 Number 反推
      originalAmount: originalText,
      discountAmount: discountText,
      surchargeAmount: surchargeText,
      payAmount: paidText,
      // 明确告诉前端尾数是多少，好向商户解释"为什么不是整数"
      matchSuffix: surchargeText,
      // 从 mapRow 出来的订单行取，不用事务里的局部变量（那个在回调作用域内）
      expiresAt: order.expiresAt,
      expiresInMinutes: RECHARGE_TTL_MINUTES,
      channel: {
        id: channel.id,
        name: channel.name,
        network: channel.network,
        address: channel.address,
        tokenContract: USDT_TRC20_CONTRACT,
        note: channel.note
      },
      // 金额就是订单标识：链上按"地址 + 合约 + 金额"三者匹配，
      // 所以必须一分不差地转账，多转少转都会进异常池等人工处理
      expiresHint: `请按 ${paidText} USDT 准确转账（金额即订单标识，多付少付都无法自动入账）`
    })
  }))

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

  router.get('/admin/mail', asyncRoute(async (_req, res) => {
    const settings = await repo.settings()
    // 键是扁平的 'mail.smtp'，不是 settings.mail.smtp —— 读错位置会永远显示"未配置"
    const smtp = objectSetting(settings, 'mail.smtp', {})
    const cfg = await accounts.mailer.config()
    res.json({
      host: smtp.host || '',
      port: smtp.port || 465,
      secure: smtp.secure !== false,
      user: smtp.user || '',
      pass: smtp.pass ? '********' : '',
      from: smtp.from || '',
      fromName: smtp.fromName || 'Hello Pix',
      alertTo: readAlertTo(settings),
      configured: cfg.configured,
      missing: cfg.missing
    })
  }))

  router.post('/admin/mail', asyncRoute(async (req, res) => {
    const data = input(req)
    const settings = await repo.settings()
    const current = objectSetting(settings, 'mail.smtp', {})
    const smtp = {
      host: String(data.host || '').trim(),
      port: Number(data.port) || 465,
      secure: data.secure !== false && data.secure !== 'false',
      user: String(data.user || '').trim(),
      // 提交的是掩码说明管理员没改密码 —— 保持原值，别把真密码覆盖成星号
      pass: data.pass === '********' ? (current.pass || '') : String(data.pass || ''),
      from: String(data.from || '').trim(),
      fromName: String(data.fromName || 'Hello Pix').trim()
    }
    // 与 /admin/settings/save 用同一套写法：事务 + 审计。
    // 仓储层没有 upsertSetting 这个方法（我先写了才发现），
    // 实际都是 inline 的 ON CONFLICT —— 抽出来反而会让两处行为分叉。
    await repo.transaction(async client => {
      await repo.query(
        `INSERT INTO app_settings(key,value,description) VALUES($1,$2::jsonb,$3)
         ON CONFLICT (key) DO UPDATE SET value=$2::jsonb`,
        ['mail.smtp', JSON.stringify(smtp), 'SMTP 服务器配置'], client
      )
      // 告警收件地址单独存：它可以在 SMTP 还没配好之前就先填上，
      // 而巡检脚本正是靠它把"服务挂了"这类消息发出去
      await repo.query(
        `INSERT INTO app_settings(key,value,description) VALUES($1,$2::jsonb,$3)
         ON CONFLICT (key) DO UPDATE SET value=$2::jsonb`,
        ['mail.alert_to', JSON.stringify(String(data.alertTo || '').trim()), '运维告警收件地址'], client
      )
      await repo.audit(client, req.pixAdmin, '修改邮件服务配置',
        smtp.host + ' / ' + smtp.from, req.ip, { type: 'settings' })
    })
    res.json({ ok: true, configured: await accounts.mailer.configured(), missing: (await accounts.mailer.config()).missing })
  }))

  // 真实发信测试：连接 → 认证 → 投递，三步分开报。
  // 失败用真实 HTTP 状态码（配置缺失 503 / SMTP 侧失败 502），绝不返回 200 假装成功。
  router.post('/admin/mail/test', asyncRoute(async (req, res) => {
    const to = String((req.body && req.body.to) || '').trim()
    const result = await accounts.mailer.sendTest(to)
    if (result.ok) return res.json(result)
    const status = result.code === 'MAIL_NOT_CONFIGURED' ? 503
      : (result.code === 'BAD_EMAIL' ? 400 : 502)
    res.status(status).json(result)
  }))

  router.get('/admin/customers', asyncRoute(async (req, res) => {
    const { keyword } = req.query
    // listCustomers 自己就返回 { rows, total } ——
    // 不要再调 countCustomers：那是仓储层的方法，服务层没有透出，
    // 而且它跑的是同一条 count 查询，重复一次没有意义。
    const { limit, offset } = pagination(req, 50)
    res.json(await customers.listCustomers({ keyword, limit, offset }))
  }))

  router.get('/admin/customers/:id', asyncRoute(async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, '客户编号不正确', 'BAD_ID')
    const detail = await customers.customerDetail(id)
    if (!detail) throw new ApiError(404, '客户不存在', 'NOT_FOUND')
    res.json(detail)
  }))

  router.get('/admin/merge-candidates', asyncRoute(async (req, res) => {
    res.json({ rows: await customers.listMergeCandidates(req.query.status || 'pending') })
  }))

  router.post('/admin/merge-candidates/:id/resolve', asyncRoute(async (req, res) => {
    const id = Number(req.params.id)
    const action = String((req.body && req.body.action) || '')
    if (!['merge', 'reject'].includes(action)) {
      throw new ApiError(400, 'action 只能是 merge 或 reject', 'BAD_ACTION')
    }
    res.json(await customers.resolveMergeCandidate(id, action, req.pixAdmin && req.pixAdmin.id))
  }))

  router.get('/admin/collisions', asyncRoute(async (_req, res) => {
    res.json({ rows: await customers.collisionHistory(100) })
  }))

  router.get('/admin/collision-settings', asyncRoute(async (_req, res) => {
    res.json(await customers.collisionConfig())
  }))

  router.put('/admin/collision-settings', asyncRoute(async (req, res) => {
    res.json(await customers.saveCollisionConfig(input(req), req.pixAdmin && req.pixAdmin.id))
  }))

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
      `SELECT code,title,subtitle,price,port_limit,port_unlimited,included_chars,highlights,clients,features
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

  router.post('/admin/login', loginIpLimit, loginAccountLimit, asyncRoute(async (req, res) => {
    const data = input(req)
    // 图形验证码：超管是全站最高价值目标，前置阻力不能比商户端还弱
    const captchaCheck = await captcha.consume(core.redis, data.imageId, data.imageCode)
    if (!captchaCheck.ok) throw new ApiError(400, captchaCheck.message, captchaCheck.code)

    const admin = await auth.verifyAdminCredentials(req, data)

    if (admin.totpEnabled) {
      // 已开两步验证：这一步只发一次性票据，**不给会话**
      const { ticket, expiresInMs } = await adminTotp.issueLoginTicket(admin)
      return res.json({
        success: true,
        needTotp: true,
        ticket,
        expiresInMs,
        msg: '请输入验证器上的 6 位动态码'
      })
    }

    await auth.startAdminSession(req, res, admin)
    res.json({
      success: true,
      obj: {
        username: admin.username,
        nickname: admin.nickname,
        role: admin.role || 'superadmin',
        totpEnabled: false
      }
    })
  }))

  router.post('/admin/login/totp', adminTotpLimit, asyncRoute(async (req, res) => {
    const data = input(req)
    const { admin, usedRecovery } = await adminTotp.completeLogin(data.ticket, data.code, req.ip)
    await auth.startAdminSession(
      req, res, admin, usedRecovery ? '使用恢复码登录超管后台' : '登录超管后台（两步验证）'
    )
    res.json({
      success: true,
      usedRecovery: !!usedRecovery,
      obj: {
        username: admin.username,
        nickname: admin.nickname,
        role: admin.role || 'superadmin',
        totpEnabled: true
      }
    })
  }))

  router.get('/admin/totp', adminTotpOpLimit, asyncRoute(async (req, res) => {
    res.json(Object.assign({ success: true }, await adminTotp.status(req.pixAdmin)))
  }))

  router.post('/admin/totp/setup', adminTotpOpLimit, asyncRoute(async (req, res) => {
    res.json(Object.assign({ success: true }, await adminTotp.beginSetup(req.pixAdmin)))
  }))

  router.post('/admin/totp/enable', adminTotpOpLimit, asyncRoute(async (req, res) => {
    const { recoveryCodes } = await adminTotp.enable(req.pixAdmin, input(req).code, req.ip)
    // 恢复码只在此刻返回一次，之后库里只有哈希，谁也取不回明文
    res.json({ success: true, recoveryCodes, msg: '两步验证已开启' })
  }))

  router.post('/admin/totp/disable', adminTotpOpLimit, asyncRoute(async (req, res) => {
    await adminTotp.disable(req.pixAdmin, input(req).code, req.ip)
    // 与同组其它端点保持一致用 success:true。
    // 项目里的 ok() 辅助返回的是 success:'success'（字符串），两种风格并存，
    // 前端靠真值判断都能用，但同一组接口混着来迟早会坑到调用方。
    res.json({ success: true, msg: '两步验证已关闭' })
  }))

  router.post('/admin/totp/recovery', adminTotpOpLimit, asyncRoute(async (req, res) => {
    const { recoveryCodes } = await adminTotp.regenerateRecovery(req.pixAdmin, input(req).code, req.ip)
    res.json({ success: true, recoveryCodes, msg: '恢复码已重新生成' })
  }))

  router.post('/admin/logout', asyncRoute(async (req, res) => {
    await security.destroySession(req, res, 'admin')
    ok(res, '已退出')
  }))
  /**
   * 超管总览的数据源。
   *
   * ## 为什么要重写
   *
   * 前端 `AdminDashboard.vue`（以及「翻译计费」页）读的是 `enterpriseUsers`、
   * `translateSell`、`translateCost`、`activeEngine`、`packageBill`、
   * `recentTranslates`、`recentAudits`、`fanCount`、`rechargeCount` 这些字段，
   * 这个契约**只在 mock 里实现过** —— 真后端只回了其中 10 个计数，
   * 其余字段一个都没有。于是生产上：
   *
   *   · 「企业账号」恒为 0（明明已把商户升成企业）
   *   · 「翻译售出 / 通道成本」恒为空
   *   · 「当前通道」一直显示 "-"
   *   · 「最近翻译扣费」「超管操作记录」永远"暂无数据"
   *     —— 而库里 audit_logs 有 135 行、translate_logs 有 457 行
   *
   * 有一处口径要如实说明：`translate_logs.sell_amount` 在 core-service 里是
   * **写死的 0**（`VALUES(...,$8,0,...)`）—— 本系统按套餐整包售卖，
   * 并不按字符计价。所以「翻译售出」的真实值就是 0，不是取错了列；
   * 真正的钱在「充值金额」（实收）与「通道成本」（translate_logs.cost_amount）。
   */
  router.get('/admin/stats', asyncRoute(async (_req, res) => {
    const counts = await repo.query(
      `SELECT
       (SELECT count(*) FROM users)::int AS user_count,
       (SELECT count(*) FROM users WHERE status=1)::int AS active_users,
       (SELECT count(*) FROM users WHERE enterprise)::int AS enterprise_users,
       (SELECT count(*) FROM sub_accounts)::int AS sub_count,
       -- 进粉的口径必须与「进粉统计」页（/admin/fans）**完全一致**：
       -- 那个页面的 total 就是 conversations JOIN users 的行数（新客户模型，
       -- 见下方 /admin/fans 路由）。早先我这里是数 order_fans —— 那是随工单
       -- 一起下线的表，恒为 0，会出现"卡片 0、页面有数据"的经典错位。
       (SELECT count(*) FROM conversations c JOIN users u ON u.id=c.user_id)::int AS fan_count,
       (SELECT COALESCE(sum(hits),0) FROM short_links)::int AS short_link_hits,
       (SELECT COALESCE(sum(char_balance),0) FROM users)::bigint AS char_balance,
       (SELECT COALESCE(sum(chars),0) FROM translate_logs)::bigint AS char_used,
       (SELECT ROUND(COALESCE(sum(paid_amount),0),2) FROM recharges WHERE status=1)::numeric AS recharge_sum,
       (SELECT count(*) FROM recharges WHERE status=1)::int AS recharge_count,
       (SELECT ROUND(COALESCE(sum(cost_amount),0),4) FROM translate_logs)::numeric AS translate_cost,
       (SELECT ROUND(COALESCE(sum(sell_amount),0),4) FROM translate_logs)::numeric AS translate_sell,
       -- 有效待支付：仍在有效期内、真的还能付款的单
       (SELECT count(*) FROM recharges r
         WHERE r.status=0 AND r.expires_at > now())::int AS recharge_pending,
       -- 惰性过期：数据库里还写着 status=0，但其实早就过期了 —— 这些必须从"待支付"里剔除
       (SELECT count(*) FROM recharges r
         WHERE r.status=0 AND r.expires_at <= now())::int AS recharge_pending_stale`
    )

    // 最近翻译扣费 / 超管操作记录：总览两张表原本永远是空的，因为后端根本没查。
    // 别名必须对齐前端（cost / sell / direction / createTime / admin ...）。
    const [recentTranslates, recentAudits, settings] = await Promise.all([
      repo.query(
        `SELECT t.id,t.chars,ROUND(t.cost_amount,6) AS cost,ROUND(t.sell_amount,6) AS sell,t.snippet,
                t.engine_id AS engine,t.created_at AS create_time,
                (t.source_language||'→'||t.target_language) AS direction,u.username
           FROM translate_logs t JOIN users u ON u.id=t.user_id
          ORDER BY t.id DESC LIMIT 6`
      ),
      repo.query(
        `SELECT id,actor AS admin,action,COALESCE(detail->>'message','') AS detail,created_at AS create_time
           FROM audit_logs ORDER BY id DESC LIMIT 6`
      ),
      repo.settings()
    ])

    // 毛利估算 = 累计实收 − 累计通道成本。
    // 两者现在都是美元（迁移 032 已把 cost_amount 的单位统一成美元），
    // 所以可以直接相减。它是估算：实收按订单口径、成本按字符口径，
    // 不是严格的会计周期配比，卡片文案里已注明"估算"。
    const stats = mapRow(counts.rows[0])
    const grossProfit = Math.round(
      (Number(stats.rechargeSum || 0) - Number(stats.translateCost || 0)) * 100) / 100

    // 当前通道：取「后台设置的默认通道」，退回第一个已接通且启用的通道。
    // 前端要的是通道名（如 GPT），不是 id。
    const configured = String(settingOf(settings, 'translation.active_engine', '') || '').trim()
    const engineRow = (await repo.query(
      `SELECT id,name,cost_per_million FROM engines
        WHERE ($1 <> '' AND id=$1) OR ($1 = '' AND wired AND enabled)
        ORDER BY (id=$1) DESC, id LIMIT 1`,
      [configured]
    )).rows[0]

    // 套餐文案：币种必须跟「系统设置 → 价格货币」一致，
    // 否则会出现"套餐 ¥200"而全站别的金额都是 $ 的错位。
    const symbol = { USD: '$', CNY: '¥', HKD: 'HK$', JPY: '¥', EUR: '€' }[
      String(settingOf(settings, 'billing.currency', 'USD') || 'USD').toUpperCase()] || '$'
    const packages = (await repo.query(
      `SELECT title,price,included_chars FROM packages WHERE active ORDER BY sort_order,id`
    )).rows
    const packageBill = packages
      .map(p => `${p.title} ${symbol}${p.price}/${Number(p.includedChars || 0) / 10000}万`)
      .join(' · ')

    res.json(Object.assign(stats, {
      grossProfit,
      recentTranslates: mapRows(recentTranslates.rows),
      recentAudits: mapRows(recentAudits.rows),
      activeEngine: engineRow ? engineRow.name : '',
      engineCostPerMillion: engineRow ? engineRow.costPerMillion : null,
      packageBill
    }))
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
      p.title AS basename,u.package_catalog_version,u.char_balance,u.char_used,u.translate_count,u.sub_quota,u.auto_alloc_master,
      u.auto_reply,u.enterprise,u.port_limit AS port,u.ports_in_use AS user_ports,u.bound_device,
      u.expires_at AS expire_time,u.remarks,u.created_at AS create_time,
      -- 子账号数必须是**真计数**。
      -- 这个字段原先只存在于 mock 的 enrichUser 里，真后端 SELECT 从来没查过，
      -- 于是列表这一列在生产上恒为 0/空白 —— 超管会以为"商户没有子账号"，
      -- 而实际上 jiufa 名下有三个（查库可见），只是界面永远显示 0。
      -- （工单数已随工单功能一起移除，见文件上方 2026-10-11 的说明。）
      (SELECT count(*) FROM sub_accounts s WHERE s.parent_id=u.id)::int AS sub_count`,
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
  router.get('/admin/recharges', asyncRoute((req, res) => adminJoinedList(req, res, {
    from: 'recharges r JOIN users u ON u.id=r.user_id LEFT JOIN packages p ON p.id=r.package_id',
    // effective_status：把「已过有效期但 status 还是 0」的惰性过期订单算成 expired。
    // 后台必须按它展示/筛选，否则会把一堆再也付不了款的僵尸单显示成"待支付"。
    select: `r.*,${effectiveStatusSql('r')} AS effective_status,
      r.order_number AS order_num,r.original_amount AS original_price,
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
  /**
   * 重置商户密码 —— 超管专用，不需要原密码。
   *
   * 为什么不复用编辑商户的 `/admin/users/save`：那个接口开头就
   * `repo.package(data.versionId || data.packageId)`，拿不到套餐直接
   * 404「套餐不存在」。只想改个密码，还得把当前套餐正确传进来，很容易失败；
   * 而且它一条 UPDATE 会顺带碰 nick/status/套餐/到期等一串字段 —— 改密码是
   * 安全敏感操作，值得一条**只做一件事**的独立通路。
   *
   * 规则：6-128 位、不限字符类型（唯一真源 server/lib/password.js）。
   */
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
    await repo.query(`UPDATE ${table} SET bound_device='',updated_at=NOW() WHERE id=$1`, [id])
    await auth.revokeUser(data.subId ? 'sub' : 'main', id)
    ok(res, '客户端绑定已重置')
  }))
  /**
   * 回收字符：账号保留，余额归零。
   *
   * 为什么不复用 `/admin/translate/grant`：那个接口只加不减（`chars<=0` 直接
   * 拒绝），而且会给商户造一张 manual 充值单。回收不是充值，为它造一张 0 元
   * 充值单是**假账** —— 以后按 recharges 统计营收就会多出一笔不存在的流水。
   *
   * 这里走总账 `char_ledger` 追加一条 `reason='correction'` 的负数流水：
   * 余额是**变动**出来的，不是被抹掉的，"为什么少了 N"必须有答案。
   */
  router.post('/admin/users/reclaim', asyncRoute(async (req, res) => {
    const data = input(req)
    const result = await purge.reclaimChars({
      repo, admin: req.pixAdmin, ip: req.ip, id: data.id, note: data.note
    })
    ok(res, result.reclaimed > 0
      ? `已回收 ${result.reclaimed} 字符，${result.username} 余额归零（已记入字符流水）`
      : `${result.username} 余额本就是 0，无需回收`)
  }))
  /**
   * 删除商户（不可逆）。
   *
   * 两道闸，缺一不可：
   *   1. `confirmUsername` 必须**一字不差**等于账号名 —— 防"点错行"；
   *   2. 账号里有生意痕迹时，首次请求返回 409 + 影响条数，前端渲染确认弹窗，
   *      带上 `acknowledge=true` 再提交才真正执行 —— 防"没看清就点了确定"。
   *
   * 执行前先把商户行与账目快照写进 `deleted_merchants`（不挂外键）。
   * 这是**必须的**：`char_ledger.user_id` 是 RESTRICT，删商户必然连带删流水，
   * 所以删除的审计痕迹只能放存档表，不能放流水。
   */
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
  /**
   * 确认收款（超管手动把订单标记为已支付）。
   *
   * 这是全站唯一"点一下就给商户加字符"的地方，所以三重防重复：
   *   1. 事务里 SELECT ... FOR UPDATE 锁住订单行，并发点击会被串行化
   *   2. 已经是已支付状态直接返回，不重复加字符（幂等）
   *   3. 填了链上交易号时，走表上 (payment_type, provider_transaction_id)
   *      唯一索引 —— 同一笔链上交易不可能给两单充值
   */
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
      // 先取当前套餐与已钉权益版本 —— 下面要判断"这次编辑有没有换套餐"。
      //
      // 为什么必须判断：`users.package_catalog_version` 是"这位商户当初买到的是
      // 哪一版通道组合"的凭据。如果每次编辑（哪怕只是改个备注、续个期）都顺手
      // 把它刷成当前版本，那这个字段就形同虚设 —— 一次无关的编辑就能把老客户
      // 已经付过钱的权益悄悄换掉，正是"擅自改变已售权益"。
      // 所以：只有**换套餐**才重新钉，不换就原样保留。
      const before = await repo.query(
        'SELECT package_id,package_catalog_version FROM users WHERE id=$1', [data.id])
      if (!before.rows[0]) throw new ApiError(404, '用户不存在', 'USER_NOT_FOUND')
      const packageChanged = String(before.rows[0].package_id || '') !== String(pack.id)
      const requestedVersion = data.catalogVersion === undefined || data.catalogVersion === ''
        ? null
        : number(data.catalogVersion)
      if (requestedVersion !== null && requestedVersion < 1) {
        throw new ApiError(400, '权益版本必须是正整数', 'BAD_CATALOG_VERSION')
      }
      // 显式指定优先；换套餐时钉到新套餐的当前版本；否则 NULL = 保持原值
      const catalogVersion = requestedVersion !== null
        ? requestedVersion
        : (packageChanged ? (Number(pack.catalogVersion) || null) : null)
      const result = await repo.query(
        `UPDATE users SET nickname=COALESCE($2,nickname),status=COALESCE($3,status),
         package_id=$4,port_limit=COALESCE($5,port_limit),
         -- 到期时间支持"清空成无限期"。
         -- 原来是 COALESCE($6::timestamptz,expires_at)：传 null 只会**保留原值**，
         -- 于是后台根本无法把一个已设到期时间的商户改回不过期 —— 想设"无限"
         -- 只能填 2038 这种假日期（jiufa 现在就停在 2038-10-10，正是这么来的）。
         -- 现在用显式开关 $14 区分三态：开 → NULL；给了日期 → 用日期；都没给 → 保持原值。
         expires_at=CASE WHEN $14::boolean THEN NULL
                         WHEN $6::timestamptz IS NOT NULL THEN $6::timestamptz
                         ELSE expires_at END,
         password_hash=COALESCE($7,password_hash),phone=COALESCE($8,phone),remarks=COALESCE($9,remarks),
         enterprise=COALESCE($10,enterprise),auto_reply=COALESCE($13,auto_reply),
         sub_quota=COALESCE($11,sub_quota),
         package_catalog_version=COALESCE($12,package_catalog_version),
         updated_at=NOW() WHERE id=$1 RETURNING username,status,package_catalog_version`,
        [data.id, data.nickname || null, data.status === undefined ? null : number(data.status),
          pack.id, data.port === undefined ? null : number(data.port),
          data.expireTime || null, passwordHash, data.phone === undefined ? null : (data.phone || null),
          data.remarks === undefined ? null : data.remarks,
          // 开关一律走 bool()，不能写 Boolean(number(...))：
          // 请求体里是字符串 "true"，Number("true") 是 NaN，会被判成 false ——
          // 于是"打开"的开关保存后反而被关掉，且毫无报错（线上踩过）
          bool(data.enterprise),
          data.subQuota === undefined || data.subQuota === '' ? null : number(data.subQuota),
          catalogVersion,
          // 自动回复原来**根本没写**：编辑态点了等于没点（新建时却会写）。
          // 补上这一列，让两边的行为一致。
          bool(data.autoReply),
          // $14：到期时间是否设为「无限期」。null（没传）时不动作。
          bool(data.expireUnlimited)]
      )
      if (!result.rows[0]) throw new ApiError(404, '用户不存在', 'USER_NOT_FOUND')
      if (passwordHash || number(result.rows[0].status) !== 1) await auth.revokeUser('main', data.id)
      // 权益版本变了就把新旧版本写进审计：事后被问"谁把这家的通道换了"要有答案
      await repo.audit(null, req.pixAdmin, '编辑商户', result.rows[0].username, req.ip, {
        type: 'user', id: data.id, catalogVersion: Number(result.rows[0].packageCatalogVersion) || null
      })
      return ok(res, '用户已更新')
    }
    if (!data.username) throw new ApiError(400, '请填写账号', 'USERNAME_REQUIRED')
    const settings = await repo.settings()
    const gift = data.charBalance === undefined || data.charBalance === ''
      ? number(settings['registration.trial_chars'])
      : number(data.charBalance)
    // 子账号额度：没显式填就按套餐自带的给。
    // 不这么做的话新商户额度恒为 0（`sub_quota` 建表默认值），
    // 一进来就开不了子账号 —— 与套餐里带的额度直接矛盾。
    const subQuotaForNew = data.subQuota === undefined || data.subQuota === ''
      ? Math.max(0, Math.floor(Number(pack.subQuota) || 0))
      : number(data.subQuota)
      // 新商户的默认翻译通道：后台设置的默认值 → 套餐内第一个「已接通且启用」的 → 空。
      // 原先写死 'youdao'，一旦该通道没接通，该商户从第一天起翻译就必然失败。
      let defaultEngine = String(settings['translation.active_engine'] || '').trim()
      if (!defaultEngine) {
        const usable = await repo.packageEngines(pack.id)
        defaultEngine = (usable.find(row => row.enabled && row.wired) || {}).id || ''
      }
    await repo.transaction(async client => {
      // 新商户**在建号那一刻**钉住权益版本：他买到的就是当下这一版，
      // 日后我们调整套餐组合不会回溯改到他头上。
      // 管理员可以显式传 catalogVersion 指定（例如按老客户的旧合同开号）。
      const newVersion = data.catalogVersion === undefined || data.catalogVersion === ''
        ? (Number(pack.catalogVersion) || null)
        : number(data.catalogVersion)
      // 16 个列 ↔ 16 个值，必须严格对齐。
      // 这里曾经写成 `$7,$8,...,$16`（17 个值），而 `$16` 连绑定参数都没有 ——
      // 后果是**新建商户整条路径直接 500**（`INSERT has more expressions than
      // target columns`）。生产上 `新建商户` 审计只有 1 条、且是 2026-09-25
      // 那次改动之前的，正是这个多出来的占位符造成的。
      const created = await repo.query(
        `INSERT INTO users(username,password_hash,nickname,status,package_id,port_limit,expires_at,
         char_balance,auto_reply,phone,remarks,active_engine_id,enterprise,email,sub_quota,
         package_catalog_version)
         -- $16 勾了「无限期」就建一个不过期的号（NULL）；
         -- 否则维持原行为：给了日期用日期，没给就默认 30 天。
         VALUES($1,$2,$3,1,$4,$5,
          CASE WHEN $16::boolean THEN NULL
               ELSE COALESCE($6::timestamptz,NOW()+interval '30 days') END,
          $7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id,username`,
        [String(data.username).trim(), await auth.hash(data.password), data.nickname || data.username,
          pack.id, number(data.port, number(pack.portLimit)), data.expireTime || null, gift,
          // 这三列都是 NOT NULL 的布尔列，bool() 可能返回 null（没传），
          // 所以必须 `=== true` 兜成布尔再进 SQL
          bool(data.autoReply) === true, data.phone || null, data.remarks || '',
          defaultEngine || null, bool(data.enterprise) === true,
          data.email ? String(data.email).toLowerCase() : null, subQuotaForNew,
          newVersion, bool(data.expireUnlimited)], client
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

  /**
   * 校验并归一 `call_params`（通道调用参数）。
   *
   * 为什么要在路由层校验：这几个值会**直接进入出站请求**（超时、重试、输出上限），
   * 一旦写进一个字符串或负数，故障现场会跑偏到"适配器莫名不工作"，
   * 而不是"后台填错了"。这里挡在前面对排查友好得多。
   *
   * 上限在这里再夹一次（适配器里还有一层）：两边都要，
   * 因为适配器可被脚本/测试直接调用，不能只靠路由把关。
   */
  function normalizeCallParams(raw) {
    if (raw === undefined || raw === null || raw === '') return null
    let value = raw
    if (typeof value === 'string') {
      try { value = JSON.parse(value) } catch (_error) {
        throw new ApiError(400, '调用参数必须是 JSON 对象', 'BAD_CALL_PARAMS')
      }
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new ApiError(400, '调用参数必须是 JSON 对象', 'BAD_CALL_PARAMS')
    }
    const out = {}
    const numeric = { timeoutMs: [1000, 30000], maxRetries: [0, 2], maxOutputTokens: [0, 65536], maxInputTokens: [0, 1000000] }
    for (const [key, [min, max]] of Object.entries(numeric)) {
      if (value[key] === undefined || value[key] === null || value[key] === '') continue
      const parsed = Number(value[key])
      if (!Number.isFinite(parsed)) throw new ApiError(400, `调用参数 ${key} 必须是数字`, 'BAD_CALL_PARAMS')
      out[key] = Math.min(max, Math.max(min, Math.trunc(parsed)))
    }
    // temperature: null 是**有意的空值语义**（该模型不能收这个字段，如 Kimi K3），
    // 必须保留成 null 而不是被当成"没填"丢掉 —— 丢掉会让适配器把 0 发出去，
    // 而 K3 收到 temperature 会直接报错。
    if (Object.prototype.hasOwnProperty.call(value, 'temperature')) {
      if (value.temperature === null) out.temperature = null
      else {
        const parsed = Number(value.temperature)
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
          throw new ApiError(400, 'temperature 必须在 0~2 之间，或填 null 表示不发送该参数', 'BAD_CALL_PARAMS')
        }
        out.temperature = parsed
      }
    }
    if (value.extraBody !== undefined) {
      if (!value.extraBody || typeof value.extraBody !== 'object' || Array.isArray(value.extraBody)) {
        throw new ApiError(400, 'extraBody 必须是 JSON 对象', 'BAD_CALL_PARAMS')
      }
      out.extraBody = value.extraBody
    }
    return out
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
        rows: rows.map(row => ({
          id: row.id,
          name: row.name,
          provider: row.provider,
          tier: row.tier,
          costPerMillion: Number(row.costPerMillion || 0),
          model: row.model || '',
          endpoint: row.endpoint || '',
          note: row.note || '',
          callParams: row.callParams || {},
          enabled: Boolean(row.enabled),
          wired: Boolean(row.wired),
          // 已下架：对商户不可见，但仍在库里、历史日志仍指向它。
          // 后台保留可见是为了能重新上架，以及查"当初卖的是什么"。
          retired: Boolean(row.retiredAt),
          retiredAt: row.retiredAt || null,
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
    // 下架：**不删行**，只打 retired_at 并停用。历史 translate_logs 仍指向它，
    // 已售权益的凭据也还在 package_engines 里 —— 删了就查不出"当初卖过什么"。
    const retired = data.retired === undefined ? Boolean(engine.retiredAt) : Boolean(Number(data.retired))
    const enabled = retired ? false : Boolean(Number(data.enabled))
    const adapter = providers[id]
    const ready = Boolean(adapter && adapter.configured(effective))
    // wired 不让人手填：适配器实现 + 凭据齐备才允许接通，与 CLI 脚本同一把尺子
    const wired = enabled && ready

    const callParams = normalizeCallParams(data.callParams)
    const model = String(data.model || '').trim() || null
    // 渠道换了真实模型就**必须显式可见**：台账、前台展示都读这个字段。
    // 这里不阻止改，但改了要在审计里留下前后值（下面写审计）。
    const modelChanged = (engine.model || '') !== (model || '')

    await repo.query(
      `UPDATE engines SET enabled=$2, wired=$3, cost_per_million=$4, model=$5, endpoint=$6, note=$7,
              call_params=COALESCE($10::jsonb, call_params),
              retired_at=${retired ? 'NOW()' : 'NULL'},
              api_key_ciphertext=COALESCE($8, api_key_ciphertext),
              secret_ciphertext=COALESCE($9, secret_ciphertext),
              updated_at=NOW()
       WHERE id=$1`,
      [id, enabled, wired,
        Math.max(0, Number(data.costPerMillion) || 0),
        model,
        endpoint || null,
        String(data.note || '').slice(0, 1000),
        apiKey ? encryptSecret(apiKey) : null,
        secret ? encryptSecret(secret) : null,
        callParams ? JSON.stringify(callParams) : null]
    )
    await repo.audit(null, req.pixAdmin, retired ? '下架翻译通道' : '配置翻译通道',
      `${engine.name}: enabled=${enabled} wired=${wired} retired=${retired}` +
      (modelChanged ? ` 模型 ${engine.model || '(空)'} → ${model || '(空)'}` : ''), req.ip, {
        type: 'engine', id
      })
    ok(res, retired
      ? `${engine.name} 已下架（历史日志与已售权益保留，未删除）`
      : (wired ? `${engine.name} 已接通` : `${engine.name} 已保存（未接通：${adapter ? '凭据未就绪' : '适配器未实现'}）`))
  }))

  router.post('/admin/engines/active', asyncRoute(async (req, res) => {
    const id = String(input(req).id || '').trim()
    const engine = await repo.engineById(id)
    if (!engine) throw new ApiError(404, '通道不存在', 'ENGINE_NOT_FOUND')
    if (engine.retiredAt) throw new ApiError(400, '该通道已下架，不能设为默认', 'ENGINE_RETIRED')
    if (!engine.enabled) throw new ApiError(400, '该通道未启用，不能设为默认', 'ENGINE_DISABLED')
    await repo.query(
      `INSERT INTO app_settings(key,value,description) VALUES('translation.active_engine',to_jsonb($1::text),'默认翻译引擎')
       ON CONFLICT (key) DO UPDATE SET value=to_jsonb($1::text)`,
      [id]
    )
    await repo.audit(null, req.pixAdmin, '设置默认翻译通道', engine.name, req.ip, { type: 'engine', id })
    ok(res, `默认通道已设为 ${engine.name}`)
  }))

  // 提交的 JSON 字段（features/engines/clients/notices/lines…）统一解析，
  // 解析失败一律 400，不要冒成 500
  // ---- FAQ / 分流短链 / 话术库（超管运营菜单）--------------------------------
  router.get('/admin/faqs', asyncRoute(async (_req, res) => {
    res.json(mapRows((await repo.query(
      'SELECT id,question,answer,sort_order AS sort,enabled FROM faqs ORDER BY sort_order,id'
    )).rows))
  }))

  router.post('/admin/faqs/save', asyncRoute(async (req, res) => {
    const data = input(req)
    const question = String(data.question || '').trim()
    if (!question) throw new ApiError(400, '问题不能为空', 'FAQ_QUESTION_REQUIRED')
    const answer = String(data.answer || '').slice(0, 10000)
    const sort = Math.max(0, Math.floor(Number(data.sort) || 0))
    const enabled = Number(data.enabled) ? true : false
    if (data.id) {
      const updated = await repo.query(
        `UPDATE faqs SET question=$2,answer=$3,sort_order=$4,enabled=$5,updated_at=NOW()
         WHERE id=$1 RETURNING id`, [Number(data.id), question, answer, sort, enabled])
      if (!updated.rows[0]) throw new ApiError(404, 'FAQ 不存在', 'FAQ_NOT_FOUND')
    } else {
      await repo.query(
        'INSERT INTO faqs(question,answer,sort_order,enabled) VALUES($1,$2,$3,$4)',
        [question, answer, sort, enabled])
    }
    await repo.audit(null, req.pixAdmin, data.id ? '编辑FAQ' : '新增FAQ', question.slice(0, 60), req.ip, { type: 'faq', id: data.id || null })
    ok(res, data.id ? 'FAQ 已更新' : 'FAQ 已新增')
  }))

  router.get('/admin/links', asyncRoute(async (req, res) => {
    const data = input(req)
    const paging = pagination(req, { size: 50 })
    const values = []
    let filter = ''
    if (data.keyword) {
      values.push(`%${data.keyword}%`)
      filter = ' AND (l.code ILIKE $1 OR l.message ILIKE $1 OR u.username ILIKE $1)'
    }
    const total = await repo.query(
      `SELECT count(*)::bigint AS total FROM short_links l LEFT JOIN users u ON u.id=l.user_id WHERE TRUE${filter}`, values)
    const rows = await repo.query(
      `SELECT l.id, COALESCE(u.username,'') AS username, l.order_serial AS "orderNum", l.code,
              l.target, l.hits, l.accounts, l.message
       FROM short_links l LEFT JOIN users u ON u.id=l.user_id
       WHERE TRUE${filter} ORDER BY l.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      values.concat([paging.size, paging.offset]))
    res.json(Object.assign(page(mapRows(rows.rows), total.rows[0].total, paging), {
      rows: rows.rows.map(row => Object.assign(row, {
        orderNum: row.orderNum || '',
        shareLink: row.target
      }))
    }))
  }))

  router.get('/admin/scripts', asyncRoute(async (req, res) => {
    const data = input(req)
    const paging = pagination(req, { size: 50 })
    const values = []
    let filter = ''
    if (data.keyword) {
      values.push(`%${data.keyword}%`)
      filter = ' AND (s.keyword ILIKE $1 OR s.source ILIKE $1 OR s.target ILIKE $1 OR u.username ILIKE $1)'
    }
    const total = await repo.query(
      `SELECT count(*)::bigint AS total FROM scripts s LEFT JOIN users u ON u.id=s.user_id WHERE TRUE${filter}`, values)
    const rows = await repo.query(
      `SELECT s.id, COALESCE(u.username,'') AS username, s.group_title AS "groupTitle",
              s.keyword, s.source, s.target
       FROM scripts s LEFT JOIN users u ON u.id=s.user_id
       WHERE TRUE${filter} ORDER BY s.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      values.concat([paging.size, paging.offset]))
    res.json(page(mapRows(rows.rows), total.rows[0].total, paging))
  }))

  // ---------------------------------------------------------------------
  // 运营 · 在线账号 / 进粉统计
  //
  // 这两页原来查的是旧「工单」模型的 order_details / order_fans，
  // 而那套模型（工单号 / 主号 / 端口 / 当日进粉）在现在的产品里已经不存在了，
  // 生产库那几张表**一行数据都没有** —— 于是接口干脆没实现，直接返回
  // 503「该兼容模块尚未迁移到 PostgreSQL」。运营点进去只能看到一个报错。
  //
  // 但这两页要表达的信息在新模型里是**真实存在**的：
  //
  //   在线账号  → conversations（哪个商户、用哪个账号、在跟哪个客户、多久没动）
  //   进粉统计  → conversations 的首次出现时间，以及这个客户是不是别处也见过
  //
  // 所以这里按新模型重写，而不是去复活那两张空表 —— 后者只会得到一个
  // 永远为空的假页面，比报错更糟（报错至少说明"这里没东西"）。
  // ---------------------------------------------------------------------

  /**
   * 多久没活动就算离线。客户端切换会话时会更新 last_message_at。
   *
   * 这个值**直接内联进 SQL**而不是当绑定参数：它是个服务端常量，不是用户输入；
   * 当参数传会带来一个很难查的坑 —— 无筛选时 count 查询里根本不出现这个占位符，
   * 于是 pg 报 "bind message supplies 1 parameters, but prepared statement requires 0"。
   * 内联之前做一次整数校验，杜绝拼字符串带来的注入面。
   */
  const ACCOUNT_ONLINE_WINDOW_MINUTES = 10
  const ONLINE_WINDOW_SQL = Number.isInteger(ACCOUNT_ONLINE_WINDOW_MINUTES) && ACCOUNT_ONLINE_WINDOW_MINUTES > 0
    ? String(ACCOUNT_ONLINE_WINDOW_MINUTES)
    : '10'

  router.get('/admin/accounts', asyncRoute(async (req, res) => {
    const data = input(req)
    const paging = pagination(req, { size: 50 })
    const values = []
    const clauses = ['TRUE']
    if (data.keyword) {
      values.push(`%${data.keyword}%`)
      clauses.push(`(u.username ILIKE $${values.length} OR c.account_key ILIKE $${values.length}`
        + ` OR c.peer_key ILIKE $${values.length} OR c.display_name ILIKE $${values.length})`)
    }
    if (data.online !== undefined && data.online !== '') {
      clauses.push(Number(data.online) === 1
        ? `c.last_message_at > now() - interval '${ONLINE_WINDOW_SQL} minutes'`
        : `(c.last_message_at IS NULL OR c.last_message_at <= now() - interval '${ONLINE_WINDOW_SQL} minutes')`)
    }
    const where = clauses.join(' AND ')
    const total = await repo.query(
      `SELECT count(*)::bigint AS total FROM conversations c JOIN users u ON u.id=c.user_id WHERE ${where}`, values)
    const rows = await repo.query(
      `SELECT c.id, COALESCE(u.username,'') AS username, c.platform,
              COALESCE(c.account_key,'') AS account,
              COALESCE(c.peer_key,'') AS peer_key,
              COALESCE(c.display_name,'') AS nick_name,
              CASE WHEN c.last_message_at > now() - interval '${ONLINE_WINDOW_SQL} minutes'
                   THEN 1 ELSE 0 END AS online_status,
              COALESCE(co.status,'') AS owner_status,
              COALESCE(cu.public_id,'') AS customer_no,
              c.last_message_at,
              c.created_at
         FROM conversations c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN customers cu ON cu.id = c.customer_id
         LEFT JOIN customer_owners co
                ON co.user_id = c.user_id AND co.customer_id = c.customer_id
        WHERE ${where}
        ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      values.concat([paging.size, paging.offset]))
    res.json(page(mapRows(rows.rows), total.rows[0].total, paging))
  }))

  router.get('/admin/fans', asyncRoute(async (req, res) => {
    const data = input(req)
    const paging = pagination(req, { size: 50 })
    const values = []
    const clauses = ['TRUE']
    if (data.keyword) {
      values.push(`%${data.keyword}%`)
      clauses.push(`(u.username ILIKE $${values.length} OR c.account_key ILIKE $${values.length}`
        + ` OR c.peer_key ILIKE $${values.length} OR c.display_name ILIKE $${values.length})`)
    }

    // 新粉 / 重粉：同一个客户被几个会话见过。
    // 「重粉」正是撞单信号 —— 同一个客户在别的账号/商户那里也出现过，
    // 这正是运营最需要先看到的那批人，所以放在列表里而不是藏进详情页。
    const seenCount = `(SELECT count(*) FROM conversations c2 WHERE c2.customer_id = c.customer_id)`
    const fanTypeExpr = `CASE WHEN c.customer_id IS NOT NULL AND ${seenCount} > 1 THEN '重粉' ELSE '新粉' END`
    if (data.type) {
      values.push(String(data.type))
      clauses.push(`${fanTypeExpr} = $${values.length}`)
    }

    const where = clauses.join(' AND ')
    const total = await repo.query(
      `SELECT count(*)::bigint AS total FROM conversations c JOIN users u ON u.id=c.user_id WHERE ${where}`, values)
    const rows = await repo.query(
      `SELECT c.id, COALESCE(u.username,'') AS username, c.platform,
              COALESCE(c.peer_key,'') AS account,
              COALESCE(c.display_name,'') AS nick_name,
              ${fanTypeExpr} AS fan_type,
              ${seenCount}::int AS seen_count,
              COALESCE(c.account_key,'') AS login_account,
              c.created_at AS create_time
         FROM conversations c
         JOIN users u ON u.id = c.user_id
        WHERE ${where}
        ORDER BY c.id DESC
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      values.concat([paging.size, paging.offset]))
    res.json(page(mapRows(rows.rows), total.rows[0].total, paging))
  }))

  function safeParse(value) {
    try {
      return JSON.parse(value)
    } catch (error) {
      throw new ApiError(400, '提交的数据不是合法 JSON', 'BAD_JSON')
    }
  }

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
    res.json(await packagesWithEngines())
  }))

  router.post('/admin/packages/save', asyncRoute(async (req, res) => {
    const data = input(req)
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
    // 套餐自带的子账号额度。企业账号不受它限制，但对个人账号它是
    // `users.sub_quota` 的发放来源（结算买套餐、新建商户两处都取它）。
    const subQuota = Math.max(0, Math.floor(Number(data.subQuota) || 0))
    const fields = {
      title,
      subtitle: String(data.subtitle || '').slice(0, 300),
      portLimit,
      portUnlimited: data.portUnlimited === undefined ? true : Boolean(Number(data.portUnlimited)),
      chars,
      price,
      subQuota,
      clients: parseJson(data.clients, {}, 'object'),
      features: parseJson(data.features, {}, 'object'),
      sortOrder: Math.max(0, Math.floor(Number(data.sortOrder) || 0))
    }

    const saved = await repo.transaction(async client => {
      let packageId = data.id ? Number(data.id) : null
      if (packageId) {
        const updated = await repo.query(
          `UPDATE packages SET title=$2,subtitle=$3,port_limit=$4,port_unlimited=$5,included_chars=$6,
                  price=$7,clients=$8::jsonb,features=$9::jsonb,sort_order=$10,sub_quota=$11,
                  updated_at=NOW()
           WHERE id=$1 RETURNING id`,
          [packageId, fields.title, fields.subtitle, fields.portLimit, fields.portUnlimited,
            fields.chars, fields.price, JSON.stringify(fields.clients), JSON.stringify(fields.features),
            fields.sortOrder, fields.subQuota], client
        )
        if (!updated.rows[0]) throw new ApiError(404, '套餐不存在', 'PACKAGE_NOT_FOUND')
      } else {
        const inserted = await repo.query(
          `INSERT INTO packages(code,title,subtitle,port_limit,port_unlimited,included_chars,price,clients,features,sort_order,sub_quota)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11) RETURNING id`,
          [code, fields.title, fields.subtitle, fields.portLimit, fields.portUnlimited,
            fields.chars, fields.price, JSON.stringify(fields.clients), JSON.stringify(fields.features),
            fields.sortOrder, fields.subQuota], client
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
    notices: 'site.notices',
    // 货币单位：官网价格显示要用，做成设置项而不是页面写死。
    // 刻意**没有**计费周期项 —— 本站按字符计费，没有按月/按年这回事，
    // 加一个周期设置等于凭空造出一个不存在的商业条款。
    currency: 'billing.currency',
    // 收款渠道。当前用 TRC20 USDT（跨境、无拒付、手续费低）。
    // 地址必须过 base58check 校验：填错 = 资金永久丢失、无法追回。
    paymentChannels: 'payment.channels'
  }

  const CURRENCIES = {
    USD: { symbol: '$', label: '美元 USD' },
    CNY: { symbol: '¥', label: '人民币 CNY' },
    HKD: { symbol: 'HK$', label: '港币 HKD' },
    JPY: { symbol: '¥', label: '日元 JPY' },
    EUR: { symbol: '€', label: '欧元 EUR' }
  }
  const DEFAULT_CURRENCY = 'USD'

  // 收款渠道默认值。只支持 TRC20 USDT：
  // 跨境客户用不了微信/支付宝，TRC20 手续费低（约 $1-3）、无拒付。
  const PAYMENT_NETWORKS = { TRC20: 'TRC20（波场）' }

  /**
   * TRC20 USDT 官方合约地址。
   *
   * **故意写成常量而不是后台配置项**：链上叫 "USDT" 的仿盘合约有很多，
   * 转进来同样数量但一文不值。把它做成可编辑的输入框，
   * 等于给"手滑改成仿盘合约"留了一扇门，而那种错误要到对账时才会发现。
   * 真需要换合约时改代码、走一次评审，比在后台点一下安全得多。
   */
  const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

  /** 充值订单有效期（分钟）。到期后不再接受自动匹配，迟到款进异常池。 */
  const RECHARGE_TTL_MINUTES = 30

  const PAYMENT_DEFAULTS = [
    { id: 'usdt-trc20', name: 'USDT', network: 'TRC20', address: '', note: '', enabled: 0 }
  ]

  async function readSettings() {
    const rows = (await repo.query('SELECT key,value FROM app_settings')).rows
    const byKey = rows.reduce((out, row) => { out[row.key] = row.value; return out }, {})
    const discounts = byKey['billing.discounts'] || {}
    const savedChannels = Array.isArray(byKey['payment.channels']) ? byKey['payment.channels'] : []
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
      lines: Array.isArray(byKey['service.lines']) ? byKey['service.lines'] : [],
      currency: CURRENCIES[byKey['billing.currency']] ? byKey['billing.currency'] : DEFAULT_CURRENCY,
      currencyOptions: Object.keys(CURRENCIES).map(code => ({ code, label: CURRENCIES[code].label })),
      // 收款渠道：把默认值和已保存的合并，保证新增字段能补上
      paymentChannels: PAYMENT_DEFAULTS.map(item => {
        const saved = savedChannels.find(row => row && row.id === item.id) || {}
        return Object.assign({}, item, {
          name: String(saved.name || item.name),
          network: 'TRC20',
          address: normalizeTronAddress(saved.address),
          // 合约地址跟着渠道一起下发，下单时快照进订单 —— 只认这一个合约
          tokenContract: USDT_TRC20_CONTRACT,
          note: String(saved.note || ''),
          enabled: Number(saved.enabled) ? 1 : 0
        })
      }),
      paymentNetworks: Object.keys(PAYMENT_NETWORKS).map(code => ({ code, label: PAYMENT_NETWORKS[code] }))
    }
  }

  router.get('/admin/settings', asyncRoute(async (_req, res) => {
    res.json(await readSettings())
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
      if (field === 'currency') {
        const text = String(value || '').trim().toUpperCase()
        if (!CURRENCIES[text]) {
          throw new ApiError(400, `不支持的货币单位：${text}`, 'BAD_CURRENCY')
        }
        value = text
      }
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
      if (field === 'paymentChannels') {
        const parsed = typeof value === 'string' ? safeParse(value) : value
        if (!Array.isArray(parsed)) throw new ApiError(400, '收款渠道必须是数组', 'BAD_PAYMENT_CHANNELS')
        value = parsed.map((item, index) => {
          const id = String((item && item.id) || `ch${index + 1}`)
          const address = normalizeTronAddress(item && item.address)
          const enabled = Number(item && item.enabled) ? 1 : 0
          // 地址一旦填了就必须能过校验和 —— 这是资金安全底线，不做"先存后改"
          if (address && !validTronAddress(address)) {
            throw new ApiError(400,
              `第 ${index + 1} 个收款地址不是合法的 TRC20 地址（校验和不匹配，请核对是否复制错字符）`,
              'BAD_PAYMENT_ADDRESS')
          }
          // 启用但没填地址 = 商户看到空地址，属于必然出事故的配置，直接拦下
          if (enabled && !address) {
            throw new ApiError(400, `第 ${index + 1} 个渠道已启用但没填收款地址`, 'PAYMENT_ADDRESS_REQUIRED')
          }
          return {
            id,
            name: String((item && item.name) || 'USDT').trim().slice(0, 40) || 'USDT',
            network: 'TRC20',
            address,
            note: String((item && item.note) || '').slice(0, 500),
            enabled
          }
        }).slice(0, 10)
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


  // ---- 验证码接口配置（后台「验证码接口」页）----------------------------------
  // 这一页管两件事：通道参数（重发间隔/有效期/位数），以及邮箱通道的 SMTP 凭据。
  //
  // 两个曾经真实存在的缺陷，都在这里修掉：
  //   1) 页面上的 SMTP 输入框（smtpHost/smtpPort/smtpSecure/smtpUser/smtpPass/smtpFrom）
  //      在保存时被整体丢弃 —— 只存了 id/provider/revealDemo/resendSeconds/expireMin/digits。
  //      管理员填完以为存上了，实际 mail.smtp 一直是空的。
  //   2) 读取时把状态写死成 wired=false / '未接通' / hasKey=false，
  //      无论真实配置如何都显示"未接入"，把真正的故障点藏了起来。
  // 现在：SMTP 字段真正落到 mail.smtp（与「邮件服务」页同一个键，单一事实来源），
  //      状态由 mailer 的真实配置推导，读不出来的原因（缺哪一项）直接回给页面。
  const VERIFY_DEFAULTS = [
    { id: 'email', name: '邮箱验证码', kind: '邮箱', provider: 'smtp', revealDemo: 0,
      resendSeconds: 60, expireMin: 10, digits: 6, note: '注册与找回密码的发信通道' },
    { id: 'sms', name: '短信验证码', kind: '短信', provider: 'local', revealDemo: 0,
      resendSeconds: 60, expireMin: 5, digits: 6, note: '短信通道未接入，保留配置位' }
  ]

  router.get('/admin/verify', asyncRoute(async (_req, res) => {
    const row = (await repo.query("SELECT value FROM app_settings WHERE key='verify.channels'")).rows[0]
    const saved = row && Array.isArray(row.value) ? row.value : []
    const byId = saved.reduce((out, item) => { if (item && item.id) out[item.id] = item; return out }, {})
    const settings = await repo.settings()
    const smtp = objectSetting(settings, 'mail.smtp', {})
    const cfg = await accounts.mailer.config()
    const ready = cfg.configured

    const rows = VERIFY_DEFAULTS.map(item => {
      const merged = Object.assign({}, item, byId[item.id] || {})
      if (item.id !== 'email') {
        return Object.assign(merged, {
          providerName: '本地 SVG（不发短信）', wired: false, wiredText: '未接通', hasKey: false
        })
      }
      return Object.assign(merged, {
        providerName: ready ? 'SMTP（已接通）' : 'SMTP（未接通）',
        wired: ready,
        wiredText: ready ? '已接通' : '未接通',
        // 密钥是否已填：看的是真实配置，不是写死的 false
        hasKey: Boolean(smtp.pass && smtp.user),
        smtpHost: smtp.host || '',
        smtpPort: Number(smtp.port) || 465,
        smtpSecure: smtp.secure === false ? 0 : 1,
        smtpUser: smtp.user || '',
        smtpFrom: smtp.from || '',
        // 口令永不回传明文，只回"已配置"
        smtpPass: smtp.pass ? '********' : '',
        missing: ready ? [] : cfg.missing
      })
    })

    res.json({
      rows,
      smtpReady: ready,
      note: ready
        ? 'SMTP 已接通，注册与找回密码可正常发信'
        : 'SMTP 未接通，缺少：' + (cfg.missing.join('、') || '未知') +
          '。补齐后注册与找回密码立即生效。'
    })
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
      // 前端字段名叫 length，接口此前只认 digits —— 位数设置也被静默丢了。两个都收。
      digits: Math.min(8, Math.max(4, Math.floor(Number(data.digits || data.length) || 6)))
    }
    const index = saved.findIndex(item => item && item.id === id)
    if (index >= 0) saved[index] = entry
    else saved.push(entry)
    await repo.query(
      `INSERT INTO app_settings(key,value,description) VALUES('verify.channels',$1::jsonb,'验证码通道配置')
       ON CONFLICT (key) DO UPDATE SET value=$1::jsonb`,
      [JSON.stringify(saved)]
    )

    // 邮箱通道选 SMTP 时，把页面上那几个 SMTP 字段真正写进 mail.smtp。
    // 留空的字段沿用原值 —— 否则管理员只改端口会把主机和口令一起清掉。
    let smtpSaved = false
    if (id === 'email' && entry.provider === 'smtp') {
      const settings = await repo.settings()
      const current = objectSetting(settings, 'mail.smtp', {})
      const secureRaw = data.smtpSecure
      const keep = secureRaw === undefined || secureRaw === ''
      const nextPass = String(data.smtpPass || '').trim()
      const smtp = {
        host: String(data.smtpHost || '').trim() || current.host || '',
        port: Number(data.smtpPort) || current.port || 465,
        secure: keep ? current.secure !== false
          : !(secureRaw === 0 || secureRaw === '0' || secureRaw === false || secureRaw === 'false'),
        user: String(data.smtpUser || '').trim() || current.user || '',
        // 掩码或留空都表示"不改口令"
        pass: (!nextPass || nextPass === '********') ? (current.pass || '') : nextPass,
        from: String(data.smtpFrom || '').trim() || current.from || '',
        fromName: String(current.fromName || 'Hello Pix').trim()
      }
      await repo.transaction(async client => {
        await repo.query(
          `INSERT INTO app_settings(key,value,description) VALUES($1,$2::jsonb,$3)
           ON CONFLICT (key) DO UPDATE SET value=$2::jsonb`,
          ['mail.smtp', JSON.stringify(smtp), 'SMTP 服务器配置'], client
        )
        await repo.query(
          `INSERT INTO app_settings(key,value,description) VALUES('mail.enabled','true'::jsonb,'邮件服务总开关')
           ON CONFLICT (key) DO UPDATE SET value='true'::jsonb`, [], client
        )
        await repo.audit(client, req.pixAdmin, '配置验证码通道（含 SMTP）',
          `${id} / ${entry.provider} / ${smtp.host || '(空主机)'}`, req.ip, { type: 'verify', id })
      })
      smtpSaved = true
    } else {
      await repo.audit(null, req.pixAdmin, '配置验证码通道', JSON.stringify(entry), req.ip, { type: 'verify', id })
    }

    const cfg = await accounts.mailer.config()
    ok(res, smtpSaved
      ? (cfg.configured ? '已保存，SMTP 已接通' : '已保存，但 SMTP 仍未就绪：缺少 ' + cfg.missing.join('、'))
      : '已保存')
  }))

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
