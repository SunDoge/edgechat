import { loadIdentity, saveIdentity } from "@edgechat/client-storage/vault";
import { LocalDatabase, type LocalMessage, type LocalMessageWindow, type SearchResult } from "@edgechat/db";
import { assertMessageEnvelope, createMessagePayload, embeddedImagePreviewByteLength, messageText, normalizeMessagePayload, prepareImageMetadata, type AttachmentMetadata, type MessagePayload } from "@edgechat/message-content";
import { decodeBase64Url, encodeBase64Url, openArchiveSegmentKey, sealArchiveSegmentKey, OpenMlsMessagingCore, WebCryptoMessagingCore, type DeviceIdentity } from "@edgechat/messaging-core";
import {
  acceptedEventMatchesClientEvent,
  canonicalEventBytes,
  isDeliveryReceiptPayload,
  isMessageDeletePayload,
  isMessageEditPayload,
  isMessageExpiryPolicyPayload,
  isMessageReactionPayload,
  isMlsMembershipCommitEventType,
  isReadReceiptPayload,
  isRoomOwnerTransferPayload,
  isRoomProfilePayload,
  MAX_EVENT_CIPHERTEXT_LENGTH,
  type ClientEvent,
  type EventId,
  type MessageId,
  type RoomEvent,
  type RoomId,
  type RoomProfilePayload,
  type UserId,
} from "@edgechat/protocol";
import {
  ApiClient,
  ArchiveCoordinator,
  ArchiveSegmentBuilder,
  LocalProjectionPersistenceError,
  LocalStagingIntegrityError,
  OutboxEngine,
  SyncEngine,
  createAttachmentId,
  type ArchiveSegmentDescriptor,
  type DeviceLinkPreview,
  type ServerRoom,
  type SessionIdentity,
} from "@edgechat/sync";
import { stagedMlsPosition } from "./crypto-state";
import { replenishMlsKeyPackages } from "./key-package-replenishment";
import { ArchiveSegmentCiphertextCache } from "./archive-segment-cache";
import { AttachmentCiphertextCache } from "./attachment-cache";
import { sealAccountCredential } from "@edgechat/messaging-core";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ROOM_DISCOVERY_INTERVAL_MS = 5_000;

export type RuntimeConnection = "starting" | "online" | "offline" | "stopped";
export type RuntimeSnapshot = {
  connection: RuntimeConnection;
  session: SessionIdentity;
  rooms: ServerRoom[];
};

export type BrowserRuntimeOptions = {
  profileId: string;
  accessToken: string;
  api?: ApiClient;
  database?: LocalDatabase;
};

function serverName(session: SessionIdentity): string {
  const value = session.server_name ?? session.user_id.slice(session.user_id.lastIndexOf(":") + 1);
  if (!value) throw new Error("Session server name is unavailable");
  return value;
}

function publicSigningKey(value: JsonWebKey): JsonWebKey {
  if (value.kty !== "EC" || value.crv !== "P-256" || typeof value.x !== "string" || typeof value.y !== "string") {
    throw new Error("Invalid device signing key");
  }
  return { kty: "EC", crv: "P-256", x: value.x, y: value.y, ext: true };
}

