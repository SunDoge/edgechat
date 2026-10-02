ALTER TABLE attachments ADD COLUMN source_deleted_at INTEGER;

CREATE TABLE attachment_grants (
  grant_id TEXT PRIMARY KEY,
  source_attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  granted_by_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  grant_event_id TEXT NOT NULL UNIQUE REFERENCES room_events(event_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_attachment_grants_room
  ON attachment_grants(room_id, grant_id);

CREATE INDEX idx_attachment_grants_source
  ON attachment_grants(source_attachment_id, grant_event_id);
