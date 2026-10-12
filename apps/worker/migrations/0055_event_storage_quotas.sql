-- edgechat-migration-phase: expand
ALTER TABLE user_storage_usage ADD COLUMN event_bytes INTEGER NOT NULL DEFAULT 0 CHECK (event_bytes >= 0);
ALTER TABLE user_storage_usage ADD COLUMN event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0);

ALTER TABLE user_storage_limits ADD COLUMN event_quota_bytes INTEGER CHECK (event_quota_bytes IS NULL OR event_quota_bytes > 0);
ALTER TABLE user_storage_limits ADD COLUMN event_limit INTEGER CHECK (event_limit IS NULL OR event_limit > 0);

CREATE TABLE event_storage_claims (
  event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  reservation_token TEXT NOT NULL UNIQUE,
  charged_bytes INTEGER NOT NULL CHECK (charged_bytes > 0),
  created_at INTEGER NOT NULL,
  accepted_at INTEGER
) STRICT;

CREATE INDEX idx_event_storage_claims_pending
  ON event_storage_claims(accepted_at, created_at)
  WHERE accepted_at IS NULL;
CREATE INDEX idx_event_storage_claims_room
  ON event_storage_claims(room_id, event_id);
