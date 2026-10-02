CREATE TABLE device_link_history_transfers (
  link_id TEXT PRIMARY KEY REFERENCES device_links(link_id) ON DELETE CASCADE,
  transfer_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  source_device_id TEXT NOT NULL REFERENCES devices(device_id),
  plaintext_bytes INTEGER NOT NULL CHECK (plaintext_bytes > 0),
  shard_plaintext_bytes INTEGER NOT NULL CHECK (shard_plaintext_bytes BETWEEN 1048576 AND 33554432),
  shard_count INTEGER NOT NULL CHECK (shard_count BETWEEN 1 AND 4096),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE device_link_history_shards (
  link_id TEXT NOT NULL REFERENCES device_link_history_transfers(link_id) ON DELETE CASCADE,
  shard_index INTEGER NOT NULL CHECK (shard_index >= 0),
  object_key TEXT NOT NULL UNIQUE,
  ciphertext_bytes INTEGER NOT NULL CHECK (ciphertext_bytes > 0),
  status TEXT NOT NULL CHECK (status IN ('ready', 'acked')),
  uploaded_at INTEGER NOT NULL,
  acked_at INTEGER,
  PRIMARY KEY (link_id, shard_index)
);

CREATE INDEX device_link_history_shards_status_idx
  ON device_link_history_shards(link_id, status, shard_index);
