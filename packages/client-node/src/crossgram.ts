import { isNamespacedMessageId, type MessageId, type RoomEvent, type RoomId, type UserId } from "@edgechat/protocol";
import type { ServerRoom } from "@edgechat/sync";
import type { DecryptedNodeMessage, NodeAttachment, NodeAttachmentInput, NodeEdgeChatClient, SendNodeMessageResult } from "./index.js";

export type CrossgramUser = { id: string; firstName: string; username?: string; metadata?: Record<string, string | number | boolean | null> };
export type CrossgramConversation = { id: string; kind: "direct" | "group"; title: string; selfRole: "owner" | "member"; metadata?: Record<string, string | number | boolean | null> };
export type CrossgramMediaLocator = { edgechatAttachment: NodeAttachment };
export type CrossgramMedia = {
  id: string;
  kind: "image" | "file";
  name?: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
  voice?: boolean;
  locator: CrossgramMediaLocator;
};
export type CrossgramMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  sender?: CrossgramUser;
  content: { parts: Array<{ type: "text"; text: string } | { type: "media"; media: CrossgramMedia }> };
  timestamp: number;
  nativeOrderKey: string;
  outgoing: boolean;
  replyToId?: string;
  metadata: Record<string, string | number | boolean | null>;
};
export type CrossgramMediaSource = { size?: number; stream(options?: { signal?: AbortSignal }): AsyncIterable<Uint8Array> };
export type CrossgramMessageInput = { parts: Array<
  | { type: "text"; text: string }
  | { type: "media"; media: { kind: "image" | "file"; name?: string; mimeType?: string; size?: number; width?: number; height?: number; duration?: number; voice?: boolean; source: CrossgramMediaSource } }
>; replyToId?: string };

export type CrossgramEvent =
  | { type: "message"; message: CrossgramMessage; conversation: CrossgramConversation }
  | { type: "message-edit"; eventId: string; message: CrossgramMessage; conversation: CrossgramConversation }
  | { type: "message-delete"; eventId: string; conversation: CrossgramConversation; messageIds: string[]; timestamp: number };

export interface EdgeChatGatewayClient {
  readonly userId: UserId;
  rooms(): Promise<ServerRoom[]>;
  pull(): Promise<DecryptedNodeMessage[]>;
  acknowledgeDeliveries(eventIds: readonly string[]): Promise<void>;
  sendText(roomId: RoomId, text: string, options?: { replyToId?: MessageId }): Promise<{ event_id: MessageId; seq: number }>;
  sendAttachments(roomId: RoomId, inputs: readonly NodeAttachmentInput[], text?: string, options?: { replyToId?: MessageId }): Promise<SendNodeMessageResult>;
  deleteMessage(roomId: RoomId, targetMessageId: MessageId): Promise<{ event_id: MessageId; seq: number }>;
  editMessage(roomId: RoomId, targetMessageId: MessageId, text: string): Promise<{ event_id: MessageId; seq: number }>;
  downloadAttachment(attachment: NodeAttachment): Promise<ArrayBuffer>;
}

export type CrossgramAdapterOptions = {
  pollIntervalMs?: number;
  now?: () => number;
  onPollError?: (error: unknown) => void;
};

/**
 * Structurally matches CrossGram's IMPlatform text/history subset without
 * importing its private workspace package. A thin Cordis plugin inside a
 * CrossGram checkout can register this instance directly.
 */
export class EdgeChatCrossgramPlatform {
  readonly platformKind = "edgechat";
  readonly capabilities = {
    history: true,
    send: { text: true, images: true, files: true, mixed: true, maxTextLength: 16_000, maxMedia: 10 },
    conversations: { groups: true, channels: false, subchannels: false },
    messageActions: {
      delete: { own: { supported: true }, others: { supported: false } },
      edit: { mode: "native" },
      forward: { mode: "unsupported", preservesAuthor: false },
    },
  } as const;

  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly onPollError: (error: unknown) => void;
  private readonly messages = new Map<string, CrossgramMessage[]>();
  private readonly subscribers = new Set<(event: CrossgramEvent) => void | Promise<void>>();
  private roomsById = new Map<string, ServerRoom>();
  private timer?: ReturnType<typeof setInterval>;
  private pollTail: Promise<void> = Promise.resolve();

