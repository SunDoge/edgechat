-- Account appeals are deliberately metadata-only and D1-only. A valid
-- password proves control of the server account, but never grants access to
-- MLS state or locally stored message history.
CREATE TABLE account_appeals (
  appeal_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  receipt_hash TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('login_locked', 'device_lost', 'account_access')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER
) STRICT;

CREATE UNIQUE INDEX idx_account_appeals_pending_user
  ON account_appeals(user_id)
  WHERE status = 'pending';

CREATE INDEX idx_account_appeals_status_created
  ON account_appeals(status, created_at, appeal_id);

CREATE INDEX idx_account_appeals_expiry
  ON account_appeals(expires_at);

CREATE TABLE operator_appeal_actions (
  action_id TEXT PRIMARY KEY,
  appeal_id TEXT NOT NULL REFERENCES account_appeals(appeal_id) ON DELETE CASCADE,
  resolution TEXT NOT NULL CHECK (resolution IN ('approved', 'denied')),
  login_unlocked INTEGER NOT NULL DEFAULT 0 CHECK (login_unlocked IN (0, 1)),
  note TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_operator_appeal_actions_appeal
  ON operator_appeal_actions(appeal_id, created_at);
