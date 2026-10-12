import { NodeOpenMlsMessagingCore } from "@edgechat/messaging-core/node";
import { WebCryptoMessagingCore } from "@edgechat/messaging-core";
import {
  canonicalEventBytes,
  isNamespacedMessageId,
  isMessageDeletePayload,
  isRoomEventEnvelope,
  MAX_ATTACHMENT_PLAINTEXT_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_MESSAGE_ATTACHMENT_PLAINTEXT_BYTES,
  type ClientEvent,
  type MessageId,
  type MessageDeletePayload,
  type RoomEvent,
  type RoomId,
  type UserId,
} from "@edgechat/protocol";
import { ApiClient, createAttachmentId, type NetworkRoute, type ServerRoom } from "@edgechat/sync";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64Url(value: Uint8Array | ArrayBuffer): string {
  return Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value)).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(value, "base64url")) as Uint8Array<ArrayBuffer>;
}

function randomSecret(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function serverName(userId: string): string {
  const separator = userId.lastIndexOf(":");
  if (separator < 1) throw new Error("Server returned an invalid user ID");
  return userId.slice(separator + 1);
}

export type NodeClientState = {
  version: 1;
  base_url: string;
  user_id: UserId;
  device_id: string;
  display_name: string;
  access_token: string;
  account_credential: string;
  device_credential: string;
  signing_private_key: JsonWebKey;
  signing_public_key: JsonWebKey;
  encryption_private_key: JsonWebKey;
  encryption_public_key: JsonWebKey;
  mls_state: string;
  sync_cursor: number;
  room_sequences: Record<string, number>;
  outbox: ClientEvent[];
  pending_deliveries: DecryptedNodeMessage[];
};

export interface NodeClientStateStore {
  save(state: NodeClientState): Promise<void>;
}

export type RegisterNodeClientOptions = {
  baseUrl: string;
  displayName: string;
  deviceName?: string;
  store?: NodeClientStateStore;
  fetch?: typeof globalThis.fetch;
};

export type RestoreNodeClientOptions = {
  store?: NodeClientStateStore;
  fetch?: typeof globalThis.fetch;
};

export type DecryptedNodeMessage = {
  event: RoomEvent;
  payload: Record<string, unknown>;
  text: string;
  attachments: NodeAttachment[];
  replyToId?: MessageId;
  mutation?: NodeMessageMutation;
};

export type NodeMessageMutation = {
  type: "message-delete";
  targetMessageId: MessageId;
  deletedAt: number;
};

export type NodeMessageOptions = {
  replyToId?: MessageId;
};

export type NodeAttachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  key: string;
  nonce: string;
  width?: number;
  height?: number;
  duration_ms?: number;
};

export type NodeAttachmentInput = {
  name: string;
  type: string;
  bytes: ArrayBuffer | Uint8Array;
  width?: number;
  height?: number;
  duration_ms?: number;
};

export type SendNodeMessageResult = {
  event_id: MessageId;
  seq: number;
  attachments: NodeAttachment[];
};

export class NodeClientError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

function nodeRoute(fetcher: typeof globalThis.fetch): NetworkRoute {
  return {
    fetch: (input, init) => fetcher(input, init),
    openRealtime: () => { throw new NodeClientError("Realtime transport is not configured", "realtime_unavailable"); },
  };
}

/**
 * Headless EdgeChat device for integration tests and trusted self-hosted gateways.
 * Its persisted state contains plaintext-capable MLS secrets and must be protected.
 */
export class NodeEdgeChatClient {
  private operationTail: Promise<void> = Promise.resolve();
  private readonly attachmentCrypto = new WebCryptoMessagingCore();

  private constructor(
    private state: NodeClientState,
    private readonly signingKey: CryptoKey,
    private readonly mls: NodeOpenMlsMessagingCore,
    private readonly api: ApiClient,
    private readonly store?: NodeClientStateStore,
  ) {}

