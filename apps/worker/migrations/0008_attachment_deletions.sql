CREATE TABLE attachment_deletions (
  attachment_id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  uploader_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  ciphertext_bytes INTEGER NOT NULL,
  delete_event_id TEXT NOT NULL REFERENCES room_events(event_id) ON DELETE CASCADE,
  requested_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
) STRICT;

CREATE INDEX idx_attachment_deletions_requested ON attachment_deletions(requested_at);
