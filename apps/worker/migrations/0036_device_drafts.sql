-- One opaque current draft per target device and room. Draft plaintext and
-- deletion tombstones are encrypted separately to every active user device.
-- This is deliberately D1-only: draft updates never allocate an R2 object.
CREATE TABLE device_draft_envelopes (
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  target_device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  source_device_id TEXT NOT NULL REFERENCES devices(device_id),
  client_updated_at INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  server_updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, target_device_id)
) STRICT;

CREATE INDEX idx_device_draft_target
  ON device_draft_envelopes(target_device_id, room_id);
