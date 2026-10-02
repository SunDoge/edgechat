ALTER TABLE users ADD COLUMN deletion_requested_at INTEGER;
ALTER TABLE users ADD COLUMN deleted_at INTEGER;

CREATE TABLE account_deletions (
  deletion_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(user_id),
  requested_by_device_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'complete')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  room_count INTEGER NOT NULL DEFAULT 0,
  object_count INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE account_deletion_rooms (
  deletion_id TEXT NOT NULL REFERENCES account_deletions(deletion_id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('delete', 'leave')),
  successor_user_id TEXT,
  expected_epoch INTEGER,
  event_id TEXT,
  sockets_closed_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  updated_at INTEGER NOT NULL,
  last_error TEXT,
  PRIMARY KEY (deletion_id, room_id)
) STRICT;

CREATE TABLE account_deletion_objects (
  deletion_id TEXT NOT NULL REFERENCES account_deletions(deletion_id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('attachment', 'archive', 'avatar')),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  last_error TEXT,
  PRIMARY KEY (deletion_id, object_key)
) STRICT;

CREATE INDEX idx_account_deletion_objects_pending
  ON account_deletion_objects(deletion_id, status, object_key);

CREATE INDEX idx_account_deletion_rooms_pending
  ON account_deletion_rooms(deletion_id, status, room_id);
