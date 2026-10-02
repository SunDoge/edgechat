ALTER TABLE device_key_packages ADD COLUMN consumed_room_id TEXT;
CREATE INDEX idx_key_packages_claim ON device_key_packages(claimed_by_device_id, consumed_room_id);
