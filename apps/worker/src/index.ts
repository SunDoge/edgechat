import { canonicalDraftEnvelopeBytes, canonicalEventBytes, currentServerProtocol, deviceSessionProofBytes, isClientEventEnvelope, isNamespacedRoomId, isNamespacedUserId, isRoomEventEnvelope, MAX_ATTACHMENT_PLAINTEXT_BYTES, MAX_EVENT_CIPHERTEXT_LENGTH, MAX_MESSAGE_ATTACHMENTS, MIN_SUPPORTED_PROTOCOL_VERSION, PROTOCOL_VERSION, roomEventTypes, type ClientEvent, type Device, type DeviceSessionChallenge, type DraftEnvelope, type EventAcceptanceReceipt, type RoomEvent, type RoomId, type RoomSummary, type ServerProtocolCapabilities, type UserId, type UserProfile } from "@edgechat/protocol";
import { batch } from "@sundoge/kysely-d1";
import { sql } from "kysely";
import { authenticate, cleanupExpiredAuthenticationState, createSession, passwordHash, validatePublicKeys, verifyPassword } from "./auth";
import { createDatabase } from "./database";
import type { AuthContext, Env } from "./env";
import { b64url, fromB64url, hardenApiResponse, HttpError, json, randomId, readJson, sha256, stringField } from "./http";
import { notifyAccountDevices, notifyOfflineDevices } from "./push";
import { accountDeletionStatus, accountExport, accountExportDrafts, accountExportEvents, accountExportObjects, accountExportRooms, accountRemovalTasks, completeAccountRoomRemoval, processAccountDeletions, requestAccountDeletion } from "./account";
import { eventReceiptKeyStatus, repairReceiptsEnabled, verifyAcceptanceReceipt } from "./receipt";
import { cleanupLoginFailureState, clearLoginFailures, limitAuthenticatedRequest, limitUnauthenticatedIpRequest, limitUnauthenticatedRequest, loginTemporarilyBlocked, recordLoginFailure } from "./abuse";
import { logSecurityEvent } from "./security-events";
import { ObjectStoreChecksumMismatchError, objectStore, type ObjectStoreObject } from "./object-store";
import { authenticatePasskey, cleanupExpiredPasskeyChallenges, deletePasskey, listPasskeys, passkeyAuthenticationOptions, passkeyRegistrationOptions, registerPasskey } from "./passkeys";
export { RoomDurableObject } from "./room-do";

// The browser limit is 25 MiB of plaintext; AES-GCM appends a 16-byte tag.
const MAX_ATTACHMENT = MAX_ATTACHMENT_PLAINTEXT_BYTES + 16;
const MAX_SEGMENT = 12 * 1024 * 1024;
const ARCHIVE_V3_HEADER_BYTES = 40;
const ARCHIVE_KEY_ENVELOPE_MAX_BYTES = 1024 * 1024;
const COMPACTION_MAX_EVENTS = 500;
const COMPACTION_RECENT_TAIL = 32;
const COMPACTION_LEASE_MS = 5 * 60 * 1_000;
const COMPACTION_MIN_INPUT_BYTES = 1024 * 1024;
const COMPACTION_TARGET_INPUT_BYTES = 6 * 1024 * 1024;
const REPAIR_LEASE_MS = 5 * 60 * 1_000;
const REPAIR_MAX_RANGE = 500;
const REPAIR_MAX_UPLOAD_EVENTS = 20;
const ATTACHMENT_REPAIR_LEASE_MS = 5 * 60 * 1_000;
const ARCHIVE_REPAIR_LEASE_MS = 5 * 60 * 1_000;
const PROFILE_AVATAR_WRITE_INTENT_GRACE_MS = 60 * 60 * 1_000;
const PROFILE_AVATAR_DELETE_CLAIM_MS = 60 * 60 * 1_000;
const PROFILE_AVATAR_REPAIR_LEASE_MS = 60 * 60 * 1_000;
const BOT_TOKEN_MS = 365 * 24 * 60 * 60 * 1_000;
const BOT_RATE_WINDOW_MS = 60_000;
const BOT_DEFAULT_MESSAGES_PER_MINUTE = 60;
const DEVICE_LINK_PENDING_MS = 15 * 60 * 1_000;
const DEVICE_LINK_APPROVED_MS = 24 * 60 * 60 * 1_000;
const DEVICE_LINK_SESSION_MS = 30 * 24 * 60 * 60 * 1_000;
const DEVICE_SESSION_CHALLENGE_MS = 5 * 60 * 1_000;
const DEVICE_LINK_HISTORY_SHARD_MAX_BYTES = 34 * 1024 * 1024;
const DEVICE_LINK_HISTORY_MAX_SHARDS = 4096;
const ROOM_PEER_RECOVERY_MAX_EVENTS = 500;
const ROOM_PEER_RECOVERY_MAX_BYTES = 34 * 1024 * 1024;
const ROOM_PEER_RECOVERY_TTL_MS = 24 * 60 * 60 * 1_000;
const ROOM_PEER_RECOVERY_LEASE_MS = 10 * 60 * 1_000;
const MLS_KEY_PACKAGE_LOW_WATER = 8;
const MLS_KEY_PACKAGE_TARGET = 24;
const MLS_KEY_PACKAGE_ACTIVE_LIMIT = 64;
const ABANDONED_KEY_PACKAGE_TTL_MS = 24 * 60 * 60 * 1_000;
const CONSUMED_KEY_PACKAGE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_USER_OBJECT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_USER_OBJECT_LIMIT = 100_000;
const MAX_PROFILE_AVATAR_BYTES = 128 * 1024;
const ACCOUNT_APPEAL_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const RESOLVED_APPEAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const READINESS_WRITE_INTENT_SLO_MS = 30 * 60 * 1_000;
const READINESS_BACKGROUND_WORK_SLO_MS = 24 * 60 * 60 * 1_000;
const READINESS_APPEAL_SLO_MS = 7 * 24 * 60 * 60 * 1_000;
const UNCOMMITTED_ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const PENDING_R2_WRITE_TTL_MS = 15 * 60 * 1_000;
const visibleMessageEventTypes = new Set(["message.text", "message.file", "message.contact"]);

function validateArchiveV3Envelope(bytes: Uint8Array, totalBytes: number, startSeq: number, endSeq: number, uploaderDeviceId: string, activeDeviceIds: Set<string>): void {
  const invalid = () => { throw new HttpError(400, "Invalid archive segment v3 envelope", "invalid_segment_envelope"); };
  const exactBase64Url = (value: unknown, byteLength: number): value is string => {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
    const decoded = fromB64url(value);
    return decoded.length === byteLength && b64url(decoded) === value;
  };
  try {
    if (bytes.length < ARCHIVE_V3_HEADER_BYTES || bytes[0] !== 0x45 || bytes[1] !== 0x43 || bytes[2] !== 0x41 || bytes[3] !== 0x52 || bytes[4] !== 3 || bytes[5] !== 1) return invalid();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const envelopeOffset = view.getUint32(8); const envelopeLength = view.getUint32(12); const indexOffset = view.getUint32(16); const indexLength = view.getUint32(20);
    if (envelopeOffset !== ARCHIVE_V3_HEADER_BYTES || envelopeLength < 64 || envelopeLength > ARCHIVE_KEY_ENVELOPE_MAX_BYTES
      || indexOffset !== envelopeOffset + envelopeLength || indexLength < 32 || indexOffset + indexLength > totalBytes
      || view.getUint32(28) !== startSeq || view.getUint32(32) !== endSeq) return invalid();
    const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(envelopeOffset, indexOffset))) as Record<string, unknown>;
    const ephemeral = manifest.ephemeral_key as Partial<JsonWebKey> | undefined;
    const recipients = manifest.recipients;
    if (manifest.format !== "edgechat-archive-key" || manifest.version !== 1 || !exactBase64Url(manifest.salt, 16)
      || ephemeral?.kty !== "EC" || ephemeral.crv !== "P-256" || !exactBase64Url(ephemeral.x, 32) || !exactBase64Url(ephemeral.y, 32)
      || !Array.isArray(recipients) || recipients.length < 1 || recipients.length > 1_000) return invalid();
    const seen = new Set<string>();
    for (const value of recipients) {
      if (!value || typeof value !== "object") return invalid();
      const recipient = value as Record<string, unknown>;
      if (typeof recipient.device_id !== "string" || !activeDeviceIds.has(recipient.device_id) || seen.has(recipient.device_id)
        || !exactBase64Url(recipient.nonce, 12) || !exactBase64Url(recipient.ciphertext, 48)) return invalid();
      seen.add(recipient.device_id);
    }
    if (!seen.has(uploaderDeviceId)) return invalid();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    invalid();
  }
}

function requestContentSha256(request: Request, errorCode = "invalid_attachment_digest"): { bytes: Uint8Array<ArrayBuffer>; text: string } | null {
  const text = request.headers.get("x-content-sha256");
  if (text === null) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) throw new HttpError(400, "Invalid ciphertext SHA-256", errorCode);
  const bytes = fromB64url(text);
  if (bytes.byteLength !== 32 || b64url(bytes) !== text) throw new HttpError(400, "Invalid ciphertext SHA-256", errorCode);
  return { bytes, text };
}

async function archiveEnvelopePrefix(body: ReadableStream<Uint8Array>, totalBytes: number): Promise<{
  bytes: Uint8Array<ArrayBuffer>;
  body: ReadableStream<Uint8Array>;
}> {
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let received = 0;
  const readThrough = async (target: number) => {
    while (received < target) {
      const next = await reader.read();
      if (next.done) throw new HttpError(400, "Archive segment is truncated", "invalid_segment_length");
      chunks.push(next.value); received += next.value.byteLength;
    }
  };
  try {
    await readThrough(ARCHIVE_V3_HEADER_BYTES);
    const header = new Uint8Array(ARCHIVE_V3_HEADER_BYTES); let offset = 0;
    for (const chunk of chunks) {
      const length = Math.min(chunk.byteLength, header.byteLength - offset);
      header.set(chunk.subarray(0, length), offset); offset += length;
      if (offset === header.byteLength) break;
    }
    const view = new DataView(header.buffer);
    const envelopeOffset = view.getUint32(8); const envelopeLength = view.getUint32(12);
    const prefixLength = envelopeOffset + envelopeLength;
    if (header[0] !== 0x45 || header[1] !== 0x43 || header[2] !== 0x41 || header[3] !== 0x52 || header[4] !== 3 || header[5] !== 1
      || envelopeOffset !== ARCHIVE_V3_HEADER_BYTES || envelopeLength < 64 || envelopeLength > ARCHIVE_KEY_ENVELOPE_MAX_BYTES
      || prefixLength > totalBytes) throw new HttpError(400, "Invalid archive segment v3 envelope", "invalid_segment_envelope");
    await readThrough(prefixLength);
    const bytes = new Uint8Array(prefixLength); offset = 0;
    for (const chunk of chunks) {
      const length = Math.min(chunk.byteLength, bytes.byteLength - offset);
      bytes.set(chunk.subarray(0, length), offset); offset += length;
      if (offset === bytes.byteLength) break;
    }
    let replayIndex = 0;
    return {
      bytes,
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (replayIndex < chunks.length) {
            const chunk = chunks[replayIndex]!; chunks[replayIndex] = new Uint8Array(0); replayIndex += 1;
            controller.enqueue(chunk); return;
          }
          const next = await reader.read();
          if (next.done) controller.close(); else controller.enqueue(next.value);
        },
        cancel(reason) { return reader.cancel(reason); },
      }),
    };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

function exactLengthUploadStream(body: ReadableStream<Uint8Array>, expectedBytes: number): {
  body: ReadableStream<Uint8Array>;
  completed: Promise<void>;
} {
  const fixedLength = new FixedLengthStream(expectedBytes);
  return { body: fixedLength.readable, completed: body.pipeTo(fixedLength.writable) };
}

function isFixedLengthMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.includes("FixedLengthStream");
}

export function archiveCompactionEnabled(env: Pick<Env, "ARCHIVE_COMPACTION_ENABLED">): boolean {
  return env.ARCHIVE_COMPACTION_ENABLED === "true";
}

function protocolCapabilities(env: Env): ServerProtocolCapabilities {
  return {
    ...currentServerProtocol,
    features: currentServerProtocol.features.filter((feature) => feature !== "history.repair.v1" || repairReceiptsEnabled(env)),
    limits: { ...currentServerProtocol.limits },
  };
}

function sessionCapabilities(env: Env): { archive_compaction_enabled: boolean; protocol: ServerProtocolCapabilities } {
  return { archive_compaction_enabled: archiveCompactionEnabled(env), protocol: protocolCapabilities(env) };
}

function protocolResponseHeaders(): HeadersInit {
  return {
    "x-edgechat-server-protocol": String(PROTOCOL_VERSION),
    "x-edgechat-min-client-protocol": String(MIN_SUPPORTED_PROTOCOL_VERSION),
  };
}

function protocolHeader(request: Request, name: string, fallback: number): number {
  const raw = request.headers.get(name);
  if (raw === null) return fallback;
  if (!/^\d{1,6}$/.test(raw)) throw new HttpError(400, `Invalid ${name} header`, "invalid_protocol_version");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new HttpError(400, `Invalid ${name} header`, "invalid_protocol_version");
  return value;
}

function assertClientProtocol(request: Request): void {
  // Headerless requests are legacy v1. Browser WebSocket upgrades cannot set
  // custom headers, but their one-time ticket was minted by a checked request.
  if (new URL(request.url).pathname === "/api/v1/ws") return;
  const clientVersion = protocolHeader(request, "x-edgechat-client-protocol", 1);
  const minimumServerVersion = protocolHeader(request, "x-edgechat-min-server-protocol", 1);
  if (clientVersion < MIN_SUPPORTED_PROTOCOL_VERSION) {
    throw new HttpError(426, "This client must be updated before it can use this server", "client_upgrade_required");
  }
  if (minimumServerVersion > PROTOCOL_VERSION) {
    throw new HttpError(426, "This server must be updated before it can use this client", "server_upgrade_required");
  }
}

/** Classifies only structural SQLite failures that an unapplied D1 migration can cause. */
export function isDatabaseSchemaMismatch(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const message = current instanceof Error ? current.message : typeof current === "string" ? current : "";
    const databaseError = /(?:\bD1_ERROR\b|\bSQLITE_(?:ERROR|SCHEMA)\b)/iu.test(message);
    const missingStructure = /(?:\bno such (?:table|column)\b|\bhas no column named\b)/iu.test(message);
    if (databaseError && missingStructure) return true;
    current = current instanceof Error ? current.cause : null;
  }
  return false;
}

function requireArchiveCompaction(env: Env): void {
  if (!archiveCompactionEnabled(env)) {
    throw new HttpError(503, "Client archive compaction is disabled on this server", "archive_compaction_disabled");
  }
}

type StorageKind = "attachment" | "archive";
type TimingSafeSubtleCrypto = SubtleCrypto & {
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultStorageLimits(env: Env): { bytes: number; objects: number } {
  return {
    bytes: positiveInteger(env.USER_OBJECT_QUOTA_BYTES, DEFAULT_USER_OBJECT_QUOTA_BYTES),
    objects: positiveInteger(env.USER_OBJECT_LIMIT, DEFAULT_USER_OBJECT_LIMIT),
  };
}

async function storageLimits(env: Env, userId: string): Promise<{ bytes: number; objects: number; source: "default" | "override" }> {
  const override = await createDatabase(env.DB).selectFrom("user_storage_limits").select(["quota_bytes", "object_limit"])
    .where("user_id", "=", userId).executeTakeFirst();
  if (override) return { bytes: override.quota_bytes, objects: override.object_limit, source: "override" };
  return { ...defaultStorageLimits(env), source: "default" };
}

async function reserveStorage(env: Env, userId: string, bytes: number, kind: StorageKind): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new HttpError(413, "Storage quota exceeded", "storage_quota_exceeded");
  const db = createDatabase(env.DB);
  const defaults = defaultStorageLimits(env);
  const now = Date.now();
  await db.insertInto("user_storage_usage").values({ user_id: userId, attachment_bytes: 0, archive_bytes: 0, attachment_objects: 0, archive_objects: 0, updated_at: now })
    .onConflict((conflict) => conflict.column("user_id").doNothing()).execute();
  const result = await db.updateTable("user_storage_usage").set(kind === "attachment"
    ? { attachment_bytes: sql<number>`attachment_bytes + ${bytes}`, attachment_objects: sql<number>`attachment_objects + 1`, updated_at: now }
    : { archive_bytes: sql<number>`archive_bytes + ${bytes}`, archive_objects: sql<number>`archive_objects + 1`, updated_at: now })
    .where("user_id", "=", userId)
    .where(sql<boolean>`attachment_bytes + archive_bytes + COALESCE((SELECT avatar_bytes FROM users WHERE user_id = ${userId}), 0) + ${bytes} <= COALESCE((SELECT quota_bytes FROM user_storage_limits WHERE user_id = ${userId}), ${defaults.bytes})`)
    .where(sql<boolean>`attachment_objects + archive_objects + CASE WHEN COALESCE((SELECT avatar_bytes FROM users WHERE user_id = ${userId}), 0) > 0 THEN 1 ELSE 0 END + 1 <= COALESCE((SELECT object_limit FROM user_storage_limits WHERE user_id = ${userId}), ${defaults.objects})`)
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) throw new HttpError(413, "Storage quota or object limit exceeded", "storage_quota_exceeded");
}

async function releaseStorage(env: Env, userId: string, bytes: number, kind: StorageKind): Promise<void> {
  const db = createDatabase(env.DB);
  await db.updateTable("user_storage_usage").set(kind === "attachment"
    ? { attachment_bytes: sql<number>`max(0, attachment_bytes - ${bytes})`, attachment_objects: sql<number>`max(0, attachment_objects - 1)`, updated_at: Date.now() }
    : { archive_bytes: sql<number>`max(0, archive_bytes - ${bytes})`, archive_objects: sql<number>`max(0, archive_objects - 1)`, updated_at: Date.now() })
    .where("user_id", "=", userId).execute();
}

type PendingR2Write = {
  object_key: string;
  owner_user_id: string;
  kind: StorageKind;
  expected_bytes: number;
  room_id?: string | null;
  content_sha256?: string | null;
  cancelled_at?: number | null;
};

async function stageR2Write(env: Env, item: PendingR2Write): Promise<void> {
  await reserveStorage(env, item.owner_user_id, item.expected_bytes, item.kind);
  try {
    await createDatabase(env.DB).insertInto("pending_r2_writes").values({ ...item, created_at: Date.now(), attempts: 0, last_error: null }).execute();
  } catch (error) {
    await releaseStorage(env, item.owner_user_id, item.expected_bytes, item.kind);
    throw error;
  }
}

function pendingR2WriteMatches(existing: PendingR2Write, expected: PendingR2Write): boolean {
  return existing.object_key === expected.object_key
    && existing.owner_user_id === expected.owner_user_id
    && existing.kind === expected.kind
    && existing.expected_bytes === expected.expected_bytes
    && (existing.room_id ?? null) === (expected.room_id ?? null)
    && (existing.content_sha256 ?? null) === (expected.content_sha256 ?? null);
}

async function stageIdempotentR2Write(env: Env, item: PendingR2Write): Promise<boolean> {
  const cancelled = () => item.kind === "archive"
    ? new HttpError(409, "Archive upload was cancelled", "archive_upload_cancelled")
    : new HttpError(409, "Attachment upload was cancelled", "attachment_upload_cancelled");
  const conflict = () => item.kind === "archive"
    ? new HttpError(409, "Segment ID is already in use", "segment_conflict")
    : new HttpError(409, "Attachment ID is already in use", "attachment_id_conflict");
  const findExisting = () => createDatabase(env.DB).selectFrom("pending_r2_writes")
    .select(["object_key", "owner_user_id", "kind", "expected_bytes", "room_id", "content_sha256", "cancelled_at"])
    .where("object_key", "=", item.object_key).executeTakeFirst();
  const existing = await findExisting();
  if (existing) {
    if (existing.cancelled_at !== null) throw cancelled();
    if (!pendingR2WriteMatches(existing as PendingR2Write, item)) throw conflict();
    return false;
  }
  try {
    await stageR2Write(env, item);
    return true;
  } catch (error) {
    // Two identical retries may race between the initial lookup and the
    // reservation insert. stageR2Write has already released the losing quota
    // reservation, so only adopt the winner when every bound field matches.
    const raced = await findExisting();
    if (raced?.cancelled_at !== null && raced?.cancelled_at !== undefined) throw cancelled();
    if (raced && pendingR2WriteMatches(raced as PendingR2Write, item)) return false;
    throw error;
  }
}

async function finalizePendingR2Cleanup(env: Env, items: PendingR2Write[]): Promise<void> {
  if (!items.length) return;
  const db = createDatabase(env.DB);
  await batch(env.DB, items.flatMap((item) => [
    db.updateTable("user_storage_usage").set(item.kind === "attachment"
      ? { attachment_bytes: sql<number>`max(0, attachment_bytes - ${item.expected_bytes})`, attachment_objects: sql<number>`max(0, attachment_objects - 1)`, updated_at: Date.now() }
      : { archive_bytes: sql<number>`max(0, archive_bytes - ${item.expected_bytes})`, archive_objects: sql<number>`max(0, archive_objects - 1)`, updated_at: Date.now() })
      .where("user_id", "=", item.owner_user_id)
      .where(sql<boolean>`EXISTS (SELECT 1 FROM pending_r2_writes WHERE object_key = ${item.object_key})`),
    db.deleteFrom("pending_r2_writes").where("object_key", "=", item.object_key),
  ]));
}

async function abandonPendingR2Write(env: Env, item: PendingR2Write): Promise<boolean> {
  try {
    await objectStore(env).delete(item.object_key);
    await finalizePendingR2Cleanup(env, [item]);
    return true;
  } catch (error) {
    const message = (error instanceof Error ? error.message : "R2 cleanup failed").slice(0, 500);
    await createDatabase(env.DB).updateTable("pending_r2_writes")
      .set({ attempts: sql<number>`attempts + 1`, last_error: message }).where("object_key", "=", item.object_key).execute();
    return false;
  }
}

export async function processPendingR2Writes(env: Env, cutoff = Date.now() - PENDING_R2_WRITE_TTL_MS): Promise<number> {
  const db = createDatabase(env.DB);
  let cleaned = 0;
  for (let page = 0; page < 10; page += 1) {
    const pending = await db.selectFrom("pending_r2_writes")
      .select(["object_key", "owner_user_id", "kind", "expected_bytes"])
      .where("created_at", "<", cutoff).orderBy("created_at").limit(50).execute();
    if (!pending.length) break;
    try {
      await objectStore(env).delete(pending.map((item) => item.object_key));
    } catch (error) {
      const message = (error instanceof Error ? error.message : "R2 cleanup failed").slice(0, 500);
      await batch(env.DB, pending.map((item) => db.updateTable("pending_r2_writes")
        .set({ attempts: sql<number>`attempts + 1`, last_error: message }).where("object_key", "=", item.object_key)));
      break;
    }
    await finalizePendingR2Cleanup(env, pending);
    cleaned += pending.length;
  }
  return cleaned;
}

async function storageUsage(env: Env, auth: AuthContext): Promise<Response> {
  requireUser(auth);
  const usage = await createDatabase(env.DB).selectFrom("user_storage_usage")
    .select(["attachment_bytes", "archive_bytes", "attachment_objects", "archive_objects", "updated_at"])
    .where("user_id", "=", auth.userId).executeTakeFirst();
  const [limits, avatar] = await Promise.all([
    storageLimits(env, auth.userId),
    createDatabase(env.DB).selectFrom("users").select("avatar_bytes").where("user_id", "=", auth.userId).executeTakeFirstOrThrow(),
  ]);
  const value = usage ?? { attachment_bytes: 0, archive_bytes: 0, attachment_objects: 0, archive_objects: 0, updated_at: Date.now() };
  const avatarBytes = Number(avatar.avatar_bytes); const avatarObjects = avatarBytes > 0 ? 1 : 0;
  const usedBytes = value.attachment_bytes + value.archive_bytes + avatarBytes;
  const usedObjects = value.attachment_objects + value.archive_objects + avatarObjects;
  return json({ ...value, avatar_bytes: avatarBytes, avatar_objects: avatarObjects, used_bytes: usedBytes, quota_bytes: limits.bytes, remaining_bytes: Math.max(0, limits.bytes - usedBytes), used_objects: usedObjects, object_limit: limits.objects, remaining_objects: Math.max(0, limits.objects - usedObjects), quota_source: limits.source });
}

async function requireOperator(request: Request, env: Env): Promise<void> {
  const configured = env.OPERATOR_TOKEN;
  if (!configured || configured.length < 32) throw new HttpError(503, "Operator API is not configured", "operator_unavailable");
  const header = request.headers.get("authorization");
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const encoder = new TextEncoder();
  const [configuredHash, providedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(configured)),
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
  ]);
  if (!(crypto.subtle as TimingSafeSubtleCrypto).timingSafeEqual(configuredHash, providedHash)) {
    logSecurityEvent("warn", "security.operator_auth_failed");
    throw new HttpError(401, "Operator authentication required", "operator_unauthorized", { "www-authenticate": "Bearer" });
  }
}

function requiredPositiveSafeInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new HttpError(400, `Invalid ${key}`, "invalid_input");
  return value as number;
}

async function operatorSetStorageLimit(request: Request, env: Env, userId: UserId, remove: boolean): Promise<Response> {
  assertLocalId(userId, "@", env);
  const db = createDatabase(env.DB);
  const user = await db.selectFrom("users").select("user_id").where("user_id", "=", userId).executeTakeFirst();
  if (!user) throw new HttpError(404, "User not found", "user_not_found");
  if (remove) {
    await db.deleteFrom("user_storage_limits").where("user_id", "=", userId).execute();
  } else {
    const body = await readJson(request, 1_024);
    const quotaBytes = requiredPositiveSafeInteger(body, "quota_bytes");
    const objectLimit = requiredPositiveSafeInteger(body, "object_limit");
    const updatedAt = Date.now();
    await db.insertInto("user_storage_limits").values({ user_id: userId, quota_bytes: quotaBytes, object_limit: objectLimit, updated_at: updatedAt })
      .onConflict((conflict) => conflict.column("user_id").doUpdateSet({ quota_bytes: quotaBytes, object_limit: objectLimit, updated_at: updatedAt })).execute();
  }
  const limits = await storageLimits(env, userId);
  return json({ user_id: userId, quota_bytes: limits.bytes, object_limit: limits.objects, quota_source: limits.source });
}

async function operatorStorage(url: URL, env: Env): Promise<Response> {
  const db = createDatabase(env.DB);
  const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) throw new HttpError(400, "Invalid limit", "invalid_input");
  const cursor = url.searchParams.get("cursor");
  if (cursor && cursor.length > 128) throw new HttpError(400, "Invalid cursor", "invalid_input");
  let usersQuery = db.selectFrom("users as u")
    .leftJoin("user_storage_usage as s", "s.user_id", "u.user_id")
    .leftJoin("user_storage_limits as l", "l.user_id", "u.user_id")
    .select(["u.user_id", "u.display_name", "u.avatar_bytes", "s.attachment_bytes", "s.archive_bytes", "s.attachment_objects", "s.archive_objects", "s.updated_at", "l.quota_bytes", "l.object_limit"])
    .orderBy("u.user_id").limit(requestedLimit + 1);
  if (cursor) usersQuery = usersQuery.where("u.user_id", ">", cursor);
  const [rows, usage, avatars, userCount, pendingWrites, pendingDeletes, pendingAvatarDeletes] = await Promise.all([
    usersQuery.execute(),
    db.selectFrom("user_storage_usage").select(({ fn }) => [
      fn.sum<number>("attachment_bytes").as("attachment_bytes"), fn.sum<number>("archive_bytes").as("archive_bytes"),
      fn.sum<number>("attachment_objects").as("attachment_objects"), fn.sum<number>("archive_objects").as("archive_objects"),
    ]).executeTakeFirst(),
    db.selectFrom("users").select(({ fn }) => [fn.sum<number>("avatar_bytes").as("bytes"), sql<number>`sum(case when avatar_bytes > 0 then 1 else 0 end)`.as("objects")]).executeTakeFirst(),
    db.selectFrom("users").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("pending_r2_writes").select(({ fn }) => [fn.sum<number>("expected_bytes").as("bytes"), fn.countAll<number>().as("objects")]).executeTakeFirst(),
    db.selectFrom("attachment_deletions").select(({ fn }) => [fn.sum<number>("ciphertext_bytes").as("bytes"), fn.countAll<number>().as("objects")]).executeTakeFirst(),
    db.selectFrom("profile_avatar_deletions").select(({ fn }) => [fn.sum<number>("byte_size").as("bytes"), fn.countAll<number>().as("objects")]).executeTakeFirst(),
  ]);
  const hasMore = rows.length > requestedLimit;
  const page = hasMore ? rows.slice(0, requestedLimit) : rows;
  const defaults = defaultStorageLimits(env);
  const users = page.map((row) => {
    const attachmentBytes = Number(row.attachment_bytes ?? 0); const archiveBytes = Number(row.archive_bytes ?? 0); const avatarBytes = Number(row.avatar_bytes ?? 0);
    const attachmentObjects = Number(row.attachment_objects ?? 0); const archiveObjects = Number(row.archive_objects ?? 0);
    const avatarObjects = avatarBytes > 0 ? 1 : 0;
    return {
      user_id: row.user_id, display_name: row.display_name,
      attachment_bytes: attachmentBytes, archive_bytes: archiveBytes, avatar_bytes: avatarBytes, used_bytes: attachmentBytes + archiveBytes + avatarBytes,
      attachment_objects: attachmentObjects, archive_objects: archiveObjects, avatar_objects: avatarObjects, used_objects: attachmentObjects + archiveObjects + avatarObjects,
      quota_bytes: row.quota_bytes ?? defaults.bytes, object_limit: row.object_limit ?? defaults.objects,
      quota_source: row.quota_bytes === null ? "default" : "override", updated_at: row.updated_at,
    };
  });
  const attachmentBytes = Number(usage?.attachment_bytes ?? 0); const archiveBytes = Number(usage?.archive_bytes ?? 0);
  const attachmentObjects = Number(usage?.attachment_objects ?? 0); const archiveObjects = Number(usage?.archive_objects ?? 0);
  const avatarBytes = Number(avatars?.bytes ?? 0); const avatarObjects = Number(avatars?.objects ?? 0);
  return json({
    defaults: { quota_bytes: defaults.bytes, object_limit: defaults.objects },
    totals: {
      users: Number(userCount.count), attachment_bytes: attachmentBytes, archive_bytes: archiveBytes, avatar_bytes: avatarBytes, used_bytes: attachmentBytes + archiveBytes + avatarBytes,
      attachment_objects: attachmentObjects, archive_objects: archiveObjects, avatar_objects: avatarObjects, used_objects: attachmentObjects + archiveObjects + avatarObjects,
      pending_write_bytes: Number(pendingWrites?.bytes ?? 0), pending_write_objects: Number(pendingWrites?.objects ?? 0),
      pending_delete_bytes: Number(pendingDeletes?.bytes ?? 0) + Number(pendingAvatarDeletes?.bytes ?? 0), pending_delete_objects: Number(pendingDeletes?.objects ?? 0) + Number(pendingAvatarDeletes?.objects ?? 0),
    },
    users, next_cursor: hasMore ? page.at(-1)?.user_id ?? null : null,
  });
}

type ReadinessRow = {
  active_users: number; active_devices: number; rooms: number; sync_cursor_high_water: number;
  ledger_bytes: number; ledger_objects: number;
  pending_writes: number; pending_writes_oldest_at: number | null;
  pending_object_deletions: number; pending_object_deletions_oldest_at: number | null;
  repair_jobs: number; repair_jobs_oldest_at: number | null;
  account_deletions: number; account_deletions_oldest_at: number | null;
  device_revocations: number; device_revocations_oldest_at: number | null;
  peer_recoveries: number; peer_recoveries_oldest_at: number | null;
  pending_appeals: number; pending_appeals_oldest_at: number | null;
};

function age(now: number, timestamp: number | null): number | null {
  return timestamp === null ? null : Math.max(0, now - Number(timestamp));
}

async function operatorReadiness(env: Env): Promise<Response> {
  // Construction validates provider selection and required bindings/secrets but
  // performs no object-store request, preserving the D1-only readiness budget.
  objectStore(env);
  const db = createDatabase(env.DB); const now = Date.now();
  const result = await sql<ReadinessRow>`SELECT
    (SELECT count(*) FROM users WHERE deleted_at IS NULL) AS active_users,
    (SELECT count(*) FROM devices WHERE revoked_at IS NULL) AS active_devices,
    (SELECT count(*) FROM rooms) AS rooms,
    COALESCE((SELECT max(cursor) FROM sync_log), 0) AS sync_cursor_high_water,
    COALESCE((SELECT sum(attachment_bytes + archive_bytes) FROM user_storage_usage), 0)
      + COALESCE((SELECT sum(avatar_bytes) FROM users), 0) AS ledger_bytes,
    COALESCE((SELECT sum(attachment_objects + archive_objects) FROM user_storage_usage), 0)
      + COALESCE((SELECT sum(CASE WHEN avatar_bytes > 0 THEN 1 ELSE 0 END) FROM users), 0) AS ledger_objects,
    (SELECT count(*) FROM pending_r2_writes) AS pending_writes,
    (SELECT min(created_at) FROM pending_r2_writes) AS pending_writes_oldest_at,
    (SELECT count(*) FROM attachment_deletions) + (SELECT count(*) FROM retention_object_deletions)
      + (SELECT count(*) FROM profile_avatar_deletions) AS pending_object_deletions,
    (SELECT min(requested_at) FROM (
      SELECT requested_at FROM attachment_deletions UNION ALL
      SELECT requested_at FROM retention_object_deletions UNION ALL
      SELECT requested_at FROM profile_avatar_deletions
    )) AS pending_object_deletions_oldest_at,
    (SELECT count(*) FROM history_repair_jobs) + (SELECT count(*) FROM attachment_repair_jobs)
      + (SELECT count(*) FROM archive_segment_repair_jobs) + (SELECT count(*) FROM profile_avatar_repair_jobs) AS repair_jobs,
    (SELECT min(detected_at) FROM (
      SELECT detected_at FROM history_repair_jobs UNION ALL
      SELECT detected_at FROM attachment_repair_jobs UNION ALL
      SELECT detected_at FROM archive_segment_repair_jobs UNION ALL
      SELECT detected_at FROM profile_avatar_repair_jobs
    )) AS repair_jobs_oldest_at,
    (SELECT count(*) FROM account_deletions WHERE status != 'complete') AS account_deletions,
    (SELECT min(updated_at) FROM account_deletions WHERE status != 'complete') AS account_deletions_oldest_at,
    (SELECT count(*) FROM device_revocations WHERE status != 'complete') AS device_revocations,
    (SELECT min(updated_at) FROM device_revocations WHERE status != 'complete') AS device_revocations_oldest_at,
    (SELECT count(*) FROM room_peer_recoveries WHERE status NOT IN ('complete', 'cancelled')) AS peer_recoveries,
    (SELECT min(updated_at) FROM room_peer_recoveries WHERE status NOT IN ('complete', 'cancelled')) AS peer_recoveries_oldest_at,
    (SELECT count(*) FROM account_appeals WHERE status = 'pending') AS pending_appeals,
    (SELECT min(created_at) FROM account_appeals WHERE status = 'pending') AS pending_appeals_oldest_at`.execute(db);
  const row = result.rows[0];
  if (!row) throw new HttpError(503, "Readiness query returned no row", "readiness_unavailable");
  const ages = {
    pending_writes: age(now, row.pending_writes_oldest_at),
    pending_object_deletions: age(now, row.pending_object_deletions_oldest_at),
    repair_jobs: age(now, row.repair_jobs_oldest_at),
    account_deletions: age(now, row.account_deletions_oldest_at),
    device_revocations: age(now, row.device_revocations_oldest_at),
    peer_recoveries: age(now, row.peer_recoveries_oldest_at),
    pending_appeals: age(now, row.pending_appeals_oldest_at),
  };
  const degraded_reasons: string[] = [];
  if (ages.pending_writes !== null && ages.pending_writes > READINESS_WRITE_INTENT_SLO_MS) degraded_reasons.push("stale_r2_write_intents");
  for (const key of ["pending_object_deletions", "repair_jobs", "account_deletions", "device_revocations", "peer_recoveries"] as const) {
    if (ages[key] !== null && ages[key] > READINESS_BACKGROUND_WORK_SLO_MS) degraded_reasons.push(`stale_${key}`);
  }
  if (ages.pending_appeals !== null && ages.pending_appeals > READINESS_APPEAL_SLO_MS) degraded_reasons.push("stale_pending_appeals");
  return json({
    status: degraded_reasons.length ? "degraded" : "healthy", generated_at: now, degraded_reasons,
    inventory: {
      active_users: Number(row.active_users), active_devices: Number(row.active_devices), rooms: Number(row.rooms), sync_cursor_high_water: Number(row.sync_cursor_high_water),
      ledger_bytes: Number(row.ledger_bytes), ledger_objects: Number(row.ledger_objects),
    },
    queues: {
      pending_writes: { count: Number(row.pending_writes), oldest_age_ms: ages.pending_writes },
      pending_object_deletions: { count: Number(row.pending_object_deletions), oldest_age_ms: ages.pending_object_deletions },
      repair_jobs: { count: Number(row.repair_jobs), oldest_age_ms: ages.repair_jobs },
      account_deletions: { count: Number(row.account_deletions), oldest_age_ms: ages.account_deletions },
      device_revocations: { count: Number(row.device_revocations), oldest_age_ms: ages.device_revocations },
      peer_recoveries: { count: Number(row.peer_recoveries), oldest_age_ms: ages.peer_recoveries },
      pending_appeals: { count: Number(row.pending_appeals), oldest_age_ms: ages.pending_appeals },
    },
    slo_ms: { write_intent: READINESS_WRITE_INTENT_SLO_MS, background_work: READINESS_BACKGROUND_WORK_SLO_MS, pending_appeal: READINESS_APPEAL_SLO_MS },
    object_store: { provider: env.OBJECT_STORE_PROVIDER ?? "r2", probed: false },
    storage_source: "d1_ledger",
  });
}

async function operatorRooms(url: URL, env: Env): Promise<Response> {
  const db = createDatabase(env.DB);
  const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) throw new HttpError(400, "Invalid limit", "invalid_input");
  const cursor = url.searchParams.get("cursor");
  if (cursor && (cursor.length > 255 || !isNamespacedRoomId(cursor))) throw new HttpError(400, "Invalid cursor", "invalid_input");
  const policy = url.searchParams.get("policy") ?? "all";
  if (policy !== "all" && policy !== "finite" && policy !== "indefinite") throw new HttpError(400, "Invalid policy", "invalid_input");

  let roomsQuery = db.selectFrom("rooms").select([
    "room_id", "kind", "purpose", "name", "current_seq", "retention_days", "retention_floor_seq",
    "retention_generation", "retention_gc_at", "retention_min_device_copies", "created_at",
  ]).orderBy("room_id").limit(requestedLimit + 1);
  if (cursor) roomsQuery = roomsQuery.where("room_id", ">", cursor);
  if (policy === "finite") roomsQuery = roomsQuery.where("retention_days", "is not", null);
  if (policy === "indefinite") roomsQuery = roomsQuery.where("retention_days", "is", null);

  const [rows, totals, archives, pendingDeletes] = await Promise.all([
    roomsQuery.execute(),
    db.selectFrom("rooms").select(({ fn }) => [
      fn.countAll<number>().as("rooms"),
      sql<number>`sum(case when retention_days is null then 1 else 0 end)`.as("indefinite_rooms"),
      sql<number>`sum(case when retention_days is not null then 1 else 0 end)`.as("finite_rooms"),
    ]).executeTakeFirstOrThrow(),
    db.selectFrom("archive_segments").select(({ fn }) => [fn.countAll<number>().as("objects"), fn.sum<number>("byte_size").as("bytes")]).executeTakeFirst(),
    db.selectFrom("retention_object_deletions").select(({ fn }) => [fn.countAll<number>().as("objects"), fn.sum<number>("ciphertext_bytes").as("bytes")]).executeTakeFirst(),
  ]);
  const hasMore = rows.length > requestedLimit;
  const page = hasMore ? rows.slice(0, requestedLimit) : rows;
  const roomIds = page.map((room) => room.room_id);
  const [members, devices, acknowledgements, roomArchives] = roomIds.length ? await Promise.all([
    db.selectFrom("room_members").select(({ fn }) => ["room_id", fn.countAll<number>().as("count")])
      .where("room_id", "in", roomIds).where("removed_at", "is", null).groupBy("room_id").execute(),
    db.selectFrom("room_devices as rd").innerJoin("devices as d", "d.device_id", "rd.device_id")
      .innerJoin("room_members as rm", (join) => join.onRef("rm.room_id", "=", "rd.room_id").onRef("rm.user_id", "=", "rd.user_id"))
      .select(({ fn }) => ["rd.room_id", fn.countAll<number>().as("count")]).where("rd.room_id", "in", roomIds)
      .where("rd.removed_at", "is", null).where("d.revoked_at", "is", null).where("rm.removed_at", "is", null).groupBy("rd.room_id").execute(),
    db.selectFrom("room_retention_acks as ack").innerJoin("rooms as r", (join) => join.onRef("r.room_id", "=", "ack.room_id").onRef("r.retention_generation", "=", "ack.generation"))
      .innerJoin("room_devices as rd", (join) => join.onRef("rd.room_id", "=", "ack.room_id").onRef("rd.device_id", "=", "ack.device_id"))
      .innerJoin("devices as d", "d.device_id", "ack.device_id")
      .innerJoin("room_members as rm", (join) => join.onRef("rm.room_id", "=", "ack.room_id").onRef("rm.user_id", "=", "rd.user_id"))
      .select(({ fn }) => ["ack.room_id", fn.countAll<number>().as("devices"), fn.max<number>("ack.through_seq").as("highest_seq")])
      .where("ack.room_id", "in", roomIds).where("rd.removed_at", "is", null).where("d.revoked_at", "is", null)
      .where("rm.removed_at", "is", null).groupBy("ack.room_id").execute(),
    db.selectFrom("archive_segments").select(({ fn }) => ["room_id", fn.countAll<number>().as("objects"), fn.sum<number>("byte_size").as("bytes")])
      .where("room_id", "in", roomIds).groupBy("room_id").execute(),
  ]) : [[], [], [], []];
  const keyed = <T extends { room_id: string }>(values: T[]) => new Map(values.map((value) => [value.room_id, value]));
  const memberMap = keyed(members); const deviceMap = keyed(devices); const acknowledgementMap = keyed(acknowledgements); const archiveMap = keyed(roomArchives);
  return json({
    totals: {
      rooms: Number(totals.rooms), finite_rooms: Number(totals.finite_rooms ?? 0), indefinite_rooms: Number(totals.indefinite_rooms ?? 0),
      archive_bytes: Number(archives?.bytes ?? 0), archive_objects: Number(archives?.objects ?? 0),
      pending_delete_bytes: Number(pendingDeletes?.bytes ?? 0), pending_delete_objects: Number(pendingDeletes?.objects ?? 0),
    },
    rooms: page.map((room) => ({
      ...room,
      active_members: Number(memberMap.get(room.room_id)?.count ?? 0),
      active_devices: Number(deviceMap.get(room.room_id)?.count ?? 0),
      acknowledged_devices: Number(acknowledgementMap.get(room.room_id)?.devices ?? 0),
      highest_acknowledged_seq: Number(acknowledgementMap.get(room.room_id)?.highest_seq ?? room.retention_floor_seq),
      archive_bytes: Number(archiveMap.get(room.room_id)?.bytes ?? 0),
      archive_objects: Number(archiveMap.get(room.room_id)?.objects ?? 0),
    })),
    next_cursor: hasMore ? page.at(-1)?.room_id ?? null : null,
  });
}

async function operatorReports(url: URL, env: Env): Promise<Response> {
  const db = createDatabase(env.DB);
  const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) throw new HttpError(400, "Invalid limit", "invalid_input");
  const cursor = url.searchParams.get("cursor");
  if (cursor && (cursor.length > 64 || !/^[A-Za-z0-9_-]+$/.test(cursor))) throw new HttpError(400, "Invalid cursor", "invalid_input");
  const status = url.searchParams.get("status") ?? "open";
  if (status !== "all" && status !== "open" && status !== "confirmed" && status !== "dismissed") throw new HttpError(400, "Invalid report status", "invalid_input");
  let query = db.selectFrom("room_reports").select([
    "report_id", "room_id", "reporter_user_id", "reported_user_id", "category", "event_id", "status", "resolution_note", "created_at", "reviewed_at",
  ]).orderBy("report_id").limit(requestedLimit + 1);
  if (cursor) query = query.where("report_id", ">", cursor);
  if (status !== "all") query = query.where("status", "=", status);
  const [rows, totals] = await Promise.all([
    query.execute(),
    db.selectFrom("room_reports").select([
      sql<number>`count(*)`.as("total"),
      sql<number>`sum(case when status = 'open' then 1 else 0 end)`.as("open"),
      sql<number>`sum(case when status = 'confirmed' then 1 else 0 end)`.as("confirmed"),
      sql<number>`sum(case when status = 'dismissed' then 1 else 0 end)`.as("dismissed"),
    ]).executeTakeFirstOrThrow(),
  ]);
  const hasMore = rows.length > requestedLimit; const page = hasMore ? rows.slice(0, requestedLimit) : rows;
  return json({
    totals: { total: Number(totals.total), open: Number(totals.open ?? 0), confirmed: Number(totals.confirmed ?? 0), dismissed: Number(totals.dismissed ?? 0) },
    reports: page, next_cursor: hasMore ? page.at(-1)?.report_id ?? null : null,
  });
}

async function operatorAppeals(url: URL, env: Env): Promise<Response> {
  const db = createDatabase(env.DB);
  const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) throw new HttpError(400, "Invalid limit", "invalid_input");
  const cursor = url.searchParams.get("cursor");
  if (cursor && (cursor.length > 64 || !/^[A-Za-z0-9_-]+$/.test(cursor))) throw new HttpError(400, "Invalid cursor", "invalid_input");
  const status = url.searchParams.get("status") ?? "pending";
  if (status !== "all" && status !== "pending" && status !== "approved" && status !== "denied") throw new HttpError(400, "Invalid appeal status", "invalid_input");
  let query = db.selectFrom("account_appeals").select([
    "appeal_id", "user_id", "category", "status", "created_at", "updated_at", "expires_at", "resolved_at",
  ]).orderBy("appeal_id").limit(requestedLimit + 1);
  if (cursor) query = query.where("appeal_id", ">", cursor);
  if (status !== "all") query = query.where("status", "=", status);
  const [rows, totals] = await Promise.all([
    query.execute(),
    db.selectFrom("account_appeals").select([
      sql<number>`count(*)`.as("total"),
      sql<number>`sum(case when status = 'pending' then 1 else 0 end)`.as("pending"),
      sql<number>`sum(case when status = 'approved' then 1 else 0 end)`.as("approved"),
      sql<number>`sum(case when status = 'denied' then 1 else 0 end)`.as("denied"),
    ]).executeTakeFirstOrThrow(),
  ]);
  const hasMore = rows.length > requestedLimit; const page = hasMore ? rows.slice(0, requestedLimit) : rows;
  return json({
    totals: { total: Number(totals.total), pending: Number(totals.pending ?? 0), approved: Number(totals.approved ?? 0), denied: Number(totals.denied ?? 0) },
    appeals: page, next_cursor: hasMore ? page.at(-1)?.appeal_id ?? null : null,
  });
}

async function operatorResolveAppeal(request: Request, env: Env, appealId: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(appealId)) throw new HttpError(400, "Invalid appeal ID", "invalid_input");
  const body = await readJson(request, 2_048); const resolution = body.resolution;
  if (resolution !== "approved" && resolution !== "denied") throw new HttpError(400, "Invalid appeal resolution", "invalid_input");
  const unlockLogin = body.unlock_login === true;
  if (body.unlock_login !== undefined && typeof body.unlock_login !== "boolean") throw new HttpError(400, "unlock_login must be boolean", "invalid_input");
  const note = body.note === undefined || body.note === null ? null : stringField(body, "note", 500).trim() || null;
  const db = createDatabase(env.DB);
  const appeal = await db.selectFrom("account_appeals").select(["appeal_id", "user_id", "category", "status"])
    .where("appeal_id", "=", appealId).executeTakeFirst();
  if (!appeal) throw new HttpError(404, "Appeal not found", "not_found");
  if (appeal.status !== "pending") throw new HttpError(409, "Appeal has already been resolved", "appeal_resolved");
  if (unlockLogin && (resolution !== "approved" || appeal.category !== "login_locked")) {
    throw new HttpError(400, "Login unlock is valid only for approved login-lock appeals", "invalid_input");
  }
  const now = Date.now(); const actionId = randomId(18);
  await batch(env.DB, [
    db.updateTable("account_appeals").set({ status: resolution, updated_at: now, resolved_at: now })
      .where("appeal_id", "=", appealId).where("status", "=", "pending"),
    db.insertInto("operator_appeal_actions").values({ action_id: actionId, appeal_id: appealId, resolution, login_unlocked: unlockLogin ? 1 : 0, note, created_at: now }),
    ...(unlockLogin ? [db.deleteFrom("login_failure_state").where("user_id", "=", appeal.user_id)] : []),
  ]);
  logSecurityEvent("info", "security.account_appeal_resolved", { resolution, login_unlocked: unlockLogin });
  const updated = await db.selectFrom("account_appeals").select([
    "appeal_id", "user_id", "category", "status", "created_at", "updated_at", "expires_at", "resolved_at",
  ]).where("appeal_id", "=", appealId).executeTakeFirstOrThrow();
  return json({ appeal: updated, action: { action_id: actionId, resolution, login_unlocked: unlockLogin, note, created_at: now } });
}

async function operatorLoginLocks(url: URL, env: Env): Promise<Response> {
  const db = createDatabase(env.DB);
  const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) throw new HttpError(400, "Invalid limit", "invalid_input");
  const cursor = url.searchParams.get("cursor");
  if (cursor && (cursor.length > 255 || !isNamespacedUserId(cursor))) throw new HttpError(400, "Invalid cursor", "invalid_input");
  const status = url.searchParams.get("status") ?? "active";
  if (status !== "active" && status !== "all") throw new HttpError(400, "Invalid login lock status", "invalid_input");
  const now = Date.now();
  let query = db.selectFrom("login_failure_state as state").innerJoin("users as user", "user.user_id", "state.user_id")
    .select(["state.user_id", "user.display_name", "state.window_started_at", "state.failure_count", "state.blocked_until", "state.updated_at"])
    .orderBy("state.user_id").limit(requestedLimit + 1);
  if (cursor) query = query.where("state.user_id", ">", cursor);
  if (status === "active") query = query.where("state.blocked_until", ">", now);
  const [rows, totals] = await Promise.all([
    query.execute(),
    db.selectFrom("login_failure_state").select([
      sql<number>`count(*)`.as("total"),
      sql<number>`sum(case when blocked_until > ${now} then 1 else 0 end)`.as("active"),
    ]).executeTakeFirstOrThrow(),
  ]);
  const hasMore = rows.length > requestedLimit; const page = hasMore ? rows.slice(0, requestedLimit) : rows;
  return json({
    totals: { total: Number(totals.total), active: Number(totals.active ?? 0) },
    locks: page.map((row) => ({ ...row, active: row.blocked_until !== null && Number(row.blocked_until) > now })),
    next_cursor: hasMore ? page.at(-1)?.user_id ?? null : null,
  });
}

async function operatorUnlockLogin(request: Request, env: Env, userId: UserId): Promise<Response> {
  assertLocalId(userId, "@", env);
  const body = await readJson(request, 2_048);
  const note = body.note === undefined || body.note === null ? null : stringField(body, "note", 500).trim() || null;
  const db = createDatabase(env.DB);
  const user = await db.selectFrom("users").select("user_id").where("user_id", "=", userId).executeTakeFirst();
  if (!user) throw new HttpError(404, "User not found", "user_not_found");
  const previous = await db.selectFrom("login_failure_state").select(["failure_count", "blocked_until"]).where("user_id", "=", userId).executeTakeFirst();
  if (!previous) return json({ user_id: userId, unlocked: false, action: null });
  const actionId = randomId(18); const createdAt = Date.now();
  await batch(env.DB, [
    db.deleteFrom("login_failure_state").where("user_id", "=", userId),
    db.insertInto("operator_login_unlock_actions").values({
      action_id: actionId, user_id: userId, previous_failure_count: Number(previous.failure_count),
      previous_blocked_until: previous.blocked_until === null ? null : Number(previous.blocked_until), note, created_at: createdAt,
    }),
  ]);
  return json({
    user_id: userId, unlocked: true,
    action: { action_id: actionId, previous_failure_count: Number(previous.failure_count), previous_blocked_until: previous.blocked_until, note, created_at: createdAt },
  });
}

async function operatorResolveReport(request: Request, env: Env, reportId: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(reportId)) throw new HttpError(400, "Invalid report ID", "invalid_input");
  const body = await readJson(request, 2_048); const resolution = body.resolution;
  if (resolution !== "confirmed" && resolution !== "dismissed") throw new HttpError(400, "Invalid report resolution", "invalid_input");
  const note = body.note === undefined || body.note === null ? null : stringField(body, "note", 500).trim() || null;
  const db = createDatabase(env.DB);
  const report = await db.selectFrom("room_reports").select("report_id").where("report_id", "=", reportId).executeTakeFirst();
  if (!report) throw new HttpError(404, "Report not found", "not_found");
  const now = Date.now(); const actionId = randomId(18);
  await batch(env.DB, [
    db.updateTable("room_reports").set({ status: resolution, resolution_note: note, reviewed_at: now }).where("report_id", "=", reportId),
    db.insertInto("operator_report_actions").values({ action_id: actionId, report_id: reportId, resolution, note, created_at: now }),
  ]);
  const updated = await db.selectFrom("room_reports").select([
    "report_id", "room_id", "reporter_user_id", "reported_user_id", "category", "event_id", "status", "resolution_note", "created_at", "reviewed_at",
  ]).where("report_id", "=", reportId).executeTakeFirstOrThrow();
  return json({ report: updated, action: { action_id: actionId, resolution, note, created_at: now } });
}

async function operatorRoomRetention(request: Request, env: Env, roomId: RoomId): Promise<Response> {
  const db = createDatabase(env.DB);
  const room = await db.selectFrom("rooms").select(["room_id", "retention_days", "retention_floor_seq", "retention_generation", "retention_min_device_copies"])
    .where("room_id", "=", roomId).executeTakeFirst();
  if (!room) throw new HttpError(404, "Room not found", "not_found");
  if (request.method === "PUT") {
    const body = await readJson(request, 1_024);
    const days = body.retention_days;
    const minimumCopies = body.minimum_device_copies ?? room.retention_min_device_copies;
    if (days !== null && (!Number.isSafeInteger(days) || Number(days) < 1 || Number(days) > 36_500)) {
      throw new HttpError(400, "retention_days must be null or an integer from 1 to 36500", "invalid_retention_policy");
    }
    if (!Number.isSafeInteger(minimumCopies) || Number(minimumCopies) < 1 || Number(minimumCopies) > 10) {
      throw new HttpError(400, "minimum_device_copies must be an integer from 1 to 10", "invalid_retention_policy");
    }
    await batch(env.DB, [
      db.updateTable("rooms").set({ retention_days: days as number | null, retention_min_device_copies: Number(minimumCopies), retention_gc_at: null })
        .where("room_id", "=", roomId),
      db.updateTable("attachment_retention_requirements").set({ minimum_copies: Number(minimumCopies) }).where("room_id", "=", roomId),
    ]);
  }
  const updated = await db.selectFrom("rooms").select(["room_id", "retention_days", "retention_floor_seq", "retention_generation", "retention_gc_at", "retention_min_device_copies"])
    .where("room_id", "=", roomId).executeTakeFirstOrThrow();
  return json(updated);
}

function mlsKeyPackages(body: Record<string, unknown>): string[] {
  const packages = body.mls_key_packages;
  if (!Array.isArray(packages) || packages.length < 1 || packages.length > 50 || packages.some((value) => typeof value !== "string" || value.length < 100 || value.length > 20_000 || !/^[A-Za-z0-9_-]+$/.test(value))) {
    throw new HttpError(400, "1-50 MLS KeyPackages are required", "invalid_mls_key_packages");
  }
  return packages as string[];
}

async function keyPackageInserts(db: ReturnType<typeof createDatabase>, deviceId: string, packages: string[], now: number) {
  const fingerprints = await Promise.all(packages.map(sha256));
  return packages.map((keyPackage, index) => db.insertInto("device_key_packages").values({
    package_id: randomId(18), device_id: deviceId, key_package: keyPackage, key_package_fingerprint: fingerprints[index],
    created_at: now, claimed_at: null, claimed_by_device_id: null, claim_context: null, consumed_room_id: null,
  }).onConflict((conflict) => conflict.doNothing()));
}

async function memberRole(env: Env, roomId: string, userId: string): Promise<"owner" | "member" | null> {
  const row = await createDatabase(env.DB).selectFrom("room_members").select("role")
    .where("room_id", "=", roomId).where("user_id", "=", userId).where("removed_at", "is", null).executeTakeFirst();
  return row?.role ?? null;
}

async function roomLeavePending(env: Env, roomId: string, userId: string): Promise<boolean> {
  const row = await createDatabase(env.DB).selectFrom("room_leave_requests").select("request_id")
    .where("room_id", "=", roomId).where("user_id", "=", userId).where("status", "in", ["pending", "processing"]).executeTakeFirst();
  return Boolean(row);
}

async function interactionBlocked(env: Env, left: string, right: string): Promise<boolean> {
  if (left === right) return false;
  const row = await createDatabase(env.DB).selectFrom("user_blocks").select("blocker_user_id")
    .where((eb) => eb.or([
      eb.and([eb("blocker_user_id", "=", left), eb("blocked_user_id", "=", right)]),
      eb.and([eb("blocker_user_id", "=", right), eb("blocked_user_id", "=", left)]),
    ])).executeTakeFirst();
  return Boolean(row);
}

type InvitationPolicy = "everyone" | "shared_rooms" | "nobody";

async function invitationAllowed(env: Env, inviter: string, invitee: string): Promise<boolean> {
  if (inviter === invitee) return true;
  const db = createDatabase(env.DB);
  const user = await db.selectFrom("users").select("invitation_policy").where("user_id", "=", invitee)
    .where("deletion_requested_at", "is", null).where("deleted_at", "is", null).executeTakeFirst();
  if (!user || user.invitation_policy === "nobody") return false;
  if (user.invitation_policy === "everyone") return true;
  const shared = await db.selectFrom("room_members as invited")
    .innerJoin("room_members as inviter", "inviter.room_id", "invited.room_id")
    .select("invited.room_id")
    .where("invited.user_id", "=", invitee).where("invited.removed_at", "is", null)
    .where("inviter.user_id", "=", inviter).where("inviter.removed_at", "is", null)
    .executeTakeFirst();
  return Boolean(shared);
}

async function hasEstablishedRelationship(env: Env, left: string, right: string): Promise<boolean> {
  if (left === right) return true;
  const db = createDatabase(env.DB);
  const shared = await db.selectFrom("room_members as left_member")
    .innerJoin("room_members as right_member", "right_member.room_id", "left_member.room_id")
    .leftJoin("direct_message_requests as request", "request.room_id", "left_member.room_id")
    .select("left_member.room_id")
    .where("left_member.user_id", "=", left).where("left_member.removed_at", "is", null)
    .where("right_member.user_id", "=", right).where("right_member.removed_at", "is", null)
    .where((eb) => eb.or([eb("request.room_id", "is", null), eb("request.status", "=", "accepted")]))
    .executeTakeFirst();
  return Boolean(shared);
}

type DirectRequestState = {
  requester_user_id: string;
  recipient_user_id: string;
  status: "pending" | "accepted" | "rejected";
};

async function directRequestState(env: Env, roomId: string): Promise<DirectRequestState | null> {
  return await createDatabase(env.DB).selectFrom("direct_message_requests")
    .select(["requester_user_id", "recipient_user_id", "status"]).where("room_id", "=", roomId).executeTakeFirst() ?? null;
}

function requestView(request: DirectRequestState | null, userId: string, messageSent = false) {
  return {
    request_status: request?.status ?? null,
    request_role: request ? request.requester_user_id === userId ? "requester" as const : "recipient" as const : null,
    request_message_sent: Boolean(request && messageSent),
  };
}

async function reserveMessageRequestQuota(env: Env, roomId: RoomId, requesterUserId: string, recipientUserId: string): Promise<void> {
  const db = createDatabase(env.DB); const now = Date.now();
  const existing = await db.selectFrom("message_request_reservations").select(["requester_user_id", "recipient_user_id"])
    .where("room_id", "=", roomId).executeTakeFirst();
  if (existing) {
    if (existing.requester_user_id !== requesterUserId || existing.recipient_user_id !== recipientUserId) {
      throw new HttpError(409, "MLS claim context is already reserved", "message_request_reservation_conflict");
    }
    return;
  }
  const inserted = await db.insertInto("message_request_reservations").values({
    room_id: roomId, requester_user_id: requesterUserId, recipient_user_id: recipientUserId, created_at: now, consumed_at: null,
  }).onConflict((conflict) => conflict.column("room_id").doNothing()).executeTakeFirst();
  if (inserted.numInsertedOrUpdatedRows !== 1n) return reserveMessageRequestQuota(env, roomId, requesterUserId, recipientUserId);
  const [pending, reserved] = await Promise.all([
    db.selectFrom("direct_message_requests").select(sql<number>`count(*)`.as("count"))
      .where("requester_user_id", "=", requesterUserId).where("status", "=", "pending").executeTakeFirstOrThrow(),
    db.selectFrom("message_request_reservations").select(sql<number>`count(*)`.as("count"))
      .where("requester_user_id", "=", requesterUserId).where("consumed_at", "is", null).executeTakeFirstOrThrow(),
  ]);
  if (Number(pending.count) + Number(reserved.count) > 20) {
    await db.deleteFrom("message_request_reservations").where("room_id", "=", roomId).where("consumed_at", "is", null).execute();
    throw new HttpError(429, "Too many pending message requests", "message_request_limit");
  }
  const windowStartedAt = Math.floor(now / 3_600_000) * 3_600_000;
  await db.insertInto("message_request_rate_windows").values({ requester_user_id: requesterUserId, window_started_at: windowStartedAt, request_count: 1 })
    .onConflict((conflict) => conflict.columns(["requester_user_id", "window_started_at"])
      .doUpdateSet({ request_count: sql<number>`request_count + 1` })).execute();
  const window = await db.selectFrom("message_request_rate_windows").select("request_count")
    .where("requester_user_id", "=", requesterUserId).where("window_started_at", "=", windowStartedAt).executeTakeFirstOrThrow();
  if (window.request_count > 10) {
    await batch(env.DB, [
      db.deleteFrom("message_request_reservations").where("room_id", "=", roomId).where("consumed_at", "is", null),
      db.updateTable("message_request_rate_windows").set({ request_count: sql<number>`max(0, request_count - 1)` })
        .where("requester_user_id", "=", requesterUserId).where("window_started_at", "=", windowStartedAt),
    ]);
    throw new HttpError(429, "Message request rate limit exceeded", "message_request_rate_limited");
  }
}

async function invitationPolicy(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  requireUser(auth);
  const db = createDatabase(env.DB);
  if (request.method === "GET") {
    const user = await db.selectFrom("users").select("invitation_policy").where("user_id", "=", auth.userId).executeTakeFirstOrThrow();
    return json({ invitation_policy: user.invitation_policy });
  }
  const body = await readJson(request, 2_048); const policy = body.invitation_policy;
  if (policy !== "everyone" && policy !== "shared_rooms" && policy !== "nobody") throw new HttpError(400, "Invalid invitation policy", "invalid_invitation_policy");
  await db.updateTable("users").set({ invitation_policy: policy as InvitationPolicy }).where("user_id", "=", auth.userId).execute();
  return json({ invitation_policy: policy });
}

function normalizedDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "Invalid display_name", "invalid_profile");
  const displayName = value.trim();
  if (!displayName || displayName.length > 60 || /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(displayName)) {
    throw new HttpError(400, "Display name must be 1-60 visible characters", "invalid_profile");
  }
  return displayName;
}

function normalizedBio(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "Invalid bio", "invalid_profile");
  const bio = value.replace(/\r\n?/gu, "\n").trim();
  if (bio.length > 280 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(bio)) {
    throw new HttpError(400, "Bio must be at most 280 characters", "invalid_profile");
  }
  return bio;
}

function avatarUrl(avatarId: string | null): string | null {
  return avatarId ? `/avatars/${avatarId}.webp` : null;
}

type ProfileRow = { user_id: string; display_name: string; bio: string; avatar_id: string | null };

function profileView(profile: ProfileRow): UserProfile {
  return { user_id: profile.user_id as UserId, display_name: profile.display_name, bio: profile.bio, avatar_url: avatarUrl(profile.avatar_id) };
}

function profileUpdatePayload(userId: UserId, displayName: string, avatarId: string | null): string {
  return JSON.stringify({ type: "profile.updated", user_id: userId, display_name: displayName, avatar_url: avatarUrl(avatarId) });
}

function profileUpdateStatements(env: Env, userId: UserId, eventId: string, payload: string, now: number, condition?: { avatarId: string | null }): D1PreparedStatement[] {
  const self = condition
    ? env.DB.prepare(`INSERT INTO sync_log (recipient_user_id, kind, room_id, seq, event_id, payload, created_at)
        SELECT ?1, 'device.event', NULL, NULL, ?2, ?3, ?4
        WHERE EXISTS (SELECT 1 FROM users WHERE user_id = ?1 AND avatar_id IS ?5)`).bind(userId, eventId, payload, now, condition.avatarId)
    : env.DB.prepare("INSERT INTO sync_log (recipient_user_id, kind, room_id, seq, event_id, payload, created_at) VALUES (?1, 'device.event', NULL, NULL, ?2, ?3, ?4)")
      .bind(userId, eventId, payload, now);
  const avatarCondition = condition ? " AND EXISTS (SELECT 1 FROM users owner WHERE owner.user_id = ?4 AND owner.avatar_id IS ?5)" : "";
  const peerBindings = condition ? [eventId, payload, now, userId, condition.avatarId] : [eventId, payload, now, userId];
  return [
    self,
    env.DB.prepare(`
      INSERT INTO sync_log (recipient_user_id, kind, room_id, seq, event_id, payload, created_at)
      SELECT DISTINCT peers.user_id, 'device.event', NULL, NULL, ?1, ?2, ?3
      FROM room_members mine
      JOIN room_members peers ON peers.room_id = mine.room_id AND peers.removed_at IS NULL
      JOIN users peer ON peer.user_id = peers.user_id AND peer.deletion_requested_at IS NULL AND peer.deleted_at IS NULL
      WHERE mine.user_id = ?4 AND mine.removed_at IS NULL AND peers.user_id <> ?4${avatarCondition}
    `).bind(...peerBindings),
  ];
}

async function userProfile(env: Env, userId: UserId): Promise<Response> {
  assertLocalId(userId, "@", env);
  const profile = await createDatabase(env.DB).selectFrom("users").select(["user_id", "display_name", "bio", "avatar_id"])
    .where("user_id", "=", userId).where("deletion_requested_at", "is", null).where("deleted_at", "is", null).executeTakeFirst();
  if (!profile) throw new HttpError(404, "User not found", "user_not_found");
  return json({ profile: profileView(profile) });
}

async function updateUserProfile(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  requireUser(auth);
  const body = await readJson(request, 4_096);
  const displayName = normalizedDisplayName(body.display_name);
  const bio = normalizedBio(body.bio);
  const now = Date.now();
  const eventId = `profile:${auth.userId}:${now}:${randomId(8)}`;
  const current = await createDatabase(env.DB).selectFrom("users").select("avatar_id").where("user_id", "=", auth.userId).executeTakeFirstOrThrow();
  const payload = profileUpdatePayload(auth.userId, displayName, current.avatar_id);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET display_name = ?1, bio = ?2 WHERE user_id = ?3 AND deletion_requested_at IS NULL AND deleted_at IS NULL")
      .bind(displayName, bio, auth.userId),
    ...profileUpdateStatements(env, auth.userId, eventId, payload, now),
  ]);
  return json({ profile: { user_id: auth.userId, display_name: displayName, bio, avatar_url: avatarUrl(current.avatar_id) } satisfies UserProfile });
}

function isWebp(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

export async function processProfileAvatarDeletions(env: Env, objectKey?: string, now = Date.now()): Promise<number> {
  const db = createDatabase(env.DB);
  let query = db.selectFrom("profile_avatar_deletions").select(["object_key", "attempts"]).orderBy("requested_at").limit(objectKey ? 1 : 50);
  if (objectKey) query = query.where("object_key", "=", objectKey);
  else query = query.where((eb) => eb.or([
    eb.and([eb("deleting_token", "is", null), eb("requested_at", "<=", now - PROFILE_AVATAR_WRITE_INTENT_GRACE_MS)]),
    eb("deleting_expires_at", "<=", now),
  ]));
  const candidates = await query.execute();
  if (!candidates.length) return 0;
  // A deletion record is also the crash marker for the short PUT -> profile
  // CAS window. Never let routine GC delete an object that D1 has since made
  // authoritative, even when a response was lost or a prior batch was retried.
  const activeKeys = new Set((await db.selectFrom("users").select("avatar_object_key")
    .where("avatar_object_key", "in", candidates.map((item) => item.object_key)).execute())
    .flatMap((item) => item.avatar_object_key ? [item.avatar_object_key] : []));
  if (activeKeys.size) await db.deleteFrom("profile_avatar_deletions").where("object_key", "in", [...activeKeys]).execute();
  const candidateKeys = candidates.filter((item) => !activeKeys.has(item.object_key)).map((item) => item.object_key);
  if (!candidateKeys.length) return 0;
  // Atomically convert write intents into leased deletion claims. Upload
  // retry refreshes only an unclaimed intent, while a crashed cleaner's claim
  // can be recovered after its bounded lease. The UPDATE repeats every safety
  // predicate rather than trusting the earlier SELECT.
  const claimToken = randomId(18);
  let claim = db.updateTable("profile_avatar_deletions").set({ deleting_token: claimToken, deleting_expires_at: now + PROFILE_AVATAR_DELETE_CLAIM_MS })
    .where("object_key", "in", candidateKeys)
    .where((eb) => eb.or([eb("deleting_token", "is", null), eb("deleting_expires_at", "<=", now)]))
    .where(sql<boolean>`NOT EXISTS (
      SELECT 1 FROM users
      WHERE users.avatar_object_key = profile_avatar_deletions.object_key
    )`);
  if (!objectKey) claim = claim.where((eb) => eb.or([
    eb.and([eb("deleting_token", "is", null), eb("requested_at", "<=", now - PROFILE_AVATAR_WRITE_INTENT_GRACE_MS)]),
    eb("deleting_expires_at", "<=", now),
  ]));
  const pending = await claim.returning(["object_key", "attempts"]).execute();
  if (!pending.length) return 0;
  try {
    await objectStore(env).delete(pending.map((item) => item.object_key));
    await db.deleteFrom("profile_avatar_deletions").where("object_key", "in", pending.map((item) => item.object_key))
      .where("deleting_token", "=", claimToken).execute();
    return pending.length;
  } catch (error) {
    const message = (error instanceof Error ? error.message : "avatar deletion failed").slice(0, 500);
    await batch(env.DB, pending.map((item) => db.updateTable("profile_avatar_deletions")
      .set({ attempts: item.attempts + 1, last_error: message, requested_at: now, deleting_token: null, deleting_expires_at: null })
      .where("object_key", "=", item.object_key).where("deleting_token", "=", claimToken)));
    return 0;
  }
}

async function stageAvatarDeletion(env: Env, userId: UserId, objectKey: string, bytes: number): Promise<"created" | "existing" | null> {
  const now = Date.now();
  const inserted = await env.DB.prepare(`INSERT INTO profile_avatar_deletions
      (object_key, owner_user_id, byte_size, requested_at, attempts, last_error)
    SELECT ?1, ?2, ?3, ?4, 0, NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM profile_avatar_deletions
      WHERE owner_user_id = ?2 AND object_key <> ?1
    )
    ON CONFLICT(object_key) DO NOTHING
    RETURNING object_key`).bind(objectKey, userId, bytes, now).first<{ object_key: string }>();
  if (inserted?.object_key === objectKey) return "created";
  const refreshed = await env.DB.prepare(`UPDATE profile_avatar_deletions
      SET requested_at = ?4, attempts = 0, last_error = NULL
    WHERE object_key = ?1 AND owner_user_id = ?2 AND byte_size = ?3 AND deleting_token IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM profile_avatar_deletions pending
        WHERE pending.owner_user_id = ?2 AND pending.object_key <> ?1
      )
    RETURNING object_key`).bind(objectKey, userId, bytes, now).first<{ object_key: string }>();
  return refreshed?.object_key === objectKey ? "existing" : null;
}

async function uploadProfileAvatar(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  requireUser(auth);
  const declaredSize = Number(request.headers.get("content-length"));
  if (!request.body || !Number.isSafeInteger(declaredSize) || declaredSize < 12) throw new HttpError(411, "Valid Content-Length required", "length_required");
  if (declaredSize > MAX_PROFILE_AVATAR_BYTES) throw new HttpError(413, "Avatar must be at most 128 KiB", "avatar_too_large");
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "image/webp") throw new HttpError(415, "Avatar must be WebP", "invalid_avatar_type");
  const buffer = await request.arrayBuffer(); const bytes = new Uint8Array(buffer);
  if (bytes.byteLength !== declaredSize || !isWebp(bytes)) throw new HttpError(400, "Invalid WebP avatar", "invalid_avatar");
  const digestBytes = await crypto.subtle.digest("SHA-256", bytes);
  const digest = b64url(digestBytes);
  const db = createDatabase(env.DB);
  const before = await db.selectFrom("users").select(["user_id", "display_name", "bio", "avatar_id", "avatar_object_key", "avatar_sha256", "avatar_bytes"])
    .where("user_id", "=", auth.userId).where("deletion_requested_at", "is", null).where("deleted_at", "is", null).executeTakeFirstOrThrow();
  if (before.avatar_sha256 === digest && before.avatar_id && before.avatar_object_key) {
    const repair = await db.selectFrom("profile_avatar_repair_jobs").select(["object_key", "avatar_sha256", "byte_size"])
      .where("user_id", "=", auth.userId).executeTakeFirst();
    if (!repair) return json({ profile: profileView(before) });
    if (repair.object_key !== before.avatar_object_key || repair.avatar_sha256 !== digest || repair.byte_size !== bytes.byteLength) {
      throw new Error("Stored profile avatar repair job does not match the active avatar");
    }
    const leaseToken = randomId(18); const leaseNow = Date.now();
    const leased = await db.updateTable("profile_avatar_repair_jobs")
      .set({ lease_token: leaseToken, lease_expires_at: leaseNow + PROFILE_AVATAR_REPAIR_LEASE_MS, updated_at: leaseNow })
      .where("user_id", "=", auth.userId).where((eb) => eb.or([eb("lease_token", "is", null), eb("lease_expires_at", "<=", leaseNow)]))
      .returning("user_id").executeTakeFirst();
    if (!leased) throw new HttpError(409, "Profile avatar repair is already in progress", "avatar_upload_busy", { "retry-after": "30" });
    try {
      const stored = await objectStore(env).put(before.avatar_object_key, buffer, {
        expectedSize: bytes.byteLength, checksumSha256: digestBytes, contentType: "image/webp",
        cacheControl: "public, max-age=31536000, immutable", metadata: { sha256: digest },
      });
      if (!stored || stored.size !== bytes.byteLength) throw new Error("Profile avatar repair returned invalid object metadata");
      const completed = await db.deleteFrom("profile_avatar_repair_jobs").where("user_id", "=", auth.userId).where("lease_token", "=", leaseToken)
        .where((eb) => eb.exists(eb.selectFrom("users").select("user_id").where("user_id", "=", auth.userId)
          .where("avatar_object_key", "=", before.avatar_object_key).where("avatar_sha256", "=", digest).where("avatar_bytes", "=", bytes.byteLength)))
        .returning("user_id").executeTakeFirst();
      if (!completed) {
        const current = await db.selectFrom("users").select(["avatar_object_key", "avatar_sha256", "avatar_bytes"])
          .where("user_id", "=", auth.userId).executeTakeFirst();
        if (current?.avatar_object_key === before.avatar_object_key && current.avatar_sha256 === digest && current.avatar_bytes === bytes.byteLength) {
          return json({ profile: profileView(before) });
        }
        await objectStore(env).delete(before.avatar_object_key);
        await db.deleteFrom("profile_avatar_repair_jobs").where("user_id", "=", auth.userId).where("lease_token", "=", leaseToken).execute();
        throw new HttpError(409, "Profile changed while repairing the avatar", "profile_conflict");
      }
      return json({ profile: profileView(before) });
    } catch (error) {
      await db.updateTable("profile_avatar_repair_jobs").set({
        attempts: sql<number>`attempts + 1`, last_error: (error instanceof Error ? error.message : "avatar repair failed").slice(0, 500),
        lease_token: null, lease_expires_at: null, updated_at: Date.now(),
      }).where("user_id", "=", auth.userId).where("lease_token", "=", leaseToken).execute();
      throw error;
    }
  }
  const objectKey = `profiles/avatars/${await sha256(auth.userId)}/${digest}.webp`;
  const avatarId = randomId(18); const now = Date.now(); const limits = defaultStorageLimits(env);
  // This row doubles as a write intent. A crash after the R2 put but before
  // the profile CAS remains recoverable without listing the bucket.
  const intent = await stageAvatarDeletion(env, auth.userId, objectKey, bytes.byteLength);
  if (!intent) {
    throw new HttpError(409, "Another profile avatar upload or cleanup is still in progress", "avatar_upload_busy", { "retry-after": "30" });
  }
  const matchesStored = (object: ObjectStoreObject): boolean => object.size === bytes.byteLength && object.metadata.sha256 === digest;
  let stored: ObjectStoreObject | null = null;
  if (intent === "existing") stored = await objectStore(env).head(objectKey);
  if (stored && !matchesStored(stored)) {
    throw new HttpError(409, "Stored profile avatar conflicts with the upload intent", "avatar_upload_conflict");
  }
  if (!stored) {
    stored = await objectStore(env).put(objectKey, buffer, {
      ifAbsent: true, expectedSize: bytes.byteLength, checksumSha256: digestBytes, contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable", metadata: { sha256: digest },
    });
    if (!stored) stored = await objectStore(env).head(objectKey);
    if (!stored || !matchesStored(stored)) {
      throw new HttpError(409, "Stored profile avatar conflicts with the upload intent", "avatar_upload_conflict");
    }
  }
  const eventId = `profile:${auth.userId}:${now}:${randomId(8)}`;
  const payload = profileUpdatePayload(auth.userId, before.display_name, avatarId);
  const statements = [
    env.DB.prepare(`UPDATE users SET avatar_id = ?1, avatar_object_key = ?2, avatar_sha256 = ?3, avatar_bytes = ?4
      WHERE user_id = ?5 AND COALESCE(avatar_sha256, '') = ?6 AND deletion_requested_at IS NULL AND deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM profile_avatar_deletions intent
          WHERE intent.object_key = ?2 AND intent.owner_user_id = ?5 AND intent.byte_size = ?4
            AND intent.deleting_token IS NULL
        )
        AND COALESCE((SELECT attachment_bytes + archive_bytes FROM user_storage_usage WHERE user_id = ?5), 0) + ?4
          <= COALESCE((SELECT quota_bytes FROM user_storage_limits WHERE user_id = ?5), ?7)
        AND COALESCE((SELECT attachment_objects + archive_objects FROM user_storage_usage WHERE user_id = ?5), 0) + 1
          <= COALESCE((SELECT object_limit FROM user_storage_limits WHERE user_id = ?5), ?8)`)
      .bind(avatarId, objectKey, digest, bytes.byteLength, auth.userId, before.avatar_sha256 ?? "", limits.bytes, limits.objects),
    ...profileUpdateStatements(env, auth.userId, eventId, payload, now, { avatarId }),
    env.DB.prepare(`DELETE FROM profile_avatar_repair_jobs WHERE user_id = ?1
      AND EXISTS (SELECT 1 FROM users WHERE user_id = ?1 AND avatar_object_key = ?2)`).bind(auth.userId, objectKey),
    env.DB.prepare(`DELETE FROM profile_avatar_deletions WHERE object_key = ?1
      AND EXISTS (SELECT 1 FROM users WHERE user_id = ?2 AND avatar_object_key = ?1)`).bind(objectKey, auth.userId),
    ...(before.avatar_object_key ? [env.DB.prepare(`INSERT OR IGNORE INTO profile_avatar_deletions
      (object_key, owner_user_id, byte_size, requested_at, attempts, last_error)
      SELECT ?1, ?2, ?3, ?4, 0, NULL WHERE EXISTS (SELECT 1 FROM users WHERE user_id = ?2 AND avatar_object_key = ?5)`)
      .bind(before.avatar_object_key, auth.userId, before.avatar_bytes, now, objectKey)] : []),
  ];
  const results = await env.DB.batch(statements);
  if (Number(results[0].meta.changes ?? 0) !== 1) {
    const [current, intent] = await Promise.all([
      db.selectFrom("users").select("avatar_object_key").where("user_id", "=", auth.userId).executeTakeFirst(),
      db.selectFrom("profile_avatar_deletions").select("deleting_token").where("object_key", "=", objectKey).executeTakeFirst(),
    ]);
    if (current?.avatar_object_key !== objectKey) await processProfileAvatarDeletions(env, objectKey);
    if (current?.avatar_object_key !== before.avatar_object_key) throw new HttpError(409, "Profile changed on another device; try again", "profile_conflict");
    if (intent?.deleting_token) throw new HttpError(409, "Profile avatar cleanup won the upload race; retry safely", "avatar_upload_busy", { "retry-after": "30" });
    throw new HttpError(413, "Storage quota or object limit exceeded", "storage_quota_exceeded");
  }
  if (before.avatar_object_key) await processProfileAvatarDeletions(env, before.avatar_object_key);
  return json({ profile: { user_id: auth.userId, display_name: before.display_name, bio: before.bio, avatar_url: avatarUrl(avatarId) } satisfies UserProfile });
}

async function deleteProfileAvatar(env: Env, auth: AuthContext): Promise<Response> {
  requireUser(auth);
  const db = createDatabase(env.DB);
  const before = await db.selectFrom("users").select(["user_id", "display_name", "bio", "avatar_id", "avatar_object_key", "avatar_bytes"])
    .where("user_id", "=", auth.userId).executeTakeFirstOrThrow();
  if (!before.avatar_object_key) return json({ profile: profileView(before) });
  const now = Date.now(); const eventId = `profile:${auth.userId}:${now}:${randomId(8)}`;
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE users SET avatar_id = NULL, avatar_object_key = NULL, avatar_sha256 = NULL, avatar_bytes = 0 WHERE user_id = ?1 AND avatar_object_key = ?2")
      .bind(auth.userId, before.avatar_object_key),
    ...profileUpdateStatements(env, auth.userId, eventId, profileUpdatePayload(auth.userId, before.display_name, null), now, { avatarId: null }),
    env.DB.prepare(`DELETE FROM profile_avatar_repair_jobs WHERE user_id = ?1
      AND EXISTS (SELECT 1 FROM users WHERE user_id = ?1 AND avatar_object_key IS NULL)`).bind(auth.userId),
    env.DB.prepare("INSERT OR IGNORE INTO profile_avatar_deletions (object_key, owner_user_id, byte_size, requested_at, attempts, last_error) VALUES (?1, ?2, ?3, ?4, 0, NULL)")
      .bind(before.avatar_object_key, auth.userId, before.avatar_bytes, now),
  ]);
  if (Number(results[0].meta.changes ?? 0) !== 1) throw new HttpError(409, "Profile changed on another device; try again", "profile_conflict");
  await processProfileAvatarDeletions(env, before.avatar_object_key);
  return json({ profile: { user_id: auth.userId, display_name: before.display_name, bio: before.bio, avatar_url: null } satisfies UserProfile });
}

async function publicProfileAvatar(env: Env, avatarId: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{24}$/.test(avatarId)) throw new HttpError(404, "Avatar not found", "not_found");
  const db = createDatabase(env.DB);
  const row = await db.selectFrom("users as u").leftJoin("profile_avatar_repair_jobs as repair", "repair.user_id", "u.user_id")
    .select(["u.user_id", "u.avatar_object_key", "u.avatar_sha256", "u.avatar_bytes", "repair.user_id as repair_user_id"])
    .where("u.avatar_id", "=", avatarId).where("u.deletion_requested_at", "is", null).where("u.deleted_at", "is", null).executeTakeFirst();
  if (!row?.avatar_object_key || !row.avatar_sha256) throw new HttpError(404, "Avatar not found", "not_found");
  if (row.repair_user_id) throw new HttpError(503, "Avatar is awaiting an exact owner repair", "avatar_repair_pending", { "retry-after": "30" });
  const object = await objectStore(env).get(row.avatar_object_key);
  const now = Date.now();
  const markRepair = async (): Promise<boolean> => Boolean(await env.DB.prepare(`INSERT INTO profile_avatar_repair_jobs
      (user_id, object_key, avatar_sha256, byte_size, detected_at, updated_at, attempts, last_error, lease_token, lease_expires_at)
    SELECT user_id, avatar_object_key, avatar_sha256, avatar_bytes, ?1, ?1, 0, NULL, NULL, NULL
    FROM users
    WHERE user_id = ?2 AND avatar_id = ?3 AND avatar_object_key = ?4 AND avatar_sha256 = ?5 AND avatar_bytes = ?6
      AND deletion_requested_at IS NULL AND deleted_at IS NULL
    ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at
      WHERE profile_avatar_repair_jobs.object_key = excluded.object_key
        AND profile_avatar_repair_jobs.avatar_sha256 = excluded.avatar_sha256
        AND profile_avatar_repair_jobs.byte_size = excluded.byte_size
    RETURNING user_id`).bind(now, row.user_id, avatarId, row.avatar_object_key, row.avatar_sha256, row.avatar_bytes).first());
  if (!object?.body) {
    if (!(await markRepair())) throw new HttpError(404, "Avatar not found", "not_found");
    throw new HttpError(503, "Avatar is temporarily unavailable and awaiting exact owner repair", "avatar_repair_pending", { "retry-after": "30" });
  }
  if (object.size !== row.avatar_bytes || object.metadata.sha256 !== row.avatar_sha256) {
    await object.body.cancel().catch(() => undefined);
    if (!(await markRepair())) throw new HttpError(404, "Avatar not found", "not_found");
    try { await objectStore(env).delete(row.avatar_object_key); }
    catch (error) {
      await db.updateTable("profile_avatar_repair_jobs").set({
        attempts: sql<number>`attempts + 1`, last_error: (error instanceof Error ? error.message : "corrupt avatar deletion failed").slice(0, 500), updated_at: Date.now(),
      }).where("user_id", "=", row.user_id).execute();
    }
    throw new HttpError(503, "Avatar failed integrity validation and is awaiting exact owner repair", "avatar_repair_pending", { "retry-after": "30" });
  }
  return new Response(object.body, { headers: {
    "content-type": "image/webp", "content-length": String(object.size), etag: `"${row.avatar_sha256}"`,
    "cache-control": "public, max-age=31536000, immutable", "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  } });
}

async function assertNoBlockedPair(env: Env, userIds: string[]): Promise<void> {
  if (userIds.length < 2) return;
  const row = await createDatabase(env.DB).selectFrom("user_blocks").select("blocker_user_id")
    .where("blocker_user_id", "in", userIds).where("blocked_user_id", "in", userIds).executeTakeFirst();
  if (row) throw new HttpError(403, "Interaction is not available", "interaction_not_allowed");
}

async function directRoomBlocked(env: Env, roomId: string): Promise<boolean> {
  const db = createDatabase(env.DB);
  const room = await db.selectFrom("rooms").select("kind").where("room_id", "=", roomId).executeTakeFirst();
  if (room?.kind !== "direct") return false;
  const members = await db.selectFrom("room_members").select("user_id").where("room_id", "=", roomId).where("removed_at", "is", null).limit(2).execute();
  return members.length === 2 && interactionBlocked(env, members[0].user_id, members[1].user_id);
}

async function setUserBlock(env: Env, auth: AuthContext, targetUserId: UserId, blocked: boolean): Promise<Response> {
  requireUser(auth);
  assertLocalId(targetUserId, "@", env);
  if (targetUserId === auth.userId) throw new HttpError(400, "A user cannot block itself", "invalid_block_target");
  const db = createDatabase(env.DB);
  if (!(await db.selectFrom("users").select("user_id").where("user_id", "=", targetUserId).where("deletion_requested_at", "is", null).where("deleted_at", "is", null).executeTakeFirst())) throw new HttpError(404, "User not found", "user_not_found");
  if (blocked) {
    await db.insertInto("user_blocks").values({ blocker_user_id: auth.userId, blocked_user_id: targetUserId, created_at: Date.now() })
      .onConflict((conflict) => conflict.columns(["blocker_user_id", "blocked_user_id"]).doNothing()).execute();
    const directRooms = await db.selectFrom("rooms as r")
      .innerJoin("room_members as mine", (join) => join.onRef("mine.room_id", "=", "r.room_id").on("mine.user_id", "=", auth.userId).on("mine.removed_at", "is", null))
      .innerJoin("room_members as theirs", (join) => join.onRef("theirs.room_id", "=", "r.room_id").on("theirs.user_id", "=", targetUserId).on("theirs.removed_at", "is", null))
      .select("r.room_id").where("r.kind", "=", "direct").execute();
    await Promise.all(directRooms.flatMap((room) => [
      env.ROOMS.getByName(room.room_id).closeUserSockets(auth.userId),
      env.ROOMS.getByName(room.room_id).closeUserSockets(targetUserId),
    ]));
  } else {
    await db.deleteFrom("user_blocks").where("blocker_user_id", "=", auth.userId).where("blocked_user_id", "=", targetUserId).execute();
  }
  return new Response(null, { status: 204 });
}

async function appendRoomEvent(env: Env, roomId: RoomId, event: ClientEvent, currentEpoch: number): Promise<RoomEvent> {
  const result = await env.ROOMS.getByName(roomId).appendEvent(event, currentEpoch);
  if (!result.ok) {
    const message = result.code === "stale_epoch"
      ? "Room MLS epoch changed while ordering the event"
      : result.code === "event_id_conflict" ? "Event ID is already bound to another signed envelope"
        : result.code === "owner_conflict" ? "Room ownership changed while ordering the event" : "Event MLS epoch is invalid";
    throw new HttpError(409, message, result.code);
  }
  return result.event;
}

function assertLocalId(id: string, prefix: "@" | "!" | "$", env: Env): void {
  if (!id.startsWith(prefix) || id.slice(id.lastIndexOf(":") + 1) !== env.SERVER_NAME) {
    throw new HttpError(400, "Remote identifiers are disabled in Phase 1", "federation_disabled");
  }
}

async function register(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const localpart = stringField(body, "localpart", 32).trim().toLowerCase();
  const displayName = normalizedDisplayName(body.display_name ?? localpart);
  const password = stringField(body, "password", 256);
  const device = body.device as Record<string, unknown> | undefined;
  if (!/^[a-z0-9_][a-z0-9_.-]{1,30}$/.test(localpart)) throw new HttpError(400, "Invalid username", "invalid_username");
  await limitUnauthenticatedRequest(request, env, "register", localpart);
  if (!device || typeof device !== "object") throw new HttpError(400, "Device is required", "invalid_device");
  const deviceId = stringField(device, "device_id", 96);
  const deviceName = stringField(device, "display_name", 60);
  const signingKey = stringField(device, "signing_key", 2_000);
  const encryptionKey = stringField(device, "encryption_key", 2_000);
  const packages = mlsKeyPackages(device);
  await validatePublicKeys(signingKey, encryptionKey);
  const credential = await passwordHash(password);
  const deviceCredential = randomId(32);
  const userId = `@${localpart}:${env.SERVER_NAME}` as UserId;
  const now = Date.now();
  try {
    const db = createDatabase(env.DB);
    await batch(env.DB, [
      db.insertInto("users").values({ user_id: userId, localpart, display_name: displayName, bio: "", password_hash: credential.hash, password_salt: credential.salt, created_at: now }),
      db.insertInto("devices").values({ device_id: deviceId, user_id: userId, display_name: deviceName, signing_key: signingKey, encryption_key: encryptionKey, device_credential_hash: await sha256(deviceCredential), created_at: now, last_seen_at: now, revoked_at: null }),
      ...(await keyPackageInserts(db, deviceId, packages, now)),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) throw new HttpError(409, "Username or device already exists", "already_exists");
    throw error;
  }
  const token = await createSession(env, userId, deviceId);
  return json({ access_token: token, user_id: userId, device_id: deviceId, device_credential: deviceCredential, display_name: displayName, avatar_url: null, server_name: env.SERVER_NAME, ...sessionCapabilities(env) }, 201);
}

async function replayOpaqueRegistration(env: Env, input: {
  deviceId: string; signingKey: string; encryptionKey: string; accountCredential: string; deviceCredential: string;
}): Promise<Response | null> {
  const db = createDatabase(env.DB);
  const existing = await db.selectFrom("devices as d").innerJoin("users as u", "u.user_id", "d.user_id")
    .select(["u.user_id", "u.display_name", "u.account_mode", "u.password_hash", "u.password_salt", "u.avatar_id",
      "d.signing_key", "d.encryption_key", "d.device_credential_hash", "d.revoked_at"])
    .where("d.device_id", "=", input.deviceId).where("u.deletion_requested_at", "is", null).where("u.deleted_at", "is", null).executeTakeFirst();
  if (!existing) return null;
  const [accountMatches, suppliedDeviceCredentialHash] = await Promise.all([
    verifyPassword(input.accountCredential, existing.password_hash, existing.password_salt).catch(() => false),
    sha256(input.deviceCredential),
  ]);
  if (existing.account_mode !== "opaque" || existing.revoked_at !== null || !accountMatches
    || existing.device_credential_hash !== suppliedDeviceCredentialHash
    || existing.signing_key !== input.signingKey || existing.encryption_key !== input.encryptionKey) {
    throw new HttpError(409, "Device already exists", "already_exists");
  }
  const token = await createSession(env, existing.user_id as UserId, input.deviceId);
  return json({ access_token: token, user_id: existing.user_id, device_id: input.deviceId, device_credential: input.deviceCredential,
    account_credential: input.accountCredential, account_mode: "opaque", display_name: existing.display_name,
    avatar_url: existing.avatar_id ? `/avatars/${existing.avatar_id}` : null,
    server_name: env.SERVER_NAME, ...sessionCapabilities(env) });
}

async function registerOpaqueAccount(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const displayName = normalizedDisplayName(body.display_name);
  const accountCredential = stringField(body, "account_credential", 128);
  if (!/^[A-Za-z0-9_-]{43}$/.test(accountCredential)) throw new HttpError(400, "Invalid account credential", "invalid_account_credential");
  const device = body.device as Record<string, unknown> | undefined;
  if (!device || typeof device !== "object" || Array.isArray(device)) throw new HttpError(400, "Device is required", "invalid_device");
  const deviceId = stringField(device, "device_id", 96);
  const deviceName = stringField(device, "display_name", 60);
  const signingKey = stringField(device, "signing_key", 2_000);
  const encryptionKey = stringField(device, "encryption_key", 2_000);
  const deviceCredential = stringField(device, "device_credential", 128);
  if (!/^[A-Za-z0-9_-]{43}$/.test(deviceCredential)) throw new HttpError(400, "Invalid device credential", "invalid_device_credential");
  const packages = mlsKeyPackages(device);
  await limitUnauthenticatedRequest(request, env, "register", deviceId);
  await validatePublicKeys(signingKey, encryptionKey);
  const retryInput = { deviceId, signingKey, encryptionKey, accountCredential, deviceCredential };
  const replay = await replayOpaqueRegistration(env, retryInput);
  if (replay) return replay;
  const db = createDatabase(env.DB);
  const localpart = `u_${randomId(18).toLowerCase()}`;
  const credential = await passwordHash(accountCredential);
  const userId = `@${localpart}:${env.SERVER_NAME}` as UserId;
  const now = Date.now();
  try {
    await batch(env.DB, [
      db.insertInto("users").values({ user_id: userId, localpart, display_name: displayName, bio: "", account_mode: "opaque", password_hash: credential.hash, password_salt: credential.salt, created_at: now }),
      db.insertInto("devices").values({ device_id: deviceId, user_id: userId, display_name: deviceName, signing_key: signingKey, encryption_key: encryptionKey, device_credential_hash: await sha256(deviceCredential), created_at: now, last_seen_at: now, revoked_at: null }),
      ...(await keyPackageInserts(db, deviceId, packages, now)),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      // A concurrent byte-identical retry may have committed between the
      // lookup and this batch. Re-enter once through the authoritative lookup
      // path instead of creating another account or losing its credentials.
      const concurrentReplay = await replayOpaqueRegistration(env, retryInput);
      if (concurrentReplay) return concurrentReplay;
      throw new HttpError(409, "Device or KeyPackage already exists", "already_exists");
    }
    throw error;
  }
  const token = await createSession(env, userId, deviceId);
  return json({ access_token: token, user_id: userId, device_id: deviceId, device_credential: deviceCredential,
    account_credential: accountCredential, account_mode: "opaque", display_name: displayName, avatar_url: null,
    server_name: env.SERVER_NAME, ...sessionCapabilities(env) }, 201);
}

async function changePassword(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  requireUser(auth);
  await limitUnauthenticatedRequest(request, env, "password-change", auth.userId);
  const body = await readJson(request, 2_048);
  const currentPassword = stringField(body, "current_password", 256);
  const newPassword = stringField(body, "new_password", 256);
  if (typeof body.logout_other_devices !== "boolean") throw new HttpError(400, "Invalid logout option", "invalid_input");
  if (newPassword === currentPassword) throw new HttpError(400, "New password must be different", "password_unchanged");
  if (newPassword.length < 10) throw new HttpError(400, "Password must be at least 10 characters", "weak_password");

  const db = createDatabase(env.DB);
  const user = await db.selectFrom("users").select(["password_hash", "password_salt", "account_mode"])
    .where("user_id", "=", auth.userId).where("deletion_requested_at", "is", null).where("deleted_at", "is", null).executeTakeFirst();
  if (user?.account_mode === "opaque") throw new HttpError(409, "Generated account credentials cannot be changed manually", "password_change_not_supported");
  let verified = false;
  try { verified = Boolean(user) && currentPassword.length >= 10 && await verifyPassword(currentPassword, user!.password_hash, user!.password_salt); }
  catch { verified = false; }
  if (!verified) {
    await recordLoginFailure(env, auth.userId);
    throw new HttpError(401, "Current password is incorrect", "invalid_credentials");
  }

  const credential = await passwordHash(newPassword);
  const logoutOtherDevices = body.logout_other_devices;
  await batch(env.DB, [
    db.updateTable("users").set({ password_hash: credential.hash, password_salt: credential.salt }).where("user_id", "=", auth.userId),
    db.deleteFrom("login_failure_state").where("user_id", "=", auth.userId),
    db.deleteFrom("passkey_challenges").where("user_id", "=", auth.userId),
    ...(logoutOtherDevices ? [
      db.deleteFrom("sessions").where("user_id", "=", auth.userId).where("device_id", "!=", auth.deviceId),
      db.deleteFrom("ws_tickets").where("user_id", "=", auth.userId).where("device_id", "!=", auth.deviceId),
      db.deleteFrom("push_subscriptions").where("device_id", "in", db.selectFrom("devices").select("device_id").where("user_id", "=", auth.userId).where("device_id", "!=", auth.deviceId)),
      db.deleteFrom("device_session_challenges").where("device_id", "in", db.selectFrom("devices").select("device_id").where("user_id", "=", auth.userId).where("device_id", "!=", auth.deviceId)),
      db.updateTable("devices").set({ device_credential_hash: null }).where("user_id", "=", auth.userId).where("device_id", "!=", auth.deviceId),
    ] : []),
  ]);
  if (logoutOtherDevices) {
    const rooms = await db.selectFrom("room_members").select("room_id")
      .where("user_id", "=", auth.userId).where("removed_at", "is", null).execute();
    await Promise.allSettled(rooms.map((room) => env.ROOMS.getByName(room.room_id).closeOtherDeviceSockets(auth.userId, auth.deviceId)));
  }
  logSecurityEvent("info", "security.password_changed", { other_sessions_revoked: logoutOtherDevices });
  return json({ changed: true, other_sessions_revoked: logoutOtherDevices });
}

type AppealCategory = "login_locked" | "device_lost" | "account_access";

function appealReceipt(now = Date.now()): string {
  return `appeal_${now.toString(36)}_${randomId(24)}`;
}

function appealReceiptIssuedAt(receipt: string): number | null {
  const match = receipt.match(/^appeal_([0-9a-z]{8,12})_([A-Za-z0-9_-]{32})$/);
  if (!match) return null;
  const issuedAt = Number.parseInt(match[1], 36);
  return Number.isSafeInteger(issuedAt) && issuedAt > 0 ? issuedAt : null;
}

async function createAccountAppeal(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request, 2_048);
  const identifier = stringField(body, "user_id", 128).trim().toLowerCase();
  const userId = (identifier.startsWith("@") ? identifier : `@${identifier}:${env.SERVER_NAME}`) as UserId;
  assertLocalId(userId, "@", env);
  const password = stringField(body, "password", 256);
  const category = body.category;
  if (category !== "login_locked" && category !== "device_lost" && category !== "account_access") {
    throw new HttpError(400, "Invalid appeal category", "invalid_input");
  }
  await limitUnauthenticatedRequest(request, env, "appeal", userId);
  const now = Date.now(); const receipt = appealReceipt(now); const expiresAt = now + ACCOUNT_APPEAL_TTL_MS;
  const db = createDatabase(env.DB);
  const user = await db.selectFrom("users").select(["user_id", "password_hash", "password_salt", "deletion_requested_at", "deleted_at"])
    .where("user_id", "=", userId).executeTakeFirst();
  let verified = false;
  if (user && user.deletion_requested_at === null && user.deleted_at === null) {
    try { verified = password.length >= 10 && await verifyPassword(password.length >= 10 ? password : password.padEnd(10, "\0"), user.password_hash, user.password_salt); }
    catch { verified = false; }
  } else {
    await passwordHash(password.length >= 10 ? password : password.padEnd(10, "\0"), new Uint8Array(16));
  }
  if (user && user.deletion_requested_at === null && user.deleted_at === null && !verified) await recordLoginFailure(env, userId);
  if (verified) {
    const receiptHash = await sha256(receipt);
    const pending = await db.selectFrom("account_appeals").select("appeal_id")
      .where("user_id", "=", userId).where("status", "=", "pending").executeTakeFirst();
    if (pending) {
      await db.updateTable("account_appeals").set({ receipt_hash: receiptHash, category: category as AppealCategory, updated_at: now, expires_at: expiresAt })
        .where("appeal_id", "=", pending.appeal_id).execute();
    } else {
      await db.insertInto("account_appeals").values({
        appeal_id: randomId(18), user_id: userId, receipt_hash: receiptHash, category: category as AppealCategory,
        status: "pending", created_at: now, updated_at: now, expires_at: expiresAt, resolved_at: null,
      }).execute();
    }
    logSecurityEvent("info", "security.account_appeal_submitted", { category: category as AppealCategory, replaced_pending: Boolean(pending) });
  }
  // Invalid credentials receive an indistinguishable, self-expiring receipt,
  // but cannot allocate durable D1 state or reveal whether an account exists.
  return json({ receipt, status: "pending", expires_at: expiresAt }, 202);
}

async function accountAppealStatus(request: Request, env: Env, receipt: string): Promise<Response> {
  const issuedAt = appealReceiptIssuedAt(receipt);
  if (issuedAt === null) throw new HttpError(404, "Appeal not found", "not_found");
  await limitUnauthenticatedRequest(request, env, "appeal", receipt);
  const expiresAt = issuedAt + ACCOUNT_APPEAL_TTL_MS;
  if (expiresAt <= Date.now()) return json({ status: "expired", expires_at: expiresAt });
  const appeal = await createDatabase(env.DB).selectFrom("account_appeals").select(["status", "resolved_at"])
    .where("receipt_hash", "=", await sha256(receipt)).executeTakeFirst();
  return json({ status: appeal?.status ?? "pending", expires_at: expiresAt, resolved_at: appeal?.resolved_at ?? null });
}

export async function cleanupAccountAppeals(env: Env, now = Date.now()): Promise<number> {
  const db = createDatabase(env.DB);
  const row = await db.selectFrom("account_appeals").select(({ fn }) => fn.countAll<number>().as("count")).where((eb) => eb.or([
      eb.and([eb("status", "=", "pending"), eb("expires_at", "<=", now)]),
      eb.and([eb("status", "!=", "pending"), eb("resolved_at", "is not", null), eb("resolved_at", "<=", now - RESOLVED_APPEAL_RETENTION_MS)]),
    ])).executeTakeFirstOrThrow();
  if (Number(row.count) > 0) await db.deleteFrom("account_appeals").where((eb) => eb.or([
    eb.and([eb("status", "=", "pending"), eb("expires_at", "<=", now)]),
    eb.and([eb("status", "!=", "pending"), eb("resolved_at", "is not", null), eb("resolved_at", "<=", now - RESOLVED_APPEAL_RETENTION_MS)]),
  ])).execute();
  return Number(row.count);
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const identifier = stringField(body, "user_id", 128).toLowerCase();
  const userId = (identifier.startsWith("@") ? identifier : `@${identifier}:${env.SERVER_NAME}`) as UserId;
  assertLocalId(userId, "@", env);
  const password = stringField(body, "password", 256);
  await limitUnauthenticatedRequest(request, env, "login", userId);
  const db = createDatabase(env.DB);
  const user = await db.selectFrom("users").select(["user_id", "display_name", "avatar_id", "password_hash", "password_salt", "account_mode", "deletion_requested_at", "deleted_at"])
    .where("user_id", "=", userId).executeTakeFirst();
  const blocked = user ? await loginTemporarilyBlocked(env, userId) : false;
  if (!user || user.deletion_requested_at !== null || user.deleted_at !== null || blocked) {
    await passwordHash(password.length >= 10 ? password : password.padEnd(10, "\0"), new Uint8Array(16));
    throw new HttpError(401, "Invalid user ID or password", "invalid_credentials");
  }
  let passwordValid = false;
  try { passwordValid = password.length >= 10 && await verifyPassword(password, user.password_hash, user.password_salt); }
  catch { passwordValid = false; }
  if (!passwordValid) {
    await recordLoginFailure(env, userId);
    throw new HttpError(401, "Invalid user ID or password", "invalid_credentials");
  }
  const device = body.device as Record<string, unknown> | undefined;
  if (!device || typeof device !== "object" || Array.isArray(device)) throw new HttpError(400, "Device is required", "invalid_device");
  return establishDeviceSession(env, userId, user, device, true, user.account_mode !== "opaque");
}

async function establishDeviceSession(env: Env, userId: UserId, user: { display_name: string; avatar_id: string | null; account_mode: "password" | "opaque" }, device: Record<string, unknown>, allowBackupRestore: boolean, allowNewDevice: boolean): Promise<Response> {
  const db = createDatabase(env.DB);
  const deviceId = stringField(device, "device_id", 96);
  const deviceName = stringField(device, "display_name", 60);
  const signingKey = stringField(device, "signing_key", 2_000);
  const encryptionKey = stringField(device, "encryption_key", 2_000);
  const backupCheckpoint = typeof device.backup_checkpoint === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(device.backup_checkpoint) ? device.backup_checkpoint : null;
  const deviceCredential = typeof device.device_credential === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(device.device_credential) ? device.device_credential : null;
  const packages = mlsKeyPackages(device);
  await validatePublicKeys(signingKey, encryptionKey);
  if (backupCheckpoint && !allowBackupRestore) throw new HttpError(403, "Backup restore requires the account password", "backup_restore_requires_password");
  const existing = await db.selectFrom("devices").select(["user_id", "revoked_at", "signing_key", "encryption_key", "device_credential_hash"]).where("device_id", "=", deviceId).executeTakeFirst();
  if (!existing && !allowNewDevice) throw new HttpError(403, "A new device must be linked from an existing device or restored from backup", "device_link_required");
  if (existing && (existing.user_id !== userId || existing.revoked_at !== null)) throw new HttpError(403, "Device cannot be used", "device_rejected");
  if (existing && (!samePublicKey(existing.signing_key, signingKey) || !samePublicKey(existing.encryption_key, encryptionKey))) {
    throw new HttpError(403, "Device public keys do not match the registered identity", "device_key_mismatch");
  }
  if (existing && !existing.device_credential_hash && user.account_mode === "opaque") {
    throw new HttpError(403, "This device must finish its approved device link", "device_link_claim_required");
  }
  if (!existing && (backupCheckpoint || deviceCredential)) throw new HttpError(403, "Backup device is no longer registered", "backup_device_missing");
  const now = Date.now();
  let issuedDeviceCredential: string | undefined;
  if (!existing) {
    issuedDeviceCredential = randomId(32);
    await batch(env.DB, [
      db.insertInto("devices").values({ device_id: deviceId, user_id: userId, display_name: deviceName, signing_key: signingKey, encryption_key: encryptionKey, device_credential_hash: await sha256(issuedDeviceCredential), created_at: now, last_seen_at: now, revoked_at: null }),
      ...(await keyPackageInserts(db, deviceId, packages, now)),
    ]);
  } else {
    if (backupCheckpoint) {
      const checkpointHash = await sha256(backupCheckpoint);
      const checkpoint = await db.selectFrom("device_backup_checkpoints").select(["sent_event_count", "consumed_at"])
        .where("checkpoint_hash", "=", checkpointHash).where("device_id", "=", deviceId).where("user_id", "=", userId).executeTakeFirst();
      if (!checkpoint || checkpoint.consumed_at !== null) throw new HttpError(409, "This backup has already been restored or is no longer valid", "backup_checkpoint_invalid");
      const currentCount = await deviceSentEventCount(env, userId, deviceId);
      if (currentCount !== checkpoint.sent_event_count) throw new HttpError(409, "This backup predates messages sent by this device and cannot safely restore its MLS state", "backup_stale");
      const consumed = await db.updateTable("device_backup_checkpoints").set({ consumed_at: now })
        .where("checkpoint_hash", "=", checkpointHash).where("consumed_at", "is", null).executeTakeFirst();
      if (consumed.numUpdatedRows !== 1n) throw new HttpError(409, "This backup was restored concurrently", "backup_checkpoint_invalid");
      issuedDeviceCredential = randomId(32);
      await batch(env.DB, [
        db.updateTable("devices").set({ device_credential_hash: await sha256(issuedDeviceCredential), last_seen_at: now }).where("device_id", "=", deviceId),
        db.deleteFrom("sessions").where("device_id", "=", deviceId),
        db.deleteFrom("ws_tickets").where("device_id", "=", deviceId),
      ]);
      const roomIds = await db.selectFrom("room_devices").select("room_id").where("device_id", "=", deviceId).where("removed_at", "is", null).execute();
      await Promise.all(roomIds.map((room) => env.ROOMS.getByName(room.room_id).revokeDevice(deviceId)));
    } else {
      if (existing.device_credential_hash && (!deviceCredential || await sha256(deviceCredential) !== existing.device_credential_hash)) {
        throw new HttpError(403, "This device requires its possession credential", "device_credential_required");
      }
      if (!existing.device_credential_hash) issuedDeviceCredential = randomId(32);
    }
    await batch(env.DB, [
      db.updateTable("devices").set({ last_seen_at: now, ...(issuedDeviceCredential ? { device_credential_hash: await sha256(issuedDeviceCredential) } : {}) }).where("device_id", "=", deviceId),
      ...(await keyPackageInserts(db, deviceId, packages, now)),
    ]);
  }
  const token = await createSession(env, userId, deviceId);
  await clearLoginFailures(env, userId);
  return json({ access_token: token, user_id: userId, device_id: deviceId, display_name: user.display_name, avatar_url: avatarUrl(user.avatar_id), server_name: env.SERVER_NAME, ...sessionCapabilities(env), ...(issuedDeviceCredential ? { device_credential: issuedDeviceCredential } : {}) });
}

async function issuePasskeyAuthenticationOptions(request: Request, env: Env): Promise<Response> {
  const preview = await readJson(request.clone() as unknown as Request, 2_048);
  await limitUnauthenticatedRequest(request, env, "passkey", typeof preview.user_id === "string" ? preview.user_id : "missing");
  return passkeyAuthenticationOptions(request, env);
}

async function loginWithPasskey(request: Request, env: Env): Promise<Response> {
  const preview = await readJson(request.clone() as unknown as Request, 256_000);
  await limitUnauthenticatedRequest(request, env, "passkey", typeof preview.user_id === "string" ? preview.user_id : "missing");
  const result = await authenticatePasskey(request, env);
  await clearLoginFailures(env, result.user_id);
  return establishDeviceSession(env, result.user_id as UserId, result, result.device, false, false);
}

async function issueDeviceSessionChallenge(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request, 2_048);
  const deviceId = stringField(body, "device_id", 96);
  const credential = stringField(body, "device_credential", 128);
  await limitUnauthenticatedRequest(request, env, "device-session", deviceId);
  const now = Date.now(); const expiresAt = now + DEVICE_SESSION_CHALLENGE_MS;
  const challenge: DeviceSessionChallenge = {
    version: 1, challenge_id: randomId(18), device_id: deviceId,
    challenge: randomId(32), expires_at: expiresAt, server_name: env.SERVER_NAME,
  };
  const db = createDatabase(env.DB);
  const eligible = /^[A-Za-z0-9_-]{32,128}$/.test(credential)
    ? await db.selectFrom("devices as d").innerJoin("users as u", "u.user_id", "d.user_id")
      .select("d.device_id").where("d.device_id", "=", deviceId).where("d.kind", "=", "user")
      .where("d.device_credential_hash", "=", await sha256(credential)).where("d.revoked_at", "is", null)
      .where("u.deletion_requested_at", "is", null).where("u.deleted_at", "is", null).executeTakeFirst()
    : null;
  const challengeHash = await sha256(challenge.challenge);
  if (eligible) {
    await db.insertInto("device_session_challenges").values({
      challenge_id: challenge.challenge_id, device_id: deviceId, challenge_hash: challengeHash,
      created_at: now, expires_at: expiresAt,
    }).onConflict((conflict) => conflict.column("device_id").doUpdateSet({
      challenge_id: challenge.challenge_id, challenge_hash: challengeHash,
      created_at: now, expires_at: expiresAt,
    })).execute();
  }
  // Unknown, revoked, and credential-less devices receive the same shape but no
  // D1 row. Only a holder of both possession factors can complete the proof.
  return json({ challenge }, 201);
}

async function claimDeviceSession(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request, 4_096);
  const deviceId = stringField(body, "device_id", 96);
  const credential = stringField(body, "device_credential", 128);
  const challengeId = stringField(body, "challenge_id", 64);
  const challengeSecret = stringField(body, "challenge", 128);
  const signature = stringField(body, "signature", 512);
  await limitUnauthenticatedRequest(request, env, "device-session", deviceId);
  const invalid = () => { throw new HttpError(401, "Device proof is invalid or expired", "invalid_device_proof"); };
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(challengeId) || !/^[A-Za-z0-9_-]{32,128}$/.test(challengeSecret)
    || !/^[A-Za-z0-9_-]{32,128}$/.test(credential) || !exactBase64UrlBytes(signature, 64)) return invalid();
  const now = Date.now(); const db = createDatabase(env.DB);
  const proof = await db.selectFrom("device_session_challenges as c")
    .innerJoin("devices as d", "d.device_id", "c.device_id").innerJoin("users as u", "u.user_id", "d.user_id")
    .select(["c.challenge_id", "c.device_id", "c.expires_at", "d.user_id", "d.signing_key", "u.display_name", "u.avatar_id"])
    .where("c.challenge_id", "=", challengeId).where("c.device_id", "=", deviceId)
    .where("c.challenge_hash", "=", await sha256(challengeSecret)).where("c.expires_at", ">", now)
    .where("d.device_credential_hash", "=", await sha256(credential)).where("d.kind", "=", "user").where("d.revoked_at", "is", null)
    .where("u.deletion_requested_at", "is", null).where("u.deleted_at", "is", null).executeTakeFirst();
  if (!proof) return invalid();
  const challenge: DeviceSessionChallenge = {
    version: 1, challenge_id: proof.challenge_id, device_id: proof.device_id,
    challenge: challengeSecret, expires_at: proof.expires_at, server_name: env.SERVER_NAME,
  };
  try {
    const key = await crypto.subtle.importKey("jwk", JSON.parse(proof.signing_key) as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64url(signature), deviceSessionProofBytes(challenge)))) return invalid();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return invalid();
  }
  const consumed = await db.deleteFrom("device_session_challenges").where("challenge_id", "=", challengeId)
    .where("device_id", "=", deviceId).where("challenge_hash", "=", await sha256(challengeSecret)).where("expires_at", ">", Date.now()).executeTakeFirst();
  if (consumed.numDeletedRows !== 1n) return invalid();
  await db.updateTable("devices").set({ last_seen_at: now }).where("device_id", "=", deviceId).execute();
  const token = await createSession(env, proof.user_id, deviceId);
  return json({ access_token: token, user_id: proof.user_id, device_id: deviceId, display_name: proof.display_name,
    avatar_url: avatarUrl(proof.avatar_id), server_name: env.SERVER_NAME, ...sessionCapabilities(env) });
}

export async function cleanupExpiredDeviceSessionChallenges(env: Env, now = Date.now()): Promise<number> {
  const result = await createDatabase(env.DB).deleteFrom("device_session_challenges").where("expires_at", "<=", now).executeTakeFirst();
  return Number(result.numDeletedRows);
}

function samePublicKey(stored: string, candidate: string): boolean {
  try {
    const left = JSON.parse(stored) as JsonWebKey; const right = JSON.parse(candidate) as JsonWebKey;
    return left.kty === right.kty && left.crv === right.crv && left.x === right.x && left.y === right.y;
  } catch { return false; }
}

async function deviceSentEventCount(env: Env, userId: UserId, deviceId: string): Promise<number> {
  const db = createDatabase(env.DB);
  const row = await db.selectFrom("room_events").select(db.fn.countAll<number>().as("count"))
    .where("sender", "=", userId).where("device_id", "=", deviceId).executeTakeFirst();
  return Number(row?.count ?? 0);
}

async function createBackupCheckpoint(env: Env, auth: AuthContext): Promise<Response> {
  requireUser(auth);
  const db = createDatabase(env.DB); const checkpoint = randomId(32); const deviceCredential = randomId(32); const createdAt = Date.now();
  const previous = await db.selectFrom("device_backup_checkpoints").select("checkpoint_hash")
    .where("device_id", "=", auth.deviceId).orderBy("created_at", "desc").limit(20).execute();
  await batch(env.DB, [
    db.insertInto("device_backup_checkpoints").values({
      checkpoint_hash: await sha256(checkpoint), user_id: auth.userId, device_id: auth.deviceId,
      sent_event_count: await deviceSentEventCount(env, auth.userId, auth.deviceId), created_at: createdAt, consumed_at: null,
    }),
    db.updateTable("devices").set({ device_credential_hash: await sha256(deviceCredential) }).where("device_id", "=", auth.deviceId).where("user_id", "=", auth.userId),
    ...previous.slice(4).map((item) => db.deleteFrom("device_backup_checkpoints").where("checkpoint_hash", "=", item.checkpoint_hash)),
  ]);
  return json({ checkpoint, device_credential: deviceCredential, created_at: createdAt }, 201);
}

async function checkBackupRestore(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const userId = stringField(body, "user_id", 128).toLowerCase() as UserId;
  assertLocalId(userId, "@", env);
  const password = stringField(body, "password", 256);
  const deviceId = stringField(body, "device_id", 96);
  const checkpoint = stringField(body, "backup_checkpoint", 128);
  const signingKey = stringField(body, "signing_key", 2_000);
  const encryptionKey = stringField(body, "encryption_key", 2_000);
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(checkpoint)) throw new HttpError(400, "Invalid backup checkpoint", "backup_checkpoint_invalid");
  const db = createDatabase(env.DB);
  const [user, device, stored] = await Promise.all([
    db.selectFrom("users").select(["password_hash", "password_salt", "deletion_requested_at", "deleted_at"]).where("user_id", "=", userId).executeTakeFirst(),
    db.selectFrom("devices").select(["user_id", "signing_key", "encryption_key", "revoked_at"]).where("device_id", "=", deviceId).executeTakeFirst(),
    db.selectFrom("device_backup_checkpoints").select(["sent_event_count", "consumed_at"]).where("checkpoint_hash", "=", await sha256(checkpoint)).where("user_id", "=", userId).where("device_id", "=", deviceId).executeTakeFirst(),
  ]);
  if (!user || user.deletion_requested_at !== null || user.deleted_at !== null || !(await verifyPassword(password, user.password_hash, user.password_salt))) {
    throw new HttpError(401, "Invalid user ID or password", "invalid_credentials");
  }
  if (!device || device.user_id !== userId || device.revoked_at !== null || !samePublicKey(device.signing_key, signingKey) || !samePublicKey(device.encryption_key, encryptionKey)) {
    throw new HttpError(403, "Backup device is no longer valid", "backup_device_invalid");
  }
  if (!stored || stored.consumed_at !== null) throw new HttpError(409, "This backup has already been restored or is no longer valid", "backup_checkpoint_invalid");
  if (await deviceSentEventCount(env, userId, deviceId) !== stored.sent_event_count) {
    throw new HttpError(409, "This backup predates messages sent by this device and cannot safely restore its MLS state", "backup_stale");
  }
  return json({ valid: true });
}

async function listDevices(env: Env, userId: string): Promise<Response> {
  const rows = await createDatabase(env.DB).selectFrom("devices as d").innerJoin("users as u", "u.user_id", "d.user_id")
    .select(["d.device_id", "d.user_id", "d.display_name", "d.kind", "d.signing_key", "d.encryption_key", "d.created_at", "d.revoked_at"])
    .where("d.user_id", "=", userId).where("u.deletion_requested_at", "is", null).where("u.deleted_at", "is", null).orderBy("d.created_at").execute();
  return json({ devices: rows.map((row) => ({ ...row, signing_key: JSON.parse(row.signing_key), encryption_key: JSON.parse(row.encryption_key) })) });
}

async function listRoomDevices(env: Env, auth: AuthContext, roomId: RoomId): Promise<Response> {
  if (!(await memberRole(env, roomId, auth.userId))) throw new HttpError(404, "Room not found", "not_found");
  const rows = await createDatabase(env.DB).selectFrom("room_devices as rd")
    .innerJoin("devices as d", "d.device_id", "rd.device_id")
    .innerJoin("users as u", "u.user_id", "rd.user_id")
    .select(["rd.device_id", "rd.user_id", "d.display_name", "d.kind", "d.signing_key", "d.encryption_key", "d.created_at", "d.revoked_at"])
    .where("rd.removed_at", "is", null).where("d.revoked_at", "is", null)
    .where("u.deletion_requested_at", "is", null).where("u.deleted_at", "is", null)
    .orderBy("rd.device_id").limit(1_001).execute();
  if (rows.length > 1_000) throw new HttpError(409, "Room has too many devices to archive", "archive_device_limit");
  return json({ devices: rows.map((row) => ({ ...row, signing_key: JSON.parse(row.signing_key) as JsonWebKey, encryption_key: JSON.parse(row.encryption_key) as JsonWebKey })) });
}

async function listRoomSigningKeys(env: Env, auth: AuthContext, roomId: RoomId): Promise<Response> {
  if (!(await memberRole(env, roomId, auth.userId))) throw new HttpError(404, "Room not found", "not_found");
  const rows = await createDatabase(env.DB).selectFrom("room_devices as rd")
    .innerJoin("devices as d", "d.device_id", "rd.device_id")
    .select(["rd.device_id", "rd.user_id", "d.signing_key"])
    .orderBy("rd.device_id").limit(1_001).execute();
  if (rows.length > 1_000) throw new HttpError(409, "Room has too many historical device keys", "room_device_limit");
  return json({ keys: rows.map((row) => ({ ...row, signing_key: JSON.parse(row.signing_key) as JsonWebKey })) });
}

async function registerDevice(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const body = await readJson(request);
  const deviceId = stringField(body, "device_id", 96);
  const displayName = stringField(body, "display_name", 60);
  const signingKey = stringField(body, "signing_key", 2_000);
  const encryptionKey = stringField(body, "encryption_key", 2_000);
  const packages = mlsKeyPackages(body);
  await validatePublicKeys(signingKey, encryptionKey);
  const now = Date.now();
  const db = createDatabase(env.DB);
  await batch(env.DB, [
    db.insertInto("devices").values({ device_id: deviceId, user_id: auth.userId, display_name: displayName, signing_key: signingKey, encryption_key: encryptionKey, created_at: now, last_seen_at: now, revoked_at: null }),
    ...(await keyPackageInserts(db, deviceId, packages, now)),
    db.insertInto("sync_log").values({ recipient_user_id: auth.userId, kind: "device.event", room_id: null, seq: null, event_id: null, payload: JSON.stringify({ type: "device.added", device_id: deviceId }), created_at: now }),
  ]);
  return json({ device_id: deviceId }, 201);
}

type DeviceLinkStatus = "pending" | "awaiting_packages" | "approved" | "complete" | "claimed" | "cancelled";

async function deviceLinkHistoryTransfer(env: Env, linkId: string) {
  const db = createDatabase(env.DB);
  const transfer = await db.selectFrom("device_link_history_transfers").selectAll().where("link_id", "=", linkId).executeTakeFirst();
  if (!transfer) return null;
  const shards = await db.selectFrom("device_link_history_shards").select(["shard_index", "ciphertext_bytes", "status"])
    .where("link_id", "=", linkId).orderBy("shard_index").execute();
  return {
    transfer_id: transfer.transfer_id,
    source_device_id: transfer.source_device_id,
    plaintext_bytes: transfer.plaintext_bytes,
    shard_plaintext_bytes: transfer.shard_plaintext_bytes,
    shard_count: transfer.shard_count,
    ready_shards: shards.filter((shard) => shard.status === "ready").map((shard) => shard.shard_index),
    acked_shards: shards.filter((shard) => shard.status === "acked").map((shard) => shard.shard_index),
    ciphertext_bytes: shards.reduce((total, shard) => total + (shard.status === "ready" ? shard.ciphertext_bytes : 0), 0),
  };
}

async function stageAbandonedDeviceLinkRevocation(env: Env, link: {
  link_id: string; user_id: string | null; device_id: string; approved_by_device_id: string | null;
}, now: number, reason: "expired" | "cancelled"): Promise<void> {
  if (!link.user_id || !link.approved_by_device_id) return;
  const db = createDatabase(env.DB);
  const device = await db.selectFrom("devices").select(["device_id", "revoked_at"])
    .where("device_id", "=", link.device_id).where("user_id", "=", link.user_id).executeTakeFirst();
  if (!device) return;
  const existing = await db.selectFrom("device_revocations").select("revocation_id")
    .where("target_device_id", "=", link.device_id).where("user_id", "=", link.user_id)
    .where("status", "!=", "complete").executeTakeFirst();
  if (existing) return;
  const rooms = await db.selectFrom("room_devices as rd").innerJoin("rooms as r", "r.room_id", "rd.room_id")
    .innerJoin("room_members as rm", (join) => join.onRef("rm.room_id", "=", "rd.room_id").onRef("rm.user_id", "=", "rd.user_id"))
    .select(["rd.room_id", "r.mls_epoch"]).where("rd.device_id", "=", link.device_id).where("rd.user_id", "=", link.user_id)
    .where("rd.removed_at", "is", null).where("rm.removed_at", "is", null).orderBy("rd.room_id").execute();
  // A cancellation can win immediately before an already-authorized RoomDO
  // append finishes. The first zero-room revocation then completes, but the
  // late Add still needs a fresh durable Remove job.
  if (device.revoked_at !== null && !rooms.length) return;
  const revocationId = randomId(18);
  try {
    await batch(env.DB, [
      db.insertInto("device_revocations").values({ revocation_id: revocationId, user_id: link.user_id,
        target_device_id: link.device_id, requested_by_device_id: link.approved_by_device_id,
        status: "pending", created_at: now, updated_at: now, completed_at: null }),
      ...rooms.map((room) => db.insertInto("device_revocation_rooms").values({ revocation_id: revocationId,
        room_id: room.room_id, expected_epoch: room.mls_epoch + 1, status: "pending", event_id: null, updated_at: now })),
      ...(rooms.length ? [db.insertInto("sync_log").values({ recipient_user_id: link.user_id, kind: "device.event",
        room_id: null, seq: null, event_id: null,
        payload: JSON.stringify({ type: `device.link.${reason}`, device_id: link.device_id, revocation_id: revocationId }), created_at: now })] : []),
    ]);
  } catch (error) {
    // Another room membership operation may temporarily own one of the room
    // serialization slots. The link is already unusable; cron retries the
    // durable revocation job without extending the capability lifetime.
    if (error instanceof Error && error.message.includes("UNIQUE")) return;
    throw error;
  }
  if (!rooms.length) await finalizeDeviceRevocation(env, revocationId);
  logSecurityEvent("info", `security.device_link.${reason}`, { rooms: rooms.length });
}

async function abandonDeviceLink(env: Env, linkId: string, reason: "expired" | "cancelled", now = Date.now()): Promise<boolean> {
  const db = createDatabase(env.DB);
  let link = await db.selectFrom("device_links").selectAll().where("link_id", "=", linkId).executeTakeFirst();
  if (!link || link.status === "claimed" || (reason === "expired" && link.expires_at > now)) return false;
  let changed = false;
  if (link.status !== "cancelled") {
    let cancellation = db.updateTable("device_links").set({ status: "cancelled", updated_at: now }).where("link_id", "=", linkId)
      .where("status", "in", ["pending", "awaiting_packages", "approved", "complete"]);
    if (reason === "expired") cancellation = cancellation.where("expires_at", "<=", now);
    const [cancelled] = await batch(env.DB, [
      cancellation,
      db.deleteFrom("device_link_rooms").where("link_id", "=", linkId).where("status", "=", "pending"),
    ]);
    changed = cancelled.numAffectedRows === 1n;
    link = await db.selectFrom("device_links").selectAll().where("link_id", "=", linkId).executeTakeFirst();
    if (!link || link.status === "claimed" || link.status !== "cancelled") return false;
  }
  await stageAbandonedDeviceLinkRevocation(env, link, now, reason);
  await removeDeviceLinkHistory(env, link);
  await removeDeviceLinkHistoryShards(env, link.link_id, link.user_id);
  return changed;
}

async function expireDeviceLink(env: Env, linkId: string, now = Date.now()): Promise<boolean> {
  return abandonDeviceLink(env, linkId, "expired", now);
}

async function cancelDeviceLinkBySecret(request: Request, env: Env, linkId: string): Promise<Response> {
  const db = createDatabase(env.DB);
  const link = await db.selectFrom("device_links").select(["link_id", "status"])
    .where("link_id", "=", linkId).where("secret_hash", "=", await sha256(deviceLinkSecret(request))).executeTakeFirst();
  if (!link) throw new HttpError(404, "Device link not found", "not_found");
  if (link.status === "claimed") throw new HttpError(409, "Claimed devices must be revoked", "device_link_claimed");
  await abandonDeviceLink(env, linkId, "cancelled");
  return new Response(null, { status: 204 });
}

async function cancelDeviceLinkForAccount(env: Env, auth: AuthContext, linkId: string): Promise<Response> {
  requireUser(auth);
  const link = await createDatabase(env.DB).selectFrom("device_links").select(["user_id", "status"])
    .where("link_id", "=", linkId).executeTakeFirst();
  // Possession of the unapproved link ID already authorizes approveDeviceLink;
  // allow the same source-side recovery surface to cancel if approval never
  // reached the Worker. Once associated, only that account may cancel it.
  if (!link || (link.user_id !== null && link.user_id !== auth.userId)) throw new HttpError(404, "Device link not found", "not_found");
  if (link.status === "claimed") throw new HttpError(409, "Claimed devices must be revoked", "device_link_claimed");
  await abandonDeviceLink(env, linkId, "cancelled");
  return new Response(null, { status: 204 });
}

function deviceLinkSecret(request: Request): string {
  const secret = request.headers.get("x-device-link-secret") ?? "";
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(secret)) throw new HttpError(401, "Device link secret required", "invalid_link_secret");
  return secret;
}

async function deviceLinkBySecret(request: Request, env: Env, linkId: string) {
  const db = createDatabase(env.DB);
  const link = await db.selectFrom("device_links").selectAll().where("link_id", "=", linkId)
    .where("secret_hash", "=", await sha256(deviceLinkSecret(request))).executeTakeFirst();
  if (!link) throw new HttpError(404, "Device link not found", "not_found");
  if (link.expires_at <= Date.now() && link.status !== "claimed") {
    await expireDeviceLink(env, linkId);
    throw new HttpError(410, "Device link expired", "device_link_expired");
  }
  return link;
}

function linkPackages(body: Record<string, unknown>): string[] {
  const values = body.mls_key_packages;
  if (!Array.isArray(values) || values.length < 1 || values.length > 128 || values.some((value) => typeof value !== "string" || value.length < 16 || value.length > 100_000)) {
    throw new HttpError(400, "Invalid MLS KeyPackages", "invalid_key_packages");
  }
  return Array.from(new Set(values as string[]));
}

async function insertDeviceLinkPackages(env: Env, linkId: string, packages: string[]): Promise<void> {
  const db = createDatabase(env.DB);
  const row = await db.selectFrom("device_link_key_packages").select(sql<number>`coalesce(max(ordinal), -1)`.as("last")).where("link_id", "=", linkId).executeTakeFirstOrThrow();
  const now = Date.now();
  try {
    await batch(env.DB, await Promise.all(packages.map(async (keyPackage, index) => db.insertInto("device_link_key_packages").values({
      link_id: linkId, ordinal: Number(row.last) + index + 1, key_package: keyPackage,
      key_package_fingerprint: await sha256(keyPackage), created_at: now,
    }).onConflict((conflict) => conflict.column("key_package_fingerprint").doNothing()))));
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) throw new HttpError(409, "MLS KeyPackage already belongs to another link", "key_package_reused");
    throw error;
  }
}

async function createDeviceLink(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request, 2_000_000);
  const deviceId = stringField(body, "device_id", 96);
  const displayName = stringField(body, "display_name", 60).trim();
  const signingKey = stringField(body, "signing_key", 2_000);
  const encryptionKey = stringField(body, "encryption_key", 2_000);
  const packages = linkPackages(body);
  await validatePublicKeys(signingKey, encryptionKey);
  const linkId = randomId(18); const secret = randomId(32); const now = Date.now();
  const db = createDatabase(env.DB);
  const existingDevice = await db.selectFrom("devices").select("device_id").where("device_id", "=", deviceId).executeTakeFirst();
  if (existingDevice) throw new HttpError(409, "Device ID already exists", "already_exists");
  try {
    await db.insertInto("device_links").values({
      link_id: linkId, secret_hash: await sha256(secret), device_id: deviceId, display_name: displayName,
      signing_key: signingKey, encryption_key: encryptionKey, user_id: null, approved_by_device_id: null,
      status: "pending", required_packages: 0, claim_token_hash: null, created_at: now,
      expires_at: now + DEVICE_LINK_PENDING_MS, updated_at: now, completed_at: null, claimed_at: null,
    }).execute();
    await insertDeviceLinkPackages(env, linkId, packages);
  } catch (error) {
    await db.deleteFrom("device_links").where("link_id", "=", linkId).execute().catch(() => undefined);
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.message.includes("UNIQUE")) throw new HttpError(409, "Device link already exists", "already_exists");
    throw error;
  }
  return json({ link_id: linkId, secret, expires_at: now + DEVICE_LINK_PENDING_MS, server_name: env.SERVER_NAME }, 201);
}

async function deviceLinkStatus(request: Request, env: Env, linkId: string): Promise<Response> {
  const link = await deviceLinkBySecret(request, env, linkId);
  const db = createDatabase(env.DB);
  const account = link.user_id ? await db.selectFrom("users").select("account_mode").where("user_id", "=", link.user_id).executeTakeFirst() : null;
  const rooms = link.user_id ? await db.selectFrom("device_link_rooms as dlr").innerJoin("rooms as r", "r.room_id", "dlr.room_id")
    .select(["dlr.room_id", "dlr.expected_epoch", "dlr.status", "dlr.encrypted_state", "r.name", "r.kind", "r.purpose"])
    .where("dlr.link_id", "=", linkId).orderBy("dlr.room_id").execute() : [];
  const transfer = await deviceLinkHistoryTransfer(env, linkId);
  return json({
    link_id: link.link_id, device_id: link.device_id, status: link.status as DeviceLinkStatus,
    required_packages: link.required_packages, expires_at: link.expires_at,
    history_transfer: transfer,
    account_credential_ready: Boolean(link.account_credential_envelope && link.account_credential_source_device_id),
    account_mode: account?.account_mode,
    ...(link.account_credential_envelope && link.account_credential_source_device_id ? {
      account_credential: { envelope: link.account_credential_envelope, source_device_id: link.account_credential_source_device_id },
    } : {}),
    ...(link.status === "complete" || link.status === "claimed" ? { user_id: link.user_id, rooms } : { room_count: rooms.length }),
  });
}

async function previewDeviceLink(env: Env, auth: AuthContext, linkId: string): Promise<Response> {
  requireUser(auth);
  const db = createDatabase(env.DB);
  const link = await db.selectFrom("device_links")
    .select(["link_id", "device_id", "display_name", "signing_key", "encryption_key", "user_id", "approved_by_device_id", "status", "required_packages", "expires_at", "account_credential_envelope"])
    .where("link_id", "=", linkId).executeTakeFirst();
  if (!link || link.status === "cancelled") throw new HttpError(404, "Device link not found", "not_found");
  if (link.user_id && link.user_id !== auth.userId) throw new HttpError(404, "Device link not found", "not_found");
  if (link.expires_at <= Date.now() && link.status !== "claimed") {
    await expireDeviceLink(env, linkId);
    throw new HttpError(410, "Device link expired", "device_link_expired");
  }
  if (link.status === "approved") {
    await env.DB.prepare(`
      UPDATE device_link_rooms
      SET expected_epoch = (SELECT rooms.mls_epoch + 1 FROM rooms WHERE rooms.room_id = device_link_rooms.room_id), updated_at = ?
      WHERE link_id = ? AND status = 'pending'
    `).bind(Date.now(), linkId).run();
  }
  const rooms = link.user_id ? await db.selectFrom("device_link_rooms as dlr").innerJoin("rooms as r", "r.room_id", "dlr.room_id")
    .select(["dlr.room_id", "dlr.key_package", "dlr.expected_epoch", "dlr.status", "dlr.event_id", "r.name", "r.kind", "r.purpose"])
    .where("dlr.link_id", "=", linkId).orderBy("dlr.room_id").execute() : [];
  const { account_credential_envelope: accountCredentialEnvelope, ...publicLink } = link;
  const transfer = await deviceLinkHistoryTransfer(env, linkId);
  const account = link.user_id ? await db.selectFrom("users").select("account_mode").where("user_id", "=", link.user_id).executeTakeFirst() : null;
  return json({ ...publicLink, account_credential_ready: Boolean(accountCredentialEnvelope), account_mode: account?.account_mode,
    history_transfer: transfer, signing_key: JSON.parse(link.signing_key), encryption_key: JSON.parse(link.encryption_key), rooms });
}

async function uploadDeviceLinkAccountCredential(request: Request, env: Env, auth: AuthContext, linkId: string): Promise<Response> {
  requireUser(auth);
  const body = await readJson(request, 8_192);
  const envelope = stringField(body, "envelope", 4_096);
  if (!/^[A-Za-z0-9_-]{128,4096}$/.test(envelope)) throw new HttpError(400, "Invalid account credential envelope", "invalid_account_credential_envelope");
  const db = createDatabase(env.DB);
  const link = await db.selectFrom("device_links").select(["user_id", "device_id", "approved_by_device_id", "status", "expires_at", "account_credential_envelope", "account_credential_source_device_id"])
    .where("link_id", "=", linkId).executeTakeFirst();
  if (!link || link.user_id !== auth.userId || link.approved_by_device_id !== auth.deviceId || link.device_id === auth.deviceId
    || !["awaiting_packages", "approved", "complete"].includes(link.status)) throw new HttpError(404, "Device link not found", "not_found");
  if (link.expires_at <= Date.now()) {
    await expireDeviceLink(env, linkId);
    throw new HttpError(410, "Device link expired", "device_link_expired");
  }
  if (link.account_credential_envelope) {
    if (link.account_credential_envelope !== envelope || link.account_credential_source_device_id !== auth.deviceId) {
      throw new HttpError(409, "A different account credential envelope is already attached", "account_credential_conflict");
    }
    return json({ ready: true, source_device_id: auth.deviceId });
  }
  const updated = await db.updateTable("device_links").set({ account_credential_envelope: envelope,
    account_credential_source_device_id: auth.deviceId, updated_at: Date.now() })
    .where("link_id", "=", linkId).where("account_credential_envelope", "is", null).executeTakeFirst();
  if (updated.numUpdatedRows !== 1n) throw new HttpError(409, "Account credential envelope changed concurrently", "account_credential_conflict");
  return json({ ready: true, source_device_id: auth.deviceId }, 201);
}

async function createDeviceLinkHistoryTransfer(request: Request, env: Env, auth: AuthContext, linkId: string): Promise<Response> {
  requireUser(auth);
  const body = await readJson(request, 8_192);
  const transferId = stringField(body, "transfer_id", 96);
  const plaintextBytes = requiredPositiveSafeInteger(body, "plaintext_bytes");
  const shardPlaintextBytes = requiredPositiveSafeInteger(body, "shard_plaintext_bytes");
  const shardCount = requiredPositiveSafeInteger(body, "shard_count");
  if (!/^[A-Za-z0-9_-]{16,96}$/.test(transferId) || shardPlaintextBytes < 1024 * 1024 || shardPlaintextBytes > 32 * 1024 * 1024
    || shardCount > DEVICE_LINK_HISTORY_MAX_SHARDS || shardCount !== Math.ceil(plaintextBytes / shardPlaintextBytes)) {
    throw new HttpError(400, "Invalid device history manifest", "invalid_history_manifest");
  }
  const db = createDatabase(env.DB);
  const link = await db.selectFrom("device_links").select(["user_id", "device_id", "status", "expires_at"]).where("link_id", "=", linkId).executeTakeFirst();
  if (!link || link.user_id !== auth.userId || !["approved", "complete"].includes(link.status)) throw new HttpError(404, "Device link not found", "not_found");
  if (link.expires_at <= Date.now()) {
    await expireDeviceLink(env, linkId);
    throw new HttpError(410, "Device link expired", "device_link_expired");
  }
  const existing = await db.selectFrom("device_link_history_transfers").selectAll().where("link_id", "=", linkId).executeTakeFirst();
  if (existing) {
    const same = existing.transfer_id === transferId && existing.source_device_id === auth.deviceId && existing.plaintext_bytes === plaintextBytes
      && existing.shard_plaintext_bytes === shardPlaintextBytes && existing.shard_count === shardCount;
    if (!same) throw new HttpError(409, "A different history snapshot is already being transferred", "history_transfer_conflict");
    return json({ transfer: await deviceLinkHistoryTransfer(env, linkId) });
  }
  const now = Date.now();
  await db.insertInto("device_link_history_transfers").values({ link_id: linkId, transfer_id: transferId, user_id: auth.userId,
    source_device_id: auth.deviceId, plaintext_bytes: plaintextBytes, shard_plaintext_bytes: shardPlaintextBytes, shard_count: shardCount,
    created_at: now, updated_at: now }).execute();
  return json({ transfer: await deviceLinkHistoryTransfer(env, linkId) }, 201);
}

async function uploadDeviceLinkHistoryShard(request: Request, env: Env, auth: AuthContext, linkId: string, shardIndex: number): Promise<Response> {
  requireUser(auth);
  const declaredSize = Number(request.headers.get("content-length"));
  const suppliedDigest = requestContentSha256(request, "invalid_device_history_digest");
  if (!request.body || !Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > DEVICE_LINK_HISTORY_SHARD_MAX_BYTES) {
    throw new HttpError(413, "Device history shard is too large", "device_history_too_large");
  }
  if (!suppliedDigest) throw new HttpError(400, "Ciphertext SHA-256 required for device history shards", "device_history_digest_required");
  const db = createDatabase(env.DB);
  const transfer = await db.selectFrom("device_link_history_transfers as transfer")
    .innerJoin("device_links as link", "link.link_id", "transfer.link_id")
    .selectAll("transfer").select(["link.status as link_status", "link.expires_at as link_expires_at", "link.device_id as target_device_id"])
    .where("transfer.link_id", "=", linkId).executeTakeFirst();
  if (!transfer || transfer.user_id !== auth.userId || transfer.source_device_id !== auth.deviceId || !Number.isSafeInteger(shardIndex) || shardIndex < 0 || shardIndex >= transfer.shard_count) {
    throw new HttpError(404, "Device history transfer not found", "not_found");
  }
  if (transfer.link_status !== "approved" && transfer.link_status !== "complete") throw new HttpError(404, "Device history transfer not found", "not_found");
  if (transfer.link_expires_at <= Date.now()) {
    await expireDeviceLink(env, linkId);
    throw new HttpError(410, "Device link expired", "device_link_expired");
  }
  const existing = await db.selectFrom("device_link_history_shards").selectAll().where("link_id", "=", linkId).where("shard_index", "=", shardIndex).executeTakeFirst();
  const matchesCommitted = (row: { ciphertext_bytes: number; ciphertext_sha256: string | null }): boolean => (
    row.ciphertext_bytes === declaredSize && row.ciphertext_sha256 === suppliedDigest.text
  );
  if (existing) {
    await request.body.cancel().catch(() => undefined);
    if (!matchesCommitted(existing)) throw new HttpError(409, "Device history shard index is already in use", "device_history_shard_conflict");
    return json({ ready: true, index: shardIndex, bytes: existing.ciphertext_bytes, status: existing.status });
  }
  const objectKey = `device-links/${linkId}/${transfer.transfer_id}/${String(shardIndex).padStart(4, "0")}.bin`;
  const pending = { object_key: objectKey, owner_user_id: auth.userId, kind: "archive" as const, expected_bytes: declaredSize, content_sha256: suppliedDigest.text };
  let reservationCreated: boolean;
  try { reservationCreated = await stageIdempotentR2Write(env, pending); }
  catch (error) { await request.body.cancel().catch(() => undefined); throw error; }
  let releaseReservation = false;
  const metadata = { link_id: linkId, transfer_id: transfer.transfer_id, target_device_id: transfer.target_device_id,
    shard_index: String(shardIndex), sha256: suppliedDigest.text };
  const matchesStored = (object: ObjectStoreObject): boolean => object.size === declaredSize
    && object.metadata.link_id === metadata.link_id && object.metadata.transfer_id === metadata.transfer_id
    && object.metadata.target_device_id === metadata.target_device_id && object.metadata.shard_index === metadata.shard_index
    && object.metadata.sha256 === suppliedDigest.text;
  try {
    let object: ObjectStoreObject | null = null;
    if (!reservationCreated) {
      try { object = await objectStore(env).head(objectKey); }
      catch (error) { await request.body.cancel(error).catch(() => undefined); throw error; }
      if (object && !matchesStored(object)) {
        await request.body.cancel("device history shard conflict").catch(() => undefined);
        throw new HttpError(409, "Device history shard index is already in use", "device_history_shard_conflict");
      }
      if (object) await request.body.cancel("device history shard already uploaded").catch(() => undefined);
    }
    if (!object) {
      const limited = exactLengthUploadStream(request.body, declaredSize);
      try {
        object = (await Promise.all([
          objectStore(env).put(objectKey, limited.body, { ifAbsent: true, expectedSize: declaredSize,
            checksumSha256: suppliedDigest.bytes, contentType: "application/vnd.edgechat.device-history-shard", metadata }),
          limited.completed,
        ]))[0];
      } catch (error) {
        if (error instanceof ObjectStoreChecksumMismatchError) { releaseReservation = true; throw new HttpError(400, "Device history shard digest mismatch", "invalid_device_history_digest"); }
        if (isFixedLengthMismatch(error)) { releaseReservation = true; throw new HttpError(400, "Device history shard length mismatch", "invalid_device_history_length"); }
        throw error;
      }
      if (!object || !matchesStored(object)) {
        if (object) { releaseReservation = true; throw new HttpError(400, "Device history shard length or digest mismatch", "invalid_device_history_digest"); }
        const recovered = await objectStore(env).head(objectKey);
        if (!recovered || !matchesStored(recovered)) {
          releaseReservation = true;
          throw new HttpError(409, "Device history shard index is already in use", "device_history_shard_conflict");
        }
        object = recovered;
      }
    }
    const liveClaim = await db.selectFrom("pending_r2_writes").select(["object_key", "owner_user_id", "kind", "expected_bytes", "room_id", "content_sha256", "cancelled_at"])
      .where("object_key", "=", objectKey).executeTakeFirst();
    if (!liveClaim) {
      const landed = await db.selectFrom("device_link_history_shards").select(["ciphertext_bytes", "ciphertext_sha256", "status"])
        .where("link_id", "=", linkId).where("shard_index", "=", shardIndex).executeTakeFirst();
      if (landed && matchesCommitted(landed)) return json({ ready: true, index: shardIndex, bytes: landed.ciphertext_bytes, status: landed.status });
      await objectStore(env).delete(objectKey);
      throw new HttpError(409, "Device history shard upload was cancelled", "device_history_upload_cancelled");
    }
    if (liveClaim.cancelled_at !== null) {
      await objectStore(env).delete(objectKey);
      await finalizePendingR2Cleanup(env, [liveClaim as PendingR2Write]);
      throw new HttpError(409, "Device history shard upload was cancelled", "device_history_upload_cancelled");
    }
    const now = Date.now();
    await batch(env.DB, [
      db.insertInto("device_link_history_shards").values({ link_id: linkId, shard_index: shardIndex, object_key: objectKey,
        ciphertext_bytes: object.size, ciphertext_sha256: suppliedDigest.text, status: "ready", uploaded_at: now, acked_at: null })
        .onConflict((conflict) => conflict.columns(["link_id", "shard_index"]).doNothing()),
      db.updateTable("device_link_history_transfers").set({ updated_at: now }).where("link_id", "=", linkId),
      db.deleteFrom("pending_r2_writes").where("object_key", "=", objectKey).where("content_sha256", "=", suppliedDigest.text).where("cancelled_at", "is", null),
    ]);
    const committed = await db.selectFrom("device_link_history_shards").select(["ciphertext_bytes", "ciphertext_sha256"])
      .where("link_id", "=", linkId).where("shard_index", "=", shardIndex).executeTakeFirst();
    if (!committed || !matchesCommitted(committed)) throw new HttpError(409, "Device history shard index is already in use", "device_history_shard_conflict");
    return json({ ready: true, index: shardIndex, bytes: object.size, status: "ready" }, 201);
  } catch (error) {
    if (reservationCreated && releaseReservation) await finalizePendingR2Cleanup(env, [pending]);
    throw error;
  }
}

async function downloadDeviceLinkHistoryShard(request: Request, env: Env, linkId: string, shardIndex: number): Promise<Response> {
  const link = await deviceLinkBySecret(request, env, linkId);
  if (link.status !== "complete" && link.status !== "claimed") throw new HttpError(409, "Device link is not ready", "device_link_not_ready");
  const shard = await createDatabase(env.DB).selectFrom("device_link_history_shards").selectAll().where("link_id", "=", linkId).where("shard_index", "=", shardIndex).where("status", "=", "ready").executeTakeFirst();
  if (!shard) throw new HttpError(404, "Device history shard not found", "not_found");
  const object = await objectStore(env).get(shard.object_key);
  if (!object || object.size !== shard.ciphertext_bytes || !shard.ciphertext_sha256 || object.metadata.sha256 !== shard.ciphertext_sha256) {
    await object?.body.cancel().catch(() => undefined);
    throw new HttpError(503, "Device history shard is temporarily unavailable", "history_transfer_unavailable");
  }
  return new Response(object.body, { headers: { "content-type": "application/vnd.edgechat.device-history-shard", "content-length": String(object.size), "cache-control": "no-store" } });
}

async function acknowledgeDeviceLinkHistoryShard(request: Request, env: Env, linkId: string, shardIndex: number): Promise<Response> {
  const link = await deviceLinkBySecret(request, env, linkId);
  if (link.status !== "complete" && link.status !== "claimed") throw new HttpError(409, "Device link is not ready", "device_link_not_ready");
  const db = createDatabase(env.DB);
  const shard = await db.selectFrom("device_link_history_shards").selectAll().where("link_id", "=", linkId).where("shard_index", "=", shardIndex).executeTakeFirst();
  if (!shard || shard.status === "acked") return new Response(null, { status: 204 });
  try { await objectStore(env).delete(shard.object_key); } catch { throw new HttpError(503, "Device history shard cleanup failed", "history_cleanup_failed"); }
  const now = Date.now();
  await batch(env.DB, [
    db.updateTable("user_storage_usage").set({ archive_bytes: sql<number>`max(0, archive_bytes - ${shard.ciphertext_bytes})`, archive_objects: sql<number>`max(0, archive_objects - 1)`, updated_at: now })
      .where("user_id", "=", link.user_id!).where(sql<boolean>`EXISTS (SELECT 1 FROM device_link_history_shards WHERE link_id = ${linkId} AND shard_index = ${shardIndex} AND status = 'ready')`),
    db.updateTable("device_link_history_shards").set({ status: "acked", acked_at: now }).where("link_id", "=", linkId).where("shard_index", "=", shardIndex).where("status", "=", "ready"),
  ]);
  return new Response(null, { status: 204 });
}

async function removeDeviceLinkHistory(env: Env, link: { link_id: string; user_id: string | null; history_object_key: string | null; history_bytes: number | null }): Promise<boolean> {
  if (!link.user_id || !link.history_object_key || !link.history_bytes) return true;
  try { await objectStore(env).delete(link.history_object_key); }
  catch { return false; }
  const db = createDatabase(env.DB);
  await batch(env.DB, [
    db.updateTable("user_storage_usage").set({
      archive_bytes: sql<number>`max(0, archive_bytes - ${link.history_bytes})`,
      archive_objects: sql<number>`max(0, archive_objects - 1)`, updated_at: Date.now(),
    }).where("user_id", "=", link.user_id)
      .where(sql<boolean>`EXISTS (SELECT 1 FROM device_links WHERE link_id = ${link.link_id} AND history_object_key = ${link.history_object_key})`),
    db.updateTable("device_links").set({ history_object_key: null, history_bytes: null, history_uploaded_at: null, history_source_device_id: null, updated_at: Date.now() })
      .where("link_id", "=", link.link_id).where("history_object_key", "=", link.history_object_key),
  ]);
  return true;
}

async function removeDeviceLinkHistoryShards(env: Env, linkId: string, userId: string | null): Promise<boolean> {
  const db = createDatabase(env.DB);
  const shards = await db.selectFrom("device_link_history_shards").select(["object_key", "ciphertext_bytes"])
    .where("link_id", "=", linkId).where("status", "=", "ready").execute();
  if (!shards.length) {
    await db.deleteFrom("device_link_history_transfers").where("link_id", "=", linkId).execute();
    return true;
  }
  try { await objectStore(env).delete(shards.map((shard) => shard.object_key)); } catch { return false; }
  const bytes = shards.reduce((total, shard) => total + shard.ciphertext_bytes, 0); const now = Date.now();
  await batch(env.DB, [
    ...(userId ? [db.updateTable("user_storage_usage").set({ archive_bytes: sql<number>`max(0, archive_bytes - ${bytes})`,
      archive_objects: sql<number>`max(0, archive_objects - ${shards.length})`, updated_at: now }).where("user_id", "=", userId)
      .where(sql<boolean>`EXISTS (SELECT 1 FROM device_link_history_shards WHERE link_id = ${linkId} AND status = 'ready')`)] : []),
    db.deleteFrom("device_link_history_transfers").where("link_id", "=", linkId),
  ]);
  return true;
}

async function materializeDeviceLink(env: Env, linkId: string): Promise<void> {
  const db = createDatabase(env.DB);
  const link = await db.selectFrom("device_links").selectAll().where("link_id", "=", linkId).executeTakeFirstOrThrow();
  if (!link.user_id || !link.approved_by_device_id || link.expires_at <= Date.now()
    || (link.status !== "awaiting_packages" && link.status !== "approved")) return;
  const rooms = await db.selectFrom("room_members as rm").innerJoin("rooms as r", "r.room_id", "rm.room_id")
    .select(["rm.room_id", "r.mls_epoch"]).where("rm.user_id", "=", link.user_id).where("rm.removed_at", "is", null).orderBy("rm.room_id").execute();
  const packages = await db.selectFrom("device_link_key_packages").select("key_package").where("link_id", "=", linkId).orderBy("ordinal").execute();
  if (packages.length < rooms.length) {
    await db.updateTable("device_links").set({ status: "awaiting_packages", required_packages: rooms.length, updated_at: Date.now() }).where("link_id", "=", linkId).execute();
    return;
  }
  const busyRevocation = rooms.length ? await db.selectFrom("device_revocation_rooms").select("room_id").where("room_id", "in", rooms.map((room) => room.room_id)).where("status", "=", "pending").executeTakeFirst() : null;
  if (busyRevocation) throw new HttpError(409, "Another MLS membership change is pending", "room_membership_busy");
  const now = Date.now();
  const sparePackageInserts = await keyPackageInserts(db, link.device_id, packages.slice(rooms.length, rooms.length + MLS_KEY_PACKAGE_ACTIVE_LIMIT).map((item) => item.key_package), now);
  try {
    await batch(env.DB, [
      db.insertInto("devices").values({ device_id: link.device_id, user_id: link.user_id, display_name: link.display_name, signing_key: link.signing_key, encryption_key: link.encryption_key, created_at: now, last_seen_at: now, revoked_at: null }),
      ...sparePackageInserts,
      ...rooms.map((room, index) => db.insertInto("device_link_rooms").values({ link_id: linkId, room_id: room.room_id, key_package: packages[index].key_package, expected_epoch: room.mls_epoch + 1, status: "pending", event_id: null, encrypted_state: null, updated_at: now })),
      db.updateTable("device_links").set({ status: rooms.length ? "approved" : "complete", required_packages: rooms.length, expires_at: now + DEVICE_LINK_APPROVED_MS, updated_at: now, completed_at: rooms.length ? null : now }).where("link_id", "=", linkId),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) throw new HttpError(409, "A room membership change or device link is already pending", "room_membership_busy");
    throw error;
  }
}

async function approveDeviceLink(env: Env, auth: AuthContext, linkId: string): Promise<Response> {
  requireUser(auth);
  const db = createDatabase(env.DB); const now = Date.now();
  const updated = await db.updateTable("device_links").set({ user_id: auth.userId, approved_by_device_id: auth.deviceId, status: "awaiting_packages", expires_at: now + DEVICE_LINK_APPROVED_MS, updated_at: now })
    .where("link_id", "=", linkId).where("status", "=", "pending").where("expires_at", ">", now).executeTakeFirst();
  if (updated.numUpdatedRows !== 1n) throw new HttpError(409, "Device link is no longer pending", "device_link_not_pending");
  await materializeDeviceLink(env, linkId);
  const link = await db.selectFrom("device_links").select(["status", "required_packages", "expires_at"]).where("link_id", "=", linkId).executeTakeFirstOrThrow();
  return json({ link_id: linkId, ...link });
}

async function uploadDeviceLinkPackages(request: Request, env: Env, linkId: string): Promise<Response> {
  const link = await deviceLinkBySecret(request, env, linkId);
  if (link.status !== "awaiting_packages") throw new HttpError(409, "Device link is not waiting for KeyPackages", "invalid_link_state");
  const body = await readJson(request, 4_000_000); await insertDeviceLinkPackages(env, linkId, linkPackages(body));
  await materializeDeviceLink(env, linkId);
  return deviceLinkStatus(request, env, linkId);
}

async function commitDeviceLinkRoom(request: Request, env: Env, auth: AuthContext, linkId: string, roomId: RoomId): Promise<Response> {
  requireUser(auth);
  const db = createDatabase(env.DB);
  const link = await db.selectFrom("device_links").selectAll().where("link_id", "=", linkId).executeTakeFirst();
  if (!link || link.user_id !== auth.userId) throw new HttpError(404, "Device link not found", "not_found");
  if (link.status === "cancelled") throw new HttpError(410, "Device link was cancelled", "device_link_cancelled");
  if (link.expires_at <= Date.now() && link.status !== "claimed") {
    await expireDeviceLink(env, linkId);
    throw new HttpError(410, "Device link expired", "device_link_expired");
  }
  if (link.status !== "approved" && link.status !== "complete" && link.status !== "claimed") throw new HttpError(409, "Device link is not ready", "device_link_not_ready");
  const task = await db.selectFrom("device_link_rooms").selectAll().where("link_id", "=", linkId).where("room_id", "=", roomId).executeTakeFirst();
  if (!task) throw new HttpError(404, "Device link room not found", "not_found");
  if (task.status === "complete") {
    const stored = task.event_id ? await db.selectFrom("room_events").select("event_json").where("event_id", "=", task.event_id).executeTakeFirst() : null;
    if (!stored) throw new HttpError(503, "Committed device-link event is temporarily unavailable", "committed_event_unavailable");
    return json({ link_id: linkId, room_id: roomId, status: "complete", event: JSON.parse(stored.event_json) as RoomEvent });
  }
  const body = await readJson(request, 800_000);
  const encryptedState = stringField(body, "encrypted_state", 300_000);
  const eventBody = body.event;
  if (!eventBody || typeof eventBody !== "object" || Array.isArray(eventBody)) throw new HttpError(400, "MLS commit event required", "invalid_event");
  const event = await verifyEvent(env, auth, eventBody as Record<string, unknown>, roomId);
  if (event.type !== "control.device.add" || event.metadata.link_id !== linkId || event.metadata.target_device_id !== link.device_id) throw new HttpError(400, "Device link event metadata mismatch", "invalid_device_commit");
  const epoch = Number(event.metadata.mls_epoch);
  if (!Number.isInteger(epoch) || epoch !== task.expected_epoch) throw new HttpError(409, "MLS commit epoch does not match", "stale_epoch");
  const room = await db.selectFrom("rooms").select("mls_epoch").where("room_id", "=", roomId).executeTakeFirst();
  if (!room || room.mls_epoch + 1 !== epoch) throw new HttpError(409, "Room MLS epoch changed", "stale_epoch");
  const accepted = await appendRoomEvent(env, roomId, event, room.mls_epoch); const now = Date.now();
  await batch(env.DB, [
    db.updateTable("rooms").set({ mls_epoch: epoch }).where("room_id", "=", roomId).where("mls_epoch", "=", epoch - 1),
    db.insertInto("room_devices").values({ room_id: roomId, device_id: link.device_id, user_id: link.user_id!, joined_epoch: epoch, joined_seq: accepted.seq, removed_epoch: null, created_at: now, removed_at: null }),
    db.insertInto("room_device_keys").values({ room_id: roomId, device_id: link.device_id, encrypted_state: encryptedState, epoch, created_at: now }).onConflict((conflict) => conflict.columns(["room_id", "device_id", "epoch"]).doUpdateSet({ encrypted_state: encryptedState, created_at: now })),
    db.updateTable("device_link_rooms").set({ status: "complete", event_id: event.event_id, encrypted_state: encryptedState, updated_at: now }).where("link_id", "=", linkId).where("room_id", "=", roomId),
  ]);
  const pending = await db.selectFrom("device_link_rooms").select("room_id").where("link_id", "=", linkId).where("status", "=", "pending").executeTakeFirst();
  if (!pending) {
    const completed = await db.updateTable("device_links").set({ status: "complete", completed_at: now, updated_at: now })
      .where("link_id", "=", linkId).where("status", "=", "approved").executeTakeFirst();
    if (completed.numUpdatedRows === 1n) {
      await db.insertInto("sync_log").values({ recipient_user_id: link.user_id!, kind: "device.event", room_id: null, seq: null, event_id: null,
        payload: JSON.stringify({ type: "device.added", device_id: link.device_id, link_id: linkId }), created_at: now }).execute();
    }
  }
  const finalLink = await db.selectFrom("device_links").select(["status", "approved_by_device_id"])
    .where("link_id", "=", linkId).executeTakeFirst();
  if (finalLink?.status === "cancelled") {
    await stageAbandonedDeviceLinkRevocation(env, { ...link, approved_by_device_id: finalLink.approved_by_device_id }, now, "cancelled");
  }
  return json({ link_id: linkId, room_id: roomId, status: "complete", event: accepted });
}

async function claimDeviceLink(request: Request, env: Env, linkId: string): Promise<Response> {
  const link = await deviceLinkBySecret(request, env, linkId);
  if (link.status === "cancelled") throw new HttpError(410, "Device link was cancelled", "device_link_cancelled");
  if (!link.user_id || (link.status !== "complete" && link.status !== "claimed")) throw new HttpError(409, "Device link is not ready", "device_link_not_ready");
  const historyTransfer = await deviceLinkHistoryTransfer(env, linkId);
  if (link.status !== "claimed" && historyTransfer
    && historyTransfer.ready_shards.length + historyTransfer.acked_shards.length !== historyTransfer.shard_count) {
    throw new HttpError(409, "Device history transfer is not ready", "device_history_not_ready");
  }
  const body = await readJson(request);
  const accessToken = stringField(body, "access_token", 128);
  const deviceCredential = stringField(body, "device_credential", 64);
  const signature = stringField(body, "signature", 512);
  if (!/^[A-Za-z0-9_-]{43}$/.test(accessToken) || !/^[A-Za-z0-9_-]{43}$/.test(deviceCredential)) {
    throw new HttpError(400, "Invalid device claim credentials", "invalid_input");
  }
  const [tokenHash, deviceCredentialHash] = await Promise.all([sha256(accessToken), sha256(deviceCredential)]);
  const claimBindingHash = await sha256(`edgechat-device-link-claim-v2\0${tokenHash}\0${deviceCredentialHash}`);
  const transcript = new TextEncoder().encode(JSON.stringify({ version: 2, link_id: linkId, device_id: link.device_id,
    access_token_hash: tokenHash, device_credential_hash: deviceCredentialHash }));
  const key = await crypto.subtle.importKey("jwk", JSON.parse(link.signing_key) as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64url(signature), transcript))) throw new HttpError(400, "Invalid device proof", "invalid_signature");
  const db = createDatabase(env.DB); const now = Date.now();
  const user = await db.selectFrom("users").select(["display_name", "avatar_id", "account_mode"]).where("user_id", "=", link.user_id).executeTakeFirstOrThrow();
  if (user.account_mode === "opaque" && (!link.account_credential_envelope || !link.account_credential_source_device_id)) {
    throw new HttpError(409, "Account credential transfer is not ready", "account_credential_not_ready");
  }
  const linkedDevice = await db.selectFrom("devices").select("device_credential_hash").where("device_id", "=", link.device_id)
    .where("user_id", "=", link.user_id).executeTakeFirstOrThrow();
  if (link.status === "claimed") {
    if (link.claim_token_hash !== claimBindingHash || linkedDevice.device_credential_hash !== deviceCredentialHash) {
      throw new HttpError(409, "Device link was already claimed", "device_link_claimed");
    }
  } else {
    if (linkedDevice.device_credential_hash !== null) throw new HttpError(409, "Linked device credential is already set", "device_link_claimed");
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE device_links SET status = 'claimed', claim_token_hash = ?1, claimed_at = ?2, updated_at = ?2 WHERE link_id = ?3 AND status = 'complete' AND NOT EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?4)")
        .bind(claimBindingHash, now, linkId, tokenHash),
      env.DB.prepare("UPDATE devices SET device_credential_hash = ?1, last_seen_at = ?2 WHERE device_id = ?3 AND user_id = ?4 AND device_credential_hash IS NULL AND EXISTS (SELECT 1 FROM device_links WHERE link_id = ?5 AND claim_token_hash = ?6)")
        .bind(deviceCredentialHash, now, link.device_id, link.user_id, linkId, claimBindingHash),
      env.DB.prepare("INSERT OR IGNORE INTO sessions (token_hash,user_id,device_id,created_at,expires_at) SELECT ?1,?2,?3,?4,?5 WHERE EXISTS (SELECT 1 FROM device_links WHERE link_id = ?6 AND claim_token_hash = ?7)")
        .bind(tokenHash, link.user_id, link.device_id, now, now + DEVICE_LINK_SESSION_MS, linkId, claimBindingHash),
    ]);
    if (results.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
      throw new HttpError(409, "Device link was claimed concurrently", "device_link_claimed");
    }
  }
  return json({ user_id: link.user_id, device_id: link.device_id, display_name: user.display_name, avatar_url: avatarUrl(user.avatar_id), server_name: env.SERVER_NAME, ...sessionCapabilities(env) });
}

function requireUser(auth: AuthContext): void {
  if (auth.actor !== "user") throw new HttpError(403, "A user session is required", "user_session_required");
}

function requireBotRoom(auth: AuthContext, roomId: string): void {
  if (auth.actor === "bot" && auth.botRoomId !== roomId) throw new HttpError(403, "Bot token is scoped to its notification room", "bot_room_scope");
}

async function consumeBotMessageCapability(env: Env, auth: AuthContext, event: ClientEvent): Promise<void> {
  const senderKind = event.metadata.sender_kind; const metadataBotId = event.metadata.bot_id;
  if (auth.actor !== "bot") {
    if (senderKind !== undefined || metadataBotId !== undefined) throw new HttpError(403, "Bot provenance requires a bot capability", "bot_provenance_forbidden");
    return;
  }
  if (!auth.botId || auth.botScope !== "message:create" || !auth.botRoomId || event.room_id !== auth.botRoomId || event.type !== "message.text") {
    throw new HttpError(403, "Bot capability only permits text messages in its notification room", "bot_capability_scope");
  }
  if (senderKind !== "bot" || metadataBotId !== auth.botId) {
    throw new HttpError(403, "Bot provenance does not match this capability", "bot_provenance_mismatch");
  }
  const db = createDatabase(env.DB);
  const duplicate = await db.selectFrom("room_events").select("event_id")
    .where("event_id", "=", event.event_id).where("device_id", "=", auth.deviceId).executeTakeFirst();
  if (duplicate) return;
  const now = Date.now();
  const resetBefore = now - BOT_RATE_WINDOW_MS;
  const limit = auth.botRateLimit ?? BOT_DEFAULT_MESSAGES_PER_MINUTE;
  const admitted = await db.insertInto("bot_rate_windows")
    .values({ bot_id: auth.botId, window_started_at: now, message_count: 1 })
    .onConflict((conflict) => conflict.column("bot_id").doUpdateSet({
      window_started_at: sql<number>`CASE WHEN bot_rate_windows.window_started_at <= ${resetBefore} THEN ${now} ELSE bot_rate_windows.window_started_at END`,
      message_count: sql<number>`CASE WHEN bot_rate_windows.window_started_at <= ${resetBefore} THEN 1 ELSE bot_rate_windows.message_count + 1 END`,
    }).where((eb) => eb.or([
      eb("bot_rate_windows.window_started_at", "<=", resetBefore),
      eb("bot_rate_windows.message_count", "<", limit),
    ])))
    .returning("message_count").executeTakeFirst();
  if (!admitted) throw new HttpError(429, "Bot message rate limit exceeded", "rate_limited", { "retry-after": "60" });
}

async function createBot(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  requireUser(auth);
  const body = await readJson(request);
  const displayName = stringField(body, "display_name", 60).trim();
  const device = body.device as Record<string, unknown> | undefined;
  if (!device || typeof device !== "object") throw new HttpError(400, "Bot device is required", "invalid_device");
  const deviceId = stringField(device, "device_id", 96);
  const signingKey = stringField(device, "signing_key", 2_000);
  const encryptionKey = stringField(device, "encryption_key", 2_000);
  const packages = mlsKeyPackages(device);
  await validatePublicKeys(signingKey, encryptionKey);
  const botId = `bot_${randomId(18)}`;
  const token = randomId(32);
  const now = Date.now();
  const expiresAt = now + BOT_TOKEN_MS;
  const db = createDatabase(env.DB);
  try {
    await batch(env.DB, [
      db.insertInto("devices").values({ device_id: deviceId, user_id: auth.userId, display_name: `Bot · ${displayName}`, kind: "bot", signing_key: signingKey, encryption_key: encryptionKey, created_at: now, last_seen_at: now, revoked_at: null }),
      ...(await keyPackageInserts(db, deviceId, packages, now)),
      db.insertInto("bot_integrations").values({ bot_id: botId, user_id: auth.userId, device_id: deviceId, display_name: displayName, room_id: null, token_hash: await sha256(token), scope: "message:create", max_messages_per_minute: BOT_DEFAULT_MESSAGES_PER_MINUTE, created_at: now, expires_at: expiresAt, revoked_at: null }),
      db.insertInto("sync_log").values({ recipient_user_id: auth.userId, kind: "device.event", room_id: null, seq: null, event_id: null, payload: JSON.stringify({ type: "bot.added", bot_id: botId, device_id: deviceId }), created_at: now }),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) throw new HttpError(409, "Bot device already exists", "already_exists");
    throw error;
  }
  return json({ bot_id: botId, access_token: token, user_id: auth.userId, device_id: deviceId, display_name: displayName, server_name: env.SERVER_NAME, expires_at: expiresAt, scope: "message:create", max_messages_per_minute: BOT_DEFAULT_MESSAGES_PER_MINUTE }, 201);
}

async function listBots(env: Env, auth: AuthContext): Promise<Response> {
  requireUser(auth);
  const bots = await createDatabase(env.DB).selectFrom("bot_integrations")
    .select(["bot_id", "device_id", "display_name", "room_id", "scope", "max_messages_per_minute", "created_at", "expires_at", "revoked_at"])
    .where("user_id", "=", auth.userId).orderBy("created_at", "desc").execute();
  return json({ bots });
}

async function revokeBot(env: Env, auth: AuthContext, botId: string): Promise<Response> {
  requireUser(auth);
  const db = createDatabase(env.DB);
  const bot = await db.selectFrom("bot_integrations").select("device_id").where("bot_id", "=", botId).where("user_id", "=", auth.userId).where("revoked_at", "is", null).executeTakeFirst();
  if (!bot) throw new HttpError(404, "Bot not found", "not_found");
  const now = Date.now();
  await batch(env.DB, [
    db.updateTable("bot_integrations").set({ revoked_at: now }).where("bot_id", "=", botId),
    db.updateTable("devices").set({ revoked_at: now }).where("device_id", "=", bot.device_id),
    db.insertInto("sync_log").values({ recipient_user_id: auth.userId, kind: "device.event", room_id: null, seq: null, event_id: null, payload: JSON.stringify({ type: "bot.revoked", bot_id: botId, device_id: bot.device_id }), created_at: now }),
  ]);
  return new Response(null, { status: 204 });
}

async function revokeDevice(env: Env, auth: AuthContext, deviceId: string): Promise<Response> {
  const db = createDatabase(env.DB);
  const target = await db.selectFrom("devices").select("device_id").where("device_id", "=", deviceId)
    .where("user_id", "=", auth.userId).where("revoked_at", "is", null).executeTakeFirst();
  if (!target) throw new HttpError(404, "Device not found", "not_found");
  if (deviceId !== auth.deviceId) throw new HttpError(409, "Remove another device through the cryptographic revocation flow", "mls_revocation_required");
  const replacement = await db.selectFrom("devices").select("device_id").where("user_id", "=", auth.userId)
    .where("device_id", "!=", deviceId).where("kind", "=", "user").where("revoked_at", "is", null).executeTakeFirst();
  if (replacement) throw new HttpError(409, "Use another active device to remove this device from MLS rooms", "mls_revocation_required");
  const roomIds = (await db.selectFrom("room_devices").select("room_id").where("device_id", "=", deviceId).where("removed_at", "is", null).execute()).map((row) => row.room_id);
  const now = Date.now();
  await batch(env.DB, [
    db.updateTable("devices").set({ revoked_at: now }).where("device_id", "=", deviceId),
    db.deleteFrom("sessions").where("device_id", "=", deviceId),
    db.deleteFrom("ws_tickets").where("device_id", "=", deviceId),
    db.deleteFrom("push_subscriptions").where("device_id", "=", deviceId),
    db.deleteFrom("device_draft_envelopes").where("target_device_id", "=", deviceId),
    db.insertInto("sync_log").values({ recipient_user_id: auth.userId, kind: "device.event", room_id: null, seq: null, event_id: null, payload: JSON.stringify({ type: "device.revoked", device_id: deviceId }), created_at: now }),
  ]);
  await Promise.all(roomIds.map((roomId) => env.ROOMS.getByName(roomId).revokeDevice(deviceId)));
  return new Response(null, { status: 204 });
}

type DeviceRevocationView = {
  revocation_id: string;
  target_device_id: string;
  status: "pending" | "finalizing" | "complete";
  rooms: Array<{ room_id: RoomId; expected_epoch: number; status: "pending" | "complete"; event_id: string | null }>;
};

async function deviceRevocationView(env: Env, revocationId: string): Promise<DeviceRevocationView> {
  const db = createDatabase(env.DB);
  const job = await db.selectFrom("device_revocations").select(["revocation_id", "target_device_id", "status"])
    .where("revocation_id", "=", revocationId).executeTakeFirstOrThrow();
  const rooms = await db.selectFrom("device_revocation_rooms").select(["room_id", "expected_epoch", "status", "event_id"])
    .where("revocation_id", "=", revocationId).orderBy("room_id").execute();
  return { ...job, rooms: rooms.map((room) => ({ ...room, room_id: room.room_id as RoomId })) };
}

async function refreshPendingDeviceRevocationEpochs(env: Env, revocationId: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE device_revocation_rooms
    SET expected_epoch = (SELECT rooms.mls_epoch + 1 FROM rooms WHERE rooms.room_id = device_revocation_rooms.room_id),
        updated_at = ?
    WHERE revocation_id = ? AND status = 'pending'
  `).bind(Date.now(), revocationId).run();
}

async function finalizeDeviceRevocation(env: Env, revocationId: string): Promise<DeviceRevocationView> {
  const db = createDatabase(env.DB);
  const job = await db.selectFrom("device_revocations").selectAll().where("revocation_id", "=", revocationId).executeTakeFirstOrThrow();
  const pending = await db.selectFrom("device_revocation_rooms").select("room_id")
    .where("revocation_id", "=", revocationId).where("status", "=", "pending").executeTakeFirst();
  if (pending || job.status === "complete") return deviceRevocationView(env, revocationId);

  const now = Date.now();
  await batch(env.DB, [
    db.updateTable("device_revocations").set({ status: "finalizing", updated_at: now }).where("revocation_id", "=", revocationId),
    db.updateTable("devices").set({ revoked_at: now }).where("device_id", "=", job.target_device_id).where("revoked_at", "is", null),
    db.deleteFrom("sessions").where("device_id", "=", job.target_device_id),
    db.deleteFrom("ws_tickets").where("device_id", "=", job.target_device_id),
    db.deleteFrom("push_subscriptions").where("device_id", "=", job.target_device_id),
    db.deleteFrom("device_draft_envelopes").where("target_device_id", "=", job.target_device_id),
  ]);
  const roomIds = (await db.selectFrom("room_devices").select("room_id").where("device_id", "=", job.target_device_id).execute()).map((row) => row.room_id);
  await Promise.all(roomIds.map((roomId) => env.ROOMS.getByName(roomId).revokeDevice(job.target_device_id)));
  const completedAt = Date.now();
  await batch(env.DB, [
    db.updateTable("device_revocations").set({ status: "complete", updated_at: completedAt, completed_at: completedAt }).where("revocation_id", "=", revocationId),
    db.insertInto("sync_log").values({ recipient_user_id: job.user_id, kind: "device.event", room_id: null, seq: null, event_id: null, payload: JSON.stringify({ type: "device.revoked", device_id: job.target_device_id, revocation_id: revocationId }), created_at: completedAt }),
  ]);
  return deviceRevocationView(env, revocationId);
}

async function prepareDeviceRevocation(env: Env, auth: AuthContext, deviceId: string): Promise<Response> {
  if (deviceId === auth.deviceId) throw new HttpError(409, "A device cannot cryptographically remove itself", "current_device");
  const db = createDatabase(env.DB);
  const existing = await db.selectFrom("device_revocations").select(["revocation_id", "status"])
    .where("target_device_id", "=", deviceId).where("user_id", "=", auth.userId).orderBy("created_at", "desc").executeTakeFirst();
  if (existing) {
    if (existing.status !== "complete") await refreshPendingDeviceRevocationEpochs(env, existing.revocation_id);
    return json(existing.status === "complete" ? await deviceRevocationView(env, existing.revocation_id) : await finalizeDeviceRevocation(env, existing.revocation_id));
  }
  const target = await db.selectFrom("devices").select("device_id").where("device_id", "=", deviceId)
    .where("user_id", "=", auth.userId).where("kind", "=", "user").where("revoked_at", "is", null).executeTakeFirst();
  if (!target) throw new HttpError(404, "Device not found", "not_found");

  const rooms = await db.selectFrom("room_devices as rd").innerJoin("rooms as r", "r.room_id", "rd.room_id")
    .innerJoin("room_members as rm", (join) => join.onRef("rm.room_id", "=", "rd.room_id").onRef("rm.user_id", "=", "rd.user_id"))
    .select(["rd.room_id", "r.mls_epoch"]).where("rd.device_id", "=", deviceId).where("rd.user_id", "=", auth.userId)
    .where("rd.removed_at", "is", null).where("rm.removed_at", "is", null).orderBy("rd.room_id").execute();
  const revocationId = randomId(18);
  const now = Date.now();
  try {
    await batch(env.DB, [
      db.insertInto("device_revocations").values({ revocation_id: revocationId, user_id: auth.userId, target_device_id: deviceId, requested_by_device_id: auth.deviceId, status: "pending", created_at: now, updated_at: now, completed_at: null }),
      ...rooms.map((room) => db.insertInto("device_revocation_rooms").values({ revocation_id: revocationId, room_id: room.room_id, expected_epoch: room.mls_epoch + 1, status: "pending", event_id: null, updated_at: now })),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) throw new HttpError(409, "Another MLS membership change is pending in one of these rooms", "room_membership_busy");
    throw error;
  }
  return json(await finalizeDeviceRevocation(env, revocationId), 201);
}

async function listDeviceRevocations(env: Env, auth: AuthContext): Promise<Response> {
  const rows = await createDatabase(env.DB).selectFrom("device_revocations").select("revocation_id")
    .where("user_id", "=", auth.userId).where("status", "!=", "complete").orderBy("created_at").execute();
  await Promise.all(rows.map((row) => refreshPendingDeviceRevocationEpochs(env, row.revocation_id)));
  return json({ revocations: await Promise.all(rows.map((row) => deviceRevocationView(env, row.revocation_id))) });
}

async function commitDeviceRevocation(request: Request, env: Env, auth: AuthContext, revocationId: string, roomId: RoomId): Promise<Response> {
  const db = createDatabase(env.DB);
  const job = await db.selectFrom("device_revocations").select(["user_id", "target_device_id", "status"])
    .where("revocation_id", "=", revocationId).executeTakeFirst();
  if (!job || job.user_id !== auth.userId) throw new HttpError(404, "Device revocation not found", "not_found");
  const roomJob = await db.selectFrom("device_revocation_rooms").selectAll().where("revocation_id", "=", revocationId).where("room_id", "=", roomId).executeTakeFirst();
  if (!roomJob) throw new HttpError(404, "Revocation room not found", "not_found");
  if (roomJob.status === "complete") {
    const stored = roomJob.event_id ? await db.selectFrom("room_events").select("event_json").where("event_id", "=", roomJob.event_id).executeTakeFirst() : null;
    if (!stored) throw new HttpError(503, "Committed device-revocation event is temporarily unavailable", "committed_event_unavailable");
    return json({ ...(await finalizeDeviceRevocation(env, revocationId)), event: JSON.parse(stored.event_json) as RoomEvent });
  }
  if (job.status !== "pending") throw new HttpError(409, "Device revocation is already finalizing", "revocation_finalizing");
  const body = await readJson(request, 512_000);
  const event = await verifyEvent(env, auth, body, roomId);
  if (event.type !== "control.device.revoke" || event.metadata.target_device_id !== job.target_device_id || event.metadata.revocation_id !== revocationId) {
    throw new HttpError(400, "Device revocation event metadata does not match the job", "invalid_device_commit");
  }
  const epoch = Number(event.metadata.mls_epoch);
  if (!Number.isInteger(epoch) || epoch !== roomJob.expected_epoch) throw new HttpError(409, "MLS commit epoch does not match the reserved epoch", "stale_epoch");
  const room = await db.selectFrom("rooms").select("mls_epoch").where("room_id", "=", roomId).executeTakeFirst();
  if (!room || room.mls_epoch + 1 !== epoch) throw new HttpError(409, "Room MLS epoch changed; retry the revocation", "stale_epoch");

  const accepted = await appendRoomEvent(env, roomId, event, room.mls_epoch);
  const now = Date.now();
  await batch(env.DB, [
    db.updateTable("rooms").set({ mls_epoch: epoch }).where("room_id", "=", roomId).where("mls_epoch", "=", epoch - 1),
    db.updateTable("room_devices").set({ removed_epoch: epoch, removed_at: now }).where("room_id", "=", roomId).where("device_id", "=", job.target_device_id).where("removed_at", "is", null),
    db.deleteFrom("room_device_keys").where("room_id", "=", roomId).where("device_id", "=", job.target_device_id),
    db.updateTable("device_revocation_rooms").set({ status: "complete", event_id: event.event_id, updated_at: now }).where("revocation_id", "=", revocationId).where("room_id", "=", roomId),
    db.updateTable("device_revocations").set({ updated_at: now }).where("revocation_id", "=", revocationId),
  ]);
  return json({ ...(await finalizeDeviceRevocation(env, revocationId)), event: accepted });
}

async function commitAccountRemoval(request: Request, env: Env, auth: AuthContext, deletionId: string, roomId: RoomId): Promise<Response> {
  requireUser(auth);
  const db = createDatabase(env.DB);
  const task = await db.selectFrom("account_deletion_rooms as dr")
    .innerJoin("account_deletions as deletion", "deletion.deletion_id", "dr.deletion_id")
    .select(["dr.successor_user_id", "dr.expected_epoch", "dr.event_id", "dr.status", "deletion.user_id"])
    .where("dr.deletion_id", "=", deletionId).where("dr.room_id", "=", roomId).where("dr.action", "=", "leave").executeTakeFirst();
  if (!task || task.successor_user_id !== auth.userId) throw new HttpError(404, "Account removal task not found", "not_found");
  if (task.status === "complete") {
    const stored = task.event_id ? await db.selectFrom("room_events").select("event_json").where("event_id", "=", task.event_id).executeTakeFirst() : null;
    if (!stored) throw new HttpError(503, "Committed account-removal event is temporarily unavailable", "committed_event_unavailable");
    return json({ deletion: await completeAccountRoomRemoval(env, deletionId, roomId, task.event_id!, task.expected_epoch ?? 0, Date.now()), event: JSON.parse(stored.event_json) as RoomEvent });
  }
  const body = await readJson(request, 512_000);
  const eventBody = body.event && typeof body.event === "object" ? body.event as Record<string, unknown> : body;
  const event = await verifyEvent(env, auth, eventBody, roomId);
  if (event.type !== "control.group.commit" || event.metadata.account_deletion_id !== deletionId || event.metadata.target_user_id !== task.user_id) {
    throw new HttpError(400, "MLS removal event metadata does not match the account deletion", "invalid_account_removal_commit");
  }
  const epoch = Number(event.metadata.mls_epoch);
  if (!Number.isInteger(epoch) || epoch !== task.expected_epoch) throw new HttpError(409, "MLS commit epoch does not match the reserved epoch", "stale_epoch");
  const room = await db.selectFrom("rooms").select("mls_epoch").where("room_id", "=", roomId).executeTakeFirst();
  if (!room || room.mls_epoch + 1 !== epoch) throw new HttpError(409, "Room MLS epoch changed; refresh the removal task", "stale_epoch");
  const accepted = await appendRoomEvent(env, roomId, event, room.mls_epoch);
  const deletion = await completeAccountRoomRemoval(env, deletionId, roomId, accepted.event_id, epoch, Date.now());
  return json({ deletion, event: accepted });
}

async function listRooms(env: Env, auth: AuthContext): Promise<Response> {
  const db = createDatabase(env.DB);
  const [blockRows, hiddenRows] = await Promise.all([
    db.selectFrom("user_blocks").select("blocked_user_id").where("blocker_user_id", "=", auth.userId).execute(),
    db.selectFrom("group_hidden_members").select(["room_id", "hidden_user_id"]).where("user_id", "=", auth.userId).execute(),
  ]);
  const blockedByMe = new Set(blockRows.map((row) => row.blocked_user_id));
  const hiddenByRoom = new Map<string, UserId[]>();
  for (const row of hiddenRows) hiddenByRoom.set(row.room_id, [...(hiddenByRoom.get(row.room_id) ?? []), row.hidden_user_id as UserId]);
  let query = db.selectFrom("room_members as mine").innerJoin("rooms as r", "r.room_id", "mine.room_id")
    .innerJoin("room_devices as current_device", (join) => join.onRef("current_device.room_id", "=", "r.room_id").on("current_device.device_id", "=", auth.deviceId))
    .leftJoin("device_room_preferences as pref", (join) => join.onRef("pref.room_id", "=", "r.room_id").on("pref.device_id", "=", auth.deviceId))
    .select(["r.room_id", "r.name", "r.kind", "r.purpose", "r.current_seq", "r.created_at", "r.home_server", "r.mls_epoch as epoch", "current_device.joined_seq", "pref.muted_until"])
    .where("mine.user_id", "=", auth.userId).where("mine.removed_at", "is", null).where("current_device.removed_at", "is", null);
  if (auth.actor === "bot") query = query.where("r.room_id", "=", auth.botRoomId ?? "");
  const rooms = await query.orderBy("r.created_at", "desc").execute();
  const result = await Promise.all(rooms.map(async (room) => {
    const [members, state, request, leaveRequest] = await Promise.all([
      db.selectFrom("room_members as member").innerJoin("users as user", "user.user_id", "member.user_id")
        .select(["member.user_id", "user.display_name", "user.avatar_id", "member.role"]).where("member.room_id", "=", room.room_id).where("member.removed_at", "is", null).orderBy("member.joined_at").execute(),
      db.selectFrom("room_device_keys").select(["encrypted_state", "epoch"]).where("room_id", "=", room.room_id).where("device_id", "=", auth.deviceId).orderBy("epoch", "desc").executeTakeFirst(),
      db.selectFrom("direct_message_requests").select(["requester_user_id", "recipient_user_id", "status"]).where("room_id", "=", room.room_id).executeTakeFirst(),
      db.selectFrom("room_leave_requests").select("status").where("room_id", "=", room.room_id).where("user_id", "=", auth.userId).where("status", "in", ["pending", "processing"]).executeTakeFirst(),
    ]);
    const requestMessage = request ? await db.selectFrom("room_events").select("event_id").where("room_id", "=", room.room_id)
      .where("event_type", "in", [...visibleMessageEventTypes]).executeTakeFirst() : null;
    return { ...room, members: members.map(({ avatar_id, ...member }) => ({ ...member, avatar_url: avatarUrl(avatar_id) })), hidden_member_ids: hiddenByRoom.get(room.room_id) ?? [], encrypted_state: state?.encrypted_state ?? null, blocked_by_me: members.some((member) => blockedByMe.has(member.user_id)), leave_status: leaveRequest ? "pending" as const : null, ...requestView(request ?? null, auth.userId, Boolean(requestMessage)) };
  }));
  return json({ rooms: result });
}

async function claimMlsKeyPackages(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const body = await readJson(request);
  const claimContext = stringField(body, "room_id", 180) as RoomId;
  if (!isNamespacedRoomId(claimContext)) throw new HttpError(400, "Invalid MLS claim context", "invalid_room");
  assertLocalId(claimContext, "!", env);
  const requested = Array.isArray(body.user_ids) ? body.user_ids.filter((value): value is string => typeof value === "string") : [];
  if (auth.actor === "bot" && auth.botRoomId) throw new HttpError(403, "Bot provisioning capability has already been consumed", "bot_provisioned");
  if (auth.actor === "bot" && requested.some((id) => id !== auth.userId)) throw new HttpError(403, "Personal bots may only claim their owner's devices", "bot_owner_scope");
  const db = createDatabase(env.DB);
  const existingRoom = await db.selectFrom("rooms").select(["kind", "purpose"]).where("room_id", "=", claimContext).executeTakeFirst();
  if (existingRoom) {
    if (auth.actor !== "user" || existingRoom.kind !== "group" || existingRoom.purpose !== "chat" || await memberRole(env, claimContext, auth.userId) !== "owner") {
      throw new HttpError(403, "Only the group owner may claim packages for a new member", "forbidden");
    }
    if (new Set(requested).size !== 1 || requested[0] === auth.userId) throw new HttpError(400, "Exactly one new group member is required", "invalid_members");
    const membership = await db.selectFrom("room_members").select("removed_at").where("room_id", "=", claimContext).where("user_id", "=", requested[0] as UserId).executeTakeFirst();
    if (membership?.removed_at === null) throw new HttpError(409, "User is already a member", "membership_conflict");
  }
  const userIds = Array.from(new Set(existingRoom ? requested : [auth.userId, ...requested])) as UserId[];
  if (userIds.length < 1 || userIds.length > 32) throw new HttpError(400, "Invalid MLS member list", "invalid_members");
  userIds.forEach((id) => assertLocalId(id, "@", env));
  const policyParticipants = existingRoom
    ? [...(await db.selectFrom("room_members").select("user_id").where("room_id", "=", claimContext).where("removed_at", "is", null).execute()).map((member) => member.user_id), ...userIds]
    : userIds;
  await assertNoBlockedPair(env, policyParticipants);
  const deniedInvitee = (await Promise.all(userIds.filter((userId) => userId !== auth.userId)
    .map(async (userId) => ({ userId, allowed: await invitationAllowed(env, auth.userId, userId) })))).find((entry) => !entry.allowed);
  if (deniedInvitee) throw new HttpError(403, "A user does not accept invitations from this account", "invitation_not_allowed");
  const unknownInvitees = auth.actor === "user" ? (await Promise.all(userIds.filter((userId) => userId !== auth.userId)
    .map(async (userId) => ({ userId, known: await hasEstablishedRelationship(env, auth.userId, userId) })))).filter((entry) => !entry.known) : [];
  if ((existingRoom || userIds.length > 2) && unknownInvitees.length) {
    throw new HttpError(403, "Create direct message requests before inviting unknown users to a group", "group_invitation_requires_contact");
  }
  const devices = await db.selectFrom("devices").select(["device_id", "user_id"]).where("user_id", "in", userIds).where("kind", "=", "user").where("revoked_at", "is", null).where("device_id", "!=", auth.deviceId).execute();
  const claimed: Array<{ package_id: string; device_id: string; user_id: string; key_package: string; reserve: boolean }> = [];
  for (const device of devices) {
    const existing = await db.selectFrom("device_key_packages").select(["package_id", "key_package"])
      .where("device_id", "=", device.device_id).where("claimed_by_device_id", "=", auth.deviceId)
      .where("claim_context", "=", claimContext).where("consumed_room_id", "is", null).executeTakeFirst();
    if (existing) {
      claimed.push({ ...existing, device_id: device.device_id, user_id: device.user_id, reserve: false });
      continue;
    }
    const keyPackage = await db.selectFrom("device_key_packages").select(["package_id", "key_package"])
      .where("device_id", "=", device.device_id).where("claimed_at", "is", null).orderBy("created_at").executeTakeFirst();
    if (!keyPackage) throw new HttpError(409, `Device ${device.device_id} has no MLS KeyPackage`, "mls_key_package_exhausted");
    claimed.push({ ...keyPackage, device_id: device.device_id, user_id: device.user_id, reserve: true });
  }
  const requestTarget = userIds.length === 2 ? unknownInvitees[0]?.userId ?? null : null;
  if (requestTarget) {
    await reserveMessageRequestQuota(env, claimContext, auth.userId, requestTarget);
  }
  const now = Date.now();
  const pendingReservations = claimed.filter((item) => item.reserve);
  let reservations: Awaited<ReturnType<typeof batch>> = [];
  try {
    reservations = pendingReservations.length ? await batch(env.DB, pendingReservations.map((item) => db.updateTable("device_key_packages").set({ claimed_at: now, claimed_by_device_id: auth.deviceId, claim_context: claimContext })
      .where("package_id", "=", item.package_id).where("claimed_at", "is", null))) : [];
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) throw new HttpError(409, "MLS KeyPackage claim raced; retry the same room", "mls_key_package_race");
    throw error;
  }
  if (reservations.some((result) => result.numAffectedRows !== 1n)) throw new HttpError(409, "MLS KeyPackage was claimed concurrently; retry", "mls_key_package_race");
  return json({ key_packages: claimed.map(({ package_id, reserve: _reserve, ...item }) => ({ ...item, claim_id: package_id })) });
}

async function keyPackageCounts(env: Env, deviceId: string): Promise<{ available: number; claimed: number; active: number }> {
  const db = createDatabase(env.DB);
  const [available, claimed, active] = await Promise.all([
    db.selectFrom("device_key_packages").select(sql<number>`count(*)`.as("count"))
      .where("device_id", "=", deviceId).where("claimed_at", "is", null).where("consumed_room_id", "is", null).executeTakeFirstOrThrow(),
    db.selectFrom("device_key_packages").select(sql<number>`count(*)`.as("count"))
      .where("device_id", "=", deviceId).where("claimed_at", "is not", null).where("consumed_room_id", "is", null).executeTakeFirstOrThrow(),
    db.selectFrom("device_key_packages").select(sql<number>`count(*)`.as("count"))
      .where("device_id", "=", deviceId).where("consumed_room_id", "is", null).executeTakeFirstOrThrow(),
  ]);
  return { available: Number(available.count), claimed: Number(claimed.count), active: Number(active.count) };
}

async function keyPackageStatus(env: Env, auth: AuthContext): Promise<Response> {
  requireUser(auth);
  const counts = await keyPackageCounts(env, auth.deviceId);
  return json({ ...counts, low_water: MLS_KEY_PACKAGE_LOW_WATER, target: MLS_KEY_PACKAGE_TARGET, active_limit: MLS_KEY_PACKAGE_ACTIVE_LIMIT });
}

async function uploadKeyPackages(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  requireUser(auth);
  const body = await readJson(request, 1_100_000);
  const requested = mlsKeyPackages(body);
  const db = createDatabase(env.DB);
  const before = await keyPackageCounts(env, auth.deviceId);
  const capacity = Math.max(0, MLS_KEY_PACKAGE_ACTIVE_LIMIT - before.active);
  if (!capacity) return json({ uploaded: 0, ...before, low_water: MLS_KEY_PACKAGE_LOW_WATER, target: MLS_KEY_PACKAGE_TARGET, active_limit: MLS_KEY_PACKAGE_ACTIVE_LIMIT });
  const candidates = Array.from(new Set(requested)).slice(0, capacity);
  const existing = candidates.length ? await db.selectFrom("device_key_packages").select("key_package")
    .where("device_id", "=", auth.deviceId).where("key_package", "in", candidates).execute() : [];
  const existingValues = new Set(existing.map((item) => item.key_package));
  const fresh = candidates.filter((item) => !existingValues.has(item));
  const results = fresh.length ? await batch(env.DB, await keyPackageInserts(db, auth.deviceId, fresh, Date.now())) : [];
  const uploaded = results.reduce((total, result) => total + Number(result.numAffectedRows), 0);
  const after = await keyPackageCounts(env, auth.deviceId);
  return json({ uploaded, ...after, low_water: MLS_KEY_PACKAGE_LOW_WATER, target: MLS_KEY_PACKAGE_TARGET, active_limit: MLS_KEY_PACKAGE_ACTIVE_LIMIT }, 201);
}

export async function cleanupExpiredKeyPackages(env: Env): Promise<number> {
  const db = createDatabase(env.DB);
  const now = Date.now();
  const [abandoned, consumed] = await batch(env.DB, [
    db.deleteFrom("device_key_packages").where("claimed_at", "is not", null).where("claimed_at", "<", now - ABANDONED_KEY_PACKAGE_TTL_MS).where("consumed_room_id", "is", null),
    db.deleteFrom("device_key_packages").where("consumed_room_id", "is not", null).where("claimed_at", "<", now - CONSUMED_KEY_PACKAGE_TTL_MS),
  ]);
  return Number((abandoned.numAffectedRows ?? 0n) + (consumed.numAffectedRows ?? 0n));
}

async function cleanupMessageRequestRateWindows(env: Env): Promise<number> {
  const db = createDatabase(env.DB); const now = Date.now();
  const [windows, reservations] = await batch(env.DB, [
    db.deleteFrom("message_request_rate_windows").where("window_started_at", "<", now - 48 * 60 * 60 * 1_000),
    db.deleteFrom("message_request_reservations").where((eb) => eb.or([
      eb.and([eb("consumed_at", "is", null), eb("created_at", "<", now - ABANDONED_KEY_PACKAGE_TTL_MS)]),
      eb("created_at", "<", now - CONSUMED_KEY_PACKAGE_TTL_MS),
    ])),
  ]);
  return Number((windows.numAffectedRows ?? 0n) + (reservations.numAffectedRows ?? 0n));
}

export async function cleanupExpiredDeviceLinks(env: Env): Promise<number> {
  const db = createDatabase(env.DB); const now = Date.now();
  const expiredLinks = await db.selectFrom("device_links").select("link_id")
    .where("status", "in", ["pending", "awaiting_packages", "approved", "complete", "cancelled"])
    .where("expires_at", "<=", now).orderBy("updated_at").limit(100).execute();
  let expired = 0;
  for (const link of expiredLinks) if (await expireDeviceLink(env, link.link_id, now)) expired += 1;
  const removable = await db.selectFrom("device_links").select(["link_id", "user_id", "device_id", "status", "history_object_key", "history_bytes"])
    .where((eb) => eb.or([
      eb.and([eb("status", "=", "cancelled"), eb("updated_at", "<", now - 24 * 60 * 60 * 1_000)]),
      eb.and([eb("status", "=", "claimed"), eb("claimed_at", "<", now - 7 * 24 * 60 * 60 * 1_000)]),
    ])).orderBy("updated_at").limit(100).execute();
  const deletedIds: string[] = [];
  for (const link of removable) {
    if (link.status === "cancelled"
      && (await db.selectFrom("devices").select("revoked_at").where("device_id", "=", link.device_id).executeTakeFirst())?.revoked_at === null) {
      const staged = await db.selectFrom("device_revocations").select("revocation_id").where("target_device_id", "=", link.device_id).executeTakeFirst();
      if (!staged) continue;
    }
    if (await removeDeviceLinkHistory(env, link) && await removeDeviceLinkHistoryShards(env, link.link_id, link.user_id)) deletedIds.push(link.link_id);
  }
  if (deletedIds.length) await db.deleteFrom("device_links").where("link_id", "in", deletedIds).execute();
  return expired + deletedIds.length;
}

async function persistRetentionFloor(env: Env, roomId: RoomId, floorSeq: number, generation: number, checkedAt: number): Promise<void> {
  const db = createDatabase(env.DB);
  await batch(env.DB, [
    db.updateTable("rooms").set({ retention_floor_seq: floorSeq, retention_generation: generation, retention_gc_at: checkedAt })
      .where("room_id", "=", roomId),
    db.deleteFrom("attachment_grants").where("room_id", "=", roomId).where("grant_seq", "<=", floorSeq),
    db.deleteFrom("room_events").where("room_id", "=", roomId).where("seq", "<=", floorSeq),
    db.deleteFrom("sync_log").where("room_id", "=", roomId).where("kind", "=", "room.event").where("seq", "<=", floorSeq),
    db.deleteFrom("room_retention_acks").where("room_id", "=", roomId).where("through_seq", "<=", floorSeq),
    db.updateTable("room_retention_acks").set({ generation, from_seq: floorSeq + 1 })
      .where("room_id", "=", roomId).where("generation", "<", generation).where("from_seq", "<=", floorSeq + 1).where("through_seq", ">", floorSeq),
    db.deleteFrom("history_repair_jobs").where("room_id", "=", roomId).where("start_seq", "<=", floorSeq),
  ]);
}

async function acknowledgedRetentionThrough(env: Env, roomId: RoomId, generation: number, floorSeq: number, minimumCopies: number): Promise<number> {
  const db = createDatabase(env.DB);
  const acknowledgements = await db.selectFrom("room_retention_acks as ack")
    .innerJoin("room_devices as rd", (join) => join.onRef("rd.room_id", "=", "ack.room_id").onRef("rd.device_id", "=", "ack.device_id"))
    .innerJoin("devices as d", "d.device_id", "ack.device_id")
    .innerJoin("room_members as rm", (join) => join.onRef("rm.room_id", "=", "ack.room_id").onRef("rm.user_id", "=", "rd.user_id"))
    .select("ack.through_seq")
    .where("ack.room_id", "=", roomId).where("ack.generation", "=", generation).where("ack.from_seq", "<=", floorSeq + 1)
    .where("rd.removed_at", "is", null).where("d.revoked_at", "is", null).where("rm.removed_at", "is", null)
    .orderBy("ack.through_seq", "desc").limit(minimumCopies).execute();
  if (acknowledgements.length < minimumCopies) return floorSeq;
  return Math.max(floorSeq, Number(acknowledgements.at(-1)!.through_seq));
}

async function segmentAlignedRetentionThrough(env: Env, roomId: RoomId, floorSeq: number, acknowledgedThrough: number, cutoff: number): Promise<number> {
  if (acknowledgedThrough <= floorSeq) return floorSeq;
  const db = createDatabase(env.DB);
  const candidate = await db.selectFrom("room_events").select("seq")
    .where("room_id", "=", roomId).where("seq", ">", floorSeq).where("seq", "<=", acknowledgedThrough)
    .where(sql<number>`cast(json_extract(event_json, '$.acceptance_receipt.accepted_at') as integer)`, "<=", cutoff)
    .orderBy("seq", "desc").executeTakeFirst();
  if (!candidate) return floorSeq;
  const straddling = await db.selectFrom("archive_segments").select("start_seq")
    .where("room_id", "=", roomId).where("start_seq", "<=", candidate.seq).where("end_seq", ">", candidate.seq)
    .orderBy("start_seq").executeTakeFirst();
  return straddling ? Math.max(floorSeq, straddling.start_seq - 1) : candidate.seq;
}

export async function processRoomRetention(env: Env, now = Date.now()): Promise<{ rooms: number; events: number }> {
  // A retention floor is only safe when future accidental gaps can be
  // distinguished from intentional deletion using signed acceptance receipts.
  if (!repairReceiptsEnabled(env)) return { rooms: 0, events: 0 };
  const db = createDatabase(env.DB);
  const rooms = await db.selectFrom("rooms")
    .select(["room_id", "retention_days", "retention_floor_seq", "retention_generation", "retention_min_device_copies"])
    .where("retention_days", "is not", null)
    .orderBy(sql<number>`coalesce(retention_gc_at, 0)`).limit(20).execute();
  let processedRooms = 0; let deletedEvents = 0;
  for (const policy of rooms) {
    const roomId = policy.room_id as RoomId;
    try {
      const room = env.ROOMS.getByName(roomId);
      const state = await room.retentionState();
      if (state.floor_seq < policy.retention_floor_seq || state.generation < policy.retention_generation) {
        console.error(JSON.stringify({ message: "retention state regressed", room_id: roomId }));
        continue;
      }
      if (state.floor_seq !== policy.retention_floor_seq || state.generation !== policy.retention_generation) {
        await persistRetentionFloor(env, roomId, state.floor_seq, state.generation, now);
      }
      const cutoff = now - Number(policy.retention_days) * 86_400_000;
      const acknowledgedThrough = await acknowledgedRetentionThrough(env, roomId, state.generation, state.floor_seq, policy.retention_min_device_copies);
      // Never cut a retained archive object in half. Waiting until the whole
      // segment expires avoids an R2 delete + rewrite cycle at every GC run.
      const alignedThrough = await segmentAlignedRetentionThrough(env, roomId, state.floor_seq, acknowledgedThrough, cutoff);
      const advanced = await room.advanceRetentionBefore(cutoff, 500, alignedThrough);
      await persistRetentionFloor(env, roomId, advanced.floor_seq, advanced.generation, now);
      processedRooms += 1;
      deletedEvents += advanced.deleted_events;
    } catch (error) {
      console.error(JSON.stringify({ message: "room retention failed", room_id: roomId, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return { rooms: processedRooms, events: deletedEvents };
}

export async function stageRetentionObjectDeletions(env: Env, now = Date.now()): Promise<number> {
  const db = createDatabase(env.DB);
  const [attachments, segments] = await Promise.all([
    db.selectFrom("attachments as a")
      .innerJoin("rooms as r", "r.room_id", "a.room_id")
      .select(["a.attachment_id", "a.object_key", "a.uploader_user_id", "a.ciphertext_bytes"])
      .where("a.committed_seq", "is not", null)
      .whereRef("a.committed_seq", "<=", "r.retention_floor_seq")
      .where(sql<boolean>`(
        SELECT count(DISTINCT ack.device_id)
        FROM attachment_retention_acks ack
        JOIN devices d ON d.device_id = ack.device_id AND d.revoked_at IS NULL
        WHERE ack.attachment_id = a.attachment_id
          AND EXISTS (
            SELECT 1
            FROM attachment_retention_requirements req
            JOIN room_devices rd ON rd.room_id = req.room_id AND rd.device_id = ack.device_id AND rd.removed_at IS NULL
            JOIN room_members rm ON rm.room_id = req.room_id AND rm.user_id = rd.user_id AND rm.removed_at IS NULL
            WHERE req.attachment_id = a.attachment_id
          )
      ) >= (
        SELECT max(req.minimum_copies)
        FROM attachment_retention_requirements req
        WHERE req.attachment_id = a.attachment_id
      )`)
      .where((eb) => eb.not(eb.exists(
        eb.selectFrom("attachment_grants as g").select("g.grant_id").whereRef("g.source_attachment_id", "=", "a.attachment_id"),
      )))
      .where((eb) => eb.not(eb.exists(
        eb.selectFrom("room_profile_attachments as profile").select("profile.room_id").whereRef("profile.attachment_id", "=", "a.attachment_id"),
      )))
      .orderBy("a.committed_seq").limit(50).execute(),
    db.selectFrom("archive_segments as s")
      .innerJoin("rooms as r", "r.room_id", "s.room_id")
      .select(["s.segment_id", "s.object_key", "s.byte_size", "r.created_by"])
      .whereRef("s.end_seq", "<=", "r.retention_floor_seq")
      .orderBy("s.created_at").limit(50).execute(),
  ]);
  const queries = [
    ...attachments.map((item) => db.insertInto("retention_object_deletions").values({
      object_key: item.object_key, object_type: "attachment" as const, object_id: item.attachment_id,
      owner_user_id: item.uploader_user_id, ciphertext_bytes: item.ciphertext_bytes,
      requested_at: now, attempts: 0, last_error: null,
    }).onConflict((conflict) => conflict.column("object_key").doNothing())),
    ...segments.map((item) => db.insertInto("retention_object_deletions").values({
      object_key: item.object_key, object_type: "archive" as const, object_id: item.segment_id,
      owner_user_id: item.created_by, ciphertext_bytes: item.byte_size,
      requested_at: now, attempts: 0, last_error: null,
    }).onConflict((conflict) => conflict.column("object_key").doNothing())),
  ];
  if (!queries.length) return 0;
  const results = await batch(env.DB, queries);
  return results.reduce((count, result) => count + Number(result.numAffectedRows), 0);
}

export async function processRetentionObjectDeletions(env: Env): Promise<number> {
  const db = createDatabase(env.DB);
  const candidates = await db.selectFrom("retention_object_deletions").selectAll().orderBy("requested_at").limit(50).execute();
  const candidateAttachmentIds = candidates.filter((item) => item.object_type === "attachment").map((item) => item.object_id);
  const activeProfileAttachments = candidateAttachmentIds.length ? new Set((await db.selectFrom("room_profile_attachments").select("attachment_id")
    .where("attachment_id", "in", candidateAttachmentIds).execute()).map((item) => item.attachment_id)) : new Set<string>();
  const protectedObjectKeys = candidates.filter((item) => item.object_type === "attachment" && activeProfileAttachments.has(item.object_id)).map((item) => item.object_key);
  if (protectedObjectKeys.length) await db.deleteFrom("retention_object_deletions").where("object_key", "in", protectedObjectKeys).execute();
  const pending = candidates.filter((item) => item.object_type !== "attachment" || !activeProfileAttachments.has(item.object_id));
  if (!pending.length) return 0;
  try {
    await objectStore(env).delete(pending.map((item) => item.object_key));
  } catch (error) {
    const message = (error instanceof Error ? error.message : "R2 retention deletion failed").slice(0, 500);
    await batch(env.DB, pending.map((item) => db.updateTable("retention_object_deletions")
      .set({ attempts: sql<number>`attempts + 1`, last_error: message }).where("object_key", "=", item.object_key)));
    return 0;
  }
  const attachmentIds = pending.filter((item) => item.object_type === "attachment").map((item) => item.object_id);
  const segmentIds = pending.filter((item) => item.object_type === "archive").map((item) => item.object_id);
  const usage = new Map<string, { attachmentBytes: number; attachmentObjects: number; archiveBytes: number; archiveObjects: number }>();
  for (const item of pending) {
    const current = usage.get(item.owner_user_id) ?? { attachmentBytes: 0, attachmentObjects: 0, archiveBytes: 0, archiveObjects: 0 };
    if (item.object_type === "attachment") { current.attachmentBytes += item.ciphertext_bytes; current.attachmentObjects += 1; }
    else { current.archiveBytes += item.ciphertext_bytes; current.archiveObjects += 1; }
    usage.set(item.owner_user_id, current);
  }
  await batch(env.DB, [
    ...(attachmentIds.length ? [db.deleteFrom("attachments").where("attachment_id", "in", attachmentIds)] : []),
    ...(segmentIds.length ? [db.deleteFrom("archive_segments").where("segment_id", "in", segmentIds)] : []),
    ...Array.from(usage, ([userId, item]) => db.updateTable("user_storage_usage").set({
      attachment_bytes: sql<number>`max(0, attachment_bytes - ${item.attachmentBytes})`,
      attachment_objects: sql<number>`max(0, attachment_objects - ${item.attachmentObjects})`,
      archive_bytes: sql<number>`max(0, archive_bytes - ${item.archiveBytes})`,
      archive_objects: sql<number>`max(0, archive_objects - ${item.archiveObjects})`,
      updated_at: Date.now(),
    }).where("user_id", "=", userId)),
    db.deleteFrom("retention_object_deletions").where("object_key", "in", pending.map((item) => item.object_key)),
  ]);
  return pending.length;
}

async function createRoom(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const body = await readJson(request, 2_000_000);
  const kind = body.kind;
  if (kind !== "direct" && kind !== "group") throw new HttpError(400, "Invalid room kind", "invalid_room");
  const purpose = body.purpose === undefined ? "chat" : body.purpose;
  if (purpose !== "chat" && purpose !== "saved") throw new HttpError(400, "Invalid room purpose", "invalid_room_purpose");
  if (kind === "group" && body.name !== undefined && body.name !== null) {
    throw new HttpError(400, "Group names must be sent as encrypted room profile events", "plaintext_group_name_forbidden");
  }
  const name = purpose === "saved" || kind === "group" ? null : typeof body.name === "string" ? body.name.slice(0, 100) : null;
  const requested = Array.isArray(body.members) ? body.members : [];
  const members = Array.from(new Set([auth.userId, ...requested.filter((id): id is string => typeof id === "string")])) as UserId[];
  if (purpose === "saved") {
    requireUser(auth);
    if (kind !== "group" || members.length !== 1) throw new HttpError(400, "Saved messages must be an owner-only group", "invalid_saved_room");
  }
  if (auth.actor === "bot" && (auth.botRoomId || kind !== "direct" || members.length !== 1)) throw new HttpError(403, "Personal bots may create exactly one owner-only direct room", "bot_room_scope");
  if (members.length < 1 || members.length > 32 || (kind === "direct" && members.length > 2)) throw new HttpError(400, "Invalid room members", "invalid_members");
  members.forEach((id) => assertLocalId(id, "@", env));
  await assertNoBlockedPair(env, members);
  const db = createDatabase(env.DB);
  const roomId = stringField(body, "room_id", 180) as RoomId;
  if (!isNamespacedRoomId(roomId)) throw new HttpError(400, "Invalid room ID", "invalid_room");
  assertLocalId(roomId, "!", env);
  if (purpose === "saved") {
    const existing = await db.selectFrom("rooms").select("room_id").where("created_by", "=", auth.userId).where("purpose", "=", "saved").executeTakeFirst();
    if (existing) return json({ room_id: existing.room_id, created: false });
  }
  const found = await db.selectFrom("users").select("user_id").where("user_id", "in", members).where("deletion_requested_at", "is", null).where("deleted_at", "is", null).execute();
  if (found.length !== members.length) throw new HttpError(404, "One or more users do not exist", "user_not_found");
  const deniedInvitee = (await Promise.all(members.filter((userId) => userId !== auth.userId)
    .map(async (userId) => ({ userId, allowed: await invitationAllowed(env, auth.userId, userId) })))).find((entry) => !entry.allowed);
  if (deniedInvitee) throw new HttpError(403, "A user does not accept invitations from this account", "invitation_not_allowed");
  if (kind === "group" && purpose === "chat") {
    const unknownMember = (await Promise.all(members.filter((userId) => userId !== auth.userId)
      .map(async (userId) => ({ userId, known: await hasEstablishedRelationship(env, auth.userId, userId) })))).find((entry) => !entry.known);
    if (unknownMember) throw new HttpError(403, "Create a direct message request before adding this user to a group", "group_invitation_requires_contact");
  }
  const directPeer = kind === "direct" && purpose === "chat" && members.length === 2
    ? members.find((userId) => userId !== auth.userId) ?? null : null;
  const createsMessageRequest = Boolean(directPeer && auth.actor === "user" && !(await hasEstablishedRelationship(env, auth.userId, directPeer)));
  const welcome = purpose === "saved" && body.mls_welcome === "" ? "" : stringField(body, "mls_welcome", 1_000_000);
  const ratchetTree = stringField(body, "mls_ratchet_tree", 1_000_000);
  const epoch = Number(body.mls_epoch);
  if (!Number.isInteger(epoch) || epoch < (purpose === "saved" ? 0 : 1)) throw new HttpError(400, "Invalid MLS epoch", "invalid_mls_epoch");
  const recipients = Array.isArray(body.mls_recipients) ? body.mls_recipients.filter((value): value is string => typeof value === "string") : [];
  const claimIds = Array.isArray(body.mls_claim_ids) ? body.mls_claim_ids.filter((value): value is string => typeof value === "string") : [];
  const activeDevices = await db.selectFrom("devices").select(["device_id", "user_id"]).where("user_id", "in", members).where("kind", "=", "user").where("revoked_at", "is", null).execute();
  const roomDevices = [{ device_id: auth.deviceId, user_id: auth.userId }, ...activeDevices.filter((device) => device.device_id !== auth.deviceId)];
  const expectedRecipients = activeDevices.map((device) => device.device_id).filter((deviceId) => deviceId !== auth.deviceId);
  if (new Set(recipients).size !== expectedRecipients.length || expectedRecipients.some((deviceId) => !recipients.includes(deviceId))) {
    throw new HttpError(400, "MLS Welcome must cover every other active device", "missing_mls_recipient");
  }
  const claims = claimIds.length ? await db.selectFrom("device_key_packages").select(["package_id", "device_id"])
    .where("package_id", "in", claimIds).where("claimed_by_device_id", "=", auth.deviceId).where("claim_context", "=", roomId).where("consumed_room_id", "is", null).execute() : [];
  if (claims.length !== expectedRecipients.length || expectedRecipients.some((deviceId) => !claims.some((claim) => claim.device_id === deviceId))) {
    throw new HttpError(409, "Valid one-time MLS KeyPackage claims are required", "invalid_mls_claim");
  }
  if (createsMessageRequest) {
    const reservation = await db.selectFrom("message_request_reservations").select(["requester_user_id", "recipient_user_id", "consumed_at"])
      .where("room_id", "=", roomId).executeTakeFirst();
    if (!reservation || reservation.requester_user_id !== auth.userId || reservation.recipient_user_id !== directPeer || reservation.consumed_at !== null) {
      throw new HttpError(409, "A valid message request reservation is required", "message_request_reservation_required");
    }
  }
  const joinState = JSON.stringify({ version: 1, welcome, ratchet_tree: ratchetTree });
  const now = Date.now();
  const consumed = await batch(env.DB, claims.map((claim) => db.updateTable("device_key_packages").set({ consumed_room_id: roomId }).where("package_id", "=", claim.package_id).where("consumed_room_id", "is", null)));
  if (consumed.some((result) => result.numAffectedRows !== 1n)) throw new HttpError(409, "MLS KeyPackage claim was consumed concurrently; retry", "mls_claim_race");
  try {
    await batch(env.DB, [
      db.insertInto("rooms").values({ room_id: roomId, home_server: env.SERVER_NAME, kind, purpose, name, current_seq: 0, mls_epoch: epoch, created_by: auth.userId, created_at: now }),
      ...(kind === "group" && purpose === "chat" ? [db.insertInto("room_profile_attachments").values({ room_id: roomId, attachment_id: null, profile_event_id: null, profile_seq: 0, updated_at: now })] : []),
      ...members.map((userId) => db.insertInto("room_members").values({ room_id: roomId, user_id: userId, role: userId === auth.userId ? "owner" as const : "member" as const, joined_at: now, removed_at: null })),
      ...recipients.map((deviceId) => db.insertInto("room_device_keys").values({ room_id: roomId, device_id: deviceId, encrypted_state: joinState, epoch, created_at: now })),
      ...roomDevices.map((device) => db.insertInto("room_devices").values({ room_id: roomId, device_id: device.device_id, user_id: device.user_id, joined_epoch: epoch, joined_seq: 0, removed_epoch: null, created_at: now, removed_at: null })),
      ...(createsMessageRequest && directPeer ? [db.insertInto("direct_message_requests").values({ room_id: roomId, requester_user_id: auth.userId, recipient_user_id: directPeer, status: "pending", created_at: now, resolved_at: null })] : []),
      ...(createsMessageRequest ? [db.updateTable("message_request_reservations").set({ consumed_at: now }).where("room_id", "=", roomId).where("consumed_at", "is", null)] : []),
      ...members.map((userId) => db.insertInto("sync_log").values({ recipient_user_id: userId, kind: "room.event.available", room_id: roomId, seq: null, event_id: `room:${roomId}`, payload: JSON.stringify({ type: "room.available", room_id: roomId }), created_at: now })),
      ...(auth.actor === "bot" && auth.botId ? [db.updateTable("bot_integrations").set({ room_id: roomId }).where("bot_id", "=", auth.botId).where("room_id", "is", null)] : []),
    ]);
  } catch (error) {
    if (purpose !== "saved" || !(error instanceof Error) || !error.message.includes("UNIQUE")) throw error;
    if (claimIds.length) await db.updateTable("device_key_packages").set({ consumed_room_id: null, claimed_at: null, claimed_by_device_id: null, claim_context: null })
      .where("package_id", "in", claimIds).where("claimed_by_device_id", "=", auth.deviceId).where("consumed_room_id", "=", roomId).execute();
    const existing = await db.selectFrom("rooms").select("room_id").where("created_by", "=", auth.userId).where("purpose", "=", "saved").executeTakeFirst();
    if (existing) return json({ room_id: existing.room_id, created: false });
    throw error;
  }
  const roomMembers = members.map((user_id) => ({ user_id, role: user_id === auth.userId ? "owner" as const : "member" as const }));
  await env.ROOMS.getByName(roomId).initialize(roomId, roomMembers, now, epoch);
  return json({ room_id: roomId, created: true, ...(createsMessageRequest ? { request_status: "pending" as const } : {}) }, 201);
}

async function changeMember(body: Record<string, unknown>, env: Env, auth: AuthContext, roomId: RoomId, targetUserId: UserId, remove: boolean): Promise<Response> {
  assertLocalId(targetUserId, "@", env);
  const db = createDatabase(env.DB);
  const room = await db.selectFrom("rooms").select(["kind", "purpose", "mls_epoch"]).where("room_id", "=", roomId).executeTakeFirst();
  if (!room) throw new HttpError(404, "Room not found", "not_found");
  if (room.purpose === "saved") throw new HttpError(409, "Saved messages membership cannot be changed", "fixed_membership");
  if (room.kind !== "group") throw new HttpError(409, "Direct room membership cannot be changed", "fixed_membership");
  if ((await memberRole(env, roomId, auth.userId)) !== "owner") throw new HttpError(403, "Room owner role required", "forbidden");
  const pendingDeviceChange = await db.selectFrom("device_revocation_rooms").select("revocation_id").where("room_id", "=", roomId).where("status", "=", "pending").executeTakeFirst();
  if (pendingDeviceChange) throw new HttpError(409, "A device revocation is pending in this room", "room_membership_busy");
  if (remove && targetUserId === auth.userId) throw new HttpError(409, "The owner cannot remove itself", "owner_required");

  if (!body.event || typeof body.event !== "object") throw new HttpError(400, "Signed MLS commit event required", "missing_mls_commit");
  const event = await verifyEvent(env, auth, body.event as Record<string, unknown>, roomId);
  if (event.type !== "control.group.commit") throw new HttpError(400, "Expected control.group.commit", "invalid_mls_commit");
  const action = remove ? "remove" : "add";
  if (event.metadata.membership_action !== action || event.metadata.target_user_id !== targetUserId) {
    throw new HttpError(400, "Signed membership target does not match the request", "invalid_mls_commit");
  }
  const leaveRequestId = event.metadata.leave_request_id;
  if (leaveRequestId !== undefined) {
    if (!remove || typeof leaveRequestId !== "string" || !/^leave_[A-Za-z0-9_-]{16,64}$/.test(leaveRequestId)) {
      throw new HttpError(400, "Signed leave request reference is invalid", "invalid_mls_commit");
    }
  }
  const epoch = Number(event.metadata.mls_epoch);
  if (!Number.isInteger(epoch) || epoch < 2) throw new HttpError(409, "MLS commit epoch is invalid", "stale_epoch");
  const duplicateRow = await db.selectFrom("room_events").select("event_json").where("room_id", "=", roomId).where("event_id", "=", event.event_id).executeTakeFirst();
  const duplicate = duplicateRow ? JSON.parse(duplicateRow.event_json) as RoomEvent : null;
  if (duplicate && duplicate.signature !== event.signature) throw new HttpError(409, "Event ID is already bound to another signed envelope", "event_id_conflict");

  const target = await db.selectFrom("users").select("user_id").where("user_id", "=", targetUserId).where("deletion_requested_at", "is", null).where("deleted_at", "is", null).executeTakeFirst();
  if (!target) throw new HttpError(404, "User not found", "user_not_found");
  const active = await db.selectFrom("room_members").select(["user_id", "removed_at"]).where("room_id", "=", roomId).where("user_id", "=", targetUserId).executeTakeFirst();
  const applied = remove ? Boolean(active && active.removed_at !== null) : active?.removed_at === null;
  if (duplicate && room.mls_epoch === epoch && applied) return json({ room_id: roomId, user_id: targetUserId, epoch, event: duplicate });
  if (typeof leaveRequestId === "string") {
    const leaveRequest = await db.selectFrom("room_leave_requests").select(["request_id", "status", "commit_event_id"])
      .where("request_id", "=", leaveRequestId).where("room_id", "=", roomId).where("user_id", "=", targetUserId)
      .executeTakeFirst();
    if (!leaveRequest || (leaveRequest.status !== "pending" && !(leaveRequest.status === "processing" && leaveRequest.commit_event_id === event.event_id))) {
      throw new HttpError(409, "Room leave request was cancelled", "room_leave_cancelled");
    }
  }
  if (room.mls_epoch !== epoch - 1 || applied) {
    throw new HttpError(409, duplicate ? "Membership commit reconciliation state conflicts" : remove ? "User is not an active member" : "User is already a member", duplicate ? "membership_reconciliation_conflict" : "membership_conflict");
  }
  if (!remove) {
    const activeUserIds = (await db.selectFrom("room_members").select("user_id").where("room_id", "=", roomId).where("removed_at", "is", null).execute()).map((member) => member.user_id);
    await assertNoBlockedPair(env, [...activeUserIds, targetUserId]);
    if (!(await invitationAllowed(env, auth.userId, targetUserId))) throw new HttpError(403, "This user does not accept invitations from this account", "invitation_not_allowed");
  }

  let joinState: string | null = null;
  const targetDevices = (await db.selectFrom("devices").select("device_id").where("user_id", "=", targetUserId).where("kind", "=", "user").where("revoked_at", "is", null).execute()).map((device) => device.device_id);
  const signedTargetDevices = Array.isArray(event.metadata.target_device_ids) ? event.metadata.target_device_ids.filter((value): value is string => typeof value === "string") : [];
  if (new Set(signedTargetDevices).size !== targetDevices.length || targetDevices.some((deviceId) => !signedTargetDevices.includes(deviceId))) {
    throw new HttpError(400, "Signed membership device set is incomplete", "missing_mls_recipient");
  }
  let claims: Array<{ package_id: string; device_id: string; consumed_room_id: string | null }> = [];
  if (!remove) {
    const welcome = stringField(body, "mls_welcome", 1_000_000);
    const ratchetTree = stringField(body, "mls_ratchet_tree", 1_000_000);
    const recipients = Array.isArray(body.mls_recipients) ? body.mls_recipients.filter((value): value is string => typeof value === "string") : [];
    if (new Set(recipients).size !== targetDevices.length || targetDevices.some((deviceId) => !recipients.includes(deviceId))) throw new HttpError(400, "MLS Welcome must cover every target device", "missing_mls_recipient");
    const claimIds = Array.isArray(body.mls_claim_ids) ? body.mls_claim_ids.filter((value): value is string => typeof value === "string") : [];
    claims = claimIds.length ? await db.selectFrom("device_key_packages").select(["package_id", "device_id", "consumed_room_id"])
      .where("package_id", "in", claimIds).where("claimed_by_device_id", "=", auth.deviceId).where("claim_context", "=", roomId).execute() : [];
    if (new Set(claimIds).size !== targetDevices.length || claims.length !== targetDevices.length
      || targetDevices.some((deviceId) => !claims.some((claim) => claim.device_id === deviceId && (claim.consumed_room_id === null || claim.consumed_room_id === roomId)))) {
      throw new HttpError(409, "Valid one-time MLS KeyPackage claims are required", "invalid_mls_claim");
    }
    joinState = JSON.stringify({ version: 1, welcome, ratchet_tree: ratchetTree });
  }

  const now = Date.now();
  const unconsumedClaims = claims.filter((claim) => claim.consumed_room_id === null);
  if (unconsumedClaims.length) {
    await batch(env.DB, unconsumedClaims.map((claim) => db.updateTable("device_key_packages").set({ consumed_room_id: roomId })
      .where("package_id", "=", claim.package_id).where("consumed_room_id", "is", null)));
    const consumed = await db.selectFrom("device_key_packages").select(["package_id", "consumed_room_id"])
      .where("package_id", "in", unconsumedClaims.map((claim) => claim.package_id)).execute();
    if (consumed.length !== unconsumedClaims.length || consumed.some((claim) => claim.consumed_room_id !== roomId)) {
      throw new HttpError(409, "MLS KeyPackage claim was consumed concurrently", "mls_claim_race");
    }
  }
  if (typeof leaveRequestId === "string") {
    const claimed = await db.updateTable("room_leave_requests").set({ status: "processing", commit_event_id: event.event_id, updated_at: now })
      .where("request_id", "=", leaveRequestId).where("status", "=", "pending").executeTakeFirst();
    if (claimed.numUpdatedRows !== 1n) {
      const current = await db.selectFrom("room_leave_requests").select(["status", "commit_event_id"]).where("request_id", "=", leaveRequestId).executeTakeFirst();
      if (current?.status !== "processing" || current.commit_event_id !== event.event_id) {
        throw new HttpError(409, "Room leave request was cancelled", "room_leave_cancelled");
      }
    }
  }
  let accepted: RoomEvent;
  try {
    accepted = await appendRoomEvent(env, roomId, event, epoch - 1);
    if (remove) await env.ROOMS.getByName(roomId).removeMember(targetUserId, auth.userId, now);
    else await env.ROOMS.getByName(roomId).addMember(targetUserId, "member", auth.userId, now);
  } catch (cause) {
    if (typeof leaveRequestId === "string") await db.updateTable("room_leave_requests").set({ status: "pending", commit_event_id: null, updated_at: Date.now() })
      .where("request_id", "=", leaveRequestId).where("status", "=", "processing").where("commit_event_id", "=", event.event_id).execute();
    throw cause;
  }
  const membership = remove
    ? db.updateTable("room_members").set({ removed_at: now }).where("room_id", "=", roomId).where("user_id", "=", targetUserId)
    : db.insertInto("room_members").values({ room_id: roomId, user_id: targetUserId, role: "member", joined_at: now, removed_at: null })
      .onConflict((conflict) => conflict.columns(["room_id", "user_id"]).doUpdateSet({ role: "member", joined_at: now, removed_at: null }));
  await batch(env.DB, [
    membership,
    db.updateTable("rooms").set({ mls_epoch: epoch }).where("room_id", "=", roomId),
    ...(!remove && joinState ? targetDevices.map((deviceId) => db.insertInto("room_device_keys").values({ room_id: roomId, device_id: deviceId, encrypted_state: joinState, epoch, created_at: now })) : []),
    ...(!remove ? targetDevices.map((deviceId) => db.insertInto("room_devices").values({ room_id: roomId, device_id: deviceId, user_id: targetUserId, joined_epoch: epoch, joined_seq: accepted.seq, removed_epoch: null, created_at: now, removed_at: null })
      .onConflict((conflict) => conflict.columns(["room_id", "device_id"]).doUpdateSet({ user_id: targetUserId, joined_epoch: epoch, joined_seq: accepted.seq, removed_epoch: null, created_at: now, removed_at: null }))) : []),
    ...(remove ? [db.updateTable("room_devices").set({ removed_epoch: epoch, removed_at: now }).where("room_id", "=", roomId).where("user_id", "=", targetUserId).where("removed_at", "is", null)] : []),
    ...(remove && targetDevices.length ? [db.deleteFrom("room_device_keys").where("room_id", "=", roomId).where("device_id", "in", targetDevices)] : []),
    ...(remove ? [db.updateTable("room_leave_requests").set({ status: "complete", completed_at: now, updated_at: now })
      .where("room_id", "=", roomId).where("user_id", "=", targetUserId).where("status", "in", ["pending", "processing"])] : []),
    ...(!remove ? [db.insertInto("sync_log").values({ recipient_user_id: targetUserId, kind: "room.event.available", room_id: roomId, seq: accepted.seq, event_id: `membership:${roomId}:${epoch}`, payload: JSON.stringify({ type: "control.member.add", room_id: roomId, user_id: targetUserId, epoch }), created_at: now })] : []),
  ]);
  return json({ room_id: roomId, user_id: targetUserId, epoch, event: accepted });
}

async function setRoomLeaveRequest(env: Env, auth: AuthContext, roomId: RoomId, pending: boolean, ctx: ExecutionContext): Promise<Response> {
  requireUser(auth);
  const db = createDatabase(env.DB);
  const membership = await db.selectFrom("room_members as member").innerJoin("rooms as room", "room.room_id", "member.room_id")
    .select(["member.role", "member.removed_at", "room.kind", "room.purpose"])
    .where("member.room_id", "=", roomId).where("member.user_id", "=", auth.userId).executeTakeFirst();
  if (!membership || membership.removed_at !== null) throw new HttpError(404, "Room not found", "not_found");
  if (membership.kind !== "group" || membership.purpose !== "chat") throw new HttpError(409, "Only group chats can be left", "fixed_membership");
  if (membership.role === "owner") throw new HttpError(409, "Transfer room ownership before leaving", "owner_transfer_required");
  const existing = await db.selectFrom("room_leave_requests").select(["request_id", "status"])
    .where("room_id", "=", roomId).where("user_id", "=", auth.userId).executeTakeFirst();
  const owner = await db.selectFrom("room_members").select("user_id").where("room_id", "=", roomId)
    .where("role", "=", "owner").where("removed_at", "is", null).executeTakeFirst();
  if (!owner) throw new HttpError(409, "Room has no active owner", "owner_required");
  if (!pending) {
    if (existing?.status === "pending") {
      const now = Date.now();
      const cancelled = await db.updateTable("room_leave_requests").set({ status: "cancelled", commit_event_id: null, updated_at: now, completed_at: null })
        .where("request_id", "=", existing.request_id).where("status", "=", "pending").executeTakeFirst();
      if (cancelled.numUpdatedRows !== 1n) throw new HttpError(409, "Room leave is already being processed", "room_leave_processing");
      await batch(env.DB, [
        db.insertInto("sync_log").values({ recipient_user_id: auth.userId, kind: "device.event", room_id: roomId, seq: null,
          event_id: `room-leave-cancelled:self:${existing.request_id}:${now}`, payload: JSON.stringify({ type: "room.leave.updated", room_id: roomId }), created_at: now }),
        db.insertInto("sync_log").values({ recipient_user_id: owner.user_id, kind: "device.event", room_id: roomId, seq: null,
          event_id: `room-leave-cancelled:owner:${existing.request_id}:${now}`, payload: JSON.stringify({ type: "room.leave.cancelled", room_id: roomId }), created_at: now }),
      ]);
      ctx.waitUntil(Promise.all([notifyAccountDevices(env, auth.userId, auth.deviceId), notifyAccountDevices(env, owner.user_id)]).then(() => undefined));
    }
    if (existing?.status === "processing") throw new HttpError(409, "Room leave is already being processed", "room_leave_processing");
    return new Response(null, { status: 204 });
  }
  if (existing?.status === "pending" || existing?.status === "processing") return json({ request_id: existing.request_id, room_id: roomId, status: "pending" as const });
  const requestId = existing?.request_id ?? `leave_${randomId(18)}`;
  const now = Date.now();
  await batch(env.DB, [
    db.insertInto("room_leave_requests").values({ request_id: requestId, room_id: roomId, user_id: auth.userId, status: "pending", commit_event_id: null, requested_at: now, updated_at: now, completed_at: null })
      .onConflict((conflict) => conflict.columns(["room_id", "user_id"]).doUpdateSet({ status: "pending", commit_event_id: null, requested_at: now, updated_at: now, completed_at: null })),
    db.insertInto("sync_log").values({ recipient_user_id: owner.user_id, kind: "device.event", room_id: roomId, seq: null,
      event_id: `room-leave:${requestId}:${now}`, payload: JSON.stringify({ type: "room.leave.requested", room_id: roomId }), created_at: now }),
    db.insertInto("sync_log").values({ recipient_user_id: auth.userId, kind: "device.event", room_id: roomId, seq: null,
      event_id: `room-leave:self:${requestId}:${now}`, payload: JSON.stringify({ type: "room.leave.updated", room_id: roomId }), created_at: now }),
  ]);
  ctx.waitUntil(Promise.all([notifyAccountDevices(env, owner.user_id), notifyAccountDevices(env, auth.userId, auth.deviceId)]).then(() => undefined));
  return json({ request_id: requestId, room_id: roomId, status: "pending" as const }, 202);
}

async function roomLeaveTasks(env: Env, auth: AuthContext): Promise<Response> {
  requireUser(auth);
  const db = createDatabase(env.DB);
  const rows = await db.selectFrom("room_leave_requests as request")
    .innerJoin("room_members as owner", (join) => join.onRef("owner.room_id", "=", "request.room_id").on("owner.role", "=", "owner").on("owner.removed_at", "is", null))
    .innerJoin("room_members as target", (join) => join.onRef("target.room_id", "=", "request.room_id").onRef("target.user_id", "=", "request.user_id").on("target.removed_at", "is", null))
    .select(["request.request_id", "request.room_id", "request.user_id as target_user_id"])
    .where("request.status", "=", "pending").where("owner.user_id", "=", auth.userId).orderBy("request.updated_at").limit(100).execute();
  return json({ tasks: await Promise.all(rows.map(async (row) => ({
    ...row,
    target_device_ids: (await db.selectFrom("room_devices").select("device_id").where("room_id", "=", row.room_id)
      .where("user_id", "=", row.target_user_id).where("removed_at", "is", null).orderBy("device_id").execute()).map((device) => device.device_id),
  }))) });
}

async function getRoom(env: Env, auth: AuthContext, roomId: RoomId): Promise<Response> {
  if (!(await memberRole(env, roomId, auth.userId))) throw new HttpError(404, "Room not found", "not_found");
  const db = createDatabase(env.DB);
  const room = await db.selectFrom("rooms as r")
    .innerJoin("room_devices as current_device", (join) => join.onRef("current_device.room_id", "=", "r.room_id").on("current_device.device_id", "=", auth.deviceId))
    .leftJoin("device_room_preferences as pref", (join) => join.onRef("pref.room_id", "=", "r.room_id").on("pref.device_id", "=", auth.deviceId))
    .select(["r.room_id", "r.home_server", "r.kind", "r.purpose", "r.name", "r.current_seq", "r.created_at", "r.mls_epoch as epoch", "current_device.joined_seq", "pref.muted_until"])
    .where("r.room_id", "=", roomId).where("current_device.removed_at", "is", null).executeTakeFirst();
  if (!room) throw new HttpError(404, "Room not found", "not_found");
  const [members, state, blockedRows, hiddenRows, request, requestMessage, leaveRequest] = await Promise.all([
    db.selectFrom("room_members as member").innerJoin("users as user", "user.user_id", "member.user_id")
      .select(["member.user_id", "user.display_name", "user.avatar_id", "member.role"]).where("member.room_id", "=", roomId).where("member.removed_at", "is", null).orderBy("member.joined_at").execute(),
    db.selectFrom("room_device_keys").select(["encrypted_state", "epoch"]).where("room_id", "=", roomId).where("device_id", "=", auth.deviceId).orderBy("epoch", "desc").executeTakeFirst(),
    db.selectFrom("user_blocks").select("blocked_user_id").where("blocker_user_id", "=", auth.userId).execute(),
    db.selectFrom("group_hidden_members").select("hidden_user_id").where("room_id", "=", roomId).where("user_id", "=", auth.userId).execute(),
    db.selectFrom("direct_message_requests").select(["requester_user_id", "recipient_user_id", "status"]).where("room_id", "=", roomId).executeTakeFirst(),
    db.selectFrom("room_events").select("event_id").where("room_id", "=", roomId).where("event_type", "in", [...visibleMessageEventTypes]).executeTakeFirst(),
    db.selectFrom("room_leave_requests").select("status").where("room_id", "=", roomId).where("user_id", "=", auth.userId).where("status", "in", ["pending", "processing"]).executeTakeFirst(),
  ]);
  const blockedByMe = new Set(blockedRows.map((row) => row.blocked_user_id));
  return json({ room: { ...room, members: members.map(({ avatar_id, ...member }) => ({ ...member, avatar_url: avatarUrl(avatar_id) })), hidden_member_ids: hiddenRows.map((row) => row.hidden_user_id), encrypted_state: state?.encrypted_state ?? null, blocked_by_me: members.some((member) => blockedByMe.has(member.user_id)), leave_status: leaveRequest ? "pending" as const : null, ...requestView(request ?? null, auth.userId, Boolean(requestMessage)) } });
}

async function setGroupMemberHidden(env: Env, auth: AuthContext, roomId: RoomId, targetUserId: UserId, hidden: boolean): Promise<Response> {
  requireUser(auth);
  assertLocalId(targetUserId, "@", env);
  if (targetUserId === auth.userId) throw new HttpError(400, "A user cannot hide itself", "invalid_hidden_member");
  const db = createDatabase(env.DB);
  const room = await db.selectFrom("rooms as r")
    .innerJoin("room_members as mine", (join) => join.onRef("mine.room_id", "=", "r.room_id").on("mine.user_id", "=", auth.userId).on("mine.removed_at", "is", null))
    .select(["r.kind", "r.purpose"]).where("r.room_id", "=", roomId).executeTakeFirst();
  if (!room) throw new HttpError(404, "Room not found", "not_found");
  if (room.kind !== "group" || room.purpose !== "chat") throw new HttpError(400, "Members can only be hidden in group chats", "not_group_chat");
  const target = await db.selectFrom("room_members").select("user_id").where("room_id", "=", roomId)
    .where("user_id", "=", targetUserId).where("removed_at", "is", null).executeTakeFirst();
  if (!target) throw new HttpError(404, "Group member not found", "member_not_found");
  const now = Date.now();
  const change = hidden
    ? db.insertInto("group_hidden_members").values({ room_id: roomId, user_id: auth.userId, hidden_user_id: targetUserId, created_at: now })
      .onConflict((conflict) => conflict.columns(["room_id", "user_id", "hidden_user_id"]).doNothing())
    : db.deleteFrom("group_hidden_members").where("room_id", "=", roomId).where("user_id", "=", auth.userId).where("hidden_user_id", "=", targetUserId);
  await batch(env.DB, [
    change,
    db.insertInto("sync_log").values({
      recipient_user_id: auth.userId, kind: "device.event", room_id: roomId, seq: null, event_id: null,
      payload: JSON.stringify({ type: "room.hidden_members.updated", room_id: roomId }), created_at: now,
    }),
  ]);
  return new Response(null, { status: 204 });
}

async function resolveMessageRequest(env: Env, auth: AuthContext, roomId: RoomId, status: "accepted" | "rejected"): Promise<Response> {
  requireUser(auth);
  const db = createDatabase(env.DB); const request = await directRequestState(env, roomId);
  if (!request || request.recipient_user_id !== auth.userId) throw new HttpError(404, "Message request not found", "not_found");
  if (request.status === status) return json({ room_id: roomId, status });
  if (request.status !== "pending") throw new HttpError(409, "Message request has already been resolved", "message_request_resolved");
  const now = Date.now();
  await batch(env.DB, [
    db.updateTable("direct_message_requests").set({ status, resolved_at: now }).where("room_id", "=", roomId).where("status", "=", "pending"),
    ...[request.requester_user_id, request.recipient_user_id].map((userId) => db.insertInto("sync_log").values({
      recipient_user_id: userId, kind: "room.event.available", room_id: roomId, seq: null,
      event_id: `request:${roomId}:${status}`, payload: JSON.stringify({ type: "message_request.updated", room_id: roomId, status }), created_at: now,
    })),
  ]);
  return json({ room_id: roomId, status });
}

async function reportMessageRequest(request: Request, env: Env, auth: AuthContext, roomId: RoomId): Promise<Response> {
  requireUser(auth);
  const state = await directRequestState(env, roomId);
  if (!state || state.recipient_user_id !== auth.userId) throw new HttpError(404, "Message request not found", "not_found");
  const body = await readJson(request, 4_096); const category = body.category;
  if (category !== "spam" && category !== "abuse" && category !== "other") throw new HttpError(400, "Invalid report category", "invalid_report");
  const eventId = body.event_id === undefined ? null : stringField(body, "event_id", 96);
  const db = createDatabase(env.DB);
  if (eventId && !(await db.selectFrom("room_events").select("event_id").where("room_id", "=", roomId).where("event_id", "=", eventId).executeTakeFirst())) {
    throw new HttpError(400, "Reported event does not belong to this conversation", "invalid_report_event");
  }
  const now = Date.now();
  await batch(env.DB, [
    db.insertInto("room_reports").values({ report_id: randomId(18), room_id: roomId, reporter_user_id: auth.userId, reported_user_id: state.requester_user_id, category, event_id: eventId, created_at: now })
      .onConflict((conflict) => conflict.columns(["room_id", "reporter_user_id"]).doNothing()),
    db.insertInto("user_blocks").values({ blocker_user_id: auth.userId, blocked_user_id: state.requester_user_id, created_at: now })
      .onConflict((conflict) => conflict.columns(["blocker_user_id", "blocked_user_id"]).doNothing()),
    db.updateTable("direct_message_requests").set({ status: "rejected", resolved_at: now }).where("room_id", "=", roomId).where("status", "=", "pending"),
    ...[state.requester_user_id, state.recipient_user_id].map((userId) => db.insertInto("sync_log").values({
      recipient_user_id: userId, kind: "room.event.available", room_id: roomId, seq: null,
      event_id: `request:${roomId}:reported`, payload: JSON.stringify({ type: "message_request.updated", room_id: roomId, status: "rejected" }), created_at: now,
    })),
  ]);
  return json({ room_id: roomId, status: "rejected" });
}

async function setRoomNotificationPreference(request: Request, env: Env, auth: AuthContext, roomId: RoomId): Promise<Response> {
  requireUser(auth);
  if (!(await memberRole(env, roomId, auth.userId))) throw new HttpError(404, "Room not found", "not_found");
  const body = await readJson(request, 2_048);
  const value = body.muted_until;
  if (value !== null && (!Number.isSafeInteger(value) || Number(value) < 0)) throw new HttpError(400, "Invalid mute expiry", "invalid_mute_expiry");
  const mutedUntil = value === null || Number(value) <= Date.now() ? null : Number(value);
  const now = Date.now();
  await createDatabase(env.DB).insertInto("device_room_preferences").values({ device_id: auth.deviceId, room_id: roomId, muted_until: mutedUntil, updated_at: now })
    .onConflict((conflict) => conflict.columns(["device_id", "room_id"]).doUpdateSet({ muted_until: mutedUntil, updated_at: now })).execute();
  return json({ room_id: roomId, muted_until: mutedUntil });
}

function exactBase64UrlBytes(value: unknown, bytes: number): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try { const decoded = fromB64url(value); return decoded.byteLength === bytes && b64url(decoded) === value; }
  catch { return false; }
}

async function putEncryptedDraft(request: Request, env: Env, auth: AuthContext, roomId: RoomId): Promise<Response> {
  requireUser(auth);
  const db = createDatabase(env.DB);
  const access = await db.selectFrom("room_members as rm")
    .innerJoin("room_devices as rd", (join) => join.onRef("rd.room_id", "=", "rm.room_id").on("rd.device_id", "=", auth.deviceId))
    .select("rm.room_id").where("rm.room_id", "=", roomId).where("rm.user_id", "=", auth.userId)
    .where("rm.removed_at", "is", null).where("rd.removed_at", "is", null).executeTakeFirst();
  if (!access) throw new HttpError(404, "Room not found", "not_found");
  const body = await readJson(request, 2_000_000);
  if (!Array.isArray(body.envelopes) || body.envelopes.length < 1 || body.envelopes.length > 50) {
    throw new HttpError(400, "Draft requires 1-50 device envelopes", "invalid_draft");
  }
  const targets = await db.selectFrom("devices").select("device_id").where("user_id", "=", auth.userId)
    .where("kind", "=", "user").where("revoked_at", "is", null).orderBy("device_id").limit(51).execute();
  if (targets.length > 50) throw new HttpError(409, "Account has too many active devices", "device_limit");
  const expected = new Set(targets.map((target) => target.device_id));
  const envelopes = body.envelopes as Array<Record<string, unknown>>;
  const received = new Set(envelopes.map((envelope) => envelope.target_device_id).filter((value): value is string => typeof value === "string"));
  if (received.size !== envelopes.length || received.size !== expected.size || [...expected].some((deviceId) => !received.has(deviceId))) {
    throw new HttpError(409, "Draft device set is stale", "draft_device_set_stale");
  }
  const source = await db.selectFrom("devices").select("signing_key").where("device_id", "=", auth.deviceId)
    .where("user_id", "=", auth.userId).where("revoked_at", "is", null).executeTakeFirstOrThrow();
  const signingKey = await crypto.subtle.importKey("jwk", JSON.parse(source.signing_key) as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const parsed: DraftEnvelope[] = [];
  for (const value of envelopes) {
    const key = value.ephemeral_key as Partial<JsonWebKey> | undefined;
    if (value.version !== 1 || value.room_id !== roomId || value.source_device_id !== auth.deviceId
      || typeof value.target_device_id !== "string" || !expected.has(value.target_device_id)
      || !Number.isSafeInteger(value.client_updated_at) || Number(value.client_updated_at) < 1 || Number(value.client_updated_at) > Date.now() + 24 * 60 * 60 * 1_000
      || key?.kty !== "EC" || key.crv !== "P-256" || !exactBase64UrlBytes(key.x, 32) || !exactBase64UrlBytes(key.y, 32)
      || !exactBase64UrlBytes(value.salt, 16) || !exactBase64UrlBytes(value.nonce, 12)
      || typeof value.ciphertext !== "string" || value.ciphertext.length < 20 || value.ciphertext.length > 32_000 || !/^[A-Za-z0-9_-]+$/.test(value.ciphertext)
      || !exactBase64UrlBytes(value.signature, 64)) throw new HttpError(400, "Invalid encrypted draft envelope", "invalid_draft");
    const envelope = value as unknown as DraftEnvelope;
    try {
      await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: key.x, y: key.y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
      const { signature: _, ...unsigned } = envelope;
      if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, signingKey, fromB64url(envelope.signature), canonicalDraftEnvelopeBytes(unsigned)))) {
        throw new HttpError(400, "Invalid draft signature", "invalid_signature");
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "Invalid encrypted draft envelope", "invalid_draft");
    }
    parsed.push(envelope);
  }
  const now = Date.now();
  await batch(env.DB, [
    ...parsed.map((envelope) => db.insertInto("device_draft_envelopes").values({
      room_id: roomId, user_id: auth.userId, target_device_id: envelope.target_device_id, source_device_id: auth.deviceId,
      client_updated_at: envelope.client_updated_at, envelope_json: JSON.stringify(envelope), server_updated_at: now,
    }).onConflict((conflict) => conflict.columns(["room_id", "target_device_id"]).doUpdateSet({
      user_id: auth.userId, source_device_id: auth.deviceId, client_updated_at: envelope.client_updated_at,
      envelope_json: JSON.stringify(envelope), server_updated_at: sql<number>`max(device_draft_envelopes.server_updated_at + 1, ${now})`,
    }).where("device_draft_envelopes.client_updated_at", "<=", envelope.client_updated_at))),
    db.insertInto("sync_log").values({ recipient_user_id: auth.userId, kind: "device.event", room_id: roomId, seq: null, event_id: null,
      payload: JSON.stringify({ type: "draft.updated", room_id: roomId, source_device_id: auth.deviceId }), created_at: now }),
  ]);
  return json({ room_id: roomId, updated: parsed.length });
}

async function encryptedDrafts(url: URL, env: Env, auth: AuthContext): Promise<Response> {
  requireUser(auth);
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && !isNamespacedRoomId(cursor)) throw new HttpError(400, "Invalid draft cursor", "invalid_cursor");
  const db = createDatabase(env.DB);
  let query = db.selectFrom("device_draft_envelopes as draft")
    .innerJoin("room_members as member", (join) => join.onRef("member.room_id", "=", "draft.room_id").on("member.user_id", "=", auth.userId))
    .select(["draft.room_id", "draft.envelope_json", "draft.server_updated_at"])
    .where("draft.target_device_id", "=", auth.deviceId).where("draft.user_id", "=", auth.userId)
    .where("member.removed_at", "is", null).orderBy("draft.room_id").limit(101);
  if (cursor) query = query.where("draft.room_id", ">", cursor);
  const rows = await query.execute(); const hasMore = rows.length > 100; const page = hasMore ? rows.slice(0, 100) : rows;
  return json({
    drafts: page.map((row) => ({ ...JSON.parse(row.envelope_json) as DraftEnvelope, server_updated_at: row.server_updated_at })),
    next_cursor: hasMore ? page.at(-1)?.room_id ?? null : null,
  });
}

async function verifyEvent(env: Env, auth: AuthContext, body: Record<string, unknown>, roomId: RoomId): Promise<ClientEvent> {
  const event = body as Partial<ClientEvent>;
  if (event.room_id !== roomId || event.sender !== auth.userId || event.device_id !== auth.deviceId) throw new HttpError(400, "Event identity mismatch", "invalid_event");
  if (!isClientEventEnvelope(event)) throw new HttpError(400, "Invalid event envelope", "invalid_event");
  assertLocalId(event.event_id, "$", env);
  if (typeof event.created_at !== "number" || Math.abs(Date.now() - event.created_at) > 24 * 60 * 60 * 1_000) throw new HttpError(400, "Invalid event time", "invalid_event");
  if (typeof event.ciphertext !== "string" || event.ciphertext.length > MAX_EVENT_CIPHERTEXT_LENGTH || !event.metadata || typeof event.metadata !== "object" || typeof event.signature !== "string") throw new HttpError(400, "Invalid encrypted event", "invalid_event");
  const complete = event as ClientEvent;
  const row = await createDatabase(env.DB).selectFrom("devices as d")
    .innerJoin("room_devices as rd", (join) => join.onRef("rd.device_id", "=", "d.device_id").on("rd.room_id", "=", roomId))
    .select("d.signing_key")
    .where("d.device_id", "=", auth.deviceId).where("d.user_id", "=", auth.userId).where("d.revoked_at", "is", null).where("rd.removed_at", "is", null).executeTakeFirst();
  if (!row) throw new HttpError(403, "This device has not joined the encrypted room", "device_not_in_room");
  const key = await crypto.subtle.importKey("jwk", JSON.parse(row.signing_key) as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const { signature: _, ...unsigned } = complete;
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64url(complete.signature), canonicalEventBytes(unsigned));
  if (!valid) throw new HttpError(400, "Invalid device signature", "invalid_signature");
  return complete;
}

async function resolveForwardAttachment(env: Env, userId: string, referenceId: string): Promise<{ attachment_id: string }> {
  const db = createDatabase(env.DB);
  const source = await db.selectFrom("attachments as a")
    .innerJoin("room_members as rm", "rm.room_id", "a.room_id")
    .select("a.attachment_id")
    .where("a.attachment_id", "=", referenceId).where("a.committed_event_id", "is not", null).where("a.source_deleted_at", "is", null)
    .where("rm.user_id", "=", userId).where("rm.removed_at", "is", null).executeTakeFirst();
  if (source) return source;
  const grant = await db.selectFrom("attachment_grants as g")
    .innerJoin("attachments as a", "a.attachment_id", "g.source_attachment_id")
    .innerJoin("room_members as rm", "rm.room_id", "g.room_id")
    .select("a.attachment_id")
    .where("g.grant_id", "=", referenceId).where("rm.user_id", "=", userId).where("rm.removed_at", "is", null).executeTakeFirst();
  if (!grant) throw new HttpError(404, "Forwarded attachment is unavailable", "forward_attachment_unavailable");
  return grant;
}

type EventAttachmentReference = { attachmentId: string; sourceAttachmentId: string | null };
type RoomProfileAvatarTransition = { attachmentId: string | null; previousAttachmentId: string | null };

function roomProfileAvatarTransition(event: ClientEvent): RoomProfileAvatarTransition | null {
  if (event.type !== "control.room.profile") return null;
  const attachmentId = event.metadata.room_profile_avatar_id;
  const previousAttachmentId = event.metadata.room_profile_previous_avatar_id;
  const valid = (value: unknown) => value === null || (typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value));
  if (!valid(attachmentId) || !valid(previousAttachmentId)) {
    throw new HttpError(400, "Invalid encrypted room profile avatar metadata", "invalid_room_profile_avatar");
  }
  return { attachmentId: attachmentId as string | null, previousAttachmentId: previousAttachmentId as string | null };
}

function eventAttachmentReferences(event: ClientEvent): EventAttachmentReference[] {
  const pluralIds = event.metadata.attachment_ids;
  const pluralSourceIds = event.metadata.forward_source_attachment_ids;
  const legacyId = typeof event.metadata.attachment_id === "string" ? event.metadata.attachment_id : null;
  const legacySourceId = typeof event.metadata.forward_source_attachment_id === "string" ? event.metadata.forward_source_attachment_id : null;
  if ((pluralIds !== undefined || pluralSourceIds !== undefined) && (legacyId || legacySourceId)) {
    throw new HttpError(400, "Conflicting attachment metadata", "invalid_attachment");
  }
  const ids = Array.isArray(pluralIds) ? pluralIds : legacyId ? [legacyId] : [];
  const sourceIds = Array.isArray(pluralSourceIds) ? pluralSourceIds : legacySourceId ? [legacySourceId] : [];
  if (ids.length > MAX_MESSAGE_ATTACHMENTS || (sourceIds.length && sourceIds.length !== ids.length)
    || ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(id))
    || sourceIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(id))
    || new Set(ids).size !== ids.length || new Set(sourceIds).size !== sourceIds.length) {
    throw new HttpError(400, "Invalid attachment metadata", "invalid_attachment");
  }
  if (ids.length && !visibleMessageEventTypes.has(event.type)) throw new HttpError(400, "Attachments require a visible message event", "invalid_attachment");
  if (ids.length && event.type === "message.contact") throw new HttpError(400, "Contact cards cannot reference attachments", "invalid_attachment");
  return ids.map((attachmentId, index) => ({ attachmentId, sourceAttachmentId: sourceIds[index] ?? null }));
}

async function sendEvent(request: Request, env: Env, ctx: ExecutionContext, auth: AuthContext, roomId: RoomId): Promise<Response> {
  const body = await readJson(request);
  const event = await verifyEvent(env, auth, body, roomId);
  await consumeBotMessageCapability(env, auth, event);
  if (event.type === "typing.start" || event.type === "typing.stop") throw new HttpError(409, "Typing state is WebSocket-only and ephemeral", "ephemeral_only");
  if (event.type === "control.key.update") throw new HttpError(409, "Archive keys are device-wrapped inside segment format v3", "invalid_control_path");
  if (event.type === "control.group.commit" || event.type === "control.member.add" || event.type === "control.member.remove"
    || event.type === "control.device.add" || event.type === "control.device.revoke") {
    throw new HttpError(409, "Use the MLS membership endpoint for membership control events", "invalid_control_path");
  }
  const db = createDatabase(env.DB);
  const [roomEpoch, duplicateRow] = await Promise.all([
    db.selectFrom("rooms as room").innerJoin("room_members as member", (join) => join
      .onRef("member.room_id", "=", "room.room_id").on("member.user_id", "=", auth.userId))
      .select(["room.mls_epoch", "room.kind", "room.purpose", "member.role", "member.removed_at"])
      .where("room.room_id", "=", roomId).executeTakeFirst(),
    db.selectFrom("room_events").select("event_json").where("event_id", "=", event.event_id).where("room_id", "=", roomId).executeTakeFirst(),
  ]);
  const duplicate = duplicateRow ? JSON.parse(duplicateRow.event_json) as RoomEvent : null;
  if (duplicate && duplicate.signature !== event.signature) throw new HttpError(409, "Event ID is already bound to another signed envelope", "event_id_conflict");
  if (!duplicate && roomEpoch?.kind === "direct" && await directRoomBlocked(env, roomId)) throw new HttpError(403, "Conversation is unavailable", "direct_unavailable");
  const eventEpoch = Number(event.metadata.mls_epoch);
  if (!duplicate && (!roomEpoch || !Number.isInteger(eventEpoch) || eventEpoch !== roomEpoch.mls_epoch)) {
    throw new HttpError(409, "Encrypted event was created for a stale MLS epoch", "stale_epoch");
  }
  if (!roomEpoch) throw new HttpError(404, "Room not found", "not_found");
  if (!duplicate && await roomLeavePending(env, roomId, auth.userId)) {
    throw new HttpError(409, "Room leave is waiting for the owner to update encryption", "room_leave_pending");
  }
  if (event.type === "control.owner.transfer") {
    const targetUserId = event.metadata.target_user_id;
    if (typeof targetUserId !== "string") throw new HttpError(400, "Signed ownership target is required", "invalid_owner_transfer");
    assertLocalId(targetUserId, "@", env);
    if (targetUserId === auth.userId) throw new HttpError(400, "Ownership must be transferred to another member", "invalid_owner_transfer");
    if (roomEpoch.kind !== "group" || roomEpoch.purpose !== "chat" || roomEpoch.removed_at !== null) {
      throw new HttpError(409, "Only active group chats support ownership transfer", "invalid_owner_transfer");
    }
    const target = await db.selectFrom("room_members").select(["role", "removed_at"])
      .where("room_id", "=", roomId).where("user_id", "=", targetUserId).executeTakeFirst();
    if (!duplicate && (!target || target.removed_at !== null)) throw new HttpError(409, "The new owner must be an active room member", "invalid_owner_transfer");
    if (!duplicate && await roomLeavePending(env, roomId, targetUserId)) {
      throw new HttpError(409, "The selected member is waiting to leave this room", "owner_transfer_target_leaving");
    }
    const accepted = await appendRoomEvent(env, roomId, event, roomEpoch.mls_epoch);
    if (!duplicate || (roomEpoch.role === "owner" && target?.removed_at === null)) await batch(env.DB, [
      db.updateTable("room_members").set({ role: "member" }).where("room_id", "=", roomId).where("user_id", "=", auth.userId),
      db.updateTable("room_members").set({ role: "owner" }).where("room_id", "=", roomId).where("user_id", "=", targetUserId),
    ]);
    ctx.waitUntil(notifyOfflineDevices(env, roomId, auth.deviceId));
    return json({ event: accepted }, duplicate ? 200 : 201);
  }
  if (!duplicate && event.type === "control.room.profile"
    && (roomEpoch.kind !== "group" || roomEpoch.purpose !== "chat" || roomEpoch.role !== "owner" || roomEpoch.removed_at !== null)) {
    throw new HttpError(403, "Only the group owner may update the room profile", "room_profile_forbidden");
  }
  const profileAvatar = roomProfileAvatarTransition(event);
  if (!duplicate && profileAvatar) {
    const current = await db.selectFrom("room_profile_attachments").select(["attachment_id", "profile_seq"])
      .where("room_id", "=", roomId).executeTakeFirst();
    if ((current?.attachment_id ?? null) !== profileAvatar.previousAttachmentId) {
      throw new HttpError(409, "The encrypted room profile changed on another device", "room_profile_conflict");
    }
    if (profileAvatar.attachmentId !== null && profileAvatar.attachmentId !== profileAvatar.previousAttachmentId) {
      const uploaded = await db.selectFrom("attachments").select(["attachment_id", "committed_event_id", "ciphertext_bytes"])
        .where("attachment_id", "=", profileAvatar.attachmentId).where("room_id", "=", roomId)
        .where("uploader_user_id", "=", auth.userId).executeTakeFirst();
      if (!uploaded || uploaded.committed_event_id !== null || uploaded.ciphertext_bytes > MAX_PROFILE_AVATAR_BYTES + 16) {
        throw new HttpError(409, "Room profile avatar is missing or already committed", "invalid_room_profile_avatar");
      }
    }
  }
  if (!duplicate && roomEpoch.kind === "direct") {
    const requestState = await directRequestState(env, roomId);
    if (requestState?.status === "rejected") throw new HttpError(403, "Message request was rejected", "message_request_rejected");
    if (requestState?.status === "pending") {
      if (requestState.requester_user_id !== auth.userId) throw new HttpError(409, "Accept this message request before replying", "message_request_pending");
      if (event.type !== "message.text" || eventAttachmentReferences(event).length) {
        throw new HttpError(409, "A pending request allows one text message and no attachments", "message_request_text_only");
      }
      const existing = await db.selectFrom("room_events").select("event_id").where("room_id", "=", roomId)
        .where("event_type", "in", [...visibleMessageEventTypes]).executeTakeFirst();
      if (existing) throw new HttpError(429, "Wait for the recipient to accept this message request", "message_request_message_limit");
    }
  }
  let deleteTargetEventId: string | null = null;
  if (event.type === "message.delete") {
    const targetEventId = event.metadata.target_event_id;
    if (typeof targetEventId !== "string" || !targetEventId || targetEventId.length > 96 || targetEventId === event.event_id) {
      throw new HttpError(400, "Invalid message deletion target", "invalid_delete_target");
    }
    const target = await createDatabase(env.DB).selectFrom("room_events").select(["sender", "event_type"])
      .where("event_id", "=", targetEventId).where("room_id", "=", roomId).executeTakeFirst();
    if (!target) throw new HttpError(404, "Message deletion target not found", "delete_target_not_found");
    if (target.sender !== auth.userId || !visibleMessageEventTypes.has(target.event_type)) {
      throw new HttpError(403, "Only the sender may delete this message", "delete_forbidden");
    }
    deleteTargetEventId = targetEventId;
  }
  if (event.type === "message.edit" || event.type === "message.reaction") {
    const targetEventId = event.metadata.target_event_id;
    if (typeof targetEventId !== "string" || !targetEventId || targetEventId.length > 96 || targetEventId === event.event_id) {
      throw new HttpError(400, "Invalid message relation target", "invalid_relation_target");
    }
    const target = await db.selectFrom("room_events").select(["sender", "event_type"])
      .where("event_id", "=", targetEventId).where("room_id", "=", roomId).executeTakeFirst();
    if (!target || !visibleMessageEventTypes.has(target.event_type)) throw new HttpError(404, "Message relation target not found", "relation_target_not_found");
    if (event.type === "message.edit" && target.sender !== auth.userId) throw new HttpError(403, "Only the sender may edit this message", "edit_forbidden");
  }
  const attachmentReferences = eventAttachmentReferences(event);
  const forwardReferences = attachmentReferences.filter((reference) => reference.sourceAttachmentId);
  if (forwardReferences.length && forwardReferences.length !== attachmentReferences.length) throw new HttpError(400, "Cannot mix uploaded and forwarded attachments", "invalid_attachment");
  const forwardGrants: Array<{ grant_id: string; source_attachment_id: string }> = [];
  if (forwardReferences.length) {
    const referenceIds = forwardReferences.map((reference) => reference.attachmentId);
    const [existingGrants, attachmentCollisions] = await Promise.all([
      db.selectFrom("attachment_grants").select(["grant_id", "source_attachment_id", "room_id", "grant_event_id"]).where("grant_id", "in", referenceIds).execute(),
      db.selectFrom("attachments").select("attachment_id").where("attachment_id", "in", referenceIds).execute(),
    ]);
    const existingById = new Map(existingGrants.map((grant) => [grant.grant_id, grant]));
    const collisions = new Set(attachmentCollisions.map((attachment) => attachment.attachment_id));
    for (const reference of forwardReferences) {
      const sourceId = reference.sourceAttachmentId!;
      if (reference.attachmentId === sourceId || collisions.has(reference.attachmentId)) throw new HttpError(409, "Forward attachment reference is already in use", "forward_attachment_conflict");
      const existing = existingById.get(reference.attachmentId);
      if (existing && (existing.room_id !== roomId || existing.grant_event_id !== event.event_id)) throw new HttpError(409, "Forward attachment reference is already in use", "forward_attachment_conflict");
      const source = existing ? { attachment_id: existing.source_attachment_id } : await resolveForwardAttachment(env, auth.userId, sourceId);
      forwardGrants.push({ grant_id: reference.attachmentId, source_attachment_id: source.attachment_id });
    }
  } else if (attachmentReferences.length) {
    const ids = attachmentReferences.map((reference) => reference.attachmentId);
    const attachments = await db.selectFrom("attachments").select(["attachment_id", "committed_event_id"])
      .where("attachment_id", "in", ids).where("room_id", "=", roomId).where("uploader_user_id", "=", auth.userId).execute();
    const attachmentById = new Map(attachments.map((attachment) => [attachment.attachment_id, attachment]));
    if (ids.some((id) => { const attachment = attachmentById.get(id); return !attachment || Boolean(attachment.committed_event_id && attachment.committed_event_id !== event.event_id); })) {
      throw new HttpError(409, "Attachment is missing or already committed", "invalid_attachment");
    }
  }
  const accepted = await appendRoomEvent(env, roomId, event, roomEpoch.mls_epoch);
  if (forwardGrants.length) await batch(env.DB, forwardGrants.flatMap((grant) => [
    db.insertInto("attachment_grants").values({
      ...grant, room_id: roomId, granted_by_user_id: auth.userId, grant_event_id: accepted.event_id, grant_seq: accepted.seq, created_at: Date.now(),
    }).onConflict((conflict) => conflict.column("grant_id").doNothing()),
    attachmentRetentionRequirement(db, grant.source_attachment_id, roomId),
  ]));
  else if (attachmentReferences.length) await batch(env.DB, attachmentReferences.map((reference) => db.updateTable("attachments").set({ committed_event_id: accepted.event_id, committed_seq: accepted.seq, committed_at: Date.now() })
    .where("attachment_id", "=", reference.attachmentId).where("committed_event_id", "is", null)));
  if (!duplicate && profileAvatar) {
    await db.updateTable("room_profile_attachments").set({
      attachment_id: profileAvatar.attachmentId, profile_event_id: accepted.event_id, profile_seq: accepted.seq, updated_at: Date.now(),
    }).where("room_id", "=", roomId).where("profile_seq", "<", accepted.seq).execute();
    const projected = await db.selectFrom("room_profile_attachments").select(["attachment_id", "profile_event_id"])
      .where("room_id", "=", roomId).executeTakeFirst();
    if (projected?.profile_event_id === accepted.event_id) {
      const statements = [];
      if (profileAvatar.attachmentId) {
        const committed = await db.updateTable("attachments")
          .set({ committed_event_id: accepted.event_id, committed_seq: accepted.seq, committed_at: Date.now(), source_deleted_at: null })
          .where("attachment_id", "=", profileAvatar.attachmentId)
          .where((eb) => eb.exists(eb.selectFrom("room_profile_attachments as profile").select("profile.room_id")
            .where("profile.room_id", "=", roomId).where("profile.profile_event_id", "=", accepted.event_id)
            .whereRef("profile.attachment_id", "=", "attachments.attachment_id")))
          .executeTakeFirst();
        if (committed.numUpdatedRows > 0n) {
          const currentAttachment = await db.selectFrom("attachments").select("object_key").where("attachment_id", "=", profileAvatar.attachmentId).executeTakeFirst();
          if (currentAttachment) statements.push(
            db.deleteFrom("attachment_deletions").where("attachment_id", "=", profileAvatar.attachmentId),
            db.deleteFrom("retention_object_deletions").where("object_key", "=", currentAttachment.object_key),
          );
        }
      }
      const obsoleteProfileAttachments = await db.selectFrom("attachments as a")
        .leftJoin("room_events as event", "event.event_id", "a.committed_event_id")
        .select(["a.attachment_id", "a.object_key", "a.uploader_user_id", "a.ciphertext_bytes"])
        .where("a.room_id", "=", roomId).where("a.committed_at", "is not", null)
        .where((eb) => eb.or([
          eb("event.event_type", "=", "control.room.profile"),
          ...(profileAvatar.previousAttachmentId ? [eb("a.attachment_id", "=", profileAvatar.previousAttachmentId)] : []),
        ]))
        .where((eb) => eb.not(eb.exists(eb.selectFrom("room_profile_attachments as profile").select("profile.room_id")
          .whereRef("profile.attachment_id", "=", "a.attachment_id"))))
        .execute();
      if (obsoleteProfileAttachments.length) {
        const obsoleteIds = obsoleteProfileAttachments.map((item) => item.attachment_id);
        const grantedIds = new Set((await db.selectFrom("attachment_grants").select("source_attachment_id")
          .where("source_attachment_id", "in", obsoleteIds).execute()).map((item) => item.source_attachment_id));
        for (const previous of obsoleteProfileAttachments) {
          statements.push(db.updateTable("attachments").set({ source_deleted_at: accepted.created_at }).where("attachment_id", "=", previous.attachment_id));
          if (!grantedIds.has(previous.attachment_id)) statements.push(db.insertInto("attachment_deletions").values({ ...previous, delete_event_id: accepted.event_id, requested_at: Date.now(), attempts: 0, last_error: null })
            .onConflict((conflict) => conflict.column("attachment_id").doNothing()));
        }
      }
      if (statements.length) await batch(env.DB, statements);
    }
  }
  if (deleteTargetEventId) {
    const db = createDatabase(env.DB);
    const originals = await db.selectFrom("attachments").select("attachment_id")
      .where("room_id", "=", roomId).where("committed_event_id", "=", deleteTargetEventId).execute();
    const forwarded = await db.selectFrom("attachment_grants").select("source_attachment_id").where("grant_event_id", "=", deleteTargetEventId).execute();
    if (originals.length || forwarded.length) {
      await batch(env.DB, [
        ...originals.map((item) => db.updateTable("attachments").set({ source_deleted_at: accepted.created_at }).where("attachment_id", "=", item.attachment_id)),
        db.deleteFrom("attachment_grants").where("grant_event_id", "=", deleteTargetEventId),
      ]);
      const candidateIds = Array.from(new Set([...originals.map((item) => item.attachment_id), ...forwarded.map((item) => item.source_attachment_id)]));
      const deletable = await db.selectFrom("attachments as a").select(["a.attachment_id", "a.object_key", "a.uploader_user_id", "a.ciphertext_bytes"])
        .where("a.attachment_id", "in", candidateIds).where("a.source_deleted_at", "is not", null)
        .where((eb) => eb.not(eb.exists(eb.selectFrom("attachment_grants as g").select("g.grant_id").whereRef("g.source_attachment_id", "=", "a.attachment_id"))))
        .execute();
      if (deletable.length) await batch(env.DB, deletable.map((item) => db.insertInto("attachment_deletions").values({
        ...item, delete_event_id: accepted.event_id, requested_at: Date.now(), attempts: 0, last_error: null,
      }).onConflict((conflict) => conflict.column("attachment_id").doNothing())));
      await processPendingAttachmentDeletions(env, accepted.event_id);
    }
  }
  ctx.waitUntil(notifyOfflineDevices(env, roomId, auth.deviceId));
  return json({ event: accepted }, 201);
}

export async function processPendingAttachmentDeletions(env: Env, deleteEventId?: string): Promise<number> {
  const db = createDatabase(env.DB);
  let query = db.selectFrom("attachment_deletions").selectAll().orderBy("requested_at").limit(100);
  if (deleteEventId) query = query.where("delete_event_id", "=", deleteEventId);
  const candidates = await query.execute();
  const activeProfileAttachments = candidates.length ? new Set((await db.selectFrom("room_profile_attachments").select("attachment_id")
    .where("attachment_id", "in", candidates.map((item) => item.attachment_id)).execute()).map((item) => item.attachment_id)) : new Set<string>();
  if (activeProfileAttachments.size) {
    await db.deleteFrom("attachment_deletions").where("attachment_id", "in", Array.from(activeProfileAttachments)).execute();
  }
  const pending = candidates.filter((item) => !activeProfileAttachments.has(item.attachment_id));
  if (!pending.length) return 0;
  try {
    await objectStore(env).delete(pending.map((item) => item.object_key));
  } catch (error) {
    const message = (error instanceof Error ? error.message : "R2 deletion failed").slice(0, 500);
    await batch(env.DB, pending.map((item) => db.updateTable("attachment_deletions")
      .set({ attempts: sql<number>`attempts + 1`, last_error: message }).where("attachment_id", "=", item.attachment_id)));
    return 0;
  }
  const byUser = new Map<string, { bytes: number; objects: number }>();
  for (const item of pending) {
    const usage = byUser.get(item.uploader_user_id) ?? { bytes: 0, objects: 0 };
    usage.bytes += item.ciphertext_bytes;
    usage.objects += 1;
    byUser.set(item.uploader_user_id, usage);
  }
  const ids = pending.map((item) => item.attachment_id);
  await batch(env.DB, [
    db.deleteFrom("attachments").where("attachment_id", "in", ids),
    db.deleteFrom("attachment_deletions").where("attachment_id", "in", ids),
    ...Array.from(byUser, ([userId, usage]) => db.updateTable("user_storage_usage").set({
      attachment_bytes: sql<number>`max(0, attachment_bytes - ${usage.bytes})`,
      attachment_objects: sql<number>`max(0, attachment_objects - ${usage.objects})`,
      updated_at: Date.now(),
    }).where("user_id", "=", userId)),
  ]);
  return pending.length;
}

export async function purgeUncommittedAttachments(env: Env): Promise<number> {
  const db = createDatabase(env.DB);
  const expired = await db.selectFrom("attachments").select(["attachment_id", "object_key", "uploader_user_id", "ciphertext_bytes"])
    .where("committed_at", "is", null).where("created_at", "<", Date.now() - UNCOMMITTED_ATTACHMENT_TTL_MS).orderBy("created_at").limit(100).execute();
  if (!expired.length) return 0;
  await objectStore(env).delete(expired.map((item) => item.object_key));
  const byUser = new Map<string, { bytes: number; objects: number }>();
  for (const item of expired) {
    const current = byUser.get(item.uploader_user_id) ?? { bytes: 0, objects: 0 };
    current.bytes += item.ciphertext_bytes;
    current.objects += 1;
    byUser.set(item.uploader_user_id, current);
  }
  await batch(env.DB, [
    db.deleteFrom("attachments").where("attachment_id", "in", expired.map((item) => item.attachment_id)),
    ...Array.from(byUser, ([userId, usage]) => db.updateTable("user_storage_usage").set({
      attachment_bytes: sql<number>`max(0, attachment_bytes - ${usage.bytes})`,
      attachment_objects: sql<number>`max(0, attachment_objects - ${usage.objects})`,
      updated_at: Date.now(),
    }).where("user_id", "=", userId)),
  ]);
  return expired.length;
}

function peerRecoveryToken(request: Request): string {
  const token = request.headers.get("x-peer-recovery-token") ?? "";
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new HttpError(401, "Peer recovery token required", "invalid_recovery_token");
  return token;
}

async function createRoomPeerRecovery(request: Request, env: Env, auth: AuthContext, roomId: RoomId, ctx: ExecutionContext): Promise<Response> {
  requireUser(auth);
  const body = await readJson(request, 8_192);
  const afterSeq = Number(body.after_seq); const throughSeq = Number(body.through_seq);
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(throughSeq) || throughSeq <= afterSeq
    || throughSeq - afterSeq > ROOM_PEER_RECOVERY_MAX_EVENTS) {
    throw new HttpError(400, `Peer recovery must contain 1-${ROOM_PEER_RECOVERY_MAX_EVENTS} events`, "invalid_recovery_range");
  }
  const db = createDatabase(env.DB);
  const room = await db.selectFrom("rooms as r")
    .innerJoin("room_devices as rd", (join) => join.onRef("rd.room_id", "=", "r.room_id").on("rd.device_id", "=", auth.deviceId))
    .select(["r.current_seq", "r.retention_floor_seq", "rd.joined_seq"])
    .where("r.room_id", "=", roomId).where("rd.user_id", "=", auth.userId).where("rd.removed_at", "is", null).executeTakeFirst();
  if (!room) throw new HttpError(404, "Room not found", "not_found");
  if (afterSeq < room.joined_seq || throughSeq > room.current_seq || afterSeq >= room.retention_floor_seq) {
    throw new HttpError(409, "Room range does not require peer recovery", "peer_recovery_not_required");
  }
  const sources = await db.selectFrom("room_devices as rd").innerJoin("devices as d", "d.device_id", "rd.device_id")
    .select("rd.device_id").where("rd.room_id", "=", roomId).where("rd.user_id", "=", auth.userId)
    .where("rd.device_id", "!=", auth.deviceId).where("rd.removed_at", "is", null).where("d.revoked_at", "is", null).limit(1).execute();
  if (!sources.length) throw new HttpError(409, "No other active device can provide this history", "peer_recovery_source_unavailable");
  const existing = await db.selectFrom("room_peer_recoveries").selectAll().where("room_id", "=", roomId)
    .where("target_device_id", "=", auth.deviceId).where("status", "in", ["pending", "transferring", "ready"]).executeTakeFirst();
  if (existing) {
    if (existing.after_seq !== afterSeq || existing.through_seq !== throughSeq) throw new HttpError(409, "Another recovery range is already active", "peer_recovery_conflict");
    ctx.waitUntil(notifyAccountDevices(env, auth.userId, auth.deviceId));
    return json({ recovery: existing });
  }
  const now = Date.now(); const recoveryId = randomId(18);
  await batch(env.DB, [
    db.insertInto("room_peer_recoveries").values({
      recovery_id: recoveryId, room_id: roomId, user_id: auth.userId, target_device_id: auth.deviceId, source_device_id: null,
      after_seq: afterSeq, through_seq: throughSeq, status: "pending", lease_token_hash: null, lease_expires_at: null,
      object_key: null, ciphertext_bytes: null, created_at: now, expires_at: now + ROOM_PEER_RECOVERY_TTL_MS,
      updated_at: now, completed_at: null,
    }),
    db.insertInto("sync_log").values({ recipient_user_id: auth.userId, kind: "device.event", room_id: roomId, seq: null,
      event_id: `peer-recovery:${recoveryId}`, payload: JSON.stringify({ type: "room.peer_recovery.requested", recovery_id: recoveryId, room_id: roomId }), created_at: now }),
  ]);
  ctx.waitUntil(notifyAccountDevices(env, auth.userId, auth.deviceId));
  return json({ recovery: { recovery_id: recoveryId, room_id: roomId, target_device_id: auth.deviceId, after_seq: afterSeq,
    through_seq: throughSeq, status: "pending", expires_at: now + ROOM_PEER_RECOVERY_TTL_MS } }, 201);
}

async function listRoomPeerRecoveries(env: Env, auth: AuthContext): Promise<Response> {
  requireUser(auth);
  const now = Date.now(); const db = createDatabase(env.DB);
  const rows = await db.selectFrom("room_peer_recoveries as recovery")
    .innerJoin("room_devices as source", (join) => join.onRef("source.room_id", "=", "recovery.room_id").on("source.device_id", "=", auth.deviceId))
    .innerJoin("devices as target", "target.device_id", "recovery.target_device_id")
    .select(["recovery.recovery_id", "recovery.room_id", "recovery.target_device_id", "recovery.source_device_id", "recovery.after_seq",
      "recovery.through_seq", "recovery.status", "recovery.expires_at", "target.encryption_key"])
    .where("recovery.user_id", "=", auth.userId).where("recovery.target_device_id", "!=", auth.deviceId)
    .where("source.removed_at", "is", null).where("recovery.expires_at", ">", now)
    .where((eb) => eb.or([eb("recovery.status", "=", "pending"), eb.and([eb("recovery.status", "=", "transferring"), eb("recovery.source_device_id", "=", auth.deviceId)])]))
    .orderBy("recovery.created_at").limit(20).execute();
  return json({ recoveries: rows.map((row) => ({ ...row, encryption_key: JSON.parse(row.encryption_key) })) });
}

async function roomPeerRecoveryStatus(env: Env, auth: AuthContext, recoveryId: string): Promise<Response> {
  requireUser(auth);
  const row = await createDatabase(env.DB).selectFrom("room_peer_recoveries as recovery")
    .leftJoin("devices as source", "source.device_id", "recovery.source_device_id")
    .select(["recovery.recovery_id", "recovery.room_id", "recovery.target_device_id", "recovery.source_device_id", "recovery.after_seq",
      "recovery.through_seq", "recovery.status", "recovery.ciphertext_bytes", "recovery.expires_at", "source.encryption_key as source_encryption_key"])
    .where("recovery.recovery_id", "=", recoveryId).where("recovery.user_id", "=", auth.userId)
    .where("recovery.target_device_id", "=", auth.deviceId).executeTakeFirst();
  if (!row) throw new HttpError(404, "Peer recovery not found", "not_found");
  return json({ recovery: { ...row, source_encryption_key: row.source_encryption_key ? JSON.parse(row.source_encryption_key) : null } });
}

async function claimRoomPeerRecovery(env: Env, auth: AuthContext, recoveryId: string): Promise<Response> {
  requireUser(auth);
  const db = createDatabase(env.DB); const now = Date.now();
  const row = await db.selectFrom("room_peer_recoveries as recovery")
    .innerJoin("room_devices as source", (join) => join.onRef("source.room_id", "=", "recovery.room_id").on("source.device_id", "=", auth.deviceId))
    .innerJoin("devices as target", "target.device_id", "recovery.target_device_id")
    .select(["recovery.room_id", "recovery.user_id", "recovery.target_device_id", "recovery.after_seq", "recovery.through_seq",
      "recovery.expires_at", "source.removed_at", "target.encryption_key"])
    .where("recovery.recovery_id", "=", recoveryId).executeTakeFirst();
  if (!row || row.user_id !== auth.userId || row.target_device_id === auth.deviceId || row.removed_at !== null || row.expires_at <= now) {
    throw new HttpError(404, "Peer recovery not found", "not_found");
  }
  const token = randomId(32); const tokenHash = await sha256(token); const leaseExpiresAt = now + ROOM_PEER_RECOVERY_LEASE_MS;
  const claimed = await db.updateTable("room_peer_recoveries").set({ status: "transferring", source_device_id: auth.deviceId,
    lease_token_hash: tokenHash, lease_expires_at: leaseExpiresAt, updated_at: now })
    .where("recovery_id", "=", recoveryId).where((eb) => eb.or([
      eb("status", "=", "pending"),
      eb.and([eb("status", "=", "transferring"), eb.or([eb("source_device_id", "=", auth.deviceId), eb("lease_expires_at", "<=", now)])]),
    ])).returning("recovery_id").executeTakeFirst();
  if (!claimed) throw new HttpError(409, "Another device is preparing this recovery", "peer_recovery_busy");
  return json({ recovery_id: recoveryId, room_id: row.room_id, target_device_id: row.target_device_id,
    after_seq: row.after_seq, through_seq: row.through_seq, encryption_key: JSON.parse(row.encryption_key), token, lease_expires_at: leaseExpiresAt });
}

async function uploadRoomPeerRecovery(request: Request, env: Env, auth: AuthContext, recoveryId: string, ctx: ExecutionContext): Promise<Response> {
  requireUser(auth);
  const declaredSize = Number(request.headers.get("content-length")); const token = peerRecoveryToken(request); const tokenHash = await sha256(token);
  const suppliedDigest = requestContentSha256(request, "invalid_peer_recovery_digest");
  if (!request.body || !Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > ROOM_PEER_RECOVERY_MAX_BYTES) {
    throw new HttpError(413, "Peer recovery bundle is too large", "peer_recovery_too_large");
  }
  if (!suppliedDigest) throw new HttpError(400, "Ciphertext SHA-256 required for peer recovery bundles", "peer_recovery_digest_required");
  const db = createDatabase(env.DB); const now = Date.now();
  const objectKey = `room-recovery/${recoveryId}/${tokenHash.slice(0, 24)}.bin`;
  const recovery = await db.selectFrom("room_peer_recoveries").selectAll().where("recovery_id", "=", recoveryId)
    .where("user_id", "=", auth.userId).where("source_device_id", "=", auth.deviceId).executeTakeFirst();
  const matchesCommitted = (row: { status: string; object_key: string | null; ciphertext_bytes: number | null; ciphertext_sha256: string | null }): boolean => (
    row.status === "ready" && row.object_key === objectKey && row.ciphertext_bytes === declaredSize && row.ciphertext_sha256 === suppliedDigest.text
  );
  if (recovery && matchesCommitted(recovery)) {
    await request.body.cancel("peer recovery bundle already committed").catch(() => undefined);
    await db.deleteFrom("pending_r2_writes").where("object_key", "=", objectKey)
      .where("content_sha256", "=", suppliedDigest.text).where("cancelled_at", "is", null).execute();
    return json({ recovery_id: recoveryId, ready: true, ciphertext_bytes: declaredSize });
  }
  if (!recovery || recovery.status !== "transferring" || recovery.lease_token_hash !== tokenHash || !recovery.lease_expires_at || recovery.lease_expires_at <= now) {
    await request.body.cancel("peer recovery lease is missing or stale").catch(() => undefined);
    throw new HttpError(409, "Peer recovery lease is missing or stale", "invalid_recovery_lease");
  }
  const pending = { object_key: objectKey, owner_user_id: auth.userId, kind: "archive" as const, expected_bytes: declaredSize,
    room_id: recovery.room_id, content_sha256: suppliedDigest.text };
  let reservationCreated: boolean;
  try { reservationCreated = await stageIdempotentR2Write(env, pending); }
  catch (error) {
    await request.body.cancel(error).catch(() => undefined);
    if (error instanceof HttpError && error.code === "segment_conflict") {
      throw new HttpError(409, "Peer recovery bundle is already in use", "peer_recovery_conflict");
    }
    if (error instanceof HttpError && error.code === "archive_upload_cancelled") {
      throw new HttpError(409, "Peer recovery upload was cancelled", "peer_recovery_upload_cancelled");
    }
    throw error;
  }
  let releaseReservation = false;
  const metadata = { recovery_id: recoveryId, room_id: recovery.room_id, source_device_id: auth.deviceId,
    target_device_id: recovery.target_device_id, after_seq: String(recovery.after_seq), through_seq: String(recovery.through_seq), sha256: suppliedDigest.text };
  const matchesStored = (object: ObjectStoreObject): boolean => object.size === declaredSize
    && object.metadata.recovery_id === metadata.recovery_id && object.metadata.room_id === metadata.room_id
    && object.metadata.source_device_id === metadata.source_device_id && object.metadata.target_device_id === metadata.target_device_id
    && object.metadata.after_seq === metadata.after_seq && object.metadata.through_seq === metadata.through_seq
    && object.metadata.sha256 === suppliedDigest.text;
  try {
    let object: ObjectStoreObject | null = null;
    if (!reservationCreated) {
      try { object = await objectStore(env).head(objectKey); }
      catch (error) { await request.body.cancel(error).catch(() => undefined); throw error; }
      if (object && !matchesStored(object)) {
        await request.body.cancel("peer recovery bundle conflict").catch(() => undefined);
        throw new HttpError(409, "Peer recovery bundle is already in use", "peer_recovery_conflict");
      }
      if (object) await request.body.cancel("peer recovery bundle already uploaded").catch(() => undefined);
    }
    if (!object) {
      const limited = exactLengthUploadStream(request.body, declaredSize);
      try {
        object = (await Promise.all([
          objectStore(env).put(objectKey, limited.body, { ifAbsent: true, expectedSize: declaredSize,
            checksumSha256: suppliedDigest.bytes, contentType: "application/vnd.edgechat.room-recovery", metadata }),
          limited.completed,
        ]))[0];
      } catch (error) {
        if (error instanceof ObjectStoreChecksumMismatchError) { releaseReservation = true; throw new HttpError(400, "Peer recovery bundle digest mismatch", "invalid_peer_recovery_digest"); }
        if (isFixedLengthMismatch(error)) { releaseReservation = true; throw new HttpError(400, "Peer recovery bundle length mismatch", "invalid_peer_recovery_length"); }
        throw error;
      }
      if (!object || !matchesStored(object)) {
        if (object) { releaseReservation = true; throw new HttpError(400, "Peer recovery bundle length or digest mismatch", "invalid_peer_recovery_digest"); }
        const recovered = await objectStore(env).head(objectKey);
        if (!recovered || !matchesStored(recovered)) {
          releaseReservation = true;
          throw new HttpError(409, "Peer recovery bundle is already in use", "peer_recovery_conflict");
        }
        object = recovered;
      }
    }
    const liveClaim = await db.selectFrom("pending_r2_writes").select(["object_key", "owner_user_id", "kind", "expected_bytes", "room_id", "content_sha256", "cancelled_at"])
      .where("object_key", "=", objectKey).executeTakeFirst();
    if (!liveClaim) {
      const landed = await db.selectFrom("room_peer_recoveries").select(["status", "object_key", "ciphertext_bytes", "ciphertext_sha256"])
        .where("recovery_id", "=", recoveryId).executeTakeFirst();
      if (landed && matchesCommitted(landed)) return json({ recovery_id: recoveryId, ready: true, ciphertext_bytes: declaredSize });
      await objectStore(env).delete(objectKey);
      throw new HttpError(409, "Peer recovery upload was cancelled", "peer_recovery_upload_cancelled");
    }
    if (liveClaim.cancelled_at !== null) {
      await objectStore(env).delete(objectKey);
      await finalizePendingR2Cleanup(env, [liveClaim as PendingR2Write]);
      throw new HttpError(409, "Peer recovery upload was cancelled", "peer_recovery_upload_cancelled");
    }
    const committedAt = Date.now();
    await batch(env.DB, [
      db.updateTable("room_peer_recoveries").set({ status: "ready", object_key: objectKey, ciphertext_bytes: object.size,
        ciphertext_sha256: suppliedDigest.text, lease_token_hash: null, lease_expires_at: null, updated_at: committedAt })
        .where("recovery_id", "=", recoveryId).where("status", "=", "transferring").where("source_device_id", "=", auth.deviceId)
        .where("lease_token_hash", "=", tokenHash).where("lease_expires_at", ">", committedAt),
      db.deleteFrom("pending_r2_writes").where("object_key", "=", objectKey)
        .where("content_sha256", "=", suppliedDigest.text).where("cancelled_at", "is", null)
        .where(sql<boolean>`EXISTS (SELECT 1 FROM room_peer_recoveries WHERE recovery_id = ${recoveryId} AND status = 'ready'
          AND object_key = ${objectKey} AND ciphertext_bytes = ${declaredSize} AND ciphertext_sha256 = ${suppliedDigest.text})`),
    ]);
    const committed = await db.selectFrom("room_peer_recoveries").select(["status", "object_key", "ciphertext_bytes", "ciphertext_sha256"])
      .where("recovery_id", "=", recoveryId).executeTakeFirst();
    if (!committed || !matchesCommitted(committed)) {
      await objectStore(env).delete(objectKey);
      await finalizePendingR2Cleanup(env, [liveClaim as PendingR2Write]);
      throw new HttpError(409, "Peer recovery lease changed during upload", "invalid_recovery_lease");
    }
    await db.insertInto("sync_log").values({ recipient_user_id: auth.userId, kind: "device.event", room_id: recovery.room_id, seq: null,
      event_id: `peer-recovery-ready:${recoveryId}`, payload: JSON.stringify({ type: "room.peer_recovery.ready", recovery_id: recoveryId,
        room_id: recovery.room_id, target_device_id: recovery.target_device_id }), created_at: Date.now() })
      .onConflict((conflict) => conflict.columns(["recipient_user_id", "kind", "event_id"]).doNothing()).execute();
    ctx.waitUntil(notifyAccountDevices(env, auth.userId, auth.deviceId, recovery.target_device_id));
    return json({ recovery_id: recoveryId, ready: true, ciphertext_bytes: object.size }, 201);
  } catch (error) {
    if (reservationCreated && releaseReservation) await finalizePendingR2Cleanup(env, [pending]);
    throw error;
  }
}

async function downloadRoomPeerRecovery(env: Env, auth: AuthContext, recoveryId: string): Promise<Response> {
  requireUser(auth);
  const row = await createDatabase(env.DB).selectFrom("room_peer_recoveries").selectAll().where("recovery_id", "=", recoveryId)
    .where("user_id", "=", auth.userId).where("target_device_id", "=", auth.deviceId).where("status", "=", "ready").executeTakeFirst();
  if (!row?.object_key || !row.ciphertext_bytes || !row.ciphertext_sha256) throw new HttpError(404, "Peer recovery bundle not found", "not_found");
  const object = await objectStore(env).get(row.object_key);
  if (!object || object.size !== row.ciphertext_bytes || object.metadata.sha256 !== row.ciphertext_sha256) {
    await object?.body.cancel().catch(() => undefined);
    throw new HttpError(503, "Peer recovery bundle is temporarily unavailable", "peer_recovery_unavailable");
  }
  return new Response(object.body, { headers: { "content-type": "application/vnd.edgechat.room-recovery", "content-length": String(object.size), "cache-control": "no-store" } });
}

async function acknowledgeRoomPeerRecovery(env: Env, auth: AuthContext, recoveryId: string): Promise<Response> {
  requireUser(auth);
  const db = createDatabase(env.DB);
  const row = await db.selectFrom("room_peer_recoveries").selectAll().where("recovery_id", "=", recoveryId)
    .where("user_id", "=", auth.userId).where("target_device_id", "=", auth.deviceId).executeTakeFirst();
  if (!row || row.status === "complete") return new Response(null, { status: 204 });
  if (row.status !== "ready" || !row.object_key || !row.ciphertext_bytes) throw new HttpError(409, "Peer recovery is not ready", "peer_recovery_not_ready");
  try { await objectStore(env).delete(row.object_key); }
  catch { throw new HttpError(503, "Peer recovery cleanup failed", "peer_recovery_cleanup_failed"); }
  const now = Date.now();
  await batch(env.DB, [
    db.updateTable("user_storage_usage").set({ archive_bytes: sql<number>`max(0, archive_bytes - ${row.ciphertext_bytes})`,
      archive_objects: sql<number>`max(0, archive_objects - 1)`, updated_at: now }).where("user_id", "=", auth.userId)
      .where(sql<boolean>`EXISTS (SELECT 1 FROM room_peer_recoveries WHERE recovery_id = ${recoveryId} AND status = 'ready')`),
    db.updateTable("room_peer_recoveries").set({ status: "complete", object_key: null, ciphertext_bytes: null, completed_at: now, updated_at: now })
      .where("recovery_id", "=", recoveryId).where("status", "=", "ready"),
  ]);
  return new Response(null, { status: 204 });
}

async function cancelRoomPeerRecovery(env: Env, auth: AuthContext, recoveryId: string): Promise<Response> {
  requireUser(auth);
  const db = createDatabase(env.DB);
  const row = await db.selectFrom("room_peer_recoveries").selectAll().where("recovery_id", "=", recoveryId)
    .where("user_id", "=", auth.userId).where("target_device_id", "=", auth.deviceId).executeTakeFirst();
  if (!row) throw new HttpError(404, "Peer recovery not found", "not_found");
  if (row.status === "complete" || row.status === "cancelled") return new Response(null, { status: 204 });
  if (row.status === "ready" && row.object_key && row.ciphertext_bytes) {
    try { await objectStore(env).delete(row.object_key); }
    catch { throw new HttpError(503, "Peer recovery cleanup failed", "peer_recovery_cleanup_failed"); }
    await batch(env.DB, [
      db.updateTable("user_storage_usage").set({ archive_bytes: sql<number>`max(0, archive_bytes - ${row.ciphertext_bytes})`,
        archive_objects: sql<number>`max(0, archive_objects - 1)`, updated_at: Date.now() }).where("user_id", "=", auth.userId)
        .where(sql<boolean>`EXISTS (SELECT 1 FROM room_peer_recoveries WHERE recovery_id = ${recoveryId} AND status = 'ready')`),
      db.updateTable("room_peer_recoveries").set({ status: "cancelled", object_key: null, ciphertext_bytes: null, lease_token_hash: null,
        lease_expires_at: null, updated_at: Date.now() }).where("recovery_id", "=", recoveryId).where("status", "=", "ready"),
    ]);
  } else {
    await db.updateTable("room_peer_recoveries").set({ status: "cancelled", lease_token_hash: null, lease_expires_at: null, updated_at: Date.now() })
      .where("recovery_id", "=", recoveryId).where("status", "in", ["pending", "transferring"]).execute();
  }
  return new Response(null, { status: 204 });
}

export async function cleanupExpiredRoomPeerRecoveries(env: Env, now = Date.now()): Promise<number> {
  const db = createDatabase(env.DB);
  const rows = await db.selectFrom("room_peer_recoveries").select(["recovery_id", "user_id", "status", "object_key", "ciphertext_bytes"])
    .where("status", "in", ["pending", "transferring", "ready"]).where("expires_at", "<=", now).orderBy("expires_at").limit(50).execute();
  let cleaned = 0;
  for (const row of rows) {
    if (row.status === "ready" && row.object_key && row.ciphertext_bytes) {
      try { await objectStore(env).delete(row.object_key); } catch { continue; }
      await batch(env.DB, [
        db.updateTable("user_storage_usage").set({ archive_bytes: sql<number>`max(0, archive_bytes - ${row.ciphertext_bytes})`,
          archive_objects: sql<number>`max(0, archive_objects - 1)`, updated_at: now }).where("user_id", "=", row.user_id)
          .where(sql<boolean>`EXISTS (SELECT 1 FROM room_peer_recoveries WHERE recovery_id = ${row.recovery_id} AND status = 'ready')`),
        db.updateTable("room_peer_recoveries").set({ status: "cancelled", object_key: null, ciphertext_bytes: null, lease_token_hash: null,
          lease_expires_at: null, updated_at: now }).where("recovery_id", "=", row.recovery_id).where("status", "=", "ready"),
      ]);
    } else {
      await db.updateTable("room_peer_recoveries").set({ status: "cancelled", lease_token_hash: null, lease_expires_at: null, updated_at: now })
        .where("recovery_id", "=", row.recovery_id).where("status", "in", ["pending", "transferring"]).execute();
    }
    cleaned += 1;
  }
  return cleaned;
}

async function sync(url: URL, env: Env, auth: AuthContext): Promise<Response> {
  const cursor = Math.max(0, Number(url.searchParams.get("cursor") ?? 0) || 0);
  let query = createDatabase(env.DB).selectFrom("sync_log").select(["cursor", "kind", "room_id", "seq", "payload"])
    .where("recipient_user_id", "=", auth.userId).where("cursor", ">", cursor);
  if (auth.actor === "bot") query = query.where("room_id", "=", auth.botRoomId ?? "");
  const rows = await query.orderBy("cursor").limit(201).execute();
  const page = rows.slice(0, 200);
  return json({ next_cursor: page.at(-1)?.cursor ?? cursor, has_more: rows.length > 200, items: page.map((item) => ({ ...item, payload: JSON.parse(item.payload) })) });
}

async function history(url: URL, env: Env, auth: AuthContext, roomId: RoomId): Promise<Response> {
  if (!(await memberRole(env, roomId, auth.userId))) throw new HttpError(404, "Room not found", "not_found");
  const before = url.searchParams.has("before_seq") ? Number(url.searchParams.get("before_seq")) : null;
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  const events = await env.ROOMS.getByName(roomId).getEvents(Number.isFinite(before) ? before : null, limit);
  const db = createDatabase(env.DB);
  const policy = await db.selectFrom("rooms").select("retention_floor_seq").where("room_id", "=", roomId).executeTakeFirstOrThrow();
  let segmentQuery = db.selectFrom("archive_segments").select(["segment_id", "start_seq", "end_seq", "byte_size"])
    .where("room_id", "=", roomId).where("start_seq", ">", policy.retention_floor_seq);
  if (Number.isFinite(before)) segmentQuery = segmentQuery.where("start_seq", "<", before!);
  const segments = await segmentQuery.orderBy("start_seq", "desc").limit(4).execute();
  return json({ events, segments });
}

async function archivePlan(url: URL, env: Env, auth: AuthContext, roomId: RoomId): Promise<Response> {
  if (!(await memberRole(env, roomId, auth.userId))) throw new HttpError(404, "Room not found", "not_found");
  const afterSeq = Number(url.searchParams.get("after_seq")); const throughSeq = Number(url.searchParams.get("through_seq"));
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(throughSeq) || throughSeq <= afterSeq) throw new HttpError(400, "Invalid archive catch-up range", "invalid_archive_range");
  const db = createDatabase(env.DB);
  const room = await db.selectFrom("rooms as r").innerJoin("room_devices as rd", (join) => join.onRef("rd.room_id", "=", "r.room_id").on("rd.device_id", "=", auth.deviceId))
    .select(["r.current_seq", "r.retention_floor_seq", "rd.joined_seq"]).where("r.room_id", "=", roomId).where("rd.removed_at", "is", null).executeTakeFirst();
  if (!room) throw new HttpError(404, "Room not found", "not_found");
  if (!room || throughSeq > room.current_seq) throw new HttpError(409, "Archive catch-up range exceeds room history", "invalid_archive_range");
  if (afterSeq < room.joined_seq) throw new HttpError(409, "Local room sequence predates this device's MLS state", "device_sequence_baseline_mismatch");
  if (afterSeq < room.retention_floor_seq) throw new HttpError(410, "Required room history was intentionally removed from cloud storage; recover from another device", "device_history_transfer_required");
  const rows = await db.selectFrom("archive_segments").select(["segment_id", "start_seq", "end_seq", "byte_size"])
    .where("room_id", "=", roomId).where("start_seq", ">", room.retention_floor_seq)
    .where("end_seq", ">", afterSeq).where("start_seq", "<=", throughSeq)
    .orderBy("start_seq").limit(33).execute();
  return json({ segments: rows.slice(0, 32), has_more: rows.length > 32 });
}

export function missingSequenceNumbers(startSeq: number, endSeq: number, present: Iterable<number>): number[] {
  const found = new Set(present);
  const missing: number[] = [];
  for (let seq = startSeq; seq <= endSeq; seq += 1) if (!found.has(seq)) missing.push(seq);
  return missing;
}

async function d1MissingSequences(env: Env, roomId: RoomId, startSeq: number, endSeq: number): Promise<number[]> {
  const rows = await createDatabase(env.DB).selectFrom("room_events").select("seq")
    .where("room_id", "=", roomId).where("seq", ">=", startSeq).where("seq", "<=", endSeq).orderBy("seq").execute();
  return missingSequenceNumbers(startSeq, endSeq, rows.map((row) => row.seq));
}

export async function auditRoomHistory(env: Env, now = Date.now()): Promise<{ rooms: number; ranges: number; gaps: number }> {
  if (!repairReceiptsEnabled(env)) return { rooms: 0, ranges: 0, gaps: 0 };
  const db = createDatabase(env.DB);
  const rooms = await db.selectFrom("rooms as r")
    .select(["r.room_id", "r.current_seq", "r.retention_floor_seq", "r.retention_generation", "r.repair_audit_seq", "r.repair_audit_at"])
    .whereRef("r.current_seq", ">", "r.retention_floor_seq")
    .where((eb) => eb.not(eb.exists(eb.selectFrom("history_repair_jobs as job").select("job.room_id").whereRef("job.room_id", "=", "r.room_id"))))
    .orderBy(sql<number>`coalesce(r.repair_audit_at, 0)`).orderBy("r.room_id").limit(20).execute();
  let audited = 0; let ranges = 0; let gaps = 0;
  for (const policy of rooms) {
    const roomId = policy.room_id as RoomId;
    try {
      const room = env.ROOMS.getByName(roomId); const state = await room.retentionState();
      if (state.floor_seq !== policy.retention_floor_seq || state.generation !== policy.retention_generation || state.current_seq < policy.current_seq) {
        console.error(JSON.stringify({ message: "history audit state mismatch", room_id: roomId }));
        continue;
      }
      const startSeq = policy.repair_audit_at === null
        ? Math.max(state.floor_seq + 1, state.current_seq - REPAIR_MAX_RANGE + 1)
        : policy.repair_audit_seq < state.floor_seq || policy.repair_audit_seq >= state.current_seq
          ? state.floor_seq + 1 : policy.repair_audit_seq + 1;
      const endSeq = Math.min(state.current_seq, startSeq + REPAIR_MAX_RANGE - 1);
      if (endSeq < startSeq) continue;
      const [durable, d1Missing] = await Promise.all([room.repairRangeState(startSeq, endSeq), d1MissingSequences(env, roomId, startSeq, endSeq)]);
      const missing = [...new Set([...durable.missing_sequences, ...d1Missing])].sort((left, right) => left - right);
      await batch(env.DB, [
        db.updateTable("rooms").set({ current_seq: state.current_seq, repair_audit_seq: endSeq, repair_audit_at: now }).where("room_id", "=", roomId),
        ...(missing.length ? [db.insertInto("history_repair_jobs").values({
          room_id: roomId, start_seq: missing[0], end_seq: missing.at(-1)!, missing_count: missing.length, detected_at: now, updated_at: now,
        }).onConflict((conflict) => conflict.column("room_id").doUpdateSet({
          start_seq: missing[0], end_seq: missing.at(-1)!, missing_count: missing.length, updated_at: now,
        }))] : []),
      ]);
      if (missing.length) await room.notifyRepairAvailable(missing[0], missing.at(-1)!);
      audited += 1; ranges += 1; gaps += missing.length;
    } catch (error) {
      console.error(JSON.stringify({ message: "history audit failed", room_id: roomId, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return { rooms: audited, ranges, gaps };
}

function requireRepairReceipts(env: Env): void {
  if (!repairReceiptsEnabled(env)) throw new HttpError(503, "History repair receipts are not configured", "history_repair_disabled");
}

async function acquireRepairLease(request: Request, env: Env, auth: AuthContext, roomId: RoomId): Promise<Response> {
  requireUser(auth);
  requireRepairReceipts(env);
  if (!(await memberRole(env, roomId, auth.userId))) throw new HttpError(404, "Room not found", "not_found");
  const body = await readJson(request, 2_048);
  const startSeq = Number(body.start_seq); const endSeq = Number(body.end_seq);
  if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq) || startSeq < 1 || endSeq < startSeq || endSeq - startSeq + 1 > REPAIR_MAX_RANGE) {
    throw new HttpError(400, `Repair range must contain 1-${REPAIR_MAX_RANGE} sequences`, "invalid_repair_range");
  }
  const room = env.ROOMS.getByName(roomId);
  let state: Awaited<ReturnType<typeof room.repairRangeState>>;
  try { state = await room.repairRangeState(startSeq, endSeq); }
  catch { throw new HttpError(409, "Repair range is outside retained room history", "repair_range_unavailable"); }
  const d1Missing = await d1MissingSequences(env, roomId, startSeq, endSeq);
  const missing = [...new Set([...state.missing_sequences, ...d1Missing])].sort((a, b) => a - b);
  if (!missing.length) {
    await createDatabase(env.DB).deleteFrom("history_repair_jobs").where("room_id", "=", roomId).execute();
    return json({ complete: true, floor_seq: state.floor_seq, generation: state.generation, missing_sequences: [] });
  }
  const token = randomId(32); const tokenHash = await sha256(token); const expiresAt = Date.now() + REPAIR_LEASE_MS;
  const result = await room.acquireRepairLease({
    token_hash: tokenHash, device_id: auth.deviceId, start_seq: startSeq, end_seq: endSeq,
    generation: state.generation, expires_at: expiresAt,
  }, Date.now());
  if (!result.acquired) throw new HttpError(409, "Another device is repairing this room", "repair_busy", { "retry-after": String(Math.max(1, Math.ceil((result.retry_at - Date.now()) / 1_000))) });
  return json({ token, room_id: roomId, start_seq: startSeq, end_seq: endSeq, floor_seq: state.floor_seq,
    generation: state.generation, expires_at: expiresAt, missing_sequences: missing, max_events_per_upload: REPAIR_MAX_UPLOAD_EVENTS }, 201);
}

async function releaseRepairLease(request: Request, env: Env, auth: AuthContext, roomId: RoomId): Promise<Response> {
  requireUser(auth);
  const token = request.headers.get("x-repair-token");
  const outcome = request.headers.get("x-repair-outcome");
  if (!token || token.length > 128) throw new HttpError(400, "Repair token required", "invalid_repair_lease");
  if (outcome !== null && outcome !== "local_incomplete" && outcome !== "local_unverified") {
    throw new HttpError(400, "Invalid repair outcome", "invalid_repair_outcome");
  }
  await env.ROOMS.getByName(roomId).releaseRepairLease(await sha256(token), auth.deviceId);
  if (outcome) await env.DB.prepare(`
    INSERT INTO history_repair_attempts (room_id, device_id, outcome, attempted_at)
    SELECT room_id, ?, ?, ? FROM history_repair_jobs WHERE room_id = ?
    ON CONFLICT(room_id, device_id) DO UPDATE SET outcome = excluded.outcome, attempted_at = excluded.attempted_at
  `).bind(auth.deviceId, outcome, Date.now(), roomId).run();
  return new Response(null, { status: 204 });
}

async function historyRepairJobs(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  requireUser(auth);
  const cursor = new URL(request.url).searchParams.get("cursor");
  if (cursor !== null && !isNamespacedRoomId(cursor)) throw new HttpError(400, "Invalid repair cursor", "invalid_cursor");
  const db = createDatabase(env.DB);
  let query = db.selectFrom("history_repair_jobs as job")
    .innerJoin("rooms as r", "r.room_id", "job.room_id")
    .innerJoin("room_members as rm", "rm.room_id", "job.room_id")
    .innerJoin("room_devices as rd", (join) => join.onRef("rd.room_id", "=", "job.room_id").on("rd.device_id", "=", auth.deviceId))
    .select(["job.room_id", "job.start_seq", "job.end_seq", "job.missing_count", "job.detected_at"])
    .where("rm.user_id", "=", auth.userId).where("rm.removed_at", "is", null).where("rd.removed_at", "is", null)
    .where((eb) => eb.not(eb.exists(eb.selectFrom("history_repair_attempts as attempt").select("attempt.room_id")
      .whereRef("attempt.room_id", "=", "job.room_id").where("attempt.device_id", "=", auth.deviceId)
      .where("attempt.attempted_at", ">", Date.now() - 24 * 60 * 60 * 1_000))))
    .whereRef("job.start_seq", ">", "r.retention_floor_seq").orderBy("job.room_id").limit(101);
  if (cursor) query = query.where("job.room_id", ">", cursor);
  const rows = await query.execute(); const hasMore = rows.length > 100; const page = hasMore ? rows.slice(0, 100) : rows;
  return json({ jobs: page, next_cursor: hasMore ? page.at(-1)?.room_id ?? null : null });
}

function parseRepairEvents(value: unknown, roomId: RoomId, env: Env): RoomEvent[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > REPAIR_MAX_UPLOAD_EVENTS) {
    throw new HttpError(400, `Repair upload must contain 1-${REPAIR_MAX_UPLOAD_EVENTS} events`, "invalid_repair_events");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new HttpError(400, "Invalid repaired event", "invalid_repair_event");
    const event = item as Partial<RoomEvent>;
    const receipt = event.acceptance_receipt as Partial<EventAcceptanceReceipt> | undefined;
    if (!isRoomEventEnvelope(event) || event.room_id !== roomId
      || typeof event.sender !== "string" || typeof event.device_id !== "string" || !roomEventTypes.includes(event.type as never)
      || !Number.isSafeInteger(event.seq) || Number(event.seq) < 1 || !Number.isSafeInteger(event.created_at) || Number(event.created_at) < 0
      || typeof event.ciphertext !== "string" || event.ciphertext.length > MAX_EVENT_CIPHERTEXT_LENGTH || !event.metadata || typeof event.metadata !== "object" || Array.isArray(event.metadata)
      || typeof event.signature !== "string" || event.signature.length > 1_024 || !receipt || typeof receipt.mac !== "string") {
      throw new HttpError(400, "Invalid repaired event", "invalid_repair_event");
    }
    assertLocalId(event.event_id, "$", env);
    return event as RoomEvent;
  });
}

async function verifyRepairEvents(env: Env, roomId: RoomId, events: RoomEvent[]): Promise<void> {
  const deviceIds = [...new Set(events.map((event) => event.device_id))];
  const devices = await createDatabase(env.DB).selectFrom("devices").select(["device_id", "user_id", "signing_key"])
    .where("device_id", "in", deviceIds).execute();
  const byId = new Map(devices.map((device) => [device.device_id, device]));
  const keys = new Map<string, CryptoKey>();
  for (const event of events) {
    const receipt = event.acceptance_receipt!;
    const device = byId.get(event.device_id);
    if (!device || device.user_id !== event.sender || event.room_id !== roomId
      || receipt.seq !== event.seq || !(await verifyAcceptanceReceipt(env, event, receipt))) {
      throw new HttpError(400, "Repaired event receipt is invalid", "invalid_repair_receipt");
    }
    let key = keys.get(event.device_id);
    if (!key) {
      try { key = await crypto.subtle.importKey("jwk", JSON.parse(device.signing_key) as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]); }
      catch { throw new HttpError(400, "Repaired event device key is invalid", "invalid_repair_signature"); }
      keys.set(event.device_id, key);
    }
    let valid = false;
    try {
      const { signature: _, ...unsigned } = event;
      valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64url(event.signature), canonicalEventBytes(unsigned));
    } catch { /* invalid base64 or signature */ }
    if (!valid) throw new HttpError(400, "Repaired event signature is invalid", "invalid_repair_signature");
  }
}

async function uploadRepairEvents(request: Request, env: Env, auth: AuthContext, roomId: RoomId): Promise<Response> {
  requireUser(auth);
  requireRepairReceipts(env);
  if (!(await memberRole(env, roomId, auth.userId))) throw new HttpError(404, "Room not found", "not_found");
  const body = await readJson(request, 4_500_000);
  const token = stringField(body, "token", 128); const generation = Number(body.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new HttpError(400, "Invalid repair generation", "invalid_repair_generation");
  const events = parseRepairEvents(body.events, roomId, env);
  await verifyRepairEvents(env, roomId, events);
  const db = createDatabase(env.DB);
  const seqs = events.map((event) => event.seq); const ids = events.map((event) => event.event_id);
  const [bySeq, byEventId] = await Promise.all([
    db.selectFrom("room_events").select(["event_id", "seq"]).where("room_id", "=", roomId).where("seq", "in", seqs).execute(),
    db.selectFrom("room_events").select(["event_id", "seq"]).where("event_id", "in", ids).execute(),
  ]);
  const existing = [...bySeq, ...byEventId];
  const existingPairs = new Set(existing.map((row) => `${row.seq}\0${row.event_id}`));
  for (const event of events) {
    if (existing.some((row) => (row.seq === event.seq || row.event_id === event.event_id) && (row.seq !== event.seq || row.event_id !== event.event_id))) {
      throw new HttpError(409, "Repaired event conflicts with D1 history", "repair_event_conflict");
    }
  }
  const tokenHash = await sha256(token); const room = env.ROOMS.getByName(roomId);
  let result: Awaited<ReturnType<typeof room.repairEvents>>;
  try { result = await room.repairEvents(tokenHash, auth.deviceId, generation, events, Date.now()); }
  catch { throw new HttpError(409, "Repair lease is missing, stale, or conflicts with retained history", "invalid_repair_lease"); }
  const originalAttachmentReferences = events.flatMap((event) => eventAttachmentReferences(event)
    .filter((reference) => !reference.sourceAttachmentId).map((reference) => ({ event, attachmentId: reference.attachmentId })));
  await batch(env.DB, [
    ...events.map((event) => db.insertInto("room_events").values({
      event_id: event.event_id, room_id: event.room_id, seq: event.seq, sender: event.sender, device_id: event.device_id,
      event_type: event.type, event_json: JSON.stringify(event), created_at: event.created_at, accepted_at: event.acceptance_receipt?.accepted_at ?? null,
    }).onConflict((conflict) => conflict.column("event_id").doNothing())),
    ...originalAttachmentReferences.map(({ event, attachmentId }) => db.updateTable("attachments").set({
      committed_event_id: event.event_id, committed_seq: event.seq,
      committed_at: event.acceptance_receipt?.accepted_at ?? event.created_at,
    }).where("attachment_id", "=", attachmentId).where("room_id", "=", roomId).where((eb) => eb.or([
      eb("committed_event_id", "is", null), eb("committed_event_id", "=", event.event_id),
    ]))),
  ]);

  const d1Missing = await d1MissingSequences(env, roomId, result.start_seq, result.end_seq);
  const remaining = [...new Set([...result.missing_sequences, ...d1Missing])].sort((a, b) => a - b);
  if (!remaining.length) await Promise.all([
    room.releaseRepairLease(tokenHash, auth.deviceId),
    db.deleteFrom("history_repair_jobs").where("room_id", "=", roomId)
      .where("start_seq", ">=", result.start_seq).where("end_seq", "<=", result.end_seq).execute(),
  ]);
  return json({
    restored_do_events: result.inserted,
    restored_d1_events: events.filter((event) => !existingPairs.has(`${event.seq}\0${event.event_id}`)).length,
    complete: remaining.length === 0,
    missing_sequences: remaining,
  });
}

async function acquireCompactionLease(env: Env, auth: AuthContext, roomId: RoomId): Promise<Response> {
  requireArchiveCompaction(env);
  if ((await memberRole(env, roomId, auth.userId)) !== "owner") throw new HttpError(403, "Only the room owner may compact history", "forbidden");
  const requestState = await directRequestState(env, roomId);
  if (requestState && requestState.status !== "accepted") return new Response(null, { status: 204 });
  const db = createDatabase(env.DB);
  const [room, latestSegment] = await Promise.all([
    db.selectFrom("rooms").select(["current_seq", "retention_floor_seq"]).where("room_id", "=", roomId).executeTakeFirst(),
    db.selectFrom("archive_segments").select("end_seq").where("room_id", "=", roomId).orderBy("end_seq", "desc").executeTakeFirst(),
  ]);
  if (!room) throw new HttpError(404, "Room not found", "not_found");
  const startSeq = Math.max((latestSegment?.end_seq ?? 0) + 1, room.retention_floor_seq + 1);
  const eligibleEnd = room.current_seq - COMPACTION_RECENT_TAIL;
  if (eligibleEnd < startSeq) return new Response(null, { status: 204 });
  const candidates = await db.selectFrom("room_events").select(["seq", sql<number>`length(event_json)`.as("event_bytes")])
    .where("room_id", "=", roomId).where("seq", ">=", startSeq).where("seq", "<=", eligibleEnd).orderBy("seq").limit(COMPACTION_MAX_EVENTS).execute();
  let inputBytes = 0;
  let endSeq = startSeq - 1;
  for (const candidate of candidates) {
    if (endSeq >= startSeq && inputBytes + candidate.event_bytes > COMPACTION_TARGET_INPUT_BYTES) break;
    inputBytes += candidate.event_bytes;
    endSeq = candidate.seq;
  }
  // Avoid paying one R2 object/write plus several Range reads for tiny text-only
  // segments. Low-volume rooms remain in D1 until they reach 1 MiB or 500 events.
  if (endSeq < startSeq || (candidates.length < COMPACTION_MAX_EVENTS && inputBytes < COMPACTION_MIN_INPUT_BYTES)) return new Response(null, { status: 204 });
  const now = Date.now();
  const proposed = {
    token: randomId(24), device_id: auth.deviceId, segment_id: randomId(20),
    start_seq: startSeq, end_seq: endSeq, expires_at: now + COMPACTION_LEASE_MS,
  };
  const result = await env.ROOMS.getByName(roomId).acquireCompactionLease(proposed, now);
  if (!result.acquired) return json({ error: "Another device is compacting this room", code: "compaction_busy", retry_at: result.retry_at }, 409);
  return json({ ...result.lease, room_id: roomId }, 201);
}

async function releaseCompactionLease(request: Request, env: Env, auth: AuthContext, roomId: RoomId): Promise<Response> {
  const token = request.headers.get("x-compaction-token");
  if (!token) throw new HttpError(400, "Compaction token required", "invalid_compaction_lease");
  await env.ROOMS.getByName(roomId).releaseCompactionLease(token, auth.deviceId);
  return new Response(null, { status: 204 });
}

function attachmentRetentionRequirement(
  db: ReturnType<typeof createDatabase>, attachmentId: string, roomId: RoomId,
) {
  return db.insertInto("attachment_retention_requirements")
    .columns(["attachment_id", "room_id", "minimum_copies"])
    .expression((eb) => eb.selectFrom("rooms").select([
      eb.val(attachmentId).as("attachment_id"),
      "room_id",
      "retention_min_device_copies as minimum_copies",
    ]).where("room_id", "=", roomId)
      .where((inner) => inner.exists(inner.selectFrom("attachments").select("attachment_id")
        .where("attachment_id", "=", attachmentId))))
    .onConflict((conflict) => conflict.columns(["attachment_id", "room_id"])
      .doUpdateSet({ minimum_copies: sql<number>`excluded.minimum_copies` }));
}

async function uploadAttachment(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const roomId = request.headers.get("x-room-id");
  if (!roomId || !isNamespacedRoomId(roomId) || !(await memberRole(env, roomId, auth.userId))) throw new HttpError(403, "Room membership required", "forbidden");
  if (await roomLeavePending(env, roomId, auth.userId)) throw new HttpError(409, "Room leave is pending", "room_leave_pending");
  if (await directRoomBlocked(env, roomId)) throw new HttpError(403, "Conversation is unavailable", "direct_unavailable");
  const requestState = await directRequestState(env, roomId);
  if (requestState && requestState.status !== "accepted") throw new HttpError(409, "Attachments require an accepted message request", "message_request_attachment_blocked");
  const declaredSize = Number(request.headers.get("content-length"));
  if (!request.body || !Number.isSafeInteger(declaredSize) || declaredSize < 1) throw new HttpError(411, "Content-Length required", "length_required");
  if (declaredSize > MAX_ATTACHMENT) throw new HttpError(413, "Encrypted attachment is too large", "attachment_too_large");
  const suppliedDigest = requestContentSha256(request);
  if (!suppliedDigest) throw new HttpError(400, "Ciphertext SHA-256 required for attachment uploads", "attachment_digest_required");
  const id = request.headers.get("x-attachment-id");
  if (!id || !/^[A-Za-z0-9_-]{32}$/.test(id)) throw new HttpError(400, "A 192-bit client attachment ID is required", "invalid_attachment_id");
  const key = `attachments/${id}`;
  const db = createDatabase(env.DB);
  const matchesUpload = (row: { room_id: string; uploader_user_id: string; ciphertext_bytes: number; ciphertext_sha256: string | null; source_deleted_at: number | null }): boolean => (
    row.room_id === roomId && row.uploader_user_id === auth.userId && row.ciphertext_bytes === declaredSize
      && row.ciphertext_sha256 === suppliedDigest.text && row.source_deleted_at === null
  );
  const existing = await db.selectFrom("attachments").select(["room_id", "uploader_user_id", "ciphertext_bytes", "ciphertext_sha256", "source_deleted_at"])
    .where("attachment_id", "=", id).executeTakeFirst();
  if (existing) {
    if (!matchesUpload(existing)) throw new HttpError(409, "Attachment ID is already in use", "attachment_id_conflict");
    return json({ attachment_id: id, ciphertext_bytes: declaredSize }, 200);
  }
  const pending = { object_key: key, owner_user_id: auth.userId, kind: "attachment" as const, expected_bytes: declaredSize, room_id: roomId, content_sha256: suppliedDigest.text };
  const reservationCreated = await stageIdempotentR2Write(env, pending);
  let releaseReservation = false;
  const createdAt = Date.now();
  try {
    let stored: ObjectStoreObject | null;
    if (!reservationCreated) {
      // A matching D1 intent means an earlier response may have been lost after
      // the object landed. Reconcile with one exact HEAD before paying for a
      // second streamed PUT plus its conflict HEAD. A missing object still
      // falls through to one PUT, and a first attempt never gains a HEAD.
      const recovered = await objectStore(env).head(key);
      if (recovered && (recovered.size !== declaredSize || recovered.metadata.room_id !== roomId
        || recovered.metadata.uploader_user_id !== auth.userId || recovered.metadata.sha256 !== suppliedDigest.text)) {
        await request.body.cancel().catch(() => undefined);
        throw new HttpError(409, "Attachment ID is already in use", "attachment_id_conflict");
      }
      stored = recovered;
      if (stored) await request.body.cancel().catch(() => undefined);
    } else stored = null;
    if (!stored) {
      const limited = exactLengthUploadStream(request.body, declaredSize);
      const put = objectStore(env).put(key, limited.body, {
        ifAbsent: true, expectedSize: declaredSize, checksumSha256: suppliedDigest.bytes, contentType: "application/octet-stream",
        metadata: { room_id: roomId, uploader_user_id: auth.userId, sha256: suppliedDigest.text },
      });
      try {
        stored = (await Promise.all([put, limited.completed]))[0];
      } catch (error) {
        if (error instanceof ObjectStoreChecksumMismatchError) { releaseReservation = true; throw new HttpError(400, "Attachment digest mismatch", "invalid_attachment_digest"); }
        if (isFixedLengthMismatch(error)) { releaseReservation = true; throw new HttpError(400, "Attachment length mismatch", "invalid_attachment_length"); }
        throw error;
      }
    }
    if (!stored || stored.size !== declaredSize) {
      if (stored) throw new HttpError(400, "Attachment length or digest mismatch", "invalid_attachment_digest");
      const recovered = await objectStore(env).head(key);
      if (!recovered || recovered.size !== declaredSize || recovered.metadata.room_id !== roomId
        || recovered.metadata.uploader_user_id !== auth.userId || recovered.metadata.sha256 !== suppliedDigest.text) {
        releaseReservation = true;
        throw new HttpError(409, "Attachment ID is already in use", "attachment_id_conflict");
      }
    }
    const liveClaim = await db.selectFrom("pending_r2_writes").select(["object_key", "owner_user_id", "kind", "expected_bytes", "room_id", "content_sha256", "cancelled_at"])
      .where("object_key", "=", key).executeTakeFirst();
    if (!liveClaim) {
      const landed = await db.selectFrom("attachments").select(["room_id", "uploader_user_id", "ciphertext_bytes", "ciphertext_sha256", "source_deleted_at"])
        .where("attachment_id", "=", id).executeTakeFirst();
      if (landed && matchesUpload(landed)) return json({ attachment_id: id, ciphertext_bytes: declaredSize }, 200);
      await objectStore(env).delete(key);
      throw new HttpError(409, "Attachment upload was cancelled", "attachment_upload_cancelled");
    }
    if (liveClaim.cancelled_at !== null) {
      await objectStore(env).delete(key);
      await finalizePendingR2Cleanup(env, [liveClaim as PendingR2Write]);
      throw new HttpError(409, "Attachment upload was cancelled", "attachment_upload_cancelled");
    }
    await batch(env.DB, [
      db.insertInto("attachments")
        .columns(["attachment_id", "room_id", "uploader_user_id", "object_key", "ciphertext_bytes", "ciphertext_sha256", "created_at", "committed_event_id", "committed_at", "source_deleted_at"])
        .expression((eb) => eb.selectFrom("pending_r2_writes").select([
          eb.val(id).as("attachment_id"), eb.val(roomId).as("room_id"), eb.val(auth.userId).as("uploader_user_id"),
          eb.val(key).as("object_key"), eb.val(declaredSize).as("ciphertext_bytes"), eb.val(suppliedDigest.text).as("ciphertext_sha256"),
          eb.val(createdAt).as("created_at"), eb.val(null).as("committed_event_id"), eb.val(null).as("committed_at"), eb.val(null).as("source_deleted_at"),
        ]).where("object_key", "=", key).where("owner_user_id", "=", auth.userId).where("kind", "=", "attachment")
          .where("room_id", "=", roomId).where("content_sha256", "=", suppliedDigest.text).where("expected_bytes", "=", declaredSize)
          .where("cancelled_at", "is", null))
        .onConflict((conflict) => conflict.column("attachment_id").doNothing()),
      attachmentRetentionRequirement(db, id, roomId),
      db.deleteFrom("pending_r2_writes").where("object_key", "=", key).where("cancelled_at", "is", null),
    ]);
    const committed = await db.selectFrom("attachments").select(["room_id", "uploader_user_id", "ciphertext_bytes", "ciphertext_sha256", "source_deleted_at"])
      .where("attachment_id", "=", id).executeTakeFirst();
    if (!committed || !matchesUpload(committed)) throw new HttpError(409, "Attachment ID is already in use", "attachment_id_conflict");
  } catch (error) {
    // Provider/transport errors are ambiguous: retain the exact intent so a
    // retry or cancellation can reconcile the known key. Only checksum,
    // length, or verified-key conflicts prove this reservation can roll back.
    if (reservationCreated && releaseReservation) await finalizePendingR2Cleanup(env, [pending]);
    throw error;
  }
  return json({ attachment_id: id, ciphertext_bytes: declaredSize }, 201);
}

async function abandonAttachments(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const body = await readJson(request, 2_048);
  const ids = Array.isArray(body.attachment_ids) ? body.attachment_ids : [];
  if (!ids.length || ids.length > MAX_MESSAGE_ATTACHMENTS || ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new HttpError(400, "Invalid attachment IDs", "invalid_attachment");
  }
  const db = createDatabase(env.DB);
  const requestedIds = ids as string[];
  const requestedKeys = requestedIds.map((id) => `attachments/${id}`);
  const now = Date.now();
  await db.updateTable("pending_r2_writes").set({ cancelled_at: now })
    .where("object_key", "in", requestedKeys).where("owner_user_id", "=", auth.userId).where("kind", "=", "attachment").execute();
  const rows = await db.selectFrom("attachments").select(["attachment_id", "object_key", "ciphertext_bytes"])
    .where("attachment_id", "in", requestedIds).where("uploader_user_id", "=", auth.userId).where("committed_event_id", "is", null).execute();
  const pendingRows = await db.selectFrom("pending_r2_writes").select(["object_key", "owner_user_id", "kind", "expected_bytes", "room_id", "content_sha256", "cancelled_at"])
    .where("object_key", "in", requestedKeys).where("owner_user_id", "=", auth.userId).where("kind", "=", "attachment").where("cancelled_at", "is not", null).execute();
  const objectKeys = [...new Set([...rows.map((row) => row.object_key), ...pendingRows.map((row) => row.object_key)])];
  if (!objectKeys.length) return json({ abandoned: 0 });
  await objectStore(env).delete(objectKeys);
  if (rows.length) {
    await batch(env.DB, rows.flatMap((row) => [
      db.updateTable("user_storage_usage").set({ attachment_bytes: sql<number>`max(0, attachment_bytes - ${row.ciphertext_bytes})`, attachment_objects: sql<number>`max(0, attachment_objects - 1)`, updated_at: now })
        .where("user_id", "=", auth.userId).where(sql<boolean>`EXISTS (SELECT 1 FROM attachments WHERE attachment_id = ${row.attachment_id} AND committed_event_id IS NULL)`),
      db.deleteFrom("attachments").where("attachment_id", "=", row.attachment_id).where("uploader_user_id", "=", auth.userId).where("committed_event_id", "is", null),
    ]));
  }
  await finalizePendingR2Cleanup(env, pendingRows as PendingR2Write[]);
  const abandonedIds = new Set(rows.map((row) => row.attachment_id));
  for (const row of pendingRows) abandonedIds.add(row.object_key.slice("attachments/".length));
  return json({ abandoned: abandonedIds.size });
}

async function acknowledgeAttachmentRetention(env: Env, auth: AuthContext, id: string): Promise<Response> {
  const db = createDatabase(env.DB);
  const original = await db.selectFrom("attachments as a")
    .innerJoin("room_members as rm", "rm.room_id", "a.room_id")
    .select("a.attachment_id")
    .where("a.attachment_id", "=", id).where("rm.user_id", "=", auth.userId).where("rm.removed_at", "is", null).executeTakeFirst();
  const attachment = original ?? await db.selectFrom("attachment_grants as g")
    .innerJoin("room_members as rm", "rm.room_id", "g.room_id")
    .select("g.source_attachment_id as attachment_id")
    .where("g.grant_id", "=", id).where("rm.user_id", "=", auth.userId).where("rm.removed_at", "is", null).executeTakeFirst();
  if (!attachment) throw new HttpError(404, "Attachment not found", "not_found");
  await db.insertInto("attachment_retention_acks").values({ attachment_id: attachment.attachment_id, device_id: auth.deviceId, cached_at: Date.now() })
    .onConflict((conflict) => conflict.columns(["attachment_id", "device_id"]).doUpdateSet({ cached_at: Date.now() })).execute();
  return json({ attachment_id: attachment.attachment_id });
}

async function markAttachmentRepairNeeded(env: Env, attachmentId: string): Promise<void> {
  const now = Date.now(); const db = createDatabase(env.DB);
  const inserted = await db.insertInto("attachment_repair_jobs").values({
    attachment_id: attachmentId, detected_at: now, updated_at: now,
    lease_device_id: null, lease_token_hash: null, lease_expires_at: null, attempts: 0, last_error: null,
  }).onConflict((conflict) => conflict.column("attachment_id").doNothing()).returning("attachment_id").executeTakeFirst();
  if (!inserted) return;
  const [source, grants] = await Promise.all([
    db.selectFrom("attachments").select("room_id").where("attachment_id", "=", attachmentId).executeTakeFirst(),
    db.selectFrom("attachment_grants").select("room_id").distinct().where("source_attachment_id", "=", attachmentId).limit(19).execute(),
  ]);
  const rooms = Array.from(new Set([source?.room_id, ...grants.map((grant) => grant.room_id)].filter((room): room is RoomId => Boolean(room)))).slice(0, 20);
  await Promise.all(rooms.map((roomId) => env.ROOMS.getByName(roomId).notifyAttachmentRepairAvailable(attachmentId)));
}

function attachmentRepairAccess(db: ReturnType<typeof createDatabase>, auth: AuthContext, attachmentId: string) {
  return db.selectFrom("attachment_repair_jobs as job")
    .innerJoin("attachments as a", "a.attachment_id", "job.attachment_id")
    .innerJoin("attachment_retention_acks as ack", (join) => join.onRef("ack.attachment_id", "=", "a.attachment_id").on("ack.device_id", "=", auth.deviceId))
    .select(["a.attachment_id", "a.object_key", "a.ciphertext_bytes", "a.ciphertext_sha256", "a.room_id", "job.lease_device_id", "job.lease_token_hash", "job.lease_expires_at"])
    .where("a.attachment_id", "=", attachmentId).where("a.source_deleted_at", "is", null)
    .where((eb) => eb.or([
      eb.exists(eb.selectFrom("room_members as source_rm").select("source_rm.room_id")
        .whereRef("source_rm.room_id", "=", "a.room_id").where("source_rm.user_id", "=", auth.userId).where("source_rm.removed_at", "is", null)),
      eb.exists(eb.selectFrom("attachment_grants as grant")
        .innerJoin("room_members as grant_rm", "grant_rm.room_id", "grant.room_id").select("grant.grant_id")
        .whereRef("grant.source_attachment_id", "=", "a.attachment_id").where("grant_rm.user_id", "=", auth.userId).where("grant_rm.removed_at", "is", null)),
    ]));
}

async function attachmentRepairJobs(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const cursor = new URL(request.url).searchParams.get("cursor");
  if (cursor !== null && !/^[A-Za-z0-9_-]{16,64}$/.test(cursor)) throw new HttpError(400, "Invalid repair cursor", "invalid_cursor");
  const db = createDatabase(env.DB); const now = Date.now();
  let query = db.selectFrom("attachment_repair_jobs as job")
    .innerJoin("attachments as a", "a.attachment_id", "job.attachment_id")
    .innerJoin("attachment_retention_acks as ack", (join) => join.onRef("ack.attachment_id", "=", "a.attachment_id").on("ack.device_id", "=", auth.deviceId))
    .select(["a.attachment_id", "a.ciphertext_bytes", "a.ciphertext_sha256", "job.detected_at"])
    .where("a.ciphertext_sha256", "is not", null).where("a.source_deleted_at", "is", null)
    .where((eb) => eb.or([eb("job.lease_expires_at", "is", null), eb("job.lease_expires_at", "<=", now), eb("job.lease_device_id", "=", auth.deviceId)]))
    .where((eb) => eb.or([
      eb.exists(eb.selectFrom("room_members as source_rm").select("source_rm.room_id")
        .whereRef("source_rm.room_id", "=", "a.room_id").where("source_rm.user_id", "=", auth.userId).where("source_rm.removed_at", "is", null)),
      eb.exists(eb.selectFrom("attachment_grants as grant")
        .innerJoin("room_members as grant_rm", "grant_rm.room_id", "grant.room_id").select("grant.grant_id")
        .whereRef("grant.source_attachment_id", "=", "a.attachment_id").where("grant_rm.user_id", "=", auth.userId).where("grant_rm.removed_at", "is", null)),
    ])).orderBy("a.attachment_id").limit(101);
  if (cursor) query = query.where("a.attachment_id", ">", cursor);
  const rows = await query.execute(); const more = rows.length > 100; const page = more ? rows.slice(0, 100) : rows;
  return json({ jobs: page, next_cursor: more ? page.at(-1)?.attachment_id ?? null : null });
}

async function acquireAttachmentRepairLease(env: Env, auth: AuthContext, id: string): Promise<Response> {
  const db = createDatabase(env.DB); const accessible = await attachmentRepairAccess(db, auth, id).executeTakeFirst();
  if (!accessible) throw new HttpError(404, "Repairable attachment not found", "not_found");
  if (!accessible.ciphertext_sha256) throw new HttpError(409, "Legacy attachment has no verifiable digest", "attachment_repair_unverified");
  const now = Date.now(); const token = randomId(32); const tokenHash = await sha256(token); const expiresAt = now + ATTACHMENT_REPAIR_LEASE_MS;
  const result = await db.updateTable("attachment_repair_jobs").set({ lease_device_id: auth.deviceId, lease_token_hash: tokenHash, lease_expires_at: expiresAt, updated_at: now })
    .where("attachment_id", "=", id).where((eb) => eb.or([eb("lease_expires_at", "is", null), eb("lease_expires_at", "<=", now), eb("lease_device_id", "=", auth.deviceId)]))
    .returning("attachment_id").executeTakeFirst();
  if (!result) throw new HttpError(409, "Another device is repairing this attachment", "repair_busy", { "retry-after": "30" });
  return json({ attachment_id: id, token, ciphertext_bytes: accessible.ciphertext_bytes, ciphertext_sha256: accessible.ciphertext_sha256, expires_at: expiresAt }, 201);
}

async function releaseAttachmentRepairLease(request: Request, env: Env, auth: AuthContext, id: string): Promise<Response> {
  const token = request.headers.get("x-repair-token"); const outcome = request.headers.get("x-repair-outcome");
  if (!token || token.length > 128) throw new HttpError(400, "Repair token required", "invalid_repair_lease");
  if (outcome !== null && outcome !== "local_missing" && outcome !== "local_invalid") throw new HttpError(400, "Invalid repair outcome", "invalid_repair_outcome");
  const db = createDatabase(env.DB);
  const released = await db.updateTable("attachment_repair_jobs").set({ lease_device_id: null, lease_token_hash: null, lease_expires_at: null, updated_at: Date.now() })
    .where("attachment_id", "=", id).where("lease_device_id", "=", auth.deviceId).where("lease_token_hash", "=", await sha256(token)).returning("attachment_id").executeTakeFirst();
  if (released && outcome) await db.deleteFrom("attachment_retention_acks").where("attachment_id", "=", id).where("device_id", "=", auth.deviceId).execute();
  return new Response(null, { status: 204 });
}

async function uploadAttachmentRepair(request: Request, env: Env, auth: AuthContext, id: string): Promise<Response> {
  const token = request.headers.get("x-repair-token"); const declaredSize = Number(request.headers.get("content-length"));
  if (!token || token.length > 128) throw new HttpError(400, "Repair token required", "invalid_repair_lease");
  if (!request.body || !Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > MAX_ATTACHMENT) throw new HttpError(411, "Valid Content-Length required", "length_required");
  const db = createDatabase(env.DB); const row = await attachmentRepairAccess(db, auth, id).executeTakeFirst();
  if (!row || row.lease_device_id !== auth.deviceId || row.lease_token_hash !== await sha256(token) || !row.lease_expires_at || row.lease_expires_at <= Date.now()) {
    throw new HttpError(409, "Attachment repair lease is missing or stale", "invalid_repair_lease");
  }
  if (!row.ciphertext_sha256) throw new HttpError(409, "Legacy attachment has no verifiable digest", "attachment_repair_unverified");
  if (declaredSize !== row.ciphertext_bytes) throw new HttpError(400, "Attachment length mismatch", "invalid_attachment_length");
  const digest = fromB64url(row.ciphertext_sha256);
  if (digest.byteLength !== 32 || b64url(digest) !== row.ciphertext_sha256) throw new Error("Stored attachment digest is invalid");
  try {
    let stored: ObjectStoreObject | null;
    try {
      stored = await objectStore(env).put(row.object_key, request.body, {
        ifAbsent: true, expectedSize: declaredSize, checksumSha256: digest,
        contentType: "application/octet-stream", metadata: { room_id: row.room_id, sha256: row.ciphertext_sha256 },
      });
    } catch (error) {
      if (error instanceof ObjectStoreChecksumMismatchError) throw new HttpError(400, "Attachment ciphertext digest mismatch", "invalid_attachment_digest");
      throw error;
    }
    if (stored && stored.size !== row.ciphertext_bytes) {
      await objectStore(env).delete(row.object_key);
      throw new HttpError(400, "Attachment length mismatch", "invalid_attachment_length");
    }
    if (!stored) {
      const existing = await objectStore(env).head(row.object_key);
      if (!existing || existing.size !== row.ciphertext_bytes || existing.metadata.sha256 !== row.ciphertext_sha256) throw new Error("Object-store key was recreated with conflicting bytes");
    }
    const completed = await db.deleteFrom("attachment_repair_jobs").where("attachment_id", "=", id).where("lease_device_id", "=", auth.deviceId).where("lease_token_hash", "=", await sha256(token)).executeTakeFirst();
    if (completed.numDeletedRows !== 1n) {
      // Retention/account deletion may have removed the logical attachment
      // while this bounded upload was in flight. Never leave our new R2 write
      // behind as an untracked, quota-free orphan.
      if (stored) await objectStore(env).delete(row.object_key);
      throw new HttpError(409, "Attachment was collected while repair was in progress", "invalid_repair_lease");
    }
    return json({ attachment_id: id, restored: true });
  } catch (error) {
    await db.updateTable("attachment_repair_jobs").set({ attempts: sql<number>`attempts + 1`, last_error: (error instanceof Error ? error.message : "R2 repair failed").slice(0, 500), updated_at: Date.now() }).where("attachment_id", "=", id).execute();
    throw error;
  }
}

async function retentionCoverage(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const db = createDatabase(env.DB);
  if (request.method === "GET") {
    const cursor = new URL(request.url).searchParams.get("cursor");
    if (cursor !== null && !isNamespacedRoomId(cursor)) throw new HttpError(400, "Invalid retention cursor", "invalid_cursor");
    let query = db.selectFrom("rooms as r")
      .innerJoin("room_members as rm", "rm.room_id", "r.room_id")
      .innerJoin("room_devices as rd", (join) => join.onRef("rd.room_id", "=", "r.room_id").on("rd.device_id", "=", auth.deviceId))
      .select(["r.room_id", "r.current_seq", "r.retention_floor_seq", "r.retention_generation"])
      .where("rm.user_id", "=", auth.userId).where("rm.removed_at", "is", null).where("rd.removed_at", "is", null)
      .where("r.retention_days", "is not", null).orderBy("r.room_id").limit(101);
    if (cursor) query = query.where("r.room_id", ">", cursor);
    const rows = await query.execute();
    const hasMore = rows.length > 100; const page = hasMore ? rows.slice(0, 100) : rows;
    return json({ rooms: page, next_cursor: hasMore ? page.at(-1)?.room_id ?? null : null });
  }

  const body = await readJson(request, 64 * 1_024);
  const acknowledgements = body.acknowledgements;
  if (!Array.isArray(acknowledgements) || acknowledgements.length < 1 || acknowledgements.length > 100) {
    throw new HttpError(400, "Retention acknowledgements must contain 1-100 rooms", "invalid_retention_ack");
  }
  const parsed = acknowledgements.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Invalid retention acknowledgement", "invalid_retention_ack");
    const item = value as Record<string, unknown>;
    const roomId = item.room_id;
    const generation = Number(item.generation); const fromSeq = Number(item.from_seq); const throughSeq = Number(item.through_seq);
    if (typeof roomId !== "string" || !isNamespacedRoomId(roomId) || !Number.isSafeInteger(generation) || generation < 1
      || !Number.isSafeInteger(fromSeq) || fromSeq < 1 || !Number.isSafeInteger(throughSeq) || throughSeq < fromSeq || throughSeq - fromSeq + 1 > 10_000) {
      throw new HttpError(400, "Invalid retention acknowledgement", "invalid_retention_ack");
    }
    return { room_id: roomId, generation, from_seq: fromSeq, through_seq: throughSeq };
  });
  if (new Set(parsed.map((item) => item.room_id)).size !== parsed.length) throw new HttpError(400, "Duplicate retention room", "invalid_retention_ack");
  const eligible = await db.selectFrom("rooms as r")
    .innerJoin("room_members as rm", "rm.room_id", "r.room_id")
    .innerJoin("room_devices as rd", (join) => join.onRef("rd.room_id", "=", "r.room_id").on("rd.device_id", "=", auth.deviceId))
    .select(["r.room_id", "r.current_seq", "r.retention_floor_seq", "r.retention_generation"])
    .where("r.room_id", "in", parsed.map((item) => item.room_id)).where("r.retention_days", "is not", null)
    .where("rm.user_id", "=", auth.userId).where("rm.removed_at", "is", null).where("rd.removed_at", "is", null).execute();
  const byRoom = new Map(eligible.map((item) => [item.room_id, item]));
  for (const item of parsed) {
    const room = byRoom.get(item.room_id);
    if (!room) throw new HttpError(403, "Active room device membership required", "forbidden");
    if (item.generation !== room.retention_generation || item.from_seq !== room.retention_floor_seq + 1
      || item.through_seq > room.current_seq) {
      throw new HttpError(409, "Retention acknowledgement is stale", "stale_retention_ack");
    }
  }
  const now = Date.now();
  await batch(env.DB, parsed.map((item) => db.insertInto("room_retention_acks").values({ ...item, device_id: auth.deviceId, acknowledged_at: now })
    .onConflict((conflict) => conflict.columns(["room_id", "device_id"]).doUpdateSet({
      generation: item.generation, from_seq: item.from_seq, through_seq: item.through_seq, acknowledged_at: now,
    }))));
  return json({ acknowledged: parsed.length });
}

async function downloadAttachment(request: Request, env: Env, auth: AuthContext, id: string): Promise<Response> {
  const db = createDatabase(env.DB);
  const original = await db.selectFrom("attachments as a")
    .innerJoin("room_members as rm", "rm.room_id", "a.room_id")
    .leftJoin("attachment_repair_jobs as repair", "repair.attachment_id", "a.attachment_id")
    .select(["a.attachment_id", "a.object_key", "a.uploader_user_id", "a.ciphertext_bytes", "a.ciphertext_sha256", "repair.attachment_id as repair_attachment_id"])
    .where("a.attachment_id", "=", id).where("a.source_deleted_at", "is", null)
    .where("rm.user_id", "=", auth.userId).where("rm.removed_at", "is", null).executeTakeFirst();
  const row = original ?? await db.selectFrom("attachment_grants as g")
    .innerJoin("attachments as a", "a.attachment_id", "g.source_attachment_id")
    .innerJoin("room_members as rm", "rm.room_id", "g.room_id")
    .leftJoin("attachment_repair_jobs as repair", "repair.attachment_id", "a.attachment_id")
    .select(["a.attachment_id", "a.object_key", "a.uploader_user_id", "a.ciphertext_bytes", "a.ciphertext_sha256", "repair.attachment_id as repair_attachment_id"])
    .where("g.grant_id", "=", id).where("rm.user_id", "=", auth.userId).where("rm.removed_at", "is", null).executeTakeFirst();
  if (!row) throw new HttpError(404, "Attachment not found", "not_found");
  if (row.repair_attachment_id) {
    throw new HttpError(503, "Attachment ciphertext is awaiting device repair", row.ciphertext_sha256 ? "attachment_repair_pending" : "attachment_repair_unverified", { "retry-after": "30" });
  }
  const object = await objectStore(env).get(row.object_key, { rangeHeader: request.headers.get("range") ?? undefined });
  if (!object?.body) {
    const deletion = await db.selectFrom("attachment_deletions").select("delete_event_id").where("attachment_id", "=", row.attachment_id).executeTakeFirst();
    if (deletion) await processPendingAttachmentDeletions(env, deletion.delete_event_id);
    else await markAttachmentRepairNeeded(env, row.attachment_id);
    if (deletion) throw new HttpError(404, "Attachment not found", "not_found");
    throw new HttpError(503, "Attachment ciphertext is temporarily unavailable and queued for device repair", row.ciphertext_sha256 ? "attachment_repair_pending" : "attachment_repair_unverified", { "retry-after": "30" });
  }
  if (object.size !== row.ciphertext_bytes || (row.ciphertext_sha256 && object.metadata.sha256 !== row.ciphertext_sha256)) {
    await object.body.cancel().catch(() => undefined);
    await objectStore(env).delete(row.object_key);
    await markAttachmentRepairNeeded(env, row.attachment_id);
    throw new HttpError(503, "Attachment ciphertext failed integrity metadata validation and is queued for device repair", "attachment_repair_pending", { "retry-after": "30" });
  }
  const headers = new Headers({ "content-type": "application/octet-stream", etag: object.entityTag, "accept-ranges": "bytes", "cache-control": "private, max-age=31536000, immutable" });
  const range = object.range ?? null;
  if (range) headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
  headers.set("content-length", String(range?.length ?? object.size));
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

async function uploadSegment(request: Request, env: Env, auth: AuthContext, roomId: RoomId): Promise<Response> {
  requireArchiveCompaction(env);
  if ((await memberRole(env, roomId, auth.userId)) !== "owner") throw new HttpError(403, "Only the room owner may compact history", "forbidden");
  const requestState = await directRequestState(env, roomId);
  if (requestState && requestState.status !== "accepted") throw new HttpError(409, "Archiving requires an accepted message request", "message_request_archive_blocked");
  const start = Number(request.headers.get("x-start-seq"));
  const end = Number(request.headers.get("x-end-seq"));
  const declaredSize = Number(request.headers.get("content-length"));
  const suppliedDigest = requestContentSha256(request, "invalid_archive_digest");
  const id = request.headers.get("x-segment-id") ?? "";
  const leaseToken = request.headers.get("x-compaction-token") ?? "";
  if (!request.body || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || !Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > MAX_SEGMENT || !/^[A-Za-z0-9_-]{16,64}$/.test(id) || !/^[A-Za-z0-9_-]{16,128}$/.test(leaseToken)) throw new HttpError(400, "Invalid archive segment", "invalid_segment");
  if (!suppliedDigest) throw new HttpError(400, "Ciphertext SHA-256 required for archive uploads", "archive_digest_required");
  if (declaredSize < ARCHIVE_V3_HEADER_BYTES) {
    await request.body.cancel().catch(() => undefined);
    throw new HttpError(400, "Invalid archive segment v3 envelope", "invalid_segment_envelope");
  }
  const db = createDatabase(env.DB);
  const existing = await db.selectFrom("archive_segments").select(["segment_id", "start_seq", "end_seq", "byte_size", "ciphertext_sha256"]).where("segment_id", "=", id).where("room_id", "=", roomId).executeTakeFirst();
  if (existing) {
    if (existing.start_seq !== start || existing.end_seq !== end || existing.byte_size !== declaredSize
      || existing.ciphertext_sha256 !== suppliedDigest.text) {
      throw new HttpError(409, "Segment ID was already used for different ciphertext", "segment_conflict");
    }
    await env.ROOMS.getByName(roomId).releaseCompactionLease(leaseToken, auth.deviceId);
    return json(existing);
  }
  if (!(await env.ROOMS.getByName(roomId).validateCompactionLease(leaseToken, auth.deviceId, id, start, end, Date.now()))) throw new HttpError(409, "Compaction lease is missing or expired", "invalid_compaction_lease");
  const room = await db.selectFrom("rooms").select(["current_seq", "retention_floor_seq"]).where("room_id", "=", roomId).executeTakeFirst();
  if (!room || start <= room.retention_floor_seq || end > room.current_seq) throw new HttpError(409, "Segment is outside the durable room history", "invalid_segment_range");
  const overlap = await db.selectFrom("archive_segments").select("segment_id").where("room_id", "=", roomId).where("start_seq", "<=", end).where("end_seq", ">=", start).executeTakeFirst();
  if (overlap) throw new HttpError(409, "Segment overlaps archived history", "segment_overlap");
  const activeDevices = await db.selectFrom("room_devices as rd").innerJoin("devices as d", "d.device_id", "rd.device_id")
    .select("rd.device_id").where("rd.room_id", "=", roomId).where("rd.removed_at", "is", null).where("d.revoked_at", "is", null).limit(1_001).execute();
  if (activeDevices.length > 1_000) throw new HttpError(409, "Room has too many devices to archive", "archive_device_limit");
  const owner = await db.selectFrom("rooms").select("created_by").where("room_id", "=", roomId).executeTakeFirstOrThrow();
  const prefix = await archiveEnvelopePrefix(request.body, declaredSize);
  try { validateArchiveV3Envelope(prefix.bytes, declaredSize, start, end, auth.deviceId, new Set(activeDevices.map((device) => device.device_id))); }
  catch (error) { await prefix.body.cancel().catch(() => undefined); throw error; }
  const objectKey = `rooms/${encodeURIComponent(roomId)}/segments/${String(start).padStart(12, "0")}-${id}.bin`;
  const pending = { object_key: objectKey, owner_user_id: owner.created_by, kind: "archive" as const, expected_bytes: declaredSize, room_id: roomId, content_sha256: suppliedDigest.text };
  let reservationCreated: boolean;
  try { reservationCreated = await stageIdempotentR2Write(env, pending); }
  catch (error) { await prefix.body.cancel().catch(() => undefined); throw error; }
  let releaseReservation = false;
  const createdAt = Date.now();
  const matchesCommitted = (row: { start_seq: number; end_seq: number; byte_size: number; ciphertext_sha256: string | null }): boolean => (
    row.start_seq === start && row.end_seq === end && row.byte_size === declaredSize && row.ciphertext_sha256 === suppliedDigest.text
  );
  const matchesStored = (object: ObjectStoreObject): boolean => object.size === declaredSize
    && object.metadata.room_id === roomId && object.metadata.segment_id === id
    && object.metadata.start === String(start) && object.metadata.end === String(end)
    && object.metadata.sha256 === suppliedDigest.text;
  try {
    let stored: ObjectStoreObject | null = null;
    // A matching pre-existing write intent means an earlier conditional PUT
    // may have landed before its response or D1 commit was lost. Probe that
    // exact key first so a multi-megabyte ciphertext is not retransmitted.
    // First attempts still go directly to one PUT without a discovery HEAD.
    if (!reservationCreated) {
      try { stored = await objectStore(env).head(objectKey); }
      catch (error) { await prefix.body.cancel(error).catch(() => undefined); throw error; }
      if (stored && !matchesStored(stored)) {
        await prefix.body.cancel("archive segment conflict").catch(() => undefined);
        throw new HttpError(409, "Segment ID is already in use", "segment_conflict");
      }
      if (stored) await prefix.body.cancel("archive segment already uploaded").catch(() => undefined);
    }
    if (!stored) {
      const limited = exactLengthUploadStream(prefix.body, declaredSize);
      try {
        stored = (await Promise.all([
          objectStore(env).put(objectKey, limited.body, { ifAbsent: true, expectedSize: declaredSize, checksumSha256: suppliedDigest.bytes, contentType: "application/octet-stream", metadata: { room_id: roomId, segment_id: id, start: String(start), end: String(end), sha256: suppliedDigest.text } }),
          limited.completed,
        ]))[0];
      } catch (error) {
        if (error instanceof ObjectStoreChecksumMismatchError) { releaseReservation = true; throw new HttpError(400, "Archive ciphertext digest mismatch", "invalid_archive_digest"); }
        if (isFixedLengthMismatch(error)) { releaseReservation = true; throw new HttpError(400, "Archive segment length mismatch", "invalid_segment_length"); }
        throw error;
      }
      if (!stored || !matchesStored(stored)) {
        if (stored) throw new HttpError(400, "Archive segment length or digest mismatch", "invalid_archive_digest");
        const recovered = await objectStore(env).head(objectKey);
        if (!recovered || !matchesStored(recovered)) {
          releaseReservation = true;
          throw new HttpError(409, "Segment ID is already in use", "segment_conflict");
        }
      }
    }
    const liveClaim = await db.selectFrom("pending_r2_writes").select(["object_key", "owner_user_id", "kind", "expected_bytes", "room_id", "content_sha256", "cancelled_at"])
      .where("object_key", "=", objectKey).executeTakeFirst();
    if (!liveClaim) {
      const landed = await db.selectFrom("archive_segments").select(["start_seq", "end_seq", "byte_size", "ciphertext_sha256"])
        .where("segment_id", "=", id).where("room_id", "=", roomId).executeTakeFirst();
      if (landed && matchesCommitted(landed)) {
        await env.ROOMS.getByName(roomId).releaseCompactionLease(leaseToken, auth.deviceId);
        return json({ segment_id: id, start_seq: start, end_seq: end, byte_size: declaredSize });
      }
      await objectStore(env).delete(objectKey);
      throw new HttpError(409, "Archive upload was cancelled", "archive_upload_cancelled");
    }
    if (liveClaim.cancelled_at !== null) {
      await objectStore(env).delete(objectKey);
      await finalizePendingR2Cleanup(env, [liveClaim as PendingR2Write]);
      throw new HttpError(409, "Archive upload was cancelled", "archive_upload_cancelled");
    }
    // A streamed object-store upload can outlive its lease. Revalidate at the
    // commit boundary so a released or expired lease cannot make a late object
    // authoritative. This is a DO check, not an R2/S3 read.
    if (!(await env.ROOMS.getByName(roomId).validateCompactionLease(leaseToken, auth.deviceId, id, start, end, Date.now()))) {
      await db.updateTable("pending_r2_writes").set({ cancelled_at: Date.now() }).where("object_key", "=", objectKey).execute();
      await objectStore(env).delete(objectKey);
      await finalizePendingR2Cleanup(env, [liveClaim as PendingR2Write]);
      throw new HttpError(409, "Compaction lease expired while uploading", "invalid_compaction_lease");
    }
    await batch(env.DB, [
      db.insertInto("archive_segments")
        .columns(["segment_id", "room_id", "start_seq", "end_seq", "object_key", "byte_size", "ciphertext_sha256", "created_at"])
        .expression((eb) => eb.selectFrom("pending_r2_writes").select([
          eb.val(id).as("segment_id"), eb.val(roomId).as("room_id"), eb.val(start).as("start_seq"), eb.val(end).as("end_seq"),
          eb.val(objectKey).as("object_key"), eb.val(declaredSize).as("byte_size"), eb.val(suppliedDigest.text).as("ciphertext_sha256"), eb.val(createdAt).as("created_at"),
        ]).where("object_key", "=", objectKey).where("owner_user_id", "=", owner.created_by).where("kind", "=", "archive")
          .where("room_id", "=", roomId).where("content_sha256", "=", suppliedDigest.text).where("expected_bytes", "=", declaredSize)
          .where("cancelled_at", "is", null))
        .onConflict((conflict) => conflict.column("segment_id").doNothing()),
      db.deleteFrom("pending_r2_writes").where("object_key", "=", objectKey).where("cancelled_at", "is", null),
    ]);
    const committed = await db.selectFrom("archive_segments").select(["start_seq", "end_seq", "byte_size", "ciphertext_sha256"])
      .where("segment_id", "=", id).where("room_id", "=", roomId).executeTakeFirst();
    if (!committed || !matchesCommitted(committed)) throw new HttpError(409, "Segment ID is already in use", "segment_conflict");
  } catch (error) {
    if (reservationCreated && releaseReservation) await finalizePendingR2Cleanup(env, [pending]);
    throw error;
  }
  await env.ROOMS.getByName(roomId).releaseCompactionLease(leaseToken, auth.deviceId);
  return json({ segment_id: id, start_seq: start, end_seq: end, byte_size: declaredSize }, 201);
}

async function cancelArchiveSegmentUpload(request: Request, env: Env, auth: AuthContext, roomId: RoomId, segmentId: string): Promise<Response> {
  requireArchiveCompaction(env);
  if ((await memberRole(env, roomId, auth.userId)) !== "owner") throw new HttpError(403, "Only the room owner may cancel compaction", "forbidden");
  const start = Number(request.headers.get("x-start-seq"));
  const end = Number(request.headers.get("x-end-seq"));
  const declaredSize = Number(request.headers.get("x-ciphertext-bytes"));
  const suppliedDigest = requestContentSha256(request, "invalid_archive_digest");
  const leaseToken = request.headers.get("x-compaction-token") ?? "";
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start
    || !Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > MAX_SEGMENT
    || !suppliedDigest || !/^[A-Za-z0-9_-]{16,128}$/.test(leaseToken)) {
    throw new HttpError(400, "Invalid archive upload cancellation", "invalid_segment");
  }
  const db = createDatabase(env.DB);
  const committedState = async () => db.selectFrom("archive_segments").select(["start_seq", "end_seq", "byte_size", "ciphertext_sha256"])
    .where("segment_id", "=", segmentId).where("room_id", "=", roomId).executeTakeFirst();
  const matchesCommitted = (row: { start_seq: number; end_seq: number; byte_size: number; ciphertext_sha256: string | null }): boolean => (
    row.start_seq === start && row.end_seq === end && row.byte_size === declaredSize && row.ciphertext_sha256 === suppliedDigest.text
  );
  let committed = await committedState();
  if (committed) {
    if (!matchesCommitted(committed)) throw new HttpError(409, "Segment ID was committed for different ciphertext", "segment_conflict");
    return json({ segment_id: segmentId, state: "committed" });
  }
  const room = await db.selectFrom("rooms").select("created_by").where("room_id", "=", roomId).executeTakeFirstOrThrow();
  const objectKey = `rooms/${encodeURIComponent(roomId)}/segments/${String(start).padStart(12, "0")}-${segmentId}.bin`;
  const expectedPending: PendingR2Write = { object_key: objectKey, owner_user_id: room.created_by, kind: "archive", expected_bytes: declaredSize, room_id: roomId, content_sha256: suppliedDigest.text };
  const exactPending = () => db.selectFrom("pending_r2_writes").select(["object_key", "owner_user_id", "kind", "expected_bytes", "room_id", "content_sha256", "cancelled_at"])
    .where("object_key", "=", objectKey).where("owner_user_id", "=", room.created_by).where("kind", "=", "archive")
    .where("room_id", "=", roomId).where("expected_bytes", "=", declaredSize).where("content_sha256", "=", suppliedDigest.text).executeTakeFirst();
  const pendingForKey = await db.selectFrom("pending_r2_writes").select(["object_key", "owner_user_id", "kind", "expected_bytes", "room_id", "content_sha256", "cancelled_at"])
    .where("object_key", "=", objectKey).executeTakeFirst();
  if (pendingForKey && !pendingR2WriteMatches(pendingForKey as PendingR2Write, expectedPending)) {
    throw new HttpError(409, "Segment ID has a different pending ciphertext", "segment_conflict");
  }
  const pendingBeforeValidation = pendingForKey;
  const leaseValid = await env.ROOMS.getByName(roomId).validateCompactionLease(leaseToken, auth.deviceId, segmentId, start, end, Date.now());
  if (!leaseValid && !pendingBeforeValidation) {
    committed = await committedState();
    if (committed) {
      if (!matchesCommitted(committed)) throw new HttpError(409, "Segment ID was committed for different ciphertext", "segment_conflict");
      return json({ segment_id: segmentId, state: "committed" });
    }
    // D1 has neither a commit nor an exact write intent, so no object-store
    // lookup is needed. A late uploader revalidates its lease before commit and
    // exact-deletes its own object if it arrives after this response.
    return json({ segment_id: segmentId, state: "absent" });
  }
  const now = Date.now();
  await db.updateTable("pending_r2_writes").set({ cancelled_at: now })
    .where("object_key", "=", objectKey).where("owner_user_id", "=", room.created_by).where("kind", "=", "archive").where("room_id", "=", roomId)
    .where("expected_bytes", "=", declaredSize).where("content_sha256", "=", suppliedDigest.text).execute();
  const pending = await exactPending();
  if (!pending) {
    committed = await committedState();
    if (committed && matchesCommitted(committed)) return json({ segment_id: segmentId, state: "committed" });
    if (leaseValid) {
      await env.ROOMS.getByName(roomId).releaseCompactionLease(leaseToken, auth.deviceId);
    }
    return json({ segment_id: segmentId, state: "absent" });
  }
  await objectStore(env).delete(objectKey);
  await finalizePendingR2Cleanup(env, [pending as PendingR2Write]);
  await env.ROOMS.getByName(roomId).releaseCompactionLease(leaseToken, auth.deviceId);
  return json({ segment_id: segmentId, state: "abandoned" });
}

async function acknowledgeArchiveSegmentRetention(env: Env, auth: AuthContext, segmentId: string): Promise<Response> {
  const db = createDatabase(env.DB);
  const segment = await db.selectFrom("archive_segments as s").innerJoin("rooms as r", "r.room_id", "s.room_id").innerJoin("room_members as rm", "rm.room_id", "s.room_id")
    .select(["s.segment_id", "s.room_id"]).where("s.segment_id", "=", segmentId)
    .whereRef("s.start_seq", ">", "r.retention_floor_seq")
    .where("rm.user_id", "=", auth.userId).where("rm.removed_at", "is", null).executeTakeFirst();
  if (!segment) throw new HttpError(404, "Archive segment not found", "not_found");
  await db.insertInto("archive_segment_retention_acks").values({ segment_id: segmentId, device_id: auth.deviceId, cached_at: Date.now() })
    .onConflict((conflict) => conflict.columns(["segment_id", "device_id"]).doUpdateSet({ cached_at: Date.now() })).execute();
  return json({ segment_id: segmentId, room_id: segment.room_id });
}

async function markArchiveRepairNeeded(env: Env, segmentId: string, roomId: RoomId): Promise<void> {
  const now = Date.now(); const inserted = await createDatabase(env.DB).insertInto("archive_segment_repair_jobs").values({
    segment_id: segmentId, detected_at: now, updated_at: now, lease_device_id: null, lease_token_hash: null, lease_expires_at: null, attempts: 0, last_error: null,
  }).onConflict((conflict) => conflict.column("segment_id").doNothing()).returning("segment_id").executeTakeFirst();
  if (inserted) await env.ROOMS.getByName(roomId).notifyArchiveRepairAvailable(segmentId);
}

function archiveRepairAccess(db: ReturnType<typeof createDatabase>, auth: AuthContext, segmentId: string) {
  return db.selectFrom("archive_segment_repair_jobs as job")
    .innerJoin("archive_segments as s", "s.segment_id", "job.segment_id")
    .innerJoin("rooms as r", "r.room_id", "s.room_id")
    .innerJoin("archive_segment_retention_acks as ack", (join) => join.onRef("ack.segment_id", "=", "s.segment_id").on("ack.device_id", "=", auth.deviceId))
    .innerJoin("room_members as rm", "rm.room_id", "s.room_id")
    .select(["s.segment_id", "s.room_id", "s.start_seq", "s.end_seq", "s.object_key", "s.byte_size", "s.ciphertext_sha256", "job.lease_device_id", "job.lease_token_hash", "job.lease_expires_at"])
    .where("s.segment_id", "=", segmentId).whereRef("s.start_seq", ">", "r.retention_floor_seq")
    .where("rm.user_id", "=", auth.userId).where("rm.removed_at", "is", null);
}

async function archiveRepairJobs(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const cursor = new URL(request.url).searchParams.get("cursor");
  if (cursor !== null && !/^[A-Za-z0-9_-]{16,64}$/.test(cursor)) throw new HttpError(400, "Invalid repair cursor", "invalid_cursor");
  const db = createDatabase(env.DB); const now = Date.now();
  let query = db.selectFrom("archive_segment_repair_jobs as job")
    .innerJoin("archive_segments as s", "s.segment_id", "job.segment_id")
    .innerJoin("rooms as r", "r.room_id", "s.room_id")
    .innerJoin("archive_segment_retention_acks as ack", (join) => join.onRef("ack.segment_id", "=", "s.segment_id").on("ack.device_id", "=", auth.deviceId))
    .innerJoin("room_members as rm", "rm.room_id", "s.room_id")
    .select(["s.segment_id", "s.room_id", "s.byte_size", "s.ciphertext_sha256", "job.detected_at"])
    .where("s.ciphertext_sha256", "is not", null).whereRef("s.start_seq", ">", "r.retention_floor_seq")
    .where("rm.user_id", "=", auth.userId).where("rm.removed_at", "is", null)
    .where((eb) => eb.or([eb("job.lease_expires_at", "is", null), eb("job.lease_expires_at", "<=", now), eb("job.lease_device_id", "=", auth.deviceId)]))
    .orderBy("s.segment_id").limit(101);
  if (cursor) query = query.where("s.segment_id", ">", cursor);
  const rows = await query.execute(); const more = rows.length > 100; const page = more ? rows.slice(0, 100) : rows;
  return json({ jobs: page, next_cursor: more ? page.at(-1)?.segment_id ?? null : null });
}

async function acquireArchiveRepairLease(env: Env, auth: AuthContext, segmentId: string): Promise<Response> {
  const db = createDatabase(env.DB); const accessible = await archiveRepairAccess(db, auth, segmentId).executeTakeFirst();
  if (!accessible) throw new HttpError(404, "Repairable archive segment not found", "not_found");
  if (!accessible.ciphertext_sha256) throw new HttpError(409, "Legacy archive segment has no verifiable digest", "archive_repair_unverified");
  const now = Date.now(); const token = randomId(32); const tokenHash = await sha256(token); const expiresAt = now + ARCHIVE_REPAIR_LEASE_MS;
  const result = await db.updateTable("archive_segment_repair_jobs").set({ lease_device_id: auth.deviceId, lease_token_hash: tokenHash, lease_expires_at: expiresAt, updated_at: now })
    .where("segment_id", "=", segmentId).where((eb) => eb.or([eb("lease_expires_at", "is", null), eb("lease_expires_at", "<=", now), eb("lease_device_id", "=", auth.deviceId)]))
    .returning("segment_id").executeTakeFirst();
  if (!result) throw new HttpError(409, "Another device is repairing this archive segment", "repair_busy", { "retry-after": "30" });
  return json({ segment_id: segmentId, room_id: accessible.room_id, token, byte_size: accessible.byte_size, ciphertext_sha256: accessible.ciphertext_sha256, expires_at: expiresAt }, 201);
}

async function releaseArchiveRepairLease(request: Request, env: Env, auth: AuthContext, segmentId: string): Promise<Response> {
  const token = request.headers.get("x-repair-token"); const outcome = request.headers.get("x-repair-outcome");
  if (!token || token.length > 128) throw new HttpError(400, "Repair token required", "invalid_repair_lease");
  if (outcome !== null && outcome !== "local_missing" && outcome !== "local_invalid") throw new HttpError(400, "Invalid repair outcome", "invalid_repair_outcome");
  const db = createDatabase(env.DB);
  const released = await db.updateTable("archive_segment_repair_jobs").set({ lease_device_id: null, lease_token_hash: null, lease_expires_at: null, updated_at: Date.now() })
    .where("segment_id", "=", segmentId).where("lease_device_id", "=", auth.deviceId).where("lease_token_hash", "=", await sha256(token)).returning("segment_id").executeTakeFirst();
  if (released && outcome) await db.deleteFrom("archive_segment_retention_acks").where("segment_id", "=", segmentId).where("device_id", "=", auth.deviceId).execute();
  return new Response(null, { status: 204 });
}

async function uploadArchiveRepair(request: Request, env: Env, auth: AuthContext, segmentId: string): Promise<Response> {
  const token = request.headers.get("x-repair-token"); const declaredSize = Number(request.headers.get("content-length"));
  if (!token || token.length > 128) throw new HttpError(400, "Repair token required", "invalid_repair_lease");
  if (!request.body || !Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > MAX_SEGMENT) throw new HttpError(411, "Valid Content-Length required", "length_required");
  const db = createDatabase(env.DB); const row = await archiveRepairAccess(db, auth, segmentId).executeTakeFirst();
  if (!row || row.lease_device_id !== auth.deviceId || row.lease_token_hash !== await sha256(token) || !row.lease_expires_at || row.lease_expires_at <= Date.now()) throw new HttpError(409, "Archive repair lease is missing or stale", "invalid_repair_lease");
  if (!row.ciphertext_sha256) throw new HttpError(409, "Legacy archive segment has no verifiable digest", "archive_repair_unverified");
  if (declaredSize !== row.byte_size) throw new HttpError(400, "Archive segment length mismatch", "invalid_segment_length");
  const digest = fromB64url(row.ciphertext_sha256);
  if (digest.byteLength !== 32 || b64url(digest) !== row.ciphertext_sha256) throw new Error("Stored archive segment digest is invalid");
  try {
    let stored: ObjectStoreObject | null;
    try {
      stored = await objectStore(env).put(row.object_key, request.body, {
        ifAbsent: true, expectedSize: declaredSize, checksumSha256: digest, contentType: "application/octet-stream",
        metadata: { room_id: row.room_id, start: String(row.start_seq), end: String(row.end_seq), sha256: row.ciphertext_sha256 },
      });
    } catch (error) {
      if (error instanceof ObjectStoreChecksumMismatchError) throw new HttpError(400, "Archive ciphertext digest mismatch", "invalid_archive_digest");
      throw error;
    }
    if (stored && stored.size !== row.byte_size) {
      await objectStore(env).delete(row.object_key);
      throw new HttpError(400, "Archive segment length mismatch", "invalid_segment_length");
    }
    if (!stored) {
      const existing = await objectStore(env).head(row.object_key);
      if (!existing || existing.size !== row.byte_size || existing.metadata.sha256 !== row.ciphertext_sha256) throw new Error("Object-store archive key was recreated with conflicting bytes");
    }
    const completed = await db.deleteFrom("archive_segment_repair_jobs").where("segment_id", "=", segmentId)
      .where("lease_device_id", "=", auth.deviceId).where("lease_token_hash", "=", await sha256(token)).executeTakeFirst();
    if (completed.numDeletedRows !== 1n) {
      if (stored) await objectStore(env).delete(row.object_key);
      throw new HttpError(409, "Archive segment was collected while repair was in progress", "invalid_repair_lease");
    }
    return json({ segment_id: segmentId, restored: true });
  } catch (error) {
    await db.updateTable("archive_segment_repair_jobs").set({ attempts: sql<number>`attempts + 1`, last_error: (error instanceof Error ? error.message : "R2 archive repair failed").slice(0, 500), updated_at: Date.now() }).where("segment_id", "=", segmentId).execute();
    throw error;
  }
}

async function downloadSegment(request: Request, env: Env, auth: AuthContext, roomId: RoomId, segmentId: string): Promise<Response> {
  if (!(await memberRole(env, roomId, auth.userId))) throw new HttpError(404, "Segment not found", "not_found");
  const db = createDatabase(env.DB);
  const row = await db.selectFrom("archive_segments as s").innerJoin("rooms as r", "r.room_id", "s.room_id")
    .leftJoin("archive_segment_repair_jobs as repair", "repair.segment_id", "s.segment_id")
    .select(["s.object_key", "s.byte_size", "s.ciphertext_sha256", "s.start_seq", "r.retention_floor_seq", "r.created_by", "repair.segment_id as repair_segment_id"])
    .where("s.segment_id", "=", segmentId).where("s.room_id", "=", roomId).executeTakeFirst();
  if (!row) throw new HttpError(404, "Segment not found", "not_found");
  if (row.start_seq <= row.retention_floor_seq) throw new HttpError(410, "Archive segment was intentionally removed", "history_intentionally_deleted");
  if (row.repair_segment_id) {
    throw new HttpError(503, "Archive segment is awaiting device repair", row.ciphertext_sha256 ? "archive_repair_pending" : "archive_repair_unverified", { "retry-after": "30" });
  }
  const object = await objectStore(env).get(row.object_key, { rangeHeader: request.headers.get("range") ?? undefined });
  if (!object?.body) {
    await markArchiveRepairNeeded(env, segmentId, roomId);
    throw new HttpError(503, "Archive segment is temporarily unavailable and queued for device repair", row.ciphertext_sha256 ? "archive_repair_pending" : "archive_repair_unverified", { "retry-after": "30" });
  }
  if (object.size !== row.byte_size || (row.ciphertext_sha256 && object.metadata.sha256 !== row.ciphertext_sha256)) {
    await object.body.cancel().catch(() => undefined); await objectStore(env).delete(row.object_key);
    await markArchiveRepairNeeded(env, segmentId, roomId);
    throw new HttpError(503, "Archive segment failed integrity metadata validation and is queued for device repair", "archive_repair_pending", { "retry-after": "30" });
  }
  const headers = new Headers({ "content-type": "application/octet-stream", "accept-ranges": "bytes", etag: object.entityTag });
  const range = object.range ?? null;
  if (range) headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
  headers.set("content-length", String(range?.length ?? object.size));
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

async function pushSubscribe(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const body = await readJson(request);
  const { endpoint, p256dh, authKey } = pushFields(body);
  const renewalToken = randomId(32); const renewalTokenHash = await sha256(renewalToken); const now = Date.now();
  const db = createDatabase(env.DB);
  const endpointOwner = await db.selectFrom("push_subscriptions").select("device_id").where("endpoint", "=", endpoint).executeTakeFirst();
  if (endpointOwner && endpointOwner.device_id !== auth.deviceId) throw new HttpError(409, "Push endpoint is already registered", "push_endpoint_conflict");
  await db.insertInto("push_subscriptions")
    .values({ device_id: auth.deviceId, endpoint, p256dh, auth: authKey, renewal_token_hash: renewalTokenHash, created_at: now, updated_at: now })
    .onConflict((conflict) => conflict.column("device_id").doUpdateSet({ endpoint, p256dh, auth: authKey, renewal_token_hash: renewalTokenHash, updated_at: now }))
    .execute();
  return json({ renewal_token: renewalToken }, 201);
}

function pushFields(body: Record<string, unknown>): { endpoint: string; p256dh: string; authKey: string } {
  const endpoint = stringField(body, "endpoint", 2_048);
  const p256dh = stringField(body, "p256dh", 512);
  const authKey = stringField(body, "auth", 512);
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new HttpError(400, "Invalid push endpoint", "invalid_push_subscription"); }
  const hostname = parsed.hostname.toLowerCase();
  const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
  const forbiddenHost = hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || ipv4 || hostname.includes(":");
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || (parsed.port && parsed.port !== "443") || forbiddenHost || !hostname.includes(".")) {
    throw new HttpError(400, "Push endpoint must be a public HTTPS URL", "invalid_push_subscription");
  }
  const base64url = /^[A-Za-z0-9_-]+$/;
  if (!base64url.test(p256dh) || p256dh.length < 80 || !base64url.test(authKey) || authKey.length < 16) {
    throw new HttpError(400, "Invalid push subscription keys", "invalid_push_subscription");
  }
  return { endpoint: parsed.toString(), p256dh, authKey };
}

async function renewPushSubscription(body: Record<string, unknown>, env: Env): Promise<Response> {
  const renewalToken = stringField(body, "renewal_token", 256);
  const { endpoint, p256dh, authKey } = pushFields(body);
  const db = createDatabase(env.DB);
  const existing = await db.selectFrom("push_subscriptions as p")
    .innerJoin("devices as d", "d.device_id", "p.device_id")
    .innerJoin("users as u", "u.user_id", "d.user_id")
    .select(["p.device_id"])
    .where("p.renewal_token_hash", "=", await sha256(renewalToken))
    .where("d.revoked_at", "is", null).where("u.deletion_requested_at", "is", null).where("u.deleted_at", "is", null)
    .executeTakeFirst();
  if (!existing) throw new HttpError(401, "Push renewal token is invalid", "invalid_push_renewal");
  const endpointOwner = await db.selectFrom("push_subscriptions").select("device_id").where("endpoint", "=", endpoint).executeTakeFirst();
  if (endpointOwner && endpointOwner.device_id !== existing.device_id) throw new HttpError(409, "Push endpoint is already registered", "push_endpoint_conflict");
  const updated = await db.updateTable("push_subscriptions").set({ endpoint, p256dh, auth: authKey, updated_at: Date.now() })
    .where("device_id", "=", existing.device_id).where("renewal_token_hash", "=", await sha256(renewalToken)).executeTakeFirst();
  if (!updated.numUpdatedRows) throw new HttpError(401, "Push renewal token is invalid", "invalid_push_renewal");
  return new Response(null, { status: 204 });
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const publicAvatar = path.match(/^\/avatars\/([A-Za-z0-9_-]{24})\.webp$/);
  if (publicAvatar && request.method === "GET") return publicProfileAvatar(env, publicAvatar[1]);
  if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
  if (path === "/api/v1/register" && request.method === "POST") return register(request, env);
  if (path === "/api/v1/register/opaque" && request.method === "POST") return registerOpaqueAccount(request, env);
  if (path === "/api/v1/login" && request.method === "POST") return login(request, env);
  if (path === "/api/v1/device-sessions/challenge" && request.method === "POST") return issueDeviceSessionChallenge(request, env);
  if (path === "/api/v1/device-sessions" && request.method === "POST") return claimDeviceSession(request, env);
  if (path === "/api/v1/passkeys/authentication/options" && request.method === "POST") return issuePasskeyAuthenticationOptions(request, env);
  if (path === "/api/v1/passkeys/authentication" && request.method === "POST") return loginWithPasskey(request, env);
  if (path === "/api/v1/appeals" && request.method === "POST") return createAccountAppeal(request, env);
  const publicAppeal = path.match(/^\/api\/v1\/appeals\/([^/]+)$/);
  if (publicAppeal && request.method === "GET") return accountAppealStatus(request, env, decodeURIComponent(publicAppeal[1]));
  if (path === "/api/v1/push/renew" && request.method === "POST") {
    const body = await readJson(request);
    await limitUnauthenticatedRequest(request, env, "push-renew", typeof body.renewal_token === "string" ? body.renewal_token : "missing");
    return renewPushSubscription(body, env);
  }
  if (path === "/api/v1/backup-restores/check" && request.method === "POST") { await limitUnauthenticatedIpRequest(request, env); return checkBackupRestore(request, env); }
  if (path === "/api/v1/device-links" && request.method === "POST") { await limitUnauthenticatedIpRequest(request, env); return createDeviceLink(request, env); }
  const publicDeviceLink = path.match(/^\/api\/v1\/device-links\/([^/]+)\/(status|key-packages|claim)$/);
  if (publicDeviceLink) {
    const linkId = decodeURIComponent(publicDeviceLink[1]);
    await limitUnauthenticatedRequest(request, env, "device-link", linkId);
    if (publicDeviceLink[2] === "status" && request.method === "GET") return deviceLinkStatus(request, env, linkId);
    if (publicDeviceLink[2] === "key-packages" && request.method === "POST") return uploadDeviceLinkPackages(request, env, linkId);
    if (publicDeviceLink[2] === "claim" && request.method === "POST") return claimDeviceLink(request, env, linkId);
  }
  const publicDeviceLinkCancel = path.match(/^\/api\/v1\/device-links\/([^/]+)\/cancel$/);
  if (publicDeviceLinkCancel && request.method === "DELETE") {
    const linkId = decodeURIComponent(publicDeviceLinkCancel[1]);
    await limitUnauthenticatedRequest(request, env, "device-link", linkId);
    return cancelDeviceLinkBySecret(request, env, linkId);
  }
  const publicDeviceLinkHistoryShard = path.match(/^\/api\/v1\/device-links\/([^/]+)\/history\/shards\/(\d+)$/);
  if (publicDeviceLinkHistoryShard && (request.method === "GET" || request.method === "DELETE")) {
    const linkId = decodeURIComponent(publicDeviceLinkHistoryShard[1]);
    await limitUnauthenticatedRequest(request, env, "device-link", linkId);
    const shardIndex = Number(publicDeviceLinkHistoryShard[2]);
    return request.method === "GET" ? downloadDeviceLinkHistoryShard(request, env, linkId, shardIndex) : acknowledgeDeviceLinkHistoryShard(request, env, linkId, shardIndex);
  }
  if (path === "/api/v1/health" && request.method === "GET") return json({ ok: true, server_name: env.SERVER_NAME, federation: false, protocol: protocolCapabilities(env) });
  if (path.startsWith("/api/v1/operator/")) {
    await limitUnauthenticatedRequest(request, env, "operator", request.headers.get("authorization") ?? "missing");
    await requireOperator(request, env);
    if (path === "/api/v1/operator/readiness" && request.method === "GET") return operatorReadiness(env);
    if (path === "/api/v1/operator/storage" && request.method === "GET") return operatorStorage(url, env);
    if (path === "/api/v1/operator/rooms" && request.method === "GET") return operatorRooms(url, env);
    if (path === "/api/v1/operator/reports" && request.method === "GET") return operatorReports(url, env);
    if (path === "/api/v1/operator/appeals" && request.method === "GET") return operatorAppeals(url, env);
    if (path === "/api/v1/operator/login-locks" && request.method === "GET") return operatorLoginLocks(url, env);
    const reportResolution = path.match(/^\/api\/v1\/operator\/reports\/([^/]+)$/);
    if (reportResolution && request.method === "PUT") return operatorResolveReport(request, env, decodeURIComponent(reportResolution[1]));
    const appealResolution = path.match(/^\/api\/v1\/operator\/appeals\/([^/]+)$/);
    if (appealResolution && request.method === "PUT") return operatorResolveAppeal(request, env, decodeURIComponent(appealResolution[1]));
    if (path === "/api/v1/operator/event-receipt-keys" && request.method === "GET") return json(eventReceiptKeyStatus(env));
    const roomRetention = path.match(/^\/api\/v1\/operator\/rooms\/([^/]+)\/retention$/);
    if (roomRetention && (request.method === "GET" || request.method === "PUT")) {
      const roomId = decodeURIComponent(roomRetention[1]);
      if (!isNamespacedRoomId(roomId)) throw new HttpError(400, "Invalid room ID", "invalid_room");
      return operatorRoomRetention(request, env, roomId);
    }
    const userStorageLimit = path.match(/^\/api\/v1\/operator\/users\/(.+)\/storage-limit$/);
    if (userStorageLimit && (request.method === "PUT" || request.method === "DELETE")) {
      return operatorSetStorageLimit(request, env, decodeURIComponent(userStorageLimit[1]) as UserId, request.method === "DELETE");
    }
    const userLoginUnlock = path.match(/^\/api\/v1\/operator\/users\/(.+)\/login-unlock$/);
    if (userLoginUnlock && request.method === "POST") {
      return operatorUnlockLogin(request, env, decodeURIComponent(userLoginUnlock[1]) as UserId);
    }
    throw new HttpError(404, "Not found", "not_found");
  }
  let auth: AuthContext;
  if (path === "/api/v1/ws" && request.method === "GET") {
    const ticket = url.searchParams.get("ticket");
    if (!ticket) throw new HttpError(401, "WebSocket ticket required", "unauthorized");
    const db = createDatabase(env.DB);
    const ticketHash = await sha256(ticket);
    const row = await db.selectFrom("ws_tickets as wt").innerJoin("devices as d", "d.device_id", "wt.device_id").innerJoin("users as u", "u.user_id", "wt.user_id")
      .select(["wt.user_id", "wt.device_id", "wt.expires_at", "d.revoked_at", "u.deletion_requested_at", "u.deleted_at"]).where("wt.ticket_hash", "=", ticketHash).executeTakeFirst();
    if (!row || row.expires_at < Date.now() || row.revoked_at !== null || row.deletion_requested_at !== null || row.deleted_at !== null) throw new HttpError(401, "WebSocket ticket expired or device revoked", "unauthorized");
    await db.deleteFrom("ws_tickets").where("ticket_hash", "=", ticketHash).execute();
    auth = { userId: row.user_id as UserId, deviceId: row.device_id, actor: "user" };
  } else {
    auth = await authenticate(request, env);
  }
  await limitAuthenticatedRequest(env, auth);
  if (path === "/api/v1/account/deletion" && request.method === "POST") return requestAccountDeletion(request, env, auth);
  if (path === "/api/v1/account/deletion" && request.method === "GET") return accountDeletionStatus(env, auth);
  if (auth.accountDeletionRequested) throw new HttpError(409, "Account deletion is in progress", "account_deletion_pending");
  if (path === "/api/v1/account-removals" && request.method === "GET") return accountRemovalTasks(env, auth);
  if (path === "/api/v1/account/password" && request.method === "PUT") return changePassword(request, env, auth);
  if (path === "/api/v1/passkeys" && request.method === "GET") { requireUser(auth); return listPasskeys(env, auth); }
  if (path === "/api/v1/passkeys/registration/options" && request.method === "POST") { requireUser(auth); return passkeyRegistrationOptions(request, env, auth); }
  if (path === "/api/v1/passkeys" && request.method === "POST") { requireUser(auth); return registerPasskey(request, env, auth); }
  const passkeyDelete = path.match(/^\/api\/v1\/passkeys\/([^/]+)$/);
  if (passkeyDelete && request.method === "DELETE") { requireUser(auth); return deletePasskey(request, env, auth, decodeURIComponent(passkeyDelete[1])); }
  const accountRemovalCommit = path.match(/^\/api\/v1\/account-removals\/([^/]+)\/rooms\/([^/]+)$/);
  if (accountRemovalCommit && request.method === "POST") {
    const roomId = decodeURIComponent(accountRemovalCommit[2]);
    if (!isNamespacedRoomId(roomId)) throw new HttpError(400, "Invalid room ID", "invalid_room");
    return commitAccountRemoval(request, env, auth, decodeURIComponent(accountRemovalCommit[1]), roomId);
  }
  if (path === "/api/v1/me" && request.method === "GET") {
    const user = await createDatabase(env.DB).selectFrom("users").select(["user_id", "display_name", "avatar_id"]).where("user_id", "=", auth.userId).executeTakeFirstOrThrow();
    return json({ user_id: user.user_id, display_name: user.display_name, avatar_url: avatarUrl(user.avatar_id), device_id: auth.deviceId, server_name: env.SERVER_NAME, vapid_public_key: env.VAPID_PUBLIC_KEY, ...sessionCapabilities(env) });
  }
  if (path === "/api/v1/profile" && request.method === "GET") return userProfile(env, auth.userId);
  if (path === "/api/v1/profile" && request.method === "PUT") return updateUserProfile(request, env, auth);
  if (path === "/api/v1/profile/avatar" && request.method === "PUT") return uploadProfileAvatar(request, env, auth);
  if (path === "/api/v1/profile/avatar" && request.method === "DELETE") return deleteProfileAvatar(env, auth);
  if (path === "/api/v1/account/export" && request.method === "GET") return accountExport(env, auth);
  if (path === "/api/v1/account/export/rooms" && request.method === "GET") return accountExportRooms(env, auth, url);
  if (path === "/api/v1/account/export/events" && request.method === "GET") return accountExportEvents(env, auth, url);
  if (path === "/api/v1/account/export/objects" && request.method === "GET") return accountExportObjects(env, auth, url);
  if (path === "/api/v1/account/export/drafts" && request.method === "GET") return accountExportDrafts(env, auth, url);
  if (path === "/api/v1/storage" && request.method === "GET") return storageUsage(env, auth);
  if (path === "/api/v1/peer-recoveries" && request.method === "GET") return listRoomPeerRecoveries(env, auth);
  const peerRecovery = path.match(/^\/api\/v1\/peer-recoveries\/([^/]+)$/);
  if (peerRecovery && request.method === "GET") return roomPeerRecoveryStatus(env, auth, decodeURIComponent(peerRecovery[1]));
  if (peerRecovery && request.method === "DELETE") return cancelRoomPeerRecovery(env, auth, decodeURIComponent(peerRecovery[1]));
  const peerRecoveryClaim = path.match(/^\/api\/v1\/peer-recoveries\/([^/]+)\/claim$/);
  if (peerRecoveryClaim && request.method === "POST") return claimRoomPeerRecovery(env, auth, decodeURIComponent(peerRecoveryClaim[1]));
  const peerRecoveryBundle = path.match(/^\/api\/v1\/peer-recoveries\/([^/]+)\/bundle$/);
  if (peerRecoveryBundle) {
    const recoveryId = decodeURIComponent(peerRecoveryBundle[1]);
    if (request.method === "PUT") return uploadRoomPeerRecovery(request, env, auth, recoveryId, ctx);
    if (request.method === "GET") return downloadRoomPeerRecovery(env, auth, recoveryId);
    if (request.method === "DELETE") return acknowledgeRoomPeerRecovery(env, auth, recoveryId);
  }
  if (path === "/api/v1/privacy" && (request.method === "GET" || request.method === "PUT")) return invitationPolicy(request, env, auth);
  if (path === "/api/v1/bots" && request.method === "GET") return listBots(env, auth);
  if (path === "/api/v1/bots" && request.method === "POST") return createBot(request, env, auth);
  const botDelete = path.match(/^\/api\/v1\/bots\/([^/]+)$/);
  if (botDelete && request.method === "DELETE") return revokeBot(env, auth, decodeURIComponent(botDelete[1]));
  if (path === "/api/v1/devices" && request.method === "GET") { requireUser(auth); return listDevices(env, auth.userId); }
  if (path === "/api/v1/devices" && request.method === "POST") { requireUser(auth); return registerDevice(request, env, auth); }
  const deviceLink = path.match(/^\/api\/v1\/device-links\/([^/]+)$/);
  if (deviceLink && request.method === "GET") return previewDeviceLink(env, auth, decodeURIComponent(deviceLink[1]));
  if (deviceLink && request.method === "POST") return approveDeviceLink(env, auth, decodeURIComponent(deviceLink[1]));
  if (deviceLink && request.method === "DELETE") return cancelDeviceLinkForAccount(env, auth, decodeURIComponent(deviceLink[1]));
  const deviceLinkAccountCredential = path.match(/^\/api\/v1\/device-links\/([^/]+)\/account-credential$/);
  if (deviceLinkAccountCredential && request.method === "PUT") return uploadDeviceLinkAccountCredential(request, env, auth, decodeURIComponent(deviceLinkAccountCredential[1]));
  const deviceLinkHistoryManifest = path.match(/^\/api\/v1\/device-links\/([^/]+)\/history\/manifest$/);
  if (deviceLinkHistoryManifest && request.method === "PUT") return createDeviceLinkHistoryTransfer(request, env, auth, decodeURIComponent(deviceLinkHistoryManifest[1]));
  const deviceLinkHistoryShard = path.match(/^\/api\/v1\/device-links\/([^/]+)\/history\/shards\/(\d+)$/);
  if (deviceLinkHistoryShard && request.method === "PUT") return uploadDeviceLinkHistoryShard(request, env, auth, decodeURIComponent(deviceLinkHistoryShard[1]), Number(deviceLinkHistoryShard[2]));
  const deviceLinkRoom = path.match(/^\/api\/v1\/device-links\/([^/]+)\/rooms\/([^/]+)$/);
  if (deviceLinkRoom && request.method === "POST") {
    const roomId = decodeURIComponent(deviceLinkRoom[2]);
    if (!isNamespacedRoomId(roomId)) throw new HttpError(400, "Invalid room ID", "invalid_room");
    return commitDeviceLinkRoom(request, env, auth, decodeURIComponent(deviceLinkRoom[1]), roomId);
  }
  if (path === "/api/v1/devices/backup-checkpoints" && request.method === "POST") return createBackupCheckpoint(env, auth);
  const deviceDelete = path.match(/^\/api\/v1\/devices\/([^/]+)$/);
  if (deviceDelete && request.method === "DELETE") { requireUser(auth); return revokeDevice(env, auth, decodeURIComponent(deviceDelete[1])); }
  if (path === "/api/v1/device-revocations" && request.method === "GET") { requireUser(auth); return listDeviceRevocations(env, auth); }
  const deviceRevocationPrepare = path.match(/^\/api\/v1\/devices\/([^/]+)\/revocations$/);
  if (deviceRevocationPrepare && request.method === "POST") { requireUser(auth); return prepareDeviceRevocation(env, auth, decodeURIComponent(deviceRevocationPrepare[1])); }
  const deviceRevocationCommit = path.match(/^\/api\/v1\/device-revocations\/([^/]+)\/rooms\/([^/]+)$/);
  if (deviceRevocationCommit && request.method === "POST") {
    requireUser(auth);
    const roomId = decodeURIComponent(deviceRevocationCommit[2]);
    if (!isNamespacedRoomId(roomId)) throw new HttpError(400, "Invalid room ID", "invalid_room");
    return commitDeviceRevocation(request, env, auth, decodeURIComponent(deviceRevocationCommit[1]), roomId);
  }
  const userDevices = path.match(/^\/api\/v1\/users\/(.+)\/devices$/);
  if (userDevices && request.method === "GET") { requireUser(auth); const userId = decodeURIComponent(userDevices[1]); assertLocalId(userId, "@", env); return listDevices(env, userId); }
  const publicUserProfile = path.match(/^\/api\/v1\/users\/(.+)\/profile$/);
  if (publicUserProfile && request.method === "GET") { requireUser(auth); return userProfile(env, decodeURIComponent(publicUserProfile[1]) as UserId); }
  const userBlock = path.match(/^\/api\/v1\/users\/(.+)\/block$/);
  if (userBlock && (request.method === "PUT" || request.method === "DELETE")) {
    const userId = decodeURIComponent(userBlock[1]) as UserId;
    return setUserBlock(env, auth, userId, request.method === "PUT");
  }
  const roomPeerRecovery = path.match(/^\/api\/v1\/rooms\/([^/]+)\/peer-recovery$/);
  if (roomPeerRecovery && request.method === "POST") {
    const roomId = decodeURIComponent(roomPeerRecovery[1]);
    if (!isNamespacedRoomId(roomId)) throw new HttpError(400, "Invalid room ID", "invalid_room");
    return createRoomPeerRecovery(request, env, auth, roomId, ctx);
  }
  if (path === "/api/v1/users" && request.method === "GET") {
    requireUser(auth);
    const q = (url.searchParams.get("q") ?? "").trim();
    const db = createDatabase(env.DB);
    const blockRows = q.length < 2 ? [] : await db.selectFrom("user_blocks").select(["blocker_user_id", "blocked_user_id"])
      .where((eb) => eb.or([eb("blocker_user_id", "=", auth.userId), eb("blocked_user_id", "=", auth.userId)])).execute();
    const hidden = new Set(blockRows.map((row) => row.blocker_user_id === auth.userId ? row.blocked_user_id : row.blocker_user_id));
    let usersQuery = db.selectFrom("users").select(["user_id", "display_name", "avatar_id"]).where("user_id", "!=", auth.userId)
      .where("deletion_requested_at", "is", null)
      .where("deleted_at", "is", null)
      .where((eb) => eb.or([eb("localpart", "like", `${q}%`), eb("display_name", "like", `%${q}%`)]));
    if (hidden.size) usersQuery = usersQuery.where("user_id", "not in", [...hidden]);
    const users = q.length < 2 ? [] : (await usersQuery.limit(20).execute()).map(({ avatar_id, ...user }) => ({ ...user, avatar_url: avatarUrl(avatar_id) }));
    return json({ users });
  }
  if (path === "/api/v1/rooms" && request.method === "GET") return listRooms(env, auth);
  if (path === "/api/v1/rooms" && request.method === "POST") return createRoom(request, env, auth);
  if (path === "/api/v1/room-leave-tasks" && request.method === "GET") return roomLeaveTasks(env, auth);
  if (path === "/api/v1/drafts" && request.method === "GET") return encryptedDrafts(url, env, auth);
  if (path === "/api/v1/mls/key-packages" && request.method === "GET") return keyPackageStatus(env, auth);
  if (path === "/api/v1/mls/key-packages" && request.method === "POST") return uploadKeyPackages(request, env, auth);
  if (path === "/api/v1/mls/key-packages/claim" && request.method === "POST") return claimMlsKeyPackages(request, env, auth);
  const roomMatch = path.match(/^\/api\/v1\/rooms\/([^/]+)$/);
  if (roomMatch && request.method === "GET") { const id = decodeURIComponent(roomMatch[1]); if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room"); requireBotRoom(auth, id); return getRoom(env, auth, id); }
  const roomLeave = path.match(/^\/api\/v1\/rooms\/([^/]+)\/leave$/);
  if (roomLeave && (request.method === "POST" || request.method === "DELETE")) {
    const id = decodeURIComponent(roomLeave[1]); if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room");
    return setRoomLeaveRequest(env, auth, id, request.method === "POST", ctx);
  }
  const roomDevices = path.match(/^\/api\/v1\/rooms\/([^/]+)\/devices$/);
  if (roomDevices && request.method === "GET") { requireUser(auth); const id = decodeURIComponent(roomDevices[1]); if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room"); return listRoomDevices(env, auth, id); }
  const roomSigningKeys = path.match(/^\/api\/v1\/rooms\/([^/]+)\/signing-keys$/);
  if (roomSigningKeys && request.method === "GET") { requireUser(auth); const id = decodeURIComponent(roomSigningKeys[1]); if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room"); return listRoomSigningKeys(env, auth, id); }
  const roomPreference = path.match(/^\/api\/v1\/rooms\/([^/]+)\/preferences$/);
  if (roomPreference && request.method === "PUT") { const id = decodeURIComponent(roomPreference[1]); if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room"); return setRoomNotificationPreference(request, env, auth, id); }
  const hiddenMember = path.match(/^\/api\/v1\/rooms\/([^/]+)\/hidden-members\/(.+)$/);
  if (hiddenMember && (request.method === "PUT" || request.method === "DELETE")) {
    const id = decodeURIComponent(hiddenMember[1]); const userId = decodeURIComponent(hiddenMember[2]) as UserId;
    if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room");
    return setGroupMemberHidden(env, auth, id, userId, request.method === "PUT");
  }
  const roomRequestAccept = path.match(/^\/api\/v1\/rooms\/([^/]+)\/request\/accept$/);
  if (roomRequestAccept && request.method === "POST") { const id = decodeURIComponent(roomRequestAccept[1]); if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room"); return resolveMessageRequest(env, auth, id, "accepted"); }
  const roomRequest = path.match(/^\/api\/v1\/rooms\/([^/]+)\/request$/);
  if (roomRequest && request.method === "DELETE") { const id = decodeURIComponent(roomRequest[1]); if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room"); return resolveMessageRequest(env, auth, id, "rejected"); }
  const roomReport = path.match(/^\/api\/v1\/rooms\/([^/]+)\/report$/);
  if (roomReport && request.method === "POST") { const id = decodeURIComponent(roomReport[1]); if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room"); return reportMessageRequest(request, env, auth, id); }
  const roomDraft = path.match(/^\/api\/v1\/rooms\/([^/]+)\/draft$/);
  if (roomDraft && request.method === "PUT") { const id = decodeURIComponent(roomDraft[1]); if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room"); return putEncryptedDraft(request, env, auth, id); }
  const memberAdd = path.match(/^\/api\/v1\/rooms\/([^/]+)\/members$/);
  if (memberAdd && request.method === "POST") {
    requireUser(auth);
    const id = decodeURIComponent(memberAdd[1]); if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room");
    const body = await readJson(request, 512_000); const userId = stringField(body, "user_id", 128) as UserId;
    return changeMember(body, env, auth, id, userId, false);
  }
  const memberRemove = path.match(/^\/api\/v1\/rooms\/([^/]+)\/members\/(.+)$/);
  if (memberRemove && request.method === "DELETE") {
    requireUser(auth);
    const id = decodeURIComponent(memberRemove[1]); const userId = decodeURIComponent(memberRemove[2]) as UserId;
    if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room");
    return changeMember(await readJson(request, 512_000), env, auth, id, userId, true);
  }
  const eventMatch = path.match(/^\/api\/v1\/rooms\/([^/]+)\/events$/);
  if (eventMatch && request.method === "POST") { const id = decodeURIComponent(eventMatch[1]); if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room"); requireBotRoom(auth, id); return sendEvent(request, env, ctx, auth, id); }
  const historyMatch = path.match(/^\/api\/v1\/rooms\/([^/]+)\/history$/);
  if (historyMatch && request.method === "GET") { const id = decodeURIComponent(historyMatch[1]); if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room"); requireBotRoom(auth, id); return history(url, env, auth, id); }
  const archivePlanMatch = path.match(/^\/api\/v1\/rooms\/([^/]+)\/archive-plan$/);
  if (archivePlanMatch && request.method === "GET") { requireUser(auth); const id = decodeURIComponent(archivePlanMatch[1]); if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room"); return archivePlan(url, env, auth, id); }
  const repairLease = path.match(/^\/api\/v1\/rooms\/([^/]+)\/repair\/lease$/);
  if (repairLease && (request.method === "POST" || request.method === "DELETE")) {
    const id = decodeURIComponent(repairLease[1]); if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room");
    return request.method === "POST" ? acquireRepairLease(request, env, auth, id) : releaseRepairLease(request, env, auth, id);
  }
  const repairUpload = path.match(/^\/api\/v1\/rooms\/([^/]+)\/repair\/events$/);
  if (repairUpload && request.method === "POST") {
    const id = decodeURIComponent(repairUpload[1]); if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room");
    return uploadRepairEvents(request, env, auth, id);
  }
  if (path === "/api/v1/retention/coverage" && (request.method === "GET" || request.method === "POST")) {
    requireUser(auth);
    return retentionCoverage(request, env, auth);
  }
  if (path === "/api/v1/repair/jobs" && request.method === "GET") return historyRepairJobs(request, env, auth);
  const compactionLease = path.match(/^\/api\/v1\/rooms\/([^/]+)\/compaction\/lease$/);
  if (compactionLease && (request.method === "POST" || request.method === "DELETE")) {
    requireUser(auth);
    const id = decodeURIComponent(compactionLease[1]); if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room");
    return request.method === "POST" ? acquireCompactionLease(env, auth, id) : releaseCompactionLease(request, env, auth, id);
  }
  const segmentUpload = path.match(/^\/api\/v1\/rooms\/([^/]+)\/segments$/);
  if (segmentUpload && request.method === "POST") { requireUser(auth); const id = decodeURIComponent(segmentUpload[1]); if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room"); return uploadSegment(request, env, auth, id); }
  const segmentUploadCancellation = path.match(/^\/api\/v1\/rooms\/([^/]+)\/segments\/([^/]+)\/upload$/);
  if (segmentUploadCancellation && request.method === "DELETE") {
    requireUser(auth); const roomId = decodeURIComponent(segmentUploadCancellation[1]); const segmentId = segmentUploadCancellation[2];
    if (!isNamespacedRoomId(roomId)) throw new HttpError(400, "Invalid room ID", "invalid_room");
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(segmentId)) throw new HttpError(400, "Invalid segment ID", "invalid_segment");
    return cancelArchiveSegmentUpload(request, env, auth, roomId, segmentId);
  }
  if (path === "/api/v1/archive-repair/jobs" && request.method === "GET") { requireUser(auth); return archiveRepairJobs(request, env, auth); }
  const archiveRepairLease = path.match(/^\/api\/v1\/archive-segments\/([^/]+)\/repair\/lease$/);
  if (archiveRepairLease && (request.method === "POST" || request.method === "DELETE")) {
    requireUser(auth); const id = archiveRepairLease[1];
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) throw new HttpError(400, "Invalid segment ID", "invalid_segment");
    return request.method === "POST" ? acquireArchiveRepairLease(env, auth, id) : releaseArchiveRepairLease(request, env, auth, id);
  }
  const archiveRepairUpload = path.match(/^\/api\/v1\/archive-segments\/([^/]+)\/repair$/);
  if (archiveRepairUpload && request.method === "PUT") {
    requireUser(auth); const id = archiveRepairUpload[1];
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) throw new HttpError(400, "Invalid segment ID", "invalid_segment");
    return uploadArchiveRepair(request, env, auth, id);
  }
  const archiveRetentionAck = path.match(/^\/api\/v1\/archive-segments\/([^/]+)\/retention-ack$/);
  if (archiveRetentionAck && request.method === "POST") {
    requireUser(auth); const id = archiveRetentionAck[1];
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) throw new HttpError(400, "Invalid segment ID", "invalid_segment");
    return acknowledgeArchiveSegmentRetention(env, auth, id);
  }
  const segmentGet = path.match(/^\/api\/v1\/rooms\/([^/]+)\/segments\/([^/]+)$/);
  if (segmentGet && request.method === "GET") { requireUser(auth); const id = decodeURIComponent(segmentGet[1]); if (!isNamespacedRoomId(id)) throw new HttpError(400, "Invalid room ID", "invalid_room"); return downloadSegment(request, env, auth, id, segmentGet[2]); }
  if (path === "/api/v1/sync" && request.method === "GET") return sync(url, env, auth);
  if (path === "/api/v1/ws-ticket" && request.method === "POST") {
    requireUser(auth);
    const ticket = randomId(24);
    await createDatabase(env.DB).insertInto("ws_tickets").values({ ticket_hash: await sha256(ticket), user_id: auth.userId, device_id: auth.deviceId, expires_at: Date.now() + 60_000 }).execute();
    return json({ ticket, expires_at: Date.now() + 60_000 }, 201);
  }
  if (path === "/api/v1/attachments" && request.method === "POST") { requireUser(auth); return uploadAttachment(request, env, auth); }
  if (path === "/api/v1/attachments/abandon" && request.method === "POST") { requireUser(auth); return abandonAttachments(request, env, auth); }
  if (path === "/api/v1/attachment-repair/jobs" && request.method === "GET") { requireUser(auth); return attachmentRepairJobs(request, env, auth); }
  const attachmentRepairLease = path.match(/^\/api\/v1\/attachments\/([^/]+)\/repair\/lease$/);
  if (attachmentRepairLease && (request.method === "POST" || request.method === "DELETE")) {
    requireUser(auth); const id = attachmentRepairLease[1];
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) throw new HttpError(400, "Invalid attachment ID", "invalid_attachment");
    return request.method === "POST" ? acquireAttachmentRepairLease(env, auth, id) : releaseAttachmentRepairLease(request, env, auth, id);
  }
  const attachmentRepairUpload = path.match(/^\/api\/v1\/attachments\/([^/]+)\/repair$/);
  if (attachmentRepairUpload && request.method === "PUT") {
    requireUser(auth); const id = attachmentRepairUpload[1];
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) throw new HttpError(400, "Invalid attachment ID", "invalid_attachment");
    return uploadAttachmentRepair(request, env, auth, id);
  }
  const attachmentRetentionAck = path.match(/^\/api\/v1\/attachments\/([^/]+)\/retention-ack$/);
  if (attachmentRetentionAck && request.method === "POST") { requireUser(auth); return acknowledgeAttachmentRetention(env, auth, attachmentRetentionAck[1]); }
  const attachmentGet = path.match(/^\/api\/v1\/attachments\/([^/]+)$/);
  if (attachmentGet && request.method === "GET") { requireUser(auth); return downloadAttachment(request, env, auth, attachmentGet[1]); }
  if (path === "/api/v1/push/subscribe" && request.method === "POST") { requireUser(auth); return pushSubscribe(request, env, auth); }
  if (path === "/api/v1/push/subscription" && request.method === "GET") {
    requireUser(auth);
    const row = await createDatabase(env.DB).selectFrom("push_subscriptions").select("endpoint").where("device_id", "=", auth.deviceId).executeTakeFirst();
    return json({ subscribed: Boolean(row), endpoint: row?.endpoint ?? null });
  }
  if (path === "/api/v1/push/subscribe" && request.method === "DELETE") { requireUser(auth); await createDatabase(env.DB).deleteFrom("push_subscriptions").where("device_id", "=", auth.deviceId).execute(); return new Response(null, { status: 204 }); }
  if (path === "/api/v1/ws" && request.method === "GET") {
    const roomId = url.searchParams.get("room_id");
    if (!roomId || !isNamespacedRoomId(roomId) || !(await memberRole(env, roomId, auth.userId))) throw new HttpError(403, "Room membership required", "forbidden");
    if (await directRoomBlocked(env, roomId)) throw new HttpError(403, "Conversation is unavailable", "direct_unavailable");
    const requestState = await directRequestState(env, roomId);
    if (requestState?.status === "rejected") throw new HttpError(403, "Message request was rejected", "message_request_rejected");
    const headers = new Headers(request.headers); headers.set("x-edgechat-user", auth.userId); headers.set("x-edgechat-device", auth.deviceId);
    if (requestState?.status === "pending") headers.set("x-edgechat-allow-typing", "false");
    if (requestState?.status !== "pending" && url.searchParams.get("presence") === "1") headers.set("x-edgechat-share-presence", "true");
    return env.ROOMS.getByName(roomId).fetch(new Request(request, { headers }));
  }
  throw new HttpError(404, "Not found", "not_found");
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const isApi = new URL(request.url).pathname.startsWith("/api/");
    try {
      if (isApi) assertClientProtocol(request);
      const response = await route(request, env, ctx);
      return isApi ? hardenApiResponse(response, protocolResponseHeaders()) : response;
    }
    catch (error) {
      if (error instanceof HttpError) return hardenApiResponse(json({ error: error.message, code: error.code }, error.status, error.headers), protocolResponseHeaders());
      if (isApi && isDatabaseSchemaMismatch(error)) {
        console.error(JSON.stringify({ message: "database schema upgrade required", path: new URL(request.url).pathname }));
        return hardenApiResponse(json({ error: "Server database schema must be upgraded", code: "server_upgrade_required" }, 503), protocolResponseHeaders());
      }
      console.error(JSON.stringify({ message: "request failed", path: new URL(request.url).pathname, error: error instanceof Error ? error.message : String(error) }));
      return hardenApiResponse(json({ error: "Internal server error", code: "internal_error" }, 500), protocolResponseHeaders());
    }
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(Promise.all([
      purgeUncommittedAttachments(env).then((count) => {
        if (count) console.log(JSON.stringify({ message: "purged uncommitted attachments", count }));
      }),
      processPendingAttachmentDeletions(env).then((count) => {
        if (count) console.log(JSON.stringify({ message: "deleted attachments for message tombstones", count }));
      }),
      processPendingR2Writes(env).then((count) => {
        if (count) console.log(JSON.stringify({ message: "deleted abandoned R2 writes", count }));
      }),
      processProfileAvatarDeletions(env).then((count) => {
        if (count) console.log(JSON.stringify({ message: "deleted replaced profile avatars", count }));
      }),
      cleanupExpiredKeyPackages(env).then((count) => {
        if (count) console.log(JSON.stringify({ message: "deleted expired MLS KeyPackages", count }));
      }),
      cleanupMessageRequestRateWindows(env).then((count) => {
        if (count) console.log(JSON.stringify({ message: "deleted expired message request rate windows", count }));
      }),
      cleanupLoginFailureState(env).then((count) => {
        if (count) console.log(JSON.stringify({ message: "deleted expired login failure state", count }));
      }),
      cleanupAccountAppeals(env).then((count) => {
        if (count) console.log(JSON.stringify({ message: "deleted expired account appeals", count }));
      }),
      cleanupExpiredDeviceLinks(env).then((count) => {
        if (count) console.log(JSON.stringify({ message: "cleaned expired device links", count }));
      }),
      cleanupExpiredDeviceSessionChallenges(env).then((count) => {
        if (count) console.log(JSON.stringify({ message: "cleaned expired device session challenges", count }));
      }),
      cleanupExpiredAuthenticationState(env).then((count) => {
        if (count.sessions || count.ws_tickets) console.log(JSON.stringify({ message: "cleaned expired authentication state", ...count }));
      }),
      cleanupExpiredPasskeyChallenges(env).then((count) => {
        if (count) console.log(JSON.stringify({ message: "cleaned expired passkey challenges", count }));
      }),
      cleanupExpiredRoomPeerRecoveries(env).then((count) => {
        if (count) console.log(JSON.stringify({ message: "cleaned expired peer recoveries", count }));
      }),
      auditRoomHistory(env).then((result) => {
        if (result.gaps) console.log(JSON.stringify({ message: "detected repairable room history gaps", ...result }));
      }),
      processAccountDeletions(env).then((count) => {
        if (count) console.log(JSON.stringify({ message: "processed account deletion jobs", count }));
      }),
      processRoomRetention(env).then(async (result) => {
        const stagedObjects = await stageRetentionObjectDeletions(env);
        const deletedObjects = await processRetentionObjectDeletions(env);
        if (result.events || stagedObjects || deletedObjects) console.log(JSON.stringify({
          message: "applied room retention", ...result, staged_objects: stagedObjects, deleted_objects: deletedObjects,
        }));
      }),
    ]).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
