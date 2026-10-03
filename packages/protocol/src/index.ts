export const API_VERSION = "v1" as const;
export const PROTOCOL_VERSION = 1 as const;
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1 as const;
export const MAX_ATTACHMENT_PLAINTEXT_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 10;
export const MAX_MESSAGE_ATTACHMENT_PLAINTEXT_BYTES = 100 * 1024 * 1024;

export const serverProtocolFeatures = ["attachments.multi.v1", "history.repair.v1", "attachments.repair.v1", "archive.repair.v1", "room.peer-recovery.v1", "drafts.e2ee.v1", "message-requests.v1", "groups.hidden-members.v1", "messages.expiry.v1", "messages.contact.v1", "rooms.profile.v1", "rooms.leave.v1", "rooms.owner-transfer.v1", "account.password-change.v1"] as const;
export type ServerProtocolFeature = typeof serverProtocolFeatures[number];
export type ServerProtocolCapabilities = {
  version: number;
  minimum_client_version: number;
  features: string[];
  limits: {
    max_attachments_per_message: number;
    max_attachment_plaintext_bytes: number;
    max_message_attachment_plaintext_bytes: number;
  };
};

const legacyServerProtocol: ServerProtocolCapabilities = {
  version: 1,
  minimum_client_version: 1,
  features: [],
  limits: {
    max_attachments_per_message: 1,
    max_attachment_plaintext_bytes: MAX_ATTACHMENT_PLAINTEXT_BYTES,
    max_message_attachment_plaintext_bytes: MAX_ATTACHMENT_PLAINTEXT_BYTES,
  },
};

export const currentServerProtocol: ServerProtocolCapabilities = {
  version: PROTOCOL_VERSION,
  minimum_client_version: MIN_SUPPORTED_PROTOCOL_VERSION,
  features: [...serverProtocolFeatures],
  limits: {
    max_attachments_per_message: MAX_MESSAGE_ATTACHMENTS,
    max_attachment_plaintext_bytes: MAX_ATTACHMENT_PLAINTEXT_BYTES,
    max_message_attachment_plaintext_bytes: MAX_MESSAGE_ATTACHMENT_PLAINTEXT_BYTES,
  },
};

/** Missing capabilities mean a pre-negotiation v1 server, never the newest feature set. */
export function normalizeServerProtocol(value: unknown): ServerProtocolCapabilities {
  if (value === undefined || value === null) return structuredClone(legacyServerProtocol);
  if (!value || typeof value !== "object") throw new Error("Invalid server protocol capabilities");
  const protocol = value as Partial<ServerProtocolCapabilities>;
  const limits = protocol.limits as Partial<ServerProtocolCapabilities["limits"]> | undefined;
  if (!Number.isSafeInteger(protocol.version) || Number(protocol.version) < 1
    || !Number.isSafeInteger(protocol.minimum_client_version) || Number(protocol.minimum_client_version) < 1
    || Number(protocol.minimum_client_version) > Number(protocol.version)
    || !Array.isArray(protocol.features) || protocol.features.length > 64
    || protocol.features.some((feature) => typeof feature !== "string" || feature.length < 1 || feature.length > 64)
    || new Set(protocol.features).size !== protocol.features.length
    || !limits
    || !Number.isSafeInteger(limits.max_attachments_per_message) || Number(limits.max_attachments_per_message) < 1 || Number(limits.max_attachments_per_message) > MAX_MESSAGE_ATTACHMENTS
    || !Number.isSafeInteger(limits.max_attachment_plaintext_bytes) || Number(limits.max_attachment_plaintext_bytes) < 1 || Number(limits.max_attachment_plaintext_bytes) > MAX_ATTACHMENT_PLAINTEXT_BYTES
    || !Number.isSafeInteger(limits.max_message_attachment_plaintext_bytes) || Number(limits.max_message_attachment_plaintext_bytes) < 1 || Number(limits.max_message_attachment_plaintext_bytes) > MAX_MESSAGE_ATTACHMENT_PLAINTEXT_BYTES) {
    throw new Error("Invalid server protocol capabilities");
  }
  return {
    version: Number(protocol.version), minimum_client_version: Number(protocol.minimum_client_version),
    features: [...protocol.features],
    limits: {
      max_attachments_per_message: Number(limits.max_attachments_per_message),
      max_attachment_plaintext_bytes: Number(limits.max_attachment_plaintext_bytes),
      max_message_attachment_plaintext_bytes: Number(limits.max_message_attachment_plaintext_bytes),
    },
  };
}

