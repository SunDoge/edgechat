-- edgechat-migration-phase: expand
-- A D1 circuit breaker prevents repeated object-store reads for a missing or
-- corrupt current avatar and lets its owner restore the exact bytes/key.
CREATE TABLE profile_avatar_repair_jobs (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  avatar_sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 131072),
  detected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_token TEXT,
  lease_expires_at INTEGER
) STRICT;

CREATE INDEX idx_profile_avatar_repair_jobs_age
  ON profile_avatar_repair_jobs(updated_at, user_id);
