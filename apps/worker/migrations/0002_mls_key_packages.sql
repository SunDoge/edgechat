ALTER TABLE rooms ADD COLUMN mls_epoch INTEGER NOT NULL DEFAULT 0;

CREATE TABLE device_key_packages (
  package_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  key_package TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  claimed_by_device_id TEXT REFERENCES devices(device_id)
) STRICT;

CREATE INDEX idx_key_packages_available ON device_key_packages(device_id, claimed_at, created_at);
