CREATE TABLE device_room_preferences (
  device_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  muted_until INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, room_id),
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE,
  FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
);

CREATE INDEX idx_device_room_preferences_push
  ON device_room_preferences(room_id, device_id, muted_until);
