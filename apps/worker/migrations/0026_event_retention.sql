ALTER TABLE room_events ADD COLUMN accepted_at INTEGER;
ALTER TABLE rooms ADD COLUMN retention_gc_at INTEGER;

CREATE INDEX idx_room_events_retention
  ON room_events(room_id, seq, accepted_at);

CREATE INDEX idx_rooms_retention_gc
  ON rooms(retention_days, retention_gc_at);
