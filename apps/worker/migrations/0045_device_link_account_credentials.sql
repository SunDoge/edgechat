-- edgechat-migration-phase: expand
-- A linked device receives the random account login credential in a small
-- target-device-encrypted envelope. It is D1 metadata, never an R2 object.
ALTER TABLE device_links ADD COLUMN account_credential_envelope TEXT;
ALTER TABLE device_links ADD COLUMN account_credential_source_device_id TEXT;

ALTER TABLE users ADD COLUMN account_mode TEXT NOT NULL DEFAULT 'password'
  CHECK (account_mode IN ('password', 'opaque'));
