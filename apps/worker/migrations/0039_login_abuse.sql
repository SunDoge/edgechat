-- Bounded by registered accounts: unknown identifiers never allocate D1 rows.
-- This is an exact credential-abuse backstop; fast request shedding happens in
-- Cloudflare's edge-local Rate Limiting bindings.
CREATE TABLE login_failure_state (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  window_started_at INTEGER NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK (failure_count >= 0)
) STRICT;

CREATE INDEX idx_login_failure_state_updated
  ON login_failure_state(updated_at);

CREATE TABLE operator_login_unlock_actions (
  action_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  previous_failure_count INTEGER NOT NULL,
  previous_blocked_until INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL,
  CHECK (previous_failure_count >= 0)
) STRICT;

CREATE INDEX idx_operator_login_unlock_actions_user
  ON operator_login_unlock_actions(user_id, created_at);
