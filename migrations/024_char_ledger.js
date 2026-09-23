/**
 * 字符总账。
 *
 * ## 现状的缺口
 *
 * 现在字符变动只有两个落点：
 *   - `character_transfers` —— **只记主账号 → 子账号的划转**
 *   - `recharges` —— 充值订单本身
 *
 * 也就是说：**主账号充值到账的字符没有流水**。
 * 「这笔余额是怎么来的」只能靠翻 recharges 反推；
 * 而「余额对不对得上」这个最基本的问题，现在**没有任何一张表能回答**。
 *
 * RC-02 要求结算链路写「字符流水」，指的就是这张表。
 *
 * ## 设计
 *
 * 追加写、不可改。每一行记录一次变动与变动后的余额快照：
 *
 *   delta          本次变动（正=入账，负=扣减，不允许 0）
 *   balance_after  变动后的余额 —— 有了它才能逐行复算对账
 *   reason         变动原因（枚举，不用自由文本，否则统计时分不了组）
 *   reference_*    指向来源业务对象（如 recharges.id）
 *   idempotency_key 唯一 —— **同一笔业务只能产生一条流水**
 *
 * ## 为什么 idempotency_key 是 NOT NULL + UNIQUE
 *
 * 结算可能被重复触发（链监听补扫、用户重复点「我已付款」、
 * 超管手工补单撞上自动入账）。字符不能因此多发一次。
 * 给每次「应当只发生一次的发放」一个确定性的 key
 * （例如 `recharge:<id>`），重复插入会撞唯一约束，
 * 服务层据此判定"已经发过了"，而不是靠先查后写（有竞态）。
 *
 * ## 与 character_transfers 的关系
 *
 * 两者不重复：`character_transfers` 是「主 → 子」的**业务凭证**，
 * 有审批语义；`char_ledger` 是**账**，记所有变动。
 * 主账号划给子账号时，两边各写一行（-N / +N），
 * `character_transfers` 仍然保留作为划转单。
 */

exports.up = async pgm => {
  await pgm.db.query(`
    CREATE TABLE char_ledger (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

      -- 余额归属：sub_account_id 为 NULL 表示主账号
      user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      sub_account_id bigint,

      delta bigint NOT NULL CHECK (delta <> 0),
      -- 变动后余额。允许为 0，不允许为负 —— 负余额说明上游漏了校验
      balance_after bigint NOT NULL CHECK (balance_after >= 0),

      reason varchar(32) NOT NULL CHECK (reason IN (
        'recharge',        -- 充值到账
        'manual_grant',    -- 后台赠送/调整
        'transfer_out',    -- 主账号划出
        'transfer_in',     -- 子账号划入
        'translate',       -- 翻译消耗
        'refund',          -- 翻译失败回滚
        'correction'       -- 人工修正
      )),

      reference_type varchar(32),
      reference_id bigint,
      note varchar(200) NOT NULL DEFAULT '',

      -- 幂等锚点：同一笔业务只允许一条流水
      idempotency_key varchar(160) NOT NULL UNIQUE,

      created_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT char_ledger_sub_requires_user_check
        CHECK (sub_account_id IS NULL OR sub_account_id > 0)
    )
  `)

  await pgm.db.query(`
    CREATE INDEX char_ledger_user_created_idx
      ON char_ledger (user_id, created_at DESC)
  `)

  // 按来源业务反查（如「这张充值单产生了哪条流水」）
  await pgm.db.query(`
    CREATE INDEX char_ledger_reference_idx
      ON char_ledger (reference_type, reference_id)
      WHERE reference_id IS NOT NULL
  `)
}

exports.down = async pgm => {
  await pgm.db.query('DROP TABLE IF EXISTS char_ledger')
}
