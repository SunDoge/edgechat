ALTER TABLE devices ADD COLUMN restore_credential_hash TEXT;

CREATE TABLE device_backup_checkpoints (
  checkpoint_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  sent_event_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER
) STRICT;

CREATE INDEX idx_backup_checkpoints_device_created
  ON device_backup_checkpoints(device_id, created_at DESC);
CREATE INDEX idx_room_events_device
  ON room_events(device_id);
