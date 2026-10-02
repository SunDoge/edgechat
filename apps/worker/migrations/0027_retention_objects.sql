ALTER TABLE attachments ADD COLUMN committed_seq INTEGER;
ALTER TABLE attachment_grants ADD COLUMN grant_seq INTEGER;

UPDATE attachments
SET committed_seq = (
  SELECT e.seq FROM room_events e WHERE e.event_id = attachments.committed_event_id
)
WHERE committed_event_id IS NOT NULL;

UPDATE attachment_grants
SET grant_seq = (
  SELECT e.seq FROM room_events e WHERE e.event_id = attachment_grants.grant_event_id
);

CREATE INDEX idx_attachments_retention
  ON attachments(room_id, committed_seq);
CREATE INDEX idx_attachment_grants_retention
  ON attachment_grants(source_attachment_id, room_id, grant_seq);

CREATE TABLE retention_object_deletions (
  object_key TEXT PRIMARY KEY,
  object_type TEXT NOT NULL CHECK (object_type IN ('attachment', 'archive')),
  object_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  ciphertext_bytes INTEGER NOT NULL CHECK (ciphertext_bytes >= 0),
  requested_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  UNIQUE (object_type, object_id)
) STRICT;

CREATE INDEX idx_retention_object_deletions_requested
  ON retention_object_deletions(requested_at, object_key);
