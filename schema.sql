-- Run this once against your `ledger` D1 database
-- (Cloudflare dashboard → Storage & Databases → D1 → ledger → Console).
CREATE TABLE IF NOT EXISTS app_state (
  user_email TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at TEXT
);
