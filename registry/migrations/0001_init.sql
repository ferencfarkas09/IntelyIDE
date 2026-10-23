-- IntelyIDE registry, first schema.
-- users: one row per email address. installs: one row per computer a person registered from.
-- No IP address is stored anywhere. Location is the coarse place Cloudflare derives for the request (country, region, city).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- the version (a date) of the privacy notice the person agreed to in the app, and when
  consent_notice TEXT NOT NULL,
  consent_at INTEGER NOT NULL,
  -- the newsletter: asked for by ticking the box (never by default); 'pending' until the confirmation mail is answered
  newsletter INTEGER NOT NULL DEFAULT 0,
  newsletter_at INTEGER,
  newsletter_status TEXT NOT NULL DEFAULT 'none' CHECK (newsletter_status IN ('none', 'pending', 'subscribed', 'unsubscribed', 'failed')),
  newsletter_checked_at INTEGER
);

CREATE TABLE installs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 of the token the app keeps; the token itself is never stored
  token_hash TEXT NOT NULL UNIQUE,
  -- the fingerprint of the computer: a hash made in the app, hashed again here with a secret, so it cannot be matched to a hardware id
  machine_hash TEXT NOT NULL,
  os TEXT NOT NULL,
  os_version TEXT NOT NULL,
  arch TEXT NOT NULL,
  cpu_cores INTEGER NOT NULL,
  ram_gb INTEGER NOT NULL,
  locale TEXT NOT NULL,
  tz TEXT NOT NULL,
  app_version TEXT NOT NULL,
  country TEXT,
  region TEXT,
  city TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  launches INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX installs_user_machine ON installs (user_id, machine_hash);
CREATE INDEX installs_last_seen ON installs (last_seen);
CREATE INDEX installs_user ON installs (user_id);
CREATE INDEX users_newsletter ON users (newsletter_status, newsletter_checked_at);

-- request counters per (hashed address, route, ten-minute window); rows older than a day are deleted
CREATE TABLE rate (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  win INTEGER NOT NULL
);
