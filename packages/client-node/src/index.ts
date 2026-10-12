import { NodeOpenMlsMessagingCore } from "@edgechat/messaging-core/node";
import {
  canonicalEventBytes,
  isRoomEventEnvelope,
  type ClientEvent,
  type MessageId,
  type RoomEvent,
  type RoomId,
  type UserId,
} from "@edgechat/protocol";
import { ApiClient, type NetworkRoute, type ServerRoom } from "@edgechat/sync";

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
    return new NodeEdgeChatClient(structuredClone(state), signingKey, mls, api, options.store);
  }

  exportState(): NodeClientState { return structuredClone(this.state); }
  get userId(): UserId { return this.state.user_id; }
  get deviceId(): string { return this.state.device_id; }
  get pendingCount(): number { return this.state.outbox.length; }

  rooms(): Promise<ServerRoom[]> {
    return this.exclusive(async () => this.refreshRoomsLocked());
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

  sendText(roomId: RoomId, text: string): Promise<{ event_id: string; seq: number }> {
    return this.exclusive(async () => {
      const content = text.trim();
      if (!content || content.length > 32_000) throw new RangeError("Text must contain 1-32000 characters");
      await this.flushPendingLocked();
      if (!this.mls.hasGroup(roomId)) await this.refreshRoomsLocked();
      if (!this.mls.hasGroup(roomId)) throw new NodeClientError("Room MLS state is unavailable", "room_state_unavailable");
      const eventId = `$${crypto.randomUUID()}:${serverName(this.state.user_id)}` as MessageId;
      const payload = { version: 2, message_id: eventId, parts: [{ part_id: crypto.randomUUID(), kind: "text", text: content }] };
      const ciphertext = base64Url(this.mls.encryptMessage(roomId, encoder.encode(JSON.stringify(payload))));
      this.captureMlsState();
      const unsigned: Omit<ClientEvent, "signature"> = {
        event_id: eventId,
        room_id: roomId,
        sender: this.state.user_id,
        device_id: this.state.device_id,
        type: "message.text",
        created_at: Date.now(),
        ciphertext,
        metadata: { mls_epoch: this.mls.epoch(roomId) },
      };
      const signature = base64Url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.signingKey, canonicalEventBytes(unsigned)));
      this.state.outbox.push({ ...unsigned, signature });
      // Ratchet state and its exact ciphertext are durable before the request can become ambiguous.
      await this.persist();
      const delivered = await this.flushPendingLocked();
      const result = delivered.at(-1);
      if (!result) throw new NodeClientError("Message was not delivered", "delivery_failed");
      return result;
    });
  }

  flushPending(): Promise<Array<{ event_id: string; seq: number }>> {
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
      const messages: DecryptedNodeMessage[] = [];
      for (const room of rooms) messages.push(...await this.pullRoomLocked(room));
      await this.persist();
      return messages;
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
          messages.push({ event, payload, text });
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

  private async flushPendingLocked(): Promise<Array<{ event_id: string; seq: number }>> {
    const delivered: Array<{ event_id: string; seq: number }> = [];
    while (this.state.outbox.length) {
      const event = this.state.outbox[0];
      const result = await this.api.sendEvent(event.room_id, event);
      delivered.push({ event_id: result.event.event_id, seq: result.event.seq });
      this.state.room_sequences[event.room_id] = Math.max(this.state.room_sequences[event.room_id] ?? 0, result.event.seq);
      this.state.outbox.shift();
      await this.persist();
    }
    return delivered;
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