  static async register(options: RegisterNodeClientOptions): Promise<NodeEdgeChatClient> {
    const [signing, encryption] = await Promise.all([
      crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
      crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
    ]);
    const deviceId = crypto.randomUUID();
    const mls = NodeOpenMlsMessagingCore.create(deviceId);
    const [signingPrivate, signingPublic, encryptionPrivate, encryptionPublic] = await Promise.all([
      crypto.subtle.exportKey("jwk", signing.privateKey),
      crypto.subtle.exportKey("jwk", signing.publicKey),
      crypto.subtle.exportKey("jwk", encryption.privateKey),
      crypto.subtle.exportKey("jwk", encryption.publicKey),
    ]);
    const accountCredential = randomSecret();
    const deviceCredential = randomSecret();
    const api = new ApiClient(options.baseUrl, null, nodeRoute(options.fetch ?? globalThis.fetch));
    try {
      const session = await api.registerOpaque({
        display_name: options.displayName,
        account_credential: accountCredential,
        device: {
          device_id: deviceId,
          display_name: options.deviceName ?? `${options.displayName} gateway`,
          signing_key: JSON.stringify(signingPublic),
          encryption_key: JSON.stringify(encryptionPublic),
          device_credential: deviceCredential,
          mls_key_packages: mls.generateKeyPackages(12),
        },
      });
      if (session.device_id !== deviceId || !session.access_token) throw new NodeClientError("Registration returned a mismatched device", "invalid_registration_response");
      api.setToken(session.access_token);
      const state: NodeClientState = {
        version: 1,
        base_url: options.baseUrl,
        user_id: session.user_id as UserId,
        device_id: deviceId,
        display_name: session.display_name,
        access_token: session.access_token,
        account_credential: accountCredential,
        device_credential: session.device_credential ?? deviceCredential,
        signing_private_key: signingPrivate,
        signing_public_key: signingPublic,
        encryption_private_key: encryptionPrivate,
        encryption_public_key: encryptionPublic,
        mls_state: base64Url(mls.exportState()),
        sync_cursor: 0,
        room_sequences: {},
        outbox: [],
        pending_deliveries: [],
      };
      const client = new NodeEdgeChatClient(state, signing.privateKey, mls, api, options.store);
      await client.persist();
      return client;
    } catch (error) {
      mls.destroy();
      throw error;
    }
  }

