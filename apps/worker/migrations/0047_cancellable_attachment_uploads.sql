-- edgechat-migration-phase: expand
-- A client that exhausts its bounded idempotent retries can cancel the exact
-- upload claim without racing a late object-store response into a live row.
ALTER TABLE pending_r2_writes ADD COLUMN cancelled_at INTEGER DEFAULT NULL;
