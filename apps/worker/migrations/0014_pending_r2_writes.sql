CREATE TABLE pending_r2_writes (
  object_key TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('attachment', 'archive')),
  expected_bytes INTEGER NOT NULL CHECK (expected_bytes > 0),
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
) STRICT;

CREATE INDEX idx_pending_r2_writes_created
  ON pending_r2_writes(created_at);

CREATE INDEX idx_pending_r2_writes_owner
  ON pending_r2_writes(owner_user_id, kind);

CREATE INDEX idx_attachments_uploader
  ON attachments(uploader_user_id);

CREATE INDEX idx_rooms_creator
  ON rooms(created_by);
