'use strict'

/**
 * 充值订单的**套餐权益发放**。
 *
 * ## 为什么需要它
 *
 * 生产上商户付了 35 USDT 的基础版、订单也记着 `package_id=1`，
 * 但到账之后 `users.package_id` 仍然是 NULL。结果是三个连锁症状：
 *
 *   · 商户端首页「套餐」一栏空白（`packageTitle` 由 `LEFT JOIN packages` 得来）
 *   · 通道权益为空 —— 套餐不带通道，翻译会被拒
 *   · 子账号额度为 0，一个子账号都开不出来
 *
 * 根因是**结算只加字符、从不发套餐**：`RechargeSettlementService.creditOrder`
 * 与 `/admin/recharges/status` 两处都只调 `adjustChars`，谁都没碰 `users`。
 * 于是"买套餐"这件事在账上只留下字符，套餐本身从来没有落地。
 *
 * 这个服务把那一步补上，并作为**唯一落点**：链上自动入账与超管手工确认
 * 共用同一份逻辑，避免"自动入账发了套餐、手工确认没发"这类分叉。
 *
 * ## 什么订单才发
 *
 * 只发 `kind='package'` 且带 `package_id` 的订单。纯字符充值（`characters`）
 * 与后台赠送（`manual`，含注册试用）**不改套餐** —— 那两类订单的
 * `package_id` 要么为空、要么只是记账用，拿它改商户套餐会误伤。
 *
 * ## 幂等
 *
 * 本方法**自身不做幂等判断**，由调用方保证只调一次 —— 两个调用点都满足：
 *
 *   · `creditOrder`：订单行 `FOR UPDATE` 后，`status === PAID` 直接 return
 *   · `/admin/recharges/status`：同一处 `status === PAID` 短路
 *
 * 也就是说"置为已支付"与"发放权益"在同一个事务里、且只在状态跃迁时发生。
 * 这不是可以省略的前提：重复调用的后果是 `expires_at` 被再延长一个月。
 *
 * ## 到期时间怎么算
 *
 * 从**当下与现有到期时间里的较晚者**起算，加 `quantity` 个月。
 *
 *   · 用 `GREATEST` 而不是直接 `now()`：提前续费不该把剩余天数吞掉
 *   · `quantity` 就是下单时的月数（`core.quote` 的 `qty`），
 *     所以买 3 个月就是 +3 个月
 */

/** 只有整包套餐订单会带权益 */
const PACKAGE_KIND = 'package'

class RechargeEntitlement {
  constructor(repo, options) {
    const opts = options || {}
    this.repo = repo
    this.engineResolver = opts.engineResolver || null
  }

  /** 这笔订单该不该发套餐权益 */
  static isPackageOrder(order) {
    if (!order) return false
    if (String(order.kind || '') !== PACKAGE_KIND) return false
    const id = order.packageId
    return id !== null && id !== undefined && String(id) !== ''
  }

  /**
   * 默认翻译通道：只在商户**还没有**指定通道时补一个。
   *
   * 已有值一律不覆盖 —— 那是用户自己选的，结算没理由改它。
   * 优先取后台设置的默认通道，其次取该套餐里第一个「已启用且已接通」的。
   * 都取不到就留 NULL（客户端会退回它自己拿到的可用列表）。
   */
  async defaultEngine(packId) {
    if (this.engineResolver) return this.engineResolver(packId)
    const settings = await this.repo.settings()
    const configured = String(settings['translation.active_engine'] || '').trim()
    if (configured) return configured
    const usable = await this.repo.packageEngines(packId)
    const picked = usable.find(row => row.enabled && row.wired)
    return (picked && picked.id) || null
  }

