ALTER TABLE users ADD COLUMN invitation_policy TEXT NOT NULL DEFAULT 'everyone'
  CHECK (invitation_policy IN ('everyone', 'shared_rooms', 'nobody'));
