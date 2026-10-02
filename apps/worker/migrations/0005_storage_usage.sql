CREATE TABLE user_storage_usage (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  attachment_bytes INTEGER NOT NULL DEFAULT 0 CHECK (attachment_bytes >= 0),
  archive_bytes INTEGER NOT NULL DEFAULT 0 CHECK (archive_bytes >= 0),
  attachment_objects INTEGER NOT NULL DEFAULT 0 CHECK (attachment_objects >= 0),
  archive_objects INTEGER NOT NULL DEFAULT 0 CHECK (archive_objects >= 0),
  updated_at INTEGER NOT NULL
) STRICT;

INSERT INTO user_storage_usage (user_id, attachment_bytes, archive_bytes, attachment_objects, archive_objects, updated_at)
SELECT u.user_id,
       COALESCE((SELECT SUM(a.ciphertext_bytes) FROM attachments a WHERE a.uploader_user_id = u.user_id), 0),
       COALESCE((SELECT SUM(s.byte_size) FROM archive_segments s JOIN rooms r ON r.room_id = s.room_id WHERE r.created_by = u.user_id), 0),
       COALESCE((SELECT COUNT(*) FROM attachments a WHERE a.uploader_user_id = u.user_id), 0),
       COALESCE((SELECT COUNT(*) FROM archive_segments s JOIN rooms r ON r.room_id = s.room_id WHERE r.created_by = u.user_id), 0),
       CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM users u;
