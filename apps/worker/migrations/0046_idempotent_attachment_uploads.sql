-- edgechat-migration-phase: expand
-- Bind a pending object reservation to the exact client-chosen attachment so
-- retries cannot change its room or ciphertext while reusing the quota claim.
ALTER TABLE pending_r2_writes ADD COLUMN room_id TEXT DEFAULT NULL;
ALTER TABLE pending_r2_writes ADD COLUMN content_sha256 TEXT DEFAULT NULL;
