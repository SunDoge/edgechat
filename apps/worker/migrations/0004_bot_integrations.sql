ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'bot'));

CREATE TABLE bot_integrations (
  bot_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL UNIQUE REFERENCES devices(device_id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  room_id TEXT REFERENCES rooms(room_id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

CREATE INDEX idx_bot_integrations_user ON bot_integrations(user_id, revoked_at);