  static async restore(state: NodeClientState, options: RestoreNodeClientOptions = {}): Promise<NodeEdgeChatClient> {
    if (state.version !== 1 || !state.user_id || !state.device_id || !state.access_token) throw new NodeClientError("Invalid client state", "invalid_state");
    const signingKey = await crypto.subtle.importKey("jwk", state.signing_private_key, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const mls = NodeOpenMlsMessagingCore.create(state.device_id, fromBase64Url(state.mls_state));
    const api = new ApiClient(state.base_url, state.access_token, nodeRoute(options.fetch ?? globalThis.fetch));
    return new NodeEdgeChatClient({ ...structuredClone(state), pending_deliveries: structuredClone(state.pending_deliveries ?? []) }, signingKey, mls, api, options.store);
  }

  exportState(): NodeClientState { return structuredClone(this.state); }
  get userId(): UserId { return this.state.user_id; }
  get deviceId(): string { return this.state.device_id; }
  get pendingCount(): number { return this.state.outbox.length; }

  rooms(): Promise<ServerRoom[]> {
    return this.exclusive(async () => this.refreshRoomsLocked());
  }

  acceptMessageRequest(roomId: RoomId): Promise<void> {
    return this.exclusive(async () => { await this.api.acceptMessageRequest(roomId); });
  }

  createRoom(memberIds: UserId[]): Promise<RoomId> {
    return this.exclusive(async () => {
      const members = [...new Set(memberIds.filter((id) => id !== this.state.user_id))];
      if (!members.length || members.length > 31) throw new RangeError("A room requires 1-31 other members");
      const roomId = `!${base64Url(crypto.getRandomValues(new Uint8Array(18)))}:${serverName(this.state.user_id)}` as RoomId;
      const claimed = await this.api.claimMlsKeyPackages(members, roomId);
      if (!claimed.key_packages.length) throw new NodeClientError("No active recipient devices have MLS KeyPackages", "missing_key_packages");
      const created = this.mls.createGroup(roomId, claimed.key_packages.map((item) => item.key_package));
      this.captureMlsState();
      await this.persist();
      await this.api.createRoom({
        room_id: roomId,
        kind: members.length === 1 ? "direct" : "group",
        name: null,
        members,
        mls_welcome: created.welcome,
        mls_ratchet_tree: created.ratchet_tree,
        mls_epoch: created.epoch,
        mls_recipients: claimed.key_packages.map((item) => item.device_id),
        mls_claim_ids: claimed.key_packages.map((item) => item.claim_id),
      });
      this.state.room_sequences[roomId] = 0;
      await this.persist();
      return roomId;
    });
  }

  sendText(roomId: RoomId, text: string, options: NodeMessageOptions = {}): Promise<{ event_id: MessageId; seq: number }> {
    return this.exclusive(async () => {
      const content = text.trim();
      if (!content || content.length > 16_000) throw new RangeError("Text must contain 1-16000 characters");
      const relation = messageRelation(roomId, options.replyToId);
      return this.queueMessageLocked(roomId, "message.text", (eventId) => ({
        version: 2, message_id: eventId, parts: [{ part_id: crypto.randomUUID(), kind: "text", text: content }],
        ...(relation ? { relation } : {}),
      }), {});
    });
  }

  sendAttachments(roomId: RoomId, inputs: readonly NodeAttachmentInput[], text = "", options: NodeMessageOptions = {}): Promise<SendNodeMessageResult> {
    return this.exclusive(async () => {
      const content = text.trim();
      if (content.length > 16_000) throw new RangeError("Text must contain at most 16000 characters");
      if (!inputs.length || inputs.length > MAX_MESSAGE_ATTACHMENTS) throw new RangeError(`A message requires 1-${MAX_MESSAGE_ATTACHMENTS} attachments`);
      const normalized = inputs.map(normalizeAttachmentInput);
      const total = normalized.reduce((sum, input) => sum + input.bytes.byteLength, 0);
      if (total > MAX_MESSAGE_ATTACHMENT_PLAINTEXT_BYTES) throw new RangeError("Message attachments exceed the plaintext size limit");
      const relation = messageRelation(roomId, options.replyToId);
      const uploaded: NodeAttachment[] = [];
      let queued = false;
      try {
        for (const input of normalized) {
          const id = createAttachmentId();
          const encrypted = await this.attachmentCrypto.encryptAttachment(input.bytes);
          await this.api.uploadAttachment(roomId, encrypted.ciphertext, id);
          uploaded.push({ id, name: input.name, type: input.type, size: input.bytes.byteLength,
            key: encrypted.key, nonce: encrypted.nonce, ...(input.width ? { width: input.width, height: input.height } : {}),
            ...(input.duration_ms ? { duration_ms: input.duration_ms } : {}) });
        }
        const result = await this.queueMessageLocked(roomId, "message.file", (eventId) => ({
          version: 2, message_id: eventId, parts: [
            ...(content ? [{ part_id: crypto.randomUUID(), kind: "text", text: content }] : []),
            ...uploaded.map((attachment) => ({ part_id: crypto.randomUUID(), kind: "attachment", attachment })),
          ],
          ...(relation ? { relation } : {}),
        }), uploaded.length === 1 ? { attachment_id: uploaded[0]!.id } : { attachment_ids: uploaded.map((item) => item.id) }, () => { queued = true; });
        return { ...result, attachments: uploaded };
      } catch (error) {
        if (!queued && uploaded.length) await this.api.abandonAttachments(uploaded.map((item) => item.id)).catch(() => undefined);
        throw error;
      }
    });
  }

  deleteMessage(roomId: RoomId, targetMessageId: MessageId): Promise<{ event_id: MessageId; seq: number }> {
    return this.exclusive(async () => {
      if (!isNamespacedMessageId(targetMessageId)) throw new RangeError("Message deletion target is invalid");
      const deletedAt = Date.now();
      const payload: MessageDeletePayload = {
        version: 1,
        kind: "message.delete",
        target: { kind: "message", message_id: targetMessageId, room_id: roomId },
        deleted_at: deletedAt,
      };
      return this.queueMessageLocked(roomId, "message.delete", () => payload as unknown as Record<string, unknown>, {
        target_event_id: targetMessageId,
      }, undefined, deletedAt);
    });
  }

  async downloadAttachment(attachment: NodeAttachment): Promise<ArrayBuffer> {
    const normalized = normalizeAttachment(attachment);
    if (!normalized) throw new NodeClientError("Attachment metadata is invalid", "invalid_attachment_metadata");
    try {
      const ciphertext = await this.api.downloadAttachment(normalized.id);
      const plaintext = await this.attachmentCrypto.decryptAttachment(ciphertext, normalized.key, normalized.nonce);
      if (plaintext.byteLength !== normalized.size) throw new NodeClientError("Attachment size does not match its authenticated metadata", "attachment_size_mismatch");
      return plaintext;
    } catch (error) {
      if (error instanceof NodeClientError) throw error;
      throw new NodeClientError("Attachment authentication failed", "attachment_authentication_failed");
    }
  }

  flushPending(): Promise<Array<{ event_id: MessageId; seq: number }>> {
    return this.exclusive(async () => this.flushPendingLocked());
  }

  pull(): Promise<DecryptedNodeMessage[]> {
    return this.exclusive(async () => {
      const rooms = await this.refreshRoomsLocked();
      let hasMore = true;
      while (hasMore) {
        const page = await this.api.sync(this.state.sync_cursor);
        this.state.sync_cursor = page.next_cursor;
        hasMore = page.has_more;
      }
      const messages: DecryptedNodeMessage[] = [...this.state.pending_deliveries];
      for (const room of rooms) messages.push(...await this.pullRoomLocked(room));
      await this.persist();
      return messages;
    });
  }

  acknowledgeDeliveries(eventIds: readonly string[]): Promise<void> {
    return this.exclusive(async () => {
      const ids = new Set(eventIds);
      if ([...ids].some((id) => !id || id.length > 512)) throw new RangeError("Delivery acknowledgement IDs are invalid");
      if (!ids.size) return;
      this.state.pending_deliveries = this.state.pending_deliveries.filter((message) => !ids.has(message.event.event_id));
      await this.persist();
    });
  }

  private async refreshRoomsLocked(): Promise<ServerRoom[]> {
    const { rooms } = await this.api.rooms();
    for (const room of rooms) {
      if (!this.mls.hasGroup(room.room_id) && room.encrypted_state) {
        const packet = JSON.parse(room.encrypted_state) as { version?: unknown; welcome?: unknown; ratchet_tree?: unknown };
        if (packet.version !== 1 || typeof packet.welcome !== "string" || typeof packet.ratchet_tree !== "string") {
          throw new NodeClientError("Room MLS welcome is invalid", "invalid_room_welcome");
        }
        this.mls.joinGroup(packet.welcome, packet.ratchet_tree);
        this.captureMlsState();
        this.state.room_sequences[room.room_id] ??= room.joined_seq;
        await this.persist();
      }
    }
    return rooms;
  }

  private async pullRoomLocked(room: ServerRoom): Promise<DecryptedNodeMessage[]> {
    const after = this.state.room_sequences[room.room_id] ?? room.joined_seq;
    if (room.current_seq <= after) return [];
    const pending: RoomEvent[] = [];
    let before: number | undefined;
    for (;;) {
      const page = await this.api.history(room.room_id, before, 200);
      const events = page.events.filter((event) => event.seq > after);
      pending.push(...events);
      if (!events.length || events.some((event) => event.seq === after + 1) || page.events.length < 200) break;
      before = Math.min(...events.map((event) => event.seq));
    }
    const unique = [...new Map(pending.map((event) => [event.seq, event])).values()].sort((left, right) => left.seq - right.seq);
    const messages: DecryptedNodeMessage[] = [];
    let expected = after + 1;
    for (const event of unique) {
      if (event.seq !== expected) throw new NodeClientError(`Missing room event ${expected}`, "history_gap");
      await this.verifyEvent(event);
      if (event.device_id !== this.state.device_id) {
        const processed = this.mls.processMessage(room.room_id, fromBase64Url(event.ciphertext));
        if (processed.senderDeviceId !== event.device_id) throw new NodeClientError("MLS sender does not match the signed envelope", "sender_mismatch");
        this.captureMlsState();
        if (processed.plaintext.length) {
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(decoder.decode(processed.plaintext)) as Record<string, unknown>; }
          catch { throw new NodeClientError("Decrypted message is not valid JSON", "invalid_plaintext"); }
          const text = Array.isArray(payload.parts)
            ? payload.parts.filter((part): part is { kind: "text"; text: string } => Boolean(part) && typeof part === "object" && (part as { kind?: unknown }).kind === "text" && typeof (part as { text?: unknown }).text === "string").map((part) => part.text).join("\n")
            : "";
          const attachments = Array.isArray(payload.parts)
            ? payload.parts.flatMap((part) => {
              if (!part || typeof part !== "object" || (part as { kind?: unknown }).kind !== "attachment") return [];
              const attachment = normalizeAttachment((part as { attachment?: unknown }).attachment);
              if (!attachment) throw new NodeClientError("Decrypted attachment metadata is invalid", "invalid_attachment_metadata");
              return [attachment];
            })
            : [];
          const replyToId = messageReplyTarget(payload, event.room_id);
          const mutation = messageMutation(payload, event);
          const message = { event, payload, text, attachments, ...(replyToId ? { replyToId } : {}), ...(mutation ? { mutation } : {}) };
          messages.push(message);
          this.state.pending_deliveries.push(message);
        }
      }
      this.state.room_sequences[room.room_id] = event.seq;
      expected += 1;
      await this.persist();
    }
    return messages;
  }

