ALTER TABLE device_key_packages ADD COLUMN key_package_fingerprint TEXT;

CREATE UNIQUE INDEX idx_key_packages_device_fingerprint
  ON device_key_packages(device_id, key_package_fingerprint)
  WHERE key_package_fingerprint IS NOT NULL;
