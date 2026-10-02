-- A per-account, per-group visibility preference. This never changes room
-- membership or event delivery; clients still process every MLS event.
CREATE TABLE group_hidden_members (
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  hidden_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id, hidden_user_id),
  CHECK (user_id <> hidden_user_id)
) STRICT;

CREATE INDEX idx_group_hidden_members_user
  ON group_hidden_members(user_id, room_id);
