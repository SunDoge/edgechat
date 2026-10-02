CREATE TABLE attachment_retention_acks (
  attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  cached_at INTEGER NOT NULL,
  PRIMARY KEY (attachment_id, device_id)
) STRICT;

CREATE INDEX idx_attachment_retention_acks_device
  ON attachment_retention_acks(device_id, cached_at);