export function assertCompatibleServerProtocol(value: unknown): ServerProtocolCapabilities {
  const protocol = normalizeServerProtocol(value);
  if (protocol.minimum_client_version > PROTOCOL_VERSION) throw new Error("此服务器需要更新版本的客户端");
  if (protocol.version < MIN_SUPPORTED_PROTOCOL_VERSION) throw new Error("此服务器版本过旧，请先升级服务器");
  return protocol;
}

export function serverSupports(protocol: ServerProtocolCapabilities | undefined, feature: ServerProtocolFeature): boolean {
  return normalizeServerProtocol(protocol).features.includes(feature);
}

export type UserId = `@${string}:${string}`;
export type RoomId = `!${string}:${string}`;
export type DeviceId = string;
export type EventId = `$${string}:${string}`;
export type MessageId = `$${string}:${string}`;
export type AttachmentId = string;
export type MessagePartId = string;

export type MessageReference = {
  kind: "message";
  message_id: MessageId;
  room_id: RoomId;
};

export type MessageDeletePayload = {
  version: 1;
  kind: "message.delete";
  target: MessageReference;
  deleted_at: number;
};

export type MessageEditPayload = {
  version: 1;
  kind: "message.edit";
  target: MessageReference;
  text: string;
  edited_at: number;
};

export type MessageReactionPayload = {
  version: 1;
  kind: "message.reaction";
  target: MessageReference;
  reaction: string | null;
  updated_at: number;
};

export type ReadReceiptPayload = {
  version: 1;
  kind: "receipt.read";
  room_id: RoomId;
  up_to_seq: number;
  read_at: number;
};

export type DeliveryReceiptPayload = {
  version: 1;
  kind: "receipt.delivered";
  room_id: RoomId;
  up_to_seq: number;
  delivered_at: number;
};

export const MESSAGE_EXPIRY_OPTIONS_SECONDS = [3_600, 86_400, 604_800, 2_592_000] as const;
export type MessageExpirySeconds = typeof MESSAGE_EXPIRY_OPTIONS_SECONDS[number];
export type MessageExpiryPolicyPayload = {
  version: 1;
  kind: "room.message-expiry";
  expires_in_seconds: MessageExpirySeconds | null;
  updated_at: number;
};

export type RoomProfilePayload = {
  version: 1;
  kind: "room.profile";
  name: string;
  avatar: RoomProfileAvatar | null;
  updated_at: number;
};

export type RoomOwnerTransferPayload = {
  version: 1;
  kind: "room.owner-transfer";
  target_user_id: UserId;
  updated_at: number;
};

export type RoomProfileAvatar = {
  attachment_id: AttachmentId;
  mime_type: "image/webp";
  plaintext_bytes: number;
  key: string;
  nonce: string;
};

export const roomEventTypes = [
  "message.text", "message.file", "message.contact", "message.delete", "message.edit", "message.reaction",
  "control.member.add", "control.member.remove", "control.device.add",
  "control.device.revoke", "control.key.update", "control.group.commit", "control.message-expiry", "control.room.profile", "control.owner.transfer",
  "receipt.read", "receipt.delivered", "typing.start", "typing.stop",
] as const;
export type RoomEventType = typeof roomEventTypes[number];

const mlsMembershipCommitEventTypes: readonly RoomEventType[] = [
  "control.group.commit", "control.device.add", "control.device.revoke",
];

