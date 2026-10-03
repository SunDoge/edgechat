-- edgechat-migration-phase: expand
-- Circuit-break a missing or provider-corrupt temporary device-history shard
-- after one object read while preserving its exact D1 cleanup/reupload identity.
CREATE TABLE device_link_history_shard_repairs (
  link_id TEXT NOT NULL,
  shard_index INTEGER NOT NULL,
  repair_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL CHECK (reason IN ('missing', 'invalid')),
  detected_at INTEGER NOT NULL,
  PRIMARY KEY (link_id, shard_index),
  FOREIGN KEY (link_id, shard_index)
    REFERENCES device_link_history_shards(link_id, shard_index) ON DELETE CASCADE
);

CREATE INDEX device_link_history_shard_repairs_detected_idx
  ON device_link_history_shard_repairs(detected_at, link_id, shard_index);
