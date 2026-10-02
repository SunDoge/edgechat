ALTER TABLE attachments ADD COLUMN ciphertext_sha256 TEXT;

-- Missing objects remain logical attachments and keep their existing quota
-- reservation. A repair replaces the absent bytes at the same opaque key.
CREATE TABLE attachment_repair_jobs (
  attachment_id TEXT PRIMARY KEY REFERENCES attachments(attachment_id) ON DELETE CASCADE,
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

CREATE INDEX idx_attachment_repair_jobs_updated
  ON attachment_repair_jobs(updated_at, attachment_id);
CREATE INDEX idx_attachment_repair_jobs_lease
  ON attachment_repair_jobs(lease_expires_at, attachment_id);
