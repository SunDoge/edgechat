import { isClientEventEnvelope, isMessageExpiryPolicyPayload, isNamespacedRoomId, isNamespacedUserId, isRoomProfilePayload, type ClientEvent, type DeliveryReceiptPayload, type MessageEditPayload, type MessageExpiryPolicyPayload, type MessageExpirySeconds, type MessageId, type MessageReactionPayload, type ReadReceiptPayload, type RoomEvent, type RoomId, type RoomProfileAvatar, type RoomProfilePayload, type UserId } from "@edgechat/protocol";
import { LOCAL_CLEAR_ACCOUNT_DATA } from "./schema";
import { isLocalRetentionDays, type LocalRetentionDays } from "./retention";
import { messageExpiryAt } from "./expiry";
import type { LocalHistoryClearResult } from "./local-history";

type Pending = { resolve: (value: DbResponse) => void; reject: (error: Error) => void };
type DbResponse = { id: number; rows?: unknown[]; blob?: Blob; restored?: boolean; error?: string; storage?: "opfs" | "indexeddb" };

class LocalDatabaseResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalDatabaseResponseError";
  }
}

export type LocalMessage = {
  event_id: string; message_id: string; room_id: RoomId; seq: number; sender: string; device_id: string;
  event_type: string; created_at: number; ciphertext: string; plaintext: string | null;
  payload: Record<string, unknown> | null;
  deleted_at: number | null; deleted_by: string | null; delete_event_id: string | null;
  edited_at: number | null; edit_event_id: string | null;
  expires_at: number | null;
};

export type LocalMessageWindow = { messages: LocalMessage[]; hasOlder: boolean; hasNewer: boolean };
export type LocalRoomAttachmentCursor = { seq: number; position: number };
export type LocalRoomAttachment = {
  attachment_id: string; message_id: string; room_id: RoomId; seq: number; sender: string;
  created_at: number; position: number; kind: "attachment";
  metadata: Record<string, unknown>;
};
type LocalRoomAttachmentRow = Omit<LocalRoomAttachment, "kind" | "metadata"> & { kind: string; metadata: Record<string, unknown> | string };
export type LocalRoomAttachmentPage = { items: LocalRoomAttachment[]; next_cursor: LocalRoomAttachmentCursor | null };
export type LocalSignedEventRange = { events: RoomEvent[]; complete: boolean; missing_seq: number | null };
export type LocalRoomSyncState = { room_id: RoomId; baseline_seq: number; processed_through_seq: number };
type LocalEventEnvelopeRow = { event_id: string; room_id: string; seq: number | string; event_json: RoomEvent | string };
type LocalDeferredEventRow = { event_id: string; room_id: RoomId; seq: number | string; event_json: RoomEvent | string };
export type LocalStagedDecryptedEvent = {
  event: RoomEvent;
  plaintext: Uint8Array<ArrayBuffer>;
  sender_device_id: string;
  previous_mls_state: Uint8Array<ArrayBuffer>;
  next_mls_state: Uint8Array<ArrayBuffer>;
};
export type LocalStagedOutgoingEvent = {
  event: ClientEvent;
  plaintext: string;
  payload: Record<string, unknown>;
  previous_mls_state: Uint8Array<ArrayBuffer>;
  next_mls_state: Uint8Array<ArrayBuffer>;
};
export type LocalRoomDeviceSigningKey = { room_id: RoomId; device_id: string; user_id: UserId; signing_key: JsonWebKey };
export const PIN_ROOM_DEVICE_SIGNING_KEY_SQL = `INSERT INTO room_device_signing_keys (room_id,device_id,user_id,signing_key,first_seen_at,last_seen_at)
VALUES ($1,$2,$3,$4::jsonb,$5,$5)
ON CONFLICT (room_id,device_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
WHERE room_device_signing_keys.user_id = EXCLUDED.user_id AND room_device_signing_keys.signing_key = EXCLUDED.signing_key
RETURNING device_id`;

function canonicalSigningKey(value: JsonWebKey): JsonWebKey {
  if (value.kty !== "EC" || value.crv !== "P-256" || typeof value.x !== "string" || typeof value.y !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(value.x) || !/^[A-Za-z0-9_-]{43}$/.test(value.y)) throw new Error("Invalid device signing key");
  return { kty: "EC", crv: "P-256", x: value.x, y: value.y, ext: true };
}

const MAX_SIGNED_EVENT_RANGE = 500;
export const MARK_EVENT_PROCESSED_SQL = `WITH stored_envelope AS (
  INSERT INTO event_envelopes (event_id, room_id, seq, created_at, event_json, stored_at)
  VALUES ($1,$2,$3,$4,$5::jsonb,$6)
  ON CONFLICT (event_id) DO NOTHING
)
INSERT INTO processed_events (event_id, room_id, seq, processed_at)
VALUES ($1,$2,$3,$6) ON CONFLICT (event_id) DO NOTHING`;

export const PROMOTE_STAGED_OUTGOING_EVENT_SQL = `WITH staged AS (
  SELECT event_id,room_id,event_json,plaintext,payload,staged_at
  FROM outgoing_event_staging WHERE event_id = $1
), admitted AS (
  INSERT INTO outbox (event_id,message_id,room_id,event_json,plaintext,payload,status,attempts,next_attempt_at,last_error,created_at,updated_at)
  SELECT event_id,COALESCE(NULLIF(payload->>'message_id',''),event_id),room_id,event_json,plaintext,payload,'pending',0,staged_at,NULL,staged_at,staged_at
  FROM staged
  ON CONFLICT (event_id) DO UPDATE SET event_id = EXCLUDED.event_id
  WHERE outbox.room_id = EXCLUDED.room_id AND outbox.event_json = EXCLUDED.event_json
    AND outbox.plaintext = EXCLUDED.plaintext AND outbox.payload = EXCLUDED.payload
  RETURNING event_id
), superseded AS (
  DELETE FROM outbox o USING staged s, admitted a
  WHERE o.event_id <> a.event_id AND o.room_id = s.room_id AND o.status <> 'sending'
    AND s.payload->>'kind' IN ('receipt.read','receipt.delivered')
    AND o.payload->>'kind' = s.payload->>'kind'
), removed AS (
  DELETE FROM outgoing_event_staging s USING admitted a WHERE s.event_id = a.event_id
)
SELECT event_id FROM admitted`;

export const ADVANCE_ROOM_SEQUENCE_SQL = `WITH RECURSIVE contiguous(seq) AS (
  SELECT processed_through_seq FROM room_sync_state WHERE room_id = $1
  UNION ALL
  SELECT envelope.seq FROM event_envelopes envelope
  JOIN contiguous previous ON envelope.room_id = $1 AND envelope.seq = previous.seq + 1
)
UPDATE room_sync_state SET processed_through_seq = (SELECT MAX(seq) FROM contiguous), updated_at = $2
WHERE room_id = $1 RETURNING processed_through_seq`;

export const SET_HIDDEN_ROOM_MEMBERS_SQL = `WITH desired(user_id) AS (SELECT jsonb_array_elements_text($2::jsonb)),
  removed AS (DELETE FROM room_hidden_senders WHERE room_id = $1 AND user_id NOT IN (SELECT user_id FROM desired)),
  inserted AS (INSERT INTO room_hidden_senders (room_id,user_id,created_at)
    SELECT $1,user_id,$3 FROM desired ON CONFLICT DO NOTHING RETURNING user_id)
  SELECT count(*) FROM desired`;

export const ROOM_ATTACHMENTS_FIRST_PAGE_SQL = `SELECT a.attachment_id, m.message_id, m.room_id, m.seq, m.sender, m.created_at, p.position, p.kind, a.metadata
  FROM attachments a JOIN messages m ON m.message_id = a.message_id AND m.room_id = a.room_id
  JOIN message_parts p ON p.message_id = m.message_id AND p.attachment_id = a.attachment_id
  WHERE m.room_id = $1 AND m.deleted_at IS NULL AND p.kind = 'attachment'
    AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender)
  ORDER BY m.seq DESC, p.position DESC LIMIT $2`;

export const ROOM_ATTACHMENTS_BEFORE_SQL = `SELECT a.attachment_id, m.message_id, m.room_id, m.seq, m.sender, m.created_at, p.position, p.kind, a.metadata
  FROM attachments a JOIN messages m ON m.message_id = a.message_id AND m.room_id = a.room_id
  JOIN message_parts p ON p.message_id = m.message_id AND p.attachment_id = a.attachment_id
  WHERE m.room_id = $1 AND m.deleted_at IS NULL AND p.kind = 'attachment'
    AND (m.seq < $2 OR (m.seq = $2 AND p.position < $3))
    AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender)
  ORDER BY m.seq DESC, p.position DESC LIMIT $4`;

export const ROOM_UNREAD_COUNTS_SQL = `SELECT r.room_id,
       CASE WHEN COALESCE(p.manually_unread,FALSE) THEN GREATEST(1,count(m.event_id) FILTER (WHERE m.seq > COALESCE(s.last_read_seq, 0) AND m.sender <> $1 AND m.deleted_at IS NULL)::int)
            ELSE count(m.event_id) FILTER (WHERE m.seq > COALESCE(s.last_read_seq, 0) AND m.sender <> $1 AND m.deleted_at IS NULL)::int END AS unread_count,
       COALESCE(s.last_read_seq, 0) AS last_read_seq
  FROM rooms r
  LEFT JOIN room_read_state s ON s.room_id = r.room_id
  LEFT JOIN room_preferences p ON p.room_id = r.room_id
  LEFT JOIN messages m ON m.room_id = r.room_id AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender)
  GROUP BY r.room_id, s.last_read_seq, p.manually_unread`;

export const FIRST_UNREAD_VISIBLE_MESSAGE_SQL = `SELECT message_id, seq FROM messages m
  WHERE room_id = $1 AND seq > $2 AND sender <> $3 AND deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender)
  ORDER BY seq ASC LIMIT 1`;

export const MESSAGES_AFTER_SQL = `SELECT event_id, message_id, room_id, seq, sender, device_id, event_type, created_at, ciphertext, plaintext, payload, deleted_at, deleted_by, delete_event_id, edited_at, edit_event_id, expires_at
  FROM messages m WHERE room_id = $1 AND seq > $2
    AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender)
  ORDER BY seq ASC LIMIT $3`;

export const ROOM_LIST_ACTIVITIES_SQL = `WITH latest_messages AS (
    SELECT DISTINCT ON (m.room_id) m.room_id, m.message_id, m.sender, m.event_type, m.created_at, m.plaintext, m.payload, m.deleted_at,
      NULL::text AS outbox_status, 0 AS source_priority
    FROM messages m
    WHERE m.event_type IN ('message.text','message.file','message.contact')
      AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender)
    ORDER BY m.room_id, m.seq DESC
  ), latest_outbox AS (
    SELECT DISTINCT ON (o.room_id) o.room_id, o.message_id, o.event_json->>'sender' AS sender, o.event_json->>'type' AS event_type,
      o.created_at, o.plaintext, o.payload, NULL::bigint AS deleted_at, o.status::text AS outbox_status, 1 AS source_priority
    FROM outbox o
    WHERE o.event_json->>'type' IN ('message.text','message.file','message.contact')
    ORDER BY o.room_id, o.created_at DESC, o.event_id DESC
  ), candidates AS (SELECT * FROM latest_messages UNION ALL SELECT * FROM latest_outbox)
  SELECT DISTINCT ON (room_id) room_id, message_id, sender, event_type, created_at, plaintext, payload, deleted_at, outbox_status
  FROM candidates ORDER BY room_id, source_priority DESC, created_at DESC, message_id DESC`;

export const APPLY_ROOM_PROFILE_SQL = `INSERT INTO room_profiles (room_id,event_id,event_seq,name,avatar,updated_by,updated_at)
  VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
  ON CONFLICT (room_id) DO UPDATE SET event_id = EXCLUDED.event_id, event_seq = EXCLUDED.event_seq,
    name = EXCLUDED.name, avatar = EXCLUDED.avatar, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
  WHERE room_profiles.event_seq < EXCLUDED.event_seq`;

function isStoredRoomEvent(value: unknown, roomId: RoomId, seq: number, eventId: string): value is RoomEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<RoomEvent>;
  return event.event_id === eventId && event.room_id === roomId && event.seq === seq
    && typeof event.sender === "string" && typeof event.device_id === "string"
    && typeof event.type === "string" && Number.isSafeInteger(event.created_at)
    && typeof event.ciphertext === "string" && typeof event.signature === "string"
    && Boolean(event.metadata) && typeof event.metadata === "object" && !Array.isArray(event.metadata);
}

export function assembleSignedEventRange(rows: LocalEventEnvelopeRow[], roomId: RoomId, startSeq: number, endSeq: number): LocalSignedEventRange {
  const events: RoomEvent[] = [];
  let expected = startSeq;
  for (const row of rows) {
    const seq = Number(row.seq);
    if (seq !== expected) return { events, complete: false, missing_seq: expected };
    let event: unknown;
    try { event = jsonValue(row.event_json); } catch { return { events, complete: false, missing_seq: expected }; }
    if (!isStoredRoomEvent(event, roomId, seq, row.event_id)) return { events, complete: false, missing_seq: expected };
    events.push(event);
    expected += 1;
  }
  return expected === endSeq + 1
    ? { events, complete: true, missing_seq: null }
    : { events, complete: false, missing_seq: expected };
}

