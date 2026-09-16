/**
 * 超管后台两步验证（TOTP）。
 *
 * 背景：超管后台是全站最高价值的目标 —— 拿下它等于拿到所有商户数据与
 * 厂商密钥。而在此之前它只有"密码 + 限流"，是所有入口里前置阻力最弱的。
 * 本迁移加上 TOTP（Google Authenticator / Authy 那类 30 秒动态码）与一次性恢复码。
 *
 * 设计取舍：
 *   1. 用 TOTP 而不是邮箱验证码 —— 不依赖 SMTP 送达、无发送成本、离线可用，
 *      而且不会因为管理员邮箱被攻破而一起失效。
 *   2. totp_secret 允许为空：没开启 2FA 的管理员仍可登录（存量账号不会被锁死），
 *      但后台会持续提示去开启。
 *   3. 恢复码单独一张表而不是塞进数组字段 —— 需要"用掉一个就作废一个"，
 *      并且要能查"还剩几个"，用表最直接，也方便审计。
 *   4. 恢复码只存 SHA-256，不存明文：管理员开启时展示一次，之后连我们也拿不回来。
 *      码本身是 10 位 base32（约 50 bit 熵），不落明文也不会被离线爆破。
 */
exports.up = pgm => {
  pgm.sql(`
    ALTER TABLE admins
      ADD COLUMN IF NOT EXISTS totp_secret text,
      ADD COLUMN IF NOT EXISTS totp_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS totp_confirmed_at timestamptz;

    COMMENT ON COLUMN admins.totp_secret IS
      'TOTP 共享密钥（base32）。为空表示尚未配置两步验证。';
    COMMENT ON COLUMN admins.totp_enabled IS
      '是否已开启两步验证。只有管理员用动态码确认过一次才会置 true。';

    CREATE TABLE IF NOT EXISTS admin_recovery_codes (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      admin_id bigint NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      code_hash char(64) NOT NULL,
      used_at timestamptz,
      used_ip inet,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    COMMENT ON TABLE admin_recovery_codes IS
      '超管一次性恢复码。丢失验证器时用它登录，每个只能用一次。';

    CREATE UNIQUE INDEX IF NOT EXISTS admin_recovery_codes_hash_uidx
      ON admin_recovery_codes (admin_id, code_hash);
    CREATE INDEX IF NOT EXISTS admin_recovery_codes_unused_idx
      ON admin_recovery_codes (admin_id) WHERE used_at IS NULL;

    -- 两步验证的中间票据与已用过的 TOTP 步长都放 Redis（短期、高频、需原子），
    -- 不入库；这里只记录"发生过什么"用于审计。
    CREATE TABLE IF NOT EXISTS admin_totp_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      admin_id bigint REFERENCES admins(id) ON DELETE SET NULL,
      event varchar(32) NOT NULL
        CHECK (event IN ('enabled', 'disabled', 'verify_failed', 'recovery_used', 'recovery_regenerated')),
      detail text,
      ip inet,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS admin_totp_events_admin_idx
      ON admin_totp_events (admin_id, created_at DESC);
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DROP TABLE IF EXISTS admin_totp_events;
    DROP TABLE IF EXISTS admin_recovery_codes;
    ALTER TABLE admins
      DROP COLUMN IF EXISTS totp_confirmed_at,
      DROP COLUMN IF EXISTS totp_enabled,
      DROP COLUMN IF EXISTS totp_secret;
  `)
}
