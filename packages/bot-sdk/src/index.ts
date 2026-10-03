import { NodeOpenMlsMessagingCore } from "@edgechat/messaging-core/node";
import { canonicalEventBytes, type ClientEvent, type MessageId, type RoomId, type UserId } from "@edgechat/protocol";

const encoder = new TextEncoder();

export type PersonalBotState = {
  version: 1;
  base_url: string;
  bot_id: string;
  access_token: string;
  expires_at: number;
  user_id: UserId;
  device_id: string;
  room_id: RoomId;
  display_name: string;
  signing_private_key: JsonWebKey;
  mls_state: string;
  /** Exact signed ciphertext envelopes awaiting an idempotent server acknowledgement. */
  outbox?: ClientEvent[];
};

export interface BotStateStore {
  save(state: PersonalBotState): Promise<void>;
}

export type ProvisionPersonalBotOptions = {
  baseUrl: string;
  userAccessToken: string;
  displayName: string;
  store?: BotStateStore;
  fetch?: typeof globalThis.fetch;
};

class BotApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

async function request<T>(fetcher: typeof fetch, baseUrl: string, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (typeof init.body === "string") headers.set("content-type", "application/json");
  const response = await fetcher(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, headers });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "EdgeChat request failed", code: "request_failed" })) as { error: string; code: string };
    throw new BotApiError(error.error, response.status, error.code);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
}

/** An E2EE client for a user's personal notification integration. */
export class PersonalBotClient {
  private operationTail: Promise<void> = Promise.resolve();

  private constructor(
    private state: PersonalBotState,
    private readonly signingKey: CryptoKey,
    private readonly mls: NodeOpenMlsMessagingCore,
    private readonly store?: BotStateStore,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}

  static async provision(options: ProvisionPersonalBotOptions): Promise<PersonalBotClient> {
    const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const encryption = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const deviceId = crypto.randomUUID();
    const mls = NodeOpenMlsMessagingCore.create(deviceId);
    const [signingPublic, signingPrivate, encryptionPublic] = await Promise.all([
      crypto.subtle.exportKey("jwk", signing.publicKey),
      crypto.subtle.exportKey("jwk", signing.privateKey),
      crypto.subtle.exportKey("jwk", encryption.publicKey),
    ]);
    const fetcher = options.fetch ?? globalThis.fetch;
    const credentials = await request<{ bot_id: string; access_token: string; expires_at: number; user_id: UserId; device_id: string; server_name: string; display_name: string }>(fetcher, options.baseUrl, options.userAccessToken, "/api/v1/bots", {
      method: "POST",
      body: JSON.stringify({ display_name: options.displayName, device: { device_id: deviceId, display_name: options.displayName, signing_key: JSON.stringify(signingPublic), encryption_key: JSON.stringify(encryptionPublic), mls_key_packages: mls.generateKeyPackages(12) } }),
    });
    const roomId = `!${b64url(crypto.getRandomValues(new Uint8Array(18)))}:${credentials.server_name}` as RoomId;
    const claims = await request<{ key_packages: Array<{ claim_id: string; device_id: string; key_package: string }> }>(fetcher, options.baseUrl, credentials.access_token, "/api/v1/mls/key-packages/claim", { method: "POST", body: JSON.stringify({ user_ids: [credentials.user_id], room_id: roomId }) });
    const group = mls.createGroup(roomId, claims.key_packages.map((item) => item.key_package));
    await request(fetcher, options.baseUrl, credentials.access_token, "/api/v1/rooms", {
      method: "POST",
      body: JSON.stringify({ room_id: roomId, kind: "direct", name: `${options.displayName} 通知`, members: [], mls_welcome: group.welcome, mls_ratchet_tree: group.ratchet_tree, mls_epoch: group.epoch, mls_recipients: claims.key_packages.map((item) => item.device_id), mls_claim_ids: claims.key_packages.map((item) => item.claim_id) }),
    });
    const state: PersonalBotState = { version: 1, base_url: options.baseUrl, bot_id: credentials.bot_id, access_token: credentials.access_token, expires_at: credentials.expires_at, user_id: credentials.user_id, device_id: deviceId, room_id: roomId, display_name: options.displayName, signing_private_key: signingPrivate, mls_state: b64url(mls.exportState()), outbox: [] };
    const client = new PersonalBotClient(state, signing.privateKey, mls, options.store, fetcher);
    await options.store?.save(client.exportState());
    return client;
  }

