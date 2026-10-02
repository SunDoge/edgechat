ALTER TABLE archive_segments ADD COLUMN ciphertext_sha256 TEXT;

CREATE TABLE archive_segment_retention_acks (
  segment_id TEXT NOT NULL REFERENCES archive_segments(segment_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  cached_at INTEGER NOT NULL,
  PRIMARY KEY (segment_id, device_id)
) STRICT;

CREATE INDEX idx_archive_segment_retention_acks_device
  ON archive_segment_retention_acks(device_id, cached_at);

CREATE TABLE archive_segment_repair_jobs (
  segment_id TEXT PRIMARY KEY REFERENCES archive_segments(segment_id) ON DELETE CASCADE,
  detected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  lease_device_id TEXT REFERENCES devices(device_id) ON DELETE SET NULL,
  lease_token_hash TEXT,
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  CHECK ((lease_device_id IS NULL AND lease_token_hash IS NULL AND lease_expires_at IS NULL)
      OR (lease_device_id IS NOT NULL AND lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_archive_segment_repair_jobs_updated
  ON archive_segment_repair_jobs(updated_at, segment_id);
CREATE INDEX idx_archive_segment_repair_jobs_lease
  ON archive_segment_repair_jobs(lease_expires_at, segment_id);