export function assembleMessageWindow(beforeDescending: LocalMessage[], afterAscending: LocalMessage[], before: number, after: number): LocalMessageWindow {
  const olderAndTarget = beforeDescending.slice(0, before + 1);
  const newer = afterAscending.slice(0, after);
  return {
    messages: [...olderAndTarget].reverse().concat(newer),
    hasOlder: beforeDescending.length > before + 1,
    hasNewer: afterAscending.length > after,
  };
}

export type LocalReactionSummary = { message_id: string; reaction: string; count: number; reacted_by_me: boolean };
export type LocalReadReceipt = { room_id: RoomId; user_id: string; last_read_seq: number; read_at: number };
export type LocalDeliveryReceipt = { room_id: RoomId; user_id: string; last_delivered_seq: number; delivered_at: number };
export type RoomUnreadCount = { room_id: RoomId; unread_count: number; last_read_seq: number };
export type LocalRoomPreference = { room_id: RoomId; pinned_at: number | null; archived_at: number | null; muted_until: number | null; local_retention_days: LocalRetentionDays | null; manually_unread: boolean; updated_at: number };
export type LocalRoomListActivity = {
  room_id: RoomId; message_id: string; sender: string; event_type: string; created_at: number; plaintext: string | null;
  payload: Record<string, unknown>; deleted_at: number | null; outbox_status: OutboxStatus | null;
};
export type LocalMessageExpiryPolicy = { room_id: RoomId; event_id: string; effective_after_seq: number; expires_in_seconds: MessageExpirySeconds | null; updated_by: string; updated_at: number };
export type LocalRoomProfile = { room_id: RoomId; event_id: string; event_seq: number; name: string; avatar: RoomProfileAvatar | null; updated_by: string; updated_at: number };
export type LocalComposerDraft = { room_id: RoomId; text_content: string; mode: "message" | "reply" | "quote" | "edit"; target_message_id: string | null; quote_text: string | null; updated_at: number };
export type LocalComposerDraftOutbox = { room_id: RoomId; draft: LocalComposerDraft | null; client_updated_at: number; attempts: number; next_attempt_at: number | null; last_error: string | null };
export type LocalDeviceVerification = { user_id: string; device_id: string; fingerprint: string; verified_at: number };

export type SearchResult = Pick<LocalMessage, "event_id" | "message_id" | "room_id" | "seq" | "sender" | "created_at" | "plaintext"> & { kind: "text" };
export type ImageSearchResult = Pick<LocalMessage, "message_id" | "room_id" | "seq" | "sender" | "created_at"> & {
  kind: "image"; attachment_id: string; name: string; score: number;
};
type ImageEmbeddingRow = Omit<ImageSearchResult, "kind" | "score"> & { embedding: Uint8Array; dimensions: number };
export type CompactionJobStatus = "leased" | "key_wrapped" | "building" | "uploading" | "uploaded" | "complete" | "failed";
export type PendingArchiveRetentionAck = { room_id: RoomId; segment_id: string };
export type LocalArchiveSegmentMetadata = {
  segment_id: string; room_id: RoomId; start_seq: number; end_seq: number; byte_size: number;
  header_bytes: Uint8Array<ArrayBuffer>; envelope_index_bytes: Uint8Array<ArrayBuffer>;
};
export type OutboxStatus = "pending" | "sending" | "failed";
export type OutboxItem = {
  event_id: string; message_id: string; room_id: RoomId; event: ClientEvent;
  plaintext: string; payload: Record<string, unknown>; status: OutboxStatus;
  attempts: number; next_attempt_at: number | null; last_error: string | null;
  created_at: number; updated_at: number;
};
type OutboxRow = Omit<OutboxItem, "event" | "payload"> & { event_json: ClientEvent | string; payload: Record<string, unknown> | string };
export type DeviceRevocationOutboxItem = {
  revocation_id: string;
  room_id: RoomId;
  target_device_id: string;
  event: ClientEvent;
  previous_mls_state: Uint8Array | null;
  mls_state: Uint8Array;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};
type DeviceRevocationOutboxRow = Omit<DeviceRevocationOutboxItem, "event"> & { event_json: ClientEvent | string };
export type DeviceLinkOutboxItem = {
  link_id: string;
  room_id: RoomId;
  target_device_id: string;
  event: ClientEvent;
  encrypted_state: string;
  previous_mls_state: Uint8Array;
  mls_state: Uint8Array;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};
type DeviceLinkOutboxRow = Omit<DeviceLinkOutboxItem, "event"> & { event_json: ClientEvent | string };
export type AccountRemovalOutboxItem = {
  deletion_id: string;
  room_id: RoomId;
  target_user_id: string;
  target_device_ids: string[];
  event: ClientEvent;
  previous_mls_state: Uint8Array | null;
  mls_state: Uint8Array;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};
type AccountRemovalOutboxRow = Omit<AccountRemovalOutboxItem, "event" | "target_device_ids"> & { event_json: ClientEvent | string; target_device_ids: string[] | string };
export type RoomMembershipOutboxItem = {
  room_id: RoomId;
  operation: "add" | "remove";
  target_user_id: string;
  target_device_ids: string[];
  event: ClientEvent;
  mls_welcome: string | null;
  mls_ratchet_tree: string | null;
  mls_claim_ids: string[];
  previous_mls_state: Uint8Array;
  mls_state: Uint8Array;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};
type RoomMembershipOutboxRow = Omit<RoomMembershipOutboxItem, "event" | "target_device_ids" | "mls_claim_ids"> & {
  event_json: ClientEvent | string;
  target_device_ids: string[] | string;
  mls_claim_ids: string[] | string;
};

function jsonValue<T>(value: T | string): T { return typeof value === "string" ? JSON.parse(value) as T : value; }

export function projectEditedPayload(payload: Record<string, unknown>, messageId: string, text: string): { payload: Record<string, unknown>; textPart: Record<string, unknown> | null } {
  const parts = Array.isArray(payload.parts) ? payload.parts.filter((part): part is Record<string, unknown> => Boolean(part && typeof part === "object")) : [];
  const firstText = parts.find((part) => part.kind === "text" && typeof part.part_id === "string");
  const nonText = parts.filter((part) => part.kind !== "text");
  const textPart = text ? { part_id: typeof firstText?.part_id === "string" ? firstText.part_id : `${messageId}:edited-text`, kind: "text", text } : null;
  return { payload: { ...payload, parts: [...(textPart ? [textPart] : []), ...nonText] }, textPart };
}

export class LocalRestoreCommitUnknownError extends Error {
  constructor(cause: unknown) {
    super("本机恢复提交状态无法确认；请重新打开后使用同一备份继续恢复", { cause });
    this.name = "LocalRestoreCommitUnknownError";
  }
}

export class LocalDatabase {
  private readonly worker = new Worker(new URL("./db-worker.ts", import.meta.url), { type: "module", name: "edgechat-pglite" });
  private readonly pending = new Map<number, Pending>();
  private requestId = 0;
  private closing: Promise<void> | null = null;
  private workerFailure: Error | null = null;
  storage: "opfs" | "indexeddb" | "initializing" = "initializing";

