ALTER TABLE device_key_packages ADD COLUMN claim_context TEXT;

CREATE UNIQUE INDEX idx_key_packages_claim_context
  ON device_key_packages(claimed_by_device_id, device_id, claim_context)
  WHERE claim_context IS NOT NULL AND consumed_room_id IS NULL;
