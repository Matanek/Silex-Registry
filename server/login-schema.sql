CREATE TABLE IF NOT EXISTS login_schema (version INTEGER PRIMARY KEY CHECK(version=1));
INSERT OR IGNORE INTO login_schema VALUES (1);
CREATE TABLE IF NOT EXISTS login_attempts (
    id TEXT PRIMARY KEY,
    ticket_digest TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('starting','pending','polling','consumed','denied','expired','failed')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    interval INTEGER NOT NULL DEFAULT 5,
    next_poll INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER NOT NULL DEFAULT 0,
    device TEXT,
    user_code TEXT
);
CREATE TABLE IF NOT EXISTS login_rate (minute INTEGER PRIMARY KEY, starts INTEGER NOT NULL);
