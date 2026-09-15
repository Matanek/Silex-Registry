PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS identities (
    github_id TEXT PRIMARY KEY,
    login TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
    digest TEXT PRIMARY KEY,
    github_id TEXT NOT NULL REFERENCES identities(github_id),
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
);
CREATE TABLE IF NOT EXISTS names (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    github_id TEXT REFERENCES identities(github_id),
    reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved IN (0, 1))
);
CREATE TABLE IF NOT EXISTS publications (
    id TEXT PRIMARY KEY,
    github_id TEXT NOT NULL REFERENCES identities(github_id),
    digest TEXT NOT NULL,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    descriptor TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('receiving', 'published', 'expired')),
    UNIQUE (github_id, digest)
);
CREATE TABLE IF NOT EXISTS uploads (
    publication TEXT NOT NULL REFERENCES publications(id),
    digest TEXT NOT NULL,
    size INTEGER NOT NULL,
    offset INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (publication, digest)
);
CREATE TABLE IF NOT EXISTS versions (
    name TEXT NOT NULL REFERENCES names(name),
    version TEXT NOT NULL,
    digest TEXT NOT NULL,
    descriptor TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    PRIMARY KEY (name, version)
);
CREATE TABLE IF NOT EXISTS version_objects (
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    digest TEXT NOT NULL,
    PRIMARY KEY (name, version, digest),
    FOREIGN KEY (name, version) REFERENCES versions(name, version)
);
PRAGMA user_version = 1;
