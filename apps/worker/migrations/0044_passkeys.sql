-- edgechat-migration-phase: expand
-- Passkeys authenticate the server account; they never replace a device's
-- signing/ECDH keys or MLS state. All rows live in D1 and create no R2 object.
ALTER TABLE users ADD COLUMN webauthn_user_id TEXT;

CREATE UNIQUE INDEX idx_users_webauthn_user_id
  ON users(webauthn_user_id) WHERE webauthn_user_id IS NOT NULL;

CREATE TABLE passkeys (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL CHECK (counter >= 0),
  transports TEXT NOT NULL,
  device_type TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up INTEGER NOT NULL CHECK (backed_up IN (0, 1)),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;

CREATE INDEX idx_passkeys_user
  ON passkeys(user_id, created_at, credential_id);

CREATE TABLE passkey_challenges (
  challenge_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id TEXT,
  display_name TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'authenticate')),
  challenge_hash TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  UNIQUE (user_id, purpose)
) STRICT;

CREATE INDEX idx_passkey_challenges_expiry
  ON passkey_challenges(expires_at, challenge_id);