/** Events that advance the MLS group epoch and therefore cannot be skipped. */
export function isMlsMembershipCommitEventType(value: unknown): value is "control.group.commit" | "control.device.add" | "control.device.revoke" {
  return typeof value === "string" && mlsMembershipCommitEventTypes.includes(value as RoomEventType);
}

export type ClientEvent = {
  event_id: EventId;
  room_id: RoomId;
  sender: UserId;
  device_id: DeviceId;
  type: RoomEventType;
  created_at: number;
  ciphertext: string;
  metadata: Record<string, string | number | boolean | null | string[]>;
  signature: string;
};

export type EventAcceptanceReceipt = {
  version: 1;
  key_id: string;
  room_id: RoomId;
  seq: number;
  event_id: EventId;
  event_hash: string;
  retention_generation: number;
  accepted_at: number;
  mac: string;
};

export type RoomEvent = ClientEvent & { seq: number; acceptance_receipt?: EventAcceptanceReceipt };

export type Device = {
  device_id: DeviceId;
  user_id: UserId;
  display_name: string;
  signing_key: JsonWebKey;
  encryption_key: JsonWebKey;
  created_at: number;
  revoked_at: number | null;
};

export type UserProfile = {
  user_id: UserId;
  display_name: string;
  bio: string;
  avatar_url: string | null;
};

export type DraftEnvelope = {
  version: 1;
  room_id: RoomId;
  source_device_id: string;
  target_device_id: string;
  client_updated_at: number;
  ephemeral_key: JsonWebKey;
  salt: string;
  nonce: string;
  ciphertext: string;
  signature: string;
};

export type DraftEnvelopeRecord = DraftEnvelope & { server_updated_at: number };

export type RoomSummary = {
  room_id: RoomId;
  name: string | null;
  kind: "direct" | "group";
  purpose: "chat" | "saved";
  current_seq: number;
  created_at: number;
  members: Array<{ user_id: UserId; display_name: string; avatar_url: string | null; role: "owner" | "member" }>;
  hidden_member_ids: UserId[];
  request_status: "pending" | "accepted" | "rejected" | null;
  request_role: "requester" | "recipient" | null;
  request_message_sent: boolean;
};

export type SyncItem = {
  cursor: number;
  kind: "room.event" | "device.event" | "room.event.available";
  room_id: RoomId | null;
  seq: number | null;
  payload: RoomEvent | Record<string, unknown>;
};

export type SyncResponse = {
  next_cursor: number;
  has_more: boolean;
  items: SyncItem[];
};

export type ClientSocketFrame =
  | { type: "ping" }
  | { type: "typing"; active: boolean };

export type TypingSocketFrame = {
  type: "typing";
  room_id: RoomId;
  user_id: UserId;
  connection_id: string;
  active: boolean;
  expires_at: number;
};

export type PresenceSocketFrame = {
  type: "presence";
  room_id: RoomId;
  user_id: UserId;
  active: boolean;
};

export type PresenceSnapshotSocketFrame = {
  type: "presence.snapshot";
  room_id: RoomId;
  user_ids: UserId[];
};

export type SocketFrame =
  | { type: "ready"; room_id: RoomId; current_seq: number }
  | { type: "room.event"; room_id: RoomId; seq: number; event: RoomEvent }
  | { type: "history.repair.available"; room_id: RoomId; start_seq: number; end_seq: number }
  | { type: "attachment.repair.available"; room_id: RoomId; attachment_id: string }
  | { type: "archive.repair.available"; room_id: RoomId; segment_id: string }
  | TypingSocketFrame
  | PresenceSocketFrame
  | PresenceSnapshotSocketFrame
  | { type: "ping"; at: number }
  | { type: "error"; code: string };

export interface FederationTransport {
  sendRoomEvent(event: RoomEvent): Promise<void>;
  sendControlEvent(event: RoomEvent): Promise<void>;
  resolveRemoteUser(userId: UserId): Promise<never>;
}

