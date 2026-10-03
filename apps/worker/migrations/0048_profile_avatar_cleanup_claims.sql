-- edgechat-migration-phase: expand
-- Separates an in-flight exact deletion claim from the avatar write-intent
-- timestamp so crashed cleaners are recoverable without racing upload retry.
ALTER TABLE profile_avatar_deletions ADD COLUMN deleting_token TEXT DEFAULT NULL;
ALTER TABLE profile_avatar_deletions ADD COLUMN deleting_expires_at INTEGER DEFAULT NULL;

CREATE INDEX idx_profile_avatar_deletions_claim
  ON profile_avatar_deletions(deleting_expires_at, requested_at, object_key);
