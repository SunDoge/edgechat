-- Direct conversations from previously unknown users begin as message requests.
-- Pending requests remain D1/DO-only and cannot allocate attachment/archive R2 objects.
CREATE TABLE direct_message_requests (
  room_id TEXT PRIMARY KEY REFERENCES rooms(room_id) ON DELETE CASCADE,
  requester_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  recipient_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  CHECK (requester_user_id <> recipient_user_id)
) STRICT;

CREATE INDEX idx_direct_message_requests_recipient
  ON direct_message_requests(recipient_user_id, status, created_at);
CREATE INDEX idx_direct_message_requests_requester
  ON direct_message_requests(requester_user_id, status, created_at);

CREATE TABLE message_request_rate_windows (
  requester_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (requester_user_id, window_started_at)
) STRICT;

CREATE TABLE message_request_reservations (
  room_id TEXT PRIMARY KEY,
  requester_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  recipient_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,
  CHECK (requester_user_id <> recipient_user_id)
) STRICT;

CREATE INDEX idx_message_request_reservations_requester
  ON message_request_reservations(requester_user_id, consumed_at, created_at);

CREATE TABLE room_reports (
  report_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  reporter_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  reported_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('spam', 'abuse', 'other')),
  event_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'dismissed')),
  resolution_note TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  UNIQUE (room_id, reporter_user_id)
) STRICT;

CREATE INDEX idx_room_reports_reported
  ON room_reports(reported_user_id, created_at);

CREATE INDEX idx_room_reports_status
  ON room_reports(status, report_id);

CREATE TABLE operator_report_actions (
  action_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES room_reports(report_id) ON DELETE CASCADE,
  resolution TEXT NOT NULL CHECK (resolution IN ('confirmed', 'dismissed')),
  note TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_operator_report_actions_report
  ON operator_report_actions(report_id, created_at);
