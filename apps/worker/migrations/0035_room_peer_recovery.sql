-- Temporary, device-to-device relay for a bounded room-event gap. The Worker
-- never receives plaintext: the source device encrypts one bundle directly to
-- the target device. One object covers up to 500 events and is deleted after
-- the target durably applies it.
CREATE TABLE room_peer_recoveries (
  recovery_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  target_device_id TEXT NOT NULL REFERENCES devices(device_id),
  source_device_id TEXT REFERENCES devices(device_id),
  after_seq INTEGER NOT NULL CHECK (after_seq >= 0),
  through_seq INTEGER NOT NULL CHECK (through_seq > after_seq AND through_seq - after_seq <= 500),
  status TEXT NOT NULL CHECK (status IN ('pending', 'transferring', 'ready', 'complete', 'cancelled')),
  lease_token_hash TEXT,
  lease_expires_at INTEGER,
  object_key TEXT UNIQUE,
  ciphertext_bytes INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE UNIQUE INDEX room_peer_recoveries_active_target_idx
  ON room_peer_recoveries(room_id, target_device_id)
  WHERE status IN ('pending', 'transferring', 'ready');

CREATE INDEX room_peer_recoveries_source_queue_idx
  ON room_peer_recoveries(user_id, status, created_at);

CREATE INDEX room_peer_recoveries_expiry_idx
  ON room_peer_recoveries(status, expires_at);
