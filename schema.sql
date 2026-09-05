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

-- Automatic weekly recap (Monday 7am ET, browser closed).
-- Holds the Google offline refresh token so the cron Worker can read Gmail and
-- send the recap without JP being present. The refresh token is stored ENCRYPTED
-- (AES-GCM, key derived from the RECAP_ENC_KEY secret) — never in plaintext.
CREATE TABLE IF NOT EXISTS recap_auth (
  user_email   TEXT PRIMARY KEY,   -- the app_state key this recap is for (e.g. john@latimer.ai)
  google_email TEXT,               -- the Google account that granted access
  enc_refresh  TEXT NOT NULL,      -- base64(iv || AES-GCM ciphertext) of the refresh token
  scope        TEXT,               -- granted scopes (space-separated)
  updated_at   TEXT
);

-- One row per weekly send, so the cron never double-sends within an ISO week and
-- JP can see the history. `week_key` is 'YYYY-Www' in America/New_York.
CREATE TABLE IF NOT EXISTS recap_log (
  week_key   TEXT PRIMARY KEY,
  user_email TEXT,
  status     TEXT,                 -- 'sent' | 'error' | 'skipped-no-activity'
  detail     TEXT,
  sent_at    TEXT
);
