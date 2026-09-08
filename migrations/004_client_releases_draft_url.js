exports.up = pgm => {
  pgm.sql(`
    ALTER TABLE client_releases
      DROP CONSTRAINT IF EXISTS client_releases_url_check;
    ALTER TABLE client_releases
      ADD CONSTRAINT client_releases_url_check
        CHECK (url = '' OR url ~ '^https://');
    ALTER TABLE client_releases
      ADD CONSTRAINT client_releases_enabled_url_check
        CHECK (enabled = false OR url ~ '^https://');
  `)
}

exports.down = pgm => {
  pgm.sql(`
    UPDATE client_releases SET enabled=false WHERE url = '' OR url !~ '^https://';
    ALTER TABLE client_releases
      DROP CONSTRAINT IF EXISTS client_releases_enabled_url_check;
    ALTER TABLE client_releases
      DROP CONSTRAINT IF EXISTS client_releases_url_check;
    ALTER TABLE client_releases
      ADD CONSTRAINT client_releases_url_check
        CHECK (url ~ '^https://');
  `)
}
