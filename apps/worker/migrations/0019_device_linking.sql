-- Short-lived, capability-protected requests for linking a distinct new device.
-- No plaintext, MLS private state, or archive bytes are stored here.
CREATE TABLE device_links (
  link_id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  signing_key TEXT NOT NULL,
  encryption_key TEXT NOT NULL,
  user_id TEXT REFERENCES users(user_id) ON DELETE CASCADE,
  approved_by_device_id TEXT REFERENCES devices(device_id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'awaiting_packages', 'approved', 'complete', 'claimed', 'cancelled')),
  required_packages INTEGER NOT NULL DEFAULT 0,
  claim_token_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  claimed_at INTEGER
) STRICT;

CREATE INDEX idx_device_links_user_status ON device_links(user_id, status, created_at);
CREATE INDEX idx_device_links_expiry ON device_links(expires_at, status);

CREATE TABLE device_link_key_packages (
  link_id TEXT NOT NULL REFERENCES device_links(link_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  key_package TEXT NOT NULL,
  key_package_fingerprint TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (link_id, ordinal)
) STRICT;

CREATE TABLE device_link_rooms (
  link_id TEXT NOT NULL REFERENCES device_links(link_id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  key_package TEXT NOT NULL,
  expected_epoch INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  event_id TEXT,
  encrypted_state TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (link_id, room_id)
) STRICT;

CREATE UNIQUE INDEX idx_device_link_rooms_active_room
ON device_link_rooms(room_id)
WHERE status = 'pending';
