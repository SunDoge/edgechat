-- edgechat-migration-phase: expand
-- A member cannot author an MLS Commit that removes its own leaf. A leave
-- request therefore asks the current room owner to publish the normal signed
-- Remove Commit. This D1-only queue stores routing/progress metadata and never
-- creates an R2 object.
CREATE TABLE room_leave_requests (
  request_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'cancelled', 'complete')),
  commit_event_id TEXT,
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(room_id, user_id)
) STRICT;

CREATE INDEX idx_room_leave_requests_pending
  ON room_leave_requests(status, updated_at, room_id);
