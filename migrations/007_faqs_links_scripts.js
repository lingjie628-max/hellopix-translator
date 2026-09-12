/**
 * 运营侧的三个独立模块：FAQ、分流短链、话术库。
 * 都是新建表，不影响既有数据。
 */
exports.up = pgm => {
  pgm.sql(`
    CREATE TABLE faqs (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      question varchar(500) NOT NULL CHECK (length(btrim(question)) > 0),
      answer text NOT NULL DEFAULT '',
      sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE short_links (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id bigint REFERENCES users(id) ON DELETE SET NULL,
      order_serial varchar(64) NOT NULL DEFAULT '',
      code varchar(64) NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9_-]{2,64}$'),
      target text NOT NULL DEFAULT '',
      hits integer NOT NULL DEFAULT 0 CHECK (hits >= 0),
      message varchar(500) NOT NULL DEFAULT '',
      accounts varchar(500) NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX short_links_user_idx ON short_links (user_id, created_at DESC);

    CREATE TABLE scripts (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id bigint REFERENCES users(id) ON DELETE CASCADE,
      group_title varchar(120) NOT NULL DEFAULT '',
      keyword varchar(120) NOT NULL DEFAULT '',
      source text NOT NULL DEFAULT '',
      target text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX scripts_user_idx ON scripts (user_id, created_at DESC);

    INSERT INTO faqs (question, answer, sort_order, enabled) VALUES
      ('如何购买套餐？', '在商户后台「充值」页选择套餐下单，支持微信与支付宝。', 1, true),
      ('翻译字符怎么计算？', '中文按 2 个字符计费，其它语言按 1 个字符计费；翻译失败会自动退还。', 2, true)
    ON CONFLICT DO NOTHING;
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DROP TABLE IF EXISTS scripts;
    DROP TABLE IF EXISTS short_links;
    DROP TABLE IF EXISTS faqs;
  `)
}