  constructor(private readonly profileId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(profileId)) throw new Error("Invalid local profile identifier");
    this.worker.onmessage = (event: MessageEvent<DbResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) pending.reject(new LocalDatabaseResponseError(response.error));
      else {
        if (response.storage) this.storage = response.storage;
        pending.resolve(response);
      }
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.failWorker(new Error(event.message || "Local database worker failed"));
    };
    this.worker.onmessageerror = () => this.failWorker(new Error("Local database worker response could not be decoded"));
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const response = await this.send(sql, params, false);
    return response.rows as T[];
  }

  async exec(sql: string): Promise<void> { await this.send(sql, [], true); }

  async clearAccountData(): Promise<void> {
    await this.exec(LOCAL_CLEAR_ACCOUNT_DATA);
  }

  async bindAccount(userId: string, displayName: string): Promise<void> {
    await this.query(
      `INSERT INTO account_state (id, user_id, display_name, updated_at) VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at`,
      [userId, displayName, Date.now()],
    );
  }

  async cacheSession<T extends object>(session: T): Promise<void> {
    await this.query(
      `INSERT INTO cached_session (id, session_json, updated_at) VALUES (1, $1::jsonb, $2)
       ON CONFLICT (id) DO UPDATE SET session_json = EXCLUDED.session_json, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(session), Date.now()],
    );
  }

  async cachedSession<T extends object>(): Promise<T | null> {
    const [row] = await this.query<{ session_json: T | string }>("SELECT session_json FROM cached_session WHERE id = 1");
    return row ? jsonValue(row.session_json) : null;
  }

  async deviceVerifications(userIds?: readonly string[]): Promise<LocalDeviceVerification[]> {
    if (!userIds) return this.query<LocalDeviceVerification>("SELECT user_id, device_id, fingerprint, verified_at FROM device_verifications ORDER BY user_id, verified_at DESC");
    const unique = [...new Set(userIds)];
    if (!unique.length) return [];
    if (unique.length > 1_000 || unique.some((userId) => !isNamespacedUserId(userId))) throw new Error("Invalid verification user list");
    const placeholders = unique.map((_, index) => `$${index + 1}`).join(",");
    return this.query<LocalDeviceVerification>(`SELECT user_id, device_id, fingerprint, verified_at FROM device_verifications WHERE user_id IN (${placeholders}) ORDER BY user_id, verified_at DESC`, unique);
  }

  async verifyDevice(userId: string, deviceId: string, fingerprint: string, verifiedAt = Date.now()): Promise<void> {
    if (!isNamespacedUserId(userId) || !deviceId || deviceId.length > 96 || !/^(?:[0-9A-F]{4} ){7}[0-9A-F]{4}$/.test(fingerprint) || !Number.isSafeInteger(verifiedAt) || verifiedAt < 0) {
      throw new Error("Invalid device verification");
    }
    await this.query(
      `INSERT INTO device_verifications (user_id, device_id, fingerprint, verified_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, device_id) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, verified_at = EXCLUDED.verified_at`,
      [userId, deviceId, fingerprint, verifiedAt],
    );
  }

  async removeDeviceVerification(userId: string, deviceId: string): Promise<void> {
    await this.query("DELETE FROM device_verifications WHERE user_id = $1 AND device_id = $2", [userId, deviceId]);
  }

  async roomDeviceSigningKey(roomId: RoomId, deviceId: string): Promise<LocalRoomDeviceSigningKey | null> {
    if (!isNamespacedRoomId(roomId) || !deviceId || deviceId.length > 96) throw new Error("Invalid room device signing-key lookup");
    const [row] = await this.query<{ room_id: RoomId; device_id: string; user_id: UserId; signing_key: JsonWebKey | string }>(
      "SELECT room_id,device_id,user_id,signing_key FROM room_device_signing_keys WHERE room_id = $1 AND device_id = $2", [roomId, deviceId],
    );
    if (!row) return null;
    return { ...row, signing_key: canonicalSigningKey(jsonValue(row.signing_key)) };
  }

  async saveRoomDeviceSigningKeys(roomId: RoomId, keys: readonly Omit<LocalRoomDeviceSigningKey, "room_id">[], seenAt = Date.now()): Promise<void> {
    if (!isNamespacedRoomId(roomId) || keys.length > 1_000 || !Number.isSafeInteger(seenAt) || seenAt < 0) throw new Error("Invalid room device signing-key directory");
    const unique = new Set<string>();
    for (const item of keys) {
      if (!item.device_id || item.device_id.length > 96 || !isNamespacedUserId(item.user_id) || unique.has(item.device_id)) throw new Error("Invalid room device signing-key directory");
      unique.add(item.device_id);
      const signingKey = canonicalSigningKey(item.signing_key);
      const rows = await this.query<{ device_id: string }>(
        PIN_ROOM_DEVICE_SIGNING_KEY_SQL,
        [roomId, item.device_id, item.user_id, JSON.stringify(signingKey), seenAt],
      );
      if (!rows.length) throw new Error("Room device signing key changed after first use");
    }
  }

  async backupSnapshot(): Promise<Blob> {
    const response = await this.request({ kind: "dump" });
    if (!response.blob?.size) throw new Error("Local database snapshot is empty");
    return response.blob;
  }

  async stageRestoreSnapshot(snapshot: Blob, expectedUserId: string): Promise<string> {
    return this.stageSnapshot("restore", snapshot, expectedUserId);
  }

  async stageLinkedDeviceHistory(snapshot: Blob, expectedUserId: string): Promise<string> {
    return this.stageSnapshot("restore-device-history", snapshot, expectedUserId);
  }

  async restoreCommitted(restoreId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(restoreId)) throw new Error("Invalid local restore identifier");
    const response = await this.request({ kind: "verify-restore", restoreId });
    return response.restored === true;
  }

  async getCursor(): Promise<number> {
    const [row] = await this.query<{ cursor: string | number }>("SELECT cursor FROM sync_state WHERE id = 1");
    return Number(row?.cursor ?? 0);
  }

  async setCursor(cursor: number): Promise<void> {
    await this.query("UPDATE sync_state SET cursor = $1, updated_at = $2 WHERE id = 1", [cursor, Date.now()]);
  }

  async saveRoom<T extends { room_id: RoomId; name: string | null; kind: string; current_seq: number; joined_seq: number }>(room: T): Promise<void> {
    await this.query(
      `INSERT INTO rooms (room_id, name, kind, current_seq, updated_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (room_id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, current_seq = GREATEST(rooms.current_seq, EXCLUDED.current_seq), updated_at = EXCLUDED.updated_at`,
      [room.room_id, room.name, room.kind, room.current_seq, Date.now()],
    );
    await this.query(
      `INSERT INTO room_snapshots (room_id, snapshot, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (room_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = EXCLUDED.updated_at`,
      [room.room_id, JSON.stringify(room), Date.now()],
    );
    await this.prepareRoomSequence(room.room_id, room.joined_seq);
  }

  async prepareRoomSequence(roomId: RoomId, baselineSeq: number): Promise<void> {
    if (!Number.isSafeInteger(baselineSeq) || baselineSeq < 0) throw new Error("Invalid room sequence baseline");
    await this.query(
      `INSERT INTO room_sync_state (room_id, baseline_seq, processed_through_seq, updated_at) VALUES ($1,$2,$2,$3)
       ON CONFLICT (room_id) DO UPDATE SET
         baseline_seq = GREATEST(room_sync_state.baseline_seq, EXCLUDED.baseline_seq),
         processed_through_seq = GREATEST(room_sync_state.processed_through_seq, EXCLUDED.baseline_seq),
         updated_at = EXCLUDED.updated_at`,
      [roomId, baselineSeq, Date.now()],
    );
    await this.advanceRoomSequence(roomId);
  }

  async roomSequenceState(roomId: RoomId): Promise<LocalRoomSyncState | null> {
    const [row] = await this.query<{ room_id: RoomId; baseline_seq: string | number; processed_through_seq: string | number }>(
      "SELECT room_id, baseline_seq, processed_through_seq FROM room_sync_state WHERE room_id = $1", [roomId],
    );
    return row ? { room_id: row.room_id, baseline_seq: Number(row.baseline_seq), processed_through_seq: Number(row.processed_through_seq) } : null;
  }

  async advanceRoomSequence(roomId: RoomId): Promise<number | null> {
    const rows = await this.query<{ processed_through_seq: string | number }>(ADVANCE_ROOM_SEQUENCE_SQL, [roomId, Date.now()]);
    return rows[0] ? Number(rows[0].processed_through_seq) : null;
  }

  async deferRoomEvent(event: RoomEvent): Promise<void> {
    if (!isStoredRoomEvent(event, event.room_id, event.seq, event.event_id)) throw new Error("Invalid deferred room event");
    const encoded = JSON.stringify(event);
    await this.query(
      `INSERT INTO deferred_room_events (event_id, room_id, seq, event_json, deferred_at)
       VALUES ($1,$2,$3,$4::jsonb,$5)
       ON CONFLICT DO NOTHING`,
      [event.event_id, event.room_id, event.seq, encoded, Date.now()],
    );
    const [stored] = await this.query<{ event_id: string; same_event: boolean }>(
      "SELECT event_id, event_json = $3::jsonb AS same_event FROM deferred_room_events WHERE room_id = $1 AND seq = $2",
      [event.room_id, event.seq, encoded],
    );
    if (!stored || stored.event_id !== event.event_id || !stored.same_event) throw new Error("Deferred room sequence conflicts with another event");
  }

  async deferredRoomIds(): Promise<RoomId[]> {
    const rows = await this.query<{ room_id: RoomId }>("SELECT DISTINCT room_id FROM deferred_room_events ORDER BY room_id");
    return rows.map((row) => row.room_id);
  }

  async deferredRoomEvents(roomId: RoomId, limit = 500): Promise<RoomEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Deferred event limit must be between 1 and 500");
    const rows = await this.query<LocalDeferredEventRow>(
      "SELECT event_id, room_id, seq, event_json FROM deferred_room_events WHERE room_id = $1 ORDER BY seq LIMIT $2",
      [roomId, limit],
    );
    return rows.map((row) => {
      const seq = Number(row.seq);
      const event = jsonValue(row.event_json);
      if (!isStoredRoomEvent(event, roomId, seq, row.event_id)) throw new Error("Stored deferred room event is invalid");
      return event;
    });
  }

  async removeDeferredRoomEvent(eventId: string): Promise<void> {
    await this.query("DELETE FROM deferred_room_events WHERE event_id = $1", [eventId]);
  }

  async stageDecryptedEvent(
    event: RoomEvent,
    plaintext: Uint8Array<ArrayBuffer>,
    senderDeviceId: string,
    previousMlsState: Uint8Array<ArrayBuffer>,
    nextMlsState: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    if (!senderDeviceId || senderDeviceId.length > 512) throw new Error("Invalid authenticated MLS sender identity");
    await this.query(
      `INSERT INTO decrypted_event_staging (event_id, room_id, seq, event_json, plaintext, sender_device_id, previous_mls_state, next_mls_state, staged_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)`,
      [event.event_id, event.room_id, event.seq, JSON.stringify(event), plaintext, senderDeviceId, previousMlsState, nextMlsState, Date.now()],
    );
  }

  async stagedDecryptedEvent(eventId: string): Promise<LocalStagedDecryptedEvent | null> {
    const [row] = await this.query<{ event_id: string; room_id: RoomId; seq: number | string; event_json: RoomEvent | string; plaintext: Uint8Array<ArrayBuffer>; sender_device_id: string; previous_mls_state: Uint8Array<ArrayBuffer>; next_mls_state: Uint8Array<ArrayBuffer> }>(
      "SELECT event_id, room_id, seq, event_json, plaintext, sender_device_id, previous_mls_state, next_mls_state FROM decrypted_event_staging WHERE event_id = $1",
      [eventId],
    );
    if (!row) return null;
    const seq = Number(row.seq); const event = jsonValue(row.event_json);
    if (!isStoredRoomEvent(event, row.room_id, seq, row.event_id)) throw new Error("Stored decrypted event staging record is invalid");
    if (!row.sender_device_id || row.sender_device_id.length > 512) throw new Error("Stored decrypted event sender identity is invalid");
    return { event, plaintext: row.plaintext, sender_device_id: row.sender_device_id, previous_mls_state: row.previous_mls_state, next_mls_state: row.next_mls_state };
  }

  async stagedDecryptedEvents(limit = 500): Promise<RoomEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Staged decrypted event limit must be between 1 and 500");
    const rows = await this.query<LocalDeferredEventRow>(
      "SELECT event_id, room_id, seq, event_json FROM decrypted_event_staging ORDER BY staged_at, room_id, seq LIMIT $1",
      [limit],
    );
    return rows.map((row) => {
      const seq = Number(row.seq); const event = jsonValue(row.event_json);
      if (!isStoredRoomEvent(event, row.room_id, seq, row.event_id)) throw new Error("Stored decrypted event staging record is invalid");
      return event;
    });
  }

  async removeStagedDecryptedEvent(eventId: string): Promise<void> {
    await this.query("DELETE FROM decrypted_event_staging WHERE event_id = $1", [eventId]);
  }

  async stageOutgoingEvent(
    event: ClientEvent,
    plaintext: string,
    payload: Record<string, unknown>,
    previousMlsState: Uint8Array<ArrayBuffer>,
    nextMlsState: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const rows = await this.query<{ event_id: string }>(
      `INSERT INTO outgoing_event_staging (event_id,room_id,event_json,plaintext,payload,previous_mls_state,next_mls_state,staged_at)
       VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,$6,$7,$8)
       ON CONFLICT (event_id) DO UPDATE SET event_id = EXCLUDED.event_id
       WHERE outgoing_event_staging.room_id = EXCLUDED.room_id
         AND outgoing_event_staging.event_json = EXCLUDED.event_json
         AND outgoing_event_staging.plaintext = EXCLUDED.plaintext
         AND outgoing_event_staging.payload = EXCLUDED.payload
         AND outgoing_event_staging.previous_mls_state = EXCLUDED.previous_mls_state
         AND outgoing_event_staging.next_mls_state = EXCLUDED.next_mls_state
       RETURNING event_id`,
      [event.event_id, event.room_id, JSON.stringify(event), plaintext, JSON.stringify(payload), previousMlsState, nextMlsState, Date.now()],
    );
    if (!rows.length) throw new Error("Outgoing event ID conflicts with different staged ciphertext or MLS state");
  }

  async stagedOutgoingEvents(limit = 500): Promise<LocalStagedOutgoingEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Outgoing staging limit must be between 1 and 500");
    const rows = await this.query<{ event_id: string; room_id: RoomId; event_json: ClientEvent | string; plaintext: string; payload: Record<string, unknown> | string; previous_mls_state: Uint8Array<ArrayBuffer>; next_mls_state: Uint8Array<ArrayBuffer> }>(
      "SELECT event_id,room_id,event_json,plaintext,payload,previous_mls_state,next_mls_state FROM outgoing_event_staging ORDER BY staged_at,event_id LIMIT $1",
      [limit],
    );
    return rows.map((row) => {
      const event: unknown = jsonValue(row.event_json);
      if (!isClientEventEnvelope(event) || event.event_id !== row.event_id || event.room_id !== row.room_id) {
        throw new Error("Stored outgoing event staging record is invalid");
      }
      return { event, plaintext: row.plaintext, payload: jsonValue(row.payload), previous_mls_state: row.previous_mls_state, next_mls_state: row.next_mls_state };
    });
  }

  async promoteStagedOutgoingEvent(eventId: string): Promise<void> {
    const rows = await this.query<{ event_id: string }>(PROMOTE_STAGED_OUTGOING_EVENT_SQL, [eventId]);
    if (!rows.length) throw new Error("Outgoing staging is missing or conflicts with a different outbox event");
  }

  async hasExactOutbox(event: ClientEvent, plaintext: string, payload: Record<string, unknown>): Promise<boolean> {
    const rows = await this.query<{ event_id: string }>(
      "SELECT event_id FROM outbox WHERE event_id = $1 AND room_id = $2 AND event_json = $3::jsonb AND plaintext = $4 AND payload = $5::jsonb",
      [event.event_id, event.room_id, JSON.stringify(event), plaintext, JSON.stringify(payload)],
    );
    return rows.length === 1;
  }

  async cachedRooms<T extends object>(): Promise<T[]> {
    const rows = await this.query<{ snapshot: T | string }>("SELECT snapshot FROM room_snapshots ORDER BY updated_at DESC, room_id");
    return rows.map((row) => jsonValue(row.snapshot));
  }

  async setHiddenRoomMembers(roomId: RoomId, userIds: readonly string[]): Promise<void> {
    const unique = Array.from(new Set(userIds));
    if (unique.some((userId) => typeof userId !== "string" || !userId.length)) throw new Error("Invalid hidden group member");
    await this.query(SET_HIDDEN_ROOM_MEMBERS_SQL, [roomId, JSON.stringify(unique), Date.now()]);
  }

  async saveDecryptedEvent(event: RoomEvent, plaintext: string, payload: Record<string, unknown>): Promise<void> {
    await this.markProcessed(event);
    if (event.seq <= await this.localHistoryFloor(event.room_id)) return;
    const messageId = typeof payload.message_id === "string" && payload.message_id ? payload.message_id : event.event_id;
    const [expired] = await this.query<{ present: boolean }>("SELECT EXISTS(SELECT 1 FROM expired_messages WHERE message_id = $1) AS present", [messageId]);
    if (expired?.present) return;
    const [policy] = await this.query<{ expires_in_seconds: MessageExpirySeconds | null }>(
      "SELECT expires_in_seconds FROM room_message_expiry WHERE room_id = $1 AND effective_after_seq < $2",
      [event.room_id, event.seq],
    );
    const expiresAt = policy?.expires_in_seconds ? messageExpiryAt(event, policy.expires_in_seconds) : null;
    if (expiresAt !== null && expiresAt <= Date.now()) {
      await this.query(
        `INSERT INTO expired_messages (message_id, room_id, expired_at) VALUES ($1,$2,$3)
         ON CONFLICT (message_id) DO UPDATE SET expired_at = LEAST(expired_messages.expired_at, EXCLUDED.expired_at)`,
        [messageId, event.room_id, expiresAt],
      );
      return;
    }
    await this.query(
      `INSERT INTO messages (event_id, message_id, room_id, seq, sender, device_id, event_type, created_at, ciphertext, plaintext, payload, search_vector, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,to_tsvector('simple', COALESCE($10, '')),$12)
       ON CONFLICT (event_id) DO UPDATE SET message_id = EXCLUDED.message_id, plaintext = EXCLUDED.plaintext, payload = EXCLUDED.payload, search_vector = EXCLUDED.search_vector, expires_at = EXCLUDED.expires_at`,
      [event.event_id, messageId, event.room_id, event.seq, event.sender, event.device_id, event.type, event.created_at, event.ciphertext, plaintext, JSON.stringify(payload), expiresAt],
    );
    const parts = Array.isArray(payload.parts) ? payload.parts : [];
    for (const [position, value] of parts.entries()) {
      if (!value || typeof value !== "object") continue;
      const part = value as Record<string, unknown>;
      const partId = typeof part.part_id === "string" && part.part_id ? part.part_id : `${messageId}:${position}`;
      const kind = typeof part.kind === "string" ? part.kind : "unknown";
      const textContent = kind === "text" && typeof part.text === "string" ? part.text : null;
      const attachment = part.attachment && typeof part.attachment === "object" ? part.attachment as Record<string, unknown> : null;
      const attachmentId = attachment && typeof attachment.id === "string" ? attachment.id : null;
      await this.query(
        `INSERT INTO message_parts (part_id, message_id, position, kind, text_content, attachment_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT (part_id) DO UPDATE SET position = EXCLUDED.position, kind = EXCLUDED.kind, text_content = EXCLUDED.text_content, attachment_id = EXCLUDED.attachment_id, metadata = EXCLUDED.metadata`,
        [partId, messageId, position, kind, textContent, attachmentId, JSON.stringify(part)],
      );
      if (attachmentId && attachment) {
        await this.query(
          `INSERT INTO attachments (attachment_id, room_id, event_id, message_id, part_id, mime_type, plaintext_bytes, width, height, local_status, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'remote',$10::jsonb)
           ON CONFLICT (attachment_id) DO UPDATE SET message_id = EXCLUDED.message_id, part_id = EXCLUDED.part_id, metadata = EXCLUDED.metadata`,
          [attachmentId, event.room_id, event.event_id, messageId, partId, typeof attachment.type === "string" ? attachment.type : null, typeof attachment.size === "number" ? attachment.size : null, typeof attachment.width === "number" ? attachment.width : null, typeof attachment.height === "number" ? attachment.height : null, JSON.stringify(attachment)],
        );
      }
    }
    const [tombstone] = await this.query<{ delete_event_id: string; delete_seq: number; deleted_by: string; deleted_at: number }>(
      "SELECT delete_event_id, delete_seq, deleted_by, deleted_at FROM message_tombstones WHERE target_message_id = $1",
      [messageId],
    );
    if (tombstone?.deleted_by === event.sender) await this.redactMessage(messageId, tombstone);
    else await this.projectLatestEdit(messageId);
    await this.query(
      `INSERT INTO segment_state (room_id, indexed_until_seq, oldest_local_seq, newest_local_seq, history_complete)
       VALUES ($1,$2,$2,$2,FALSE)
       ON CONFLICT (room_id) DO UPDATE SET indexed_until_seq = LEAST(segment_state.indexed_until_seq, EXCLUDED.indexed_until_seq), oldest_local_seq = LEAST(segment_state.oldest_local_seq, EXCLUDED.oldest_local_seq), newest_local_seq = GREATEST(segment_state.newest_local_seq, EXCLUDED.newest_local_seq)`,
      [event.room_id, event.seq],
    );
  }

  async messages(roomId: RoomId, limit = 200): Promise<LocalMessage[]> {
    return this.query<LocalMessage>("SELECT event_id, message_id, room_id, seq, sender, device_id, event_type, created_at, ciphertext, plaintext, payload, deleted_at, deleted_by, delete_event_id, edited_at, edit_event_id, expires_at FROM messages m WHERE room_id = $1 AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender) ORDER BY seq DESC LIMIT $2", [roomId, limit]);
  }

  async roomListActivities(): Promise<LocalRoomListActivity[]> {
    const rows = await this.query<Omit<LocalRoomListActivity, "payload"> & { payload: Record<string, unknown> | string }>(ROOM_LIST_ACTIVITIES_SQL);
    return rows.map((row) => ({ ...row, created_at: Number(row.created_at), deleted_at: row.deleted_at === null ? null : Number(row.deleted_at), payload: jsonValue(row.payload) }));
  }

  async message(roomId: RoomId, messageId: string): Promise<LocalMessage | null> {
    const [row] = await this.query<LocalMessage>(
      "SELECT event_id, message_id, room_id, seq, sender, device_id, event_type, created_at, ciphertext, plaintext, payload, deleted_at, deleted_by, delete_event_id, edited_at, edit_event_id, expires_at FROM messages WHERE room_id = $1 AND message_id = $2",
      [roomId, messageId],
    );
    return row ?? null;
  }

  async messagesBefore(roomId: RoomId, beforeSeq: number, limit = 100): Promise<LocalMessage[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1) return [];
    return this.query<LocalMessage>(
      "SELECT event_id, message_id, room_id, seq, sender, device_id, event_type, created_at, ciphertext, plaintext, payload, deleted_at, deleted_by, delete_event_id, edited_at, edit_event_id, expires_at FROM messages m WHERE room_id = $1 AND seq < $2 AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender) ORDER BY seq DESC LIMIT $3",
      [roomId, beforeSeq, safeLimit],
    );
  }

  async messagesAfter(roomId: RoomId, afterSeq: number, limit = 200): Promise<LocalMessage[]> {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) return [];
    return this.query<LocalMessage>(MESSAGES_AFTER_SQL, [roomId, afterSeq, safeLimit]);
  }

  async localHistoryFloor(roomId: RoomId): Promise<number> {
    const [row] = await this.query<{ cleared_through_seq: number | string }>("SELECT cleared_through_seq FROM room_local_history_floor WHERE room_id = $1", [roomId]);
    return Number(row?.cleared_through_seq ?? 0);
  }

  async clearRoomHistory(roomId: RoomId, throughSeq: number, now = Date.now()): Promise<LocalHistoryClearResult> {
    const response = await this.request({ kind: "clear-room-history", roomId, throughSeq, now });
    const result = response.rows?.[0] as LocalHistoryClearResult | undefined;
    if (!result || !Array.isArray(result.attachment_ids) || !Array.isArray(result.segment_ids)) throw new Error("Local history clear result is invalid");
    return { ...result, deleted: Number(result.deleted), cleared_through_seq: Number(result.cleared_through_seq) };
  }

  async roomAttachments(roomId: RoomId, cursor: LocalRoomAttachmentCursor | null = null, limit = 48): Promise<LocalRoomAttachmentPage> {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await this.query<LocalRoomAttachmentRow>(
      cursor ? ROOM_ATTACHMENTS_BEFORE_SQL : ROOM_ATTACHMENTS_FIRST_PAGE_SQL,
      cursor ? [roomId, cursor.seq, cursor.position, safeLimit + 1] : [roomId, safeLimit + 1],
    );
    const items = rows.slice(0, safeLimit).flatMap((row): LocalRoomAttachment[] => {
      if (row.kind !== "attachment") return [];
      let metadata: unknown;
      try { metadata = jsonValue(row.metadata); } catch { return []; }
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
      return [{ ...row, kind: row.kind, metadata: metadata as Record<string, unknown> }];
    });
    const lastRow = rows[Math.min(rows.length, safeLimit) - 1];
    return {
      items,
      next_cursor: rows.length > safeLimit && lastRow ? { seq: Number(lastRow.seq), position: Number(lastRow.position) } : null,
    };
  }

  async messageWindow(roomId: RoomId, targetSeq: number, before = 80, after = 120): Promise<LocalMessageWindow> {
    if (!Number.isSafeInteger(targetSeq) || targetSeq < 1) return { messages: [], hasOlder: false, hasNewer: false };
    const safeBefore = Math.max(0, Math.min(200, Math.floor(before)));
    const safeAfter = Math.max(0, Math.min(200, Math.floor(after)));
    const columns = "event_id, message_id, room_id, seq, sender, device_id, event_type, created_at, ciphertext, plaintext, payload, deleted_at, deleted_by, delete_event_id, edited_at, edit_event_id, expires_at";
    const [beforeRows, afterRows] = await Promise.all([
      this.query<LocalMessage>(`SELECT ${columns} FROM messages m WHERE room_id = $1 AND seq <= $2 AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender) ORDER BY seq DESC LIMIT $3`, [roomId, targetSeq, safeBefore + 2]),
      this.query<LocalMessage>(`SELECT ${columns} FROM messages m WHERE room_id = $1 AND seq > $2 AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender) ORDER BY seq ASC LIMIT $3`, [roomId, targetSeq, safeAfter + 1]),
    ]);
    return assembleMessageWindow(beforeRows, afterRows, safeBefore, safeAfter);
  }

  async hasMessagesBefore(roomId: RoomId, beforeSeq: number): Promise<boolean> {
    if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1) return false;
    const [row] = await this.query<{ present: boolean }>("SELECT EXISTS(SELECT 1 FROM messages m WHERE room_id = $1 AND seq < $2 AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender)) AS present", [roomId, beforeSeq]);
    return Boolean(row?.present);
  }

  async applyMessageEdit(event: RoomEvent, payload: MessageEditPayload): Promise<void> {
    await this.markProcessed(event);
    if (event.seq <= await this.localHistoryFloor(event.room_id)) return;
    if ((await this.query<{ present: boolean }>("SELECT EXISTS(SELECT 1 FROM expired_messages WHERE message_id = $1) AS present", [payload.target.message_id]))[0]?.present) return;
    await this.query(
      `INSERT INTO message_edits (edit_event_id, target_message_id, room_id, edit_seq, sender, text_content, edited_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (edit_event_id) DO NOTHING`,
      [event.event_id, payload.target.message_id, event.room_id, event.seq, event.sender, payload.text, payload.edited_at],
    );
    await this.projectLatestEdit(payload.target.message_id);
  }

  async applyMessageReaction(event: RoomEvent, payload: MessageReactionPayload): Promise<void> {
    await this.markProcessed(event);
    if (event.seq <= await this.localHistoryFloor(event.room_id)) return;
    if ((await this.query<{ present: boolean }>("SELECT EXISTS(SELECT 1 FROM expired_messages WHERE message_id = $1) AS present", [payload.target.message_id]))[0]?.present) return;
    await this.query(
      `INSERT INTO message_reactions (reaction_event_id, target_message_id, room_id, reaction_seq, sender, reaction, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (reaction_event_id) DO NOTHING`,
      [event.event_id, payload.target.message_id, event.room_id, event.seq, event.sender, payload.reaction, payload.updated_at],
    );
  }

  async applyMessageExpiryPolicy(event: RoomEvent, payload: MessageExpiryPolicyPayload): Promise<void> {
    if (!isMessageExpiryPolicyPayload(payload)) throw new Error("Invalid message expiry policy");
    await this.markProcessed(event);
    await this.query(
      `INSERT INTO room_message_expiry (room_id,event_id,effective_after_seq,expires_in_seconds,updated_by,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (room_id) DO UPDATE SET event_id = EXCLUDED.event_id, effective_after_seq = EXCLUDED.effective_after_seq,
         expires_in_seconds = EXCLUDED.expires_in_seconds, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
       WHERE room_message_expiry.effective_after_seq < EXCLUDED.effective_after_seq`,
      [event.room_id, event.event_id, event.seq, payload.expires_in_seconds, event.sender, payload.updated_at],
    );
  }

  async roomMessageExpiry(roomId: RoomId): Promise<LocalMessageExpiryPolicy | null> {
    const [row] = await this.query<LocalMessageExpiryPolicy>(
      "SELECT room_id,event_id,effective_after_seq,expires_in_seconds,updated_by,updated_at FROM room_message_expiry WHERE room_id = $1",
      [roomId],
    );
    return row ?? null;
  }

  async roomMessageExpiryPolicies(): Promise<LocalMessageExpiryPolicy[]> {
    return this.query<LocalMessageExpiryPolicy>("SELECT room_id,event_id,effective_after_seq,expires_in_seconds,updated_by,updated_at FROM room_message_expiry");
  }

  async applyRoomProfile(event: RoomEvent, payload: RoomProfilePayload): Promise<void> {
    if (!isRoomProfilePayload(payload)) throw new Error("Invalid room profile");
    await this.markProcessed(event);
    await this.query(
      APPLY_ROOM_PROFILE_SQL,
      [event.room_id, event.event_id, event.seq, payload.name, payload.avatar === null ? null : JSON.stringify(payload.avatar), event.sender, payload.updated_at],
    );
  }

  async roomProfile(roomId: RoomId): Promise<LocalRoomProfile | null> {
    const [row] = await this.query<LocalRoomProfile>(
      "SELECT room_id,event_id,event_seq,name,avatar,updated_by,updated_at FROM room_profiles WHERE room_id = $1",
      [roomId],
    );
    return row ?? null;
  }

  async roomProfiles(): Promise<LocalRoomProfile[]> {
    return this.query<LocalRoomProfile>("SELECT room_id,event_id,event_seq,name,avatar,updated_by,updated_at FROM room_profiles");
  }

  async roomReactions(roomId: RoomId, currentUserId: string): Promise<LocalReactionSummary[]> {
    return this.query<LocalReactionSummary>(
      `SELECT target_message_id AS message_id, reaction, count(*)::int AS count, bool_or(sender = $2) AS reacted_by_me
       FROM (SELECT DISTINCT ON (target_message_id, sender) target_message_id, sender, reaction
             FROM message_reactions mr WHERE room_id = $1 AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = mr.room_id AND h.user_id = mr.sender) ORDER BY target_message_id, sender, reaction_seq DESC) latest
       WHERE reaction IS NOT NULL GROUP BY target_message_id, reaction ORDER BY target_message_id, reaction`,
      [roomId, currentUserId],
    );
  }

  async latestVisibleMessageSeq(roomId: RoomId): Promise<number> {
    const [row] = await this.query<{ seq: number | string | null }>(
      "SELECT MAX(seq) AS seq FROM messages m WHERE room_id = $1 AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender)",
      [roomId],
    );
    return Number(row?.seq ?? 0);
  }

  async latestIncomingMessageSeq(roomId: RoomId, currentUserId: string): Promise<number> {
    const [row] = await this.query<{ seq: number | string | null }>(
      "SELECT MAX(seq) AS seq FROM messages WHERE room_id = $1 AND sender <> $2",
      [roomId, currentUserId],
    );
    return Number(row?.seq ?? 0);
  }

  async latestIncomingVisibleMessageSeq(roomId: RoomId, currentUserId: string): Promise<number> {
    const [row] = await this.query<{ seq: number | string | null }>(
      `SELECT MAX(seq) AS seq FROM messages m WHERE room_id = $1 AND sender <> $2 AND deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender)`,
      [roomId, currentUserId],
    );
    return Number(row?.seq ?? 0);
  }

  async firstUnreadVisibleMessage(roomId: RoomId, currentUserId: string, afterSeq: number): Promise<{ message_id: string; seq: number } | null> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("Invalid read sequence");
    const [row] = await this.query<{ message_id: string; seq: number | string }>(
      FIRST_UNREAD_VISIBLE_MESSAGE_SQL,
      [roomId, afterSeq, currentUserId],
    );
    return row ? { message_id: row.message_id, seq: Number(row.seq) } : null;
  }

  async markRoomRead(roomId: RoomId, upToSeq: number): Promise<void> {
    if (!Number.isSafeInteger(upToSeq) || upToSeq < 0) throw new Error("Invalid read sequence");
    await this.query(
      `INSERT INTO room_read_state (room_id, last_read_seq, last_receipt_sent_seq, updated_at)
       VALUES ($1,$2,0,$3)
       ON CONFLICT (room_id) DO UPDATE SET last_read_seq = GREATEST(room_read_state.last_read_seq, EXCLUDED.last_read_seq), updated_at = EXCLUDED.updated_at`,
      [roomId, upToSeq, Date.now()],
    );
    await this.query(
      `INSERT INTO room_preferences (room_id,manually_unread,updated_at) VALUES ($1,FALSE,$2)
       ON CONFLICT (room_id) DO UPDATE SET manually_unread = FALSE, updated_at = GREATEST(room_preferences.updated_at, EXCLUDED.updated_at)`,
      [roomId, Date.now()],
    );
  }

  async setRoomMarkedUnread(roomId: RoomId, marked: boolean): Promise<void> {
    await this.query(
      `INSERT INTO room_preferences (room_id,manually_unread,updated_at) VALUES ($1,$2,$3)
       ON CONFLICT (room_id) DO UPDATE SET manually_unread = EXCLUDED.manually_unread, updated_at = EXCLUDED.updated_at`,
      [roomId, marked, Date.now()],
    );
  }

  async applyReadReceipt(event: RoomEvent, payload: ReadReceiptPayload, own: boolean): Promise<void> {
    await this.markProcessed(event);
    await this.query(
      `INSERT INTO read_receipts (room_id, user_id, last_read_seq, receipt_event_id, read_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (room_id, user_id) DO UPDATE SET
         last_read_seq = GREATEST(read_receipts.last_read_seq, EXCLUDED.last_read_seq),
         receipt_event_id = CASE WHEN EXCLUDED.last_read_seq >= read_receipts.last_read_seq THEN EXCLUDED.receipt_event_id ELSE read_receipts.receipt_event_id END,
         read_at = CASE WHEN EXCLUDED.last_read_seq >= read_receipts.last_read_seq THEN EXCLUDED.read_at ELSE read_receipts.read_at END`,
      [event.room_id, event.sender, payload.up_to_seq, event.event_id, payload.read_at],
    );
    if (own) {
      await this.query(
        `INSERT INTO room_read_state (room_id, last_read_seq, last_receipt_sent_seq, updated_at)
         VALUES ($1,$2,$2,$3)
         ON CONFLICT (room_id) DO UPDATE SET
           last_read_seq = GREATEST(room_read_state.last_read_seq, EXCLUDED.last_read_seq),
           last_receipt_sent_seq = GREATEST(room_read_state.last_receipt_sent_seq, EXCLUDED.last_receipt_sent_seq),
           updated_at = EXCLUDED.updated_at`,
        [event.room_id, payload.up_to_seq, Date.now()],
      );
    }
  }

  async roomReadReceipts(roomId: RoomId): Promise<LocalReadReceipt[]> {
    return this.query<LocalReadReceipt>(
      "SELECT room_id, user_id, last_read_seq, read_at FROM read_receipts r WHERE room_id = $1 AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = r.room_id AND h.user_id = r.user_id) ORDER BY user_id",
      [roomId],
    );
  }

  async applyDeliveryReceipt(event: RoomEvent, payload: DeliveryReceiptPayload, own: boolean): Promise<void> {
    await this.markProcessed(event);
    await this.query(
      `INSERT INTO delivery_receipts (room_id, user_id, last_delivered_seq, receipt_event_id, delivered_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (room_id, user_id) DO UPDATE SET
         last_delivered_seq = GREATEST(delivery_receipts.last_delivered_seq, EXCLUDED.last_delivered_seq),
         receipt_event_id = CASE WHEN EXCLUDED.last_delivered_seq >= delivery_receipts.last_delivered_seq THEN EXCLUDED.receipt_event_id ELSE delivery_receipts.receipt_event_id END,
         delivered_at = CASE WHEN EXCLUDED.last_delivered_seq >= delivery_receipts.last_delivered_seq THEN EXCLUDED.delivered_at ELSE delivery_receipts.delivered_at END`,
      [event.room_id, event.sender, payload.up_to_seq, event.event_id, payload.delivered_at],
    );
    if (own) {
      await this.query(
        `INSERT INTO room_delivery_state (room_id, last_receipt_sent_seq, updated_at) VALUES ($1,$2,$3)
         ON CONFLICT (room_id) DO UPDATE SET
           last_receipt_sent_seq = GREATEST(room_delivery_state.last_receipt_sent_seq, EXCLUDED.last_receipt_sent_seq),
           updated_at = EXCLUDED.updated_at`,
        [event.room_id, payload.up_to_seq, Date.now()],
      );
    }
  }

  async roomDeliveryReceipts(roomId: RoomId): Promise<LocalDeliveryReceipt[]> {
    return this.query<LocalDeliveryReceipt>(
      "SELECT room_id, user_id, last_delivered_seq, delivered_at FROM delivery_receipts r WHERE room_id = $1 AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = r.room_id AND h.user_id = r.user_id) ORDER BY user_id",
      [roomId],
    );
  }

  async deliveryState(roomId: RoomId): Promise<{ last_receipt_sent_seq: number }> {
    const [row] = await this.query<{ last_receipt_sent_seq: number }>(
      "SELECT last_receipt_sent_seq FROM room_delivery_state WHERE room_id = $1",
      [roomId],
    );
    return row ?? { last_receipt_sent_seq: 0 };
  }

  async unreadCounts(currentUserId: string): Promise<RoomUnreadCount[]> {
    return this.query<RoomUnreadCount>(ROOM_UNREAD_COUNTS_SQL, [currentUserId]);
  }

  async readState(roomId: RoomId): Promise<{ last_read_seq: number; last_receipt_sent_seq: number }> {
    const [row] = await this.query<{ last_read_seq: number; last_receipt_sent_seq: number }>(
      "SELECT last_read_seq, last_receipt_sent_seq FROM room_read_state WHERE room_id = $1",
      [roomId],
    );
    return row ?? { last_read_seq: 0, last_receipt_sent_seq: 0 };
  }

  async roomPreferences(): Promise<LocalRoomPreference[]> {
    return this.query<LocalRoomPreference>("SELECT room_id, pinned_at, archived_at, muted_until, local_retention_days, manually_unread, updated_at FROM room_preferences");
  }

  async linkPreviewsEnabled(): Promise<boolean> {
    const [row] = await this.query<{ link_previews: boolean }>("SELECT link_previews FROM device_preferences WHERE id = 1");
    return row?.link_previews ?? true;
  }

  async setLinkPreviewsEnabled(enabled: boolean): Promise<void> {
    await this.query(
      `INSERT INTO device_preferences (id,link_previews,updated_at) VALUES (1,$1,$2)
       ON CONFLICT (id) DO UPDATE SET link_previews = EXCLUDED.link_previews, updated_at = EXCLUDED.updated_at`,
      [enabled, Date.now()],
    );
  }

  async presenceSharingEnabled(): Promise<boolean> {
    const [row] = await this.query<{ share_presence: boolean }>("SELECT share_presence FROM device_preferences WHERE id = 1");
    return row?.share_presence ?? false;
  }

  async setPresenceSharingEnabled(enabled: boolean): Promise<void> {
    await this.query(
      `INSERT INTO device_preferences (id,link_previews,share_presence,updated_at) VALUES (1,TRUE,$1,$2)
       ON CONFLICT (id) DO UPDATE SET share_presence = EXCLUDED.share_presence, updated_at = EXCLUDED.updated_at`,
      [enabled, Date.now()],
    );
  }

  async composerDrafts(): Promise<LocalComposerDraft[]> {
    return this.query<LocalComposerDraft>("SELECT room_id, text_content, mode, target_message_id, quote_text, updated_at FROM composer_drafts ORDER BY updated_at DESC");
  }

  async composerDraft(roomId: RoomId): Promise<LocalComposerDraft | null> {
    const [row] = await this.query<LocalComposerDraft>("SELECT room_id, text_content, mode, target_message_id, quote_text, updated_at FROM composer_drafts WHERE room_id = $1", [roomId]);
    return row ?? null;
  }

  async saveComposerDraft(draft: LocalComposerDraft): Promise<void> {
    if (!draft.text_content.length) return this.deleteComposerDraft(draft.room_id);
    if ((draft.mode === "reply" || draft.mode === "quote" || draft.mode === "edit") && !draft.target_message_id) throw new Error("Composer draft target is required");
    if (draft.mode === "quote" && !draft.quote_text) throw new Error("Quote draft text is required");
    await this.query(
      `INSERT INTO composer_drafts (room_id, text_content, mode, target_message_id, quote_text, updated_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (room_id) DO UPDATE SET text_content = EXCLUDED.text_content, mode = EXCLUDED.mode, target_message_id = EXCLUDED.target_message_id, quote_text = EXCLUDED.quote_text, updated_at = EXCLUDED.updated_at`,
      [draft.room_id, draft.text_content, draft.mode, draft.target_message_id, draft.mode === "quote" ? draft.quote_text : null, draft.updated_at],
    );
  }

  async deleteComposerDraft(roomId: RoomId): Promise<void> {
    await this.query("DELETE FROM composer_drafts WHERE room_id = $1", [roomId]);
  }

  async enqueueComposerDraftSync(roomId: RoomId, draft: LocalComposerDraft | null, clientUpdatedAt: number): Promise<void> {
    await this.query(
      `INSERT INTO composer_draft_outbox (room_id,draft_json,client_updated_at,attempts,next_attempt_at,last_error) VALUES ($1,$2::jsonb,$3,0,NULL,NULL)
       ON CONFLICT (room_id) DO UPDATE SET draft_json = EXCLUDED.draft_json, client_updated_at = EXCLUDED.client_updated_at, attempts = 0, next_attempt_at = NULL, last_error = NULL`,
      [roomId, draft ? JSON.stringify(draft) : null, clientUpdatedAt],
    );
  }

  async composerDraftOutbox(now = Date.now(), limit = 20): Promise<LocalComposerDraftOutbox[]> {
    const rows = await this.query<Omit<LocalComposerDraftOutbox, "draft"> & { draft_json: LocalComposerDraft | string | null }>(
      "SELECT room_id,draft_json,client_updated_at,attempts,next_attempt_at,last_error FROM composer_draft_outbox WHERE next_attempt_at IS NULL OR next_attempt_at <= $1 ORDER BY client_updated_at LIMIT $2",
      [now, limit],
    );
    return rows.map((row) => ({ ...row, draft: row.draft_json === null ? null : jsonValue(row.draft_json) }));
  }

  async failComposerDraftSync(roomId: RoomId, clientUpdatedAt: number, error: string, retryAt: number): Promise<void> {
    await this.query(
      "UPDATE composer_draft_outbox SET attempts = attempts + 1, next_attempt_at = $3, last_error = $4 WHERE room_id = $1 AND client_updated_at = $2",
      [roomId, clientUpdatedAt, retryAt, error.slice(0, 500)],
    );
  }

  async completeComposerDraftSync(roomId: RoomId, clientUpdatedAt: number): Promise<void> {
    await this.query("DELETE FROM composer_draft_outbox WHERE room_id = $1 AND client_updated_at = $2", [roomId, clientUpdatedAt]);
  }

  async composerDraftDeviceSet(): Promise<string | null> {
    const [row] = await this.query<{ device_ids: string }>("SELECT device_ids FROM composer_draft_device_state WHERE singleton = TRUE");
    return row?.device_ids ?? null;
  }

  async setComposerDraftDeviceSet(deviceIds: string): Promise<void> {
    await this.query(
      `INSERT INTO composer_draft_device_state (singleton,device_ids,updated_at) VALUES (TRUE,$1,$2)
       ON CONFLICT (singleton) DO UPDATE SET device_ids = EXCLUDED.device_ids, updated_at = EXCLUDED.updated_at`,
      [deviceIds, Date.now()],
    );
  }

  async applyRemoteComposerDraft(roomId: RoomId, draft: LocalComposerDraft | null, clientUpdatedAt: number, serverUpdatedAt: number): Promise<boolean> {
    const [state] = await this.query<{ server_updated_at: number | string }>("SELECT server_updated_at FROM composer_draft_sync_state WHERE room_id = $1", [roomId]);
    if (state && Number(state.server_updated_at) >= serverUpdatedAt) return false;
    const local = await this.composerDraft(roomId);
    const applied = !local || clientUpdatedAt >= Number(local.updated_at);
    if (applied) {
      if (draft) await this.saveComposerDraft(draft);
      else await this.deleteComposerDraft(roomId);
    }
    await this.query(
      `INSERT INTO composer_draft_sync_state (room_id,server_updated_at) VALUES ($1,$2)
       ON CONFLICT (room_id) DO UPDATE SET server_updated_at = GREATEST(composer_draft_sync_state.server_updated_at, EXCLUDED.server_updated_at)`,
      [roomId, serverUpdatedAt],
    );
    return applied;
  }

  async roomPreference(roomId: RoomId): Promise<LocalRoomPreference> {
    const [row] = await this.query<LocalRoomPreference>("SELECT room_id, pinned_at, archived_at, muted_until, local_retention_days, manually_unread, updated_at FROM room_preferences WHERE room_id = $1", [roomId]);
    return row ?? { room_id: roomId, pinned_at: null, archived_at: null, muted_until: null, local_retention_days: null, manually_unread: false, updated_at: 0 };
  }

  async saveRoomPreference(preference: LocalRoomPreference): Promise<void> {
    await this.query(
      `INSERT INTO room_preferences (room_id, pinned_at, archived_at, muted_until, local_retention_days, manually_unread, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (room_id) DO UPDATE SET pinned_at = EXCLUDED.pinned_at, archived_at = EXCLUDED.archived_at, muted_until = EXCLUDED.muted_until, local_retention_days = EXCLUDED.local_retention_days, manually_unread = EXCLUDED.manually_unread, updated_at = EXCLUDED.updated_at`,
      [preference.room_id, preference.pinned_at, preference.archived_at, preference.muted_until, preference.local_retention_days, preference.manually_unread, preference.updated_at],
    );
  }

  async mergeServerMute(roomId: RoomId, mutedUntil: number | null): Promise<void> {
    await this.query(
      `INSERT INTO room_preferences (room_id, pinned_at, archived_at, muted_until, updated_at) VALUES ($1,NULL,NULL,$2,$3)
       ON CONFLICT (room_id) DO UPDATE SET muted_until = EXCLUDED.muted_until, updated_at = GREATEST(room_preferences.updated_at, EXCLUDED.updated_at)`,
      [roomId, mutedUntil, Date.now()],
    );
  }

  async unarchiveForIncoming(roomId: RoomId, at: number): Promise<boolean> {
    const rows = await this.query<{ room_id: RoomId }>(
      `UPDATE room_preferences SET archived_at = NULL, updated_at = $2
       WHERE room_id = $1 AND archived_at IS NOT NULL AND (muted_until IS NULL OR muted_until <= $2)
       RETURNING room_id`,
      [roomId, at],
    );
    return rows.length > 0;
  }

  async setLocalRetention(roomId: RoomId, days: LocalRetentionDays | null, now = Date.now()): Promise<{ preference: LocalRoomPreference; deleted: number }> {
    if (days !== null && !isLocalRetentionDays(days)) throw new Error("Invalid local retention period");
    const response = await this.request({ kind: "set-room-retention", roomId, days, now });
    const deleted = Number((response.rows?.[0] as { deleted?: number } | undefined)?.deleted ?? 0);
    const preference = await this.roomPreference(roomId);
    return { preference, deleted };
  }

  async purgeRoomBefore(roomId: RoomId, cutoff: number): Promise<number> {
    const response = await this.request({ kind: "purge-room", roomId, cutoff });
    return Number((response.rows?.[0] as { deleted?: number } | undefined)?.deleted ?? 0);
  }

  async enforceLocalRetention(now = Date.now()): Promise<number> {
    let deleted = 0;
    for (const preference of await this.roomPreferences()) {
      const days = Number(preference.local_retention_days);
      if (preference.local_retention_days !== null && isLocalRetentionDays(days)) {
        deleted += await this.purgeRoomBefore(preference.room_id, now - days * 86_400_000);
      }
    }
    return deleted;
  }

  async purgeExpiredMessages(now = Date.now()): Promise<number> {
    const response = await this.request({ kind: "purge-expired-messages", now });
    return Number((response.rows?.[0] as { deleted?: number } | undefined)?.deleted ?? 0);
  }

  async latestQueuedReadReceiptSeq(roomId: RoomId): Promise<number> {
    const [row] = await this.query<{ seq: number | string | null }>(
      `SELECT MAX(CAST(payload->>'up_to_seq' AS BIGINT)) AS seq FROM outbox
       WHERE room_id = $1 AND payload->>'kind' = 'receipt.read' AND status IN ('pending', 'sending')`,
      [roomId],
    );
    return Number(row?.seq ?? 0);
  }

  async supersedeReadReceiptOutbox(roomId: RoomId): Promise<void> {
    await this.query(
      "DELETE FROM outbox WHERE room_id = $1 AND payload->>'kind' = 'receipt.read' AND status <> 'sending'",
      [roomId],
    );
  }

  async latestQueuedDeliveryReceiptSeq(roomId: RoomId): Promise<number> {
    const [row] = await this.query<{ seq: number | string | null }>(
      `SELECT MAX(CAST(payload->>'up_to_seq' AS BIGINT)) AS seq FROM outbox
       WHERE room_id = $1 AND payload->>'kind' = 'receipt.delivered' AND status IN ('pending', 'sending')`,
      [roomId],
    );
    return Number(row?.seq ?? 0);
  }

  async supersedeDeliveryReceiptOutbox(roomId: RoomId): Promise<void> {
    await this.query(
      "DELETE FROM outbox WHERE room_id = $1 AND payload->>'kind' = 'receipt.delivered' AND status <> 'sending'",
      [roomId],
    );
  }

  async applyMessageTombstone(event: RoomEvent, targetMessageId: MessageId): Promise<void> {
    await this.markProcessed(event);
    if (event.seq <= await this.localHistoryFloor(event.room_id)) return;
    const [target] = await this.query<{ sender: string }>("SELECT sender FROM messages WHERE message_id = $1 AND room_id = $2", [targetMessageId, event.room_id]);
    if (target && target.sender !== event.sender) return;
    await this.query(
      `INSERT INTO message_tombstones (target_message_id, room_id, delete_event_id, delete_seq, deleted_by, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (target_message_id) DO UPDATE SET
         delete_event_id = CASE WHEN EXCLUDED.delete_seq < message_tombstones.delete_seq THEN EXCLUDED.delete_event_id ELSE message_tombstones.delete_event_id END,
         delete_seq = LEAST(message_tombstones.delete_seq, EXCLUDED.delete_seq),
         deleted_by = CASE WHEN EXCLUDED.delete_seq < message_tombstones.delete_seq THEN EXCLUDED.deleted_by ELSE message_tombstones.deleted_by END,
         deleted_at = LEAST(message_tombstones.deleted_at, EXCLUDED.deleted_at)`,
      [targetMessageId, event.room_id, event.event_id, event.seq, event.sender, event.created_at],
    );
    const [tombstone] = await this.query<{ delete_event_id: string; delete_seq: number; deleted_by: string; deleted_at: number }>(
      "SELECT delete_event_id, delete_seq, deleted_by, deleted_at FROM message_tombstones WHERE target_message_id = $1",
      [targetMessageId],
    );
    if (tombstone) await this.redactMessage(targetMessageId, tombstone);
  }

  async enqueueOutbox(event: ClientEvent, plaintext: string, payload: Record<string, unknown>): Promise<void> {
    const messageId = typeof payload.message_id === "string" && payload.message_id ? payload.message_id : event.event_id;
    const now = Date.now();
    await this.query(
      `INSERT INTO outbox (event_id, message_id, room_id, event_json, plaintext, payload, status, attempts, next_attempt_at, last_error, created_at, updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,'pending',0,$7,NULL,$7,$7)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.event_id, messageId, event.room_id, JSON.stringify(event), plaintext, JSON.stringify(payload), now],
    );
  }

  async outbox(roomId: RoomId): Promise<OutboxItem[]> {
    const rows = await this.query<OutboxRow>("SELECT event_id, message_id, room_id, event_json, plaintext, payload, status, attempts, next_attempt_at, last_error, created_at, updated_at FROM outbox WHERE room_id = $1 ORDER BY created_at", [roomId]);
    return rows.map((row) => ({ ...row, event: jsonValue(row.event_json), payload: jsonValue(row.payload) }));
  }

  async dueOutbox(now: number, limit = 20): Promise<OutboxItem[]> {
    const rows = await this.query<OutboxRow>(
      "SELECT event_id, message_id, room_id, event_json, plaintext, payload, status, attempts, next_attempt_at, last_error, created_at, updated_at FROM outbox WHERE status IN ('pending','sending') AND (next_attempt_at IS NULL OR next_attempt_at <= $1) ORDER BY created_at LIMIT $2",
      [now, limit],
    );
    return rows.map((row) => ({ ...row, event: jsonValue(row.event_json), payload: jsonValue(row.payload) }));
  }

  async nextOutboxAttempt(): Promise<number | null> {
    const [row] = await this.query<{ next_attempt_at: number | null }>("SELECT MIN(next_attempt_at) AS next_attempt_at FROM outbox WHERE status = 'pending'");
    return row?.next_attempt_at === null || row?.next_attempt_at === undefined ? null : Number(row.next_attempt_at);
  }

  async markOutboxSending(eventId: string): Promise<void> {
    await this.query("UPDATE outbox SET status = 'sending', attempts = attempts + 1, updated_at = $2 WHERE event_id = $1", [eventId, Date.now()]);
  }

  async deferOutbox(eventId: string, error: string, nextAttemptAt: number | null): Promise<void> {
    await this.query("UPDATE outbox SET status = $2, next_attempt_at = $3, last_error = $4, updated_at = $5 WHERE event_id = $1", [eventId, nextAttemptAt === null ? "failed" : "pending", nextAttemptAt, error.slice(0, 500), Date.now()]);
  }

  async retryOutbox(eventId: string): Promise<void> {
    await this.query("UPDATE outbox SET status = 'pending', next_attempt_at = $2, last_error = NULL, updated_at = $2 WHERE event_id = $1", [eventId, Date.now()]);
  }

  async removeOutbox(eventId: string): Promise<void> {
    await this.query("DELETE FROM outbox WHERE event_id = $1", [eventId]);
  }

  async saveDeviceRevocationOutbox(revocationId: string, targetDeviceId: string, event: ClientEvent, previousMlsState: Uint8Array, mlsState: Uint8Array): Promise<void> {
    const now = Date.now();
    await this.query(
      `INSERT INTO device_revocation_outbox (revocation_id, room_id, target_device_id, event_json, previous_mls_state, mls_state, last_error, created_at, updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,NULL,$7,$7)
       ON CONFLICT (revocation_id, room_id) DO UPDATE SET event_json = EXCLUDED.event_json, previous_mls_state = EXCLUDED.previous_mls_state, mls_state = EXCLUDED.mls_state, last_error = NULL, updated_at = EXCLUDED.updated_at`,
      [revocationId, event.room_id, targetDeviceId, JSON.stringify(event), previousMlsState, mlsState, now],
    );
  }

  async deviceRevocationOutbox(revocationId: string, roomId: RoomId): Promise<DeviceRevocationOutboxItem | null> {
    const [row] = await this.query<DeviceRevocationOutboxRow>("SELECT revocation_id, room_id, target_device_id, event_json, previous_mls_state, mls_state, last_error, created_at, updated_at FROM device_revocation_outbox WHERE revocation_id = $1 AND room_id = $2", [revocationId, roomId]);
    return row ? { ...row, event: jsonValue(row.event_json) } : null;
  }

  async pendingDeviceRevocations(): Promise<DeviceRevocationOutboxItem[]> {
    const rows = await this.query<DeviceRevocationOutboxRow>("SELECT revocation_id, room_id, target_device_id, event_json, previous_mls_state, mls_state, last_error, created_at, updated_at FROM device_revocation_outbox ORDER BY created_at");
    return rows.map((row) => ({ ...row, event: jsonValue(row.event_json) }));
  }

  async failDeviceRevocationOutbox(revocationId: string, roomId: RoomId, error: string): Promise<void> {
    await this.query("UPDATE device_revocation_outbox SET last_error = $3, updated_at = $4 WHERE revocation_id = $1 AND room_id = $2", [revocationId, roomId, error.slice(0, 500), Date.now()]);
  }

  async removeDeviceRevocationOutbox(revocationId: string, roomId: RoomId): Promise<void> {
    await this.query("DELETE FROM device_revocation_outbox WHERE revocation_id = $1 AND room_id = $2", [revocationId, roomId]);
  }

  async saveDeviceLinkOutbox(linkId: string, targetDeviceId: string, event: ClientEvent, encryptedState: string, previousMlsState: Uint8Array, mlsState: Uint8Array): Promise<void> {
    const now = Date.now();
    await this.query(
      `INSERT INTO device_link_outbox (link_id, room_id, target_device_id, event_json, encrypted_state, previous_mls_state, mls_state, last_error, created_at, updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,NULL,$8,$8)
       ON CONFLICT (link_id, room_id) DO UPDATE SET event_json = EXCLUDED.event_json, encrypted_state = EXCLUDED.encrypted_state, previous_mls_state = EXCLUDED.previous_mls_state, mls_state = EXCLUDED.mls_state, last_error = NULL, updated_at = EXCLUDED.updated_at`,
      [linkId, event.room_id, targetDeviceId, JSON.stringify(event), encryptedState, previousMlsState, mlsState, now],
    );
  }

  async saveDeviceLinkJob(linkId: string, targetDeviceId: string): Promise<void> {
    const now = Date.now();
    await this.query(
      `INSERT INTO device_link_jobs (link_id, target_device_id, last_error, created_at, updated_at) VALUES ($1,$2,NULL,$3,$3)
       ON CONFLICT (link_id) DO UPDATE SET target_device_id = EXCLUDED.target_device_id, last_error = NULL, updated_at = EXCLUDED.updated_at`,
      [linkId, targetDeviceId, now],
    );
  }

  async pendingDeviceLinkJobs(): Promise<Array<{ link_id: string; target_device_id: string; last_error: string | null }>> {
    return this.query("SELECT link_id, target_device_id, last_error FROM device_link_jobs ORDER BY created_at");
  }

  async failDeviceLinkJob(linkId: string, error: string): Promise<void> {
    await this.query("UPDATE device_link_jobs SET last_error = $2, updated_at = $3 WHERE link_id = $1", [linkId, error.slice(0, 500), Date.now()]);
  }

  async removeDeviceLinkJob(linkId: string): Promise<void> {
    await this.query("DELETE FROM device_link_jobs WHERE link_id = $1", [linkId]);
  }

  async deviceLinkOutbox(linkId: string, roomId: RoomId): Promise<DeviceLinkOutboxItem | null> {
    const [row] = await this.query<DeviceLinkOutboxRow>("SELECT link_id, room_id, target_device_id, event_json, encrypted_state, previous_mls_state, mls_state, last_error, created_at, updated_at FROM device_link_outbox WHERE link_id = $1 AND room_id = $2", [linkId, roomId]);
    return row ? { ...row, event: jsonValue(row.event_json) } : null;
  }

  async pendingDeviceLinks(): Promise<DeviceLinkOutboxItem[]> {
    const rows = await this.query<DeviceLinkOutboxRow>("SELECT link_id, room_id, target_device_id, event_json, encrypted_state, previous_mls_state, mls_state, last_error, created_at, updated_at FROM device_link_outbox ORDER BY created_at");
    return rows.map((row) => ({ ...row, event: jsonValue(row.event_json) }));
  }

  async failDeviceLinkOutbox(linkId: string, roomId: RoomId, error: string): Promise<void> {
    await this.query("UPDATE device_link_outbox SET last_error = $3, updated_at = $4 WHERE link_id = $1 AND room_id = $2", [linkId, roomId, error.slice(0, 500), Date.now()]);
  }

  async removeDeviceLinkOutbox(linkId: string, roomId: RoomId): Promise<void> {
    await this.query("DELETE FROM device_link_outbox WHERE link_id = $1 AND room_id = $2", [linkId, roomId]);
  }

  async saveAccountRemovalOutbox(deletionId: string, targetUserId: string, targetDeviceIds: string[], event: ClientEvent, previousMlsState: Uint8Array, mlsState: Uint8Array): Promise<void> {
    const now = Date.now();
    await this.query(
      `INSERT INTO account_removal_outbox (deletion_id, room_id, target_user_id, target_device_ids, event_json, previous_mls_state, mls_state, last_error, created_at, updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,NULL,$8,$8)
       ON CONFLICT (deletion_id, room_id) DO UPDATE SET target_device_ids = EXCLUDED.target_device_ids, event_json = EXCLUDED.event_json, previous_mls_state = EXCLUDED.previous_mls_state, mls_state = EXCLUDED.mls_state, last_error = NULL, updated_at = EXCLUDED.updated_at`,
      [deletionId, event.room_id, targetUserId, JSON.stringify(targetDeviceIds), JSON.stringify(event), previousMlsState, mlsState, now],
    );
  }

  async accountRemovalOutbox(deletionId: string, roomId: RoomId): Promise<AccountRemovalOutboxItem | null> {
    const [row] = await this.query<AccountRemovalOutboxRow>("SELECT deletion_id, room_id, target_user_id, target_device_ids, event_json, previous_mls_state, mls_state, last_error, created_at, updated_at FROM account_removal_outbox WHERE deletion_id = $1 AND room_id = $2", [deletionId, roomId]);
    return row ? { ...row, event: jsonValue(row.event_json), target_device_ids: jsonValue(row.target_device_ids) } : null;
  }

  async pendingAccountRemovals(): Promise<AccountRemovalOutboxItem[]> {
    const rows = await this.query<AccountRemovalOutboxRow>("SELECT deletion_id, room_id, target_user_id, target_device_ids, event_json, previous_mls_state, mls_state, last_error, created_at, updated_at FROM account_removal_outbox ORDER BY created_at");
    return rows.map((row) => ({ ...row, event: jsonValue(row.event_json), target_device_ids: jsonValue(row.target_device_ids) }));
  }

  async failAccountRemovalOutbox(deletionId: string, roomId: RoomId, error: string): Promise<void> {
    await this.query("UPDATE account_removal_outbox SET last_error = $3, updated_at = $4 WHERE deletion_id = $1 AND room_id = $2", [deletionId, roomId, error.slice(0, 500), Date.now()]);
  }

  async removeAccountRemovalOutbox(deletionId: string, roomId: RoomId): Promise<void> {
    await this.query("DELETE FROM account_removal_outbox WHERE deletion_id = $1 AND room_id = $2", [deletionId, roomId]);
  }

  async saveRoomMembershipOutbox(item: Omit<RoomMembershipOutboxItem, "last_error" | "created_at" | "updated_at">): Promise<void> {
    const now = Date.now();
    await this.query(
      `INSERT INTO room_membership_outbox (room_id,operation,target_user_id,target_device_ids,event_json,mls_welcome,mls_ratchet_tree,mls_claim_ids,previous_mls_state,mls_state,last_error,created_at,updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb,$9,$10,NULL,$11,$11)
       ON CONFLICT (room_id) DO UPDATE SET operation = EXCLUDED.operation, target_user_id = EXCLUDED.target_user_id, target_device_ids = EXCLUDED.target_device_ids,
         event_json = EXCLUDED.event_json, mls_welcome = EXCLUDED.mls_welcome, mls_ratchet_tree = EXCLUDED.mls_ratchet_tree, mls_claim_ids = EXCLUDED.mls_claim_ids,
         previous_mls_state = EXCLUDED.previous_mls_state, mls_state = EXCLUDED.mls_state, last_error = NULL, updated_at = EXCLUDED.updated_at`,
      [item.room_id, item.operation, item.target_user_id, JSON.stringify(item.target_device_ids), JSON.stringify(item.event), item.mls_welcome,
        item.mls_ratchet_tree, JSON.stringify(item.mls_claim_ids), item.previous_mls_state, item.mls_state, now],
    );
  }

  async roomMembershipOutbox(roomId: RoomId): Promise<RoomMembershipOutboxItem | null> {
    const [row] = await this.query<RoomMembershipOutboxRow>("SELECT room_id,operation,target_user_id,target_device_ids,event_json,mls_welcome,mls_ratchet_tree,mls_claim_ids,previous_mls_state,mls_state,last_error,created_at,updated_at FROM room_membership_outbox WHERE room_id = $1", [roomId]);
    return row ? { ...row, event: jsonValue(row.event_json), target_device_ids: jsonValue(row.target_device_ids), mls_claim_ids: jsonValue(row.mls_claim_ids) } : null;
  }

  async pendingRoomMembershipChanges(): Promise<RoomMembershipOutboxItem[]> {
    const rows = await this.query<RoomMembershipOutboxRow>("SELECT room_id,operation,target_user_id,target_device_ids,event_json,mls_welcome,mls_ratchet_tree,mls_claim_ids,previous_mls_state,mls_state,last_error,created_at,updated_at FROM room_membership_outbox ORDER BY created_at");
    return rows.map((row) => ({ ...row, event: jsonValue(row.event_json), target_device_ids: jsonValue(row.target_device_ids), mls_claim_ids: jsonValue(row.mls_claim_ids) }));
  }

  async failRoomMembershipOutbox(roomId: RoomId, error: string): Promise<void> {
    await this.query("UPDATE room_membership_outbox SET last_error = $2, updated_at = $3 WHERE room_id = $1", [roomId, error.slice(0, 500), Date.now()]);
  }

  async removeRoomMembershipOutbox(roomId: RoomId): Promise<void> {
    await this.query("DELETE FROM room_membership_outbox WHERE room_id = $1", [roomId]);
  }

  async hasMessage(eventId: string): Promise<boolean> {
    const [row] = await this.query<{ present: boolean }>("SELECT EXISTS(SELECT 1 FROM processed_events WHERE event_id = $1) AS present", [eventId]);
    return Boolean(row?.present);
  }

  async markProcessed(event: RoomEvent): Promise<void> {
    const now = Date.now();
    await this.query(
      MARK_EVENT_PROCESSED_SQL,
      [event.event_id, event.room_id, event.seq, event.created_at, JSON.stringify(event), now],
    );
    await this.advanceRoomSequence(event.room_id);
  }

  async signedEventRange(roomId: RoomId, startSeq: number, endSeq: number): Promise<LocalSignedEventRange> {
    if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq) || startSeq < 1 || endSeq < startSeq || endSeq - startSeq + 1 > MAX_SIGNED_EVENT_RANGE) {
      throw new Error(`Signed event range must contain 1-${MAX_SIGNED_EVENT_RANGE} positive sequences`);
    }
    const rows = await this.query<LocalEventEnvelopeRow>(
      "SELECT event_id, room_id, seq, event_json FROM event_envelopes WHERE room_id = $1 AND seq BETWEEN $2 AND $3 ORDER BY seq",
      [roomId, startSeq, endSeq],
    );
    return assembleSignedEventRange(rows, roomId, startSeq, endSeq);
  }

  async quarantineEvent(event: RoomEvent, error: string): Promise<void> {
    await this.query(
      `INSERT INTO failed_events (event_id, room_id, seq, event_json, error, failed_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6)
       ON CONFLICT (event_id) DO UPDATE SET error = EXCLUDED.error, failed_at = EXCLUDED.failed_at`,
      [event.event_id, event.room_id, event.seq, JSON.stringify(event), error.slice(0, 500), Date.now()],
    );
  }

  async search(query: string, roomId?: RoomId): Promise<SearchResult[]> {
    const roomClause = roomId ? "AND m.room_id = $2" : "";
    const params = roomId ? [query, roomId] : [query];
    return this.query<SearchResult>(
      `SELECT 'text' AS kind, event_id, message_id, room_id, seq, sender, created_at, plaintext FROM messages m
       WHERE plaintext IS NOT NULL AND deleted_at IS NULL ${roomClause}
         AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender)
         AND (search_vector @@ plainto_tsquery('simple', $1) OR plaintext ILIKE '%' || $1 || '%')
       ORDER BY created_at DESC LIMIT 100`, params,
    );
  }

  async saveImageEmbedding(input: { attachment_id: string; model_id: string; model_version: string; preprocessing_version: string; embedding: Float32Array }): Promise<void> {
    if (!input.embedding.length || !Array.from(input.embedding).every(Number.isFinite)) throw new Error("Invalid image embedding");
    const normalized = normalizeVector(input.embedding);
    const bytes = new Uint8Array(normalized.buffer.slice(normalized.byteOffset, normalized.byteOffset + normalized.byteLength));
    await this.query(
      `INSERT INTO image_embeddings (attachment_id, model_id, model_version, preprocessing_version, dimensions, embedding, indexed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (attachment_id, model_id, model_version, preprocessing_version)
       DO UPDATE SET dimensions = EXCLUDED.dimensions, embedding = EXCLUDED.embedding, indexed_at = EXCLUDED.indexed_at`,
      [input.attachment_id, input.model_id, input.model_version, input.preprocessing_version, normalized.length, bytes, Date.now()],
    );
  }

  async hasImageEmbedding(attachmentId: string, model: { id: string; version: string; preprocessing_version: string }): Promise<boolean> {
    const [row] = await this.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM image_embeddings WHERE attachment_id = $1 AND model_id = $2 AND model_version = $3 AND preprocessing_version = $4) AS present`,
      [attachmentId, model.id, model.version, model.preprocessing_version],
    );
    return Boolean(row?.present);
  }

  async semanticImageSearch(query: Float32Array, model: { id: string; version: string; preprocessing_version: string }, roomId?: RoomId, limit = 30): Promise<ImageSearchResult[]> {
    const roomClause = roomId ? "AND m.room_id = $4" : "";
    const rows = await this.query<ImageEmbeddingRow>(
      `SELECT m.message_id, m.room_id, m.seq, m.sender, m.created_at, a.attachment_id,
              COALESCE(a.metadata->>'name', '图片') AS name, e.embedding, e.dimensions
       FROM image_embeddings e
       JOIN attachments a ON a.attachment_id = e.attachment_id
       JOIN messages m ON m.message_id = a.message_id
       WHERE e.model_id = $1 AND e.model_version = $2 AND e.preprocessing_version = $3 AND m.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM room_hidden_senders h WHERE h.room_id = m.room_id AND h.user_id = m.sender) ${roomClause}`,
      roomId ? [model.id, model.version, model.preprocessing_version, roomId] : [model.id, model.version, model.preprocessing_version],
    );
    return rankImageEmbeddings(rows, query, limit);
  }

  async coverage(roomId: RoomId): Promise<{ indexed_until_seq: number | null; oldest_local_seq: number | null; newest_local_seq: number | null; history_complete: boolean }> {
    const [row] = await this.query<{ indexed_until_seq: number | null; oldest_local_seq: number | null; newest_local_seq: number | null; history_complete: boolean }>("SELECT indexed_until_seq, oldest_local_seq, newest_local_seq, history_complete FROM segment_state WHERE room_id = $1", [roomId]);
    return row ?? { indexed_until_seq: null, oldest_local_seq: null, newest_local_seq: null, history_complete: false };
  }

  async saveCryptoState(roomId: RoomId, epoch: number, state: Uint8Array, provider: string): Promise<void> {
    await this.query(
      `INSERT INTO crypto_state (room_id, epoch, state, provider, updated_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (room_id) DO UPDATE SET epoch = EXCLUDED.epoch, state = EXCLUDED.state, provider = EXCLUDED.provider, updated_at = EXCLUDED.updated_at`,
      [roomId, epoch, state, provider, Date.now()],
    );
  }

  async loadCryptoState(roomId: RoomId): Promise<{ epoch: number; state: Uint8Array; provider: string } | null> {
    const [row] = await this.query<{ epoch: number; state: Uint8Array; provider: string }>("SELECT epoch, state, provider FROM crypto_state WHERE room_id = $1", [roomId]);
    return row ?? null;
  }

  async saveArchiveKey(roomId: RoomId, segmentId: string, key: Uint8Array<ArrayBuffer>, startSeq: number, endSeq: number): Promise<void> {
    if (endSeq <= await this.localHistoryFloor(roomId)) return;
    await this.query(
      `INSERT INTO archive_keys (segment_id, room_id, segment_key, start_seq, end_seq, received_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (segment_id) DO UPDATE SET segment_key = EXCLUDED.segment_key, start_seq = EXCLUDED.start_seq, end_seq = EXCLUDED.end_seq, received_at = EXCLUDED.received_at`,
      [segmentId, roomId, key, startSeq, endSeq, Date.now()],
    );
  }

  async archiveKey(segmentId: string): Promise<{ room_id: RoomId; segment_key: Uint8Array<ArrayBuffer>; start_seq: number; end_seq: number } | null> {
    const [row] = await this.query<{ room_id: RoomId; segment_key: Uint8Array<ArrayBuffer>; start_seq: number; end_seq: number }>("SELECT room_id, segment_key, start_seq, end_seq FROM archive_keys WHERE segment_id = $1", [segmentId]);
    return row ?? null;
  }

  async archiveSegmentMetadata(segmentId: string): Promise<LocalArchiveSegmentMetadata | null> {
    const [row] = await this.query<LocalArchiveSegmentMetadata>(
      "SELECT segment_id, room_id, start_seq, end_seq, byte_size, header_bytes, envelope_index_bytes FROM archive_segment_metadata WHERE segment_id = $1",
      [segmentId],
    );
    return row ? { ...row, start_seq: Number(row.start_seq), end_seq: Number(row.end_seq), byte_size: Number(row.byte_size) } : null;
  }

  async saveArchiveSegmentMetadata(value: LocalArchiveSegmentMetadata): Promise<void> {
    if (value.end_seq <= await this.localHistoryFloor(value.room_id)) return;
    await this.query(
      `INSERT INTO archive_segment_metadata (segment_id, room_id, start_seq, end_seq, byte_size, header_bytes, envelope_index_bytes, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (segment_id) DO UPDATE SET room_id = EXCLUDED.room_id, start_seq = EXCLUDED.start_seq,
         end_seq = EXCLUDED.end_seq, byte_size = EXCLUDED.byte_size, header_bytes = EXCLUDED.header_bytes,
         envelope_index_bytes = EXCLUDED.envelope_index_bytes, verified_at = EXCLUDED.verified_at`,
      [value.segment_id, value.room_id, value.start_seq, value.end_seq, value.byte_size, value.header_bytes, value.envelope_index_bytes, Date.now()],
    );
  }

  async removeArchiveSegmentMetadata(segmentId: string): Promise<void> {
    await this.query("DELETE FROM archive_segment_metadata WHERE segment_id = $1", [segmentId]);
  }

  async saveCompactionJob(job: { room_id: RoomId; segment_id: string; lease_token: string; start_seq: number; end_seq: number; expires_at: number; status: CompactionJobStatus; error?: string | null }): Promise<void> {
    await this.query(
      `INSERT INTO compaction_jobs (room_id, segment_id, lease_token, start_seq, end_seq, expires_at, status, error, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (room_id) DO UPDATE SET segment_id = EXCLUDED.segment_id, lease_token = EXCLUDED.lease_token, start_seq = EXCLUDED.start_seq, end_seq = EXCLUDED.end_seq, expires_at = EXCLUDED.expires_at, status = EXCLUDED.status, error = EXCLUDED.error, updated_at = EXCLUDED.updated_at`,
      [job.room_id, job.segment_id, job.lease_token, job.start_seq, job.end_seq, job.expires_at, job.status, job.error ?? null, Date.now()],
    );
  }

  async pendingArchiveRetentionAcks(): Promise<PendingArchiveRetentionAck[]> {
    return this.query<PendingArchiveRetentionAck>(
      "SELECT room_id, segment_id FROM compaction_jobs WHERE status = 'uploaded' ORDER BY updated_at",
    );
  }

  async completeArchiveRetentionAck(roomId: RoomId, segmentId: string): Promise<void> {
    await this.query(
      "UPDATE compaction_jobs SET status = 'complete', error = NULL, updated_at = $3 WHERE room_id = $1 AND segment_id = $2 AND status = 'uploaded'",
      [roomId, segmentId, Date.now()],
    );
  }

  close(): Promise<void> {
    this.closing ??= this.request({ kind: "close" })
      .then(() => undefined, () => undefined)
      .finally(() => this.worker.terminate());
    return this.closing;
  }

  private async redactMessage(messageId: string, tombstone: { delete_event_id: string; deleted_by: string; deleted_at: number }): Promise<void> {
    const redactedPayload = JSON.stringify({ version: 2, message_id: messageId, parts: [], deleted: true });
    // Redact searchable/display content first. Remaining normalized rows are unreachable even if cleanup is interrupted.
    await this.query(
      "UPDATE messages SET plaintext = NULL, payload = $2::jsonb, search_vector = NULL, deleted_at = $3, deleted_by = $4, delete_event_id = $5 WHERE message_id = $1",
      [messageId, redactedPayload, tombstone.deleted_at, tombstone.deleted_by, tombstone.delete_event_id],
    );
    await this.query("DELETE FROM image_embeddings WHERE attachment_id IN (SELECT attachment_id FROM attachments WHERE message_id = $1)", [messageId]);
    await this.query("DELETE FROM attachments WHERE message_id = $1", [messageId]);
    await this.query("DELETE FROM message_parts WHERE message_id = $1", [messageId]);
  }

  private async projectLatestEdit(messageId: string): Promise<void> {
    const [target] = await this.query<{ sender: string; payload: Record<string, unknown> | string | null; deleted_at: number | null }>(
      "SELECT sender, payload, deleted_at FROM messages WHERE message_id = $1", [messageId],
    );
    if (!target || target.deleted_at !== null || !target.payload) return;
    const [edit] = await this.query<{ edit_event_id: string; text_content: string; edited_at: number }>(
      "SELECT edit_event_id, text_content, edited_at FROM message_edits WHERE target_message_id = $1 AND sender = $2 ORDER BY edit_seq DESC LIMIT 1",
      [messageId, target.sender],
    );
    if (!edit) return;
    const payload = jsonValue<Record<string, unknown>>(target.payload);
    const projection = projectEditedPayload(payload, messageId, edit.text_content);
    await this.query(
      "UPDATE messages SET plaintext = $2, payload = $3::jsonb, search_vector = to_tsvector('simple', $2), edited_at = $4, edit_event_id = $5 WHERE message_id = $1 AND deleted_at IS NULL",
      [messageId, edit.text_content, JSON.stringify(projection.payload), edit.edited_at, edit.edit_event_id],
    );
    await this.query("DELETE FROM message_parts WHERE message_id = $1", [messageId]);
    const projectedParts = Array.isArray(projection.payload.parts) ? projection.payload.parts : [];
    for (const [position, value] of projectedParts.entries()) {
      if (!value || typeof value !== "object") continue;
      const part = value as Record<string, unknown>;
      const partId = typeof part.part_id === "string" ? part.part_id : `${messageId}:${position}`;
      const attachment = part.attachment && typeof part.attachment === "object" ? part.attachment as Record<string, unknown> : null;
      await this.query(
        `INSERT INTO message_parts (part_id, message_id, position, kind, text_content, attachment_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [partId, messageId, position, typeof part.kind === "string" ? part.kind : "unknown", part.kind === "text" && typeof part.text === "string" ? part.text : null, attachment && typeof attachment.id === "string" ? attachment.id : null, JSON.stringify(part)],
      );
    }
  }

  private send(sql: string, params: unknown[], exec: boolean): Promise<{ rows: unknown[]; storage: "opfs" | "indexeddb" }> {
    return this.request({ sql, params, exec }).then((response) => ({ rows: response.rows ?? [], storage: response.storage ?? "indexeddb" }));
  }

  private async stageSnapshot(kind: "restore" | "restore-device-history", snapshot: Blob, expectedUserId: string): Promise<string> {
    const restoreId = crypto.randomUUID();
    try {
      const response = await this.request({ kind, snapshot, expectedUserId, restoreId });
      if (!response.restored) throw new Error(kind === "restore" ? "Local database snapshot was not restored" : "Linked-device history was not restored");
      return restoreId;
    } catch (cause) {
      // An error response from the Worker is authoritative: validation or the
      // activation transaction failed before it acknowledged a commit.
      if (cause instanceof LocalDatabaseResponseError) throw cause;
      try {
        if (await this.restoreCommitted(restoreId)) return restoreId;
      } catch (verificationCause) {
        throw new LocalRestoreCommitUnknownError(verificationCause);
      }
      throw cause;
    }
  }

  private failWorker(error: Error): void {
    if (this.workerFailure) return;
    this.workerFailure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private request(message: Record<string, unknown>): Promise<DbResponse> {
    if (this.workerFailure) return Promise.reject(this.workerFailure);
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, profileId: this.profileId, ...message }); }
      catch (cause) {
        this.pending.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }
}

export function normalizeVector(vector: Float32Array): Float32Array {
  let magnitudeSquared = 0;
  for (const value of vector) magnitudeSquared += value * value;
  const magnitude = Math.sqrt(magnitudeSquared);
  if (!Number.isFinite(magnitude) || magnitude === 0) throw new Error("Embedding must have a finite non-zero magnitude");
  return Float32Array.from(vector, (value) => value / magnitude);
}

function floatVector(bytes: Uint8Array): Float32Array {
  const copy = Uint8Array.from(bytes);
  return new Float32Array(copy.buffer);
}

export { LOCAL_RETENTION_DAY_OPTIONS, type LocalRetentionDays } from "./retention";
export type { LocalHistoryClearResult } from "./local-history";

export function rankImageEmbeddings(rows: ImageEmbeddingRow[], query: Float32Array, limit = 30): ImageSearchResult[] {
  const normalizedQuery = normalizeVector(query);
  const results: ImageSearchResult[] = [];
  for (const row of rows) {
    const vector = floatVector(row.embedding);
    if (vector.length !== normalizedQuery.length || row.dimensions !== vector.length) continue;
    const { embedding: _embedding, dimensions: _dimensions, ...metadata } = row;
    results.push({ ...metadata, kind: "image", score: dot(normalizedQuery, vector) });
  }
  return results.sort((left, right) => right.score - left.score).slice(0, limit);
}

function dot(left: Float32Array, right: Float32Array): number {
  let score = 0;
  for (let index = 0; index < left.length; index++) score += left[index] * right[index];
  return score;
}
