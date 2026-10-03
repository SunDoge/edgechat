-- edgechat-migration-phase: expand
-- Pin each temporary linked-device history shard to the client-computed
-- ciphertext digest so an ambiguous PUT can be recovered without resending a
-- 16 MiB object and downloads can reject provider-side corruption.
ALTER TABLE device_link_history_shards ADD COLUMN ciphertext_sha256 TEXT DEFAULT NULL;
