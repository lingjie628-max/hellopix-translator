'use strict'

/**
 * 商户端下单（`/userRecharge/create`）。
 *
 * ## 为什么单独抽出来
 *
 * 这是**资金主路径**：算错一分钱，链上就对不上，钱进异常池等人工捞。
 * 它原本是 `production.js` 里一条 113 行的路由，读起来要同时想五件事：
 * 权限、报价、收款渠道、金额尾数分配、订单快照。
 *
 * 抽出来的**唯一目的是可测** —— 这条路上每条注释都写着"踩过"，
 * 而踩过的坑只有真跑才能防住。路由里那层 res.json 的字段拼装留在原处
 * （它跟前端契约绑定，不属于业务规则）。
 *
 * ## 三个"踩过"的坑，一个都不能丢
 *
 * 1. **金额全程 milli 整数，不碰浮点**
 *    `parseMilli` 而不是 `toMilli`：`quote.paidMilli` 已经是「毫」，
 *    用 `toMilli` 会再乘 1000 —— 订单金额静默放大一千倍。
 *
 * 2. **金额文本只能从 milli 格式化，不能从 mapRow 反推**
 *    `mapRow` 会把 numeric 转成 JS Number（36.157），
 *    而 `formatMilli` 只接受整数毫 —— 喂进去直接抛
 *    `Cannot convert 36.157 to a BigInt`。
 *    精确值只有一份：事务里的 milli。
 *
 * 3. **金额文本必须从事务里带出来**
 *    它们在回调作用域内，出去再用就是 `ReferenceError`。
 *
 * ## 为什么这里不写 audit
 *
 * `audit_logs.admin_id` 有指向 `admins` 的外键。商户下单不是超管操作，
 * 写进去会外键冲突。下单本身在 `recharges` 表里已有完整记录
 * （时间 / 金额 / 状态 / 地址快照），足以追溯。
 */

const crypto = require('crypto')
const { parseMilli, formatMilli } = require('../lib/money')
const { ApiError } = require('../lib/http')
const { mapRow } = require('../repositories/production-repository')
const { USDT_TRC20_CONTRACT } = require('./tron/transfer')

/** 充值订单有效期（分钟）。到期后不再接受自动匹配，迟到款进异常池。 */
const RECHARGE_TTL_MINUTES = 30

class RechargeOrderService {
  /**
   * @param {object} deps
   * @param {object} deps.repo          ProductionRepository
   * @param {object} deps.core          CoreService（报价）
   * @param {object} deps.rechargeAmount RechargeAmountService（尾数分配）
   * @param {object} deps.settings      SettingsService（收款渠道）
   */
  constructor({ repo, core, rechargeAmount, settings }) {
    this.repo = repo
    this.core = core
    this.rechargeAmount = rechargeAmount
    this.settings = settings
  }

  /**
   * 下单。
   *
   * @param {object} params
   * @param {object} params.user     req.pixUser
   * @param {object} params.data     请求体
   * @returns {Promise<object>} 前端需要的全部字段（不含 HTTP 层包装）
   */
  async create({ user, data }) {
    // 充值涉及资金，只允许主账号操作；子账号需让主账号来充
    if (user.kind !== 'main') {
      throw new ApiError(403, '仅主账号可发起充值', 'MAIN_ACCOUNT_REQUIRED')
    }

    const quote = await this.core.quote({
      baseid: data.baseid || data.id,
      month: data.month || data.qty
    })
    const pack = await this.repo.package(data.baseid || data.id)
    if (!pack) throw new ApiError(404, '套餐不存在', 'PACKAGE_NOT_FOUND')

    // 收款渠道未启用/未填地址时拒绝下单，避免商户拿到空地址
    const channels = await this.settings.paymentChannels()
    if (!channels.length) {
      throw new ApiError(503, '收款方式尚未配置，请联系客服', 'PAYMENT_NOT_CONFIGURED')
    }
    const channel = channels.find(item => item.id === String(data.channelId || '')) || channels[0]

    const { order, originalText, discountText, surchargeText, paidText } =
      await this.repo.transaction(async client => {
        const now = new Date()
        // 有效期 30 分钟。到期后金额仍被保护 24 小时（见 recharge-amount-service），
        // 保护期内到账的迟到款会被识别成"原订单的迟到款"而不是新订单的钱。
        const expiresAt = new Date(now.getTime() + RECHARGE_TTL_MINUTES * 60 * 1000)

        // 金额全部走 milli-USDT 整数，**不经过任何浮点**。
        // quote.paidMilli 是折后价（字符串形式的毫），尾数直接加在整数上。
        // 注意用 parseMilli 而不是 toMilli：paidMilli 已经是「毫」，
        // 用 toMilli 会再乘 1000，订单金额静默放大一千倍（踩过）
        const baseMilli = parseMilli(quote.paidMilli)
        const allocation = await this.rechargeAmount.allocate(client, {
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
        const originalText = formatMilli(quote.originalMilli)     // 标准价，不含尾数
        const discountText = formatMilli(quote.discountMilli)     // 折扣
        const surchargeText = formatMilli(allocation.suffixMilli) // 尾数（0.001–0.999）
        const paidText = formatMilli(allocation.amountMilli)      // 实付 = 标准价 − 折扣 + 尾数

        const orderNumber = `HP${Date.now()}${crypto.randomInt(100, 999)}`
        const created = await client.query(
          `INSERT INTO recharges(user_id,package_id,order_number,kind,payment_type,quantity,chars,
           original_amount,discount_amount,surcharge_amount,paid_amount,status,idempotency_key,
           expires_at,pay_address,pay_token_contract,amount_reservation_id,package_catalog_version)
           VALUES($1,$2,$3,'package',$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13,$14,$15,$16) RETURNING *`,
          [user.parent.id, pack.id, orderNumber, `USDT-${channel.network}`,
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
        await this.rechargeAmount.attachToRecharge(client, allocation.reservationId, created.rows[0].id)

        // 金额文本必须从事务里带出来：它们在回调作用域内，
        // 直接在外面用会 ReferenceError（踩过）
        return {
          order: mapRow(created.rows[0]),
          originalText, discountText, surchargeText, paidText
        }
      })

    return {
      order,
      pack,
      channel,
      originalText,
      discountText,
      surchargeText,
      paidText,
      expiresInMinutes: RECHARGE_TTL_MINUTES,
      tokenContract: USDT_TRC20_CONTRACT
    }
  }
}

module.exports = { RechargeOrderService, RECHARGE_TTL_MINUTES }