  /**
   * 按订单发放套餐权益。**调用方必须已在事务里，且必须在同一事务里提交。**
   *
   * @param {object} client 事务连接
   * @param {object} order  `recharges` 行（mapRow 之后的驼峰对象）
   * @param {object} [context] `{ at }` 结算时刻，默认 now
   * @returns {Promise<{granted:boolean, reason?:string, username?:string,
   *   packageId?:number, subQuota?:number, months?:number, expiresAt?:Date}>}
   */
  async grantFromOrder(client, order, context) {
    const ctx = context || {}
    if (!RechargeEntitlement.isPackageOrder(order)) {
      return { granted: false, reason: 'NOT_PACKAGE_ORDER' }
    }

    const pack = await this.repo.package(order.packageId)
    if (!pack) {
      // 不一致就报错而不是静默跳过：订单指向的套餐被删了，
      // 商户付了钱却没东西可发，必须让人看见，不能悄悄吞掉。
      throw new Error(
        `订单 ${order.orderNumber} 指向的套餐 ${order.packageId} 已不存在，无法发放权益`)
    }

    const locked = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [String(order.userId)])
    const user = locked.rows[0]
    if (!user) {
      throw new Error(`订单 ${order.orderNumber} 的商户 ${order.userId} 不存在，无法发放权益`)
    }

    const at = ctx.at ? new Date(ctx.at) : new Date()
    const months = Math.max(1, Math.floor(Number(order.quantity) || 1))
    // 权益版本优先用**下单时钉在订单上**的那一版 —— 客户是按当时那版付的钱。
    // 早期订单没存才退回套餐当前版本。
    const catalogVersion = Number(order.packageCatalogVersion) || Number(pack.catalogVersion) || null
    const packageSubQuota = Math.max(0, Math.floor(Number(pack.subQuota) || 0))
    const packagePortLimit = Math.max(0, Math.floor(Number(pack.portLimit) || 0))
    const engine = user.active_engine_id ? null : await this.defaultEngine(pack.id)

    /**
     * 两个"只在套餐真的规定了才覆盖"的字段。
     *
     * 套餐的 `port_limit` / `sub_quota` 可以是 0（当前三档套餐的 port_limit 就全是 0），
     * 而超管可能已经手工给这家商户调过额度。直接赋值会把这些**人工设定清零**，
     * 属于"结一次账把他人的配置抹掉"。所以 0 一律视为"套餐没规定"，保持原值。
     */
    const { rows } = await client.query(
      `UPDATE users u
          SET package_id = $2,
              port_limit = CASE WHEN $3::int > 0 THEN $3::int ELSE u.port_limit END,
              sub_quota = CASE
                            WHEN u.enterprise THEN u.sub_quota
                            WHEN $4::int > 0 THEN $4::int
                            ELSE u.sub_quota
                          END,
              package_catalog_version = COALESCE($5::int, u.package_catalog_version),
              active_engine_id = COALESCE(u.active_engine_id, $6),
              expires_at = GREATEST(COALESCE(u.expires_at, $7::timestamptz), $7::timestamptz)
                           + ($8::int * interval '1 month'),
              updated_at = $7::timestamptz
        WHERE u.id = $1
        RETURNING u.id, u.username, u.package_id, u.port_limit, u.sub_quota,
                  u.package_catalog_version, u.active_engine_id, u.expires_at`,
      [
        String(order.userId), String(pack.id), packagePortLimit, packageSubQuota,
        catalogVersion, engine, at.toISOString(), months
      ]
    )
    const granted = rows[0]

    await this.repo.audit(client, null, '发放套餐权益',
      `${granted.username} 套餐「${pack.title}」×${months} 个月，`
      + `子账号额度 ${granted.sub_quota}，到期 ${new Date(granted.expires_at).toISOString()}`
      + `（订单 ${order.orderNumber}）`,
      null, { type: 'user', id: order.userId })

    return {
      granted: true,
      userId: Number(order.userId),
      username: granted.username,
      packageId: Number(granted.package_id),
      packageTitle: pack.title,
      months,
      subQuota: Number(granted.sub_quota),
      portLimit: Number(granted.port_limit),
      catalogVersion: Number(granted.package_catalog_version) || null,
      expiresAt: granted.expires_at
    }
  }
}

module.exports = { RechargeEntitlement, PACKAGE_KIND }
