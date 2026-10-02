CREATE TABLE attachment_grants_multi (
  grant_id TEXT PRIMARY KEY,
  source_attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  granted_by_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  grant_event_id TEXT NOT NULL REFERENCES room_events(event_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
) STRICT;

INSERT INTO attachment_grants_multi (
  grant_id, source_attachment_id, room_id, granted_by_user_id, grant_event_id, created_at
)
SELECT grant_id, source_attachment_id, room_id, granted_by_user_id, grant_event_id, created_at
FROM attachment_grants;

DROP TABLE attachment_grants;
ALTER TABLE attachment_grants_multi RENAME TO attachment_grants;

CREATE INDEX idx_attachment_grants_room
  ON attachment_grants(room_id, grant_id);

CREATE INDEX idx_attachment_grants_source
  ON attachment_grants(source_attachment_id, grant_event_id);

CREATE INDEX idx_attachment_grants_event
  ON attachment_grants(grant_event_id, grant_id);
