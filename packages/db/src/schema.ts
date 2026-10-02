export const LOCAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS cached_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  session_json JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  signing_key JSONB NOT NULL,
  encryption_key JSONB NOT NULL,
  revoked_at BIGINT
);
CREATE TABLE IF NOT EXISTS device_verifications (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  verified_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_device_verifications_user ON device_verifications(user_id, verified_at DESC);
CREATE TABLE IF NOT EXISTS rooms (
  room_id TEXT PRIMARY KEY,
  name TEXT,
  kind TEXT NOT NULL,
  current_seq BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_snapshots (
  room_id TEXT PRIMARY KEY,
  snapshot JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS room_hidden_senders (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_room_hidden_senders_room ON room_hidden_senders(room_id);
CREATE TABLE IF NOT EXISTS messages (
  event_id TEXT PRIMARY KEY,
  message_id TEXT,
  room_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  sender TEXT NOT NULL,
  device_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  ciphertext TEXT NOT NULL,
  plaintext TEXT,
  payload JSONB,
  search_vector TSVECTOR,
  deleted_at BIGINT,
  deleted_by TEXT,
  delete_event_id TEXT,
  edited_at BIGINT,
  edit_event_id TEXT,
  expires_at BIGINT,
  UNIQUE (room_id, seq)
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at BIGINT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delete_event_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at BIGINT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edit_event_id TEXT;
UPDATE messages SET message_id = event_id WHERE message_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);
CREATE INDEX IF NOT EXISTS idx_messages_expiry ON messages(expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS expired_messages (
  message_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  expired_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expired_messages_room ON expired_messages(room_id, expired_at);
CREATE TABLE IF NOT EXISTS room_message_expiry (
  room_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  effective_after_seq BIGINT NOT NULL,
  expires_in_seconds INTEGER,
  updated_by TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK (expires_in_seconds IS NULL OR expires_in_seconds IN (3600, 86400, 604800, 2592000))
);
CREATE TABLE IF NOT EXISTS message_tombstones (
  target_message_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  delete_event_id TEXT NOT NULL UNIQUE,
  delete_seq BIGINT NOT NULL,
  deleted_by TEXT NOT NULL,
  deleted_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tombstones_room ON message_tombstones(room_id, delete_seq);
CREATE TABLE IF NOT EXISTS message_edits (
  edit_event_id TEXT PRIMARY KEY,
  target_message_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  edit_seq BIGINT NOT NULL,
  sender TEXT NOT NULL,
  text_content TEXT NOT NULL,
  edited_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_edits_target ON message_edits(target_message_id, edit_seq DESC);
CREATE TABLE IF NOT EXISTS message_reactions (
  reaction_event_id TEXT PRIMARY KEY,
  target_message_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  reaction_seq BIGINT NOT NULL,
  sender TEXT NOT NULL,
  reaction TEXT,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_reactions_target ON message_reactions(room_id, target_message_id, sender, reaction_seq DESC);
CREATE TABLE IF NOT EXISTS room_read_state (
  room_id TEXT PRIMARY KEY,
  last_read_seq BIGINT NOT NULL DEFAULT 0,
  last_receipt_sent_seq BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_preferences (
  room_id TEXT PRIMARY KEY,
  pinned_at BIGINT,
  archived_at BIGINT,
  muted_until BIGINT,
  local_retention_days INTEGER,
  updated_at BIGINT NOT NULL
);
ALTER TABLE room_preferences ADD COLUMN IF NOT EXISTS local_retention_days INTEGER;
CREATE TABLE IF NOT EXISTS device_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  link_previews BOOLEAN NOT NULL DEFAULT TRUE,
  share_presence BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS composer_drafts (
  room_id TEXT PRIMARY KEY,
  text_content TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('message', 'reply', 'quote', 'edit')),
  target_message_id TEXT,
  quote_text TEXT,
  updated_at BIGINT NOT NULL
);
ALTER TABLE composer_drafts ADD COLUMN IF NOT EXISTS quote_text TEXT;
ALTER TABLE composer_drafts DROP CONSTRAINT IF EXISTS composer_drafts_mode_check;
ALTER TABLE composer_drafts ADD CONSTRAINT composer_drafts_mode_check CHECK (mode IN ('message', 'reply', 'quote', 'edit'));
CREATE TABLE IF NOT EXISTS composer_draft_sync_state (
  room_id TEXT PRIMARY KEY,
  server_updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS composer_draft_outbox (
  room_id TEXT PRIMARY KEY,
  draft_json JSONB,
  client_updated_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS composer_draft_device_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  device_ids TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS read_receipts (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_read_seq BIGINT NOT NULL,
  receipt_event_id TEXT NOT NULL,
  read_at BIGINT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_read_receipts_room_seq ON read_receipts(room_id, last_read_seq);
CREATE TABLE IF NOT EXISTS room_delivery_state (
  room_id TEXT PRIMARY KEY,
  last_receipt_sent_seq BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_receipts (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_delivered_seq BIGINT NOT NULL,
  receipt_event_id TEXT NOT NULL,
  delivered_at BIGINT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_delivery_receipts_room_seq ON delivery_receipts(room_id, last_delivered_seq);
CREATE TABLE IF NOT EXISTS outbox (
  event_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  event_json JSONB NOT NULL,
  plaintext TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_room ON outbox(room_id, created_at);
CREATE TABLE IF NOT EXISTS device_revocation_outbox (
  revocation_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  target_device_id TEXT NOT NULL,
  event_json JSONB NOT NULL,
  mls_state BYTEA NOT NULL,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (revocation_id, room_id)
);
ALTER TABLE device_revocation_outbox ADD COLUMN IF NOT EXISTS mls_state BYTEA;
ALTER TABLE device_revocation_outbox ADD COLUMN IF NOT EXISTS previous_mls_state BYTEA;
CREATE INDEX IF NOT EXISTS idx_device_revocation_outbox_target ON device_revocation_outbox(target_device_id, created_at);
CREATE TABLE IF NOT EXISTS device_link_outbox (
  link_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  target_device_id TEXT NOT NULL,
  event_json JSONB NOT NULL,
  encrypted_state TEXT NOT NULL,
  previous_mls_state BYTEA NOT NULL,
  mls_state BYTEA NOT NULL,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (link_id, room_id)
);
CREATE INDEX IF NOT EXISTS idx_device_link_outbox_target ON device_link_outbox(target_device_id, created_at);
CREATE TABLE IF NOT EXISTS device_link_jobs (
  link_id TEXT PRIMARY KEY,
  target_device_id TEXT NOT NULL,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_removal_outbox (
  deletion_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  target_device_ids JSONB NOT NULL,
  event_json JSONB NOT NULL,
  previous_mls_state BYTEA,
  mls_state BYTEA NOT NULL,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (deletion_id, room_id)
);
ALTER TABLE account_removal_outbox ADD COLUMN IF NOT EXISTS previous_mls_state BYTEA;
CREATE INDEX IF NOT EXISTS idx_account_removal_outbox_created ON account_removal_outbox(created_at);
CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  processed_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_sync_state (
  room_id TEXT PRIMARY KEY,
  baseline_seq BIGINT NOT NULL CHECK (baseline_seq >= 0),
  processed_through_seq BIGINT NOT NULL CHECK (processed_through_seq >= baseline_seq),
  updated_at BIGINT NOT NULL
);
-- Durable ciphertext inbox for rooms that cannot advance because an earlier
-- MLS event was intentionally collected from the cloud. Keeping these events
-- separate is important: event_envelopes means "processed" and participates
-- in contiguous sequence advancement, while deferred_room_events does not.
CREATE TABLE IF NOT EXISTS deferred_room_events (
  event_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  seq BIGINT NOT NULL CHECK (seq > 0),
  event_json JSONB NOT NULL,
  deferred_at BIGINT NOT NULL,
  UNIQUE (room_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_deferred_room_events_room_seq ON deferred_room_events(room_id, seq);
-- Exact server-accepted envelopes are kept separately from UI projections.
-- Rows created before this table existed are intentionally not repairable.
CREATE TABLE IF NOT EXISTS event_envelopes (
  event_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  event_json JSONB NOT NULL,
  stored_at BIGINT NOT NULL,
  UNIQUE (room_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_event_envelopes_room_seq ON event_envelopes(room_id, seq);
CREATE TABLE IF NOT EXISTS failed_events (
  event_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  event_json JSONB NOT NULL,
  error TEXT NOT NULL,
  failed_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_failed_events_room_seq ON failed_events(room_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_search ON messages USING GIN(search_vector);
CREATE TABLE IF NOT EXISTS attachments (
  attachment_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  event_id TEXT,
  message_id TEXT,
  part_id TEXT,
  mime_type TEXT,
  plaintext_bytes BIGINT,
  width INTEGER,
  height INTEGER,
  local_status TEXT NOT NULL,
  metadata JSONB NOT NULL
);
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS message_id TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS part_id TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS mime_type TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS plaintext_bytes BIGINT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS width INTEGER;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS height INTEGER;
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
CREATE TABLE IF NOT EXISTS message_parts (
  part_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text_content TEXT,
  attachment_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  UNIQUE (message_id, position)
);
CREATE INDEX IF NOT EXISTS idx_message_parts_message ON message_parts(message_id, position);
CREATE TABLE IF NOT EXISTS image_embeddings (
  attachment_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  preprocessing_version TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  embedding BYTEA NOT NULL,
  indexed_at BIGINT NOT NULL,
  PRIMARY KEY (attachment_id, model_id, model_version, preprocessing_version)
);
CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);
INSERT INTO sync_state (id, cursor, updated_at) VALUES (1, 0, 0) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS segment_state (
  room_id TEXT PRIMARY KEY,
  indexed_until_seq BIGINT,
  oldest_local_seq BIGINT,
  newest_local_seq BIGINT,
  history_complete BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS crypto_state (
  room_id TEXT PRIMARY KEY,
  epoch BIGINT NOT NULL,
  state BYTEA NOT NULL,
  provider TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS archive_keys (
  segment_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  segment_key BYTEA NOT NULL,
  start_seq BIGINT NOT NULL,
  end_seq BIGINT NOT NULL,
  received_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_archive_keys_room ON archive_keys(room_id, start_seq);
CREATE TABLE IF NOT EXISTS archive_segment_metadata (
  segment_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  start_seq BIGINT NOT NULL,
  end_seq BIGINT NOT NULL,
  byte_size BIGINT NOT NULL,
  header_bytes BYTEA NOT NULL,
  envelope_index_bytes BYTEA NOT NULL,
  verified_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_archive_segment_metadata_room ON archive_segment_metadata(room_id, start_seq);
CREATE TABLE IF NOT EXISTS compaction_jobs (
  room_id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  start_seq BIGINT NOT NULL,
  end_seq BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  subscribed BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at BIGINT NOT NULL
);
`;

export const LOCAL_CLEAR_ACCOUNT_DATA = `
TRUNCATE TABLE
  account_state, cached_session, users, devices, device_verifications, rooms, room_snapshots, room_members, room_hidden_senders, messages, expired_messages, room_message_expiry, message_tombstones, message_edits, message_reactions,
  room_read_state, room_preferences, device_preferences, composer_drafts, composer_draft_sync_state, composer_draft_outbox, composer_draft_device_state, read_receipts, room_delivery_state, delivery_receipts, outbox,
  device_revocation_outbox, device_link_jobs, device_link_outbox, account_removal_outbox, processed_events, room_sync_state, deferred_room_events, event_envelopes, failed_events, attachments,
  message_parts, image_embeddings, segment_state, crypto_state, archive_keys, archive_segment_metadata, compaction_jobs, push_state
CASCADE;
UPDATE sync_state SET cursor = 0, updated_at = 0 WHERE id = 1;
`;

// Preserve message/search/archive data, but never clone browser-specific work
// queues or OpenMLS state from the approving device into the new device.
export const LOCAL_PREPARE_LINKED_DEVICE_HISTORY = `
TRUNCATE TABLE
  outbox, device_revocation_outbox, device_link_jobs, device_link_outbox,
  account_removal_outbox, deferred_room_events, failed_events, crypto_state, room_sync_state, compaction_jobs, room_preferences, device_preferences, room_hidden_senders, composer_drafts, composer_draft_sync_state, composer_draft_outbox, composer_draft_device_state, cached_session, room_snapshots
CASCADE;
UPDATE push_state SET subscribed = FALSE, updated_at = 0 WHERE id = 1;
`;
