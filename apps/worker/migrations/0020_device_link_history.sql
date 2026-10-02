-- A device link may temporarily carry one client-encrypted PGlite snapshot.
-- The object is quota-accounted while present and deleted after successful import.
ALTER TABLE device_links ADD COLUMN history_object_key TEXT;
ALTER TABLE device_links ADD COLUMN history_bytes INTEGER;
ALTER TABLE device_links ADD COLUMN history_uploaded_at INTEGER;
ALTER TABLE device_links ADD COLUMN history_source_device_id TEXT;
