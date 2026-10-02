-- edgechat-migration-phase: expand
-- The encrypted avatar key and image metadata stay inside MLS ciphertext. This
-- table tracks only the current opaque attachment so replacement can reclaim
-- the previous R2 object without bucket listing or retaining avatar versions.
CREATE TABLE room_profile_attachments (
  room_id TEXT PRIMARY KEY REFERENCES rooms(room_id) ON DELETE CASCADE,
  attachment_id TEXT REFERENCES attachments(attachment_id) ON DELETE SET NULL,
  profile_event_id TEXT,
  profile_seq INTEGER NOT NULL DEFAULT 0 CHECK (profile_seq >= 0),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_room_profile_attachments_attachment
  ON room_profile_attachments(attachment_id)
  WHERE attachment_id IS NOT NULL;
