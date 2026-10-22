'use strict'

/**
 * 金额预约：随机尾数的分配、唯一性、以及 **24 小时复用保护**。
 *
 * ## 两道防线
 *
 * | 防线 | 位置 | 挡住什么 |
 * | --- | --- | --- |
 * | 唯一索引 `(地址, 合约, 金额) WHERE state='held'` | 数据库 | 并发下两张订单拿到同一金额 |
 * | `reusable_after` 保护期 | 本服务 | 订单结束后金额被立刻复用，导致迟到款错配 |
 *
 * 只靠第一道不够 —— 订单一旦进终态，`held` 就结束了，
 * 金额立刻可被下一张订单占用。而链上确认有延迟：
 *
 *   T+00:29  用户转出 35.427（订单 A 还有 1 分钟到期）
 *   T+00:31  订单 A 过期，金额释放
 *   T+00:32  订单 B 随机到 35.427，占用成功
 *   T+00:35  链上确认 → **记到订单 B 头上**，订单 A 永远未支付
 *
 * 两张单全错，且毫无声响。保护期把「释放」推迟 24 小时，
 * 让这段时间内到达的 35.427 只能被识别为**订单 A 的迟到款**。
 *
 * ## 全整数
 *
 * 所有金额都是 milli-USDT 的 BigInt（见 lib/money.js）。
 * 尾数 1–999 直接加在整数上，**没有任何浮点参与**。
 *
 * ## 绝不降级
 *
 * 池满时抛 `AMOUNT_POOL_EXHAUSTED`，**不回退 000、不顺序 +1、不绕过约束**。
 * 旧实现在重试 200 次后会静默把尾数置 0（等于用标准价下单），
 * 那会让两张订单拿到同一金额，且不报任何错 —— 已删除。
 */

const crypto = require('node:crypto')
const { ApiError } = require('../lib/http')
const { MILLI_PER_UNIT, isValidSuffixMilli } = require('../lib/money')

const SUFFIX_MIN = 1
const SUFFIX_MAX = 999
/** 尾数池容量：001–999 */
const POOL_SIZE = SUFFIX_MAX - SUFFIX_MIN + 1
const DEFAULT_PROTECTION_HOURS = 24
/**
 * 随机碰撞的重试次数。
 *
 * 池子接近满时随机命中率会下降，所以重试失败后**不是直接放弃**，
 * 而是切到精确补集扫描（见 allocate）。这个数字只影响快路径的命中率，
 * 不影响正确性。
 */
const RANDOM_ATTEMPTS = 24

/** BigInt → pg 能安全接收的字符串 */
function sqlInt(value) {
  return BigInt(value).toString()
}

/**
 * 毫金额 → `recharges.paid_amount` 能直接比较的 numeric 字面量。
 *
 * 绝不能写 `BigInt / 1000`：整数除法会把 0.526 变成 0，
 * 于是"查这个金额有没有被占用"永远查不到，去重形同虚设。
 */
function formatAmountForQuery(amountMilli) {
  const milli = BigInt(amountMilli)
  const negative = milli < 0n
  const abs = negative ? -milli : milli
  const text = `${abs / 1000n}.${String(abs % 1000n).padStart(3, '0')}`
  return negative ? `-${text}` : text
}

class RechargeAmountService {
  constructor(options) {
    const opts = options || {}
    this.protectionHours = Number.isFinite(opts.protectionHours)
      ? Number(opts.protectionHours)
      : DEFAULT_PROTECTION_HOURS
    // 便于测试注入确定的随机源；生产走 crypto
    this.randomSuffix = opts.randomSuffix || (() => crypto.randomInt(SUFFIX_MIN, SUFFIX_MAX + 1))
  }

  /** 保护期截止时刻 = 起算点 + protectionHours */
  protectionDeadline(from) {
    const base = from instanceof Date ? from : new Date(from)
    return new Date(base.getTime() + this.protectionHours * 3600 * 1000)
  }

  /**
   * 懒释放：把已过保护期的 held 预约改成 released。
   *
   * 为什么用懒释放而不是纯靠定时任务：
   * 定时任务可能延迟、可能没跑。如果分配依赖它，"池子看起来满了"
   * 就会成为一个假象 —— 明明有到期的可以复用，却报池满。
   * 分配前顺手释放一次，代价是一条 UPDATE，收益是池子状态永远自洽。
   *
   * @returns {number} 本次释放的条数
   */
  async releaseExpired(client, { payAddress, tokenContract, now }) {
    const result = await client.query(
      `UPDATE recharge_amount_reservations
          SET state = 'released',
              released_at = $3::timestamptz,
              released_reason = 'protection_expired'
        WHERE pay_address = $1
          AND pay_token_contract = $2
          AND state = 'held'
          AND reusable_after <= $3::timestamptz`,
      [payAddress, tokenContract, (now || new Date()).toISOString()]
    )
    return result.rowCount || 0
  }