  private async verifyEvent(event: RoomEvent): Promise<void> {
    if (!isRoomEventEnvelope(event)) throw new NodeClientError("Server returned an invalid event envelope", "invalid_event");
    const { keys } = await this.api.roomSigningKeys(event.room_id);
    const sender = keys.find((key) => key.device_id === event.device_id && key.user_id === event.sender);
    if (!sender) throw new NodeClientError("Event signer is not a room device", "unknown_signer");
    const key = await crypto.subtle.importKey("jwk", sender.signing_key, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const { signature, ...unsigned } = event;
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64Url(signature), canonicalEventBytes(unsigned));
    if (!valid) throw new NodeClientError("Event signature is invalid", "invalid_signature");
  }

  private async flushPendingLocked(): Promise<Array<{ event_id: MessageId; seq: number }>> {
    const delivered: Array<{ event_id: MessageId; seq: number }> = [];
    while (this.state.outbox.length) {
      const event = this.state.outbox[0];
      const result = await this.api.sendEvent(event.room_id, event);
      delivered.push({ event_id: result.event.event_id as MessageId, seq: result.event.seq });
      this.state.room_sequences[event.room_id] = Math.max(this.state.room_sequences[event.room_id] ?? 0, result.event.seq);
      this.state.outbox.shift();
      await this.persist();
    }
    return delivered;
  }