export class LocalFederationTransport implements FederationTransport {
  constructor(private readonly localDomain: string) {}
  async sendRoomEvent(event: RoomEvent): Promise<void> { this.assertLocal(event.room_id.slice(event.room_id.lastIndexOf(":") + 1)); }
  async sendControlEvent(event: RoomEvent): Promise<void> { return this.sendRoomEvent(event); }
  async resolveRemoteUser(userId: UserId): Promise<never> {
    const domain = userId.slice(userId.lastIndexOf(":") + 1);
    throw new Error(domain === this.localDomain ? "Local users resolve through D1" : "Federation is disabled in Phase 1");
  }
  private assertLocal(domain: string): void { if (domain !== this.localDomain) throw new Error("Federation is disabled in Phase 1"); }
}

export function isNamespacedUserId(value: string): value is UserId {
  return /^@[a-z0-9_][a-z0-9_.-]{1,30}:[a-z0-9.-]+$/i.test(value);
}
export function isNamespacedRoomId(value: string): value is RoomId {
  return /^![A-Za-z0-9_-]{16,}:[a-z0-9.-]+$/i.test(value);
}
export function isNamespacedEventId(value: string): value is EventId {
  return /^\$[A-Za-z0-9_-]{8,}:[a-z0-9.-]+$/i.test(value);
}
export function isNamespacedMessageId(value: string): value is MessageId {
  return isNamespacedEventId(value);
}

function isEventMetadata(value: unknown): value is ClientEvent["metadata"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 64) return false;
  return entries.every(([key, item]) => key.length > 0 && key.length <= 96 && (
    item === null || typeof item === "boolean"
    || (typeof item === "number" && Number.isSafeInteger(item))
    || (typeof item === "string" && item.length <= 4_096)
    || (Array.isArray(item) && item.length <= 128 && item.every((entry) => typeof entry === "string" && entry.length <= 256))
  ));
}

export function isClientEventEnvelope(value: unknown): value is ClientEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<ClientEvent>;
  if (typeof event.event_id !== "string" || event.event_id.length > 96 || !isNamespacedEventId(event.event_id)
    || typeof event.room_id !== "string" || event.room_id.length > 255 || !isNamespacedRoomId(event.room_id)
    || typeof event.sender !== "string" || event.sender.length > 255 || !isNamespacedUserId(event.sender)
    || typeof event.device_id !== "string" || event.device_id.length < 1 || event.device_id.length > 96
    || !roomEventTypes.includes(event.type as RoomEventType)
    || !Number.isSafeInteger(event.created_at) || Number(event.created_at) < 0
    || typeof event.ciphertext !== "string" || event.ciphertext.length > 200_000
    || typeof event.signature !== "string" || event.signature.length < 1 || event.signature.length > 1_024
    || !isEventMetadata(event.metadata)) return false;
  return true;
}

export function isRoomEventEnvelope(value: unknown): value is RoomEvent {
  if (!isClientEventEnvelope(value)) return false;
  const event = value as RoomEvent;
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) return false;
  if (event.acceptance_receipt === undefined) return true;
  const receipt = event.acceptance_receipt as Partial<EventAcceptanceReceipt>;
  return receipt.version === 1 && receipt.room_id === event.room_id && receipt.event_id === event.event_id && receipt.seq === event.seq
    && typeof receipt.key_id === "string" && receipt.key_id.length > 0 && receipt.key_id.length <= 64
    && typeof receipt.event_hash === "string" && receipt.event_hash.length > 0 && receipt.event_hash.length <= 1_024
    && Number.isSafeInteger(receipt.retention_generation) && Number(receipt.retention_generation) >= 1
    && Number.isSafeInteger(receipt.accepted_at) && Number(receipt.accepted_at) >= 0
    && typeof receipt.mac === "string" && receipt.mac.length > 0 && receipt.mac.length <= 1_024;
}

