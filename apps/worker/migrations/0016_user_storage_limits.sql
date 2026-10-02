CREATE TABLE user_storage_limits (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  quota_bytes INTEGER NOT NULL CHECK (quota_bytes > 0),
  object_limit INTEGER NOT NULL CHECK (object_limit > 0),
  updated_at INTEGER NOT NULL
) STRICT;
