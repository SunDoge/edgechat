-- Keep the durability policy of every room that has ever referenced an
-- attachment even after the referencing room event is collected. The body is
-- shared, so deletion must satisfy the strongest surviving room policy.
CREATE TABLE attachment_retention_requirements (
  attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  minimum_copies INTEGER NOT NULL CHECK (minimum_copies BETWEEN 1 AND 10),
  PRIMARY KEY (attachment_id, room_id)
) STRICT;

INSERT INTO attachment_retention_requirements (attachment_id, room_id, minimum_copies)
SELECT a.attachment_id, a.room_id, r.retention_min_device_copies
FROM attachments a
JOIN rooms r ON r.room_id = a.room_id;

INSERT INTO attachment_retention_requirements (attachment_id, room_id, minimum_copies)
SELECT g.source_attachment_id, g.room_id, r.retention_min_device_copies
FROM attachment_grants g
JOIN rooms r ON r.room_id = g.room_id
ON CONFLICT(attachment_id, room_id) DO UPDATE SET minimum_copies = excluded.minimum_copies;

CREATE INDEX idx_attachment_retention_requirements_room
  ON attachment_retention_requirements(room_id, attachment_id);
