/**
 * 金额预约表：随机尾数的唯一性与 **24 小时复用保护**。
 *
 * ## 为什么不能只靠 `recharges WHERE status = 0`
 *
 * 直觉做法是给 recharges 加一个
 * `UNIQUE (pay_address, paid_amount) WHERE status = 0` 就完事。
 * 这挡得住「两张未支付订单同金额」，但挡不住这个真实场景：
 *
 *   T+00:00  订单 A 生成 35.427，有效期 30 分钟
 *   T+00:29  用户转出 35.427（链上还没确认）
 *   T+00:31  订单 A 过期 → status 变 2 → 唯一索引把它放开了
 *   T+00:32  订单 B 恰好又随机到 35.427 → 顺利插入
 *   T+00:35  链上确认到账 35.427 → **被匹配给订单 B**
 *
 * 用户付的是订单 A 的钱，系统却记到订单 B 头上；而订单 A 永远是"未支付"。
 * 两张订单都错，且错得毫无声响。
 *
 * 所以唯一性必须**跨状态**成立，并且带一段保护期 —— 这就是本表的存在理由。
 *
 * ## 状态机
 *
 * ```
 *   held     占用中（订单进行中，或订单已结束但仍在 24 小时保护期内）
 *     │
 *     └── reusable_after 到点后被释放 ──→ released（可再次分配）
 * ```
 *
 * `held` 期间该 (地址, 合约, 金额) 三元组**不可被任何新订单占用**，
 * 这就是 Rule A 要的「不能立即重新分配」。
 *
 * ## 保护期怎么算
 *
 *   created 时：reusable_after = expires_at + 24h
 *   订单进终态时：reusable_after = GREATEST(reusable_after, terminal_at + 24h)
 *
 * 用 GREATEST 而不是直接覆盖，是因为提前结束的订单（比如 5 分钟就付款成功）
 * 不该把保护期缩短到「付款后 24 小时」—— 那会让 T+29 分钟才发出的迟到转账
 * 在 T+24h 之后就失去归属、可能撞上新订单。
 * 以 expires_at + 24h 为下界，覆盖了「临到期才转账、确认又慢」的整段时间。
 *
 * ## 迟到款识别
 *
 * 保护期内（甚至保护期后）收到一个金额，先按 (地址, 合约, 金额) 反查本表：
 *   - 查到且订单仍在 pending → 正常结算
 *   - 查到但订单已是终态   → **迟到款，进异常池**，绝不改配给别的订单
 *   - 查不到               → 无法匹配，进异常池
 *
 * 所以本表**不删除历史行**，released 的行正是迟到款归属的依据。
 */

exports.up = async pgm => {
  await pgm.db.query(`
    CREATE TABLE recharge_amount_reservations (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

      -- 与链上匹配用的三元组：收款地址 + 代币合约 + 应付金额（milli-USDT 整数）
      pay_address varchar(64) NOT NULL,
      pay_token_contract varchar(64) NOT NULL,
      amount_milli bigint NOT NULL CHECK (amount_milli > 0),

      -- 尾数单独存一份，便于直接观察池子占用情况（0.001–0.999 对应 1–999）
      suffix smallint NOT NULL CHECK (suffix BETWEEN 0 AND 999),

      -- 归属订单。允许 NULL：预约先于订单插入（同一事务内随后回填）
      recharge_id bigint REFERENCES recharges(id) ON DELETE RESTRICT,

      state varchar(16) NOT NULL DEFAULT 'held'
        CHECK (state IN ('held', 'released')),

      reserved_at timestamptz NOT NULL DEFAULT now(),
      -- 到这一刻之后才允许被其它订单复用
      reusable_after timestamptz NOT NULL,
      released_at timestamptz,
      released_reason varchar(32),

      -- 注意：约束名不能叫 ..._state_check —— 那正是 PostgreSQL 给
      -- 上面 state 列内联 CHECK 自动生成的名字，会撞名导致迁移失败
      CONSTRAINT recharge_amount_reservations_release_check
        CHECK ((state = 'held' AND released_at IS NULL)
            OR (state = 'released' AND released_at IS NOT NULL)),
      CONSTRAINT recharge_amount_reservations_protection_check
        CHECK (reusable_after > reserved_at)
    )
  `)

  // **核心约束**：held 状态下三元组全局唯一。
  // 用部分唯一索引而不是普通唯一约束 —— released 的历史行必须能共存，
  // 否则同一金额被复用第二次时会撞上第一次的历史行，池子越用越小。
  await pgm.db.query(`
    CREATE UNIQUE INDEX recharge_amount_reservations_held_uq
      ON recharge_amount_reservations (pay_address, pay_token_contract, amount_milli)
      WHERE state = 'held'
  `)

  // 迟到款反查：按三元组查全部历史（含 released），找到归属订单
  await pgm.db.query(`
    CREATE INDEX recharge_amount_reservations_lookup_idx
      ON recharge_amount_reservations (pay_address, pay_token_contract, amount_milli, reserved_at DESC)
  `)

  // 按订单反查（结算时要拿预约行去延长保护期）
  await pgm.db.query(`
    CREATE INDEX recharge_amount_reservations_recharge_idx
      ON recharge_amount_reservations (recharge_id)
      WHERE recharge_id IS NOT NULL
  `)

  // 释放扫描用：只索引到点的 held 行
  await pgm.db.query(`
    CREATE INDEX recharge_amount_reservations_release_idx
      ON recharge_amount_reservations (reusable_after)
      WHERE state = 'held'
  `)

  // 给 recharges 补上「本单占用的是哪条预约」，方便结算时一步取到
  await pgm.db.query(`
    ALTER TABLE recharges
      ADD COLUMN IF NOT EXISTS amount_reservation_id bigint
        REFERENCES recharge_amount_reservations(id) ON DELETE RESTRICT
  `)
}

exports.down = async pgm => {
  await pgm.db.query('ALTER TABLE recharges DROP COLUMN IF EXISTS amount_reservation_id')
  await pgm.db.query('DROP TABLE IF EXISTS recharge_amount_reservations')
}
