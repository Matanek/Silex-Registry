CREATE TABLE IF NOT EXISTS probe_sessions (
  id TEXT PRIMARY KEY,
  credential TEXT NOT NULL,
  digest TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  descriptor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (credential, digest)
);
CREATE TABLE IF NOT EXISTS probe_chunks (
  session_id TEXT NOT NULL REFERENCES probe_sessions(id),
  object_digest TEXT NOT NULL,
  offset INTEGER NOT NULL,
  size INTEGER NOT NULL,
  chunk_digest TEXT NOT NULL,
  PRIMARY KEY (session_id, object_digest, offset)
);
CREATE TABLE IF NOT EXISTS probe_versions (
  name TEXT NOT NULL COLLATE NOCASE,
  version TEXT NOT NULL,
  digest TEXT NOT NULL,
  descriptor TEXT NOT NULL,
  PRIMARY KEY (name, version)
);
