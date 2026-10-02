ALTER TABLE rooms ADD COLUMN repair_audit_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN repair_audit_at INTEGER;

-- One bounded outstanding range per room is enough: once repaired, auditing
-- resumes after the saved cursor. The job contains only sequence metadata.
CREATE TABLE history_repair_jobs (
  room_id TEXT PRIMARY KEY REFERENCES rooms(room_id) ON DELETE CASCADE,
  start_seq INTEGER NOT NULL,
  end_seq INTEGER NOT NULL,
  missing_count INTEGER NOT NULL,
  detected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (start_seq >= 1),
  CHECK (end_seq >= start_seq),
  CHECK (end_seq - start_seq < 500),
  CHECK (missing_count >= 1 AND missing_count <= 500)
) STRICT;

CREATE INDEX idx_history_repair_jobs_detected
  ON history_repair_jobs(detected_at, room_id);

CREATE TABLE history_repair_attempts (
  room_id TEXT NOT NULL REFERENCES history_repair_jobs(room_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('local_incomplete', 'local_unverified')),
  attempted_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, device_id)
) STRICT;

CREATE INDEX idx_history_repair_attempts_device
  ON history_repair_attempts(device_id, attempted_at);

CREATE INDEX idx_rooms_repair_audit
  ON rooms(repair_audit_at, room_id);