  static async restore(state: PersonalBotState, options: { store?: BotStateStore; fetch?: typeof globalThis.fetch } = {}): Promise<PersonalBotClient> {
    if (state.version !== 1) throw new Error("Unsupported bot state version");
    const signingKey = await crypto.subtle.importKey("jwk", state.signing_private_key, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const mls = NodeOpenMlsMessagingCore.create(state.device_id, new Uint8Array(Buffer.from(state.mls_state, "base64url")));
    return new PersonalBotClient({ ...structuredClone(state), outbox: structuredClone(state.outbox ?? []) }, signingKey, mls, options.store, options.fetch ?? globalThis.fetch);
  }

  exportState(): PersonalBotState { return structuredClone(this.state); }

  get pendingCount(): number { return this.state.outbox?.length ?? 0; }

  sendText(text: string): Promise<{ event_id: string; seq: number }> {
    return this.exclusive(() => this.sendTextLocked(text));
  }

  /** Retries already encrypted messages without advancing MLS or changing their event IDs. */
  flushPending(): Promise<Array<{ event_id: string; seq: number }>> {
    return this.exclusive(() => this.flushPendingLocked());
  }

  private async sendTextLocked(text: string): Promise<{ event_id: string; seq: number }> {
    const content = text.trim();
    if (!content || content.length > 32_000) throw new RangeError("Text must contain 1-32000 characters");
    if (this.state.expires_at <= Date.now()) throw new Error("Bot token has expired");
    await this.flushPendingLocked();
    const eventId = `$${crypto.randomUUID()}:${this.state.user_id.slice(this.state.user_id.lastIndexOf(":") + 1)}` as MessageId;
    const payload = { version: 2, message_id: eventId, origin: { kind: "bot", bot_id: this.state.bot_id, display_name: this.state.display_name }, parts: [{ part_id: crypto.randomUUID(), kind: "text", text: content }] };
    const ciphertext = b64url(this.mls.encryptMessage(this.state.room_id, encoder.encode(JSON.stringify(payload))));
    this.state.mls_state = b64url(this.mls.exportState());
    const unsigned: Omit<ClientEvent, "signature"> = { event_id: eventId, room_id: this.state.room_id, sender: this.state.user_id, device_id: this.state.device_id, type: "message.text", created_at: Date.now(), ciphertext, metadata: { mls_epoch: this.mls.epoch(this.state.room_id), sender_kind: "bot", bot_id: this.state.bot_id } };
    const signature = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.signingKey, canonicalEventBytes(unsigned)));
    (this.state.outbox ??= []).push({ ...unsigned, signature });
    // Persist the advanced MLS state and exact signed envelope before any ambiguous network operation.
    await this.persist();
    const delivered = await this.flushPendingLocked();
    const result = delivered.at(-1);
    if (!result) throw new Error("Bot message was not delivered");
    return result;
  }

  private async flushPendingLocked(): Promise<Array<{ event_id: string; seq: number }>> {
    const delivered: Array<{ event_id: string; seq: number }> = [];
    while (this.state.outbox?.length) {
      const event = this.state.outbox[0];
      const result = await request<{ event: ClientEvent & { seq: number } }>(this.fetcher, this.state.base_url, this.state.access_token, `/api/v1/rooms/${encodeURIComponent(this.state.room_id)}/events`, { method: "POST", body: JSON.stringify(event) });
      delivered.push({ event_id: result.event.event_id, seq: result.event.seq });
      this.state.outbox.shift();
      await this.persist();
    }
    return delivered;
  }

  private persist(): Promise<void> { return this.store?.save(this.exportState()) ?? Promise.resolve(); }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  close(): void { this.mls.destroy(); }
}

export { BotApiError };