  private async queueMessageLocked(
    roomId: RoomId,
    type: "message.text" | "message.file" | "message.delete",
    createPayload: (eventId: MessageId) => Record<string, unknown>,
    metadata: Record<string, unknown>,
    afterQueued?: () => void,
    createdAt = Date.now(),
  ): Promise<{ event_id: MessageId; seq: number }> {
    await this.flushPendingLocked();
    if (!this.mls.hasGroup(roomId)) await this.refreshRoomsLocked();
    if (!this.mls.hasGroup(roomId)) throw new NodeClientError("Room MLS state is unavailable", "room_state_unavailable");
    const eventId = `$${crypto.randomUUID()}:${serverName(this.state.user_id)}` as MessageId;
    const ciphertext = base64Url(this.mls.encryptMessage(roomId, encoder.encode(JSON.stringify(createPayload(eventId)))));
    this.captureMlsState();
    const unsigned: Omit<ClientEvent, "signature"> = {
      event_id: eventId, room_id: roomId, sender: this.state.user_id, device_id: this.state.device_id,
      type, created_at: createdAt, ciphertext, metadata: { ...metadata, mls_epoch: this.mls.epoch(roomId) },
    };
    const signature = base64Url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.signingKey, canonicalEventBytes(unsigned)));
    this.state.outbox.push({ ...unsigned, signature });
    // From this point the exact event owns its attachments. Even a state-store
    // error is ambiguous, so cleanup must not delete ciphertext it references.
    afterQueued?.();
    // Ratchet state and its exact ciphertext are durable before the request can become ambiguous.
    await this.persist();
    const delivered = await this.flushPendingLocked();
    const result = delivered.at(-1);
    if (!result) throw new NodeClientError("Message was not delivered", "delivery_failed");
    return result;
  }

  private captureMlsState(): void { this.state.mls_state = base64Url(this.mls.exportState()); }
  private persist(): Promise<void> { return this.store?.save(this.exportState()) ?? Promise.resolve(); }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  close(): void { this.mls.destroy(); }
}

