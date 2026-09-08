exports.up = pgm => {
  pgm.sql(`
    CREATE TABLE packages (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      code varchar(64) NOT NULL UNIQUE,
      title varchar(120) NOT NULL,
      subtitle varchar(300) NOT NULL DEFAULT '',
      port_limit integer NOT NULL DEFAULT 0 CHECK (port_limit >= 0),
      port_unlimited boolean NOT NULL DEFAULT true,
      included_chars bigint NOT NULL CHECK (included_chars >= 0),
      price numeric(14, 2) NOT NULL CHECK (price >= 0),
      clients jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(clients) = 'object'),
      highlights jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(highlights) = 'array'),
      features jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(features) = 'object'),
      active boolean NOT NULL DEFAULT true,
      sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (code ~ '^[a-z][a-z0-9_-]{1,63}$')
    );

    CREATE TABLE engines (
      id varchar(64) PRIMARY KEY,
      name varchar(120) NOT NULL,
      provider varchar(120) NOT NULL,
      tier varchar(20) NOT NULL CHECK (tier IN ('basic', 'advanced', 'pro')),
      enabled boolean NOT NULL DEFAULT false,
      wired boolean NOT NULL DEFAULT false,
      cost_per_million numeric(14, 4) NOT NULL DEFAULT 0 CHECK (cost_per_million >= 0),
      model varchar(120),
      endpoint text,
      api_key_ciphertext bytea,
      secret_ciphertext bytea,
      note varchar(1000) NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (id ~ '^[a-z][a-z0-9_-]{1,63}$'),
      CHECK (endpoint IS NULL OR endpoint ~ '^https://'),
      CHECK (wired = false OR enabled = true)
    );

    CREATE TABLE package_engines (
      package_id bigint NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      engine_id varchar(64) NOT NULL REFERENCES engines(id) ON DELETE RESTRICT,
      PRIMARY KEY (package_id, engine_id)
    );

    CREATE TABLE app_settings (
      key varchar(120) PRIMARY KEY,
      value jsonb NOT NULL,
      description varchar(500) NOT NULL DEFAULT '',
      is_secret boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (key ~ '^[a-z][a-z0-9_.-]{1,119}$')
    );

    CREATE TABLE users (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      username varchar(64) NOT NULL,
      password_hash text NOT NULL,
      nickname varchar(120) NOT NULL,
      email varchar(320),
      email_verified boolean NOT NULL DEFAULT false,
      phone varchar(32),
      status smallint NOT NULL DEFAULT 1 CHECK (status IN (0, 1)),
      package_id bigint REFERENCES packages(id) ON DELETE RESTRICT,
      active_engine_id varchar(64) REFERENCES engines(id) ON DELETE SET NULL,
      char_balance bigint NOT NULL DEFAULT 0 CHECK (char_balance >= 0),
      char_used bigint NOT NULL DEFAULT 0 CHECK (char_used >= 0),
      translate_count bigint NOT NULL DEFAULT 0 CHECK (translate_count >= 0),
      sub_quota integer NOT NULL DEFAULT 0 CHECK (sub_quota >= 0),
      auto_alloc_master boolean NOT NULL DEFAULT false,
      auto_reply boolean NOT NULL DEFAULT false,
      enterprise boolean NOT NULL DEFAULT false,
      port_limit integer NOT NULL DEFAULT 0 CHECK (port_limit >= 0),
      ports_in_use integer NOT NULL DEFAULT 0 CHECK (ports_in_use >= 0),
      bound_device varchar(255),
      expires_at timestamptz,
      remarks varchar(1000) NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (username ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$'),
      CHECK (password_hash ~ '^scrypt\\$[^$]+\\$[^$]+$'),
      CHECK (email IS NULL OR (length(email) <= 320 AND position('@' IN email) > 1)),
      CHECK (phone IS NULL OR phone ~ '^\\+?[0-9 -]{6,32}$'),
      CHECK (ports_in_use <= port_limit OR port_limit = 0)
    );

    CREATE UNIQUE INDEX users_username_lower_uidx ON users (lower(username));
    CREATE UNIQUE INDEX users_email_lower_uidx ON users (lower(email)) WHERE email IS NOT NULL;
    CREATE INDEX users_package_idx ON users (package_id);
    CREATE INDEX users_status_expiry_idx ON users (status, expires_at);

    CREATE TABLE sub_accounts (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      parent_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username varchar(64) NOT NULL,
      password_hash text NOT NULL,
      nickname varchar(120) NOT NULL,
      email varchar(320),
      status smallint NOT NULL DEFAULT 1 CHECK (status IN (0, 1)),
      active_engine_id varchar(64) REFERENCES engines(id) ON DELETE SET NULL,
      char_balance bigint NOT NULL DEFAULT 0 CHECK (char_balance >= 0),
      char_used bigint NOT NULL DEFAULT 0 CHECK (char_used >= 0),
      translate_count bigint NOT NULL DEFAULT 0 CHECK (translate_count >= 0),
      auto_alloc boolean NOT NULL DEFAULT false,
      bound_device varchar(255),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (parent_id, id),
      CHECK (username ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$'),
      CHECK (password_hash ~ '^scrypt\\$[^$]+\\$[^$]+$'),
      CHECK (email IS NULL OR (length(email) <= 320 AND position('@' IN email) > 1))
    );

    CREATE UNIQUE INDEX sub_accounts_username_lower_uidx ON sub_accounts (lower(username));
    CREATE UNIQUE INDEX sub_accounts_email_lower_uidx ON sub_accounts (lower(email)) WHERE email IS NOT NULL;
    CREATE INDEX sub_accounts_parent_status_idx ON sub_accounts (parent_id, status);

    CREATE TABLE merchant_identities (
      account_type varchar(10) NOT NULL CHECK (account_type IN ('user', 'sub')),
      account_id bigint NOT NULL,
      username varchar(64) NOT NULL,
      email varchar(320),
      PRIMARY KEY (account_type, account_id)
    );

    CREATE UNIQUE INDEX merchant_identities_username_lower_uidx
      ON merchant_identities (lower(username));
    CREATE UNIQUE INDEX merchant_identities_email_lower_uidx
      ON merchant_identities (lower(email)) WHERE email IS NOT NULL;

    CREATE FUNCTION sync_merchant_identity()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        DELETE FROM merchant_identities
        WHERE account_type = CASE WHEN TG_TABLE_NAME = 'users' THEN 'user' ELSE 'sub' END
          AND account_id = OLD.id;
        RETURN OLD;
      END IF;

      INSERT INTO merchant_identities (account_type, account_id, username, email)
      VALUES (
        CASE WHEN TG_TABLE_NAME = 'users' THEN 'user' ELSE 'sub' END,
        NEW.id,
        NEW.username,
        NEW.email
      )
      ON CONFLICT (account_type, account_id)
      DO UPDATE SET username = EXCLUDED.username, email = EXCLUDED.email;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER users_identity_sync
      AFTER INSERT OR UPDATE OR DELETE ON users
      FOR EACH ROW EXECUTE FUNCTION sync_merchant_identity();
    CREATE TRIGGER sub_accounts_identity_sync
      AFTER INSERT OR UPDATE OR DELETE ON sub_accounts
      FOR EACH ROW EXECUTE FUNCTION sync_merchant_identity();

    CREATE TABLE admins (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      username varchar(64) NOT NULL,
      password_hash text NOT NULL,
      nickname varchar(120) NOT NULL,
      role varchar(20) NOT NULL DEFAULT 'operator'
        CHECK (role IN ('superadmin', 'admin', 'operator', 'auditor')),
      status smallint NOT NULL DEFAULT 1 CHECK (status IN (0, 1)),
      last_login_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (username ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$'),
      CHECK (password_hash ~ '^scrypt\\$[^$]+\\$[^$]+$')
    );

    CREATE UNIQUE INDEX admins_username_lower_uidx ON admins (lower(username));
    CREATE INDEX admins_status_idx ON admins (status);

    CREATE TABLE orders (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      serial_number varchar(64) NOT NULL UNIQUE,
      title varchar(200) NOT NULL,
      type varchar(50) NOT NULL,
      use_ports integer NOT NULL DEFAULT 0 CHECK (use_ports >= 0),
      port_limit integer NOT NULL DEFAULT 1 CHECK (port_limit >= 0),
      online_total integer NOT NULL DEFAULT 0 CHECK (online_total >= 0),
      total_users integer NOT NULL DEFAULT 0 CHECK (total_users >= 0),
      completed_target bigint NOT NULL DEFAULT 0 CHECK (completed_target >= 0),
      total_target bigint NOT NULL DEFAULT 0 CHECK (total_target >= 0),
      day_target bigint NOT NULL DEFAULT 0 CHECK (day_target >= 0),
      share_password_hash text,
      expires_at timestamptz,
      share_password_expires_at timestamptz,
      distribution_mode smallint NOT NULL DEFAULT 1 CHECK (distribution_mode IN (1, 2)),
      status smallint NOT NULL DEFAULT 1 CHECK (status IN (0, 1, 2)),
      zero_time time NOT NULL DEFAULT '00:00:00',
      assistant varchar(200) NOT NULL DEFAULT '',
      remarks varchar(1000) NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (serial_number ~ '^[A-Za-z0-9_-]{6,64}$'),
      CHECK (use_ports <= port_limit OR port_limit = 0),
      CHECK (online_total <= total_users),
      CHECK (completed_target <= total_target OR total_target = 0),
      CHECK (share_password_hash IS NULL OR share_password_hash ~ '^scrypt\\$[^$]+\\$[^$]+$'),
      CHECK (share_password_expires_at IS NULL OR share_password_hash IS NOT NULL)
    );

    CREATE INDEX orders_user_created_idx ON orders (user_id, created_at DESC);
    CREATE INDEX orders_user_status_idx ON orders (user_id, status);
    CREATE INDEX orders_expiry_idx ON orders (expires_at) WHERE status = 1;

    CREATE TABLE recharges (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      package_id bigint REFERENCES packages(id) ON DELETE RESTRICT,
      order_number varchar(64) NOT NULL UNIQUE,
      kind varchar(20) NOT NULL CHECK (kind IN ('package', 'characters', 'manual')),
      payment_type varchar(50) NOT NULL,
      quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
      chars bigint NOT NULL DEFAULT 0 CHECK (chars >= 0),
      original_amount numeric(14, 2) NOT NULL CHECK (original_amount >= 0),
      discount_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
      paid_amount numeric(14, 2) NOT NULL CHECK (paid_amount >= 0),
      status smallint NOT NULL DEFAULT 0 CHECK (status IN (0, 1, 2, 3)),
      provider_transaction_id varchar(160),
      idempotency_key varchar(160) NOT NULL UNIQUE,
      paid_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (discount_amount <= original_amount),
      CHECK (paid_amount <= original_amount),
      CHECK (original_amount - discount_amount = paid_amount),
      CHECK ((status = 1 AND paid_at IS NOT NULL) OR status <> 1)
    );

    CREATE UNIQUE INDEX recharges_provider_tx_uidx
      ON recharges (payment_type, provider_transaction_id)
      WHERE provider_transaction_id IS NOT NULL;
    CREATE INDEX recharges_user_created_idx ON recharges (user_id, created_at DESC);
    CREATE INDEX recharges_status_created_idx ON recharges (status, created_at);

    CREATE TABLE translate_logs (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      sub_account_id bigint,
      engine_id varchar(64) NOT NULL REFERENCES engines(id) ON DELETE RESTRICT,
      reservation_id bigint,
      source_language varchar(32) NOT NULL,
      target_language varchar(32) NOT NULL,
      chars bigint NOT NULL CHECK (chars > 0),
      cost_amount numeric(16, 6) NOT NULL DEFAULT 0 CHECK (cost_amount >= 0),
      sell_amount numeric(16, 6) NOT NULL DEFAULT 0 CHECK (sell_amount >= 0),
      source_hash char(64) NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
      snippet varchar(300) NOT NULL DEFAULT '',
      cached boolean NOT NULL DEFAULT false,
      duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT translate_logs_sub_account_fk
        FOREIGN KEY (user_id, sub_account_id)
        REFERENCES sub_accounts(parent_id, id) ON DELETE RESTRICT,
      CHECK (source_language <> target_language)
    );

    CREATE INDEX translate_logs_user_created_idx ON translate_logs (user_id, created_at DESC);
    CREATE INDEX translate_logs_sub_created_idx ON translate_logs (sub_account_id, created_at DESC)
      WHERE sub_account_id IS NOT NULL;
    CREATE INDEX translate_logs_engine_created_idx ON translate_logs (engine_id, created_at DESC);

    CREATE TABLE translation_reservations (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      sub_account_id bigint,
      engine_id varchar(64) NOT NULL REFERENCES engines(id) ON DELETE RESTRICT,
      idempotency_key varchar(160) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved', 'committed', 'released', 'expired')),
      reserved_chars bigint NOT NULL CHECK (reserved_chars > 0),
      committed_chars bigint NOT NULL DEFAULT 0 CHECK (committed_chars >= 0),
      expires_at timestamptz NOT NULL,
      committed_at timestamptz,
      released_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, idempotency_key),
      UNIQUE (user_id, id),
      CONSTRAINT translation_reservations_sub_account_fk
        FOREIGN KEY (user_id, sub_account_id)
        REFERENCES sub_accounts(parent_id, id) ON DELETE RESTRICT,
      CHECK (committed_chars <= reserved_chars),
      CHECK (status = 'committed' OR committed_chars = 0),
      CHECK (expires_at > created_at),
      CHECK ((status = 'committed') = (committed_at IS NOT NULL)),
      CHECK ((status IN ('released', 'expired')) = (released_at IS NOT NULL))
    );

    ALTER TABLE translate_logs
      ADD CONSTRAINT translate_logs_reservation_fk
      FOREIGN KEY (user_id, reservation_id)
      REFERENCES translation_reservations(user_id, id) ON DELETE RESTRICT;

    CREATE INDEX translation_reservations_expiry_idx
      ON translation_reservations (expires_at) WHERE status = 'reserved';
    CREATE INDEX translation_reservations_user_status_idx
      ON translation_reservations (user_id, status, created_at DESC);

    CREATE TABLE login_logs (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id bigint REFERENCES users(id) ON DELETE SET NULL,
      sub_account_id bigint,
      admin_id bigint REFERENCES admins(id) ON DELETE SET NULL,
      account varchar(320) NOT NULL,
      login_type varchar(30) NOT NULL CHECK (login_type IN ('client', 'merchant', 'admin')),
      success boolean NOT NULL,
      failure_reason varchar(300),
      login_ip inet,
      user_agent varchar(1000),
      device_id varchar(255),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT login_logs_sub_account_fk
        FOREIGN KEY (user_id, sub_account_id)
        REFERENCES sub_accounts(parent_id, id) ON DELETE SET NULL,
      CHECK (sub_account_id IS NULL OR user_id IS NOT NULL),
      CHECK (NOT (admin_id IS NOT NULL AND user_id IS NOT NULL)),
      CHECK (success OR failure_reason IS NOT NULL)
    );

    CREATE INDEX login_logs_account_created_idx ON login_logs (lower(account), created_at DESC);
    CREATE INDEX login_logs_user_created_idx ON login_logs (user_id, created_at DESC)
      WHERE user_id IS NOT NULL;
    CREATE INDEX login_logs_admin_created_idx ON login_logs (admin_id, created_at DESC)
      WHERE admin_id IS NOT NULL;
    CREATE INDEX login_logs_ip_created_idx ON login_logs (login_ip, created_at DESC);

    CREATE TABLE audit_logs (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      admin_id bigint REFERENCES admins(id) ON DELETE SET NULL,
      actor varchar(120) NOT NULL,
      action varchar(160) NOT NULL,
      resource_type varchar(80),
      resource_id varchar(160),
      detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
      ip inet,
      request_id varchar(160),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX audit_logs_admin_created_idx ON audit_logs (admin_id, created_at DESC);
    CREATE INDEX audit_logs_action_created_idx ON audit_logs (action, created_at DESC);
    CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id, created_at DESC)
      WHERE resource_type IS NOT NULL;
    CREATE UNIQUE INDEX audit_logs_request_action_uidx ON audit_logs (request_id, action)
      WHERE request_id IS NOT NULL;
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DROP TABLE IF EXISTS audit_logs;
    DROP TABLE IF EXISTS login_logs;
    ALTER TABLE IF EXISTS translate_logs DROP CONSTRAINT IF EXISTS translate_logs_reservation_fk;
    DROP TABLE IF EXISTS translation_reservations;
    DROP TABLE IF EXISTS translate_logs;
    DROP TABLE IF EXISTS recharges;
    DROP TABLE IF EXISTS orders;
    DROP TABLE IF EXISTS admins;
    DROP TABLE IF EXISTS sub_accounts;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS merchant_identities;
    DROP FUNCTION IF EXISTS sync_merchant_identity();
    DROP TABLE IF EXISTS app_settings;
    DROP TABLE IF EXISTS package_engines;
    DROP TABLE IF EXISTS engines;
    DROP TABLE IF EXISTS packages;
  `)
}
