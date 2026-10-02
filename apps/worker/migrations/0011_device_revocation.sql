CREATE TABLE room_devices (
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  joined_epoch INTEGER NOT NULL,
  -- Last room sequence already represented by the device's initial MLS state.
  -- The device must begin ordered processing at joined_seq + 1.
  joined_seq INTEGER NOT NULL CHECK (joined_seq >= 0),
  removed_epoch INTEGER,
  created_at INTEGER NOT NULL,
  removed_at INTEGER,
  PRIMARY KEY (room_id, device_id)
) STRICT;

CREATE INDEX idx_room_devices_device ON room_devices(device_id, removed_at);

-- Every device that existed when its user joined was included in the room's MLS
-- Welcome/commit. This also recovers the creating device, which does not have a
-- room_device_keys row because it never receives its own Welcome.
INSERT INTO room_devices (room_id, device_id, user_id, joined_epoch, joined_seq, removed_epoch, created_at, removed_at)
SELECT rm.room_id, d.device_id, d.user_id,
       COALESCE((SELECT MIN(rdk.epoch) FROM room_device_keys rdk WHERE rdk.room_id = rm.room_id AND rdk.device_id = d.device_id), 1),
       0, NULL, rm.joined_at, NULL
FROM room_members rm
JOIN devices d ON d.user_id = rm.user_id AND d.created_at <= rm.joined_at
WHERE rm.removed_at IS NULL
ON CONFLICT(room_id, device_id) DO NOTHING;

-- A device that has authored an event demonstrably belongs to that room, even
-- if it predates the membership metadata migration above.
INSERT INTO room_devices (room_id, device_id, user_id, joined_epoch, joined_seq, removed_epoch, created_at, removed_at)
SELECT DISTINCT re.room_id, re.device_id, re.sender, 1, 0, NULL, re.created_at, NULL
FROM room_events re
JOIN devices d ON d.device_id = re.device_id AND d.user_id = re.sender
ON CONFLICT(room_id, device_id) DO NOTHING;

CREATE TABLE device_revocations (
  revocation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  target_device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  requested_by_device_id TEXT NOT NULL REFERENCES devices(device_id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'finalizing', 'complete')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT;

CREATE UNIQUE INDEX idx_device_revocations_active_target
ON device_revocations(target_device_id)
WHERE status != 'complete';

CREATE TABLE device_revocation_rooms (
  revocation_id TEXT NOT NULL REFERENCES device_revocations(revocation_id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  expected_epoch INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  event_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (revocation_id, room_id)
) STRICT;

CREATE UNIQUE INDEX idx_device_revocation_rooms_active_room
ON device_revocation_rooms(room_id)
WHERE status = 'pending';
