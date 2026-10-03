-- edgechat-migration-phase: expand
-- Bind each temporary peer-recovery bundle to the source device's ciphertext
-- digest so ambiguous uploads can resume without resending the object and the
-- target can reject provider-side corruption before decrypting it.
ALTER TABLE room_peer_recoveries ADD COLUMN ciphertext_sha256 TEXT DEFAULT NULL;