  /**
   * 占用一个唯一金额。
   *
   * **必须在调用方的事务里执行** —— 预约与订单要么一起成立，要么一起回滚。
   * 否则会出现"金额被占住但没有订单"的孤儿预约，白占池子 24 小时。
   *
   * @returns {{reservationId: bigint, suffixMilli: bigint, amountMilli: bigint}}
   */
  async allocate(client, { payAddress, tokenContract, baseAmountMilli, expiresAt, now }) {
    const base = BigInt(baseAmountMilli)
    const at = now instanceof Date ? now : new Date()
    // 保护期从 expires_at 起算：订单临到期才转账、确认又慢，这段时间必须被覆盖
    const reusableAfter = this.protectionDeadline(expiresAt || at)

    // ① 先释放到点的，避免"假池满"
    await this.releaseExpired(client, { payAddress, tokenContract, now: at })

    // ② 快路径：随机试
    for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt++) {
      const suffixMilli = BigInt(this.randomSuffix())
      if (!isValidSuffixMilli(suffixMilli)) {
        // 随机源坏了要立刻暴露，不能悄悄用一个非法尾数
        throw new ApiError(500, `随机尾数越界：${suffixMilli}`, 'BAD_SUFFIX_SOURCE')
      }
      const inserted = await this.tryInsert(client, {
        payAddress, tokenContract, base, suffixMilli, reusableAfter
      })
      if (inserted) return inserted
      // 冲突 → 换一个随机数重来。**绝不 +1**：顺序递增会让尾数可预测
    }

