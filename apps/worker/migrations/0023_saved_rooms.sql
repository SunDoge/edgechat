ALTER TABLE rooms ADD COLUMN purpose TEXT NOT NULL DEFAULT 'chat'
  CHECK (purpose IN ('chat', 'saved'));

CREATE UNIQUE INDEX idx_rooms_saved_owner
  ON rooms(created_by)
  WHERE purpose = 'saved';
