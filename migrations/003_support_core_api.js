exports.up = pgm => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN trans_recv boolean NOT NULL DEFAULT true,
      ADD COLUMN trans_send boolean NOT NULL DEFAULT true,
      ADD COLUMN trans_group boolean NOT NULL DEFAULT true,
      ADD COLUMN lang_mine varchar(32) NOT NULL DEFAULT 'zh',
      ADD COLUMN lang_other varchar(32) NOT NULL DEFAULT 'auto',
      ADD COLUMN include_zh boolean NOT NULL DEFAULT true,
      ADD CONSTRAINT users_translation_language_check
        CHECK (lang_mine ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$' AND
               lang_other ~ '^(auto|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?)$');

    ALTER TABLE sub_accounts
      ADD COLUMN trans_recv boolean NOT NULL DEFAULT true,
      ADD COLUMN trans_send boolean NOT NULL DEFAULT true,
      ADD COLUMN trans_group boolean NOT NULL DEFAULT true,
      ADD COLUMN lang_mine varchar(32) NOT NULL DEFAULT 'zh',
      ADD COLUMN lang_other varchar(32) NOT NULL DEFAULT 'auto',
      ADD COLUMN include_zh boolean NOT NULL DEFAULT true,
      ADD CONSTRAINT sub_accounts_translation_language_check
        CHECK (lang_mine ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$' AND
               lang_other ~ '^(auto|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?)$');

    ALTER TABLE translation_reservations
      ADD COLUMN source_language varchar(32) NOT NULL DEFAULT 'auto',
      ADD COLUMN target_language varchar(32) NOT NULL DEFAULT 'zh',
      ADD COLUMN source_hash char(64) NOT NULL DEFAULT repeat('0', 64),
      ADD COLUMN request_hash char(64) NOT NULL DEFAULT repeat('0', 64),
      ADD COLUMN response_json jsonb,
      ADD COLUMN error_code varchar(80),
      ADD COLUMN duration_ms integer,
      ADD CONSTRAINT translation_reservations_source_hash_check
        CHECK (source_hash ~ '^[0-9a-f]{64}$'),
      ADD CONSTRAINT translation_reservations_request_hash_check
        CHECK (request_hash ~ '^[0-9a-f]{64}$'),
      ADD CONSTRAINT translation_reservations_response_check
        CHECK (response_json IS NULL OR status IN ('committed', 'released')),
      ADD CONSTRAINT translation_reservations_duration_check
        CHECK (duration_ms IS NULL OR duration_ms >= 0),
      ADD CONSTRAINT translation_reservations_language_check
        CHECK (source_language ~ '^(auto|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?)$' AND
               target_language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$');

    ALTER TABLE translation_reservations
      ALTER COLUMN source_language DROP DEFAULT,
      ALTER COLUMN target_language DROP DEFAULT,
      ALTER COLUMN source_hash DROP DEFAULT,
      ALTER COLUMN request_hash DROP DEFAULT;

    CREATE TABLE character_transfers (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      parent_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      sub_account_id bigint NOT NULL,
      amount bigint NOT NULL CHECK (amount <> 0),
      operator_type varchar(10) NOT NULL CHECK (operator_type IN ('user', 'admin', 'system')),
      operator_id bigint,
      idempotency_key varchar(160),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT character_transfers_sub_fk
        FOREIGN KEY (parent_id, sub_account_id)
        REFERENCES sub_accounts(parent_id, id) ON DELETE RESTRICT,
      UNIQUE (parent_id, idempotency_key),
      CHECK ((operator_type = 'system' AND operator_id IS NULL) OR
             (operator_type <> 'system' AND operator_id IS NOT NULL))
    );
    CREATE INDEX character_transfers_sub_created_idx
      ON character_transfers (sub_account_id, created_at DESC);

    CREATE TABLE order_details (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      account varchar(320) NOT NULL,
      nickname varchar(200) NOT NULL DEFAULT '',
      online_status smallint NOT NULL DEFAULT 0 CHECK (online_status IN (0, 1)),
      distribution_status smallint NOT NULL DEFAULT 0 CHECK (distribution_status IN (0, 1)),
      port integer CHECK (port IS NULL OR port >= 0),
      remarks varchar(1000) NOT NULL DEFAULT '',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (order_id, account),
      CHECK (length(btrim(account)) > 0)
    );
    CREATE INDEX order_details_order_created_idx ON order_details (order_id, created_at DESC);

    CREATE TABLE order_fans (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      account varchar(320) NOT NULL,
      nickname varchar(200) NOT NULL DEFAULT '',
      fan_type varchar(50) NOT NULL DEFAULT '',
      repeated boolean NOT NULL DEFAULT false,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (length(btrim(account)) > 0)
    );
    CREATE INDEX order_fans_order_created_idx ON order_fans (order_id, created_at DESC);

    CREATE TABLE client_releases (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      release_group varchar(40) NOT NULL,
      title varchar(160) NOT NULL,
      os varchar(40) NOT NULL,
      arch varchar(40) NOT NULL DEFAULT '',
      app varchar(80) NOT NULL DEFAULT '',
      version varchar(64) NOT NULL,
      url text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      note varchar(1000) NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (url ~ '^https://'),
      CHECK (length(btrim(version)) > 0),
      UNIQUE (release_group, os, arch, app, version)
    );
    CREATE INDEX client_releases_lookup_idx
      ON client_releases (enabled, os, arch, created_at DESC);

    CREATE TABLE client_lines (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name varchar(120) NOT NULL,
      url text NOT NULL,
      region varchar(120) NOT NULL DEFAULT '',
      enabled boolean NOT NULL DEFAULT true,
      sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (url ~ '^https://'),
      CHECK (length(btrim(name)) > 0)
    );
    CREATE INDEX client_lines_public_idx ON client_lines (enabled, sort_order, id);
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DROP TABLE IF EXISTS client_lines;
    DROP TABLE IF EXISTS client_releases;
    DROP TABLE IF EXISTS order_fans;
    DROP TABLE IF EXISTS order_details;
    DROP TABLE IF EXISTS character_transfers;

    ALTER TABLE translation_reservations
      DROP CONSTRAINT IF EXISTS translation_reservations_language_check,
      DROP CONSTRAINT IF EXISTS translation_reservations_duration_check,
      DROP CONSTRAINT IF EXISTS translation_reservations_response_check,
      DROP CONSTRAINT IF EXISTS translation_reservations_request_hash_check,
      DROP CONSTRAINT IF EXISTS translation_reservations_source_hash_check,
      DROP COLUMN IF EXISTS duration_ms,
      DROP COLUMN IF EXISTS error_code,
      DROP COLUMN IF EXISTS response_json,
      DROP COLUMN IF EXISTS request_hash,
      DROP COLUMN IF EXISTS source_hash,
      DROP COLUMN IF EXISTS target_language,
      DROP COLUMN IF EXISTS source_language;

    ALTER TABLE sub_accounts
      DROP CONSTRAINT IF EXISTS sub_accounts_translation_language_check,
      DROP COLUMN IF EXISTS include_zh,
      DROP COLUMN IF EXISTS lang_other,
      DROP COLUMN IF EXISTS lang_mine,
      DROP COLUMN IF EXISTS trans_group,
      DROP COLUMN IF EXISTS trans_send,
      DROP COLUMN IF EXISTS trans_recv;

    ALTER TABLE users
      DROP CONSTRAINT IF EXISTS users_translation_language_check,
      DROP COLUMN IF EXISTS include_zh,
      DROP COLUMN IF EXISTS lang_other,
      DROP COLUMN IF EXISTS lang_mine,
      DROP COLUMN IF EXISTS trans_group,
      DROP COLUMN IF EXISTS trans_send,
      DROP COLUMN IF EXISTS trans_recv;
  `)
}
