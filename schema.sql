-- Run this once against your `ledger` D1 database
-- (Cloudflare dashboard → Storage & Databases → D1 → ledger → Console).

-- Legacy: whole-workspace JSON blob (still used for the Lead Router + msgstats,
-- and as the migration source for the contacts table below).
CREATE TABLE IF NOT EXISTS app_state (
  user_email TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at TEXT
);

-- One row per contact. The app queries/paginates this instead of loading the
-- whole list into the browser. Structured columns drive filters/sort/stats;
-- `data` keeps the full original contact object for lossless round-trips.
CREATE TABLE IF NOT EXISTS contacts (
  user_email    TEXT NOT NULL,
  id            TEXT NOT NULL,
  name          TEXT,
  profile_url   TEXT,
  email         TEXT,
  company       TEXT,
  position      TEXT,
  institution   TEXT,
  action_day    TEXT,               -- 'YYYY-MM-DD' — sort key + staleness math
  connected     INTEGER DEFAULT 0,  -- 0/1
  connected_on  TEXT,               -- 'YYYY-MM-DD'
  invited_date  TEXT,               -- 'YYYY-MM-DD'
  messaged      INTEGER DEFAULT 0,
  replied       INTEGER DEFAULT 0,
  has_email     INTEGER DEFAULT 0,
  manual_status TEXT,               -- '', 'connected', 'no_response'
  stage         TEXT,
  category      TEXT,
  priority      INTEGER DEFAULT 0,
  state         TEXT,
  notes         TEXT,
  data          TEXT,               -- JSON of the full contact object
  updated_at    TEXT,
  PRIMARY KEY (user_email, id)
);

CREATE INDEX IF NOT EXISTS idx_contacts_user_day    ON contacts(user_email, action_day DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_user_conn   ON contacts(user_email, connected);
CREATE INDEX IF NOT EXISTS idx_contacts_user_name   ON contacts(user_email, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_contacts_user_invite ON contacts(user_email, invited_date);