export function isMessageDeletePayload(value: unknown): value is MessageDeletePayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<MessageDeletePayload>;
  return payload.version === 1 && payload.kind === "message.delete" && Number.isFinite(payload.deleted_at)
    && Boolean(payload.target && payload.target.kind === "message" && isNamespacedMessageId(payload.target.message_id)
      && isNamespacedRoomId(payload.target.room_id));
}
export function isMessageEditPayload(value: unknown): value is MessageEditPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<MessageEditPayload>;
  return payload.version === 1 && payload.kind === "message.edit" && typeof payload.text === "string" && payload.text.length <= 16_000
    && Number.isFinite(payload.edited_at) && Boolean(payload.target && payload.target.kind === "message"
      && isNamespacedMessageId(payload.target.message_id) && isNamespacedRoomId(payload.target.room_id));
}
export function isMessageReactionPayload(value: unknown): value is MessageReactionPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<MessageReactionPayload>;
  return payload.version === 1 && payload.kind === "message.reaction" && (payload.reaction === null
    || (typeof payload.reaction === "string" && Array.from(payload.reaction).length >= 1 && Array.from(payload.reaction).length <= 8))
    && Number.isFinite(payload.updated_at) && Boolean(payload.target && payload.target.kind === "message"
      && isNamespacedMessageId(payload.target.message_id) && isNamespacedRoomId(payload.target.room_id));
}
export function isReadReceiptPayload(value: unknown): value is ReadReceiptPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<ReadReceiptPayload>;
  return payload.version === 1 && payload.kind === "receipt.read" && isNamespacedRoomId(payload.room_id ?? "")
    && Number.isSafeInteger(payload.up_to_seq) && Number(payload.up_to_seq) > 0 && Number.isFinite(payload.read_at);
}
export function isDeliveryReceiptPayload(value: unknown): value is DeliveryReceiptPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<DeliveryReceiptPayload>;
  return payload.version === 1 && payload.kind === "receipt.delivered" && isNamespacedRoomId(payload.room_id ?? "")
    && Number.isSafeInteger(payload.up_to_seq) && Number(payload.up_to_seq) > 0 && Number.isFinite(payload.delivered_at);
}
export function isMessageExpiryPolicyPayload(value: unknown): value is MessageExpiryPolicyPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<MessageExpiryPolicyPayload>;
  return payload.version === 1 && payload.kind === "room.message-expiry" && Number.isSafeInteger(payload.updated_at) && Number(payload.updated_at) >= 0
    && (payload.expires_in_seconds === null || MESSAGE_EXPIRY_OPTIONS_SECONDS.includes(payload.expires_in_seconds as MessageExpirySeconds));
}
export function isRoomProfilePayload(value: unknown): value is RoomProfilePayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<RoomProfilePayload>;
  const avatar = payload.avatar as Partial<RoomProfileAvatar> | null | undefined;
  const validAvatar = avatar === null || Boolean(avatar && typeof avatar === "object"
    && typeof avatar.attachment_id === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(avatar.attachment_id)
    && avatar.mime_type === "image/webp"
    && Number.isSafeInteger(avatar.plaintext_bytes) && Number(avatar.plaintext_bytes) >= 1 && Number(avatar.plaintext_bytes) <= 128 * 1024
    && typeof avatar.key === "string" && /^[A-Za-z0-9_-]{43}$/.test(avatar.key)
    && typeof avatar.nonce === "string" && /^[A-Za-z0-9_-]{16}$/.test(avatar.nonce));
  return payload.version === 1 && payload.kind === "room.profile" && typeof payload.name === "string"
    && payload.name === payload.name.trim() && payload.name.length >= 1 && payload.name.length <= 100
    && !/[\u0000-\u001f\u007f]/u.test(payload.name)
    && validAvatar
    && Number.isSafeInteger(payload.updated_at) && Number(payload.updated_at) >= 0;
}
export function isRoomOwnerTransferPayload(value: unknown): value is RoomOwnerTransferPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<RoomOwnerTransferPayload>;
  return payload.version === 1 && payload.kind === "room.owner-transfer"
    && isNamespacedUserId(payload.target_user_id ?? "")
    && Number.isSafeInteger(payload.updated_at) && Number(payload.updated_at) >= 0;
}
export function canonicalEventBytes(event: Omit<ClientEvent, "signature">): Uint8Array<ArrayBuffer> {
  const ordered = { event_id: event.event_id, room_id: event.room_id, sender: event.sender, device_id: event.device_id, type: event.type, created_at: event.created_at, ciphertext: event.ciphertext, metadata: event.metadata };
  return new TextEncoder().encode(JSON.stringify(ordered)) as Uint8Array<ArrayBuffer>;
}

