CREATE TABLE IF NOT EXISTS probe_backup_items (
  kind TEXT NOT NULL CHECK (kind IN ('object','publication','snapshot')),
  item TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending','complete')),
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, item)
);
