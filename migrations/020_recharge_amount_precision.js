/**
 * 充值金额精度：numeric(14,2) → numeric(14,3)，并重写金额校验式。
 *
 * ## 为什么必须改
 *
 * RC-02 要按「标准价 + 三位随机尾数」生成应付金额（35.000 → 35.427），
 * 但原表有三处直接冲突，在生产库上实测确认：
 *
 *   1. `paid_amount numeric(14,2)` —— `35.427` 存进去变成 **35.43**，尾数被抹掉。
 *      尾数被抹掉 = 订单失去唯一标识 = 自动匹配彻底失效。
 *
 *   2. `CHECK (paid_amount <= original_amount)` —— 应付 35.427 > 标准价 35.000，
 *      **INSERT 直接被拒**。
 *
 *   3. `CHECK (original_amount - discount_amount = paid_amount)` ——
 *      尾数加在 paid 上破坏等式；加在 original 上则污染「标准价」这个语义。
 *      旧代码选了后者：`originalAmount = round2(quote.originalPrice + suffix)`，
 *      于是 `original_amount` 不再是套餐标准价，对账时看不出原价是多少。
 *
 * ## 改成什么
 *
 * 把尾数拆成**独立可见的列**，让三个金额各司其职：
 *
 *   original_amount   标准价（如 35.000）—— 永远是套餐价，不含尾数
 *   discount_amount   折扣（如 3.500）
 *   surcharge_amount  随机尾数（0.001–0.999）
 *   paid_amount       实际应付 = original - discount + surcharge
 *
 * 这样对账时一眼能看出「原价多少、折了多少、尾数多少、实付多少」，
 * 而不是像旧写法那样把尾数混进原价里。
 *
 * ## 精度与浮点
 *
 * 数据库侧用 numeric(14,3) —— 精确十进制，不是浮点。
 * 业务侧一律走 `server/lib/money.js` 的 milli-USDT 整数 helper，
 * **禁止 parseFloat 后计算**（0.1+0.2 !== 0.3 这类误差在金额上不可接受）。
 */

const PRECISION_OLD = 'numeric(14,2)'
const PRECISION_NEW = 'numeric(14,3)'

exports.up = async pgm => {
  // 1. 三个金额列升到 3 位小数
  await pgm.db.query(`
    ALTER TABLE recharges
      ALTER COLUMN original_amount TYPE ${PRECISION_NEW},
      ALTER COLUMN discount_amount TYPE ${PRECISION_NEW},
      ALTER COLUMN paid_amount     TYPE ${PRECISION_NEW}
  `)

  // 2. 新增尾数列。默认 0 保证存量行（含 manual/grant）语义不变
  await pgm.db.query(`
    ALTER TABLE recharges
      ADD COLUMN IF NOT EXISTS surcharge_amount ${PRECISION_NEW} NOT NULL DEFAULT 0
  `)

  // 3. 删掉两个与尾数方案冲突的 CHECK。
  //    用 IF EXISTS：这两个是 PostgreSQL 自动命名的（check1/check2），
  //    名字依赖建表时的顺序，写死会在结构略有差异的库上炸。
  await pgm.db.query('ALTER TABLE recharges DROP CONSTRAINT IF EXISTS recharges_check1')
  await pgm.db.query('ALTER TABLE recharges DROP CONSTRAINT IF EXISTS recharges_check2')

  // 4. 新的金额约束
  await pgm.db.query(`
    ALTER TABLE recharges
      ADD CONSTRAINT recharges_surcharge_range_check
        CHECK (surcharge_amount >= 0 AND surcharge_amount < 1)
  `)
  await pgm.db.query(`
    ALTER TABLE recharges
      ADD CONSTRAINT recharges_amount_identity_check
        CHECK (paid_amount = original_amount - discount_amount + surcharge_amount)
  `)

  // 5. 尾数唯一性的第一道防线：同一收款地址 + 同一应付金额，
  //    在「未支付」状态下只能有一单。
  //    第二道防线（含 24 小时保护期）在 022 的预约表里。
  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS recharges_pending_amount_uq
      ON recharges (payment_type, paid_amount)
      WHERE status = 0
  `)

  // 6. 把存量行的 surcharge 补成 0 之外的真实差额（当前 recharges 为空，是防御性写法）
  await pgm.db.query(`
    UPDATE recharges
       SET surcharge_amount = paid_amount - (original_amount - discount_amount)
     WHERE surcharge_amount = 0
       AND paid_amount <> original_amount - discount_amount
  `)
}

exports.down = async pgm => {
  // 回退会丢精度：3 位尾数是订单的唯一标识，四舍五入到 2 位后
  // 不同订单可能撞成同一个金额。所以有非零尾数时**拒绝回退**，
  // 而不是静默把数据改坏。
  const { rows } = await pgm.db.query(
    'SELECT count(*)::int AS n FROM recharges WHERE surcharge_amount <> 0'
  )
  if (rows[0].n > 0) {
    throw new Error(
      `有 ${rows[0].n} 条订单带非零尾数，回退到 2 位小数会让不同订单撞成同一金额。` +
      '请先人工处理这些订单再回退。'
    )
  }

  await pgm.db.query('DROP INDEX IF EXISTS recharges_pending_amount_uq')
  await pgm.db.query('ALTER TABLE recharges DROP CONSTRAINT IF EXISTS recharges_amount_identity_check')
  await pgm.db.query('ALTER TABLE recharges DROP CONSTRAINT IF EXISTS recharges_surcharge_range_check')
  await pgm.db.query('ALTER TABLE recharges DROP COLUMN IF EXISTS surcharge_amount')
  await pgm.db.query(`
    ALTER TABLE recharges
      ALTER COLUMN original_amount TYPE ${PRECISION_OLD},
      ALTER COLUMN discount_amount TYPE ${PRECISION_OLD},
      ALTER COLUMN paid_amount     TYPE ${PRECISION_OLD}
  `)
  await pgm.db.query(`
    ALTER TABLE recharges
      ADD CONSTRAINT recharges_check1 CHECK (paid_amount <= original_amount),
      ADD CONSTRAINT recharges_check2 CHECK (original_amount - discount_amount = paid_amount)
  `)
}