async function verifyRoomEventSignature(event: ClientEvent, signingKey: JsonWebKey): Promise<void> {
  const signature = decodeBase64Url(event.signature);
  if (signature.length !== 64) throw new Error("Room event signature is malformed");
  const key = await crypto.subtle.importKey("jwk", publicSigningKey(signingKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const { signature: _signature, ...unsigned } = event;
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, canonicalEventBytes(unsigned));
  if (!valid) throw new Error("Room event signature is invalid");
}

/**
 * Framework-independent browser device runtime.
 *
 * Every MLS mutation is serialized here. React may observe snapshots and call
 * commands, but it never owns ratchet state or database transactions.
 */
export class BrowserMessagingRuntime extends EventTarget {
  readonly api: ApiClient;
  readonly db: LocalDatabase;
  readonly core = new WebCryptoMessagingCore();
  readonly profileId: string;
  readonly session: SessionIdentity;

  private identity: DeviceIdentity;
  private mls: OpenMlsMessagingCore;
  private sync: SyncEngine | null = null;
  private outbox: OutboxEngine | null = null;
  private archive: ArchiveCoordinator | null = null;
  private readonly archiveCache: ArchiveSegmentCiphertextCache;
  private readonly attachmentCache: AttachmentCiphertextCache;
  private roomsState: ServerRoom[] = [];
  private connectionState: RuntimeConnection = "starting";
  private mlsTail: Promise<void> = Promise.resolve();
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private keyPackageTimer: ReturnType<typeof setInterval> | null = null;
  private readonly resumeDiscovery = () => {
    if (document.visibilityState === "visible" && navigator.onLine) void this.sync?.catchUp();
  };
  private closed = false;

  private constructor(options: BrowserRuntimeOptions, session: SessionIdentity, identity: DeviceIdentity, mls: OpenMlsMessagingCore) {
    super();
    this.profileId = options.profileId;
    this.api = options.api ?? new ApiClient("", options.accessToken);
    this.api.setToken(options.accessToken);
    this.db = options.database ?? new LocalDatabase(options.profileId);
    this.session = session;
    this.identity = identity;
    this.mls = mls;
    this.archiveCache = new ArchiveSegmentCiphertextCache(options.profileId);
    this.attachmentCache = new AttachmentCiphertextCache(options.profileId);
  }

  static async open(options: BrowserRuntimeOptions): Promise<BrowserMessagingRuntime> {
    const api = options.api ?? new ApiClient("", options.accessToken);
    api.setToken(options.accessToken);
    const db = options.database ?? new LocalDatabase(options.profileId);
    await db.open();
    const identity = await loadIdentity(options.profileId);
    if (!identity?.mlsState) { db.close(); throw new Error("Device MLS state is unavailable"); }
    const cached = await db.cachedSession<SessionIdentity>();
    let session: SessionIdentity;
    if (cached?.device_id === identity.deviceId) session = cached;
    else {
      try {
        session = await api.me();
        await db.cacheSession(session);
      } catch (cause) { db.close(); throw cause; }
    }
    if (session.device_id !== identity.deviceId) { db.close(); throw new Error("Session belongs to another device"); }
    const mls = await OpenMlsMessagingCore.create(identity.deviceId, identity.mlsState);
    const runtime = new BrowserMessagingRuntime({ ...options, api, database: db }, session, identity, mls);
    try { await runtime.start(); return runtime; }
    catch (cause) { await runtime.close(); throw cause; }
  }

  snapshot(): RuntimeSnapshot {
    return { connection: this.connectionState, session: this.session, rooms: [...this.roomsState] };
  }

  rooms(): readonly ServerRoom[] { return this.roomsState; }

  async approveLinkedDevice(linkId: string, expectedDeviceId: string, transferHistory: (
    view: DeviceLinkPreview, identity: DeviceIdentity, segments: Awaited<ReturnType<ArchiveSegmentCiphertextCache["entries"]>>,
  ) => Promise<void>): Promise<boolean> {
    let view = await this.api.deviceLinkPreview(linkId);
    if (view.device_id !== expectedDeviceId) throw new Error("配对设备已变化");
    if (view.account_mode === "opaque" && !this.identity.accountCredential) throw new Error("这台设备缺少账户凭证");
    if (view.status === "pending") {
      await this.api.approveDeviceLink(linkId);
      view = await this.api.deviceLinkPreview(linkId);
    }
    if (view.status === "awaiting_packages") return false;
    if (!["approved", "complete", "claimed"].includes(view.status)) throw new Error("配对请求已失效");
    if (view.status !== "claimed") await transferHistory(view, this.identity, await this.archiveCache.entries().catch(() => []));
    if (this.identity.accountCredential && view.status !== "claimed" && !view.account_credential_ready) {
      const envelope = await sealAccountCredential(this.identity.accountCredential, {
        linkId, sourceDeviceId: this.identity.deviceId, targetDeviceId: view.device_id,
      }, view.encryption_key);
      await this.api.uploadDeviceLinkAccountCredential(linkId, envelope);
    }
    await this.sync?.catchUp();
    return this.exclusiveMls(async () => {
      for (const room of view.rooms) {
        let queued = await this.db.deviceLinkOutbox(linkId, room.room_id);
        if (!queued && room.status === "complete") continue;
        if (!queued) {
          if (this.mls.epoch(room.room_id) !== room.expected_epoch - 1) throw new Error("房间尚未同步，请稍后重试");
          const previous = this.mls.exportState();
          const staged = await OpenMlsMessagingCore.create(this.identity.deviceId, previous);
          try {
            const commit = staged.addMembers(room.room_id, [room.key_package]);
            if (!commit.welcome || commit.epoch !== room.expected_epoch) throw new Error("无法生成房间邀请");
            const unsigned: Omit<ClientEvent, "signature"> = {
              event_id: `$${crypto.randomUUID()}:${serverName(this.session)}`,
              room_id: room.room_id, sender: this.session.user_id as UserId, device_id: this.identity.deviceId,
              type: "control.device.add", created_at: Date.now(), ciphertext: commit.commit,
              // The durable outbox uses JSONB, which orders keys by length and then bytes.
              metadata: { link_id: linkId, mls_epoch: commit.epoch, target_device_id: view.device_id },
            };
            const event = { ...unsigned, signature: await this.core.sign(this.identity, canonicalEventBytes(unsigned)) };
            const encryptedState = JSON.stringify({ version: 1, welcome: commit.welcome, ratchet_tree: commit.ratchet_tree });
            await this.db.saveDeviceLinkOutbox(linkId, view.device_id, event, encryptedState, previous, staged.exportState());
          } finally { staged.destroy(); }
          queued = await this.db.deviceLinkOutbox(linkId, room.room_id);
          if (!queued) throw new Error("无法保存配对进度");
        }
        const epoch = this.mls.epoch(room.room_id);
        if (epoch !== room.expected_epoch - 1 && epoch !== room.expected_epoch) throw new Error("房间加密状态已变化");
        if (epoch === room.expected_epoch - 1) {
          const current = this.mls.exportState();
          if (stagedMlsPosition(current, queued.previous_mls_state, queued.mls_state) !== "previous") {
            throw new LocalStagingIntegrityError("Device link transition does not match active state");
          }
        }
        const accepted = await this.api.commitDeviceLinkRoom(linkId, room.room_id, queued.event, queued.encrypted_state);
        if (!acceptedEventMatchesClientEvent(accepted.event, queued.event)) {
          throw new LocalStagingIntegrityError("The server acknowledged a different device-link commit");
        }
        if (epoch === room.expected_epoch - 1) await this.replaceMls(queued.mls_state);
        await this.db.removeDeviceLinkOutbox(linkId, room.room_id);
      }
      return true;
    });
  }

  async messages(roomId: RoomId, limit = 200): Promise<LocalMessage[]> {
    return (await this.db.messages(roomId, limit)).reverse();
  }

  async olderMessages(roomId: RoomId, beforeSeq: number, limit = 100): Promise<LocalMessage[]> {
    return (await this.db.messagesBefore(roomId, beforeSeq, limit)).reverse();
  }

  async messageWindow(roomId: RoomId, targetSeq: number): Promise<LocalMessageWindow> {
    return this.db.messageWindow(roomId, targetSeq);
  }

  async search(query: string, roomId?: RoomId): Promise<SearchResult[]> {
    const normalized = query.trim().slice(0, 200);
    return normalized ? this.db.search(normalized, roomId) : [];
  }

  async refreshRooms(): Promise<readonly ServerRoom[]> {
    const response = await this.api.rooms();
    await this.exclusiveMls(async () => {
      for (const room of response.rooms) {
        await this.db.saveRoom(room);
        await this.db.setHiddenRoomMembers(room.room_id, room.hidden_member_ids);
        if (!this.mls.hasGroup(room.room_id) && room.encrypted_state) {
          const packet = JSON.parse(room.encrypted_state) as { version?: unknown; welcome?: unknown; ratchet_tree?: unknown };
          if (packet.version !== 1 || typeof packet.welcome !== "string" || typeof packet.ratchet_tree !== "string") throw new Error("Room MLS welcome is invalid");
          this.mls.joinGroup(packet.welcome, packet.ratchet_tree);
          await this.persistMls();
        }
      }
    });
    this.roomsState = response.rooms;
    for (const room of response.rooms) void this.sync?.connectRoom(room.room_id);
    this.emit("rooms");
    return this.roomsState;
  }

  async sendText(roomId: RoomId, text: string, relation?: MessagePayload["relation"]): Promise<EventId> {
    const content = text.trim();
    if (!content || content.length > 16_000) throw new RangeError("Message text must contain 1-16000 characters");
    const eventId = `$${crypto.randomUUID()}:${serverName(this.session)}` as EventId;
    const payload = createMessagePayload(eventId as MessageId, content, undefined, relation);
    await this.enqueueEncryptedEvent({ eventId, roomId, type: "message.text", payload: payload as unknown as Record<string, unknown>, plaintext: messageText(payload), metadata: {} });
    this.emit("messages", { roomId });
    return eventId;
  }

  async createRoom(memberIds: readonly UserId[], name?: string): Promise<RoomId> {
    const members = [...new Set(memberIds.filter((userId) => userId !== this.session.user_id))];
    if (!members.length || members.length > 31) throw new RangeError("A room requires 1-31 other members");
    const roomId = `!${encodeBase64Url(crypto.getRandomValues(new Uint8Array(18)))}:${serverName(this.session)}` as RoomId;
    const claimed = await this.api.claimMlsKeyPackages(members, roomId);
    if (!claimed.key_packages.length) throw new Error("No active recipient device has an MLS KeyPackage");
    const created = await this.exclusiveMls(async () => {
      const result = this.mls.createGroup(roomId, claimed.key_packages.map((item) => item.key_package));
      await this.persistMls();
      return result;
    });
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
    await this.refreshRooms();
    const normalizedName = name?.trim();
    if (members.length > 1 && normalizedName) {
      if (normalizedName.length > 100 || /[\u0000-\u001f\u007f]/u.test(normalizedName)) throw new RangeError("Group name is invalid");
      const updatedAt = Date.now();
      const payload: RoomProfilePayload = { version: 1, kind: "room.profile", name: normalizedName, avatar: null, updated_at: updatedAt };
      await this.enqueueEncryptedEvent({ eventId: `$${crypto.randomUUID()}:${serverName(this.session)}` as EventId, roomId, type: "control.room.profile", payload: payload as unknown as Record<string, unknown>, plaintext: "", metadata: { room_profile_avatar_id: null, room_profile_previous_avatar_id: null } });
    }
    return roomId;
  }

  async ensureSavedRoom(): Promise<ServerRoom> {
    const existing = this.roomsState.find((room) => room.purpose === "saved");
    if (existing) return existing;
    const remote = (await this.api.rooms()).rooms.find((room) => room.purpose === "saved");
    if (remote) { await this.refreshRooms(); return this.roomsState.find((room) => room.room_id === remote.room_id) ?? remote; }

    const roomId = `!${encodeBase64Url(crypto.getRandomValues(new Uint8Array(18)))}:${serverName(this.session)}` as RoomId;
    const claimed = await this.api.claimMlsKeyPackages([], roomId);
    const created = await this.exclusiveMls(async () => {
      const result = this.mls.createGroup(roomId, claimed.key_packages.map((item) => item.key_package));
      await this.persistMls();
      return result;
    });
    try {
      await this.api.createRoom({
        room_id: roomId,
        kind: "group",
        purpose: "saved",
        name: null,
        members: [],
        mls_welcome: created.welcome,
        mls_ratchet_tree: created.ratchet_tree,
        mls_epoch: created.epoch,
        mls_recipients: claimed.key_packages.map((item) => item.device_id),
        mls_claim_ids: claimed.key_packages.map((item) => item.claim_id),
      });
    } catch (cause) {
      const recovered = (await this.api.rooms().catch(() => null))?.rooms.find((room) => room.purpose === "saved");
      if (!recovered) throw cause;
    }
    await this.refreshRooms();
    const saved = this.roomsState.find((room) => room.purpose === "saved");
    if (!saved) throw new Error("Saved Messages is not available yet");
    return saved;
  }

  async resolveMessageRequest(roomId: RoomId, decision: "accepted" | "rejected"): Promise<void> {
    if (decision === "accepted") await this.api.acceptMessageRequest(roomId);
    else await this.api.rejectMessageRequest(roomId);
    await this.refreshRooms();
  }

  async sendFiles(roomId: RoomId, files: readonly File[], text = ""): Promise<EventId> {
    if (!files.length || files.some((file) => !file.size || !file.name)) throw new RangeError("At least one non-empty file is required");
    const limits = this.session.protocol?.limits;
    const maxFiles = limits?.max_attachments_per_message ?? 10;
    const maxFileBytes = limits?.max_attachment_plaintext_bytes ?? 25 * 1024 * 1024;
    const maxMessageBytes = limits?.max_message_attachment_plaintext_bytes ?? 100 * 1024 * 1024;
    if (files.length > maxFiles) throw new RangeError(`A message can contain at most ${maxFiles} attachments`);
    if (files.some((file) => file.size > maxFileBytes)) throw new RangeError("An attachment exceeds the server size limit");
    if (files.reduce((total, file) => total + file.size, 0) > maxMessageBytes) throw new RangeError("Attachments exceed the per-message size limit");
    const eventId = `$${crypto.randomUUID()}:${serverName(this.session)}` as EventId;
    const ids = files.map(() => createAttachmentId());
    const cleanup = await this.db.stageAttachmentSendCleanup(eventId, roomId, ids);
    const attachments: AttachmentMetadata[] = [];
    let previewBudget = 40 * 1024;
    let admitted = false;
    try {
      for (const [index, file] of files.entries()) {
        const id = ids[index]!;
        const image = await prepareImageMetadata(file, previewBudget);
        if (image.preview) previewBudget -= embeddedImagePreviewByteLength(image.preview);
        const encrypted = await this.core.encryptAttachment(await file.arrayBuffer(), id);
        const uploaded = await this.api.uploadAttachment(roomId, encrypted.ciphertext, id);
        attachments.push({
          id: uploaded.attachment_id,
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          key: encrypted.key,
          nonce: encrypted.nonce,
          ...(image.dimensions ?? {}),
          ...(image.preview ? { preview: image.preview } : {}),
        });
      }
      const payload = createMessagePayload(eventId as MessageId, text.trim(), attachments);
      await this.enqueueEncryptedEvent({ eventId, roomId, type: "message.file", payload: payload as unknown as Record<string, unknown>, plaintext: messageText(payload), metadata: attachments.length === 1 ? { attachment_id: attachments[0]!.id } : { attachment_ids: attachments.map((item) => item.id) } });
      admitted = true;
      await this.db.completeAttachmentSendCleanup(eventId);
      this.emit("messages", { roomId });
      return eventId;
    } catch (cause) {
      if (!admitted && !(await this.db.attachmentSendCommittedLocally(eventId).catch(() => true))) {
        await this.api.abandonAttachments(cleanup.attachment_ids).catch(() => undefined);
        await this.db.completeAttachmentSendCleanup(eventId).catch(() => undefined);
      }
      throw cause;
    }
  }

  async downloadAttachment(attachment: AttachmentMetadata): Promise<Blob> {
    const decrypt = async (ciphertext: ArrayBuffer) => {
      const plaintext = await this.core.decryptAttachment(ciphertext, attachment.key, attachment.nonce, attachment.id);
      if (plaintext.byteLength !== attachment.size) throw new Error("Attachment size does not match authenticated metadata");
      return new Blob([plaintext], { type: attachment.type });
    };
    const cached = await this.attachmentCache.get(attachment.id).catch(() => null);
    if (cached) {
      try { return await decrypt(cached); }
      catch { await this.attachmentCache.remove(attachment.id).catch(() => undefined); }
    }
    const ciphertext = await this.api.downloadAttachment(attachment.id);
    const plaintext = await decrypt(ciphertext);
    await this.attachmentCache.put(attachment.id, ciphertext);
    return plaintext;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.discoveryTimer = null;
    if (this.keyPackageTimer) clearInterval(this.keyPackageTimer);
    this.keyPackageTimer = null;
    document.removeEventListener("visibilitychange", this.resumeDiscovery);
    window.removeEventListener("online", this.resumeDiscovery);
    this.connectionState = "stopped";
    await Promise.allSettled([this.sync?.quiesce(), this.outbox?.quiesce(), this.archive?.quiesce(), this.mlsTail]);
    this.sync = null; this.outbox = null; this.archive = null;
    this.mls.destroy();
    await this.db.close();
    this.emit("state");
  }

  private async start(): Promise<void> {
    await this.db.bindAccount(this.session.user_id, this.session.display_name);
    await this.restoreOutgoingTransitions();
    this.roomsState = await this.db.cachedRooms<ServerRoom>();
    this.outbox = new OutboxEngine(this.api, this.db);
    this.outbox.addEventListener("changed", () => this.emit("messages"));
    this.outbox.addEventListener("sent", (received) => {
      const event = (received as CustomEvent<RoomEvent>).detail;
      this.emit("messages", { roomId: event.room_id });
    });
    this.sync = new SyncEngine(
      this.api,
      this.db,
      (event) => this.processEvent(event),
      async () => { await this.refreshRooms(); },
      undefined,
      (roomId, segment, envelope) => this.resolveArchiveKey(roomId, segment, envelope),
      false,
      this.db,
    );
    this.sync.addEventListener("processed", (received) => {
      const event = (received as CustomEvent<RoomEvent>).detail;
      this.roomsState = this.roomsState.map((room) => room.room_id === event.room_id ? { ...room, current_seq: Math.max(room.current_seq, event.seq) } : room);
      if (event.seq % 25 === 0) void this.archive?.compact(event.room_id).catch(() => undefined);
      this.emit("messages", { roomId: event.room_id }); this.emit("rooms");
    });
    this.sync.addEventListener("transport", (received) => {
      const connected = Boolean((received as CustomEvent<{ connected: boolean }>).detail.connected);
      this.connectionState = connected ? "online" : "offline"; this.emit("state");
    });
    this.sync.addEventListener("error", (received) => {
      this.connectionState = "offline";
      this.emit("state");
      this.dispatchEvent(new CustomEvent("runtime-error", { detail: (received as CustomEvent<unknown>).detail }));
    });
    this.sync.addEventListener("quarantined", (received) => {
      this.dispatchEvent(new CustomEvent("runtime-error", { detail: (received as CustomEvent<{ error: unknown }>).detail.error }));
    });
    await this.outbox.start();
    void this.sync.start();
    for (const room of this.roomsState) void this.sync.connectRoom(room.room_id);
    if (navigator.onLine) void this.refreshRooms().catch((cause) => {
      this.dispatchEvent(new CustomEvent("runtime-error", { detail: cause }));
    });
    document.addEventListener("visibilitychange", this.resumeDiscovery);
    window.addEventListener("online", this.resumeDiscovery);
    this.discoveryTimer = setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) void this.sync?.catchUp();
    }, ROOM_DISCOVERY_INTERVAL_MS);
    const replenish = () => replenishMlsKeyPackages({
      api: this.api,
      mls: this.mls,
      persist: () => this.persistMls(),
      exclusive: (operation) => this.exclusiveMls(operation),
    });
    void replenish().catch(() => undefined);
    this.keyPackageTimer = setInterval(() => {
      if (navigator.onLine) void replenish().catch(() => undefined);
    }, 30 * 60_000);
    if (this.session.archive_compaction_enabled) {
      this.archive = new ArchiveCoordinator(this.api, this.db, new ArchiveSegmentBuilder(), (input) => this.wrapArchiveKey(input), this.archiveCache);
      void this.archive.reconcilePendingUploads().then(() => this.archive?.reconcileRetentionAcks()).catch(() => undefined);
      this.roomsState.forEach((room, index) => window.setTimeout(() => void this.archive?.compact(room.room_id).catch(() => undefined), 2_000 + index * 500));
    }
    this.connectionState = navigator.onLine ? "online" : "offline";
    this.emit("state");
  }

  private async resolveArchiveKey(roomId: RoomId, segment: ArchiveSegmentDescriptor, envelope: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const cached = await this.db.archiveKey(segment.segment_id);
    if (cached) {
      if (cached.room_id !== roomId || cached.start_seq !== segment.start_seq || cached.end_seq !== segment.end_seq) {
        throw new LocalStagingIntegrityError("Cached archive key does not match its signed manifest");
      }
      return cached.segment_key;
    }
    const key = await openArchiveSegmentKey(envelope, {
      room_id: roomId,
      segment_id: segment.segment_id,
      start_seq: segment.start_seq,
      end_seq: segment.end_seq,
    }, this.identity);
    await this.db.saveArchiveKey(roomId, segment.segment_id, key, segment.start_seq, segment.end_seq);
    return key;
  }

  private async wrapArchiveKey(input: { room_id: RoomId; segment_id: string; start_seq: number; end_seq: number; segment_key: Uint8Array<ArrayBuffer> }): Promise<Uint8Array<ArrayBuffer>> {
    const { devices } = await this.api.roomDevices(input.room_id);
    if (!devices.some((device) => device.device_id === this.identity.deviceId)) throw new Error("This device is not an archive recipient");
    return sealArchiveSegmentKey(input, input.segment_key, devices.map((device) => ({ device_id: device.device_id, encryption_key: device.encryption_key })));
  }

  private async authenticateEvent(event: RoomEvent): Promise<void> {
    let key = await this.db.roomDeviceSigningKey(event.room_id, event.device_id);
    if (!key) {
      const response = await this.api.roomSigningKeys(event.room_id);
      try { await this.db.saveRoomDeviceSigningKeys(event.room_id, response.keys); }
      catch (cause) {
        throw new LocalStagingIntegrityError(cause instanceof Error ? cause.message : "Invalid room signing-key directory");
      }
      key = await this.db.roomDeviceSigningKey(event.room_id, event.device_id);
    }
    if (!key || key.user_id !== event.sender) throw new LocalStagingIntegrityError("Room event signer is not an active room device");
    try { await verifyRoomEventSignature(event, key.signing_key); }
    catch (cause) { throw new LocalStagingIntegrityError(cause instanceof Error ? cause.message : String(cause)); }
  }

  private async processEvent(event: RoomEvent) {
    await this.authenticateEvent(event);
    const membershipCommit = isMlsMembershipCommitEventType(event.type);
    if (event.device_id === this.identity.deviceId && !membershipCommit) return null;
    const staged = await this.db.stagedDecryptedEvent(event.event_id);
    if (staged && (staged.event.room_id !== event.room_id || staged.event.seq !== event.seq || staged.event.ciphertext !== event.ciphertext || staged.event.signature !== event.signature)) {
      throw new LocalStagingIntegrityError("Staged encrypted event changed");
    }
    const plaintextBytes = await this.exclusiveMls(async () => {
      if (!this.mls.hasGroup(event.room_id)) throw new LocalProjectionPersistenceError(new Error("Room MLS state is unavailable"));
      if (event.device_id === this.identity.deviceId && membershipCommit) {
        const epoch = Number(event.metadata.mls_epoch);
        if (Number.isInteger(epoch) && this.mls.epoch(event.room_id) >= epoch) return null;
        const linkId = event.metadata.link_id;
        if (event.type === "control.device.add" && typeof linkId === "string") {
          const queued = await this.db.deviceLinkOutbox(linkId, event.room_id);
          if (queued) {
            if (!acceptedEventMatchesClientEvent(event, queued.event)
              || stagedMlsPosition(this.mls.exportState(), queued.previous_mls_state, queued.mls_state) !== "previous") {
              throw new LocalStagingIntegrityError("Accepted device-link event does not match its staged transition");
            }
            await this.replaceMls(queued.mls_state);
            return null;
          }
        }
      }
      if (staged) {
        const position = stagedMlsPosition(this.mls.exportState(), staged.previous_mls_state, staged.next_mls_state);
        if (position === "mismatch") throw new LocalStagingIntegrityError("Active MLS state does not match staged transition");
        if (position === "previous") await this.replaceMls(staged.next_mls_state);
        await this.persistMls();
        return staged.plaintext;
      }
      const previous = this.mls.exportState();
      const processed = this.mls.processMessage(event.room_id, decodeBase64Url(event.ciphertext));
      if (processed.senderDeviceId !== event.device_id) {
        await this.replaceMls(previous); throw new LocalStagingIntegrityError("MLS sender does not match signed envelope");
      }
      const next = this.mls.exportState();
      try {
        await this.db.stageDecryptedEvent(event, processed.plaintext, processed.senderDeviceId, new Uint8Array(previous), new Uint8Array(next));
        await this.persistMls();
        return processed.plaintext;
      } catch (cause) {
        await this.replaceMls(previous).catch(() => undefined);
        throw new LocalProjectionPersistenceError(cause);
      }
    });
    if (!plaintextBytes?.length) return null;
    const decoded: unknown = JSON.parse(decoder.decode(plaintextBytes));
    if (event.type === "message.delete") {
      if (!isMessageDeletePayload(decoded) || decoded.target.room_id !== event.room_id) throw new Error("Invalid message deletion");
      await this.db.applyMessageTombstone(event, decoded.target.message_id); return null;
    }
    if (event.type === "message.edit") {
      if (!isMessageEditPayload(decoded) || decoded.target.room_id !== event.room_id) throw new Error("Invalid message edit");
      await this.db.applyMessageEdit(event, decoded); return null;
    }
    if (event.type === "message.reaction") {
      if (!isMessageReactionPayload(decoded) || decoded.target.room_id !== event.room_id) throw new Error("Invalid message reaction");
      await this.db.applyMessageReaction(event, decoded); return null;
    }
    if (event.type === "receipt.read") {
      if (!isReadReceiptPayload(decoded) || decoded.room_id !== event.room_id) throw new Error("Invalid read receipt");
      await this.db.applyReadReceipt(event, decoded, event.sender === this.session.user_id); return null;
    }
    if (event.type === "receipt.delivered") {
      if (!isDeliveryReceiptPayload(decoded) || decoded.room_id !== event.room_id) throw new Error("Invalid delivery receipt");
      await this.db.applyDeliveryReceipt(event, decoded, event.sender === this.session.user_id); return null;
    }
    if (event.type === "control.message-expiry") {
      if (!isMessageExpiryPolicyPayload(decoded)) throw new Error("Invalid message expiry policy");
      await this.db.applyMessageExpiryPolicy(event, decoded); return null;
    }
    if (event.type === "control.room.profile") {
      if (!isRoomProfilePayload(decoded)) throw new Error("Invalid room profile");
      await this.db.applyRoomProfile(event, decoded); return null;
    }
    if (event.type === "control.owner.transfer") {
      if (!isRoomOwnerTransferPayload(decoded)) throw new Error("Invalid owner transfer");
      return null;
    }
    if (!event.type.startsWith("message.")) return null;
    const message = normalizeMessagePayload(decoded as MessagePayload, event.event_id);
    assertMessageEnvelope(message, event);
    return { plaintext: messageText(message), payload: message as unknown as Record<string, unknown> };
  }

  private async enqueueEncryptedEvent(input: { eventId: EventId; roomId: RoomId; type: ClientEvent["type"]; payload: Record<string, unknown>; plaintext: string; metadata: Record<string, unknown> }): Promise<void> {
    if (!this.outbox) throw new Error("Message outbox is not ready");
    await this.exclusiveMls(async () => {
      if (!this.mls.hasGroup(input.roomId)) throw new Error("Room encryption state is unavailable");
      const previous = this.mls.exportState();
      let signed: ClientEvent | null = null;
      try {
        const ciphertext = encodeBase64Url(this.mls.encryptMessage(input.roomId, encoder.encode(JSON.stringify(input.payload))));
        if (ciphertext.length > MAX_EVENT_CIPHERTEXT_LENGTH) throw new RangeError("Encrypted event is too large");
        const next = this.mls.exportState();
        const unsigned: Omit<ClientEvent, "signature"> = {
          event_id: input.eventId, room_id: input.roomId, sender: this.session.user_id as UserId,
          device_id: this.identity.deviceId, type: input.type, created_at: Date.now(), ciphertext,
          metadata: { mls_epoch: this.mls.epoch(input.roomId), ...input.metadata },
        };
        signed = { ...unsigned, signature: await this.core.sign(this.identity, canonicalEventBytes(unsigned)) };
        await this.db.stageOutgoingEvent(signed, input.plaintext, input.payload, new Uint8Array(previous), new Uint8Array(next));
        await this.persistMls();
        await this.db.promoteStagedOutgoingEvent(signed.event_id);
        this.outbox?.notifyPersisted();
      } catch (cause) {
        if (signed) {
          const [stagedRows, promoted] = await Promise.all([
            this.db.stagedOutgoingEvents(500),
            this.db.hasExactOutbox(signed, input.plaintext, input.payload),
          ]).catch(() => [[], false] as const);
          if (promoted) { this.outbox?.notifyPersisted(); return; }
          const staged = stagedRows.find((item) => item.event.event_id === signed?.event_id);
          if (staged) {
            await this.replaceMls(staged.next_mls_state);
            await this.db.promoteStagedOutgoingEvent(staged.event.event_id);
            this.outbox?.notifyPersisted();
            return;
          }
        }
        await this.replaceMls(previous).catch(() => undefined);
        throw cause;
      }
    });
  }

  private async restoreOutgoingTransitions(): Promise<void> {
    for (const staged of await this.db.stagedOutgoingEvents(500)) {
      const position = stagedMlsPosition(this.mls.exportState(), staged.previous_mls_state, staged.next_mls_state);
      if (position === "mismatch") throw new LocalStagingIntegrityError("Outgoing MLS transition does not match active state");
      if (position === "previous") await this.replaceMls(staged.next_mls_state);
      await this.persistMls();
      await this.db.promoteStagedOutgoingEvent(staged.event.event_id);
    }
  }

  private async persistMls(): Promise<void> {
    this.identity = { ...this.identity, mlsState: this.mls.exportState() };
    await saveIdentity(this.profileId, this.identity);
  }

  private async replaceMls(state: Uint8Array): Promise<void> {
    const replacement = await OpenMlsMessagingCore.create(this.identity.deviceId, state);
    const previous = this.mls; this.mls = replacement; previous.destroy();
    this.identity = { ...this.identity, mlsState: state };
    await saveIdentity(this.profileId, this.identity);
  }

  private exclusiveMls<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mlsTail.then(operation, operation);
    this.mlsTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private emit(type: string, detail?: unknown): void {
    this.dispatchEvent(detail === undefined ? new Event(type) : new CustomEvent(type, { detail }));
  }
}

export { stagedMlsPosition } from "./crypto-state";
