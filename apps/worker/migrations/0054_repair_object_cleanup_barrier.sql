-- edgechat-migration-phase: expand
-- A corrupt-object repair is not uploadable until the exact old key has been
-- deleted. This barrier prevents a late concurrent reader from deleting bytes
-- that another device has already restored.
ALTER TABLE attachment_repair_jobs ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0
  CHECK (cleanup_pending IN (0, 1));
ALTER TABLE archive_segment_repair_jobs ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0
  CHECK (cleanup_pending IN (0, 1));
ALTER TABLE profile_avatar_repair_jobs ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0
  CHECK (cleanup_pending IN (0, 1));

-- Readers bind repair detection to the object generation they observed before
-- the GET. Successful repair advances it atomically with job completion, so a
-- delayed response from the old generation cannot reopen or clean up the key.
ALTER TABLE attachments ADD COLUMN repair_generation INTEGER NOT NULL DEFAULT 0
  CHECK (repair_generation >= 0);
ALTER TABLE archive_segments ADD COLUMN repair_generation INTEGER NOT NULL DEFAULT 0
  CHECK (repair_generation >= 0);
ALTER TABLE users ADD COLUMN avatar_repair_generation INTEGER NOT NULL DEFAULT 0
  CHECK (avatar_repair_generation >= 0);

CREATE INDEX idx_attachment_repair_cleanup
  ON attachment_repair_jobs(cleanup_pending, updated_at, attachment_id);
CREATE INDEX idx_archive_repair_cleanup
  ON archive_segment_repair_jobs(cleanup_pending, updated_at, segment_id);
CREATE INDEX idx_profile_avatar_repair_cleanup
  ON profile_avatar_repair_jobs(cleanup_pending, updated_at, user_id);
