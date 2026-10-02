PRAGMA foreign_keys = ON;

CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  localpart TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  avatar_id TEXT UNIQUE,
  avatar_object_key TEXT,
  avatar_sha256 TEXT,
  avatar_bytes INTEGER NOT NULL DEFAULT 0 CHECK (avatar_bytes >= 0 AND avatar_bytes <= 131072),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE profile_avatar_deletions (
  object_key TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 131072),
  requested_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
) STRICT;

CREATE INDEX idx_profile_avatar_deletions_requested
  ON profile_avatar_deletions(requested_at, object_key);

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  signing_key TEXT NOT NULL,
  encryption_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE rooms (
  room_id TEXT PRIMARY KEY,
  home_server TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  name TEXT,
  current_seq INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(user_id),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE room_members (
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at INTEGER NOT NULL,
  removed_at INTEGER,
  PRIMARY KEY (room_id, user_id)
) STRICT;

CREATE TABLE room_device_keys (
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  encrypted_state TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, device_id, epoch)
) STRICT;

CREATE TABLE room_events (
  event_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  sender TEXT NOT NULL,
  device_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (room_id, seq),
  UNIQUE (room_id, event_id)
) STRICT;

CREATE TABLE sync_log (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  room_id TEXT,
  seq INTEGER,
  event_id TEXT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (recipient_user_id, kind, event_id)
) STRICT;

CREATE TABLE attachments (
  attachment_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  uploader_user_id TEXT NOT NULL REFERENCES users(user_id),
  object_key TEXT NOT NULL UNIQUE,
  ciphertext_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE archive_segments (
  segment_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  start_seq INTEGER NOT NULL,
  end_seq INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (room_id, start_seq, end_seq)
) STRICT;

CREATE TABLE push_subscriptions (
  device_id TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  renewal_token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE ws_tickets (
  ticket_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_devices_user ON devices(user_id, revoked_at);
CREATE INDEX idx_members_user ON room_members(user_id, removed_at);
CREATE INDEX idx_events_room_seq ON room_events(room_id, seq);
CREATE INDEX idx_sync_recipient_cursor ON sync_log(recipient_user_id, cursor);
CREATE INDEX idx_segments_room_seq ON archive_segments(room_id, start_seq, end_seq);