  constructor(private readonly client: EdgeChatGatewayClient, options: CrossgramAdapterOptions = {}) {
    this.pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 1_000);
    this.now = options.now ?? (() => Date.now());
    this.onPollError = options.onPollError ?? (() => undefined);
  }

  async getAccount() {
    const room = (await this.refreshRooms()).find((candidate) => candidate.members.some((member) => member.user_id === this.client.userId));
    const member = room?.members.find((candidate) => candidate.user_id === this.client.userId);
    return { credentials: {}, user: this.user(member?.display_name ?? this.client.userId, this.client.userId) };
  }

  async subscribe(_session: unknown, handler: (event: CrossgramEvent) => void | Promise<void>): Promise<() => void> {
    this.subscribers.add(handler);
    if (!this.timer) {
      this.timer = setInterval(() => { this.pollInBackground(); }, this.pollIntervalMs);
      this.timer.unref?.();
    }
    this.pollInBackground();
    return () => {
      this.subscribers.delete(handler);
      if (!this.subscribers.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    };
  }

  private pollInBackground(): void {
    void this.pollOnce().catch((error: unknown) => { this.onPollError(error); });
  }

  async pollOnce(): Promise<CrossgramEvent[]> {
    const events: CrossgramEvent[] = [];
    const operation = async () => {
      await this.refreshRooms();
      const incoming = await this.client.pull();
      for (const item of incoming) {
        if (item.mutation?.type === "message-edit") {
          const conversation = this.conversation(this.roomsById.get(item.event.room_id));
          const original = this.findMessage(item.event.room_id, item.mutation.targetMessageId);
          const message: CrossgramMessage = original
            ? { ...original, content: { ...original.content, parts: [
                { type: "text", text: item.mutation.text },
                ...original.content.parts.filter((part) => part.type === "media"),
              ] } }
            : this.messageFromEvent({ ...item.event, event_id: item.mutation.targetMessageId }, item.mutation.text, []);
          const event: CrossgramEvent = { type: "message-edit", eventId: item.event.event_id, message, conversation };
          events.push(event);
          for (const subscriber of this.subscribers) await subscriber(event);
          if (this.subscribers.size) await this.client.acknowledgeDeliveries([item.event.event_id]);
          this.remember(message);
          continue;
        }
        if (item.mutation?.type === "message-delete") {
          const conversation = this.conversation(this.roomsById.get(item.event.room_id));
          const event: CrossgramEvent = { type: "message-delete", eventId: item.event.event_id, conversation,
            messageIds: [item.mutation.targetMessageId], timestamp: Math.floor(item.mutation.deletedAt / 1_000) };
          events.push(event);
          for (const subscriber of this.subscribers) await subscriber(event);
          if (this.subscribers.size) await this.client.acknowledgeDeliveries([item.event.event_id]);
          this.forget(item.event.room_id, item.mutation.targetMessageId);
          continue;
        }
        const message = this.messageFromEvent(item.event, item.text, item.attachments, item.replyToId);
        if (!message.content.parts.length) {
          await this.client.acknowledgeDeliveries([item.event.event_id]);
          continue;
        }
        this.remember(message);
        const conversation = this.conversation(this.roomsById.get(item.event.room_id));
        const event = { type: "message", message, conversation } as const;
        events.push(event);
        for (const subscriber of this.subscribers) await subscriber(event);
        // CrossGram's handler resolves only after canonical ingestion. Keep the
        // decrypted delivery durable until that backpressure boundary succeeds.
        if (this.subscribers.size) await this.client.acknowledgeDeliveries([item.event.event_id]);
      }
    };
    const result = this.pollTail.then(operation);
    this.pollTail = result.then(() => undefined, () => undefined);
    await result;
    return events;
  }

  async getDialogs(_session?: unknown, query: { cursor?: string; limit?: number } = {}) {
    const rooms = await this.refreshRooms();
    const start = Math.max(0, Number(query.cursor ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const dialogs = rooms.map((room) => {
      const messages = this.messages.get(room.room_id) ?? [];
      return { conversation: this.conversation(room), unreadCount: 0, lastMessage: messages.at(-1) };
    }).sort((left, right) => (right.lastMessage?.timestamp ?? 0) - (left.lastMessage?.timestamp ?? 0));
    return { dialogs: dialogs.slice(start, start + limit), nextCursor: start + limit < dialogs.length ? String(start + limit) : undefined };
  }

  async getConversation(_session: unknown, conversationId: string): Promise<CrossgramConversation | null> {
    await this.refreshRooms();
    const room = this.roomsById.get(conversationId);
    return room ? this.conversation(room) : null;
  }

  async getHistory(_session: unknown, conversation: { id: string }, query: { cursor?: string; before?: { id: string }; limit?: number } = {}) {
    await this.pollOnce();
    const newest = [...(this.messages.get(conversation.id) ?? [])].reverse();
    const before = query.before ? newest.findIndex((message) => message.id === query.before!.id) + 1 : 0;
    const start = Math.max(before, Number(query.cursor ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    return { messages: newest.slice(start, start + limit), nextCursor: start + limit < newest.length ? String(start + limit) : undefined };
  }

  async getUser(_session: unknown, userId: string): Promise<CrossgramUser | null> {
    await this.refreshRooms();
    for (const room of this.roomsById.values()) {
      const member = room.members.find((candidate) => candidate.user_id === userId);
      if (member) return this.user(member.display_name, member.user_id);
    }
    return null;
  }

  async sendMessage(_session: unknown, conversation: { id: string }, content: CrossgramMessageInput): Promise<CrossgramMessage> {
    const parts = content.parts;
    if (!parts.length) throw new Error("Message is empty");
    const text = parts.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text").map((part) => part.text).join("\n").trim();
    const mediaParts = parts.filter((part): part is Extract<typeof part, { type: "media" }> => part.type === "media");
    if (!text && !mediaParts.length) throw new Error("Message is empty");
    if (mediaParts.length > 10) throw new Error("EdgeChat accepts at most 10 media items per message");
    await this.refreshRooms();
    const room = this.roomsById.get(conversation.id);
    if (!room) throw new Error(`Unknown EdgeChat room: ${conversation.id}`);
    if (content.replyToId !== undefined && !isNamespacedMessageId(content.replyToId)) throw new Error("EdgeChat reply target is invalid");
    const options = content.replyToId ? { replyToId: content.replyToId } : undefined;
    let accepted: { event_id: MessageId; seq: number }; let attachments: NodeAttachment[] = [];
    if (mediaParts.length) {
      const inputs: NodeAttachmentInput[] = [];
      for (const [index, part] of mediaParts.entries()) {
        const bytes = await collectSource(part.media.source, part.media.size);
        inputs.push({ name: part.media.name?.trim() || `attachment-${index + 1}`,
          type: part.media.mimeType?.trim() || "application/octet-stream", bytes,
          ...(part.media.width && part.media.height ? { width: part.media.width, height: part.media.height } : {}),
          ...(part.media.duration ? { duration_ms: Math.max(1, Math.round(part.media.duration * 1_000)) } : {}) });
      }
      const result = options
        ? await this.client.sendAttachments(room.room_id, inputs, text, options)
        : await this.client.sendAttachments(room.room_id, inputs, text);
      accepted = result; attachments = result.attachments;
    } else accepted = options
      ? await this.client.sendText(room.room_id, text, options)
      : await this.client.sendText(room.room_id, text);
    const event = { event_id: accepted.event_id, room_id: room.room_id, sender: this.client.userId, seq: accepted.seq, created_at: this.now() } as RoomEvent;
    const message = this.messageFromEvent(event, text, attachments, options?.replyToId);
    this.remember(message);
    return message;
  }

  async deleteMessages(_session: unknown, conversation: { id: string }, messageIds: readonly string[], options: { forEveryone: boolean }): Promise<void> {
    if (!options.forEveryone) throw new Error("EdgeChat only supports retracting a message for every participant");
    await this.refreshRooms();
    const room = this.roomsById.get(conversation.id);
    if (!room) throw new Error(`Unknown EdgeChat room: ${conversation.id}`);
    const targets = [...new Set(messageIds)];
    if (!targets.length || targets.some((id) => !isNamespacedMessageId(id))) throw new Error("EdgeChat message deletion targets are invalid");
    for (const target of targets) {
      await this.client.deleteMessage(room.room_id, target as MessageId);
      this.forget(room.room_id, target);
    }
  }

  async editMessage(_session: unknown, target: { conversationId: string; messageId: string; targetId: string }, content: CrossgramMessageInput): Promise<CrossgramMessage> {
    const original = this.findMessage(target.conversationId, target.messageId);
    if (!original || target.targetId !== target.messageId) throw new Error("EdgeChat edit target is not available in the gateway projection");
    const textParts = content.parts.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text");
    if (content.parts.some((part) => part.type !== "text") || textParts.length !== 1) throw new Error("EdgeChat currently edits message text only");
    const text = textParts[0]!.text.trim();
    if (!text) throw new Error("Edited message is empty");
    await this.client.editMessage(target.conversationId as RoomId, target.messageId as MessageId, text);
    const updated = { ...original, content: { ...original.content, parts: [
      { type: "text" as const, text },
      ...original.content.parts.filter((part) => part.type === "media"),
    ] } };
    this.remember(updated);
    return updated;
  }

  async *downloadMedia(_session: unknown, media: CrossgramMedia, options: { offset?: number; limit?: number; signal?: AbortSignal } = {}): AsyncIterable<Uint8Array> {
    const attachment = media.locator?.edgechatAttachment;
    if (!attachment || attachment.id !== media.id) throw new Error("EdgeChat media locator is invalid");
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Download aborted");
    const plaintext = new Uint8Array(await this.client.downloadAttachment(attachment));
    const offset = Math.min(plaintext.length, Math.max(0, options.offset ?? 0));
    const end = Math.min(plaintext.length, offset + Math.max(0, options.limit ?? plaintext.length));
    for (let position = offset; position < end; position += 64 * 1024) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("Download aborted");
      yield plaintext.slice(position, Math.min(end, position + 64 * 1024));
    }
  }

  private async refreshRooms(): Promise<ServerRoom[]> {
    const rooms = await this.client.rooms();
    this.roomsById = new Map(rooms.map((room) => [room.room_id, room]));
    return rooms;
  }

  private conversation(room?: ServerRoom): CrossgramConversation {
    if (!room) throw new Error("EdgeChat room metadata is unavailable");
    const self = room.members.find((member) => member.user_id === this.client.userId);
    const peer = room.members.find((member) => member.user_id !== this.client.userId);
    const fallback = room.kind === "direct" ? peer?.display_name : undefined;
    return { id: room.room_id, kind: room.kind, title: room.name ?? fallback ?? "Encrypted group",
      selfRole: self?.role === "owner" ? "owner" : "member", metadata: { edgechatRoomId: room.room_id } };
  }

  private messageFromEvent(event: Pick<RoomEvent, "event_id" | "room_id" | "sender" | "seq" | "created_at">, text: string, attachments: readonly NodeAttachment[], replyToId?: MessageId): CrossgramMessage {
    const room = this.roomsById.get(event.room_id);
    const sender = room?.members.find((member) => member.user_id === event.sender);
    return {
      id: event.event_id,
      conversationId: event.room_id,
      senderId: event.sender,
      sender: this.user(sender?.display_name ?? event.sender, event.sender),
      content: { parts: [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...attachments.map((attachment) => ({ type: "media" as const, media: attachmentMedia(attachment) })),
      ] },
      timestamp: Math.floor(event.created_at / 1_000),
      nativeOrderKey: String(event.seq).padStart(16, "0"),
      outgoing: event.sender === this.client.userId,
      ...(replyToId ? { replyToId } : {}),
      metadata: { edgechatSeq: event.seq, edgechatEventId: event.event_id },
    };
  }

  private user(displayName: string, userId: string): CrossgramUser {
    return { id: userId, firstName: displayName, username: userId, metadata: { edgechatUserId: userId } };
  }

  private remember(message: CrossgramMessage): void {
    const messages = this.messages.get(message.conversationId) ?? [];
    const index = messages.findIndex((candidate) => candidate.id === message.id);
    if (index >= 0) messages[index] = message;
    else messages.push(message);
    messages.sort((left, right) => left.nativeOrderKey.localeCompare(right.nativeOrderKey));
    this.messages.set(message.conversationId, messages);
  }

  private findMessage(conversationId: string, messageId: string): CrossgramMessage | undefined {
    return this.messages.get(conversationId)?.find((message) => message.id === messageId);
  }

  private forget(conversationId: string, messageId: string): void {
    const messages = this.messages.get(conversationId);
    if (!messages) return;
    this.messages.set(conversationId, messages.filter((message) => message.id !== messageId));
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined; this.subscribers.clear();
  }
}

function attachmentMedia(attachment: NodeAttachment): CrossgramMedia {
  return {
    id: attachment.id, kind: attachment.type.startsWith("image/") ? "image" : "file", name: attachment.name,
    mimeType: attachment.type, size: attachment.size, ...(attachment.width ? { width: attachment.width, height: attachment.height } : {}),
    ...(attachment.duration_ms ? { duration: attachment.duration_ms / 1_000 } : {}),
    ...(attachment.type.startsWith("audio/") && attachment.duration_ms ? { voice: true } : {}),
    locator: { edgechatAttachment: attachment },
  };
}

async function collectSource(source: CrossgramMediaSource, declaredSize?: number): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = []; let total = 0;
  for await (const chunk of source.stream()) {
    total += chunk.byteLength;
    if (total > 25 * 1024 * 1024) throw new Error("EdgeChat attachment exceeds 25 MiB");
    chunks.push(chunk.slice());
  }
  if (declaredSize !== undefined && declaredSize !== total) throw new Error("CrossGram media size does not match its byte stream");
  const joined = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return joined.buffer;
}

export function asCrossgramPlatform(client: NodeEdgeChatClient, options?: CrossgramAdapterOptions): EdgeChatCrossgramPlatform {
  return new EdgeChatCrossgramPlatform(client, options);
}