function normalizeAttachmentInput(input: NodeAttachmentInput): NodeAttachmentInput & { bytes: ArrayBuffer } {
  const name = input.name.trim();
  const type = input.type.trim().toLowerCase();
  const bytes = input.bytes instanceof Uint8Array
    ? input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.byteLength) as ArrayBuffer
    : input.bytes;
  if (!name || name.length > 255 || /[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name)) throw new RangeError("Attachment name is invalid");
  if (!type || type.length > 128 || !type.includes("/") || /[^\x21-\x7e]/u.test(type)) throw new RangeError("Attachment MIME type is invalid");
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_ATTACHMENT_PLAINTEXT_BYTES) throw new RangeError("Attachment size is invalid");
  const hasWidth = input.width !== undefined; const hasHeight = input.height !== undefined;
  if (hasWidth !== hasHeight || (hasWidth && (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height)
    || input.width! < 1 || input.height! < 1 || input.width! > 65_535 || input.height! > 65_535))) throw new RangeError("Attachment dimensions are invalid");
  if (input.duration_ms !== undefined && (!Number.isSafeInteger(input.duration_ms) || input.duration_ms < 1 || input.duration_ms > 10 * 60_000)) throw new RangeError("Attachment duration is invalid");
  return { ...input, name, type, bytes };
}

function normalizeAttachment(value: unknown): NodeAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const attachment = value as Partial<NodeAttachment>;
  const name = typeof attachment.name === "string" ? attachment.name.trim() : "";
  const type = typeof attachment.type === "string" ? attachment.type.trim().toLowerCase() : "";
  const hasWidth = attachment.width !== undefined; const hasHeight = attachment.height !== undefined;
  if (typeof attachment.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(attachment.id)
    || !name || name.length > 255 || /[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name)
    || !type || type.length > 128 || !type.includes("/") || /[^\x21-\x7e]/u.test(type)
    || !Number.isSafeInteger(attachment.size) || attachment.size! < 1 || attachment.size! > MAX_ATTACHMENT_PLAINTEXT_BYTES
    || typeof attachment.key !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(attachment.key)
    || typeof attachment.nonce !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(attachment.nonce)
    || hasWidth !== hasHeight || (hasWidth && (!Number.isSafeInteger(attachment.width) || !Number.isSafeInteger(attachment.height)
      || attachment.width! < 1 || attachment.height! < 1 || attachment.width! > 65_535 || attachment.height! > 65_535))
    || (attachment.duration_ms !== undefined && (!Number.isSafeInteger(attachment.duration_ms) || attachment.duration_ms < 1 || attachment.duration_ms > 10 * 60_000))) return null;
  return { id: attachment.id, name, type, size: Number(attachment.size), key: attachment.key, nonce: attachment.nonce,
    ...(hasWidth ? { width: Number(attachment.width), height: Number(attachment.height) } : {}),
    ...(attachment.duration_ms ? { duration_ms: Number(attachment.duration_ms) } : {}) };
}

function messageRelation(roomId: RoomId, replyToId?: MessageId): Record<string, unknown> | undefined {
  if (replyToId === undefined) return undefined;
  if (!isNamespacedMessageId(replyToId)) throw new RangeError("Reply target message ID is invalid");
  return { type: "reply", target: { kind: "message", message_id: replyToId, room_id: roomId } };
}

function messageReplyTarget(payload: Record<string, unknown>, roomId: RoomId): MessageId | undefined {
  if (payload.relation === undefined) return undefined;
  if (!payload.relation || typeof payload.relation !== "object" || Array.isArray(payload.relation)) {
    throw new NodeClientError("Decrypted message relation is invalid", "invalid_message_relation");
  }
  const relation = payload.relation as { type?: unknown; target?: unknown };
  if (relation.type !== "reply" || !relation.target || typeof relation.target !== "object" || Array.isArray(relation.target)) {
    throw new NodeClientError("Decrypted message relation is invalid", "invalid_message_relation");
  }
  const target = relation.target as { kind?: unknown; message_id?: unknown; room_id?: unknown };
  if (target.kind !== "message" || typeof target.message_id !== "string" || !isNamespacedMessageId(target.message_id) || target.room_id !== roomId) {
    throw new NodeClientError("Decrypted reply target is invalid", "invalid_message_relation");
  }
  return target.message_id;
}

function messageMutation(payload: Record<string, unknown>, event: RoomEvent): NodeMessageMutation | undefined {
  if (event.type !== "message.delete") return undefined;
  if (!isMessageDeletePayload(payload) || payload.target.room_id !== event.room_id
    || event.metadata.target_event_id !== payload.target.message_id) {
    throw new NodeClientError("Decrypted message deletion is invalid", "invalid_message_deletion");
  }
  return { type: "message-delete", targetMessageId: payload.target.message_id, deletedAt: payload.deleted_at };
}
