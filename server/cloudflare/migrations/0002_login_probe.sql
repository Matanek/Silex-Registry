CREATE TABLE IF NOT EXISTS probe_login_attempts (
  id TEXT PRIMARY KEY,
  ticket_digest TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('starting','pending','polling','consumed','denied','expired','failed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  interval_seconds INTEGER NOT NULL DEFAULT 5,
  next_poll INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  encrypted_device TEXT,
  user_code TEXT
);
CREATE TABLE IF NOT EXISTS probe_login_rate (
  minute INTEGER PRIMARY KEY,
  starts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS probe_identities (
  github_id TEXT PRIMARY KEY,
  login TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS probe_credentials (
  digest TEXT PRIMARY KEY,
  github_id TEXT NOT NULL REFERENCES probe_identities(github_id),
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES probe_login_attempts(id)
);
