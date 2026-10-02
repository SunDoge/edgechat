ALTER TABLE attachments ADD COLUMN committed_event_id TEXT REFERENCES room_events(event_id) ON DELETE SET NULL;
ALTER TABLE attachments ADD COLUMN committed_at INTEGER;
CREATE INDEX idx_attachments_uncommitted ON attachments(committed_at, created_at);
