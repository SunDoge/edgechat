ALTER TABLE rooms ADD COLUMN retention_floor_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN retention_generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rooms ADD COLUMN retention_days INTEGER;

CREATE INDEX idx_rooms_retention_policy
  ON rooms(retention_days, retention_floor_seq);
