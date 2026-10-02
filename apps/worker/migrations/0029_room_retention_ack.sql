ALTER TABLE rooms ADD COLUMN retention_min_device_copies INTEGER NOT NULL DEFAULT 1
  CHECK (retention_min_device_copies BETWEEN 1 AND 10);

-- A row proves that one authenticated room device reports a complete local
-- sequence interval for the current retention generation. It contains no
-- message data and creates no R2 object.
CREATE TABLE room_retention_acks (
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  from_seq INTEGER NOT NULL,
  through_seq INTEGER NOT NULL,
  acknowledged_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, device_id),
  CHECK (generation >= 1),
  CHECK (from_seq >= 1),
  CHECK (through_seq >= from_seq)
) STRICT;

CREATE INDEX idx_room_retention_acks_generation
  ON room_retention_acks(room_id, generation, through_seq DESC);
