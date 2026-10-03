-- edgechat-migration-phase: contract
-- edgechat-migration-approval: predeployment schema naming cleanup; EdgeChat has no deployed legacy database
-- edgechat-min-worker-protocol: 1
-- A device credential is a browser-held possession secret used together with
-- the registered signing key. It is rotated by backup restore and invalidated
-- when a password change ends other device sessions. Challenges are D1-only,
-- one per device, and never create an R2/S3 object.
ALTER TABLE devices RENAME COLUMN restore_credential_hash TO device_credential_hash;

CREATE TABLE device_session_challenges (
  challenge_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL UNIQUE REFERENCES devices(device_id) ON DELETE CASCADE,
  challenge_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX idx_device_session_challenges_expiry
  ON device_session_challenges(expires_at, challenge_id);
