ALTER TABLE bot_integrations ADD COLUMN scope TEXT NOT NULL DEFAULT 'message:create'
  CHECK (scope = 'message:create');

ALTER TABLE bot_integrations ADD COLUMN max_messages_per_minute INTEGER NOT NULL DEFAULT 60
  CHECK (max_messages_per_minute BETWEEN 1 AND 600);

CREATE TABLE bot_rate_windows (
  bot_id TEXT PRIMARY KEY REFERENCES bot_integrations(bot_id) ON DELETE CASCADE,
  window_started_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL CHECK (message_count >= 0)
) STRICT;