    // ③ 慢路径：精确算出还有哪些空位。
    //    池子接近满时随机命中率低，靠随机试会假报池满。
    for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt++) {
      const free = await this.freeAmounts(client, { payAddress, tokenContract, base })
      if (!free.length) {
        throw new ApiError(503,
          `当前收款地址的可用金额已用尽（${POOL_SIZE} 个尾数全部占用或在保护期内），请稍后重试`,
          'AMOUNT_POOL_EXHAUSTED')
      }
      const picked = free[this.pickIndex(free.length)]
      const inserted = await this.tryInsert(client, {
        payAddress, tokenContract, base, suffixMilli: picked - base, reusableAfter
      })
      if (inserted) return inserted
      // 并发对手抢先占了这个空位，重新算一次
    }

    throw new ApiError(503,
      '可用金额分配竞争过于激烈，请稍后重试',
      'AMOUNT_POOL_EXHAUSTED')
  }

  pickIndex(length) {
    if (length <= 1) return 0
    return crypto.randomInt(0, length)
  }

  /** 插入一条 held 预约；撞唯一索引返回 null（不是错误，是正常的碰撞） */
  async tryInsert(client, { payAddress, tokenContract, base, suffixMilli, reusableAfter }) {
    const amountMilli = base + suffixMilli

    // 先查 `recharges` 的全局唯一约束。
    //
    // 预约表的唯一索引只覆盖 (地址, 币种, 金额)，而订单表是**全站唯一金额**。
    // 不做这一步的话，随机尾数有概率撞上"别的地址的待支付单"，
    // 而 `ON CONFLICT` 管不到另一张表 —— 冲突会一路冒到 INSERT recharges
    // 变成 23505 / 500。查询开销远小于一次失败回滚 + 用户看到报错。
    const taken = await client.query(
      `SELECT 1 FROM recharges
        WHERE status = 0 AND paid_amount = $1::numeric LIMIT 1`,
      [formatAmountForQuery(amountMilli)]
    )
    if (taken.rows[0]) return null

    const result = await client.query(
      `INSERT INTO recharge_amount_reservations
         (pay_address, pay_token_contract, amount_milli, suffix, reusable_after)
       VALUES ($1, $2, $3::bigint, $4::smallint, $5::timestamptz)
       ON CONFLICT (pay_address, pay_token_contract, amount_milli) WHERE state = 'held'
       DO NOTHING
       RETURNING id`,
      [
        payAddress,
        tokenContract,
        sqlInt(amountMilli),
        Number(suffixMilli),
        reusableAfter.toISOString()
      ]
    )
    if (!result.rows[0]) return null
    return { reservationId: result.rows[0].id, suffixMilli, amountMilli }
  }

  /**
   * 精确算出 base+1 .. base+999 里还有哪些金额没被 held。
   *
   * 按**金额**而不是按下标算：不同套餐的基数不同，
   * 理论上存在「A 套餐的尾数 999」与「B 套餐的尾数 1」撞上同一金额的可能，
   * 按下标算会漏掉这种跨套餐冲突。
   */
  async freeAmounts(client, { payAddress, tokenContract, base }) {
    const upper = base + BigInt(SUFFIX_MAX)
    // ## 为什么必须同时查 `recharges`，不能只看自己的预约表
    //
    // 两边的唯一约束**粒度不一样**：
    //
    //   recharge_amount_reservations_held_uq  (pay_address, pay_token_contract, amount_milli)
    //   recharges_pending_amount_uq           (payment_type, paid_amount)  ← 全站唯一
    //
    // 预约表按收款地址隔离，订单表却是**全站唯一金额**。只看预约表的话，
    // 地址 A 分配的尾数完全不知道地址 B 已经占了这个金额 —— 于是
    // `allocate` 高高兴兴返回一个 number，插进 `recharges` 时撞 23505。
    //
    // 这不是测试环境的偶然：只要有两个以上在用的收款地址、且同一时间
    // 有足够多的待支付单，尾数池就会重叠。真实后果是**用户付款后匹配到
    // 别人的订单**——只不过那一步之前会先被唯一约束拦下来变成 500。
    //
    // 所以这里把订单表里仍在等待支付的金额也当成"已占用"。
    const { rows } = await client.query(
      `SELECT amount_milli FROM recharge_amount_reservations
        WHERE pay_address = $1 AND pay_token_contract = $2 AND state = 'held'
          AND amount_milli > $3::bigint AND amount_milli <= $4::bigint
       UNION
       SELECT (paid_amount * 1000)::bigint FROM recharges
        WHERE status = 0
          AND paid_amount > $5::numeric AND paid_amount <= $6::numeric`,
      [
        payAddress, tokenContract, sqlInt(base), sqlInt(upper),
        // numeric 侧用人类可读金额比较。**不能用 Number(base)/1000**：
        // 浮点会把 40.566 变成 40.56599999…，闭区间边界就可能漏掉一档。
        formatAmountForQuery(base),
        formatAmountForQuery(upper)
      ]
    )
    const taken = new Set(rows.map(row => String(row.amount_milli)))
    const free = []
    for (let suffix = SUFFIX_MIN; suffix <= SUFFIX_MAX; suffix++) {
      const amount = base + BigInt(suffix)
      if (!taken.has(String(amount))) free.push(amount)
    }
    return free
  }

  /**
   * 订单进入终态时延长保护期。
   *
   * 用 GREATEST 而不是覆盖：
   * 提前结束的订单（比如 5 分钟就付款成功）若把保护期缩短成「付款后 24 小时」，
   * 那么 T+29 分钟才发出的迟到转账在 T+24h 后就失去归属、可能撞上新订单。
   * 以 `expires_at + 24h` 为下界，覆盖「临到期才转账、确认又慢」的整段时间。
   */
  async extendProtection(client, reservationId, at) {
    if (!reservationId) return null
    const deadline = this.protectionDeadline(at || new Date())
    await client.query(
      `UPDATE recharge_amount_reservations
          SET reusable_after = GREATEST(reusable_after, $2::timestamptz)
        WHERE id = $1`,
      [String(reservationId), deadline.toISOString()]
    )
    return deadline
  }

  /** 订单创建后回填归属（预约先于订单插入，同一事务内完成） */
  async attachToRecharge(client, reservationId, rechargeId) {
    await client.query(
      'UPDATE recharge_amount_reservations SET recharge_id = $2 WHERE id = $1',
      [String(reservationId), String(rechargeId)]
    )
  }

  /**
   * 按 (地址, 合约, 金额) 反查归属 —— 链上到账匹配的入口。
   *
   * **包含已 released 的历史行**：这正是迟到款能找回原订单的依据。
   * 只查 held 的话，保护期外的老订单就彻底查不到了。
   *
   * @returns {object|null} 最近一条预约（含 recharge_id 与 state）
   */
  async lookupByAmount(client, { payAddress, tokenContract, amountMilli }) {
    const { rows } = await client.query(
      `SELECT r.id, r.recharge_id, r.state, r.suffix, r.amount_milli,
              r.reserved_at, r.reusable_after, r.released_at, r.released_reason
         FROM recharge_amount_reservations r
        WHERE r.pay_address = $1
          AND r.pay_token_contract = $2
          AND r.amount_milli = $3::bigint
        ORDER BY r.reserved_at DESC
        LIMIT 1`,
      [payAddress, tokenContract, sqlInt(amountMilli)]
    )
    return rows[0] || null
  }

  /**
   * 某个基数下已占用多少尾数 —— 用于诊断与「池子还剩多少」的展示。
   * 也用于测试断言池满。
   */
  async heldCount(client, { payAddress, tokenContract, baseAmountMilli }) {
    const base = BigInt(baseAmountMilli)
    const { rows } = await client.query(
      `SELECT count(*)::int AS n
         FROM recharge_amount_reservations
        WHERE pay_address = $1
          AND pay_token_contract = $2
          AND state = 'held'
          AND amount_milli > $3::bigint
          AND amount_milli <= $4::bigint`,
      [payAddress, tokenContract, sqlInt(base), sqlInt(base + BigInt(SUFFIX_MAX))]
    )
    return rows[0].n
  }
}

module.exports = {
  RechargeAmountService,
  SUFFIX_MIN,
  SUFFIX_MAX,
  POOL_SIZE,
  DEFAULT_PROTECTION_HOURS,
  MILLI_PER_UNIT
}