export function canonicalSignedEventBytes(event: ClientEvent): Uint8Array<ArrayBuffer> {
  const ordered = {
    event_id: event.event_id, room_id: event.room_id, sender: event.sender, device_id: event.device_id,
    type: event.type, created_at: event.created_at, ciphertext: event.ciphertext, metadata: event.metadata,
    signature: event.signature,
  };
  return new TextEncoder().encode(JSON.stringify(ordered)) as Uint8Array<ArrayBuffer>;
}

function equalBytes(left: Uint8Array<ArrayBuffer>, right: Uint8Array<ArrayBuffer>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Verifies that a server acceptance only adds authoritative ordering/receipt data
 * to the exact client-signed envelope that was submitted.
 */
export function acceptedEventMatchesClientEvent(accepted: unknown, submitted: ClientEvent, roomId: RoomId = submitted.room_id): accepted is RoomEvent {
  return isRoomEventEnvelope(accepted) && accepted.room_id === roomId
    && equalBytes(canonicalSignedEventBytes(accepted), canonicalSignedEventBytes(submitted));
}

export function draftEnvelopeAadBytes(envelope: Omit<DraftEnvelope, "ciphertext" | "signature">): Uint8Array<ArrayBuffer> {
  const ordered = {
    version: envelope.version, room_id: envelope.room_id, source_device_id: envelope.source_device_id,
    target_device_id: envelope.target_device_id, client_updated_at: envelope.client_updated_at,
    ephemeral_key: { kty: envelope.ephemeral_key.kty, crv: envelope.ephemeral_key.crv, x: envelope.ephemeral_key.x, y: envelope.ephemeral_key.y },
    salt: envelope.salt, nonce: envelope.nonce,
  };
  return new TextEncoder().encode(JSON.stringify(ordered)) as Uint8Array<ArrayBuffer>;
}

export function canonicalDraftEnvelopeBytes(envelope: Omit<DraftEnvelope, "signature">): Uint8Array<ArrayBuffer> {
  const ordered = {
    version: envelope.version, room_id: envelope.room_id, source_device_id: envelope.source_device_id,
    target_device_id: envelope.target_device_id, client_updated_at: envelope.client_updated_at,
    ephemeral_key: { kty: envelope.ephemeral_key.kty, crv: envelope.ephemeral_key.crv, x: envelope.ephemeral_key.x, y: envelope.ephemeral_key.y },
    salt: envelope.salt, nonce: envelope.nonce, ciphertext: envelope.ciphertext,
  };
  return new TextEncoder().encode(JSON.stringify(ordered)) as Uint8Array<ArrayBuffer>;
}

export function canonicalAcceptanceReceiptBytes(receipt: Omit<EventAcceptanceReceipt, "mac">): Uint8Array<ArrayBuffer> {
  const ordered = {
    version: receipt.version, key_id: receipt.key_id, room_id: receipt.room_id, seq: receipt.seq,
    event_id: receipt.event_id, event_hash: receipt.event_hash,
    retention_generation: receipt.retention_generation, accepted_at: receipt.accepted_at,
  };
  return new TextEncoder().encode(JSON.stringify(ordered)) as Uint8Array<ArrayBuffer>;
}
