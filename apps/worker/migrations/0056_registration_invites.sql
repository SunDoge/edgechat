-- edgechat-migration-phase: expand
CREATE TABLE registration_invites (
  invite_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 1000),
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count BETWEEN 0 AND max_uses),
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;

CREATE INDEX registration_invites_active_idx
  ON registration_invites (revoked_at, expires_at, created_at);

CREATE TABLE registration_invite_uses (
  invite_id TEXT NOT NULL REFERENCES registration_invites(invite_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (invite_id, user_id)
) STRICT;
